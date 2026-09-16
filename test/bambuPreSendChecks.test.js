// test/bambuPreSendChecks.test.js — what the Send dialog tells an operator
// BEFORE a Bambu print goes out, and what it refuses outright.
//
// A wasted Bambu print is expensive: the machine heats, homes, purges and then
// stops, and on a farm nobody is watching that printer. Everything here is a
// check SnapCon can make from the file itself plus what the printer reports —
// no guessing, and each one is either a refusal (it cannot work) or a warning
// (it may not be what you meant).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  return appSrc.slice(start, appSrc.indexOf("\n}", start) + 2);
}
// t() resolves against the real shipped English strings, so these tests read
// the wording an operator actually sees — and a key that was never added to the
// locale fails here rather than rendering as a raw key in the UI.
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
function translate(key, vals) {
  const s = key.split(".").reduce((o, k) => (o == null ? o : o[k]), EN);
  assert.ok(typeof s === "string", "missing locale string: " + key);
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vals && vals[k] != null ? vals[k] : "{" + k + "}"));
}
const sandbox = { Math, JSON, String, Number, Array, Object, t: translate };
vm.createContext(sandbox);
const codes = appSrc.slice(appSrc.indexOf("const BAMBU_MODEL_CODES ="));
vm.runInContext(codes.slice(0, codes.indexOf("\n") + 1), sandbox);
vm.runInContext(extractFn("bambuSendIssues"), sandbox);
const issues = (file, printer) => vm.runInContext("bambuSendIssues", sandbox)(file, printer);

const P2S = { name: "P2S", capabilities: { fileTypes: ["3mf"], model: "Bambu Lab P2S" },
  heads: [{ label: "A1", loaded: true, material: "PLA" }, { label: "A2", loaded: false },
          { label: "A3", loaded: true, material: "PETG" }, { label: "A4", loaded: true, material: "PETG" },
          { label: "Ext", loaded: false, mappable: false }] };
const SLICED = { notSliced: false, printerModelId: "N7", nozzle: 0.4, plates: [1] };

// The function runs inside a vm realm, so its arrays are not reference-equal to
// this file's — compare contents, never the array itself.
// Array.from, not .map: mapping a vm-realm array returns another vm-realm
// array, which deepStrictEqual still refuses to match.
const texts = (file, printer) => Array.from(issues(file, printer), i => i.level + ": " + i.text);

test("a sliced file for this printer raises nothing", () => {
  assert.deepEqual(texts(SLICED, P2S), []);
});

test("an unsliced project is refused, not warned about", () => {
  // It cannot print: the start command asks the printer for a plate gcode the
  // file does not contain.
  const [first] = issues({ ...SLICED, notSliced: true }, P2S);
  assert.equal(first.level, "error");
  assert.match(first.text, /sliced/i);
  assert.match(first.text, /slicer/i, "say how to fix it");
});

test("a file sliced for a different Bambu model is a warning", () => {
  // Warned, not refused: it may still print, and the operator is the one who
  // knows whether the plates are interchangeable.
  const [first] = issues({ ...SLICED, printerModelId: "N2S" }, P2S);
  assert.equal(first.level, "warn");
  assert.match(first.text, /different Bambu/i);
});

test("an unknown printer model gives 'cannot verify', never a false mismatch", () => {
  // Only verified model codes are compared. A model nobody has checked must not
  // be reported as incompatible on a guess (CLAUDE.md section 2).
  const unknown = { ...P2S, capabilities: { ...P2S.capabilities, model: "Bambu Lab X9Z" } };
  const [first] = issues({ ...SLICED, printerModelId: "N7" }, unknown);
  assert.equal(first.level, "warn");
  assert.match(first.text, /can't verify|cannot verify/i);
  assert.doesNotMatch(first.text, /different/i);
});

test("a file that does not say what it was sliced for is not judged", () => {
  const [first] = issues({ ...SLICED, printerModelId: null }, P2S);
  assert.match(first.text, /can't verify|cannot verify/i);
});

test("a nozzle the file was not sliced for is a warning", () => {
  // The verified print stopped on exactly this: the printer paused itself
  // because the nozzle did not match the sliced file (0500-803C).
  const withNozzle = { ...P2S, nozzleDiameter: 0.6 };
  const [first] = issues({ ...SLICED, nozzle: 0.4 }, withNozzle);
  assert.equal(first.level, "warn");
  assert.match(first.text, /nozzle/i);
  assert.match(first.text, /0\.4/);
  assert.match(first.text, /0\.6/);
});

test("a printer that does not report its nozzle raises nothing about nozzles", () => {
  assert.deepEqual(texts({ ...SLICED, nozzle: 0.4 }, P2S), []);
});

test("several problems are all reported, worst first", () => {
  const bad = { notSliced: true, printerModelId: "N2S", nozzle: 0.4, plates: [] };
  const list = issues(bad, { ...P2S, nozzleDiameter: 0.6 });
  assert.ok(list.length >= 2);
  assert.equal(list[0].level, "error", "a refusal must not be buried under warnings");
});

// ---- choosing trays by material, not colour alone ----

vm.runInContext(extractFn("materialMatches"), sandbox);
const matches = (a, b) => vm.runInContext("materialMatches", sandbox)(a, b);

test("material comparison ignores case and padding", () => {
  assert.equal(matches("PETG", "petg "), true);
  assert.equal(matches(" PLA", "PLA"), true);
});

test("a different material does not match", () => {
  // The file's PETG fed from a PLA tray prints at the wrong temperature and
  // fails a few layers in, on a printer nobody is watching.
  assert.equal(matches("PETG", "PLA"), false);
});

test("an unknown material on either side is not claimed as a match", () => {
  assert.equal(matches("PETG", null), false);
  assert.equal(matches(null, "PETG"), false);
  assert.equal(matches("", ""), false);
});

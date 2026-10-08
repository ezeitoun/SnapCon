// test/filamentMaterialPicker.test.js — the material picker in the spool
// dialog's edit mode.
//
// The behaviour that matters most here is what happens when the loaded
// filament is NOT one the printer has tuned settings for. The picker's list
// is the printer's own parameter table, which is deliberately not the same
// list the touchscreen offers — the screen can set BVOH, which has no tuned
// profile and therefore no entry here. Such a slot must stay exactly as it
// is unless the user deliberately changes it: silently rewriting it to the
// nearest listed material would be SnapCon inventing printer data.
//
// Extracted from public/app.js and run in a sandbox (the pattern
// test/fleet-eject.test.js documents) — app.js is browser code with no
// exports.
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

const sandbox = {
  esc: s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  t: (k, v) => (v && v.material ? `Keep ${v.material}` : k),
};
vm.createContext(sandbox);
for (const fn of ["materialLabel", "currentMaterialIndex", "materialOptionsHtml", "pendingMaterial", "materialIsUnset", "defaultMaterialIndex"]) {
  vm.runInContext(extractFn(fn), sandbox);
}
const call = (name, ...args) => vm.runInContext(name, sandbox)(...args);

// A slice of the real U1 table, including the two collisions that make vendor
// load-bearing and the space-containing sub-type.
const MATERIALS = [
  { vendor: "Generic", type: "PLA", subType: "" },
  { vendor: "Generic", type: "PETG", subType: "" },
  { vendor: "Generic", type: "PETG", subType: "HF" },
  { vendor: "Generic", type: "TPU", subType: "95A HF" },
  { vendor: "Polymaker", type: "PLA", subType: "PolyTerra" },
  { vendor: "Snapmaker", type: "PETG", subType: "HF" },
  { vendor: "Snapmaker", type: "PLA", subType: "Basic" },
];

// ---- Labelling ----

test("materialLabel: a generic filament is named by its type alone", () => {
  assert.equal(call("materialLabel", { vendor: "Generic", type: "PLA", subType: "" }), "PLA");
});

test("materialLabel: a sub-type is appended, spaces and all", () => {
  assert.equal(call("materialLabel", { vendor: "Generic", type: "TPU", subType: "95A HF" }), "TPU 95A HF");
  assert.equal(call("materialLabel", { vendor: "Snapmaker", type: "PLA", subType: "Basic" }), "PLA Basic");
});

// ---- Matching what is loaded ----

test("currentMaterialIndex: matches the loaded spool on the full triple", () => {
  const head = { loaded: true, vendor: "Snapmaker", material: "PETG", sub: "HF" };
  assert.equal(call("currentMaterialIndex", MATERIALS, head), 5, "must pick Snapmaker PETG HF, not Generic's");
});

test("currentMaterialIndex: vendor alone separates two identically-named filaments", () => {
  const generic = { loaded: true, vendor: "Generic", material: "PETG", sub: "HF" };
  const snapmaker = { loaded: true, vendor: "Snapmaker", material: "PETG", sub: "HF" };
  assert.notEqual(call("currentMaterialIndex", MATERIALS, generic), call("currentMaterialIndex", MATERIALS, snapmaker));
});

test("currentMaterialIndex: a head with no sub-type matches the empty sub-type entry", () => {
  const head = { loaded: true, vendor: "Generic", material: "PLA", sub: null };
  assert.equal(call("currentMaterialIndex", MATERIALS, head), 0);
});

test("currentMaterialIndex: a filament the printer has no profile for matches nothing", () => {
  // BVOH is settable from the touchscreen and has no tuned profile.
  const head = { loaded: true, vendor: "Generic", material: "BVOH", sub: null };
  assert.equal(call("currentMaterialIndex", MATERIALS, head), -1);
  assert.equal(call("currentMaterialIndex", MATERIALS, { loaded: false }), -1);
  assert.equal(call("currentMaterialIndex", null, { loaded: true }), -1);
});

// ---- The select ----

test("materialOptionsHtml: groups by vendor and marks the loaded one selected", () => {
  const html = call("materialOptionsHtml", MATERIALS, 5, null);
  assert.match(html, /<optgroup label="Generic">/);
  assert.match(html, /<optgroup label="Snapmaker">/);
  assert.match(html, /<option value="5" selected>PETG HF<\/option>/);
  // Exactly one selection, or the browser silently picks the last.
  assert.equal((html.match(/ selected/g) || []).length, 1);
});

test("materialOptionsHtml: an unrecognised loaded filament gets a keep-as-is option, selected", () => {
  const html = call("materialOptionsHtml", MATERIALS, -1, "BVOH");
  assert.match(html, /<option value="-1" selected>/, "the keep option must be the selected one");
  assert.match(html, /BVOH/, "and must name what is actually loaded");
  assert.equal((html.match(/ selected/g) || []).length, 1);
});

test("materialOptionsHtml: no keep-as-is option is offered once the load is recognised", () => {
  const html = call("materialOptionsHtml", MATERIALS, 0, null);
  assert.doesNotMatch(html, /value="-1"/);
});

test("materialOptionsHtml: option text is escaped", () => {
  const html = call("materialOptionsHtml", MATERIALS, -1, '<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// ---- What actually gets sent ----

test("pendingMaterial: an unchanged selection sends nothing", () => {
  // Re-sending the same material would be a pointless extra write, and every
  // accepted write also resets that extruder's flow calibration.
  assert.equal(call("pendingMaterial", MATERIALS, 3, 3), null);
});

test("pendingMaterial: leaving an unrecognised filament alone sends nothing", () => {
  assert.equal(call("pendingMaterial", MATERIALS, -1, -1), null);
});

test("pendingMaterial: a changed selection sends that table entry", () => {
  assert.deepEqual(call("pendingMaterial", MATERIALS, 6, 0), { vendor: "Snapmaker", type: "PLA", subType: "Basic" });
});

test("pendingMaterial: picking a material for a previously unrecognised spool sends it", () => {
  assert.deepEqual(call("pendingMaterial", MATERIALS, 1, -1), { vendor: "Generic", type: "PETG", subType: "" });
});

test("pendingMaterial: an out-of-range index never fabricates a material", () => {
  for (const idx of [99, -2, null, undefined, NaN]) {
    assert.equal(call("pendingMaterial", MATERIALS, idx, 0), null, `index ${idx} must send nothing`);
  }
});

// ---- A slot with no material set starts on Generic PLA ----

const head = (material, extra = {}) => ({ loaded: true, vendor: null, material, sub: null, ...extra });
const start = h => { const base = call("currentMaterialIndex", MATERIALS, h); return [base, call("defaultMaterialIndex", MATERIALS, h, base)]; };

test("defaultMaterialIndex: the firmware's NONE, or no material at all, starts on Generic PLA", () => {
  for (const m of ["NONE", "none", "", null, undefined]) assert.deepEqual(start(head(m)), [-1, 0], String(m));
});

test("defaultMaterialIndex: a recognised load keeps its own entry", () => {
  assert.deepEqual(start(head("PETG", { vendor: "Generic", sub: "HF" })), [2, 2]);
});

test("defaultMaterialIndex: an unlisted real material is kept, not replaced (e.g. BVOH)", () => {
  assert.deepEqual(start(head("BVOH")), [-1, -1]);
});

test("defaultMaterialIndex: no Generic PLA in the printer's table means no default", () => {
  assert.equal(call("defaultMaterialIndex", MATERIALS.slice(1), head("NONE"), -1), -1);
});

test("the pre-selected Generic PLA is a real change, and 'keep' is still offered beside it", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(call("pendingMaterial", MATERIALS, 0, -1))), MATERIALS[0], "Apply sends Generic PLA");
  assert.equal(call("pendingMaterial", MATERIALS, -1, -1), null, "choosing keep sends nothing");
  const html = call("materialOptionsHtml", MATERIALS, 0, null, { offerKeep: true });
  assert.match(html, /^<option value="-1">fleet\.modal\.unload\.material_keep_unknown<\/option>/, "keep listed, not selected");
  assert.match(html, /<option value="0" selected>PLA<\/option>/);
});

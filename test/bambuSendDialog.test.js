// test/bambuSendDialog.test.js — the Send dialog has to SHOW what the pre-send
// checks found and stop a send that cannot work.
//
// The logic (bambuSendIssues, materialMatches) is covered by
// bambuPreSendChecks.test.js. What this file guards is that it is actually
// called and rendered: the checks existed for a turn without being wired to
// anything, which is worth a test of its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));

function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  return appSrc.slice(start, appSrc.indexOf("\n}", start) + 2);
}

test("the Send dialog asks the checks about every printer it lists", () => {
  // Through sendIssuesFor(), which adds the one check that depends on what the
  // printer has loaded right now (its trays) to the file-shape checks.
  assert.match(extractFn("renderSendList"), /sendIssuesFor\(p\)/, "a warning nobody renders is not a warning");
  assert.match(extractFn("sendIssuesFor"), /bambuSendIssues/);
});

test("a file that cannot print blocks Send for that printer", () => {
  const fn = extractFn("renderSendList");
  assert.match(fn, /level===?"error"|"error"/, "an error must disable that row's checkbox");
  assert.match(fn, /disabled/);
});

test("Send refuses to start when a chosen printer has a blocking problem", () => {
  const fn = extractFn("doSendUpload");
  assert.match(fn, /sendIssuesFor/,
    "the button must not upload a file the dialog already said cannot print");
  assert.match(fn, /blockers/);
});

// ---- material matching drives the tray picker ----

test("the tray picker pairs by material before colour", () => {
  const at = appSrc.indexOf("const cmapNeed=neededColorsOrSlot();");
  const block = appSrc.slice(at, at + 3000);
  assert.match(block, /materialMatches/,
    "PETG fed from a PLA tray prints at the wrong temperature and fails a few layers in");
});

test("a filament with no tray of its material cannot be sent", () => {
  const block = appSrc.slice(appSrc.indexOf("const cmapNeed=neededColorsOrSlot();"), appSrc.indexOf("card.innerHTML=`"));
  assert.match(block, /matMismatch/, "the mismatch is already marked in the mapping row");
  // …and the dialog refuses, rather than only marking it: the check lives in
  // unmatchedFilaments and reaches Send through sendIssuesFor.
  assert.match(extractFn("unmatchedFilaments"), /materialMatches/);
  assert.match(extractFn("sendIssuesFor"), /unmatchedFilaments/);
});

// ---- multi-plate files ----

test("a file with several plates asks which one to print", () => {
  const fn = extractFn("renderSendList");
  assert.match(appSrc, /function sendPlatePickerHtml\(/, "a picker exists");
  const picker = extractFn("sendPlatePickerHtml");
  assert.match(picker, /plates/);
  assert.match(picker, /MAP\.plate|selectedPlate|SEND_PLATE/, "the choice is remembered");
});

test("a single-plate file shows no picker at all", () => {
  const picker = extractFn("sendPlatePickerHtml");
  assert.match(picker, /length\s*<\s*2|<=\s*1/, "one plate is not a choice");
});

test("the chosen plate travels with the print request", () => {
  const fn = extractFn("pushTo");
  assert.match(fn, /plate/, "otherwise a 3-plate file always prints plate 1");
});

// ---- the strings exist ----

for (const key of ["issue_not_sliced", "issue_model_mismatch", "issue_model_unverified",
                   "issue_nozzle_mismatch", "blocked_material", "plate_label"]) {
  test(`fleet.send.${key} is in both shipped locales`, () => {
    for (const loc of ["en", "es"]) {
      const j = loc === "en" ? EN : JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));
      const s = j.fleet && j.fleet.send && j.fleet.send[key];
      assert.ok(s && String(s).trim(), `missing ${loc}: fleet.send.${key}`);
    }
  });
}

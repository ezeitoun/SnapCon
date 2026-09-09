// test/fileSelectionLifecycle.test.js — closing the file manager must not leave
// an invisible selection driving visible UI.
//
// Reported live: after ejecting a loaded job from a U1, the card still showed
// the colour->head mapping row. The eject was fine; the mapping is not driven by
// what is loaded on the printer at all. It is gated on
// `canSend = p.online && SELECTED && !busy && !maintMode` -- the file selected
// in the file manager. The file manager was closed, so the selection was
// invisible while still driving a visible control.
//
// applyFilesOpen() already hid the OTHER piece of SELECTED-driven UI (the
// "Selected Model" summary) on close, and deliberately kept the selection so
// reopening would restore it. The per-card mapping was simply never included in
// that rule, which is the inconsistency this fixes -- by clearing the selection
// on close rather than hiding a second thing, because a remembered-but-invisible
// selection is the confusing part.
//
// The button asymmetry below is the point, and is why clearing is safe:
// Upload has nothing to upload without a selection and must go disabled, but
// Print stays live -- with no selection it opens the printer's own files, which
// is a genuinely useful action and one the tooltips already anticipate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function fnSource(name) {
  const at = appSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in public/app.js");
  return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
}

test("closing the file manager clears the job selection", () => {
  const src = fnSource("applyFilesOpen");
  assert.match(src, /clearJobSelection\(\)/,
    "an invisible selection must not keep driving the cards' mapping row");
});

test("the selection is cleared only on a real open -> closed transition", () => {
  // applyFilesOpen() also runs at startup and from the settings flow, and
  // clearJobSelection() calls renderFleet(). Firing it unconditionally would
  // render the fleet before it has loaded.
  const src = fnSource("applyFilesOpen");
  // The STATEMENT, not the first textual match — the comment above it names the
  // function too, and slicing at that would test the prose instead of the code.
  const call = src.split("\n").find(l => l.includes("clearJobSelection()") && !l.trim().startsWith("//"));
  assert.ok(call, "clearJobSelection() must actually be called, not only described");
  assert.match(call, /FILES_WERE_OPEN|wasOpen|prevOpen/,
    "must track the previous state rather than clearing on every call");
  assert.match(call, /SELECTED/, "and must only bother when something is actually selected");
});

test("Print stays usable with no selection, and offers the printer's own files", () => {
  // The whole reason clearing the selection is safe.
  const handler = appSrc.slice(appSrc.indexOf("// Print with no file selected in SnapCon"));
  assert.match(handler.slice(0, 200), /if\(start&&!SELECTED\)\{\s*openPrinterFiles\(id\);/,
    "printing something already on the printer must survive an empty selection");

  const printBtn = appSrc.split("\n").find(l => l.includes('data-start="1"') && l.includes("btn-chip"));
  assert.ok(printBtn, "the card Print button must exist");
  assert.doesNotMatch(printBtn, /canSend&&canAct/,
    "Print must NOT be gated on the selection — only Upload is");
});

test("Upload is gated on the selection", () => {
  const uploadBtn = appSrc.split("\n").find(l => l.includes('data-start="0"') && l.includes("btn-chip"));
  assert.ok(uploadBtn, "the card Upload button must exist");
  assert.match(uploadBtn, /canSend&&canAct/,
    "there is nothing to upload without a selected file");
});

test("ejecting a loaded job refreshes the fleet", () => {
  // Every comparable action ends with loadFleet(); eject did not, so the card
  // stayed stale until the next poll happened to come round.
  const src = fnSource("ejectFile");
  assert.match(src, /loadFleet\(\)/, "eject must refresh the card it just changed");
});

test("the comment no longer claims a closed file list remembers its selection", () => {
  const src = fnSource("applyFilesOpen");
  assert.doesNotMatch(src, /selection itself is remembered/,
    "that behaviour is what changed — the comment must not outlive it");
});

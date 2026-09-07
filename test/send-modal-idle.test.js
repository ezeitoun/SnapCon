// test/send-modal-idle.test.js — the Send/upload modal's "idle" predicate.
//
// Same bug class as test/fleet-eject.test.js, found by the state-string sweep
// that fix asked for (docs/TODO.md item 9g). Two call sites in the Send modal
// still compared `p.state === 'idle'`, a string NO connector emits:
//
//   Klipper family (creality/moonraker/U1)  print_stats.state ->
//       standby | printing | paused | complete | cancelled | error
//   FlashForge  STATE_MAP ->
//       standby | complete | printing | busy | cancelled | paused | error
//   dummy-simulator  PHASE_TO_STATE ->
//       standby | printing | paused | complete | cancelled | error
//
// 'idle' is only the label statusColorText falls back to for DISPLAY. So on a
// real fleet the branch was dead, and both call sites failed silently:
//
//   1. renderSendList  — `idle` drives the row's default checkbox AND its
//      status dot. Nothing was ever pre-checked, and a printer whose own row
//      read "Idle" got the busy-coloured dot right next to that text.
//   2. the "Idle only" button — selected nothing, ever.
//
// Both now go through one predicate so the vocabulary lives in a single place.
// 'idle' is accepted alongside 'standby' for the same defensive reason
// canEject() keeps it.
//
// Deliberately NOT widened: complete/cancelled stay unselected. statusColorText
// gives those their own label and colour, so they are not "Idle" rows, and the
// button says "Idle only". This fix makes the dead branch live; it does not
// change which printers the modal was designed to pre-select.
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
  const end = appSrc.indexOf("\n}", start);
  return appSrc.slice(start, end + 2);
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(extractFn("isIdle"), sandbox);
const isIdle = p => vm.runInContext("isIdle", sandbox)(p);

test("a printer sitting at Klipper's standby counts as idle", () => {
  assert.equal(isIdle({ online: true, state: "standby" }), true,
    "'standby' is what the Klipper connectors actually emit — this was the bug");
});

test("'idle' is still accepted, for the same reason canEject keeps it", () => {
  assert.equal(isIdle({ online: true, state: "idle" }), true);
});

test("a busy printer is not idle", () => {
  assert.equal(isIdle({ online: true, state: "printing" }), false);
  assert.equal(isIdle({ online: true, state: "paused" }), false);
  assert.equal(isIdle({ online: true, state: "error" }), false);
});

test("finished states are not pre-selected — the button says 'Idle only'", () => {
  assert.equal(isIdle({ online: true, state: "complete" }), false,
    "statusColorText labels these Complete/Cancelled, not Idle");
  assert.equal(isIdle({ online: true, state: "cancelled" }), false);
});

test("an offline printer is never idle, whatever state it last reported", () => {
  assert.equal(isIdle({ online: false, state: "standby" }), false);
  assert.equal(isIdle({ online: false, state: "idle" }), false);
});

test("isIdle tolerates a malformed or missing printer row instead of throwing", () => {
  assert.equal(isIdle(undefined), false);
  assert.equal(isIdle(null), false);
  assert.equal(isIdle({}), false);
  assert.equal(isIdle({ online: true, state: null }), false);
});

// The predicate being right proves nothing if the modal still hand-rolls its
// own comparison — that is exactly how this bug survived the eject fix.
test("both Send-modal call sites go through the predicate, not a state string", () => {
  const render = appSrc.slice(appSrc.indexOf("function renderSendList("));
  const renderBody = render.slice(0, render.indexOf("\n}") + 2);
  assert.match(renderBody, /isIdle\(/,
    "renderSendList must ask the predicate for the checkbox and the dot");
  assert.doesNotMatch(renderBody, /state\s*===\s*['"]idle['"]/,
    "renderSendList must not compare the state string itself");

  const btn = appSrc.slice(appSrc.indexOf('$("sendSelectIdle")'));
  const handler = btn.slice(0, btn.indexOf("});") + 3);
  assert.match(handler, /isIdle\(/,
    "the 'Idle only' button must ask the predicate too");
  assert.doesNotMatch(handler, /state\s*===\s*['"]idle['"]/,
    "the 'Idle only' button must not compare the state string itself");
});

// test/fleet-eject.test.js — when the card's Eject button is offered.
//
// Two real bugs, both reported live on a 20+ printer farm:
//
// 1. The i7 had a file loaded in Klipper and no Eject button. The condition
//    required `p.state === 'idle'`, but NO connector emits that string --
//    Klipper connectors report Klipper's own word, "standby", and 'idle' is
//    only the label statusColorText falls back to for display. Confirmed
//    against a live fleet whose states were exactly
//    {standby, paused, complete, printing}. So the 'idle' arm was dead code and
//    Eject only ever appeared via 'complete'/'cancelled'.
//
// 2. U1 Blue showed the "Loaded" badge with no way to clear it. That badge is
//    driven by p.queuedFile (SnapCon's own staged-file tracking), which is
//    cleared ONLY when the file is finally printed -- there was no dismiss
//    path at all, and Eject was not offered for it because the condition
//    required p.filename (Klipper's loaded file), which is empty for a staged
//    file that has not been started.
//
// Eject now means "this printer is no longer holding a job for me": offered
// whenever Klipper has a file OR SnapCon has one staged, in any state where
// ejecting is safe. 'idle' is kept alongside 'standby' because FlashForge
// normalises standby->idle in at least one path (flashforge-utils.js), so a
// connector may legitimately emit it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  const end = appSrc.indexOf("\n}", start);
  return appSrc.slice(start, end + 2);
}
const sandbox = {};
vm.createContext(sandbox);
// canEject asks ejectUnsupported() whether the printer has an eject command of
// its own (Bambu Lab has none), so both come into the sandbox together.
vm.runInContext(extractFn("ejectUnsupported"), sandbox);
vm.runInContext(extractFn("canEject"), sandbox);
const canEject = p => vm.runInContext("canEject", sandbox)(p);

const staged = { name: "Alicorn Dragon (19h24m).gcode", status: "ready", ts: 1 };

// A printer with no eject command of its own. Verified live on a Bambu Lab
// P2S: nothing sent to the machine clears a finished or cancelled job —
// clean_print_error is accepted and changes nothing, print_clean is refused —
// so its last job is history, not something SnapCon can eject. A file SnapCon
// staged for it still is.
const noEject = { capabilities: { eject: false } };

test("a printer that cannot eject is not offered the button for its own last job", () => {
  assert.equal(canEject({ ...noEject, state: "cancelled", filename: "ams.3mf" }), false,
    "the button was previously shown disabled here, which read as broken");
  assert.equal(canEject({ ...noEject, state: "complete", filename: "ams.3mf" }), false);
});

test("a printer that cannot eject still drops a file SnapCon staged for it", () => {
  assert.equal(canEject({ ...noEject, state: "cancelled", filename: "ams.3mf", queuedFile: staged }), true,
    "clearing SnapCon's own staged file is real work the button can still do");
});

test("Eject is offered for a Klipper-loaded file while the printer sits at standby", () => {
  assert.equal(canEject({ state: "standby", filename: "Beardie (7h35m).gcode" }), true,
    "'standby' is what Klipper connectors actually emit — this was the i7 bug");
});

test("Eject is still offered for the states that already worked", () => {
  assert.equal(canEject({ state: "complete",  filename: "a.gcode" }), true);
  assert.equal(canEject({ state: "cancelled", filename: "a.gcode" }), true);
  assert.equal(canEject({ state: "idle",      filename: "a.gcode" }), true,
    "kept: FlashForge normalises standby->idle in at least one path");
});

test("Eject is offered for a file SnapCon staged, even though Klipper has none", () => {
  assert.equal(canEject({ state: "standby", filename: "", queuedFile: staged }), true,
    "the 'Loaded' badge must be dismissable — this was the U1 Blue bug");
});

test("Eject is not offered when the printer is holding nothing", () => {
  assert.equal(canEject({ state: "standby", filename: "" }), false);
  assert.equal(canEject({ state: "complete", filename: "" }), false);
});

test("Eject is never offered mid-job", () => {
  assert.equal(canEject({ state: "printing", filename: "a.gcode" }), false,
    "ejecting a running print is not a thing the button should offer");
  assert.equal(canEject({ state: "paused",   filename: "a.gcode" }), false);
  assert.equal(canEject({ state: "printing", filename: "a.gcode", queuedFile: staged }), false);
});

test("a staged file that is still uploading is not ejectable yet", () => {
  assert.equal(canEject({ state: "standby", filename: "",
    queuedFile: { name: "x.gcode", status: "uploading", ts: 1 } }), false,
    "mid-upload is not a job the printer is holding — let it finish or fail");
});

test("canEject tolerates a malformed printer row instead of throwing", () => {
  assert.equal(canEject({}), false);
  assert.equal(canEject({ state: null, filename: null, queuedFile: null }), false);
});

// The server half has no express harness in this project (same constraint
// test/connectors/creality-webrtc-camera.test.js documents), so the route's
// contract is asserted against source text: ejecting must also clear the staged
// entry, or the "Loaded" badge would survive the very action meant to dismiss it.
test("the eject route clears SnapCon's staged file, not just Klipper's", () => {
  const i = serverSrc.indexOf('app.post("/api/printctl"');
  assert.ok(i > 0, "printctl route must exist");
  const route = serverSrc.slice(i, i + 1600);
  assert.match(route, /action === "eject"/,
    "the eject action needs its own branch to clear the staged file");
  assert.match(route, /queuedFile\.delete/,
    "eject must remove the staged entry");
  assert.match(route, /saveQueuedFiles\(\)/,
    "and persist that removal, or it returns on restart");
});

// test/firmwareEligibility.test.js — which printers a user may tick in the
// Firmware tab, executed rather than pattern-matched.
//
// firmwareIneligibleReason() decides whether a checkbox is enabled, so a
// mistake in it either hides a printer that could safely be updated or offers
// one that is mid-print. The rule it implements is deliberately a mirror of
// firmwareDeployBlockedBy() in server.js — the server is the authority, and a
// frontend rule the server does not have would disable a control the server
// would have accepted. A source-text assertion would pass while the logic
// regressed, so the function is extracted and run in a node:vm sandbox, the
// same approach test/fleet-card-live-values.test.js documents.
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
  assert.ok(end > start, name + " must have a top-level closing brace");
  return appSrc.slice(start, end + 2);
}
// Same idea for a top-level object literal, which closes on "\n};".
function extractConst(name) {
  const start = appSrc.indexOf("const " + name + "=");
  assert.ok(start > 0, name + " must exist in public/app.js");
  const end = appSrc.indexOf("\n};", start);
  assert.ok(end > start, name + " must have a top-level closing brace");
  return appSrc.slice(start, end + 3);
}

// t() returns the key itself, so an assertion names the string the user is
// shown without depending on the English wording.
//
// Three pieces, because the decision and its wording are deliberately
// separate: firmwareIneligibleCode() is the single rule (mirroring the
// server), FW_INELIGIBLE_KEYS turns a code into a message, and the status
// sort groups on the code rather than on the translated text.
const sandbox = { t: k => k };
vm.createContext(sandbox);
vm.runInContext(extractFn("firmwareIneligibleCode"), sandbox);
vm.runInContext(extractConst("FW_INELIGIBLE_KEYS"), sandbox);
vm.runInContext(extractFn("firmwareIneligibleReason"), sandbox);
const reason = sandbox.firmwareIneligibleReason;
const code = sandbox.firmwareIneligibleCode;

const U1 = extra => ({ online: true, state: "standby", capabilities: { firmwareDeploy: true }, ...extra });

// ---------------------------------------------------------------------------

test("an idle U1 is selectable", () => {
  assert.equal(reason(U1()), null);
  assert.equal(reason(U1({ state: "complete" })), null);
  assert.equal(reason(U1({ state: "cancelled" })), null);
  assert.equal(code(U1()), null);
});

test("the code, not the message, is what the status sort groups on", () => {
  // Sorting on the rendered text would order printers alphabetically by
  // their translated status, which changes meaning with the language and is
  // not an order anyone asked for.
  assert.equal(code(U1({ state: "printing" })), "printing");
  assert.equal(code(U1({ online: false })), "offline");
  assert.equal(code(U1({ state: "updating" })), "in_progress");
  assert.equal(code({ online: true, capabilities: {} }), "unsupported");
  assert.equal(code(U1({ state: "maintenance" })), null);
});

test("a printer in maintenance mode is selectable — that is the moment TO update", () => {
  // The server agrees (firmwareDeployBlockedBy blocks only printing/paused/
  // offline); a frontend that disabled this would be inventing a rule.
  assert.equal(reason(U1({ state: "maintenance" })), null);
});

test("a printing or paused printer is not selectable, and says why", () => {
  assert.equal(reason(U1({ state: "printing" })), "settings.firmware.ineligible_printing");
  assert.equal(reason(U1({ state: "paused" })), "settings.firmware.ineligible_printing");
});

test("an offline printer is not selectable", () => {
  assert.equal(reason(U1({ online: false })), "settings.firmware.ineligible_offline");
  // ...and offline outranks whatever stale state came with it.
  assert.equal(reason(U1({ online: false, state: "standby" })), "settings.firmware.ineligible_offline");
});

test("a connector that cannot deploy firmware is never offered", () => {
  assert.equal(reason({ online: true, state: "standby", capabilities: {} }),
    "settings.firmware.ineligible_unsupported");
  assert.equal(reason({ online: true, state: "standby" }),
    "settings.firmware.ineligible_unsupported");
  assert.equal(reason({ online: true, state: "standby", capabilities: { firmwareDeploy: false } }),
    "settings.firmware.ineligible_unsupported");
  // Unsupported is decided before online/idle: a Creality that happens to be
  // idle must still say the connector cannot do this, not "offline".
  assert.equal(reason({ online: false, capabilities: {} }),
    "settings.firmware.ineligible_unsupported");
});

test("a printer already being updated cannot be queued again from the UI", () => {
  // The server refuses it with 409 regardless; this stops the user aiming at
  // it in the first place, and explains what they are seeing on the card.
  assert.equal(reason(U1({ state: "updating" })), "settings.firmware.ineligible_in_progress");
  // ...including through the reboot window, when the printer is unreachable:
  // "an update is running" is the true answer there, not "offline".
  assert.equal(reason(U1({ online: false, state: "updating" })),
    "settings.firmware.ineligible_in_progress");
});

test("a printer the fleet does not know about is not selectable", () => {
  // FLEET.find() returns undefined for a row whose printer has been removed
  // since Get Firmware ran; that must not read as "eligible".
  assert.equal(reason(undefined), "settings.firmware.ineligible_offline");
  assert.equal(reason(null), "settings.firmware.ineligible_offline");
});

test("every reason it can return is a real translated key", () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));
  const get = (o, k) => k.split(".").reduce((a, b) => a && a[b], o);
  const returned = new Set([
    reason(undefined), reason(U1({ online: false })), reason(U1({ state: "printing" })),
    reason(U1({ state: "updating" })), reason({ online: true, capabilities: {} }),
  ]);
  assert.equal(returned.size, 4, "four distinct reasons, none of them null");
  for (const k of returned) {
    assert.ok(get(en, k), "missing en key: " + k);
    assert.ok(get(es, k), "missing es key: " + k);
  }
});

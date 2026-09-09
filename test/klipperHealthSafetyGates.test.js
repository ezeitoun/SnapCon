// test/klipperHealthSafetyGates.test.js — the two server-side gates that
// decide whether SnapCon may start work on a printer (docs/TODO.md item 9b).
//
// Mapping a Klipper shutdown to state:"error" in the connectors is necessary
// but NOT sufficient, because both gates were written as denylists:
//
//   isPrinterIdle()          st.online && state !== "printing" && !== "paused"
//   firmwareDeployBlockedBy() blocks only "printing"/"paused"
//
// "error" satisfies neither exclusion, so a crashed printer would still be
// handed a queued job and still be flashed. The connector fix alone would have
// changed the badge and left both holes open.
//
// isPrinterIdle() therefore becomes an allowlist. That is a one-way safety
// argument: an unrecognised or future state now means "don't start work",
// instead of "go ahead". FlashForge's "busy" is deliberately NOT allowed --
// it was treated as idle before, but a dispatch predicate should not call an
// ambiguous state idle merely to preserve old behavior.
//
// No express harness exists in this project, so both functions are extracted
// from server.js and run against a stubbed probeCached -- real behavior, not a
// source-text assertion.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extractFn(name) {
  const start = serverSrc.indexOf("async function " + name + "(");
  assert.ok(start > 0, name + " must exist in server.js");
  return serverSrc.slice(start, serverSrc.indexOf("\n}", start) + 2);
}
function extractConst(name) {
  const start = serverSrc.indexOf("const " + name + " =");
  assert.ok(start > 0, name + " must exist in server.js");
  return serverSrc.slice(start, serverSrc.indexOf(";", start) + 1);
}

// Runs a gate with probeCached stubbed to return exactly this fleet row.
function withProbe(fnSrc, extraSrc, st) {
  const sandbox = { probeCached: async () => st };
  vm.createContext(sandbox);
  if (extraSrc) vm.runInContext(extraSrc, sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox;
}

const IDLE_SRC = () => extractFn("isPrinterIdle");
// isPrinterIdle also consults the start-sequence guard (docs/TODO.md 9i), so the
// sandbox must supply it. Empty here: these tests are about the allowlist, and
// the guard has its own file (test/startSequenceGuard.test.js).
const IDLE_SET = () => extractConst("DISPATCH_IDLE_STATES") + "\n" + extractConst("STARTING");
const idle = st => withProbe(IDLE_SRC(), IDLE_SET(), st).isPrinterIdle({ name: "P", url: "http://x" });
const blocked = st => withProbe(extractFn("firmwareDeployBlockedBy"), null, st)
  .firmwareDeployBlockedBy({ name: "U1 Black", url: "http://x" });

// ---- isPrinterIdle: the queue/upload dispatch gate ----

test("a printer reporting a Klipper fault is NOT idle", async () => {
  assert.equal(await idle({ online: true, state: "error" }), false,
    "this is the hole: a crashed machine was being handed queued jobs");
});

test("the states a printer can genuinely be free in are still idle", async () => {
  for (const state of ["standby", "idle", "complete", "cancelled"]) {
    assert.equal(await idle({ online: true, state }), true, state + " must remain dispatchable");
  }
});

test("mid-job states are still not idle", async () => {
  assert.equal(await idle({ online: true, state: "printing" }), false);
  assert.equal(await idle({ online: true, state: "paused" }), false);
});

test("FlashForge 'busy' is not treated as idle", async () => {
  assert.equal(await idle({ online: true, state: "busy" }), false,
    "deliberate tightening: an ambiguous state must not authorise starting work");
});

test("an unknown or future state fails closed", async () => {
  assert.equal(await idle({ online: true, state: "unknown" }), false);
  assert.equal(await idle({ online: true, state: "some_new_klipper_state" }), false);
  assert.equal(await idle({ online: true }), false);
});

test("an offline printer is never idle", async () => {
  assert.equal(await idle({ online: false, state: "standby" }), false);
});

test("a probe that throws fails closed", async () => {
  const sandbox = { probeCached: async () => { throw new Error("boom"); } };
  vm.createContext(sandbox);
  vm.runInContext(IDLE_SET(), sandbox);
  vm.runInContext(IDLE_SRC(), sandbox);
  assert.equal(await sandbox.isPrinterIdle({ name: "P" }), false);
});

// ---- firmwareDeployBlockedBy: the last gate before an irreversible write ----

test("a printer reporting an error refuses the flash", async () => {
  const why = await blocked({ online: true, state: "error" });
  assert.ok(why, "flashing a machine that is reporting a fault must be refused");
  assert.match(why, /U1 Black/, "the message must name the printer, per the destructive-action convention");
});

test("the error refusal is stated separately from the printing one", async () => {
  const errWhy = await blocked({ online: true, state: "error" });
  const printWhy = await blocked({ online: true, state: "printing" });
  assert.notEqual(errWhy, printWhy,
    "'is printing' would be a lie about a crashed printer, and tells the operator the wrong fix");
});

test("printing and paused still refuse the flash", async () => {
  assert.ok(await blocked({ online: true, state: "printing" }));
  assert.ok(await blocked({ online: true, state: "paused" }));
});

test("a healthy idle printer is still allowed to flash", async () => {
  assert.equal(await blocked({ online: true, state: "standby" }), null);
  assert.equal(await blocked({ online: true, state: "complete" }), null);
});

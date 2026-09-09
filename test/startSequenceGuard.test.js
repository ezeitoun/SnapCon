// test/startSequenceGuard.test.js — a printer with a start sequence in flight
// must not read as idle (docs/TODO.md item 9i).
//
// Between "SnapCon began starting a print" and "the printer reports a job",
// there is a window where the machine is physically busy but print_stats still
// says standby with no filename. isPrinterIdle()'s allowlist contains standby,
// so during that window the printer looks dispatchable:
//
//   - queue dispatch can claim and dispatch onto a printer already mid-start
//     from another path (queue-onto-its-own-dispatch is separately protected by
//     queueState, so this is specifically the cross-path case)
//   - /api/notify-load uploads immediately instead of staging
//   - the fleet card reads Idle
//
// The window is NOT CFS-specific and predates the CFS work. Measured lengths:
// Creality auto-level runs G29 inside applyHeadMapping bounded at TWELVE
// minutes; CFS material preparation runs 4-5 minutes; U1 head-mapping macros
// are seconds. Same race, three durations, so the guard keys off "a start is in
// progress" rather than off any brand.
//
// The dangerous failure here is a LEAKED entry: a printer left in the set is
// permanently undispatchable, which is worse than the bug being fixed. Hence
// the cleanup tests below cover every exit path, not just the happy one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extract(name, kind) {
  const needle = kind === "async" ? "async function " + name + "(" : "function " + name + "(";
  const start = serverSrc.indexOf(needle);
  assert.ok(start > 0, name + " must exist in server.js");
  return serverSrc.slice(start, serverSrc.indexOf("\n}", start) + 2);
}
function extractConst(name) {
  const start = serverSrc.indexOf("const " + name + " =");
  assert.ok(start > 0, name + " must exist in server.js");
  return serverSrc.slice(start, serverSrc.indexOf(";", start) + 1);
}

// A sandbox holding the guard, the allowlist and a stubbed probe.
function sandbox(probeResult) {
  const env = {
    probeCached: async () => probeResult,
    console: { log() {}, error() {} }
  };
  vm.createContext(env);
  vm.runInContext(extractConst("STARTING"), env);
  vm.runInContext(extractConst("DISPATCH_IDLE_STATES"), env);
  vm.runInContext(extract("isPrinterIdle", "async"), env);
  vm.runInContext(extract("withStartSequence", "async"), env);
  // A `const` declared inside a vm context is NOT a property of the sandbox
  // object, unlike a function declaration -- so reach it by evaluating its name.
  // The Set is mutated in place, so one reference stays valid.
  env.startingSet = vm.runInContext("STARTING", env);
  return env;
}

const IDLE_PROBE = { online: true, state: "standby" };

test("a printer is not idle while its start sequence is in flight", async () => {
  const env = sandbox(IDLE_PROBE);
  const p = { id: "p20", name: "SPARKX i7" };
  assert.equal(await env.isPrinterIdle(p), true, "precondition: idle before the sequence begins");

  let duringWindow = null;
  await env.withStartSequence(p, async () => { duringWindow = await env.isPrinterIdle(p); });

  assert.equal(duringWindow, false,
    "the printer is physically homing/loading/levelling here — dispatching onto it is the bug");
});

test("the guard is generic, not tied to any brand or connector", async () => {
  // The window's length differs per printer (12 min of Creality G29, 4-5 min of
  // CFS preparation, seconds of U1 macros) but the race is identical, so the
  // guard must not care what the printer is.
  for (const p of [
    { id: "u1-black", name: "U1 Black" },
    { id: "ff-5m", name: "5M PRO" },
    { id: "v3-yellow", name: "V3 Plus Yellow" },
    { id: 17, name: "Dummy#1" }
  ]) {
    const env = sandbox(IDLE_PROBE);
    let during = null;
    await env.withStartSequence(p, async () => { during = await env.isPrinterIdle(p); });
    assert.equal(during, false, p.name + " must be guarded too");
    assert.equal(await env.isPrinterIdle(p), true, p.name + " must be released afterwards");
  }
});

test("the entry is cleared after a successful start", async () => {
  const env = sandbox(IDLE_PROBE);
  const p = { id: "p20", name: "i7" };
  await env.withStartSequence(p, async () => "started");
  assert.equal(env.startingSet.has(p.id), false);
  assert.equal(await env.isPrinterIdle(p), true, "a finished start must not leave the printer stuck");
});

test("the entry is cleared when the start sequence rejects", async () => {
  const env = sandbox(IDLE_PROBE);
  const p = { id: "p20", name: "i7" };
  await assert.rejects(() => env.withStartSequence(p, async () => { throw new Error("G29 failed"); }));
  assert.equal(env.startingSet.has(p.id), false,
    "a printer left in the set is permanently undispatchable — worse than the bug being fixed");
});

test("the entry is cleared when the callback throws synchronously", async () => {
  const env = sandbox(IDLE_PROBE);
  const p = { id: "p20", name: "i7" };
  await assert.rejects(() => env.withStartSequence(p, () => { throw new Error("boom"); }));
  assert.equal(env.startingSet.has(p.id), false);
});

test("the entry is cleared on an early return from inside the sequence", async () => {
  const env = sandbox(IDLE_PROBE);
  const p = { id: "p20", name: "i7" };
  const out = await env.withStartSequence(p, async () => { return "early"; });
  assert.equal(out, "early", "the callback's value must pass through");
  assert.equal(env.startingSet.has(p.id), false);
});

// THE SAME PRINTER, TWICE, OVERLAPPING. There is no invariant preventing this:
//   /api/print gates on isPrinterIdle only when NOT starting -- the starting
//     case, which is the one that enters the guard, has no gate at all
//   /api/printfile has no idle gate whatsoever
//   queue dispatch gates on isPrinterIdle + the atomic claimNextForDispatch,
//     which serialises queue-against-queue and nothing else
// So two rapid Print clicks, or a Print racing a queue dispatch, both enter.
// With a plain Set the first completion deletes the entry and un-guards a start
// that is still running.
test("one start completing does not un-guard another still running on the same printer", async () => {
  const env = sandbox(IDLE_PROBE);
  const p = { id: "p20", name: "i7" };
  let releaseFirst;
  const first = new Promise(r => { releaseFirst = r; });
  let releaseSecond;
  const second = new Promise(r => { releaseSecond = r; });

  const a = env.withStartSequence(p, () => first);
  const b = env.withStartSequence(p, () => second);
  assert.equal(await env.isPrinterIdle(p), false, "both in flight");

  releaseFirst();
  await a;
  assert.equal(await env.isPrinterIdle(p), false,
    "the second start is still running — releasing here would let a job be dispatched onto it");

  releaseSecond();
  await b;
  assert.equal(await env.isPrinterIdle(p), true, "released only once every start has finished");
  assert.equal(env.startingSet.size, 0, "and nothing is left behind");
});

test("a failing start does not un-guard a concurrent healthy one", async () => {
  const env = sandbox(IDLE_PROBE);
  const p = { id: "p20", name: "i7" };
  let releaseGood;
  const good = new Promise(r => { releaseGood = r; });
  const bad = env.withStartSequence(p, async () => { throw new Error("G29 failed"); });
  const ok = env.withStartSequence(p, () => good);
  await assert.rejects(() => bad);
  assert.equal(await env.isPrinterIdle(p), false, "the healthy start is still in flight");
  releaseGood();
  await ok;
  assert.equal(env.startingSet.size, 0);
});

test("two printers starting at once do not release each other", async () => {
  const env = sandbox(IDLE_PROBE);
  const a = { id: "a", name: "A" }, b = { id: "b", name: "B" };
  let seen = null;
  await env.withStartSequence(a, async () => {
    await env.withStartSequence(b, async () => {});
    seen = await env.isPrinterIdle(a);
  });
  assert.equal(seen, false, "B finishing must not release A");
  assert.equal(env.startingSet.size, 0, "both released at the end");
});

test("idle semantics are otherwise unchanged", async () => {
  // Nothing about the allowlist itself may shift: the guard only ever adds a
  // reason to say "not idle".
  for (const [state, expected] of [
    ["standby", true], ["idle", true], ["complete", true], ["cancelled", true],
    ["printing", false], ["paused", false], ["error", false], ["busy", false], ["unknown", false]
  ]) {
    const env = sandbox({ online: true, state });
    assert.equal(await env.isPrinterIdle({ id: "x" }), expected, state + " must be unchanged");
  }
  const offline = sandbox({ online: false, state: "standby" });
  assert.equal(await offline.isPrinterIdle({ id: "x" }), false, "offline unchanged");
});

test("a probe failure still fails closed, guard or no guard", async () => {
  const env = {
    probeCached: async () => { throw new Error("unreachable"); },
    console: { log() {}, error() {} }
  };
  vm.createContext(env);
  vm.runInContext(extractConst("STARTING"), env);
  vm.runInContext(extractConst("DISPATCH_IDLE_STATES"), env);
  vm.runInContext(extract("isPrinterIdle", "async"), env);
  assert.equal(await env.isPrinterIdle({ id: "x" }), false);
});

// ---- every start path must be inside the guard ----
test("all three start paths wrap their start sequence", () => {
  let from = 0, wrapped = 0, total = 0;
  for (;;) {
    const at = serverSrc.indexOf("c.startPrintFile(", from);
    if (at < 0) break;
    total++;
    // The guard must open before this start, and near enough to be the same
    // block rather than an unrelated earlier one.
    const guardAt = serverSrc.lastIndexOf("withStartSequence(", at);
    if (guardAt > 0 && at - guardAt < 2000) wrapped++;
    from = at + 1;
  }
  assert.equal(total, 3, "/api/print, /api/printfile and queue dispatch");
  assert.equal(wrapped, 3, "every start sequence must be guarded, not just the CFS one");
});

test("the guard wraps head mapping too, not only the start command", () => {
  // applyHeadMapping is where the long waits actually live -- Creality's G29 is
  // bounded at twelve minutes and CFS preparation runs minutes. Guarding only
  // startPrintFile would leave the largest window open.
  let from = 0, checked = 0;
  for (;;) {
    const at = serverSrc.indexOf("c.applyHeadMapping(", from);
    if (at < 0) break;
    const guardAt = serverSrc.lastIndexOf("withStartSequence(", at);
    const startAfter = serverSrc.indexOf("c.startPrintFile(", at);
    // Only mapping calls that lead into a start need the guard; the staging
    // path (uploadNotifiedFile) never starts a print.
    if (startAfter > 0 && startAfter - at < 2000) {
      assert.ok(guardAt > 0 && at - guardAt < 2000,
        "head mapping at offset " + at + " runs outside the guard");
      checked++;
    }
    from = at + 1;
  }
  assert.ok(checked >= 3, "expected the three start paths' mapping calls, saw " + checked);
});

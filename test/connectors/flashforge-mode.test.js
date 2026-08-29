// test/connectors/flashforge-mode.test.js — the FlashForge transport-mode
// detection state machine (connectors/flashforge-mode.js).
//
// The behavior worth protecting is not "it picks a port": it's that a printer
// whose firmware changes underneath it heals without a restart, that a single
// blip never re-routes a working printer, that an explicit user pin is never
// silently overridden, and that a total outage caches nothing.
//
// This module performs no I/O by design — both liveness probes are injected as
// thunks — so none of these tests stub the network. If a future change makes
// this file need a network stub, that change broke the module's contract.
const test = require("node:test");
const assert = require("node:assert/strict");
const mode = require("../../connectors/flashforge-mode");

// A printer object with only the fields the state machine reads.
const P = (over = {}) => ({ id: "prt_1", name: "AD5X", url: "http://10.0.0.5", ...over });

// Probe thunk builders. `hits` records invocation counts so tests can assert a
// thunk was never called — the only way to prove "no probe was fired".
function thunks(nativeOk, moonrakerOk, hits = { native: 0, moonraker: 0 }) {
  return {
    hits,
    native: async () => { hits.native++; if (!nativeOk) throw new Error("ECONNREFUSED"); return {}; },
    moonraker: async () => { hits.moonraker++; if (!moonrakerOk) throw new Error("ECONNREFUSED"); return {}; }
  };
}

test.beforeEach(() => mode._resetAll());

test("detects native when only 8898 answers", async () => {
  const t = thunks(true, false);
  assert.equal(await mode.resolve(P(), t), "native");
});

test("detects moonraker when only 7125 answers", async () => {
  const t = thunks(false, true);
  assert.equal(await mode.resolve(P(), t), "moonraker");
});

test("native wins the tie on first detection, so a stock printer is never re-routed", async () => {
  const t = thunks(true, true);
  assert.equal(await mode.resolve(P(), t), "native");
});

test("caches the resolved mode — a second resolve fires no probes", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  const before = { ...t.hits };
  assert.equal(await mode.resolve(P(), t), "moonraker");
  assert.deepEqual(t.hits, before, "cached resolve must not re-probe");
});

test("caches nothing when neither transport answers", async () => {
  const t = thunks(false, false);
  assert.equal(await mode.resolve(P(), t), null);
  // A second call must probe again rather than inherit a guess.
  await mode.resolve(P(), t);
  assert.equal(t.hits.native, 2);
  assert.equal(t.hits.moonraker, 2);
});

test("runs both probes concurrently, so an offline printer costs one timeout not two", async () => {
  const slowFail = () => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 120));
  const started = Date.now();
  assert.equal(await mode.resolve(P(), { native: slowFail, moonraker: slowFail }), null);
  // Sequential would be ~240ms. Generous bound — this asserts concurrency, not speed.
  assert.ok(Date.now() - started < 200, "probes must run in parallel");
});

// ---- invalidation ----

test("three consecutive failures invalidate the mode; two do not", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  const after = { ...t.hits };

  mode.noteFailure(P());
  mode.noteFailure(P());
  await mode.resolve(P(), t);
  assert.deepEqual(t.hits, after, "two failures must not trigger re-detection");

  mode.noteFailure(P());
  await mode.resolve(P(), t);
  assert.ok(t.hits.moonraker > after.moonraker, "third failure must trigger re-detection");
});

test("a success resets the failure counter", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  mode.noteFailure(P());
  mode.noteFailure(P());
  mode.noteSuccess(P());
  mode.noteFailure(P());
  const after = { ...t.hits };
  await mode.resolve(P(), t);
  assert.deepEqual(t.hits, after, "counter must have reset — one failure is not three");
});

test("an address change invalidates and re-detects", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  const after = { ...t.hits };
  await mode.resolve(P({ url: "http://10.0.0.9" }), t);
  assert.ok(t.hits.moonraker > after.moonraker, "new address must re-detect");
});

// ---- anti-flap ----

test("one success on the other transport re-detects but does not switch", async () => {
  const hits = { native: 0, moonraker: 0 };
  await mode.resolve(P(), thunks(false, true, hits));          // established moonraker
  for (let i = 0; i < 3; i++) mode.noteFailure(P());            // force re-detection
  // Now only native answers. One such detection must not flip the mode.
  assert.equal(await mode.resolve(P(), thunks(true, false, hits)), "moonraker");
});

test("two consecutive detections of the other transport do switch", async () => {
  const hits = { native: 0, moonraker: 0 };
  await mode.resolve(P(), thunks(false, true, hits));
  for (let i = 0; i < 3; i++) mode.noteFailure(P());
  await mode.resolve(P(), thunks(true, false, hits));           // 1st — no switch
  for (let i = 0; i < 3; i++) mode.noteFailure(P());
  assert.equal(await mode.resolve(P(), thunks(true, false, hits)), "native");
});

test("the native tie-break feeds hysteresis rather than bypassing it", async () => {
  const hits = { native: 0, moonraker: 0 };
  await mode.resolve(P(), thunks(false, true, hits));           // established moonraker
  for (let i = 0; i < 3; i++) mode.noteFailure(P());
  // Both answer now. Native wins the tie, but an established mode still needs
  // two consecutive detections before it changes.
  assert.equal(await mode.resolve(P(), thunks(true, true, hits)), "moonraker");
});

test("a completed switch is logged, so a repeatedly-flipping printer is visible", async () => {
  const hits = { native: 0, moonraker: 0 };
  const lines = [];
  const orig = console.log;
  console.log = m => lines.push(String(m));
  try {
    await mode.resolve(P(), thunks(false, true, hits));
    for (let i = 0; i < 3; i++) mode.noteFailure(P());
    await mode.resolve(P(), thunks(true, false, hits));         // no switch yet
    assert.deepEqual(lines, [], "a non-switching detection must not log");
    for (let i = 0; i < 3; i++) mode.noteFailure(P());
    await mode.resolve(P(), thunks(true, false, hits));         // switch
  } finally { console.log = orig; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /AD5X.*moonraker.*native/);
});

// ---- manual override (a pin, not a hint) ----

test("a pinned mode is returned without firing any probe", async () => {
  const t = thunks(true, true);
  assert.equal(await mode.resolve(P({ transport: "moonraker" }), t), "moonraker");
  assert.deepEqual(t.hits, { native: 0, moonraker: 0 }, "a pin must fire no liveness probes");
});

test("a pinned mode never falls back to the other transport, however many times it fails", async () => {
  const p = P({ transport: "moonraker" });
  const t = thunks(true, false);
  for (let i = 0; i < 5; i++) { mode.noteFailure(p); assert.equal(await mode.resolve(p, t), "moonraker"); }
  assert.deepEqual(t.hits, { native: 0, moonraker: 0 }, "a pin must never probe the other transport");
});

test("changing the pin discards the cached entry and profile", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  mode.setProfile(P(), { camera: true });
  assert.deepEqual(mode.getProfile(P({ transport: "native" })), undefined);
});

// ---- profile lifetime (deliberately NOT the same as mode lifetime) ----

test("the profile survives a failure-driven invalidation, keeping capabilities sticky", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  mode.setProfile(P(), { camera: true });
  for (let i = 0; i < 3; i++) mode.noteFailure(P());
  assert.deepEqual(mode.getProfile(P()), { camera: true }, "offline must not clear capabilities");
});

test("the profile is discarded when a different mode resolves", async () => {
  const hits = { native: 0, moonraker: 0 };
  await mode.resolve(P(), thunks(false, true, hits));
  mode.setProfile(P(), { camera: true });
  for (let i = 0; i < 3; i++) mode.noteFailure(P());
  await mode.resolve(P(), thunks(true, false, hits));
  for (let i = 0; i < 3; i++) mode.noteFailure(P());
  await mode.resolve(P(), thunks(true, false, hits));           // switch completes
  assert.equal(mode.getProfile(P()), undefined, "facts from the old transport must not carry over");
});

test("the profile is discarded immediately on an address change", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  mode.setProfile(P(), { camera: true });
  assert.equal(mode.getProfile(P({ url: "http://10.0.0.9" })), undefined);
});

test("the profile is stored verbatim and never inspected", async () => {
  const t = thunks(false, true);
  await mode.resolve(P(), t);
  const blob = { anything: Symbol("opaque"), nested: { deep: [1, 2] } };
  mode.setProfile(P(), blob);
  assert.equal(mode.getProfile(P()), blob, "must be the same reference, uninterpreted");
});

// ---- identity ----

test("entries are keyed by the stable printer id, not by array position or url", async () => {
  const t = thunks(false, true);
  await mode.resolve(P({ id: "prt_a" }), t);
  const after = { ...t.hits };
  // A different printer must not read prt_a's entry.
  await mode.resolve(P({ id: "prt_b" }), t);
  assert.ok(t.hits.moonraker > after.moonraker, "a different printer must detect independently");
});

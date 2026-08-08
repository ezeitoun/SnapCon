const test = require("node:test");
const assert = require("node:assert/strict");
const sim = require("../../connectors/dummy-simulator");
const { computeSimState, entryFor, STATE } = sim._internal;

function fakePrinter(id) { return { id, name: id, simDurationSec: 60 }; }

test.beforeEach(() => STATE.clear());

// ---- computeSimState: pure math, synthetic timestamps only ----

test("computeSimState: progress rises linearly toward 1 while printing", () => {
  const entry = { phase: "printing", effectiveStartedAt: 0, durationMs: 10000, progressAtPause: 0 };
  assert.equal(computeSimState(entry, 0).progress, 0);
  assert.equal(computeSimState(entry, 5000).progress, 0.5);
  assert.equal(computeSimState(entry, 5000).phase, "printing");
});

test("computeSimState: progress never exceeds 1.0, and crossing it flips phase to complete", () => {
  const entry = { phase: "printing", effectiveStartedAt: 0, durationMs: 10000, progressAtPause: 0 };
  const farPast = computeSimState(entry, 999999999);
  assert.equal(farPast.progress, 1);
  assert.equal(farPast.phase, "complete");
});

test("computeSimState: paused/cancelled/error report the frozen progressAtPause, not a live calculation", () => {
  const base = { effectiveStartedAt: 0, durationMs: 10000, progressAtPause: 0.42 };
  assert.equal(computeSimState({ ...base, phase: "paused" }, 999999).progress, 0.42);
  assert.equal(computeSimState({ ...base, phase: "cancelled" }, 999999).progress, 0.42);
  assert.equal(computeSimState({ ...base, phase: "error" }, 999999).progress, 0.42);
});

// ---- pause/resume: freeze + continue from the exact frozen fraction ----

test("pause freezes progress at the exact fraction it was at", async () => {
  const p = fakePrinter("d1");
  STATE.set(p.id, { phase: "printing", filename: "a.gcode", progressAtPause: 0, effectiveStartedAt: Date.now() - 30000, durationMs: 60000 });
  await sim.pause(p);
  const entry = entryFor(p.id);
  assert.equal(entry.phase, "paused");
  assert.ok(Math.abs(entry.progressAtPause - 0.5) < 0.01, "expected ~0.5, got " + entry.progressAtPause);
});

test("resume continues from the frozen fraction rather than resetting or jumping", async () => {
  const p = fakePrinter("d2");
  STATE.set(p.id, { phase: "paused", filename: "a.gcode", progressAtPause: 0.5, effectiveStartedAt: 0, durationMs: 60000 });
  await sim.resume(p);
  const entry = entryFor(p.id);
  assert.equal(entry.phase, "printing");
  // Immediately after resume, live progress must read back ~0.5, not 0.
  const { progress } = computeSimState(entry, Date.now());
  assert.ok(Math.abs(progress - 0.5) < 0.02, "expected resumed progress ~0.5, got " + progress);
});

// ---- completion visibility ----

test("completion is reached and stays 'complete' until the next job starts", async () => {
  const p = fakePrinter("d3");
  STATE.set(p.id, { phase: "printing", filename: "a.gcode", progressAtPause: 0, effectiveStartedAt: Date.now() - 999999, durationMs: 1000 });
  const first = await sim.probe(p);
  assert.equal(first.state, "complete");
  assert.equal(first.progress, 1);
  // Probing again later must still report complete — no self-timer reverts it.
  const second = await sim.probe(p);
  assert.equal(second.state, "complete");
});

// ---- cancel / e-stop ----

test("cancel produces a cancelled state", async () => {
  const p = fakePrinter("d4");
  STATE.set(p.id, { phase: "printing", filename: "a.gcode", progressAtPause: 0, effectiveStartedAt: Date.now() - 10000, durationMs: 60000 });
  await sim.cancel(p);
  const st = await sim.probe(p);
  assert.equal(st.state, "cancelled");
});

test("e-stop produces an error state", async () => {
  const p = fakePrinter("d5");
  STATE.set(p.id, { phase: "printing", filename: "a.gcode", progressAtPause: 0, effectiveStartedAt: Date.now() - 10000, durationMs: 60000 });
  await sim.estop(p);
  const st = await sim.probe(p);
  assert.equal(st.state, "error");
  assert.equal(st.errorCode, "SIM_ESTOP");
});

// ---- second job resets the lifecycle ----

test("starting a second job after completion fully resets progress and filename", async () => {
  const p = fakePrinter("d6");
  STATE.set(p.id, { phase: "complete", filename: "old.gcode", progressAtPause: 1, effectiveStartedAt: 0, durationMs: 1000 });
  await sim.startPrintFile(p, "new.gcode");
  const entry = entryFor(p.id);
  assert.equal(entry.phase, "printing");
  assert.equal(entry.filename, "new.gcode");
  assert.equal(entry.progressAtPause, 0);
  const { progress } = computeSimState(entry, Date.now());
  assert.ok(progress < 0.05, "expected freshly-started progress near 0, got " + progress);
});

test("starting a second job after cancel/error also fully resets the lifecycle", async () => {
  const p = fakePrinter("d7");
  STATE.set(p.id, { phase: "error", filename: "old.gcode", progressAtPause: 0.3, effectiveStartedAt: 0, durationMs: 1000 });
  await sim.startPrintFile(p, "new.gcode");
  const st = await sim.probe(p);
  assert.equal(st.state, "printing");
  assert.equal(st.filename, "new.gcode");
});

// ---- ephemeral by design ----

test("a printer with no prior state probes as idle (module-level Map is in-memory only)", async () => {
  const p = fakePrinter("never-seen-before");
  const st = await sim.probe(p);
  assert.equal(st.state, "standby");
  assert.equal(st.progress, 0);
});

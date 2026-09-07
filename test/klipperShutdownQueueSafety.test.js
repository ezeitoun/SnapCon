// test/klipperShutdownQueueSafety.test.js — end-to-end: what a Klipper
// shutdown does to Queue Management (docs/TODO.md item 9b).
//
// This test spans the connector and the queue on purpose. QueueEngine itself
// was never wrong -- it handles state:"error" correctly and needed no change.
// The damage was done upstream, by the connector handing it a frozen
// print_stats, so a test written against QueueEngine alone would have proved
// nothing. These feed the REAL connector's output into the REAL reducer.
//
// Two distinct failures, both confirmed by reading the reducer
// (queue/QueueEngine.js:315-337):
//
//  FALSE POSITIVE (queueState "dispatching"). SnapCon calls startPrintFile and
//  Klipper dies during START_PRINT. print_stats freezes reading "printing"
//  with the dispatched filename, so the reducer matched BOTH the state and the
//  filename and recorded queueState:"printing" -- a dispatch confirmed
//  successful for a print that never ran.
//
//  FALSE NEGATIVE (queueState "printing"). Klipper dies mid-print. print_stats
//  stays "printing" forever, so the reducer concluded "still owns it, nothing
//  to reconcile" and the queue waited on a job that could never finish or fail.
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../queue/QueueEngine");
const creality = require("../connectors/creality-klipper");

const P = { name: "SPARKX i7", url: "http://192.168.4.240:7125" };
const FILE = "i1.gcode";

// Exactly what a shutdown-mid-print looks like on the wire: Klipper freezes
// the job fields rather than clearing them.
const SHUTDOWN_PAYLOAD = {
  webhooks: { state: "shutdown", state_message: "Internal error on command:G1" },
  print_stats: { state: "printing", filename: FILE, print_duration: 812, message: "" },
  display_status: { progress: 0.11 },
  virtual_sdcard: { is_active: true, progress: 0.11 },
  heater_bed: { temperature: 60, target: 60 },
  extruder: { temperature: 210, target: 210 },
  toolhead: { extruder: "extruder" }
};

async function probeShutdown() {
  const real = global.fetch;
  global.fetch = async (url) => String(url).includes("/printer/objects/query")
    ? { ok: true, status: 200, json: async () => ({ result: { status: SHUTDOWN_PAYLOAD } }) }
    : { ok: false, status: 404, json: async () => ({}) };
  try { return await creality.probe(P); } finally { global.fetch = real; }
}

function baseState(overrides) {
  return {
    queueState: "idle", queuePaused: false, queueStopped: false, reconciliationPending: false,
    attentionReason: null, attentionDetail: null,
    queue: [], currentItem: null, recentHistory: [], updatedAt: 0,
    ...overrides
  };
}
const item = () => ({
  id: "i1", status: "dispatching", alreadyUploaded: false,
  file: { name: FILE, sub: "", sizeBytes: 100, sha256: "h" },
  map: {}, prefs: {}, createdAt: 0, dispatchedAt: null, finishedAt: null,
  queuedBy: { userId: "u1", userLabel: "alice" }, retryOfItemId: null, dispatchSnapshot: null
});

test("the probe a shutdown produces no longer claims the printer is printing", async () => {
  const st = await probeShutdown();
  assert.equal(st.state, "error");
  assert.equal(st.filename, FILE, "the filename is still there — this is what used to make the match convincing");
});

test("false positive: a dispatch is no longer confirmed successful on a crashed printer", async () => {
  const st = await probeShutdown();
  const next = E.reconcileOnStartup(
    baseState({ queueState: "dispatching", currentItem: item() }),
    { online: st.online, state: st.state, filename: st.filename }
  );
  assert.notEqual(next.queueState, "printing",
    "state AND filename both matched before, so this recorded a successful dispatch for a print that never ran");
  assert.equal(next.attentionReason, "recovery-interrupted",
    "the honest outcome: the dispatch was interrupted and the result is unknown");
});

test("false negative: the queue no longer waits forever on a dead print", async () => {
  const st = await probeShutdown();
  const next = E.reconcileOnStartup(
    baseState({ queueState: "printing", currentItem: { ...item(), status: "printing" } }),
    { online: st.online, state: st.state, filename: st.filename }
  );
  assert.equal(next.attentionReason, "recovery-unknown-outcome",
    "previously this said 'still owns it, nothing to reconcile' and the queue stalled indefinitely");
});

test("a healthy printer mid-print still reconciles as owning its job", async () => {
  const healthy = { ...SHUTDOWN_PAYLOAD, webhooks: { state: "ready", state_message: "Printer is ready" } };
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { status: healthy } }) });
  let st; try { st = await creality.probe(P); } finally { global.fetch = real; }
  const next = E.reconcileOnStartup(
    baseState({ queueState: "printing", currentItem: { ...item(), status: "printing" } }),
    { online: st.online, state: st.state, filename: st.filename }
  );
  assert.equal(next.attentionReason, null, "no false alarms on a working fleet");
});

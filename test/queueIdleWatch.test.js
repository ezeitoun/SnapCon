// test/queueIdleWatch.test.js — a queue print the printer goes idle on, or
// never starts, asks a person instead of staying "printing" forever
// (docs/TODO.md §34).
//
// Before: notifyTick moved a "printing" queue on only when the printer
// reported complete, error or cancelled. A printer back on standby without one
// of those left the queue "printing" with no attention, until a restart.
//
// queueIdleWatchStep and watchQueuePrinting are taken from server.js and run
// against the real QueueStore/QueueEngine, with a clock the test moves.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { createQueueStore } = require("../queue/QueueStore");
const QueueEngine = require("../queue/QueueEngine");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const SEC = 1000, MIN = 60 * SEC;

function loadFn(env, marker) {
  const at = serverSrc.indexOf(marker);
  assert.ok(at > 0, marker);
  const end = serverSrc.slice(at).search(/\r?\n\}\r?\n/);
  vm.runInContext(serverSrc.slice(at, at + end + 3), env);
}

function harness(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-idle-watch-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const queueStore = createQueueStore({ baseDir: base, fileIO: { stat: async () => ({ size: 1, mtimeMs: 1 }), hashFile: async () => ({ sizeBytes: 1, sha256: "h" }) } });
  const printer = { id: "pr1", name: "U1", url: "http://u1", printerPoolId: "pool" };
  const h = { now: 1_000_000, audits: [] };
  class FakeDate extends Date { static now() { return h.now; } }
  const env = { Math, Date: FakeDate, QueueEngine, queueStore, Map, Set, auditLog: { log: e => { h.audits.push(e); return 1; } } };
  vm.createContext(env);
  const at = serverSrc.indexOf("const QUEUE_IDLE_CHECKS");
  assert.ok(at > 0);
  vm.runInContext(serverSrc.slice(at, serverSrc.indexOf("\n\n", serverSrc.indexOf("const QUEUE_IDLE_WATCH", at))).replace(/^const /gm, "var "), env);
  loadFn(env, "function queueIdleWatchStep(");
  loadFn(env, "function queueIdleWatchOffline(");
  loadFn(env, "function watchQueuePrinting(");
  queueStore.assignPool("pr1");
  const item = (id, extra) => ({ id, status: "queued", alreadyUploaded: false, file: { name: id + ".gcode", sub: "", sizeBytes: 1, sha256: "h" }, map: {}, prefs: {},
    createdAt: 1, dispatchedAt: null, finishedAt: null, queuedBy: null, retryOfItemId: null, dispatchSnapshot: null, ...extra });
  // The queue as attemptQueueDispatch leaves it: i1 printing, i2 waiting.
  queueStore.applyIntent("pr1", s => ({ ...s, queueState: "printing", currentItem: item("i1", { status: "printing", dispatchedAt: h.now }), queue: [item("i2")] }));
  h.state = () => queueStore.getPrinterState("pr1");
  // One notifyTick reading of the printer, `after` ms after the last.
  h.read = (state, after = 30 * SEC) => { h.now += after; env.watchQueuePrinting(printer, { online: true, state }); };
  h.offline = (after = 30 * SEC) => { h.now += after; env.queueIdleWatchOffline(printer); };
  h.env = env;
  return h;
}

test("printing, then idle for three readings over 60 s: the queue asks a person; the item stays, nothing advances", t => {
  const h = harness(t);
  h.read("printing");
  h.read("standby"); h.read("standby");
  assert.equal(h.state().queueState, "printing", "two idle readings are not enough");
  h.read("standby");
  const s = h.state();
  assert.equal(s.queueState, "queue_attention_required");
  assert.equal(s.attentionReason, "recovery-unknown-outcome");
  assert.equal(s.attentionDetail.code, "printer-idle");
  assert.match(s.attentionDetail.message, /went idle without reporting that "i1\.gcode" finished/);
  assert.equal(s.attentionDetail.resumable, false);
  assert.equal(s.currentItem.id, "i1");
  assert.equal(s.currentItem.status, "printing", "not completed, failed or skipped by standby alone");
  assert.deepEqual(s.recentHistory, []);
  assert.deepEqual(s.queue.map(i => i.id), ["i2"], "the next item is not started");
  assert.deepEqual(h.audits.map(a => [a.event, a.detail.reason]), [["queue-outcome-unknown", "printer-idle"]]);
  h.read("standby"); h.read("standby"); h.read("standby");
  assert.equal(h.audits.length, 1, "reported once; later readings leave the attention alone");
});

test("a transient idle reading does not count: printing again starts the count over", t => {
  const h = harness(t);
  h.read("printing");
  h.read("standby"); h.read("standby");
  h.read("printing");
  h.read("standby"); h.read("standby");
  assert.equal(h.state().queueState, "printing");
  for (const reset of ["paused", "busy"]) {
    h.read(reset);
    h.read("idle"); h.read("idle");
    assert.equal(h.state().queueState, "printing", reset + " starts the count over");
  }
  assert.equal(h.audits.length, 0);
});

test("readings that come close together cannot confirm it early: the idle stretch must also span 60 s", t => {
  const h = harness(t);
  h.read("printing");
  h.read("standby", 5 * SEC); h.read("standby", 5 * SEC); h.read("standby", 5 * SEC); h.read("standby", 5 * SEC);
  assert.equal(h.state().queueState, "printing", "four readings in 15 s");
  h.read("standby", 45 * SEC);
  assert.equal(h.state().queueState, "queue_attention_required", "once 60 s have passed since the first idle reading");
});

test("the printer going offline starts the count over, and remembers it was seen printing", t => {
  const h = harness(t);
  h.read("printing");
  h.read("standby"); h.read("standby");
  h.offline();
  h.read("standby"); h.read("standby");
  assert.equal(h.state().queueState, "printing");
  h.read("standby");
  assert.equal(h.state().queueState, "queue_attention_required");
});

test("never seen printing: idle is not reported before 10 minutes from the dispatch, then it is", t => {
  const h = harness(t);
  // Still showing the previous job's "complete", as a printer can during its own start.
  for (let i = 0; i < 19; i++) h.read("complete");
  assert.equal(h.state().queueState, "printing", "9.5 minutes after the dispatch");
  h.read("complete");
  const s = h.state();
  assert.equal(s.queueState, "queue_attention_required");
  assert.equal(s.attentionDetail.code, "start-not-seen");
  assert.match(s.attentionDetail.message, /not been seen printing "i1\.gcode" in the 10 minutes since it was sent/);
  assert.deepEqual(s.queue.map(i => i.id), ["i2"]);
});

test("a print that starts late inside the grace is watched as a printing one from then on", t => {
  const h = harness(t);
  h.read("standby"); h.read("standby"); h.read("standby"); h.read("standby");
  h.read("printing");
  h.read("standby"); h.read("standby"); h.read("standby");
  assert.equal(h.state().attentionDetail.code, "printer-idle", "after printing was seen, 3 readings are enough");
});

test("a queue that is not printing is left alone, and a new item starts a fresh watch", t => {
  const h = harness(t);
  h.read("printing");
  h.read("standby"); h.read("standby");
  // The edge handling (complete) moved it on in the same tick: nothing more here.
  h.env.queueStore.applyObserved("pr1", QueueEngine.onProbeComplete);
  h.read("standby"); h.read("standby"); h.read("standby");
  assert.equal(h.state().queueState, "awaiting_bed_clear");
  assert.equal(h.audits.length, 0);
  assert.equal(h.env.QUEUE_IDLE_WATCH.size, 0);
});

test("the step on its own: counts, the 60 s span, the grace, and a different item", t => {
  const h = harness(t);
  const step = h.env.queueIdleWatchStep;
  let w; let r;
  r = step(undefined, { itemId: "a", dispatchedAt: 0, state: "printing", now: 0 }); w = r.watch;
  assert.equal(w.seenPrinting, true);
  r = step(w, { itemId: "a", dispatchedAt: 0, state: "standby", now: 1 * MIN }); w = r.watch;
  r = step(w, { itemId: "a", dispatchedAt: 0, state: "standby", now: 1.5 * MIN }); w = r.watch;
  r = step(w, { itemId: "a", dispatchedAt: 0, state: "standby", now: 2 * MIN });
  assert.equal(r.verdict, "printer-idle");
  r = step(w, { itemId: "b", dispatchedAt: 0, state: "standby", now: 2 * MIN });
  assert.equal(r.watch.checks, 1, "another item starts over");
  assert.equal(r.watch.seenPrinting, false);
  r = step({ itemId: "c", seenPrinting: false, checks: 2, firstIdleAt: 0 }, { itemId: "c", dispatchedAt: null, state: "idle", now: 10 * MIN });
  assert.equal(r.verdict, "start-not-seen", "no dispatch time: the grace counts from the first idle reading");
});

test("notifyTick wires it: offline resets the count, and each online reading is watched after the complete/error/cancelled handling", () => {
  const tick = serverSrc.slice(serverSrc.indexOf("async function notifyTick("), serverSrc.indexOf("setInterval(notifyTick"));
  assert.match(tick, /if \(!st\.online\) \{ queueIdleWatchOffline\(p\); return; \}/);
  const edge = tick.indexOf("QueueEngine.onProbeFailedOrCancelled");
  const watch = tick.indexOf("watchQueuePrinting(p, st);");
  assert.ok(edge > 0 && watch > edge, "watched after the edge handling");
});

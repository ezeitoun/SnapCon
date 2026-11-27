// test/utilization/historySync.test.js — when and how history is read: paging,
// bounds, backoff, printers left alone while printing, the cursor across
// restarts. Reading is off unless configured: these tests turn it on
// (setting: () => true); test/utilization/historyOff.test.js covers off. The history itself is a stand-in function; the store and writer are real.
const test = require("node:test");
const assert = require("node:assert/strict");
const { rig, T0, S, MIN, H, on, OFF } = require("./helpers");
const { createHistorySync } = require("../../utilization/HistorySync");

const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 1)); } };
// A printer's history: `jobs` oldest first, times in SnapCon ms.
function printerHistory(jobs, { paging = true, since = true, fail = null, unavailable = false } = {}) {
  const calls = [];
  const fn = async o => {
    calls.push(o);
    if (unavailable) return { unavailable: true, jobs: [] };
    if (fail) throw new Error(fail);
    let list = jobs.map(j => ({ job_id: j.id, filename: j.file || "a.gcode", status: j.status || (j.end == null ? "in_progress" : "completed"), start_time: j.start / 1000, end_time: j.end == null ? null : j.end / 1000, print_duration: j.end == null ? 0 : (j.end - j.start) / 1000 }));
    if (since && Number.isFinite(o.since)) list = list.filter(j => j.start_time >= o.since);
    if (!paging) return { jobs: list.slice(-o.limit).reverse() };          // like the Virtual U1: newest `limit`, whatever was asked
    return { jobs: list.slice(o.start, o.start + o.limit) };
  };
  fn.calls = calls;
  return fn;
}
function setup(t, jobsFn, opts = {}) {
  const r = rig(t);
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t);
  r.tracker.observe(p, on("standby"), r.clock.t);
  r.flush();
  const logs = [];
  const hs = createHistorySync({ setting: () => true, store: r.store, writer: r.writer, historyFor: () => jobsFn, kindOf: id => r.tracker.kindOf(id), now: () => r.clock.t,
    log: { log: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) }, startDelayMs: 0, minGapMs: 0, pageGapMs: 0, ...opts });
  const run = async () => { hs.tick([p], r.clock.t); await until(() => !hs.status().inflight); r.flush(); };
  return { r, p, hs, run, logs };
}
const old = n => Array.from({ length: n }, (_, i) => ({ id: "J" + i, start: T0 - 30 * 86400e3 + i * H, end: T0 - 30 * 86400e3 + i * H + 20 * MIN }));

test("pages are read in order until a short one, and every record is applied once", async t => {
  const h = printerHistory(old(120));
  const { r, run, hs } = setup(t, h);
  await run();
  assert.deepEqual(h.calls.map(c => [c.start, c.limit, c.order]), [[0, 50, "asc"], [50, 50, "asc"], [100, 50, "asc"]]);
  assert.equal(r.store.jobs("u").length, 120);
  assert.equal(hs.status().records, 120);
});

test("bounded: at most maxPages a pass; the rest on a later pass, from the cursor, never all at once", async t => {
  const h = printerHistory(old(300));
  const { r, run } = setup(t, h, { maxPages: 2, soonMs: MIN });
  await run();
  assert.equal(h.calls.length, 2);
  assert.equal(r.store.jobs("u").length, 100);
  const cursor = r.store.historyState("u").cursor;
  assert.equal(cursor, old(300)[99].start / 1000);
  r.clock.t += 30 * S; await run();
  assert.equal(h.calls.length, 2, "not before soonMs");
  r.clock.t += MIN; await run();
  assert.equal(h.calls[2].since, cursor - 3600, "from the cursor, less the overlap");
  // The hour of overlap re-reads two applied records (no-ops), so 98 are new.
  assert.equal(r.store.jobs("u").length, 198);
  assert.equal(r.store.historyState("u").counters.already, 2);
});

test("a printer that ignores paging and filtering (like the Virtual U1): two requests, filtered here, nothing doubled", async t => {
  const jobs = old(80);
  const h = printerHistory(jobs, { paging: false, since: false });
  const { r, run, hs } = setup(t, h);
  await run();
  assert.equal(h.calls.length, 2, "the second page brought nothing new");
  assert.equal(r.store.jobs("u").length, 50);
  assert.ok(hs.status().duplicates >= 50);
});

test("the first pass looks back 90 days, no further", async t => {
  const h = printerHistory([{ id: "ancient", start: T0 - 200 * 86400e3, end: T0 - 200 * 86400e3 + H }, { id: "recent", start: T0 - 10 * 86400e3, end: T0 - 10 * 86400e3 + H }], { since: false });
  const { r, run } = setup(t, h);
  await run();
  assert.deepEqual(r.store.jobs("u").map(j => j.historyId.split("@")[0]), ["recent"]);
  assert.ok(Math.abs(h.calls[0].since - (T0 - 90 * 86400e3) / 1000) < 1);
});

test("no history on the printer: one request, then left alone for 6 hours", async t => {
  const h = printerHistory([], { unavailable: true });
  const { r, run, logs, hs } = setup(t, h);
  await run();
  for (let i = 0; i < 10; i++) { r.clock.t += 30 * MIN; await run(); }
  assert.equal(h.calls.length, 1);
  hs.markDue("u", 0);                    // a job of its ended: still not before the 6 hours
  await run();
  assert.equal(h.calls.length, 1);
  r.clock.t += 2 * H; await run();
  assert.equal(h.calls.length, 2);
  assert.equal(logs.filter(m => /no job history/.test(m)).length, 2);
});

test("errors back off (1, 5, 30 min, 2 h), and are logged once per streak", async t => {
  const h = printerHistory([], { fail: "Moonraker 500" });
  const { r, run, logs, hs } = setup(t, h);
  const at = [];
  for (let i = 0; i < 400; i++) { const n = h.calls.length; await run(); if (h.calls.length > n) at.push(r.clock.t); r.clock.t += 30 * S; }
  const gaps = at.slice(1).map((x, i) => x - at[i]);
  assert.deepEqual(gaps.slice(0, 4), [MIN, 5 * MIN, 30 * MIN, 2 * H]);
  assert.equal(logs.filter(m => /not read/.test(m)).length, 1);
  assert.equal(hs.status().printers.u.lastError, "Moonraker 500");
});

test("a printer printing, paused or not answering is left alone; one request at a time across the fleet", async t => {
  const h = printerHistory(old(3));
  const { r, p, hs } = setup(t, h);
  for (const reading of [on("printing", "a.gcode"), on("paused", "a.gcode"), OFF, OFF]) {
    r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, reading, r.clock.t); r.flush();
    hs.tick([p], r.clock.t);
    assert.equal(h.calls.length, 0, JSON.stringify(reading));
  }
  r.clock.t += 30 * S; r.tracker.observe(p, on("standby"), r.clock.t); r.flush();
  let release, started = 0;
  const slow = async o => { started++; await new Promise(res => { release = res; }); return h(o); };
  const q = r.P("q");
  r.tracker.beginTick([p, q], [p, q], r.clock.t); r.tracker.observe(q, on("standby"), r.clock.t); r.flush();
  const hs2 = createHistorySync({ setting: () => true, store: r.store, writer: r.writer, historyFor: () => slow, kindOf: id => r.tracker.kindOf(id), now: () => r.clock.t, log: { log() {}, warn() {}, error() {} }, startDelayMs: 0, minGapMs: 0 });
  hs2.tick([p, q], r.clock.t);
  hs2.tick([p, q], r.clock.t);
  assert.equal(started, 1, "the second tick did not start another request");
  assert.equal(hs2.status().inflight, true);
  release();
  await until(() => !hs2.status().inflight);
  assert.equal(h.calls.length, 1, "only one printer's request while the first was out");
  void hs;
});

test("a job still running holds the cursor before it, so it is read again when it ends", async t => {
  const jobs = [{ id: "a", start: T0 - 5 * H, end: T0 - 4 * H }, { id: "b", start: T0 - 3 * H, end: null }, { id: "c", start: T0 - 2 * H, end: T0 - H }];
  const h = printerHistory(jobs);
  const { r, run } = setup(t, h);
  await run();
  assert.equal(r.store.historyState("u").cursor, (T0 - 3 * H) / 1000 - 1);
  assert.equal(r.store.jobs("u").length, 2);
  jobs[1].end = T0 - 2.5 * H;
  r.clock.t += 11 * MIN; await run();
  assert.equal(r.store.jobs("u").length, 3);
});

test("the cursor and what was learnt survive a SnapCon restart", async t => {
  const h = printerHistory(old(10));
  const s = setup(t, h);
  await s.run();
  const cursor = s.r.store.historyState("u").cursor;
  s.r.clock.t += H;
  const r2 = s.r.restart();
  const p = r2.P("u");
  r2.tracker.beginTick([p], [p], r2.clock.t); r2.tracker.observe(p, on("standby"), r2.clock.t); r2.flush();
  const hs = createHistorySync({ setting: () => true, store: r2.store, writer: r2.writer, historyFor: () => h, kindOf: id => r2.tracker.kindOf(id), now: () => r2.clock.t, log: { log() {}, warn() {}, error() {} }, startDelayMs: 0, minGapMs: 0 });
  hs.tick([p], r2.clock.t); await until(() => !hs.status().inflight); r2.flush();
  assert.equal(h.calls.at(-1).since, cursor - 3600);
  assert.equal(r2.store.jobs("u").length, 10, "re-read records were already applied");
  assert.equal(r2.store.historyState("u").counters.already, 2, "the hour of overlap re-read two, as no-ops");
});

test("malformed records are skipped and counted; ops stay small and each is a batch of its own", async t => {
  const jobs = old(12).concat([{ id: "", start: T0 - H, end: T0 - H / 2 }, { id: "bad", start: T0 - H, end: T0 - 2 * H }]);
  const h = printerHistory(jobs);
  const { r, p, hs } = setup(t, h);
  hs.tick([p], r.clock.t); await until(() => !hs.status().inflight);
  const queued = [];
  const was = r.store.applyBatch;
  r.store.applyBatch = (id, ops) => { queued.push(ops); return was(id, ops); };
  r.flush();
  const historyBatches = queued.filter(ops => ops.some(o => o.type === "history"));
  assert.ok(historyBatches.every(ops => ops.length === 1 && ops[0].records.length <= 5));
  assert.equal(historyBatches.length, 3);
  assert.deepEqual(hs.status().skipped, { "no-id": 1, empty: 1 });
});

test("a job ending makes its printer due soon, for the outcome", async t => {
  const h = printerHistory(old(1));
  const { r, run, hs } = setup(t, h);
  await run();
  r.clock.t += MIN; await run();
  assert.equal(h.calls.length, 1, "not due for 10 minutes");
  hs.markDue("u", 0);
  await run();
  assert.equal(h.calls.length, 2);
});

test("wired: a job ending on the printer makes its history due within a minute", async t => {
  const { createUtilization } = require("../../utilization");
  const { tmpBase } = require("./helpers");
  let clock = T0;
  const h = printerHistory([]);
  const u = createUtilization({ baseDir: tmpBase(t), log: { log() {}, warn() {}, error() {} }, now: () => clock, historySetting: () => true, historyFor: () => h,
    historyOptions: { startDelayMs: 10 * H, minGapMs: 0 }, checkpointerOptions: { periodMs: 1e9 } });
  t.after(() => u.stop());
  u.start();
  const p = { id: "w", name: "W", connector: "x" };
  const step = reading => { clock += 30 * S; u.beginTick([p], [p]); u.observe(p, reading); u.endTick(); };
  step(on("printing", "a.gcode"));
  const before = u.status().history.printers.w.nextAt;
  assert.ok(before > clock + H, "not due for hours");
  step(on("complete", "a.gcode"));
  assert.ok(u.status().history.printers.w.nextAt <= clock + MIN, "due within a minute of the job ending");
});

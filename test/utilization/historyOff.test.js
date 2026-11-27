// test/utilization/historyOff.test.js — printer history reading is off unless
// config.json utilization.readPrinterHistory turns it on (owner, pre-deployment
// safeguards). Off: not one history request, scheduled or after a job ends,
// whatever the time, the polls or the restarts; recording, reports and the API
// go on as before and say that history is not read. A list of printer ids reads
// only those (the pilot); turning it off stops a pass in progress.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { rig, tmpBase, T0, S, MIN, H, on } = require("./helpers");
const { createHistorySync, historyMode } = require("../../utilization/HistorySync");
const { createUtilization } = require("../../utilization");

const quiet = { log() {}, warn() {}, error() {} };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 1)); } };
// A printer's history that counts every request, and every time it was handed out.
function counted(pages = [[]]) {
  const reader = async o => { reader.calls.push(o); return { jobs: pages[Math.min(reader.calls.length - 1, pages.length - 1)] } ; };
  reader.calls = [];
  const historyFor = p => { historyFor.asked.push(p.id); return reader; };
  historyFor.asked = [];
  return { reader, historyFor };
}

test("the setting: true reads all, a list of ids is a pilot, anything else (absent included) is off", () => {
  assert.equal(historyMode(true).mode, "on");
  const pilot = historyMode(["u1-bay2", " ", "", 7, " u1-bay3 "]);
  assert.equal(pilot.mode, "pilot");
  assert.deepEqual([...pilot.ids].sort(), ["u1-bay2", "u1-bay3"]);
  for (const v of [undefined, null, false]) assert.deepEqual(historyMode(v), { mode: "off", ids: null, invalid: false }, String(v));
  for (const v of ["true", "yes", 1, {}, [], [""], [3]]) {
    const m = historyMode(v);
    assert.equal(m.mode, "off", JSON.stringify(v));
    assert.equal(m.invalid, true, "a value that is not understood is off, and said so");
  }
});

for (const [name, setting] of [["the key absent", undefined], ["false", false], ["a value not understood (\"true\")", "true"], ["an empty list", []]]) {
  test(`off (${name}): no history request over three days of polls, job endings and a restart`, async t => {
    const r = rig(t);
    const p = r.P("u");
    const { reader, historyFor } = counted([[{ job_id: "J1", filename: "a.gcode", status: "completed", start_time: T0 / 1000 - 3600, end_time: T0 / 1000 - 60, print_duration: 3000 }]]);
    const logs = [];
    const opts = { store: r.store, writer: r.writer, historyFor, kindOf: id => r.tracker.kindOf(id), now: () => r.clock.t,
      log: { log: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) }, startDelayMs: 0, minGapMs: 0, pageGapMs: 0 };
    const hs = createHistorySync(setting === undefined ? opts : { ...opts, setting: () => setting });
    for (let i = 0; i < 3 * 24 * 120; i++) {                 // every 30 s for three days
      r.clock.t += 30 * S;
      const reading = i % 240 < 120 ? on("printing", "a.gcode") : on("complete", "a.gcode");
      r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, reading, r.clock.t);
      hs.tick([p], r.clock.t);
      if (i % 240 === 120) hs.markDue("u", 0);                // a job ended: due now
      if (i % 2000 === 0) r.flush();
    }
    await new Promise(r2 => setImmediate(r2));
    assert.equal(reader.calls.length, 0, "no request");
    assert.deepEqual(historyFor.asked, [], "the connector's reader is not even asked for");
    assert.equal(hs.status().reading, "off");
    assert.equal(hs.status().requests, 0);
    assert.equal(logs.filter(l => /printer job history is not read/.test(l)).length, 1, "said once, not on every poll");
    // A restart: the same, from the first poll.
    const hs2 = createHistorySync(setting === undefined ? opts : { ...opts, setting: () => setting });
    for (let i = 0; i < 100; i++) { r.clock.t += 30 * S; hs2.tick([p], r.clock.t); hs2.markDue("u", 0); }
    assert.equal(reader.calls.length, 0);
  });
}

test("wired, the setting absent (as in a config.json without it): recording, reports and the API go on; zero history requests", async t => {
  let clock = T0;
  const { reader, historyFor } = counted();
  const u = createUtilization({ baseDir: tmpBase(t), log: quiet, now: () => clock, historyFor,
    historyOptions: { startDelayMs: 0, minGapMs: 0, pageGapMs: 0 }, checkpointerOptions: { periodMs: 1e9 } });
  t.after(() => u.stop());
  u.start();
  const p = { id: "w", name: "W", connector: "snapmaker-u1-klipper-ws" };
  const step = reading => { clock += 30 * S; u.beginTick([p], [p]); u.observe(p, reading); u.endTick(); };
  // Polls as the server makes them: the writer's turns run between them.
  for (let i = 0; i < 600; i++) { step(i % 200 < 120 ? on("printing", "a.gcode") : on("complete", "a.gcode")); await new Promise(r => setImmediate(r)); }
  await until(() => u.status().writer.pending === 0);
  assert.equal(reader.calls.length, 0, "no history request");
  assert.deepEqual(historyFor.asked, []);
  assert.equal(u.status().recording, true, "recording goes on");
  assert.equal(u.status().history.reading, "off", "and the diagnostics say history is not read");
  const day = new Date(clock).toISOString().slice(0, 10);
  const q = { printers: [{ id: "w", name: "W", firstSeen: T0, removedAt: null, isVirtual: false, firstJobAt: null }], range: 7, endDay: day, tz: "UTC", basis: { kind: "24h" }, basisKey: "24h" };
  const sum = await u.reporting.summary(q);
  assert.ok(sum.current.hours.printing.total + sum.current.hours.provisionalRunning.total + sum.current.hours.provisionalUnknown.total > 0, "the printing SnapCon saw is recorded");
  assert.deepEqual(sum.printerHistory, { reading: "off", printersRead: 0 }, "every report says history is not read");
  const per = await u.reporting.perPrinter(q);
  assert.equal(per.printers[0].historyRead, false);
});

test("pilot: only the listed printer is read; the reports count it without naming any other", async t => {
  let clock = T0;
  const a = counted(), b = counted();
  const u = createUtilization({ baseDir: tmpBase(t), log: quiet, now: () => clock, historySetting: () => ["pa"],
    historyFor: p => (p.id === "pa" ? a.historyFor(p) : b.historyFor(p)),
    historyOptions: { startDelayMs: 0, minGapMs: 0, pageGapMs: 0 }, checkpointerOptions: { periodMs: 1e9 } });
  t.after(() => u.stop());
  u.start();
  const ps = [{ id: "pa", name: "A", connector: "x" }, { id: "pb", name: "B", connector: "x" }];
  for (let i = 0; i < 40; i++) { clock += 30 * S; u.beginTick(ps, ps); for (const p of ps) u.observe(p, on("standby")); u.endTick(); await new Promise(r => setImmediate(r)); }
  assert.ok(a.reader.calls.length >= 1, "the pilot printer is read");
  assert.equal(b.reader.calls.length, 0, "the other is never read");
  assert.deepEqual(b.historyFor.asked, []);
  assert.equal(u.status().history.reading, "pilot");
  const day = new Date(clock).toISOString().slice(0, 10);
  const q = { printers: [{ id: "pb", name: "B", firstSeen: T0, removedAt: null, isVirtual: false, firstJobAt: null }], range: 7, endDay: day, tz: "UTC", basis: { kind: "24h" }, basisKey: "24h" };
  assert.deepEqual((await u.reporting.summary(q)).printerHistory, { reading: "pilot", printersRead: 0 }, "a report without the pilot printer reads none, and does not name it");
  const per = await u.reporting.perPrinter({ ...q, printers: [{ id: "pa", name: "A", firstSeen: T0, removedAt: null, isVirtual: false, firstJobAt: null }, ...q.printers] });
  assert.deepEqual(per.printers.map(p => [p.id, p.historyRead]), [["pa", true], ["pb", false]]);
});

test("turned off while a pass reads pages: no further page", async t => {
  const r = rig(t);
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, on("standby"), r.clock.t); r.flush();
  let enabled = true;
  const full = Array.from({ length: 50 }, (_, i) => ({ job_id: "J" + i, filename: "a.gcode", status: "completed", start_time: T0 / 1000 - 86400 + i * 60, end_time: T0 / 1000 - 86400 + i * 60 + 30, print_duration: 30 }));
  const calls = [];
  const reader = async o => { calls.push(o); enabled = false; return { jobs: full }; };   // a full page: there would be more
  const hs = createHistorySync({ store: r.store, writer: r.writer, historyFor: () => reader, kindOf: id => r.tracker.kindOf(id), now: () => r.clock.t, log: quiet,
    setting: () => enabled, startDelayMs: 0, minGapMs: 0, pageGapMs: 0 });
  hs.tick([p], r.clock.t);
  await until(() => !hs.status().inflight);
  assert.equal(calls.length, 1, "the page after it was not requested");
  // And it starts again only when turned back on.
  for (let i = 0; i < 20; i++) { r.clock.t += 30 * S; hs.tick([p], r.clock.t); }
  assert.equal(calls.length, 1);
  enabled = true; r.clock.t += 30 * S; hs.tick([p], r.clock.t);
  await until(() => !hs.status().inflight);
  assert.ok(calls.length > 1, "turned on again: read again");
});

test("server.js: history is read only when config.json utilization.readPrinterHistory says so, live", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const at = src.indexOf("const utilization = createUtilization({");
  const block = src.slice(at, src.indexOf("});", at));
  assert.match(block, /historySetting: \(\) => CFG\.utilization \? CFG\.utilization\.readPrinterHistory : undefined,/);
  // The connector's command paths are untouched: history is still only fetchJobHistory, a read.
  assert.match(block, /typeof c\.fetchJobHistory === "function" \? opts => c\.fetchJobHistory\(p, opts\) : null/);
});

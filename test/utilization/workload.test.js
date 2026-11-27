// test/utilization/workload.test.js — regression safeguards for how much work
// fleet utilization does on the main thread, that do not depend on how busy
// the machine is:
//   - SQLite statements per operation, counted (deterministic);
//   - main-thread CPU time per writer turn (process.threadCpuUsage: this
//     thread only, so other processes and the checkpoint worker do not count),
//     on a database with two months of history, so a query that scans a
//     printer's history instead of using its index shows up.
// Wall-clock latency is measured separately, by the opt-in benchmark
// (npm run bench:utilization), not here. Disk waits (fsync) are not CPU time:
// these tests do not see them; the benchmark does.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { rig, T0, S, MIN, H, on } = require("./helpers");
const { normalizeRecord, linkNext } = require("../../utilization/history");

// A rig whose store counts statements, with the count read per batch.
function counted(t, o = {}) {
  let count = 0;
  const r = rig(t, { storeOpts: { hooks: { onStatement: () => { count++; } } }, ...o });
  const perBatch = [];
  const was = r.store.applyBatch;
  r.store.applyBatch = (id, ops) => { count = 0; const res = was(id, ops); perBatch.push({ ops, statements: count }); return res; };
  return { r, perBatch };
}
const raw = (id, s, e, status = "completed", file = "a.gcode") => ({ job_id: id, filename: file, status, start_time: s / 1000, end_time: e / 1000, print_duration: (e - s) / 2000, total_duration: (e - s) / 1000 });

// A step is at most 7: the open interval and the last end, close it, end a job,
// start one, look its id up, open the next interval. A batch adds 2 (its id).
test("statements per step: at most 7, plus 2 for the batch, whatever the printer's history", t => {
  const { r, perBatch } = counted(t);
  const ps = Array.from({ length: 30 }, (_, i) => r.P("p" + i));
  r.tracker.beginTick(ps, ps, r.clock.t);
  for (let k = 0; k < 40; k++) { r.clock.t += 30 * S; ps.forEach((p, i) => r.tracker.observe(p, on((k + i) % 3 ? "standby" : "printing", "f" + (k >> 2)), r.clock.t)); r.flush(); }
  const steps = perBatch.filter(b => b.ops.every(o => o.type === "step"));
  assert.ok(steps.length > 100);
  for (const b of steps) assert.ok(b.statements <= 2 + 7 * b.ops.length, `${b.statements} statements for ${b.ops.length} steps`);
});

test("statements per history record: at most 14 (plus 2 for the batch and 2 for the reconciliation state)", t => {
  const { r, perBatch } = counted(t);
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t);
  r.tracker.observe(p, on("standby"), r.clock.t); r.flush();
  for (let i = 0; i < 20; i++) { r.clock.t += 2 * MIN; r.tracker.observe(p, on(i % 2 ? "standby" : "printing", "a.gcode"), r.clock.t); }
  r.flush();
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push(raw("old" + i, T0 - 10 * H + i * H, T0 - 10 * H + i * H + 20 * MIN));           // backfill
  for (let i = 0; i < 10; i += 2) recs.push(raw("seen" + i, T0 + (2 + 2 * i) * MIN - 10 * S, T0 + (3 + 2 * i) * MIN));    // matched
  const records = linkNext(recs.map(x => normalizeRecord(x, { nowMs: r.clock.t }).record));
  for (let i = 0; i < records.length; i += 5) r.writer.enqueue({ type: "history", printerId: "u", at: r.clock.t, records: records.slice(i, i + 5), cursorTo: null });
  r.flush();
  const hist = perBatch.filter(b => b.ops.some(o => o.type === "history"));
  assert.equal(hist.length, 3);
  for (const b of hist) { const n = b.ops[0].records.length; assert.ok(b.statements <= 2 + 2 + 14 * n, `${b.statements} statements for ${n} records`); }
  // Applied again: one indexed look-up each.
  r.writer.enqueue({ type: "history", printerId: "u", at: r.clock.t, records: records.slice(0, 5), cursorTo: null });
  r.flush();
  assert.ok(perBatch.at(-1).statements <= 2 + 2 + 5, `${perBatch.at(-1).statements} statements to find 5 records already applied`);
});

test("statements per prune pass: one, with its table chosen", t => {
  let count = 0;
  const r = rig(t, { storeOpts: { hooks: { onStatement: () => { count++; } } } });
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t);
  for (let i = 0; i < 50; i++) { r.clock.t += MIN; r.tracker.observe(p, on(i % 2 ? "printing" : "standby", "a"), r.clock.t); }
  r.flush();
  for (const only of ["segments", "jobs", "batches"]) { count = 0; r.store.prunePass(r.clock.t, 10, only); assert.equal(count, 1, only); }
});

test("main-thread CPU per writer turn stays small on a database with two months of history", t => {
  const r = rig(t);
  const N = 30, DAY = 86400e3;
  // Two months of history for 30 printers, written straight into the database.
  const db = new DatabaseSync(path.join(r.base, "utilization-data", "utilization.db"));
  db.exec("BEGIN");
  const iP = db.prepare("INSERT OR IGNORE INTO printers (id, name, connector, is_virtual, first_seen) VALUES (?,?,?,0,?)");
  const iS = db.prepare("INSERT INTO segments (printer_id, kind, job_id, provenance, start_at, end_at) VALUES (?,?,?,'observed',?,?)");
  const iJ = db.prepare("INSERT INTO jobs (printer_id, source, filename, started_at, ended_at, outcome, job_key) VALUES (?, 'observed', 'x.gcode', ?, ?, 'completed', ?)");
  const start = T0 - 60 * DAY;
  for (let i = 0; i < N; i++) { iP.run("p" + i, "P" + i, "x", start); let t0 = start; for (let k = 0; k < 60 * 24; k++) { let jid = null; if (k % 3 === 0) jid = Number(iJ.run("p" + i, t0, t0 + H - 1000, "p" + i + ":" + t0).lastInsertRowid); iS.run("p" + i, jid ? "job" : "idle", jid, t0, t0 + H - 1000); t0 += H; } }
  db.exec("COMMIT"); db.close();
  const ps = Array.from({ length: N }, (_, i) => r.P("p" + i));
  const cpu = [];
  const runTurns = () => { r.writer.kick(); while (r.turns.length) { const a = process.threadCpuUsage(); r.turns.shift()(); const d = process.threadCpuUsage(a); cpu.push((d.user + d.system) / 1000); } };
  r.tracker.beginTick(ps, ps, r.clock.t);
  for (let k = 0; k < 60; k++) {
    r.clock.t += 30 * S;
    r.tracker.beginTick(ps, ps, r.clock.t);
    ps.forEach(p => r.tracker.observe(p, on(k % 2 ? "printing" : "standby", "f" + k), r.clock.t));          // all 30 change
    if (k === 20) r.writer.schedulePrune(T0 - 50 * DAY);
    if (k === 30) {
      const recs = linkNext(Array.from({ length: 10 }, (_, i) => normalizeRecord(raw("h" + i, T0 - 61 * DAY + i * H, T0 - 61 * DAY + i * H + 30 * MIN), { nowMs: r.clock.t }).record));
      for (let i = 0; i < 10; i += 5) r.writer.enqueue({ type: "history", printerId: "p0", at: r.clock.t, records: recs.slice(i, i + 5), cursorTo: null });
    }
    r.writer.pollTick();
    runTurns();
  }
  cpu.sort((a, b) => a - b);
  const p99 = cpu[Math.floor(cpu.length * 0.99)], max = cpu.at(-1);
  // Measured on the development machine: p99 about 1-2 ms. The ceilings leave
  // room for slower CPUs while still failing on a scan of a printer's history.
  t.diagnostic(`${cpu.length} turns: main-thread CPU p50 ${cpu[Math.floor(cpu.length / 2)].toFixed(2)} p99 ${p99.toFixed(2)} max ${max.toFixed(2)} ms`);
  assert.ok(cpu.length > 200, `${cpu.length} turns`);
  assert.ok(p99 < 8, `p99 ${p99.toFixed(2)} ms of main-thread CPU per turn`);
  assert.ok(max < 25, `max ${max.toFixed(2)} ms of main-thread CPU per turn`);
});

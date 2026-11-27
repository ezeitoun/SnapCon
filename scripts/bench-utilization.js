#!/usr/bin/env node
// scripts/bench-utilization.js — wall-clock performance check for fleet
// utilization (opt-in; not part of npm test). Builds a synthetic database in a
// temporary folder (default: 30 printers x 400 days), then drives the real
// store, tracker, writer, checkpoint worker and history reconciliation and
// reports main-thread latency (p50/p95/p99/max), event-loop delay, checkpoint
// duration, WAL size, prune, backup, shutdown and history batches.
//
//   npm run bench:utilization                     the full workload (several minutes)
//   npm run bench:utilization -- --days 5 --polls 30   a quick check
//   npm run bench:utilization -- --only reporting  the reporting API's rollups and queries only
//
// Results depend on the machine and how busy it is: compare runs on the same
// machine, quiet. Targets (owner, Phase 1.1): routine analytics p99 < 2 ms,
// max < 10 ms on the main thread.
"use strict";
const { performance, monitorEventLoopDelay } = require("perf_hooks");
const fs = require("fs"), os = require("os"), path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createUtilizationStore } = require("../utilization/UtilizationStore");
const { createTracker } = require("../utilization/Tracker");
const { createWriter } = require("../utilization/Writer");
const { createCheckpointer } = require("../utilization/Checkpointer");
const { normalizeRecord, linkNext } = require("../utilization/history");
const { createReporting } = require("../utilization/Reporting");

const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const DAYS = arg("days", 400), N = arg("printers", 30), POLLS = arg("polls", 300);
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1] : null; })();
const DAY = 86400e3, H = 3600e3;
const quiet = { log() {}, warn() {}, error() {} };
const pct = (a, ...ps) => { const b = [...a].sort((x, y) => x - y); return ps.map(p => (p === "max" ? b[b.length - 1] : b[Math.min(b.length - 1, Math.floor(p * b.length))])); };
const fmt = a => { if (!a.length) return "none"; const [p50, p95, p99, mx] = pct(a, 0.5, 0.95, 0.99, "max"); return `p50 ${p50.toFixed(2)}  p95 ${p95.toFixed(2)}  p99 ${p99.toFixed(2)}  max ${mx.toFixed(2)} ms  (n=${a.length})`; };
const ev = h => `p50 ${(h.percentile(50) / 1e6).toFixed(2)}  p95 ${(h.percentile(95) / 1e6).toFixed(2)}  p99 ${(h.percentile(99) / 1e6).toFixed(2)}  max ${(h.max / 1e6).toFixed(2)} ms`;

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-bench-"));
  try {
    let now = Date.now();
    { // the synthetic history: 24 intervals a printer a day, a job every third
      const s = createUtilizationStore({ baseDir: base, log: quiet, now: () => now }).open(); s.close();
      const db = new DatabaseSync(path.join(base, "utilization-data", "utilization.db"));
      db.exec("BEGIN");
      const iP = db.prepare("INSERT INTO printers (id, name, connector, is_virtual, first_seen) VALUES (?,?,?,0,?)");
      const iS = db.prepare("INSERT INTO segments (printer_id, kind, job_id, provenance, start_at, end_at) VALUES (?,?,?,'observed',?,?)");
      const iJ = db.prepare("INSERT INTO jobs (printer_id, source, filename, started_at, ended_at, outcome, job_key) VALUES (?, 'observed', 'x.gcode', ?, ?, 'completed', ?)");
      const start = now - (DAYS + 30) * DAY;
      for (let i = 0; i < N; i++) { iP.run("p" + i, "U1 " + i, "snapmaker-u1-klipper-ws", start); let t = start; for (let k = 0; k < (DAYS + 30) * 24; k++) { let jid = null; if (k % 3 === 0) jid = Number(iJ.run("p" + i, t, t + H - 1000, "p" + i + ":" + t).lastInsertRowid); iS.run("p" + i, jid ? "job" : "idle", jid, t, t + H - 1000); t += H; } }
      db.exec("COMMIT"); db.close();
    }
    const file = path.join(base, "utilization-data", "utilization.db");
    console.log(`database: ${N} printers x ${DAYS + 30} days, ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
    let t0 = performance.now();
    const store = createUtilizationStore({ baseDir: base, log: quiet, now: () => now }).open();
    const tOpen = performance.now() - t0;
    if (ONLY === "reporting") { await benchReporting(base, () => now, store); store.close(); return; }
    const turnMs = []; let writer, cp;
    cp = createCheckpointer({ store, log: quiet, onRelease: () => writer.kick(), onStop: w => writer.halt(w) });
    writer = createWriter({ store, log: quiet, clock: () => now, onCommit: () => cp.noteCommit(), onIdle: () => cp.noteIdle(), gate: () => cp.gate(),
      schedule: fn => setImmediate(() => { const a = performance.now(); fn(); turnMs.push(performance.now() - a); }) });
    const tracker = createTracker({ store, writer, log: quiet });
    tracker.start(now); cp.start();
    console.log(`startup (main thread): open + quick_check ${tOpen.toFixed(0)} ms`);
    while (cp.status().state !== "ok") await new Promise(r => setTimeout(r, 5));
    const realPrune = writer.schedulePrune; writer.schedulePrune = () => {};
    const ps = Array.from({ length: N }, (_, i) => ({ id: "p" + i, name: "U1 " + i, connector: "x" }));
    const on = (state, f) => ({ online: true, state, filename: f });
    const ck = [], wal = []; let lastCk = null;
    const sample = () => { const s = cp.status(); wal.push(s.walPhysicalBytes); if (s.lastCheckpoint && s.lastCheckpoint.at !== lastCk) { lastCk = s.lastCheckpoint.at; ck.push(s.lastCheckpoint.ms); } };
    const gap = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 5)); sample(); } };
    const settle = async () => { while (writer.pending() || cp.status().pending) { await new Promise(r => setTimeout(r, 2)); sample(); } };
    async function scenario(name, polls, readingOf) {
      turnMs.length = 0; ck.length = 0; wal.length = 0;
      const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
      for (let k = 0; k < polls; k++) { now += 30e3; tracker.beginTick(ps, ps, now); ps.forEach((p, i) => tracker.observe(p, readingOf(k, i), now)); writer.pollTick(); await gap(); }
      await settle(); h.disable();
      console.log(`\n${name}\n  writer turns (main thread): ${fmt(turnMs)}\n  event-loop delay:           ${ev(h)}\n  checkpoints (worker):       ${fmt(ck)}\n  WAL file:                   max ${(Math.max(0, ...wal) / 1048576).toFixed(2)} MB`);
    }
    await scenario("steady", POLLS, () => on("standby"));
    await scenario("one printer changes per poll", POLLS, (k, i) => on(i === k % N ? "printing" : "standby", "a"));
    await scenario("all printers change in the same poll", Math.max(1, POLLS >> 1), k => on(k % 2 ? "printing" : "standby", "f" + k));
    { turnMs.length = 0; const h = monitorEventLoopDelay({ resolution: 1 }); h.enable(); realPrune(now - DAYS * DAY); let polls = 0;
      while (writer.status().pruning && polls++ < 5000) { now += 30e3; tracker.beginTick(ps, ps, now); ps.forEach(p => tracker.observe(p, on("standby"), now)); writer.pollTick(); await gap(); }
      await settle(); h.disable();
      console.log(`\nprune (${writer.status().prunedSegments} intervals, ${writer.status().prunedJobs} jobs) over ${polls} polls\n  turns:            ${fmt(turnMs)}\n  event-loop delay: ${ev(h)}`); }
    { const ms = []; for (let b = 0; b < 60; b++) {
        const t = now - (DAYS + 29) * DAY + b * 6 * H;
        const recs = linkNext([0, 1, 2, 3, 4].map(i => normalizeRecord({ job_id: `b${b}-${i}`, filename: "x.gcode", status: "completed", start_time: (t + i * H) / 1000, end_time: (t + i * H + 30 * 60e3) / 1000, print_duration: 1200 }, { nowMs: now }).record));
        const a = performance.now(); store.applyBatch("bench-h" + b, [{ type: "history", printerId: "p" + (b % N), at: now, records: recs, cursorTo: null }]); ms.push(performance.now() - a); }
      console.log(`\nhistory batches (5 records each, main thread): ${fmt(ms)}`); }
    { const h = monitorEventLoopDelay({ resolution: 1 }); h.enable(); cp.backup(); let polls = 0;
      while (!cp.status().lastBackup) { polls++; now += 30e3; tracker.beginTick(ps, ps, now); ps.forEach(p => tracker.observe(p, on("standby"), now)); writer.pollTick(); await gap(); }
      h.disable(); const b = cp.status().lastBackup;
      console.log(`\nnightly backup (worker): ${b.ok ? b.ms + " ms" : "FAILED " + b.error}; ${polls} polls meanwhile; event-loop delay ${ev(h)}`); }
    await settle();
    t0 = performance.now(); tracker.stopEnqueue(now + 1); const r = await writer.drain(performance.now() + 500); const tDrain = performance.now() - t0;
    t0 = performance.now(); store.close(); const tClose = performance.now() - t0;
    t0 = performance.now(); const c = await cp.stop(500); const tWorker = performance.now() - t0;
    console.log(`\nclean stop: drain ${tDrain.toFixed(1)} ms (left ${r.left}); main close ${tClose.toFixed(2)} ms; worker close + fold ${tWorker.toFixed(1)} ms (clean ${c.workerClosed})`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });

// The reporting API's work (Phase 3): rollups computed cold (nothing cached)
// and warm, for the longest range (90 days and the 90 before), all printers.
async function benchReporting(base, nowFn, store) {
  let reporting = null;
  store.close();
  const s2 = createUtilizationStore({ baseDir: base, log: quiet, now: nowFn, onTouched: ch => reporting && reporting.invalidate(ch) }).open();
  reporting = createReporting({ store: s2, now: nowFn });
  const { localDay } = require("../utilization/timeBuckets");
  const printers = s2.printers().map(p => ({ ...p, firstJobAt: s2.firstJobAt(p.id) }));
  const q = range => ({ printers, range, endDay: localDay(nowFn(), "UTC"), tz: "UTC", basis: { kind: "24h" }, basisKey: "24h" });
  // The longest stretch the event loop was held, measured directly: a 1 ms
  // timer's lateness, sampled until well after the request ends.
  const time = async (name, fn) => {
    let last = performance.now(), worst = 0;
    const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last - 1); last = n; }, 1);
    const t0 = performance.now(); const r = await fn(); const ms = performance.now() - t0;
    await new Promise(res => setTimeout(res, 30));
    clearInterval(iv);
    console.log(`  ${name.padEnd(46)} ${ms.toFixed(0).padStart(6)} ms wall; longest event-loop hold ${worst.toFixed(1)} ms${typeof r === "string" ? `; ${(r.length / 1024).toFixed(0)} KB` : ""}`);
    return r;
  };
  console.log(`\nreporting (${printers.length} printers, ${DAYS + 30} days of history)`);
  { // what utilization.start() now does, at SnapCon's start: the zone data, once
    const t0 = performance.now(); require("../utilization/timeBuckets").warmTimeZones();
    console.log(`  zone data initialised at start (not in a request): ${(performance.now() - t0).toFixed(1)} ms`); }
  await time("summary, 90 days + previous 90, cold", () => reporting.summary(q(90)));
  const st = reporting.status();
  console.log(`  rollups computed: ${st.computedDays} printer-days in ${st.chunks} chunks; slowest chunk ${st.chunkMsMax.toFixed(2)} ms; chunk size now ${st.chunkDays} days`);
  { // cold again, in a process already warmed up (statements compiled, code optimised)
    const fresh = createReporting({ store: s2, now: nowFn });
    await time("summary, 90 days + previous 90, cold (2nd time)", () => fresh.summary(q(90)));
  }
  await time("summary, 90 days + previous 90, warm", () => reporting.summary(q(90)));
  await time("series, 90 days (weeks), warm", () => reporting.series(q(90)));
  await time("per printer, 90 days, warm", () => reporting.perPrinter(q(90)));
  await time("CSV, printers x 90 days, warm", () => reporting.csv(q(90), "printers"));
  await time("summary, 7 days, warm", () => reporting.summary(q(7)));
  // A change 30 days back on every printer: the days after it are recomputed.
  const t30 = nowFn() - 30 * DAY;
  reporting.invalidate(new Map(printers.map(p => [p.id, t30])));
  await time("summary, 90 days, after a change 30 days back", () => reporting.summary(q(90)));
  console.log(`  cache: ${reporting.status().cacheEntries} entries`);
  s2.close();
}

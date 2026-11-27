// utilization/Reporting.js — fleet utilization reports (Phase 3): daily
// rollups, the KPIs, time series, per-printer breakdowns and CSV, all from one
// set of calculations, so the API and the CSV cannot disagree.
//
// Rollups: one per printer, local day, time zone and basis (rollup.js), kept
// in a bounded in-memory cache. Only complete days are kept; the current day is
// always computed afresh. The store reports, after each commit, the earliest
// moment each printer's data changed (onTouched); every cached day ending after
// that moment is dropped, and only those are recomputed. Kept in memory, not in
// the database, so that reporting never writes outside the Writer (and its WAL
// controls); after a restart the first report recomputes what it needs.
//
// Bounded work on the main thread: rollups are computed for one printer and a
// few days at a time (`chunkDays`, adapted to stay within `turnBudgetMs`), with
// the event loop free between chunks, through indexed reads only
// (store.segmentsIn / jobsStarted / jobById); one computation at a time.
//
// KPI definitions (Phase 0 formulas.js metrics, plus the closeout rule that an
// estimate is never confirmed productive time): see docs/fleet-utilization.md.
"use strict";
const { performance } = require("perf_hooks");
const { BUCKETS, PROVENANCE } = require("./classify");
const { delta } = require("./formulas");
const { rangeDays, previousRange, rollingBlocks, blockSpan, dayRange } = require("./timeBuckets");
const { dayRollups, emptyJobs } = require("./rollup");

const HOUR = 3600e3, DAY = 86400e3;
const ratio = (a, b) => (b > 0 ? a / b : null);
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const tick = () => new Promise(r => setImmediate(r));

// The conservative-accounting limits every report carries (docs/fleet-utilization.md).
const LIMITATIONS = Object.freeze([
  "offline-jobs-not-timed", "short-jobs-not-timed", "estimates-only-print-duration-share",
  "unknown-outcomes-never-success", "observed-ends-at-next-poll", "merged-reprints-not-separated",
]);

function createReporting({ store, now = Date.now, historyReading = () => ({ mode: "off", ids: null }), maxCacheEntries = 20000, turnBudgetMs = 2, maxJobSpanMs = 7 * DAY } = {}) {
  const cache = new Map();               // printerId -> Map(key -> rollup)
  let size = 0, chunkDays = 7, queue = Promise.resolve();
  const stats = { computedDays: 0, cachedDays: 0, chunks: 0, chunkMsMax: 0, invalidated: 0 };

  function invalidate(changed) {
    for (const [pid, t] of changed) {
      const m = cache.get(pid);
      if (!m) continue;
      for (const [k, r] of m) if (r.end > t) { m.delete(k); size--; stats.invalidated++; }
    }
  }
  function put(pid, key, r) {
    let m = cache.get(pid);
    if (!m) { m = new Map(); cache.set(pid, m); }
    if (!m.has(key)) size++;
    m.set(key, r);
    while (size > maxCacheEntries) {                      // oldest printer-map entries first
      for (const [, mm] of cache) { const first = mm.keys().next(); if (!first.done) { mm.delete(first.value); size--; break; } }
    }
  }

  // Rollups of `printers` over `days`: Map printerId -> rollup[] (days order).
  function rollups(printers, days, ctx) {
    const run = queue.then(() => compute(printers, days, ctx));
    queue = run.catch(() => {});
    return run;
  }
  async function compute(printers, days, { tz, basis, basisKey }) {
    const out = new Map();
    for (const p of printers) {
      await tick();                                         // one printer's look-ups at a time
      const got = new Map(), missing = [];
      const m = cache.get(p.id);
      for (const d of days) { const r = m && m.get(`${tz}|${basisKey}|${d}`); if (r) { got.set(d, r); stats.cachedDays++; } else missing.push(d); }
      for (let i = 0; i < missing.length;) {
        const chunk = missing.slice(i, i + chunkDays);
        i += chunk.length;
        await tick();
        const t0 = performance.now();
        const from = dayRange(chunk[0], tz).start, to = Math.min(dayRange(chunk.at(-1), tz).end, now());
        const segments = to > from ? store.segmentsIn(p.id, from, to) : [];
        const jobsToCount = to > from ? store.jobsStarted(p.id, from - maxJobSpanMs, dayRange(chunk.at(-1), tz).end) : [];
        const jobsById = new Map(jobsToCount.map(j => [j.id, j]));
        for (const s of segments) if (s.jobId != null && !jobsById.has(s.jobId)) { const j = store.jobById(s.jobId); if (j) jobsById.set(j.id, j); }
        const rs = dayRollups({ printer: p, segments, jobsById, jobsToCount, days: chunk, tz, basis, nowMs: now() });
        for (const r of rs) { got.set(r.day, r); if (r.complete) put(p.id, `${tz}|${basisKey}|${r.day}`, r); }
        const ms = performance.now() - t0;
        stats.chunks++; stats.computedDays += chunk.length; stats.chunkMsMax = Math.max(stats.chunkMsMax, ms);
        if (ms > turnBudgetMs && chunkDays > 1) chunkDays = Math.max(1, Math.floor(chunkDays / 2));
        else if (ms < turnBudgetMs / 4 && chunkDays < 30) chunkDays = Math.min(30, chunkDays * 2);
      }
      out.set(p.id, days.map(d => got.get(d)));
    }
    return out;
  }

  // One aggregate (a fleet, a printer, a day or a block) from rollups: sums
  // only (each day carries its own printer-days), yielding every 500 days so a
  // large report never holds the event loop.
  async function aggregate(rs) {
    const t = Object.fromEntries(BUCKETS.map(b => [b, 0])), est = Object.fromEntries(BUCKETS.map(b => [b, 0]));
    const prov = Object.fromEntries(PROVENANCE.map(p => [p, Object.fromEntries(BUCKETS.map(b => [b, 0]))]));
    let eligibleMs = 0, basisMs = 0, printerDays = 0, recordedPrinterDays = 0, n = 0;
    const jobs = emptyJobs();
    for (const r of rs) {
      eligibleMs += r.eligibleMs; basisMs += r.basisMs; printerDays += r.printerDays; recordedPrinterDays += r.recordedPrinterDays;
      for (const b of BUCKETS) { t[b] += r.buckets[b]; est[b] += r.estimated[b]; for (const p of PROVENANCE) prov[p][b] += r.provenance[p][b]; }
      for (const k of ["completed", "failed", "cancelled", "running"]) jobs[k] += r.jobs[k];
      for (const k of Object.keys(jobs.unknown)) jobs.unknown[k] += r.jobs.unknown[k];
      for (const k of Object.keys(jobs.evidence)) jobs.evidence[k] += r.jobs.evidence[k];
      if (++n % 500 === 0) await tick();
    }
    const m = { printerDays, recordedPrinterDays,
      pausedErrorHoursPerPrinterDay: recordedPrinterDays > 0 ? ((t.paused + t.error) / HOUR) / recordedPrinterDays : null };
    const gap = t.unobserved + t.historicalUncertain + t.notRecorded;
    const recordedMs = eligibleMs - gap;
    const cPrinting = t.printing - est.printing, cFailed = t.failed - est.failed;
    const failedJobs = jobs.failed + jobs.cancelled;
    const hours = Object.fromEntries(BUCKETS.map(b => [b, {
      total: round(t[b] / HOUR), observed: round(prov.observed[b] / HOUR), inferred: round(prov.inferred[b] / HOUR),
      backfilled: round(prov.backfilled[b] / HOUR), estimated: round(est[b] / HOUR),
    }]));
    return {
      basisHours: round(basisMs / HOUR), eligibleHours: round(eligibleMs / HOUR), recordedHours: round(recordedMs / HOUR),
      printerDays: round(m.printerDays), recordedPrinterDays: round(m.recordedPrinterDays),
      // Every bucket, against eligible time: they add up to it, Not recorded included.
      hours,
      shares: Object.fromEntries(BUCKETS.map(b => [b, round(ratio(t[b], eligibleMs))])),
      coverage: {
        telemetry: round(ratio(recordedMs, eligibleMs)),
        outcomes: round(ratio(t.printing + t.failed, t.printing + t.failed + t.provisionalRunning + t.provisionalUnknown)),
        jobsWithOutcome: round(ratio(jobs.completed + failedJobs, jobs.completed + failedJobs + jobs.unknown.total)),
      },
      kpis: {
        // Confirmed Printing (estimates excluded) / eligible time. Null when nothing was recorded.
        utilization: {
          value: recordedMs > 0 ? round(ratio(cPrinting, eligibleMs)) : null,
          withEstimates: recordedMs > 0 ? round(ratio(t.printing, eligibleMs)) : null,
          numeratorHours: round(cPrinting / HOUR), estimatedHoursExcluded: round(est.printing / HOUR), denominatorHours: round(eligibleMs / HOUR),
        },
        // Confirmed Printing hours per printer-day (a printer-day: eligible / basis, per day; for farm hours, per scheduled day).
        avgPrintHoursPerPrinterDay: {
          value: recordedMs > 0 && m.printerDays > 0 ? round(cPrinting / HOUR / m.printerDays) : null,
          withEstimates: recordedMs > 0 && m.printerDays > 0 ? round(t.printing / HOUR / m.printerDays) : null,
          printerDays: round(m.printerDays),
        },
        // Failed time / (Printing + Failed time), confirmed (estimates excluded).
        failureLoss: {
          value: round(ratio(cFailed, cPrinting + cFailed)),
          withEstimates: round(ratio(t.failed, t.printing + t.failed)),
          failedHours: round(cFailed / HOUR), printingHours: round(cPrinting / HOUR),
        },
        // (Paused + Error) hours per recorded printer-day (only observed and inferred time knows them).
        pausedErrorHoursPerPrinterDay: {
          value: round(m.pausedErrorHoursPerPrinterDay), pausedHours: round(t.paused / HOUR), errorHours: round(t.error / HOUR),
          recordedPrinterDays: round(m.recordedPrinterDays),
        },
      },
      // Secondary (owner, Phase 3 closeout): with its outcome coverage beside it.
      secondary: {
        // Completed / (completed + failed + cancelled). Unknown and running outcomes are not in it.
        successRate: { value: round(ratio(jobs.completed, jobs.completed + failedJobs)), completed: jobs.completed, failed: jobs.failed, cancelled: jobs.cancelled, unknown: jobs.unknown.total,
          outcomeCoverage: round(ratio(jobs.completed + failedJobs, jobs.completed + failedJobs + jobs.unknown.total)) },
      },
      jobs,
    };
  }
  // The four tiles (owner, closeout) and the secondary success rate; "better" is
  // up for the first two, down for the next two (the brief), up for success.
  const KPI_DIRECTION = { utilization: true, avgPrintHoursPerPrinterDay: true, failureLoss: false, pausedErrorHoursPerPrinterDay: false };
  function deltas(cur, prev) {
    const d = Object.fromEntries(Object.entries(KPI_DIRECTION).map(([k, up]) => [k, delta(cur.kpis[k].value, prev.kpis[k].value, {
      higherIsBetter: up, currentCoverage: cur.coverage.telemetry, previousCoverage: prev.coverage.telemetry })]));
    d.successRate = delta(cur.secondary.successRate.value, prev.secondary.successRate.value, { higherIsBetter: true,
      currentCoverage: cur.secondary.successRate.outcomeCoverage, previousCoverage: prev.secondary.successRate.outcomeCoverage });
    return d;
  }

  // ---- the reports ----
  // q: { printers: [meta], range: 7|30|90, endDay, tz, basis, basisKey }
  async function load(q) {
    const days = rangeDays(q.endDay, q.range);
    const prevDays = previousRange(days);
    const all = await rollups(q.printers, [...prevDays, ...days], q);
    const cur = new Map(), prev = new Map();
    for (const [pid, rs] of all) { prev.set(pid, rs.slice(0, prevDays.length)); cur.set(pid, rs.slice(prevDays.length)); }
    return { days, prevDays, cur, prev };
  }
  const header = q => ({ range: q.range, from: rangeDays(q.endDay, q.range)[0], to: q.endDay, timeZone: q.tz, basis: q.basis.kind === "farm" ? { kind: "farm", schedule: q.basis.schedule } : { kind: "24h" },
    printers: q.printers.length, limitations: LIMITATIONS, printerHistory: historyHeader(q) });
  // Whether the printers' own job history is read (config.json
  // utilization.readPrinterHistory, off unless set), and for how many of the
  // printers in this report: a count, never the ids of printers not shown.
  function historyHeader(q) {
    let h; try { h = historyReading() || { mode: "off" }; } catch { h = { mode: "off" }; }
    const read = h.mode === "on" ? q.printers.length : h.mode === "pilot" ? q.printers.filter(p => h.ids.has(p.id)).length : 0;
    return { reading: h.mode, printersRead: read };
  }
  const historyRead = id => { try { const h = historyReading() || { mode: "off" }; return h.mode === "on" || (h.mode === "pilot" && h.ids.has(id)); } catch { return false; } };

  async function summary(q) {
    const { days, prevDays, cur, prev } = await load(q);
    const c = await aggregate([...cur.values()].flat()), p = await aggregate([...prev.values()].flat());
    const recon = reconciliation(q.printers);
    return { ...header(q), previous: { from: prevDays[0], to: prevDays.at(-1) }, current: c, previousPeriod: p, deltas: deltas(c, p), reconciliation: recon,
      flags: { partialCoverage: c.coverage.telemetry != null && c.coverage.telemetry < 1, hasEstimates: Object.values(c.hours).some(h => h.estimated > 0),
        unresolvedOrAmbiguous: c.jobs.unknown.unresolved + c.jobs.unknown.ambiguous > 0, days: days.length } };
  }
  async function series(q) {
    const { days, cur } = await load(q);
    const blocks = q.range === 90 ? rollingBlocks(days, 7) : days.map(d => [d]);
    const index = new Map(days.map((d, i) => [d, i]));
    const points = [];
    for (const block of blocks) { points.push({ ...blockSpan(block), ...(await aggregate([...cur.values()].flatMap(rs => block.map(d => rs[index.get(d)])))) }); await tick(); }
    return { ...header(q), granularity: q.range === 90 ? "week" : "day", points };
  }
  async function perPrinter(q) {
    const { cur, prev } = await load(q);
    const printers = [];
    for (const p of q.printers) {
      const c = await aggregate(cur.get(p.id)), pr = await aggregate(prev.get(p.id));
      printers.push({ id: p.id, name: p.name, removedAt: p.removedAt ?? null, virtual: !!p.isVirtual, historyRead: historyRead(p.id), ...c, deltas: deltas(c, pr), reconciliation: reconciliation([p]) });
      await tick();
    }
    return { ...header(q), printers };
  }
  // History reconciliation counters (Phase 2), summed: conflicts stay visible.
  function reconciliation(printers) {
    const sum = { matched: 0, settled: 0, corrected: 0, unresolved: 0, resolvedLater: 0, ambiguous: 0, short: 0, duringOffline: 0, backfilled: 0, conflicts: {} };
    for (const p of printers) {
      const st = store.historyState(p.id);
      if (!st) continue;
      for (const k of Object.keys(sum)) if (k !== "conflicts") sum[k] += st.counters[k] || 0;
      for (const [k, v] of Object.entries(st.counters.conflicts || {})) sum.conflicts[k] = (sum.conflicts[k] || 0) + v;
    }
    return sum;
  }

  // CSV: one row per day and printer ("printers"), or per day for the fleet
  // ("fleet"). The same aggregate() as the API; units in the column names.
  const CSV_COLUMNS = [
    ["date", r => r.day], ["printer_id", r => r.printerId], ["printer_name", r => r.printerName], ["printer_removed", r => r.removed], ["printer_virtual", r => r.virtual],
    ["time_zone", r => r.tz], ["basis", r => r.basis],
    ["basis_hours", r => r.a.basisHours], ["eligible_hours", r => r.a.eligibleHours], ["recorded_hours", r => r.a.recordedHours],
    ...BUCKETS.flatMap(b => [[`${snake(b)}_hours`, r => r.a.hours[b].total], [`${snake(b)}_estimated_hours`, r => r.a.hours[b].estimated]]),
    ["observed_hours", r => sumOf(r.a.hours, "observed")], ["inferred_hours", r => sumOf(r.a.hours, "inferred")], ["backfilled_hours", r => sumOf(r.a.hours, "backfilled")],
    ["printer_days", r => r.a.printerDays], ["recorded_printer_days", r => r.a.recordedPrinterDays],
    ["utilization_confirmed_pct", r => pct(r.a.kpis.utilization.value)], ["utilization_with_estimates_pct", r => pct(r.a.kpis.utilization.withEstimates)],
    ["avg_print_hours_per_printer_day", r => r.a.kpis.avgPrintHoursPerPrinterDay.value], ["avg_print_hours_per_printer_day_with_estimates", r => r.a.kpis.avgPrintHoursPerPrinterDay.withEstimates],
    ["failure_loss_confirmed_pct", r => pct(r.a.kpis.failureLoss.value)], ["failure_loss_with_estimates_pct", r => pct(r.a.kpis.failureLoss.withEstimates)],
    ["paused_error_hours_per_recorded_printer_day", r => r.a.kpis.pausedErrorHoursPerPrinterDay.value],
    ["job_success_rate_pct", r => pct(r.a.secondary.successRate.value)], ["jobs_with_outcome_pct", r => pct(r.a.secondary.successRate.outcomeCoverage)],
    ["telemetry_coverage_pct", r => pct(r.a.coverage.telemetry)],
    ["jobs_completed", r => r.a.jobs.completed], ["jobs_failed", r => r.a.jobs.failed], ["jobs_cancelled", r => r.a.jobs.cancelled], ["jobs_running", r => r.a.jobs.running],
    ["jobs_outcome_unknown", r => r.a.jobs.unknown.total], ["jobs_unresolved", r => r.a.jobs.unknown.unresolved], ["jobs_ambiguous", r => r.a.jobs.unknown.ambiguous],
    ["jobs_recovered_from_history", r => r.a.jobs.evidence.recoveredShort + r.a.jobs.evidence.recoveredDuringOffline + r.a.jobs.evidence.recoveredInsideMerged + r.a.jobs.evidence.backfilled],
  ];
  async function csv(q, view) {
    const { days, cur } = await load(q);
    const basis = q.basis.kind === "farm" ? "farm-hours" : "24h";
    const rows = [];
    const lines = [CSV_COLUMNS.map(c => c[0]).join(",")];
    const line = r => CSV_COLUMNS.map(c => csvCell(c[1](r))).join(",");
    if (view === "fleet") for (const [i, d] of days.entries()) lines.push(line({ day: d, printerId: "", printerName: "(fleet)", removed: "", virtual: "", tz: q.tz, basis, a: await aggregate([...cur.values()].map(rs => rs[i])) }));
    else for (const p of q.printers) {
      const rs = cur.get(p.id);
      for (let i = 0; i < rs.length; i++) lines.push(line({ day: days[i], printerId: p.id, printerName: p.name, removed: p.removedAt != null ? "yes" : "no", virtual: p.isVirtual ? "yes" : "no", tz: q.tz, basis, a: await aggregate([rs[i]]) }));
      await tick();
    }
    return lines.join("\r\n") + "\r\n";
  }

  return { summary, series, perPrinter, csv, invalidate, aggregate, status: () => ({ ...stats, cacheEntries: size, chunkDays }) };
}

const snake = s => s.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
const pct = x => (x == null ? null : round(x * 100, 2));
const sumOf = (hours, k) => round(Object.values(hours).reduce((n, h) => n + h[k], 0));
// A CSV cell. Text that a spreadsheet would run as a formula (= + - @, tab,
// carriage return first) gets a leading apostrophe; quotes, commas and line
// breaks are quoted. Numbers are written as numbers; null as empty.
function csvCell(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { createReporting, csvCell, LIMITATIONS };

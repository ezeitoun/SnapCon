// utilization/rollup.js — one printer's local days, from its intervals and jobs
// (fleet utilization, Phase 3). Pure: the inputs are rows already read
// (store.segmentsIn / jobsStarted), the accounting is Phase 0's (formulas.js
// accountPrinter, eligibleSpan; timeBuckets dayRange, farmWindows).
//
// A day's rollup is the Phase 0 ledger for that printer and day (every
// millisecond of eligible time in exactly one bucket, with its provenance and
// what of it is estimated) plus the jobs attributed to the day: a job counts on
// the local day it ended, or the day it started when it has no end time; a
// job still running counts as running.
"use strict";
const { BUCKETS, PROVENANCE } = require("./classify");
const { accountPrinter, eligibleSpan, metrics } = require("./formulas");
const { dayRange, farmWindows, clip } = require("./timeBuckets");

const zero = () => Object.fromEntries(BUCKETS.map(b => [b, 0]));
const emptyLedger = basisMs => ({ eligibleMs: 0, basisMs, buckets: zero(), provenance: Object.fromEntries(PROVENANCE.map(p => [p, zero()])), estimated: zero() });

// How a job's outcome is known, and why an unknown one is unknown.
function jobEvidence(j) {
  const src = j.outcome_source || null;
  let evidence;
  if (j.source === "backfilled") evidence = ({ short: "recoveredShort", offline: "recoveredDuringOffline", merged: "recoveredInsideMerged" })[j.history_mode] || "backfilled";
  else if (src === "history") evidence = /later job/.test(j.end_reason || "") ? "historyCorrected" : "historySettled";
  else if (src === "unresolved" || src === "ambiguous") evidence = src;
  else evidence = "observed";
  let unknownCause = null;
  if (j.outcome === "unknown") {
    if (src === "unresolved") unknownCause = "unresolved";
    else if (src === "ambiguous") unknownCause = "ambiguous";
    else if (/^history:/.test(j.end_reason || "")) unknownCause = "interrupted";      // the printer's own record says so
    else if (j.end_reason === "ended-without-outcome") unknownCause = "endedWithoutOutcome";
    else unknownCause = "other";                                                       // removed, not polled, another job...
  }
  return { evidence, unknownCause };
}
const emptyJobs = () => ({
  completed: 0, failed: 0, cancelled: 0, running: 0,
  unknown: { total: 0, unresolved: 0, ambiguous: 0, interrupted: 0, endedWithoutOutcome: 0, other: 0 },
  evidence: { observed: 0, historySettled: 0, historyCorrected: 0, unresolved: 0, ambiguous: 0, recoveredShort: 0, recoveredDuringOffline: 0, recoveredInsideMerged: 0, backfilled: 0 },
});
function countJob(acc, j) {
  if (j.outcome === "running") { acc.running++; return; }
  const { evidence, unknownCause } = jobEvidence(j);
  acc.evidence[evidence]++;
  if (j.outcome === "completed") acc.completed++;
  else if (j.outcome === "failed") acc.failed++;
  else if (j.outcome === "cancelled") acc.cancelled++;
  else { acc.unknown.total++; acc.unknown[unknownCause]++; }
}

// printer: { id, firstSeen, firstJobAt, removedAt }   (eligibility: Phase 0 eligibleSpan)
// segments: store rows (start, end|null, kind, jobId, provenance, estimated, knownFraction)
// jobsById: Map id -> job row (every job a segment names, and the jobs to count)
// basis: { kind: "24h" } | { kind: "farm", schedule }
function dayRollups({ printer, segments, jobsById, jobsToCount = [], days, tz, basis, nowMs }) {
  const intervals = [];
  for (const s of segments) {
    const end = s.end == null ? nowMs : s.end;
    if (!(end > s.start)) continue;
    const j = s.jobId != null ? jobsById.get(s.jobId) : null;
    intervals.push({ start: s.start, end, kind: s.kind, provenance: s.provenance, estimated: s.estimated, knownFraction: s.knownFraction,
      outcome: s.kind === "job" ? (j ? j.outcome : "unknown") : undefined });
  }
  return days.map(day => {
    const { start: ds, end: de } = dayRange(day, tz);
    // The basis inside this day, as parts of shifts (24 hours: the day is its own shift).
    const windows = basis.kind === "farm" ? farmWindows(day, basis.schedule, tz) : [{ start: ds, end: de, shiftStart: ds, shiftEnd: de }];
    const basisMs = windows.reduce((n, w) => n + w.end - w.start, 0);
    const until = Math.min(de, nowMs);
    const complete = de <= nowMs;
    const span = until > ds ? eligibleSpan({ ...printer, isVirtual: false }, ds, until) : null;
    const ledger = span && basisMs > 0
      ? accountPrinter({ segments: clip(intervals, [span]), start: span.start, end: span.end, windows, basisMs })
      : emptyLedger(basisMs);
    const jobs = emptyJobs();
    for (const j of jobsToCount) {
      const at = j.outcome === "running" ? j.started_at : (j.ended_at ?? j.started_at);
      if (at >= ds && at < de) countJob(jobs, j);
    }
    // Its printer-days and recorded printer-days (Phase 0 metrics), counted per
    // shift: each part of a shift in this day counts its share of the whole
    // shift (eligible part / shift length), so a shift cut by midnight, or by
    // the edge of a period, still adds up to one scheduled day (D7). With one
    // part that is the whole day (24 hours), this is eligible / basis.
    let printerDays = 0, recordedPrinterDays = 0;
    if (span && basisMs > 0) for (const w of windows) {
      const part = windows.length === 1 ? ledger : accountPrinter({ segments: clip(intervals, [span]), start: span.start, end: span.end, windows: [w], basisMs: w.end - w.start });
      const m = metrics([{ ...part, basisMs: w.shiftEnd - w.shiftStart }]);
      printerDays += m.printerDays; recordedPrinterDays += m.recordedPrinterDays;
    }
    return { day, start: ds, end: de, complete, ...ledger, printerDays, recordedPrinterDays, jobs };
  });
}

module.exports = { dayRollups, jobEvidence, emptyJobs, countJob };

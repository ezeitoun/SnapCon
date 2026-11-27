// utilization/formulas.js — accounting and KPIs (Fleet utilization, Phase 0).
// Pure. Every millisecond of eligible time lands in exactly one bucket: a ledger
// that does not add up, or intervals that overlap, are errors and not numbers.
// Conservative by design: unknown and uncertain time is never Printing, so
// utilization can be understated, never overstated. The rules, the data
// categories and where they understate: docs/fleet-utilization.md.
"use strict";
const { BUCKETS, OPERATIONAL, PROVISIONAL, GAPS, PROVENANCE, bucketFor } = require("./classify");
const { clip } = require("./timeBuckets");

const sum = (o, keys) => keys.reduce((n, k) => n + (o[k] || 0), 0);
const zero = keys => Object.fromEntries(keys.map(k => [k, 0]));
const ratio = (a, b) => (b > 0 ? a / b : null);
const HOUR = 3600000;

class OverlapError extends Error {}

function checkIntervals(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) throw new Error(`invalid interval ${s.start}..${s.end}`);
    if (!PROVENANCE.includes(s.provenance)) throw new Error(`interval without valid provenance: ${s.provenance}`);
    if (i && s.start < sorted[i - 1].end) throw new OverlapError(`intervals overlap at ${s.start}`);
  }
  return sorted;
}

// One printer over one bucket of time. start..end: when it was eligible in the
// period (it existed, and was not excluded). windows: the basis time of the
// period, for farm hours; omitted, all of it. basisMs: the period's whole basis,
// whether the printer existed for it or not, which is what a printer-day is
// measured against.
function accountPrinter({ segments, start, end, windows, basisMs }) {
  const sorted = checkIntervals(segments);
  const eligibleWindows = clip([{ start, end }], windows || [{ start, end }]).map(w => ({ start: w.start, end: w.end }));
  const eligibleMs = eligibleWindows.reduce((n, w) => n + w.end - w.start, 0);
  const buckets = zero(BUCKETS);
  const provenance = Object.fromEntries(PROVENANCE.map(p => [p, zero(BUCKETS)]));
  // Time whose place in its interval is an estimate (spread history): already in
  // buckets, also counted here so it can be shown as estimated.
  const estimated = zero(BUCKETS);
  let covered = 0;
  for (const s of clip(sorted, eligibleWindows)) {
    const len = s.end - s.start;
    const bucket = bucketFor(s);
    const known = s.knownFraction == null ? len : Math.round(len * s.knownFraction);
    buckets[bucket] += known;
    provenance[s.provenance][bucket] += known;
    if (s.estimated) estimated[bucket] += known;
    if (known < len) {
      buckets.historicalUncertain += len - known;
      provenance[s.provenance].historicalUncertain += len - known;
      if (s.estimated) estimated.historicalUncertain += len - known;
    }
    covered += len;
  }
  buckets.notRecorded += eligibleMs - covered;
  const total = sum(buckets, BUCKETS);
  if (total !== eligibleMs) throw new Error(`ledger does not add up: ${total} of ${eligibleMs}`);
  return { eligibleMs, basisMs: basisMs == null ? eligibleMs : basisMs, buckets, provenance, estimated };
}

// Printers that count for the fleet, and when: from the first known job or the
// day first seen, until removed. Virtual printers only when asked for.
function eligibleSpan(printer, from, to, { includeVirtual = false } = {}) {
  if (printer.isVirtual && !includeVirtual) return null;
  const begin = Math.min(...[printer.firstSeen, printer.firstJobAt].filter(Number.isFinite));
  if (!Number.isFinite(begin)) return null;
  const start = Math.max(from, begin), end = Math.min(to, Number.isFinite(printer.removedAt) ? printer.removedAt : to);
  return end > start ? { start, end } : null;
}

// KPIs over ledgers (one per printer per bucket of time). Null means no figure can
// be given: there is no data, which is not zero.
function metrics(ledgers, jobs = []) {
  const t = zero(BUCKETS);
  let eligibleMs = 0, printerDays = 0, recordedPrinterDays = 0;
  const provenanceTotals = Object.fromEntries(PROVENANCE.map(p => [p, zero(BUCKETS)]));
  const est = zero(BUCKETS);
  for (const l of ledgers) {
    eligibleMs += l.eligibleMs;
    for (const b of BUCKETS) { t[b] += l.buckets[b]; est[b] += l.estimated[b]; for (const p of PROVENANCE) provenanceTotals[p][b] += l.provenance[p][b]; }
    if (l.basisMs > 0) {
      printerDays += l.eligibleMs / l.basisMs;
      // Paused and error are only known where SnapCon watched: never backfilled time.
      for (const p of ["observed", "inferred"]) recordedPrinterDays += (sum(l.provenance[p], OPERATIONAL) + sum(l.provenance[p], PROVISIONAL)) / l.basisMs;
    }
  }
  const provisionalMs = sum(t, PROVISIONAL), gapMs = sum(t, GAPS), recordedMs = eligibleMs - gapMs;
  const completed = jobs.filter(j => j.outcome === "completed").length;
  const failed = jobs.filter(j => j.outcome === "failed" || j.outcome === "cancelled").length;
  const unknownOutcome = jobs.filter(j => j.outcome === "unknown").length;
  const jobMs = t.printing + t.failed + provisionalMs;
  return {
    eligibleHours: eligibleMs / HOUR,
    recordedHours: recordedMs / HOUR,
    // Two different things, never one number:
    //   telemetry  how much of the eligible time has a reading of the printer
    //   outcomes   how much job time has a known ending (Printing or Failed), and
    //              how many ended jobs have one
    coverage: {
      telemetry: ratio(recordedMs, eligibleMs),
      outcomes: ratio(t.printing + t.failed, jobMs),
      jobsWithOutcome: ratio(completed + failed, completed + failed + unknownOutcome),
    },
    hours: Object.fromEntries(BUCKETS.map(b => [b, t[b] / HOUR])),
    // Confirmed Printing only. With nothing recorded there is no figure: 0% would
    // claim the printers sat idle when nobody knows.
    utilization: recordedMs > 0 ? ratio(t.printing, eligibleMs) : null,
    utilizationIfProvisionalSucceeds: recordedMs > 0 ? ratio(t.printing + provisionalMs, eligibleMs) : null,
    utilizationOfRecorded: ratio(t.printing, recordedMs),
    avgPrintHoursPerPrinterDay: recordedMs > 0 && printerDays > 0 ? (t.printing / HOUR) / printerDays : null,
    failureLoss: ratio(t.failed, t.printing + t.failed),
    pausedErrorHoursPerPrinterDay: recordedPrinterDays > 0 ? ((t.paused + t.error) / HOUR) / recordedPrinterDays : null,
    successRate: ratio(completed, completed + failed),
    jobs: { completed, failed, unknownOutcome },
    printerDays, recordedPrinterDays,
    inferredHours: sum(provenanceTotals.inferred, BUCKETS) / HOUR,
    backfilledHours: sum(provenanceTotals.backfilled, BUCKETS) / HOUR,
    estimatedHours: Object.fromEntries(BUCKETS.map(b => [b, est[b] / HOUR])),
  };
}

// A change against the previous period. No figure on either side: no delta. Partial
// coverage on either side is said, not hidden, and not turned into a threshold.
function delta(current, previous, { higherIsBetter, currentCoverage = null, previousCoverage = null }) {
  if (current == null || previous == null) return null;
  const change = current - previous;
  return {
    change,
    verdict: change === 0 ? "same" : (change > 0) === higherIsBetter ? "better" : "worse",
    partialCoverage: (currentCoverage != null && currentCoverage < 1) || (previousCoverage != null && previousCoverage < 1),
  };
}

// Low only on a figure: a printer with no data is not a low printer.
const isLow = (utilization, thresholdPct) => utilization != null && utilization * 100 < thresholdPct;

module.exports = { OverlapError, accountPrinter, eligibleSpan, metrics, delta, isLow };

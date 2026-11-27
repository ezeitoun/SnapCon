// utilization/classify.js — what a span of a printer's time counts as (Fleet
// utilization, Phase 0). Pure: no clock, no I/O, no connector imports.
//
// Six operational states, as defined: printing, failed, paused, error, idle,
// offline. Two things are deliberately NOT operational states, and never count
// as one:
//   provisional  job time whose outcome is not known: still running, or ended
//                without a known outcome. Never shown as confirmed Printing.
//   coverage gap time SnapCon has no reading for. Never shown as Offline or Idle.
"use strict";

const OPERATIONAL = Object.freeze(["printing", "failed", "paused", "error", "idle", "offline"]);
const PROVISIONAL = Object.freeze(["provisionalRunning", "provisionalUnknown"]);
const GAPS = Object.freeze(["unobserved", "historicalUncertain", "notRecorded"]);
const BUCKETS = Object.freeze([...OPERATIONAL, ...PROVISIONAL, ...GAPS]);
// The chart's stack, bottom to top. A running job sits on Printing as a lighter
// segment with its own legend entry; an unknown outcome has its own too.
const CHART_ORDER = Object.freeze(["printing", "provisionalRunning", "provisionalUnknown", "failed", "paused", "error", "idle", "offline", "unobserved", "historicalUncertain", "notRecorded"]);

// How an interval is known. Stored on every interval, reported separately.
//   observed   SnapCon saw it on the live connection
//   inferred   from the printer's own timestamps, while SnapCon could not see it
//   backfilled from the printer's job history, before tracking began
const PROVENANCE = Object.freeze(["observed", "inferred", "backfilled"]);
const KINDS = Object.freeze(["job", "paused", "error", "idle", "offline", "unobserved"]);
const OUTCOMES = Object.freeze(["running", "completed", "failed", "cancelled", "unknown"]);

// A connector's reported state -> the kind of interval it opens. Anything not
// listed is not a reading of the printer's state: it is unobserved, not a guess.
const STATE_KIND = Object.freeze({
  printing: "job", paused: "paused", error: "error", shutdown: "error",
  standby: "idle", idle: "idle", complete: "idle", cancelled: "idle", busy: "idle",
  updating: "offline", rebooting: "offline",
});

function classifyReading(reading) {
  if (!reading || reading.online !== true) return { kind: "offline", reason: "unreachable" };
  const kind = Object.prototype.hasOwnProperty.call(STATE_KIND, reading.state) ? STATE_KIND[reading.state] : null;
  if (!kind) return { kind: "unobserved", reason: "state-" + (reading.state == null ? "missing" : "unrecognized") };
  return { kind, reason: null };
}

// A job's Moonraker status -> outcome. Only an ending the printer reports as
// such is failed; an ending that says nothing about the job is unknown.
const MOONRAKER_OUTCOME = Object.freeze({
  completed: "completed", cancelled: "cancelled", error: "failed", klippy_shutdown: "failed",
  in_progress: "running", interrupted: "unknown", klippy_disconnect: "unknown", server_exit: "unknown",
});
const moonrakerOutcome = status => (Object.prototype.hasOwnProperty.call(MOONRAKER_OUTCOME, status) ? MOONRAKER_OUTCOME[status] : "unknown");

// The one place a kind and an outcome become a bucket. A pause or error inside a
// job stays Paused or Error whatever the job's outcome: only job time moves.
function bucketFor(segment) {
  switch (segment.kind) {
    case "paused": case "error": case "idle": case "offline": return segment.kind;
    case "unobserved": return "unobserved";
    case "job":
      switch (segment.outcome) {
        case "completed": return "printing";
        case "failed": case "cancelled": return "failed";
        case "running": return "provisionalRunning";
        case "unknown": return "provisionalUnknown";
        default: throw new Error(`job interval with invalid outcome: ${segment.outcome}`);
      }
    default: throw new Error(`invalid interval kind: ${segment.kind}`);
  }
}

// A past job from the printer's history. One policy, no thresholds:
//   - the span is the printer's own start_time..end_time;
//   - print_duration, the printer's own figure, is the part counted as the
//     outcome's state. Where it fell inside the span is not known, so it is spread
//     evenly: that spreading is an ESTIMATE, and the interval says so (estimated),
//     so whatever a day or a farm window gets from it is reported as estimated;
//   - the rest could be preparation or a pause, and history cannot say which: it
//     is historicalUncertain, never Printing or Paused.
// Raw durations are kept on the interval. Returns null when there is no span.
function backfilledJob(job) {
  const start = job.start_time * 1000, end = job.end_time * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const outcome = moonrakerOutcome(job.status);
  if (outcome === "running") return null;
  const span = end - start;
  const printMs = Number.isFinite(job.print_duration) && job.print_duration >= 0 ? job.print_duration * 1000 : null;
  return {
    start, end, kind: "job", outcome, provenance: "backfilled", estimated: true,
    knownFraction: printMs == null ? 0 : Math.min(1, printMs / span),
    raw: { status: job.status, jobId: job.job_id ?? null, totalDuration: job.total_duration ?? null, printDuration: job.print_duration ?? null },
  };
}

// A span SnapCon has no reading for, and why (owner decision, Phase 2 closeout):
//   unreachable   SnapCon was polling and the printer did not answer: Offline,
//                 observed, because the failed polls are the observation. Offline
//                 means unreachable from SnapCon, not that the printer was idle,
//                 and it is never overwritten: a job the printer's history shows
//                 in that time counts as a job (its outcome), not as time.
//   service-down  SnapCon itself was not running: nothing was observed, so the
//                 span gets NO interval and stays Not recorded, except the part
//                 the printer's own timestamps confirm as a job: job time,
//                 marked inferred and estimated, of which only `knownFraction`
//                 (the confirmed job's print_duration share, Phase 2) counts as
//                 its outcome's state; the rest is historically uncertain.
//                 Without a known share, all of it is uncertain.
// Progress is not an input on purpose: progress having advanced does not say
// when, or whether the job ran throughout.
const OUTAGE_CAUSES = Object.freeze(["unreachable", "service-down"]);
function splitOutage(outage, confirmedJob) {
  if (!OUTAGE_CAUSES.includes(outage.cause)) throw new Error(`outage without a known cause: ${outage.cause}`);
  const rest = (start, end) => (outage.cause === "unreachable" ? [{ start, end, kind: "offline", provenance: "observed", reason: "unreachable" }] : []);
  if (outage.cause === "unreachable") return rest(outage.start, outage.end);
  if (!confirmedJob || !Number.isFinite(confirmedJob.start) || !Number.isFinite(confirmedJob.end)) return rest(outage.start, outage.end);
  const a = Math.max(outage.start, confirmedJob.start), b = Math.min(outage.end, confirmedJob.end);
  if (b <= a) return rest(outage.start, outage.end);
  const out = [];
  if (a > outage.start) out.push(...rest(outage.start, a));
  const known = Number.isFinite(confirmedJob.knownFraction) ? Math.max(0, Math.min(1, confirmedJob.knownFraction)) : 0;
  out.push({ start: a, end: b, kind: "job", outcome: confirmedJob.outcome, provenance: "inferred", estimated: true, knownFraction: known, jobId: confirmedJob.jobId ?? null });
  if (b < outage.end) out.push(...rest(b, outage.end));
  return out;
}

module.exports = { OPERATIONAL, PROVISIONAL, GAPS, BUCKETS, CHART_ORDER, OUTAGE_CAUSES, PROVENANCE, KINDS, OUTCOMES, classifyReading, moonrakerOutcome, bucketFor, backfilledJob, splitOutage };

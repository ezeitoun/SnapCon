// utilization/reconcile.js — a printer's job history against what SnapCon
// recorded (fleet utilization, Phase 2). Runs inside one writer transaction
// (UtilizationStore applyBatch, op "history"); every query is indexed and the
// records per op are few (HistorySync), so the work per batch is bounded.
//
// Rules (owner-approved: Phase 0, Phase 2 and its closeout, 2026-11-03).
// Conservative on purpose: where the evidence does not settle something, it is
// left unknown or uncertain, so productive utilization can be UNDERSTATED, never
// overstated (docs/fleet-utilization.md).
//   - Observed telemetry is never overwritten. History never changes, splits or
//     replaces an observed interval (Idle, Offline, Error, unobserved or a job):
//     it may only add intervals where nothing was recorded (Not recorded time),
//     never later than the moment the record was queued.
//   - Offline means unreachable from SnapCon, not proof the printer was idle. A
//     job the printer's history shows during observed Offline (or unobserved)
//     time is recorded as a job, with its outcome, and no interval: the Offline
//     time stays Offline.
//   - A record is applied once: jobs carry the printer's own history id (job id
//     with start), unique per printer; a repeat, restart or replay is a no-op.
//   - Identity. A record belongs to an observed job when the file matches, the
//     job was first seen within the match window of the record's start, and not
//     after the record's end. Then:
//       * a running or unknown job is settled with what the printer reported
//         (an unknown from history settles nothing; never success by default);
//       * an outcome SnapCon saw that the record contradicts is corrected only
//         with evidence that the seen ending was a later job's (the printer's
//         next record began after this one ended and was over by SnapCon's
//         look). Without that evidence neither side is preferred: the job is
//         UNRESOLVED (outcome unknown, both answers kept), and resolved later
//         if a delayed page brings the evidence;
//       * the job's Not recorded stretches inside the record's span get job time
//         bounded by print_duration less the printing SnapCon saw, marked
//         estimated; the rest is historically uncertain.
//   - Two prints under one observed job (a reprint of the same file while
//     SnapCon was down, continued by file name): the job is seen still printing
//     after its record's end, or another record starts inside it. That job
//     becomes AMBIGUOUS: outcome unknown, for good (the tracker only ever ends
//     jobs still running, so a later ending cannot confirm it). A record inside
//     it is counted as its own job, without an interval.
//   - An unmatched record fills only Not recorded time, as backfilled intervals
//     marked estimated (print_duration's share, Phase 0 backfilledJob).
//   - A short job entirely within observed Idle (between two polls) is recorded
//     as a job without an interval. A record over observed Error, over another
//     observed job (other than the ambiguous case), over another record, or
//     claiming more than the poll window of observed Idle is a conflict:
//     skipped and counted.
"use strict";

const JOB_KINDS = new Set(["job", "paused"]);
const FINAL = new Set(["completed", "cancelled", "failed"]);

// Segments of `printerId` overlapping [a, b): the last one starting at or
// before `a`, and every one starting inside. Both through the (printer_id,
// start_at) index, so never a scan of the printer's history.
function overlapping(q, db, printerId, a, b, openEnd) {
  const out = [];
  const before = q(db, "SELECT * FROM segments WHERE printer_id = ? AND start_at <= ? ORDER BY start_at DESC LIMIT 1").get(printerId, a);
  if (before && (before.end_at == null ? openEnd : before.end_at) > a) out.push(before);
  for (const s of q(db, "SELECT * FROM segments WHERE printer_id = ? AND start_at > ? AND start_at < ? ORDER BY start_at").all(printerId, a, b)) out.push(s);
  return out.map(s => ({ ...s, end: s.end_at == null ? openEnd : s.end_at }));
}
// [a, b) less the segments: the uncovered pieces, in order.
function gaps(a, b, segs) {
  const out = [];
  let at = a;
  for (const s of segs) {
    if (s.start_at > at) out.push([at, Math.min(s.start_at, b)]);
    at = Math.max(at, s.end);
    if (at >= b) break;
  }
  if (at < b) out.push([at, b]);
  return out.filter(([x, y]) => y > x);
}
const overlapMs = (a, b, segs, pick) => segs.filter(pick).reduce((t, s) => t + Math.max(0, Math.min(b, s.end) - Math.max(a, s.start_at)), 0);
const clamp01 = x => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

function insertSegment(q, db, printerId, [a, b], { kind, jobId, provenance, reason, estimated = 0, knownFraction = null }) {
  q(db, "INSERT INTO segments (printer_id, kind, job_id, provenance, reason, start_at, end_at, estimated, known_fraction) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(printerId, kind, jobId, provenance, reason || null, a, b, estimated ? 1 : 0, knownFraction);
}

// op: { printerId, at, records: [normalized, with .next], cursorTo } (see history.js)
function reconcileHistory(q, db, op, { matchBeforeMs = 120e3, matchAfterMs = 180e3, endSlackMs = 5e3, toleranceMs = 60e3, shortMaxMs = 90e3, touch = () => {} } = {}) {
  const pid = op.printerId;
  // Never past the moment the op was queued: the tracker's later steps start there.
  const horizon = op.at;
  const n = { already: 0, matched: 0, settled: 0, corrected: 0, unresolved: 0, resolvedLater: 0, ambiguous: 0, filled: 0, backfilled: 0, short: 0, duringOffline: 0, conflicts: {}, skew: [] };
  const conflict = why => { n.conflicts[why] = (n.conflicts[why] || 0) + 1; };
  // For the reporting cache: the earliest moment this op changes (store.touch).
  const changed = t => touch(pid, t);
  const markAmbiguous = (jobId, why, startedAt) => {
    changed(startedAt);
    const r = q(db, "UPDATE jobs SET outcome = 'unknown', end_reason = ?, outcome_source = 'ambiguous' WHERE id = ? AND coalesce(outcome_source, '') <> 'ambiguous'").run("ambiguous: " + why, jobId);
    if (r.changes) n.ambiguous++;
  };
  // A record in [start, end] is the evidence an unresolved job's seen ending
  // was this later job's: its history ended before this record began, and the
  // ending SnapCon saw came after this record was over.
  const resolveWith = rec => {
    for (const u of q(db, "SELECT * FROM jobs WHERE printer_id = ? AND outcome_source = 'unresolved'").all(pid)) {
      if (rec.start >= u.history_end - toleranceMs && u.ended_at != null && rec.end <= u.ended_at + toleranceMs && u.history_end < u.ended_at) {
        q(db, "UPDATE jobs SET outcome = ?, ended_at = ?, end_reason = ?, outcome_source = 'history' WHERE id = ?")
          .run(u.history_outcome, u.history_end, `history:${u.history_status} (the ending seen was a later job's)`, u.id);
        changed(u.started_at);
        n.resolvedLater++;
      }
    }
  };

  for (const r of op.records) {
    if (q(db, "SELECT 1 FROM jobs WHERE printer_id = ? AND history_id = ?").get(pid, r.historyId)) { n.already++; continue; }
    const end = Math.min(r.end, horizon);
    if (!(end > r.start)) { conflict("ends-after-now"); continue; }
    resolveWith(r);
    const segs = overlapping(q, db, pid, r.start, end, horizon);

    // 1. A job SnapCon observed (identity: see the header). `endSlackMs` is
    // residual clock error only (skew is already applied): a wrong match is
    // worse than a missed one, which still becomes a short or backfilled job.
    const j = q(db, `SELECT * FROM jobs WHERE printer_id = ? AND history_id IS NULL AND source = 'observed'
      AND started_at BETWEEN ? AND ? AND (filename IS NULL OR ? IS NULL OR filename = ?)
      ORDER BY abs(started_at - ?) LIMIT 1`).get(pid, r.start - matchBeforeMs, Math.min(r.start + matchAfterMs, r.end + endSlackMs), r.filename, r.filename, r.start);
    if (j) {
      n.matched++;
      n.skew.push(j.started_at - r.start);
      q(db, "UPDATE jobs SET history_id = ?, history_outcome = ?, history_end = ?, history_status = ?, history_mode = 'matched' WHERE id = ?").run(r.historyId, r.outcome, r.end, r.status, j.id);
      changed(j.started_at);
      // Seen still printing well after the printer says this job ended: the
      // observed job holds a second print too. By job id (segments_job).
      if (q(db, "SELECT 1 FROM segments WHERE job_id = ? AND start_at > ? LIMIT 1").get(j.id, r.end + toleranceMs)) {
        markAmbiguous(j.id, "the same file printed again after the printer reported this job ended", j.started_at);
        conflict("ambiguous-reprint");
        continue;
      }
      if (j.outcome_source === "ambiguous") continue;
      if (j.outcome === "running" || j.outcome === "unknown") {
        if (FINAL.has(r.outcome) || j.outcome === "running") {
          q(db, "UPDATE jobs SET outcome = ?, ended_at = coalesce(ended_at, ?), end_reason = ?, outcome_source = 'history' WHERE id = ?")
            .run(r.outcome, r.end, "history:" + r.status, j.id);
          n.settled++;
        }
      } else if (r.outcome !== j.outcome) {
        const nx = r.next;
        if (nx && j.end_reason === "printer-reported" && j.ended_at != null && nx.start >= r.end - toleranceMs && nx.end <= j.ended_at + toleranceMs) {
          q(db, "UPDATE jobs SET outcome = ?, ended_at = ?, end_reason = ?, outcome_source = 'history' WHERE id = ?")
            .run(r.outcome, r.end, `history:${r.status} (the ending seen was a later job's)`, j.id);
          n.corrected++;
        } else {
          q(db, "UPDATE jobs SET outcome = 'unknown', end_reason = ?, outcome_source = 'unresolved' WHERE id = ?")
            .run(`unresolved: SnapCon saw ${j.outcome}, the printer's history says ${r.status}`, j.id);
          n.unresolved++;
          conflict("outcome-disagrees");
        }
      }
      // Its Not recorded stretches inside the record's span: print_duration less
      // the printing SnapCon saw, spread over them, estimated; the rest uncertain.
      const pieces = gaps(Math.max(r.start, j.started_at), end, segs);
      if (pieces.length) {
        const seen = q(db, "SELECT start_at, end_at FROM segments WHERE job_id = ? AND kind = 'job' AND provenance = 'observed'").all(j.id)
          .reduce((t, s) => t + Math.max(0, Math.min(r.end, s.end_at == null ? horizon : s.end_at) - Math.max(r.start, s.start_at)), 0);
        const gapMs = pieces.reduce((t, [a, b]) => t + b - a, 0);
        const share = r.printMs == null ? 0 : clamp01((r.printMs - seen) / gapMs);
        for (const g of pieces) { insertSegment(q, db, pid, g, { kind: "job", jobId: j.id, provenance: "inferred", reason: "history", estimated: 1, knownFraction: share }); n.filled++; }
      }
      continue;
    }

    // 2. Not matched to an observed job: what did SnapCon see in that time?
    // mode: how it was recovered (merged | short | offline | backfill), for reporting.
    const insertJob = mode => { changed(r.start); return Number(q(db, `INSERT INTO jobs (printer_id, source, filename, started_at, ended_at, outcome, end_reason, job_key, history_id, outcome_source, history_outcome, history_end, history_status, history_mode)
      VALUES (?, 'backfilled', ?, ?, ?, ?, ?, ?, ?, 'history', ?, ?, ?, ?)`).run(pid, r.filename, r.start, r.end, r.outcome, "history:" + r.status, `${pid}:h:${r.historyId}`, r.historyId, r.outcome, r.end, r.status, mode).lastInsertRowid); };

    // Inside an observed job that began well before it: one job for two prints.
    const onObservedJob = segs.filter(s => JOB_KINDS.has(s.kind) && s.provenance === "observed");
    if (overlapMs(r.start, end, onObservedJob, () => true) > toleranceMs) {
      // Only the same file: a different file inside an observed job is a
      // contradiction (skew, a wrong printer), not a second print of it.
      const hosts = [...new Set(onObservedJob.map(s => s.job_id))].map(id => q(db, "SELECT id, started_at, filename FROM jobs WHERE id = ?").get(id)).filter(Boolean);
      if (hosts.length && hosts.every(h => r.start > h.started_at + toleranceMs && (h.filename == null || r.filename == null || h.filename === r.filename))) {
        for (const h of hosts) markAmbiguous(h.id, "another print ran inside it, by the printer's history", h.started_at);
        conflict("ambiguous-merged-job");
        insertJob("merged");               // counted as its own job; its time stays where SnapCon saw it
        continue;
      }
      conflict("overlaps-another-job");
      continue;
    }
    if (overlapMs(r.start, end, segs, s => JOB_KINDS.has(s.kind)) > toleranceMs) { conflict("overlaps-another-record"); continue; }
    // Observed Error contradicts a job: only residual clock error is tolerated.
    if (overlapMs(r.start, end, segs, s => s.kind === "error") > endSlackMs) { conflict("contradicts-observed-error"); continue; }
    const seenIdle = overlapMs(r.start, end, segs, s => s.kind === "idle");
    const unseen = overlapMs(r.start, end, segs, s => s.kind === "offline" || s.kind === "unobserved");
    const span = end - r.start;
    const pieces = gaps(r.start, end, segs);
    const uncovered = pieces.reduce((t, [a, b]) => t + b - a, 0);
    if (seenIdle > toleranceMs) {
      if (!(span <= shortMaxMs && uncovered <= toleranceMs)) { conflict("contradicts-observed"); continue; }
      insertJob("short"); n.short++; continue;                                // between two Idle readings
    }
    if (uncovered === 0) { insertJob(unseen > 0 ? "offline" : "short"); if (unseen > 0) n.duringOffline++; else n.short++; continue; }
    const jobId = insertJob("backfill");
    for (const g of pieces) insertSegment(q, db, pid, g, { kind: "job", jobId, provenance: "backfilled", reason: "history", estimated: 1, knownFraction: r.knownFraction });
    if (unseen > 0) n.duringOffline++;
    n.backfilled++;
  }

  // What this pass learnt, kept with the printer (survives restarts).
  const cur = q(db, "SELECT * FROM history_sync WHERE printer_id = ?").get(pid);
  const counters = cur ? JSON.parse(cur.counters || "{}") : {};
  for (const k of ["already", "matched", "settled", "corrected", "unresolved", "resolvedLater", "ambiguous", "filled", "backfilled", "short", "duringOffline"]) counters[k] = (counters[k] || 0) + n[k];
  counters.conflicts = counters.conflicts || {};
  for (const [k, v] of Object.entries(n.conflicts)) counters.conflicts[k] = (counters.conflicts[k] || 0) + v;
  const samples = (cur ? JSON.parse(cur.skew_samples || "[]") : []).concat(n.skew).slice(-9);
  const cursor = Number.isFinite(op.cursorTo) ? Math.max(op.cursorTo, cur && Number.isFinite(cur.cursor_s) ? cur.cursor_s : -Infinity) : (cur ? cur.cursor_s : null);
  q(db, `INSERT INTO history_sync (printer_id, cursor_s, skew_samples, last_ok_at, counters) VALUES (?,?,?,?,?)
    ON CONFLICT(printer_id) DO UPDATE SET cursor_s = excluded.cursor_s, skew_samples = excluded.skew_samples, last_ok_at = excluded.last_ok_at, counters = excluded.counters`)
    .run(pid, Number.isFinite(cursor) ? cursor : null, JSON.stringify(samples), op.at, JSON.stringify(counters));
  return n;
}

module.exports = { reconcileHistory, gaps };

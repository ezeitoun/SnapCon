// utilization/Tracker.js — turns readings of printers into intervals (Fleet
// utilization). Fed by the fleet's own poll (notifyTick); never asks a printer
// anything itself, never sends anything to one.
//
// Phase 1.1: deciding happens here, in memory, with no database reads; the
// steps are queued for the Writer, which saves them off the poll. The only
// database reads are at start (what was open, what was running).
//
// Rules (Phase 0, owner-approved):
//   - an interval opens only when what is counted changes; the same reading
//     again queues nothing;
//   - a printer that stops answering is Offline only after `offlineAfter`
//     unanswered readings in a row, dated back to the first, so one lost reply
//     is not an outage;
//   - online with a state SnapCon cannot read is unobserved, never Offline or Idle;
//   - when SnapCon was not running, or could not save, there is no reading: the
//     open intervals end at the last committed checkpoint, and the time after has
//     no interval, so it stays Not recorded;
//   - a job's outcome comes only from what the printer said when it ended:
//     complete, cancelled, error. Going back to standby without one, or a
//     different file appearing, ends it as unknown.
"use strict";
const { classifyReading } = require("./classify");

const OUTCOME_OF_STATE = { complete: "completed", cancelled: "cancelled", error: "failed", shutdown: "failed" };
const JOB_KINDS = new Set(["job", "paused"]);
const JOB_CONTINUES = new Set(["job", "paused", "offline", "unobserved"]);
const fresh = () => ({ kind: null, reason: null, jobKey: null, filename: null, lastAt: -Infinity, misses: 0, firstMissAt: null, open: false, openStart: null });

function createTracker({ store, writer, log = console, offlineAfter = 2, heartbeatEveryMs = 30000, retentionMs = 400 * 86400000, onJobEnd = () => {} }) {
  const mem = new Map();          // printer id -> what was last queued for it
  const known = new Map();        // printer id -> "name|connector|virtual", last queued
  const removed = new Set();      // printer ids marked removed
  let started = false, lastHeartbeat = 0, lastPrune = 0, reload = false;

  // After a start: whatever was open ends at the last committed checkpoint. Jobs
  // stay running until the printer shows whether the same one is still going.
  function start(at) {
    if (!store.isAvailable()) return null;
    const s = store.loadState();
    const cp = s.checkpoint;
    store.applyBatch(`start-${at}`, [...(s.open.length ? [{ type: "closeAll", at: cp ?? 0 }] : []), { type: "checkpoint", at }]);
    writer.setCommitted(at);
    fromState(s);
    lastHeartbeat = at; started = true;
    return { closedAt: cp };
  }
  // Memory as the database has it: nothing open, the running jobs, the printers.
  function fromState(s) {
    mem.clear(); known.clear(); removed.clear();
    for (const p of s.printers) { if (p.removedAt != null) removed.add(p.id); known.set(p.id, [p.name, p.connector, p.isVirtual ? 1 : 0].join("|")); }
    for (const j of s.runningJobs) mem.set(j.printerId, { ...fresh(), jobKey: j.jobKey, filename: j.filename });
  }
  // The writer dropped what was waiting (overflow, a refused step). Memory may
  // name jobs that were never saved, so it is rebuilt from the database at the
  // start of the next poll (indexed reads of what is open and running only).
  // Printers are queued again, which is harmless if they were saved. Until
  // then readings are ignored, so nothing builds on memory that may be wrong.
  function resync() { reload = true; }

  // Once per poll, before the readings. `configured` is every printer in
  // config.json; `active` those polled (hidden virtual ones are not).
  function beginTick(configured, active, at, { isVirtual = () => false } = {}) {
    if (!started) return;
    if (reload) {
      // Busy or failing: try again at the next poll; readings wait until then.
      let s; try { s = store.loadState(); } catch { return; }
      reload = false; fromState(s); known.clear(); lastHeartbeat = 0;
    }
    if (at - lastHeartbeat >= heartbeatEveryMs) { writer.enqueue({ type: "checkpoint", at }); lastHeartbeat = at; }
    const activeIds = new Set(active.map(p => p && p.id));
    const present = new Set();
    for (const p of configured) {
      if (!p || !p.id) continue;
      present.add(p.id);
      const sig = [p.name, p.connector, isVirtual(p.connector) ? 1 : 0].join("|");
      if (known.get(p.id) !== sig || removed.has(p.id)) {
        writer.enqueue({ type: "printer", id: p.id, name: p.name, connector: p.connector, isVirtual: isVirtual(p.connector), at });
        known.set(p.id, sig); removed.delete(p.id);
      }
      if (!activeIds.has(p.id)) stopWatching(p.id, at, "not-polled");
    }
    for (const id of known.keys()) {
      if (!present.has(id) && !removed.has(id)) { stopWatching(id, at, "removed"); writer.enqueue({ type: "removed", id, at }); removed.add(id); mem.delete(id); }
    }
    if (at - lastPrune >= 86400000) { writer.schedulePrune(at - retentionMs); lastPrune = at; }
  }
  function stopWatching(id, at, why) {
    const m = mem.get(id);
    if (!m || (!m.open && m.jobKey == null)) return;
    writer.enqueue({ type: "step", printerId: id, at: Math.max(at, m.openStart ?? at), endJob: m.jobKey != null ? { key: m.jobKey, outcome: "unknown", reason: why, at: m.open ? at : null } : null });
    mem.set(id, { ...fresh(), lastAt: at });
  }

  function observe(p, reading, at) {
    if (!started || reload || !p || !p.id) return;   // after a resync: nothing until reloaded
    let m = mem.get(p.id);
    if (!m) { m = fresh(); mem.set(p.id, m); }
    if (!(at >= m.lastAt)) return;               // older than what was already counted
    const c = classifyReading(reading);
    let stepAt = at;
    if (c.kind === "offline" && c.reason === "unreachable") {
      if (m.misses === 0) m.firstMissAt = at;
      m.misses++;
      m.lastAt = at;
      if (m.misses < offlineAfter) return;
      stepAt = Math.max(m.firstMissAt, m.openStart ?? -Infinity);
    } else { m.misses = 0; m.firstMissAt = null; }

    const filename = reading && reading.filename ? String(reading.filename) : null;
    let endJob = null, startJob = null, jobKey = m.jobKey;
    if (JOB_KINDS.has(c.kind)) {
      const same = m.jobKey != null && (m.kind == null || JOB_CONTINUES.has(m.kind)) && (!filename || !m.filename || filename === m.filename);
      if (!same) {
        if (m.jobKey != null) endJob = { key: m.jobKey, outcome: "unknown", reason: "another-job", at: m.open ? stepAt : null };
        jobKey = `${p.id}:${stepAt}`;
        startJob = { key: jobKey, filename };
      }
    } else if (m.jobKey != null && !JOB_CONTINUES.has(c.kind)) {
      const outcome = OUTCOME_OF_STATE[reading && reading.state] || "unknown";
      // Seen ending: now. Found already ended after SnapCon was not watching:
      // when is not known, so no end time is made up.
      endJob = { key: m.jobKey, outcome, reason: outcome === "unknown" ? "ended-without-outcome" : "printer-reported", at: m.open ? stepAt : null };
      jobKey = null;
    }
    const changed = !m.open || c.kind !== m.kind || (c.reason || null) !== (m.reason || null) || endJob || startJob;
    if (!changed) { m.lastAt = at; return; }
    writer.enqueue({ type: "step", printerId: p.id, at: stepAt, endJob, startJob, next: { kind: c.kind, reason: c.reason, jobKey: JOB_KINDS.has(c.kind) ? jobKey : null } });
    if (endJob) { try { onJobEnd(p.id); } catch {} }
    if (startJob) { m.jobKey = jobKey; m.filename = filename; }
    else if (endJob) { m.jobKey = null; m.filename = null; }
    else if (filename && JOB_KINDS.has(c.kind)) m.filename = m.filename || filename;
    m.kind = c.kind; m.reason = c.reason || null; m.open = true; m.openStart = stepAt; m.lastAt = at;
  }

  // A clean shutdown: every interval ends now, saved within the deadline. Jobs
  // stay running: the printer is still printing after SnapCon stops.
  // Queues the closing of every interval at `at` (the async shutdown then drains it).
  function stopEnqueue(at) {
    if (!started) return false;
    writer.enqueue({ type: "closeAll", at });
    writer.enqueue({ type: "checkpoint", at });
    for (const m of mem.values()) m.open = false;
    started = false;
    return true;
  }
  function stop(at, deadlineMs) {
    if (!stopEnqueue(at)) return { left: 0 };
    return writer.drainSync(deadlineMs);
  }

  // What the printer is doing as last counted: "job", "paused", "idle", "offline"... or null.
  const kindOf = id => { const m = mem.get(id); return m && m.open ? m.kind : null; };

  return { start, beginTick, observe, stop, stopEnqueue, resync, kindOf };
}

module.exports = { createTracker };

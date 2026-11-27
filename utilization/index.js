// utilization/index.js — the only module server.js uses for fleet utilization
// (recording only so far). Every call is safe to make from the fleet poll: it
// cannot throw. Readings are decided in memory during the poll; saving happens
// after it (endTick), in bounded turns. WAL checkpoints and the nightly
// backup run on a worker thread (Checkpointer.js).
"use strict";
const { createUtilizationStore } = require("./UtilizationStore");
const { createTracker } = require("./Tracker");
const { createWriter } = require("./Writer");
const { createCheckpointer } = require("./Checkpointer");
const { createHistorySync, historyMode } = require("./HistorySync");
const { createReporting } = require("./Reporting");
const { registerUtilizationRoutes } = require("./routes");
const { performance } = require("perf_hooks");

function createUtilization({ baseDir, isVirtual = () => false, log = console, now = Date.now, writerOptions = {}, checkpointerOptions = {}, historyOptions = {}, historyFor = () => null, historySetting = () => undefined, reportingOptions = {}, onBackupFailed, ...opts }) {
  // Phase 3: reports read the store; the store says what each commit changed,
  // and only those cached report days are dropped.
  let reporting = null;
  const store = createUtilizationStore({ baseDir, log, now, onTouched: changed => reporting && reporting.invalidate(changed), ...opts });
  // Whether printer history is read (off unless configured) is in every report.
  reporting = createReporting({ store, now, historyReading: () => historyMode(historySetting()), ...reportingOptions });
  let tracker = null, writer = null;
  const checkpointer = createCheckpointer({ store, log, now, onBackupFailed,
    onRelease: () => writer && writer.kick(), onStop: why => writer && writer.halt(why), ...checkpointerOptions });
  writer = createWriter({ store, log, clock: now, onResync: () => tracker && tracker.resync(),
    onCommit: () => checkpointer.noteCommit(), onIdle: () => checkpointer.noteIdle(), gate: () => checkpointer.gate(), ...writerOptions });
  let history = null;
  tracker = createTracker({ store, writer, log, onJobEnd: id => history && history.markDue(id) });
  // Phase 2: job history, read-only, through the connector (historyFor(p) is
  // its fetchJobHistory bound to p, or null for a printer without one).
  // Off unless config.json utilization.readPrinterHistory turns it on (historySetting).
  history = createHistorySync({ store, writer, historyFor, kindOf: id => tracker.kindOf(id), now, log, setting: historySetting, ...historyOptions });
  let failed = null;
  const safe = (fn, fallback) => (...a) => {
    if (failed) return fallback;
    try { return fn(...a); } catch (e) { failed = e.message; try { log.error("[utilization] stopped recording (" + e.message + "); printing is not affected."); } catch {} return fallback; }
  };
  return {
    // Order: open (migration and any quarantine happen here), resume, and only
    // then the checkpoint worker, which never sees a database being replaced.
    // Zone data is initialised here, at SnapCon's start (~16-20 ms once, ICU),
    // not in the first report request.
    start: safe(() => { store.open(); const r = tracker.start(now()); checkpointer.start(); try { require("./timeBuckets").warmTimeZones(); } catch {} return r; }),
    beginTick: safe((configured, active) => { tracker.beginTick(configured || [], active || [], now(), { isVirtual }); history.tick(active || [], now()); }),
    observe: safe((p, reading) => tracker.observe(p, reading, now())),
    endTick: safe(() => writer.pollTick()),
    // Shutdown: asynchronous, bounded by `budgetMs` in all, never blocking the
    // event loop. 1. What is queued is saved in ordinary bounded turns (at most
    // `drainMs`); what is left is not recorded. 2. The main connection closes
    // first: with the worker's connection still open SQLite does no checkpoint
    // here (if the worker is not running, the connection is left open for the
    // process exit instead, so the WAL is never folded on this thread). 3. The
    // worker closes its connection, the last, folding the WAL on its thread,
    // within what is left of the budget, or is terminated.
    stop: async (budgetMs = 1000, drainMs = 500) => {
      const t0 = performance.now();
      const r = { left: null, closeMs: null, mainClosed: false, worker: null };
      try { history.stop(); } catch {}
      try {
        if (!failed && tracker.stopEnqueue(now())) Object.assign(r, await writer.drain(t0 + Math.min(drainMs, budgetMs)));
      } catch (e) { try { log.error("[utilization] stop: " + e.message); } catch {} }
      try {
        const c0 = performance.now();
        if (checkpointer.workerRunning() || !store.isAvailable()) { store.close(); r.mainClosed = true; } else store.abandon();
        r.closeMs = performance.now() - c0;
      } catch {}
      try { r.worker = await checkpointer.stop(Math.max(0, budgetMs - (performance.now() - t0))); } catch {}
      return r;
    },
    status: () => ({ recording: !failed && store.isAvailable() && writer.status().mode !== "stopped", failed, writer: writer.status(), checkpoints: checkpointer.status(), history: history.status(), store: store.status() }),
    isAvailable: () => store.isAvailable(),
    // Started on the worker; it logs its own result and reports a failure
    // through onBackupFailed. Returns null, so server.js logs nothing twice.
    backup: o => { try { checkpointer.backup(o); } catch {} return null; },
    listBackups: () => store.listBackups(),
    // The reporting API (read only): see routes.js.
    registerRoutes: (app, deps) => registerUtilizationRoutes(app, { reporting, store, isAvailable: () => store.isAvailable(), now, ...deps }),
    reporting,
    // Test-only: faults injected into the checkpoint worker (needs checkpointerOptions.faults).
    _checkpointerFault: payload => checkpointer._fault(payload),
  };
}

module.exports = { createUtilization };

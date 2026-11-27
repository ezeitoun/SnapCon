// Shared by the utilization tests: a real store in a temporary folder, a clock
// the test moves, a writer whose turns and retry timers the test runs by hand.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createUtilizationStore } = require("../../utilization/UtilizationStore");
const { createTracker } = require("../../utilization/Tracker");
const { createWriter } = require("../../utilization/Writer");
const { accountPrinter } = require("../../utilization/formulas");

const quiet = { log() {}, warn() {}, error() {} };
function tmpBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-util-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
// store + writer + tracker on `base`, sharing `clock`.
function build(t, { base, clock, log = quiet, storeOpts = {}, writerOpts = {} }) {
  const store = createUtilizationStore({ baseDir: base, log, now: () => clock.t, ...storeOpts }).open();
  t.after(() => store.close());
  const turns = [], timers = [];
  let tracker = null;
  const writer = createWriter({ store, log, clock: () => clock.t, schedule: fn => turns.push(fn), timer: (fn, ms) => timers.push({ fn, ms }), onResync: () => tracker && tracker.resync(), ...writerOpts });
  tracker = createTracker({ store, writer, log });
  // Every turn the writer asks for, as the event loop would run them.
  const flush = () => { writer.kick(); let n = 0; while (turns.length) { turns.shift()(); if (++n > 1e5) throw new Error("writer never settles"); } };
  // Retry timers due: fire them all.
  const fireTimers = () => { const due = timers.splice(0); for (const x of due) x.fn(); return due.map(x => x.ms); };
  return { base, clock, store, writer, tracker, flush, fireTimers, turns, timers, log };
}
function rig(t, { base = tmpBase(t), ...o } = {}) {
  const clock = { t: T0 };
  const r = build(t, { base, clock, ...o });
  r.tracker.start(clock.t);
  r.P = (id, name = id, connector = "snapmaker-u1-klipper-ws") => ({ id, name, connector });
  // A new SnapCon process on the same files: the old one's store is closed first.
  r.restart = (o2 = {}) => { r.store.close(); const n = build(t, { base, clock, ...o2 }); n.tracker.start(clock.t); n.P = r.P; n.restart = r.restart; return n; };
  return r;
}
// Every stored interval through the Phase 0 ledger, which refuses overlaps.
function ledgerOf(store, id, from, to) {
  const jobs = store.jobs(id);
  return accountPrinter({ start: from, end: to, segments: store.segments(id).filter(x => x.end != null || x.start < to).map(x => ({ ...x, end: x.end ?? to, outcome: x.kind === "job" ? (jobs.find(j => j.id === x.jobId) || {}).outcome : undefined })) });
}
const T0 = 1_800_000_000_000;
const S = 1000, MIN = 60 * S, H = 60 * MIN;
const on = (state, filename) => ({ online: true, state, filename });
const OFF = { online: false };
const sqliteError = (errcode, message) => Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode });
module.exports = { quiet, tmpBase, build, rig, ledgerOf, sqliteError, T0, S, MIN, H, on, OFF };

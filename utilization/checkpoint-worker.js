// utilization/checkpoint-worker.js — the utilization database's checkpoints and
// nightly backups, on their own thread and their own connection (Phase 1.2).
//
// SQLite's WAL checkpoint copies pages back and syncs the disk: on this disk
// ~65–70 ms each time, which on the main thread stalls every printer's
// monitoring. Here it stalls nothing. PASSIVE never waits for a lock and
// never blocks the main connection's writes; it may stop short, which the
// supervisor (Checkpointer.js) sees and retries.
//
// The main thread opens, migrates and, if needed, quarantines the database
// before this thread is started; this thread never does any of those.
// Listed in package.json -> pkg.scripts, like the other workers.
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { runBackup } = require("../library/LibraryStore");

const { dbPath, backupsDir, busyTimeoutMs = 1000, faults = false } = workerData;
let db = null;
// Test-only: faults the tests inject (never set in production).
const fault = { busy: 0, throwCode: 0, backupFail: 0, hangMs: 0 };

function open() {
  if (!db) { db = new DatabaseSync(dbPath); db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`); }
  return db;
}
function hang() { if (fault.hangMs) { const end = Date.now() + fault.hangMs; while (Date.now() < end); } }

function handle(cmd, payload = {}) {
  if (cmd === "checkpoint") {
    hang();
    if (fault.throwCode) { const c = fault.throwCode; fault.throwCode = 0; throw Object.assign(new Error("injected SQLite error " + c), { errcode: c }); }
    const t0 = performance.now();
    const r = open().prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    const ms = performance.now() - t0;
    if (fault.busy > 0) { fault.busy--; return { busy: 1, log: r.log, checkpointed: -1, ms }; }
    return { busy: r.busy, log: r.log, checkpointed: r.checkpointed, ms };
  }
  if (cmd === "backup") {
    hang();
    if (fault.backupFail > 0) { fault.backupFail--; throw new Error("injected backup failure"); }
    return runBackup({ DatabaseSync, dbPath, backupsDir, reason: payload.reason || "nightly", now: () => payload.now || Date.now(), prefix: "utilization" });
  }
  if (cmd === "fault" && faults) {
    if (payload.crash) process.exit(3);
    Object.assign(fault, payload);
    return true;
  }
  throw new Error("unknown command " + cmd);
}

// At shutdown the main connection has closed first, so this is the last one:
// closing it folds the WAL back into the database, here, off the main thread.
function close() {
  try { if (db) db.close(); } catch {}
  db = null;
}

parentPort.on("message", ({ id, cmd, payload }) => {
  if (cmd === "close") { close(); parentPort.postMessage({ id, ok: true, result: true }); return; }
  try { parentPort.postMessage({ id, ok: true, result: handle(cmd, payload) }); }
  catch (e) { parentPort.postMessage({ id, ok: false, error: { message: e.message, errcode: e.errcode, code: e.code } }); }
});

try { open(); parentPort.postMessage({ ready: true }); }
catch (e) { parentPort.postMessage({ ready: false, error: { message: e.message, errcode: e.errcode } }); close(); }

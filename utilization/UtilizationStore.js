// utilization/UtilizationStore.js — the utilization database (Fleet utilization,
// Phase 1): utilization-data/utilization.db, node:sqlite like the audit and
// sync stores, so no native addon reaches the pkg build. Unavailable (old Node,
// unwritable folder, newer schema) means every write is refused and the rest of
// SnapCon carries on.
//
// What it holds: intervals of one printer's time (segments), the jobs those
// intervals belong to, the printers ever seen, and the checkpoint: the time up
// to which everything observed has been committed. Enforced by the database,
// not just the code: a printer has at most one open interval and one interval
// per start time, and an interval never starts before its predecessor ended.
//
// Writes come in batches (applyBatch), each one transaction with an id. A batch
// whose commit was reported as failed may still have been committed; it is
// recorded in applied_batches in the same transaction, so sending it again is
// a no-op rather than a duplicate.
//
// Durability: WAL with synchronous=NORMAL. A crash of SnapCon loses nothing
// committed. A power cut or OS crash can lose the last commits; the checkpoint
// is lost with them, so that time reads as Not recorded on the next start, and
// is never filled in.
"use strict";
const fs = require("fs");
const path = require("path");
const { runBackup, listBackups } = require("../library/LibraryStore");
const { KINDS, PROVENANCE } = require("./classify");
const { reconcileHistory } = require("./reconcile");

const SCHEMA_VERSION = 3;
const JOURNAL_SIZE_LIMIT = 4 << 20;
const ABANDONED = [];
const SCHEMA_SQL = `
CREATE TABLE printers (
  id TEXT PRIMARY KEY,                 -- SnapCon's printer id: stable across renames and address changes
  name TEXT NOT NULL, connector TEXT, is_virtual INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL, removed_at INTEGER);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY, printer_id TEXT NOT NULL REFERENCES printers(id),
  source TEXT NOT NULL CHECK (source IN ('observed','inferred','backfilled')),
  filename TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'running' CHECK (outcome IN ('running','completed','failed','cancelled','unknown')),
  end_reason TEXT);
CREATE INDEX jobs_printer ON jobs(printer_id, started_at);
CREATE TABLE segments (
  id INTEGER PRIMARY KEY, printer_id TEXT NOT NULL REFERENCES printers(id),
  kind TEXT NOT NULL CHECK (kind IN ('job','paused','error','idle','offline','unobserved')),
  job_id INTEGER REFERENCES jobs(id),
  provenance TEXT NOT NULL CHECK (provenance IN ('observed','inferred','backfilled')),
  reason TEXT, start_at INTEGER NOT NULL, end_at INTEGER,
  CHECK (end_at IS NULL OR end_at > start_at));
CREATE INDEX segments_printer ON segments(printer_id, start_at);
CREATE UNIQUE INDEX segments_one_open ON segments(printer_id) WHERE end_at IS NULL;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
// Version 2 (Phase 1.1): what keeps the per-step and prune queries off whole-
// history scans, a key per job the writer can name before the row exists, one
// interval per printer per start time, and the record of committed batches.
const V2_SQL = `
ALTER TABLE jobs ADD COLUMN job_key TEXT;
UPDATE jobs SET job_key = printer_id || ':' || started_at || ':' || id WHERE job_key IS NULL;
CREATE UNIQUE INDEX jobs_key ON jobs(job_key);
CREATE INDEX jobs_closed ON jobs(coalesce(ended_at, started_at)) WHERE outcome <> 'running';
CREATE INDEX segments_printer_end ON segments(printer_id, end_at);
CREATE INDEX segments_job ON segments(job_id);
CREATE INDEX segments_closed ON segments(end_at) WHERE end_at IS NOT NULL;
CREATE UNIQUE INDEX segments_printer_start ON segments(printer_id, start_at);
CREATE INDEX jobs_running ON jobs(printer_id) WHERE outcome = 'running';
CREATE TABLE applied_batches (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE INDEX applied_batches_at ON applied_batches(at);
`;
// version -> function(db), each in its own transaction after a pre-migration
// backup. A new database gets version 1 and every migration, in one go.
// Version 3 (Phase 2): the printer's own job-history id on jobs (unique per
// printer: a history record is applied once), what that record said (kept for
// an outcome left unresolved), where an outcome came from (observed, history,
// unresolved, ambiguous),
// estimated intervals with their known share (Phase 0 backfilledJob), and per
// printer what history reconciliation has done so far.
const V3_SQL = `
ALTER TABLE jobs ADD COLUMN history_id TEXT;
ALTER TABLE jobs ADD COLUMN outcome_source TEXT;
ALTER TABLE jobs ADD COLUMN history_outcome TEXT;
ALTER TABLE jobs ADD COLUMN history_end INTEGER;
ALTER TABLE jobs ADD COLUMN history_status TEXT;
ALTER TABLE jobs ADD COLUMN history_mode TEXT;
CREATE UNIQUE INDEX jobs_history ON jobs(printer_id, history_id) WHERE history_id IS NOT NULL;
CREATE INDEX jobs_unresolved ON jobs(printer_id) WHERE outcome_source = 'unresolved';
ALTER TABLE segments ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE segments ADD COLUMN known_fraction REAL;
CREATE TABLE history_sync (
  printer_id TEXT PRIMARY KEY REFERENCES printers(id),
  cursor_s REAL,
  skew_samples TEXT NOT NULL DEFAULT '[]',
  last_ok_at INTEGER,
  counters TEXT NOT NULL DEFAULT '{}');
`;
const MIGRATIONS = { 2: db => db.exec(V2_SQL), 3: db => db.exec(V3_SQL) };

const stamp = t => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
function loadSqlite() { try { return require("node:sqlite").DatabaseSync; } catch { return null; } }

function createUtilizationStore({ baseDir, now = Date.now, log = console, sqlite = loadSqlite(), schemaVersion = SCHEMA_VERSION, schemaSql = SCHEMA_SQL, migrations = MIGRATIONS, busyTimeoutMs = 200, journalSizeLimit = JOURNAL_SIZE_LIMIT, historyOptions = {}, hooks = {}, onTouched = null }) {
  let lastHistory = null;            // what the last history op did (tests, status)
  const dir = path.join(baseDir, "utilization-data");
  const dbPath = path.join(dir, "utilization.db");
  const backupsDir = path.join(dir, "backups");
  const state = { available: false, reason: null, recovery: null, db: null };
  const unavailable = reason => { state.available = false; state.reason = reason; log.warn("[utilization] unavailable: " + reason); };

  function probe(file) {
    const db = new sqlite(file);
    try {
      db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
      db.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
      const check = db.prepare("PRAGMA quick_check").all().map(r => Object.values(r)[0]);
      if (!(check.length === 1 && check[0] === "ok")) throw Object.assign(new Error("integrity check failed"), { corrupt: true });
      return db;
    } catch (e) { try { db.close(); } catch {} throw e; }
  }
  // Only a file SQLite says is damaged (CORRUPT, NOTADB, or a failed integrity
  // check) is moved aside. A lock held by another process, a permission
  // problem or no file descriptors say nothing about the file: it stays
  // exactly where it is, and nothing is recorded until the next start.
  const isDamaged = e => !!(e && (e.corrupt || (Number.isInteger(e.errcode) && [11, 26].includes(e.errcode & 0xff))));
  // A damaged file is moved aside, never deleted: its history may still be read.
  function quarantine() {
    const moved = [];
    for (const ext of ["", "-wal", "-shm"]) {
      const f = dbPath + ext;
      if (fs.existsSync(f)) { const to = dbPath + ".corrupt-" + stamp(now()) + ext; fs.renameSync(f, to); moved.push(path.basename(to)); }
    }
    return moved;
  }
  function tx(db, fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  function open() {
    if (!sqlite) return unavailable("node:sqlite is not available on this Node runtime"), api;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return unavailable("cannot create utilization-data: " + e.message), api; }
    let db;
    const existed = fs.existsSync(dbPath);
    try { db = probe(dbPath); }
    catch (e) {
      if (!existed) return unavailable("cannot create the database: " + e.message), api;
      if (!isDamaged(e)) return unavailable(`the database could not be opened (${e.message}); it is left as it is, and nothing is recorded until SnapCon is restarted`), api;
      try {
        const moved = quarantine();
        state.recovery = { at: now(), moved, reason: e.message };
        log.error(`[utilization] the database could not be read (${e.message}); moved aside as ${moved.join(", ")} and started empty`);
        db = probe(dbPath);
      } catch (e2) { return unavailable("the database is damaged and could not be moved aside: " + e2.message), api; }
    }
    try {
      const v = db.prepare("PRAGMA user_version").get().user_version;
      const empty = db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n === 0;
      if (v > schemaVersion) { db.close(); return unavailable(`the database was written by a newer SnapCon (schema ${v}); nothing is recorded until this one is upgraded`), api; }
      if (v === 0 && empty) tx(db, () => {
        db.exec(schemaSql);
        for (let n = 2; n <= schemaVersion; n++) if (migrations[n]) migrations[n](db);
        db.exec(`PRAGMA user_version = ${schemaVersion}`);
      });
      else if (v === 0) { db.close(); return unavailable("utilization.db holds tables but no schema version"), api; }
      else if (v < schemaVersion) {
        db.close();
        runBackup({ DatabaseSync: sqlite, dbPath, backupsDir, reason: "pre-migration", now, prefix: "utilization" });
        db = probe(dbPath);
        for (let n = v + 1; n <= schemaVersion; n++) {
          if (!migrations[n]) throw new Error(`no migration to schema version ${n}`);
          tx(db, () => { migrations[n](db); db.exec(`PRAGMA user_version = ${n}`); });
        }
      }
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      // The WAL file is truncated to this whenever it is reset (Phase 1.2).
      db.exec(`PRAGMA journal_size_limit = ${Number(journalSizeLimit) | 0}`);
      // Never a checkpoint on this (the main) thread: the checkpoint worker
      // does them (Checkpointer.js). Off from here on, and never turned on.
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec("PRAGMA foreign_keys = ON");
    } catch (e) { try { db.close(); } catch {} return unavailable("could not prepare the database: " + e.message), api; }
    state.db = db; state.available = true; state.reason = null;
    return api;
  }

  const need = () => { if (!state.available) throw new Error("utilization store unavailable: " + state.reason); return state.db; };
  const row = s => s && { id: s.id, printerId: s.printer_id, kind: s.kind, jobId: s.job_id, provenance: s.provenance, reason: s.reason, start: s.start_at, end: s.end_at, estimated: !!s.estimated, knownFraction: s.known_fraction == null ? undefined : s.known_fraction };

  // Statements are compiled once per connection, not on every call.
  const stmts = new WeakMap();
  function q(db, sql) {
    let m = stmts.get(db);
    if (!m) { m = new Map(); stmts.set(db, m); }
    let st = m.get(sql);
    if (!st) { st = db.prepare(sql); m.set(sql, st); }
    if (hooks.onStatement) hooks.onStatement(sql);   // tests: statements per operation
    return st;
  }
  function upsertPrinterIn(db, { id, name, connector, isVirtual, at }) {
    const cur = q(db, "SELECT * FROM printers WHERE id = ?").get(id);
    if (!cur) { q(db, "INSERT INTO printers (id, name, connector, is_virtual, first_seen) VALUES (?,?,?,?,?)").run(id, String(name || id), connector || null, isVirtual ? 1 : 0, at); return "added"; }
    if (cur.name !== String(name || id) || cur.connector !== (connector || null) || cur.is_virtual !== (isVirtual ? 1 : 0) || cur.removed_at != null) {
      q(db, "UPDATE printers SET name = ?, connector = ?, is_virtual = ?, removed_at = NULL WHERE id = ?").run(String(name || id), connector || null, isVirtual ? 1 : 0, id);
      // Back after removal: its eligibility changes from the moment it was removed.
      if (cur.removed_at != null) { touch(id, cur.removed_at); return "returned"; }
      return "updated";
    }
    return "same";
  }

  // One step of one printer: close what is open at `at`, end the job named, start
  // a job, open the next interval. `next` null closes only. Runs inside a batch.
  function step(db, printerId, at, { endJob = null, startJob = null, next = null }) {
    const open = q(db, "SELECT * FROM segments WHERE printer_id = ? AND end_at IS NULL").get(printerId);
    const lastEnd = q(db, "SELECT max(end_at) AS e FROM segments WHERE printer_id = ?").get(printerId).e;
    if (open && at < open.start_at) throw Object.assign(new Error(`step at ${at} is before the open interval started (${open.start_at})`), { rule: true });
    if (!open && lastEnd != null && at < lastEnd) throw Object.assign(new Error(`step at ${at} is before the last interval ended (${lastEnd})`), { rule: true });
    if (open) {
      // An interval that would end where it began had no duration: it goes.
      if (at > open.start_at) q(db, "UPDATE segments SET end_at = ? WHERE id = ?").run(at, open.id);
      else q(db, "DELETE FROM segments WHERE id = ?").run(open.id);
    }
    // What this step changes, for the reporting cache: from `at` on, and a job
    // whose outcome it settles from that job's start (RETURNING: no extra statement).
    touch(printerId, at);
    if (endJob) for (const j of q(db, "UPDATE jobs SET outcome = ?, ended_at = ?, end_reason = ? WHERE job_key = ? AND outcome = 'running' RETURNING started_at").all(endJob.outcome, endJob.at === undefined ? at : endJob.at, endJob.reason || null, endJob.key)) touch(printerId, j.started_at);
    if (startJob) q(db, "INSERT INTO jobs (printer_id, source, filename, started_at, job_key) VALUES (?, 'observed', ?, ?, ?)").run(printerId, startJob.filename || null, at, startJob.key);
    if (next) {
      if (!KINDS.includes(next.kind)) throw Object.assign(new Error(`invalid kind ${next.kind}`), { rule: true });
      const prov = next.provenance || "observed";
      if (!PROVENANCE.includes(prov)) throw Object.assign(new Error(`invalid provenance ${prov}`), { rule: true });
      let jobId = null;
      if ((next.kind === "job" || next.kind === "paused") && next.jobKey) {
        const j = q(db, "SELECT id FROM jobs WHERE job_key = ?").get(next.jobKey);
        if (!j) throw Object.assign(new Error(`no job ${next.jobKey}`), { rule: true });
        jobId = j.id;
      }
      q(db, "INSERT INTO segments (printer_id, kind, job_id, provenance, reason, start_at) VALUES (?,?,?,?,?,?)").run(printerId, next.kind, jobId, prov, next.reason || null, at);
    }
  }
  function closeAll(db, at) {
    for (const s of q(db, "SELECT printer_id, start_at FROM segments WHERE end_at IS NULL").all()) step(db, s.printer_id, Math.max(at, s.start_at), {});
  }
  // A batch: ops in order, all or nothing, once. op.type: printer | removed |
  // step | closeAll | checkpoint. Returns "applied" or "already".
  // Earliest moment each printer's data changed in the batch being applied;
  // reported after COMMIT (onTouched), never for a batch rolled back.
  let touched = null;
  function touch(printerId, t) { if (!touched || !Number.isFinite(t)) return; const c = touched.get(printerId); if (c == null || t < c) touched.set(printerId, t); }
  function applyBatch(id, ops) {
    const db = need();
    touched = new Map();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (q(db, "SELECT 1 FROM applied_batches WHERE id = ?").get(id)) { touched = null; db.exec("ROLLBACK"); return "already"; }
      for (const op of ops) {
        if (op.type === "printer") { if (upsertPrinterIn(db, op) !== "same") touch(op.id, op.at); }
        else if (op.type === "removed") { q(db, "UPDATE printers SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(op.at, op.id); touch(op.id, op.at); }
        else if (op.type === "step") step(db, op.printerId, op.at, op);
        else if (op.type === "closeAll") closeAll(db, op.at);
        else if (op.type === "checkpoint") setMetaIn(db, "heartbeat", op.at);
        else if (op.type === "history") lastHistory = reconcileHistory(q, db, op, { ...historyOptions, touch });
        else throw Object.assign(new Error(`unknown op ${op.type}`), { rule: true });
      }
      q(db, "INSERT INTO applied_batches (id, at) VALUES (?, ?)").run(id, now());
      if (hooks.beforeCommit) hooks.beforeCommit(id, ops);
      db.exec("COMMIT");
    } catch (e) { touched = null; try { db.exec("ROLLBACK"); } catch {} throw e; }
    const changed = touched; touched = null;
    if (onTouched && changed.size) { try { onTouched(changed); } catch {} }
    if (hooks.afterCommit) hooks.afterCommit(id, ops);
    return "applied";
  }
  // Kept for tests and startup: one step as its own batch.
  let directN = 0;
  const apply = (printerId, at, change = {}) => applyBatch(`direct-${now()}-${++directN}`, [{ type: "step", printerId, at, ...change }]);

  // What the tracker needs to continue after a start: no history, only what is open.
  function loadState() {
    const db = need();
    return {
      checkpoint: Number(getMetaIn(db, "heartbeat")) || null,
      open: q(db, "SELECT s.printer_id AS printerId, s.kind, s.reason, s.start_at AS start, j.job_key AS jobKey FROM segments s LEFT JOIN jobs j ON j.id = s.job_id WHERE s.end_at IS NULL").all(),
      runningJobs: q(db, "SELECT printer_id AS printerId, job_key AS jobKey, filename, started_at AS start FROM jobs WHERE outcome = 'running'").all(),
      printers: q(db, "SELECT id, name, connector, is_virtual AS isVirtual, removed_at AS removedAt FROM printers").all(),
    };
  }

  const segments = printerId => q(need(), "SELECT * FROM segments WHERE printer_id = ? ORDER BY start_at").all(printerId).map(row);
  const jobs = printerId => q(need(), "SELECT id, job_key AS key, source, filename, started_at AS start, ended_at AS end, outcome, end_reason AS reason, history_id AS historyId, outcome_source AS outcomeSource, history_outcome AS historyOutcome FROM jobs WHERE printer_id = ? ORDER BY id").all(printerId);
  const printers = () => q(need(), "SELECT id, name, connector, is_virtual AS isVirtual, first_seen AS firstSeen, removed_at AS removedAt FROM printers ORDER BY first_seen").all();
  const upsertPrinter = o => upsertPrinterIn(need(), o);
  function setMetaIn(db, key, value) { q(db, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value)); }
  function getMetaIn(db, key) { const r = q(db, "SELECT value FROM meta WHERE key = ?").get(key); return r ? r.value : null; }
  const getMeta = k => getMetaIn(need(), k);
  // One bounded pass of closed history older than the cutoff: at most `limit`
  // intervals and `limit` jobs, through indexes (see test "prune uses its
  // indexes"). Open intervals, running jobs and jobs an interval still names
  // stay. Called again until it removes nothing.
  // `only`: "segments", "jobs" or "batches" for one table per pass (the Writer
  // does that, to keep passes short); omitted, all three.
  function prunePass(cutoff, limit = 200, only = null) {
    const db = need();
    return tx(db, () => {
      const segs = only && only !== "segments" ? 0 : q(db, "DELETE FROM segments WHERE id IN (SELECT id FROM segments WHERE end_at IS NOT NULL AND end_at < ? ORDER BY end_at LIMIT ?)").run(cutoff, limit).changes;
      const jobs = only && only !== "jobs" ? 0 : q(db, "DELETE FROM jobs WHERE id IN (SELECT j.id FROM jobs j WHERE j.outcome <> 'running' AND coalesce(j.ended_at, j.started_at) < ? AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.job_id = j.id) ORDER BY coalesce(j.ended_at, j.started_at) LIMIT ?)").run(cutoff, limit).changes;
      const batches = only && only !== "batches" ? 0 : q(db, "DELETE FROM applied_batches WHERE id IN (SELECT id FROM applied_batches WHERE at < ? ORDER BY at LIMIT ?)").run(now() - 86400000, limit).changes;
      return { segments: segs, jobs, batches };
    });
  }
  function prune(cutoff) { const t = { segments: 0, jobs: 0 }; for (;;) { const r = prunePass(cutoff, 500); t.segments += r.segments; t.jobs += r.jobs; if (!r.segments && !r.jobs && !r.batches) return t; } }
  const pragma = name => { if (!/^[a-z_]+$/.test(name)) throw new Error("bad pragma"); return Object.values(need().prepare(`PRAGMA ${name}`).get())[0]; };
  const explain = (sql, ...a) => need().prepare("EXPLAIN QUERY PLAN " + sql).all(...a).map(r => r.detail);
  function backup({ reason = "nightly" } = {}) {
    if (!state.available) return null;
    return runBackup({ DatabaseSync: sqlite, dbPath, backupsDir, reason, now, prefix: "utilization" });
  }
  // Shutdown when the checkpoint worker is not running: closing this, the last
  // connection, would make SQLite fold the WAL into the database here, on the
  // main thread. Instead the connection is left open (and referenced, so the
  // garbage collector never closes it either) for the process exit; the WAL
  // stays on disk and SQLite recovers it at the next start.
  function abandon() { if (state.db) ABANDONED.push(state.db); state.db = null; state.available = false; }
  function close() { if (state.db) { try { state.db.close(); } catch {} } state.db = null; state.available = false; }

  const api = {
    open, close, upsertPrinter, applyBatch, apply, loadState, segments, jobs, printers, getMeta, prunePass, prune, explain, pragma, backup, abandon,
    paths: () => ({ dbPath, walPath: dbPath + "-wal", backupsDir }),
    // History reconciliation per printer: cursor (printer-clock seconds of the
    // newest start applied), recent clock-skew samples, counters.
    historyState: printerId => {
      const r = q(need(), "SELECT * FROM history_sync WHERE printer_id = ?").get(printerId);
      return r ? { cursor: r.cursor_s, skewSamples: JSON.parse(r.skew_samples || "[]"), lastOkAt: r.last_ok_at, counters: JSON.parse(r.counters || "{}") } : null;
    },
    lastHistory: () => lastHistory,
    // Reads for reporting (Phase 3), each through an index, bounded by its range:
    // the segments overlapping [from, to) of one printer ...
    segmentsIn: (printerId, from, to) => {
      const db = need();
      const out = [];
      const before = q(db, "SELECT * FROM segments WHERE printer_id = ? AND start_at <= ? ORDER BY start_at DESC LIMIT 1").get(printerId, from);
      if (before && (before.end_at == null || before.end_at > from)) out.push(before);
      for (const s of q(db, "SELECT * FROM segments WHERE printer_id = ? AND start_at > ? AND start_at < ? ORDER BY start_at").all(printerId, from, to)) out.push(s);
      return out.map(row);
    },
    // ... its jobs started in [from, to) (jobs_printer), and jobs by id.
    jobsStarted: (printerId, from, to) => q(need(), "SELECT * FROM jobs WHERE printer_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at").all(printerId, from, to),
    jobById: id => q(need(), "SELECT * FROM jobs WHERE id = ?").get(id),
    firstJobAt: printerId => { const r = q(need(), "SELECT min(started_at) AS t FROM jobs WHERE printer_id = ?").get(printerId); return r && Number.isFinite(r.t) ? r.t : null; },
    listBackups: () => listBackups(backupsDir, "utilization"),
    isAvailable: () => state.available,
    status: () => ({ available: state.available, reason: state.reason, recovery: state.recovery, path: dbPath }),
  };
  return api;
}

module.exports = { createUtilizationStore, SCHEMA_VERSION, SCHEMA_SQL, V2_SQL, V3_SQL };

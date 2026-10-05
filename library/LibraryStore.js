// library/LibraryStore.js — the Library's SQLite database: opening it,
// migrating it, backing it up, recovering it, and rebuilding its derived half.
//
// node:sqlite, as audit/ and sync/ use, so the pkg builds carry no native
// addon. Like them it degrades instead of crashing: without node:sqlite, or
// with a database it must not touch, the Library reports itself unavailable
// and the rest of SnapCon runs as before.
//
// Persistent state follows CLAUDE.md §7:
//   missing file       a first run: create it
//   corrupt file       quarantine it (never delete) and restore the newest
//                      good backup; with no backup, start fresh and say so
//   failed open        (locked, permissions, a newer SnapCon's database) stay
//                      unavailable and leave the file exactly as it is
"use strict";
const fs = require("fs");
const path = require("path");
const SCHEMA = require("./schema");
const { seedRoleDefaults } = require("./permissions");

// version -> function(db). Each runs inside its own transaction, after a
// pre-migration snapshot. Version 1 is the initial schema, created directly.
const MIGRATIONS = {
  // 2: the durable identity cache (§4.6), seeded from every full hash the
  // index already holds, so the first rebuild after the upgrade keeps them.
  2: db => {
    db.exec(SCHEMA.IDENTITY_SQL);
    db.prepare(`INSERT OR IGNORE INTO identity_cache (quick_fp, size, sha256, md5, verified_at)
      SELECT quick_fp, size, sha256, md5, ? FROM files WHERE sha256 IS NOT NULL AND entry_path = ''`).run(Date.now());
  },
  // 3 (M6): the actions history (authored), Decisions an action wrote and
  // an undo withdrew, merged Models kept with where they went, and a search
  // column for normalised name forms (the derived search index is recreated
  // empty; the next grouping run fills it).
  3: db => {
    const stmt = (sql, re) => { const m = re.exec(sql); if (!m) throw new Error("schema statement not found: " + re); return m[0]; };
    const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'actions'").get()) {
      db.exec(stmt(SCHEMA.AUTHORED_SQL, /CREATE TABLE actions \([\s\S]*?\);/));
      db.exec(stmt(SCHEMA.AUTHORED_SQL, /CREATE INDEX actions_model [^;]*;/));
    }
    if (!has("models", "merged_into")) db.exec("ALTER TABLE models ADD COLUMN merged_into TEXT");
    if (!has("decisions", "action_id")) db.exec("ALTER TABLE decisions ADD COLUMN action_id INTEGER REFERENCES actions(id)");
    if (!has("decisions", "withdrawn_at")) db.exec("ALTER TABLE decisions ADD COLUMN withdrawn_at INTEGER");
    db.exec("DROP TABLE IF EXISTS model_fts");
    db.exec(stmt(SCHEMA.DERIVED_SQL, /CREATE VIRTUAL TABLE model_fts [\s\S]*?\);/));
  },
  // 4 (M7): how each Print was started and from where, one row per job
  // (job_key), the audit-log imports, and each Print's resolved Model
  // (derived; the next grouping run fills it). Existing prints rows are kept.
  4: db => {
    // Comments go first: one of them holds "(#plate);", which would end a
    // statement early.
    const stmt = (sql, re) => { const m = re.exec(sql.replace(/--[^\n]*/g, "")); if (!m) throw new Error("schema statement not found: " + re); return m[0]; };
    const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    const table = name => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
    if (!has("prints", "via")) db.exec("ALTER TABLE prints ADD COLUMN via TEXT CHECK (via IN ('print','queue'))");
    for (const col of ["location", "queue_item_id", "job_key"]) if (!has("prints", col)) db.exec(`ALTER TABLE prints ADD COLUMN ${col} TEXT`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS prints_job ON prints(job_key)");
    db.exec("CREATE INDEX IF NOT EXISTS prints_audit ON prints(audit_ref)");
    if (!table("print_imports")) db.exec(stmt(SCHEMA.AUTHORED_SQL, /CREATE TABLE print_imports \([\s\S]*?\);/));
    if (!table("print_links")) {
      db.exec(stmt(SCHEMA.DERIVED_SQL, /CREATE TABLE print_links \([\s\S]*?\);/));
      db.exec(stmt(SCHEMA.DERIVED_SQL, /CREATE INDEX print_links_model [^;]*;/));
    }
  },
};

const BACKUP_KEEP = 7;
const SQLITE_CORRUPT = new Set([11, 26]);   // SQLITE_CORRUPT, SQLITE_NOTADB

function loadSqlite() {
  try { return require("node:sqlite").DatabaseSync; } catch { return null; }
}

function stamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Whether a routine backup is due: the newest one (pre-migration snapshots
// don't count) is at least `everyMs` old, or there is none. `backups` is
// listBackups()'s answer, newest first; its stamps are local time.
function backupDue(backups, nowMs, everyMs) {
  const newest = backups.find(b => b.reason !== "pre-migration");
  if (!newest) return true;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(newest.stamp);
  const at = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
  return nowMs - at >= everyMs;
}

// A prefix becomes part of a file name and a regular expression: letters only.
function checkPrefix(prefix) {
  if (!/^[a-z]+$/.test(prefix)) throw new Error("invalid backup prefix: " + prefix);
}

function isCorruption(e) {
  return !!e && (SQLITE_CORRUPT.has(e.errcode) || /file is not a database|malformed/i.test(e.message || ""));
}

// Backups are VACUUM INTO copies: consistent while the live database stays in
// use. Written under a temporary name and renamed, so a crash never leaves a
// half-written file looking like a good backup. Refuses to back up a database
// that fails its integrity check, so a damaged file never pushes the last good
// copies out of rotation. Used on the main thread for pre-migration snapshots
// (before anything else runs) and from the indexer worker for the nightly one.
// `prefix` names the files (library-…db); the audit and sync stores reuse this
// for their own databases with their own prefix.
function runBackup({ DatabaseSync, dbPath, backupsDir, reason, keep = BACKUP_KEEP, now = Date.now, prefix = "library" }) {
  checkPrefix(prefix);
  const t0 = Date.now();
  fs.mkdirSync(backupsDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const check = db.prepare("PRAGMA quick_check").all().map(r => Object.values(r)[0]);
    if (!(check.length === 1 && check[0] === "ok")) {
      const e = new Error("integrity check failed: " + check.slice(0, 3).join("; "));
      e.code = "LIBRARY_DB_CORRUPT";
      throw e;
    }
    const name = `${prefix}-${stamp(now())}-${reason}.db`;
    const tmp = path.join(backupsDir, name + ".partial");
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, path.join(backupsDir, name));
    if (reason !== "pre-migration") rotateBackups(backupsDir, keep, prefix);
    return { file: name, bytes: fs.statSync(path.join(backupsDir, name)).size, ms: Date.now() - t0 };
  } finally { db.close(); }
}

// Keeps the newest `keep` routine backups. Pre-migration snapshots are few and
// are never rotated away: they are the way back from a failed upgrade.
function rotateBackups(backupsDir, keep = BACKUP_KEEP, prefix = "library") {
  const routine = listBackups(backupsDir, prefix).filter(b => b.reason !== "pre-migration");
  for (const b of routine.slice(keep)) fs.rmSync(path.join(backupsDir, b.file), { force: true });
}

function listBackups(backupsDir, prefix = "library") {
  checkPrefix(prefix);
  const re = new RegExp("^" + prefix + "-(\\d{8}-\\d{6})-([a-z-]+)\\.db$");
  let names = [];
  try { names = fs.readdirSync(backupsDir); } catch { return []; }
  return names
    .map(n => re.exec(n))
    .filter(Boolean)
    .map(m => ({ file: m[0], stamp: m[1], reason: m[2], bytes: fs.statSync(path.join(backupsDir, m[0])).size }))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

// `schema` and `migrations` default to the real ones. Tests pass their own
// to exercise a version upgrade before the first real migration exists.
// `sqlite` is the DatabaseSync constructor; tests pass null to exercise the
// "node:sqlite unavailable" path.
function createLibraryStore({ baseDir, now = Date.now, log = console, schema = SCHEMA, migrations = MIGRATIONS, sqlite = loadSqlite() }) {
  const { SCHEMA_VERSION, AUTHORED_SQL, IDENTITY_SQL = "", DERIVED_SQL, DERIVED_TABLES } = schema;
  const dir = path.join(baseDir, "library-data");
  const dbPath = path.join(dir, "library.db");
  const backupsDir = path.join(dir, "backups");
  const checkMarker = path.join(dir, "integrity-check-requested");
  const DatabaseSync = sqlite;
  const state = { available: false, reason: null, recovery: null, db: null };

  const unavailable = reason => {
    state.available = false; state.reason = reason;
    log.warn("[library] unavailable: " + reason);
    return api;
  };

  function openAndProbe(file) {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      // Reading the schema touches the header and the schema pages: enough to
      // catch a file that is not a database, or one whose first pages are bad.
      db.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
      db.prepare("PRAGMA user_version").get();
      return db;
    } catch (e) { db.close(); throw e; }
  }

  function quarantine() {
    const suffix = ".corrupt-" + stamp(now());
    const moved = [];
    for (const ext of ["", "-wal", "-shm"]) {
      const f = dbPath + ext;
      if (fs.existsSync(f)) { fs.renameSync(f, dbPath + suffix + ext); moved.push(path.basename(dbPath + suffix + ext)); }
    }
    return moved;
  }

  function restoreNewestBackup() {
    for (const b of listBackups(backupsDir)) {
      const src = path.join(backupsDir, b.file);
      try {
        const probe = new DatabaseSync(src);
        const ok = probe.prepare("PRAGMA quick_check").all().map(r => Object.values(r)[0]);
        probe.close();
        if (ok.length !== 1 || ok[0] !== "ok") continue;
        fs.copyFileSync(src, dbPath);
        return b.file;
      } catch { /* try the next older one */ }
    }
    return null;
  }

  function createFresh(db) {
    db.exec("BEGIN");
    try {
      db.exec(AUTHORED_SQL);
      if (IDENTITY_SQL) db.exec(IDENTITY_SQL);
      db.exec(DERIVED_SQL);
      seedRoleDefaults(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  function migrate(db, from) {
    db.close();
    runBackup({ DatabaseSync, dbPath, backupsDir, reason: "pre-migration", now });
    db = openAndProbe(dbPath);
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      const step = migrations[v];
      if (!step) throw new Error(`no migration to schema version ${v}`);
      db.exec("BEGIN");
      try { step(db); db.exec(`PRAGMA user_version = ${v}`); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    return db;
  }

  function open() {
    if (!DatabaseSync) return unavailable("node:sqlite is not available on this Node runtime");
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { return unavailable("cannot create library-data: " + e.message); }

    let db;
    const existed = fs.existsSync(dbPath);
    try {
      db = openAndProbe(dbPath);
      // Opening only proves the header and schema are readable. A full check
      // costs ~3.75 s at 100k files (measured in M1), too much for every
      // start, so it runs only when a backup was refused because the
      // database failed its integrity check (requestIntegrityCheck below).
      if (fs.existsSync(checkMarker)) {
        const res = db.prepare("PRAGMA quick_check").all().map(r => Object.values(r)[0]);
        fs.rmSync(checkMarker, { force: true });
        if (!(res.length === 1 && res[0] === "ok")) {
          db.close();
          const e = new Error("integrity check failed: " + res.slice(0, 3).join("; "));
          e.errcode = 11;
          throw e;
        }
      }
    } catch (e) {
      if (!existed || !isCorruption(e)) return unavailable("cannot open library.db: " + e.message);
      // Corrupt: keep the evidence, restore the newest good backup.
      const quarantined = quarantine();
      const restored = restoreNewestBackup();
      state.recovery = { at: now(), quarantined, restoredFrom: restored, fresh: !restored, error: e.message };
      log.error(`[library] library.db was corrupt (${e.message}); quarantined as ${quarantined.join(", ")}; ` +
        (restored ? "restored " + restored : "no usable backup, starting a new empty library"));
      try { db = openAndProbe(dbPath); }
      catch (e2) { return unavailable("cannot open the recovered library.db: " + e2.message); }
    }

    try {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      const tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get().n;
      if (version > SCHEMA_VERSION) {
        db.close();
        return unavailable(`library.db has schema version ${version}, newer than this SnapCon supports (${SCHEMA_VERSION}); it was left untouched`);
      }
      if (version === 0 && tables > 0) {
        db.close();
        return unavailable("library.db contains tables but no schema version; it was left untouched");
      }
      if (version === 0) createFresh(db);
      else if (version < SCHEMA_VERSION) db = migrate(db, version);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA foreign_keys = ON");
      seedRoleDefaults(db);   // new capabilities get their role defaults; revoked ones stay allow=0
    } catch (e) {
      try { db.close(); } catch {}
      // Damage the open probe did not reach (a page first read while preparing
      // — measured on a real backup with one damaged page): the same recovery
      // as at open, then prepare again. Once only: a second failure leaves the
      // Library unavailable.
      if (existed && isCorruption(e) && !state.recovery) {
        const quarantined = quarantine();
        const restored = restoreNewestBackup();
        state.recovery = { at: now(), quarantined, restoredFrom: restored, fresh: !restored, error: e.message };
        log.error(`[library] library.db was corrupt (${e.message}); quarantined as ${quarantined.join(", ")}; ` +
          (restored ? "restored " + restored : "no usable backup, starting a new empty library"));
        return open();
      }
      return unavailable("cannot prepare library.db: " + e.message);
    }
    state.db = db; state.available = true; state.reason = null;
    return api;
  }

  // Drop and recreate every derived table in one transaction (§4.6 rule 7).
  // Foreign-key enforcement is off for the drop only, which is safe because no
  // authored table references a derived one; turning it on again afterwards
  // restores it for everything else. Authored tables, including the runtime
  // status columns of roots, are not touched, and neither is the identity
  // cache: that is what lets rediscovered files find their content keys.
  function rebuildDerived() {
    const db = state.db;
    if (!db) throw new Error("library unavailable");
    const t0 = Date.now();
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN");
      try {
        for (const t of DERIVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
        db.exec(DERIVED_SQL);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    } finally { db.exec("PRAGMA foreign_keys = ON"); }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("foreign key violations after rebuild: " + JSON.stringify(violations.slice(0, 3)));
    return { ms: Date.now() - t0 };
  }

  // The deeper reset (§4.6): forget every verified identity, so the next
  // scans rebuild identity from full hashes alone. Not part of a normal
  // rebuild, and never touches authored tables: Models, anchors and Decisions
  // stay, and re-attach once their files are hashed again.
  function resetIdentityCache() {
    const db = state.db;
    if (!db) throw new Error("library unavailable");
    return { removed: db.prepare("DELETE FROM identity_cache").run().changes };
  }

  // ---- roots (Library locations) ----
  const ROOT_COLS = "id, name, path, grouping, enabled, scan_every_min, full_hash, created_at, created_by, status, last_scan_at, last_ok_at, last_error";
  const roots = {
    list: () => state.db.prepare(`SELECT ${ROOT_COLS} FROM roots ORDER BY (id='gcode') DESC, name COLLATE NOCASE`).all().map(r => ({ ...r })),
    get: id => { const r = state.db.prepare(`SELECT ${ROOT_COLS} FROM roots WHERE id = ?`).get(id); return r ? { ...r } : null; },
    insert: r => state.db.prepare(`INSERT INTO roots (id, name, path, grouping, enabled, scan_every_min, full_hash, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.name, r.path, r.grouping, r.enabled ? 1 : 0, r.scan_every_min, r.full_hash || "idle", r.created_at, r.created_by || null),
    update: (id, f) => {
      const allowed = ["name", "path", "grouping", "enabled", "scan_every_min"];
      const keys = Object.keys(f).filter(k => allowed.includes(k));
      if (!keys.length) return;
      state.db.prepare(`UPDATE roots SET ${keys.map(k => k + " = ?").join(", ")} WHERE id = ?`)
        .run(...keys.map(k => (k === "enabled" ? (f[k] ? 1 : 0) : f[k])), id);
    },
    setStatus: (id, s) => state.db.prepare("UPDATE roots SET status = ?, last_ok_at = COALESCE(?, last_ok_at), last_error = ? WHERE id = ?")
      .run(s.status, s.lastOkAt || null, s.error || null, id),
    // Removing a location drops only its derived rows (files cascade to their
    // derived children). Decisions, prints and models are authored and stay,
    // keyed by content, for Re-link (§4.6 rule 6).
    remove: id => {
      state.db.exec("BEGIN");
      try {
        state.db.prepare("DELETE FROM scan_runs WHERE root_id = ?").run(id);
        state.db.prepare("DELETE FROM folder_classes WHERE root_id = ?").run(id);
        state.db.prepare("DELETE FROM files WHERE root_id = ?").run(id);
        state.db.prepare("DELETE FROM roots WHERE id = ?").run(id);
        state.db.exec("COMMIT");
      } catch (e) { state.db.exec("ROLLBACK"); throw e; }
    },
  };

  const api = {
    open, rebuildDerived, resetIdentityCache, roots,
    dbPath, backupsDir,
    get available() { return state.available; },
    get reason() { return state.reason; },
    get recovery() { return state.recovery; },
    get db() { return state.db; },
    schemaVersion: () => (state.db ? state.db.prepare("PRAGMA user_version").get().user_version : null),
    listBackups: () => listBackups(backupsDir),
    // Asks the next start to run a full integrity check (see open()).
    requestIntegrityCheck: reason => { try { fs.writeFileSync(checkMarker, String(reason || "")); } catch {} },
    close: () => { if (state.db) { try { state.db.close(); } catch {} state.db = null; state.available = false; } },
  };
  return api;
}

module.exports = { createLibraryStore, runBackup, rotateBackups, listBackups, backupDue, MIGRATIONS, BACKUP_KEEP };

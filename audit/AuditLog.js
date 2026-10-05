// audit/AuditLog.js — the only module server.js talks to for the audit log.
// Wraps node:sqlite's DatabaseSync (built into Node, no added dependency —
// keeps this out of the native-addon packaging risk pkg cross-builds already
// hit once this project). node:sqlite is still labeled "Active Development"
// by Node itself, so this degrades to a silent no-op on any runtime where
// `require("node:sqlite")` throws (Node <22.5) rather than crashing the app
// over an additive feature.
const fs = require("fs");
const path = require("path");
const { runBackup, listBackups } = require("../library/LibraryStore");

const ALLOWED_COLUMNS = new Set(["category", "event", "userId", "printerId"]);

function createAuditLog({ baseDir, retentionDaysFn = () => 90 }) {
  const dir = path.join(baseDir, "audit-data");
  const dbPath = path.join(dir, "audit.db");
  const backupsDir = path.join(dir, "backups");
  let db = null;
  let DatabaseSyncCtor = null;
  let unavailable = false;
  let unavailableReason = null;

  try {
    ({ DatabaseSync: DatabaseSyncCtor } = require("node:sqlite"));
  } catch (e) {
    unavailable = true;
    unavailableReason = "node:sqlite unavailable on this runtime (" + e.message + ")";
    console.warn("[audit] disabled: " + unavailableReason);
  }

  if (!unavailable) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      db = new DatabaseSyncCtor(dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          category TEXT NOT NULL,
          event TEXT NOT NULL,
          userId TEXT,
          userLabel TEXT,
          printerId TEXT,
          printerName TEXT,
          detail TEXT
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_cat_event ON audit_log(category, event)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(userId)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_printer ON audit_log(printerId)");
    } catch (e) {
      unavailable = true;
      unavailableReason = "could not open audit-data/audit.db (" + e.message + ")";
      console.warn("[audit] disabled: " + unavailableReason);
      db = null;
    }
  }

  // Returns the new row's id (the Library's print history keeps it as the
  // Print's audit_ref), or null when nothing was written.
  function log({ category, event, userId = null, userLabel = null, printerId = null, printerName = null, detail = null }) {
    if (unavailable) return null;
    try {
      const r = db.prepare(
        "INSERT INTO audit_log (ts, category, event, userId, userLabel, printerId, printerName, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        Date.now(), String(category), String(event),
        userId, userLabel, printerId, printerName,
        detail != null ? JSON.stringify(detail) : null
      );
      return Number(r.lastInsertRowid);
    } catch (e) {
      console.error("[audit] log failed:", e.message);
      return null;
    }
  }

  // Every row of the given events in [from, to], oldest first: what the
  // Library imports print history from (M7). Event names are bound, never
  // interpolated.
  function events({ from, to, names = [] } = {}) {
    if (unavailable || !names.length) return [];
    try {
      return db.prepare(
        `SELECT id, ts, category, event, userId, userLabel, printerId, printerName, detail FROM audit_log
         WHERE category = 'job' AND ts >= ? AND ts <= ? AND event IN (SELECT value FROM json_each(?)) ORDER BY ts, id`
      ).all(Number(from) || 0, Number(to) || Date.now(), JSON.stringify(names.map(String)));
    } catch (e) {
      console.error("[audit] events failed:", e.message);
      return [];
    }
  }

  function query({ from, to, userId, printerId, category, event, q, limit = 100, offset = 0 } = {}) {
    if (unavailable) return { rows: [], total: 0, unavailable: true };
    const where = [];
    const params = [];
    if (from != null) { where.push("ts >= ?"); params.push(Number(from)); }
    if (to != null) { where.push("ts <= ?"); params.push(Number(to)); }
    // Only ever compares against ALLOWED_COLUMNS — column names are never
    // interpolated from caller input, only chosen from this fixed set.
    for (const [col, val] of [["category", category], ["event", event], ["userId", userId], ["printerId", printerId]]) {
      if (val != null && ALLOWED_COLUMNS.has(col)) { where.push(col + " = ?"); params.push(val); }
    }
    if (q) {
      where.push("(userLabel LIKE ? OR printerName LIKE ? OR detail LIKE ?)");
      const like = "%" + String(q) + "%";
      params.push(like, like, like);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    try {
      const rows = db.prepare(
        `SELECT * FROM audit_log ${whereSql} ORDER BY ts DESC LIMIT ? OFFSET ?`
      ).all(...params, lim, off);
      const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(...params);
      return { rows, total: (totalRow && totalRow.n) || 0 };
    } catch (e) {
      console.error("[audit] query failed:", e.message);
      return { rows: [], total: 0 };
    }
  }

  function prune(retentionDays) {
    if (unavailable) return;
    const fallback = retentionDaysFn();
    const days = (retentionDays != null && Number.isFinite(Number(retentionDays))) ? Number(retentionDays) : (fallback != null ? fallback : 90);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      db.prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff);
    } catch (e) {
      console.error("[audit] prune failed:", e.message);
    }
  }

  // A consistent copy of the database in audit-data/backups/, made with the
  // Library's runBackup(): an integrity check first (a damaged database never
  // pushes good copies out), VACUUM INTO under a temporary name, then rename,
  // keeping the newest seven. A file copy of the live database is not safe:
  // in WAL mode recent writes may still be in audit.db-wal. Throws on failure
  // (the caller reports it); null when the store is unavailable.
  function backup({ reason = "nightly", now = Date.now } = {}) {
    if (unavailable) return null;
    return runBackup({ DatabaseSync: DatabaseSyncCtor, dbPath, backupsDir, reason, now, prefix: "audit" });
  }

  return {
    log, query, prune, events, backup,
    listBackups: () => listBackups(backupsDir, "audit"),
    isAvailable: () => !unavailable,
    unavailableReason: () => unavailableReason
  };
}

module.exports = { createAuditLog };

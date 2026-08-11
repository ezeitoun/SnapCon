// sync/SyncStore.js — persistence for the Logs/Camera sync feature.
// Mirrors audit/AuditLog.js deliberately: same node:sqlite (built into Node,
// no added dependency, same native-addon-packaging-risk reasoning) DatabaseSync
// pattern, own database file, same graceful no-op degrade if node:sqlite is
// unavailable on the runtime — a missing sync history should never crash the
// app over an additive feature.
//
// A flat JSON history file (the approach a single-printer desktop tool would
// reach for) doesn't hold up at fleet scale: every append would rewrite the
// entire file, and the "is this file already synced" dedup check would mean
// loading and scanning the whole history into memory on every sync run.
// SQLite makes both an indexed lookup instead.
const fs = require("fs");
const path = require("path");

function createSyncStore({ baseDir }) {
  let db = null;
  let DatabaseSyncCtor = null;
  let unavailable = false;
  let unavailableReason = null;

  try {
    ({ DatabaseSync: DatabaseSyncCtor } = require("node:sqlite"));
  } catch (e) {
    unavailable = true;
    unavailableReason = "node:sqlite unavailable on this runtime (" + e.message + ")";
    console.warn("[sync] disabled: " + unavailableReason);
  }

  if (!unavailable) {
    try {
      const dir = path.join(baseDir, "sync-data");
      fs.mkdirSync(dir, { recursive: true });
      db = new DatabaseSyncCtor(path.join(dir, "sync.db"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS synced_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          printerId TEXT NOT NULL,
          root TEXT NOT NULL,
          remotePath TEXT NOT NULL,
          remoteSize INTEGER,
          remoteModified REAL,
          localPath TEXT,
          syncedAt INTEGER NOT NULL,
          status TEXT NOT NULL,
          errorMessage TEXT
        )
      `);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_key ON synced_files(printerId, root, remotePath)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sync_printer_root ON synced_files(printerId, root)");
    } catch (e) {
      unavailable = true;
      unavailableReason = "could not open sync-data/sync.db (" + e.message + ")";
      console.warn("[sync] disabled: " + unavailableReason);
      db = null;
    }
  }

  // The dedup lookup a sync run makes once per remote file — indexed, not a
  // linear scan of a loaded-into-memory history array.
  function getEntry(printerId, root, remotePath) {
    if (unavailable) return null;
    try {
      return db.prepare("SELECT * FROM synced_files WHERE printerId=? AND root=? AND remotePath=?")
        .get(printerId, root, remotePath) || null;
    } catch (e) {
      console.error("[sync] getEntry failed:", e.message);
      return null;
    }
  }

  // Keyed upsert (the unique index on printerId/root/remotePath is what
  // makes INSERT OR REPLACE correct here) — a re-synced or previously-failed
  // file just overwrites its own row rather than accumulating duplicates.
  function recordSynced({ printerId, root, remotePath, remoteSize, remoteModified, localPath, status, errorMessage }) {
    if (unavailable) return;
    try {
      db.prepare(`
        INSERT OR REPLACE INTO synced_files
          (printerId, root, remotePath, remoteSize, remoteModified, localPath, syncedAt, status, errorMessage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        printerId, root, remotePath,
        remoteSize ?? null, remoteModified ?? null, localPath ?? null,
        Date.now(), status, errorMessage ?? null
      );
    } catch (e) {
      console.error("[sync] recordSynced failed:", e.message);
    }
  }

  // Retention-cleanup candidates: only ever confirmed-downloaded rows —
  // failed syncs are never eligible for source deletion, by construction.
  function listDownloaded(printerId, root) {
    if (unavailable) return [];
    try {
      return db.prepare("SELECT * FROM synced_files WHERE printerId=? AND root=? AND status='downloaded'")
        .all(printerId, root);
    } catch (e) {
      console.error("[sync] listDownloaded failed:", e.message);
      return [];
    }
  }

  function deleteEntry(printerId, root, remotePath) {
    if (unavailable) return;
    try {
      db.prepare("DELETE FROM synced_files WHERE printerId=? AND root=? AND remotePath=?")
        .run(printerId, root, remotePath);
    } catch (e) {
      console.error("[sync] deleteEntry failed:", e.message);
    }
  }

  return {
    getEntry, recordSynced, listDownloaded, deleteEntry,
    isAvailable: () => !unavailable,
    unavailableReason: () => unavailableReason
  };
}

module.exports = { createSyncStore };

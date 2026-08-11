// sync/SyncEngine.js — the only module server.js talks to for the Logs/
// Camera sync feature, same "one entry point" shape as RemoteAccessService.
// Owns the SyncStore (persistence), in-memory per-printer-per-root status
// (for the pollable progress endpoint), and the actual download/dedup/
// retention-cleanup orchestration. Nothing outside this module ever touches
// the sync database or issues a download/delete call to a printer directly.
//
// Modeled on github.com/doutorinfamous/snapsync's real sync_engine.rs (read
// directly, not just its README): stream to a `.part` file, validate size,
// atomic rename; on repeat runs, don't trust a "already synced" record
// blindly — re-stat the local file and compare its size against what the
// printer currently reports, so a manually-deleted or corrupted local copy
// gets fixed automatically instead of silently skipped forever.
const fs = require("fs");
const path = require("path");
const { createSyncStore } = require("./SyncStore");

const ROOTS = new Set(["logs", "camera", "gcodes"]);

// Filesystem-safe per-printer subfolder name — same reasoning as SnapSync's
// own sanitize_filename: strip characters illegal on Windows, trim trailing
// dots/spaces (a Windows-only quirk that silently mangles paths otherwise),
// and guard the handful of reserved device names.
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function sanitizeFolderName(name) {
  let s = String(name || "printer").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  s = s.replace(/[. ]+$/, "");
  if (!s) s = "printer";
  if (RESERVED_NAMES.test(s)) s = "_" + s;
  return s.slice(0, 100);
}

function createSyncEngine({ baseDir, getConnector }) {
  const store = createSyncStore({ baseDir });
  const statuses = new Map(); // "printerId|root" -> status object
  const locks = new Set();    // "printerId|root" currently running

  const key = (printerId, root) => printerId + "|" + root;

  function getStatus(printerId, root) {
    return statuses.get(key(printerId, root)) || {
      phase: "idle", total: 0, completed: 0,
      downloaded: 0, skipped: 0, failed: 0,
      currentFile: null, lastError: null, lastSyncAt: null, deletedFromSource: 0
    };
  }
  function setStatus(printerId, root, patch) {
    const k = key(printerId, root);
    statuses.set(k, { ...getStatus(printerId, root), ...patch });
  }

  // Retention cleanup: delete a file from the PRINTER only when every one of
  // these holds — never by age alone:
  //  (a) it has a confirmed status='downloaded' row in the store,
  //  (b) the local copy still genuinely exists on disk right now, re-stat'd
  //      (never trusted from the database record alone), and its size still
  //      matches what was recorded at sync time,
  //  (c) the printer's own reported `modified` timestamp is older than the
  //      configured retention window.
  // A file that failed to sync, or whose local copy has since gone missing
  // or changed, is never a deletion candidate, no matter its age.
  async function runRetentionCleanup(p, root, retentionDays) {
    if (!retentionDays) return 0;
    const c = getConnector(p.connector);
    if (!c.deleteSyncFile) return 0;
    const http = require("../connectors/http-utils");
    const base = http.baseUrl(p);
    const cutoffSec = Date.now() / 1000 - retentionDays * 86400;
    const entries = store.listDownloaded(p.id, root);
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.remoteModified || entry.remoteModified >= cutoffSec) continue;
      try {
        const st = await fs.promises.stat(entry.localPath);
        if (!st.isFile()) continue;
        if (entry.remoteSize && st.size !== entry.remoteSize) continue;
      } catch {
        continue; // can't verify the local copy exists — never delete the source
      }
      try {
        await c.deleteSyncFile(base, root, entry.remotePath);
        store.deleteEntry(p.id, root, entry.remotePath);
        deleted++;
      } catch (e) {
        console.error("[sync] retention delete failed:", p.id, root, entry.remotePath, e.message);
      }
    }
    return deleted;
  }

  // Fire-and-forget from the caller's perspective — the route starts this
  // and returns immediately; progress is read back via getStatus(), same
  // "server keeps working regardless of what the browser tab does" shape as
  // an actual print job.
  async function runSync(p, root, destRootFolder, retentionDays) {
    if (!ROOTS.has(root)) throw new Error("Unknown sync root: " + root);
    const k = key(p.id, root);
    if (locks.has(k)) throw new Error("A sync is already running for this printer");
    locks.add(k);
    setStatus(p.id, root, {
      phase: "listing", total: 0, completed: 0,
      downloaded: 0, skipped: 0, failed: 0,
      currentFile: null, lastError: null, deletedFromSource: 0
    });
    try {
      const c = getConnector(p.connector);
      if (!c.querySyncFiles) throw new Error("This printer's connector doesn't support file sync");
      const http = require("../connectors/http-utils");
      const base = http.baseUrl(p);
      const remoteFiles = await c.querySyncFiles(base, root);
      const destDir = path.join(destRootFolder, sanitizeFolderName(p.name));
      await fs.promises.mkdir(destDir, { recursive: true });
      setStatus(p.id, root, { phase: "downloading", total: remoteFiles.length });

      let downloaded = 0, skipped = 0, failed = 0;
      for (let i = 0; i < remoteFiles.length; i++) {
        const f = remoteFiles[i];
        setStatus(p.id, root, { currentFile: f.path, completed: i });
        const localPath = path.join(destDir, ...f.path.split("/"));

        const existing = store.getEntry(p.id, root, f.path);
        let alreadyValid = false;
        if (existing && existing.status === "downloaded" && existing.localPath) {
          try {
            const st = await fs.promises.stat(existing.localPath);
            if (st.isFile() && (!f.size || st.size === f.size)) alreadyValid = true;
          } catch { /* local copy missing — re-download below */ }
        }

        if (alreadyValid) {
          skipped++;
          setStatus(p.id, root, { skipped });
          continue;
        }
        try {
          await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
          await c.downloadSyncFile(base, root, f.path, localPath, f.size);
          store.recordSynced({
            printerId: p.id, root, remotePath: f.path,
            remoteSize: f.size, remoteModified: f.modified,
            localPath, status: "downloaded"
          });
          downloaded++;
          setStatus(p.id, root, { downloaded });
        } catch (e) {
          store.recordSynced({
            printerId: p.id, root, remotePath: f.path,
            remoteSize: f.size, remoteModified: f.modified,
            localPath: null, status: "failed", errorMessage: e.message
          });
          failed++;
          setStatus(p.id, root, { failed, lastError: e.message });
        }
      }

      let deletedFromSource = 0;
      if (retentionDays) {
        setStatus(p.id, root, { phase: "cleaning-up" });
        deletedFromSource = await runRetentionCleanup(p, root, retentionDays);
      }

      setStatus(p.id, root, {
        phase: "idle", currentFile: null, completed: remoteFiles.length,
        lastSyncAt: Date.now(), deletedFromSource
      });
      return { downloaded, skipped, failed, deletedFromSource };
    } catch (e) {
      setStatus(p.id, root, { phase: "error", lastError: e.message, currentFile: null, lastSyncAt: Date.now() });
      throw e;
    } finally {
      locks.delete(k);
    }
  }

  return { runSync, getStatus, isRunning: (printerId, root) => locks.has(key(printerId, root)), store };
}

module.exports = { createSyncEngine, sanitizeFolderName };

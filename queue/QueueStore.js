// queue/QueueStore.js — the ONLY module that owns authoritative queue state
// or touches disk for it. queue/QueueEngine.js computes what a next state
// *should* look like; this module decides whether/when that becomes real,
// via a candidate-then-commit discipline:
//
//   Intent-driven physical actions (claim, resolve-attention, confirm bed-
//   clear, start bed-clear, bulk actions) — persist the candidate FIRST,
//   commit to the authoritative in-memory store only if that succeeds, THEN
//   the caller proceeds to actually touch the connector. If persistence
//   fails, memory is simply never mutated — there's nothing to roll back.
//
//   Observed physical events (dispatch success/failure, print completion/
//   failure, bed-clear success/failure, startup reconciliation) — the
//   authoritative store is updated immediately, because the event already
//   happened in physical reality and refusing to record it wouldn't undo
//   that, it would just make SnapCon's own model wrong. Persistence is then
//   attempted best-effort; failure marks the store globally degraded rather
//   than losing the update.
//
// All persistence is synchronous (fs.writeFileSync/renameSync, not the
// fs.promises variants) specifically so it can share one JS call stack with
// the state read+compute it follows — that's what makes claimNextForDispatch
// atomic under concurrent callers with no locking library: Node's event loop
// cannot interleave two synchronous blocks, even ones that include a
// blocking disk write.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QueueEngine = require("./QueueEngine");

function defaultPrinterState() {
  return {
    queueState: "unmanaged", queuePaused: false, queueStopped: false, reconciliationPending: false,
    attentionReason: null, attentionDetail: null,
    queue: [], currentItem: null, recentHistory: [], updatedAt: Date.now()
  };
}

// Blocks intent-driven (Category A) actions — recovery-required and
// stopped-by-admin are explicit human/operational conditions; storeDegraded
// blocks them too since durability can't be guaranteed for a NEW physical
// action while the shared file can't be written (Design doc Part D4/round-3
// issue #3 — treated as global, not per-printer, since one shared file means
// one write failure risks every printer's durability, not just whichever
// triggered it first).
// The default file access for computeFileHash: fs.promises, streamed.
const defaultFileIO = {
  async stat(p) { return fs.promises.stat(p); },
  hashFile(p) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash("sha256");
      fs.createReadStream(p).on("error", reject).on("data", c => h.update(c)).on("end", () => resolve({ sha256: h.digest("hex") }));
    });
  },
};

// Windows: replacing (rename over) or copying over a file another process has
// open fails at once with EPERM/EBUSY/EACCES, whatever share mode that process
// used — MoveFileEx cannot replace an open file — until it closes it. Seen when
// a script polled queue-data.json while SnapCon saved. A short, bounded,
// synchronous retry rides out such a hold (persistence must stay synchronous:
// see the header). Longer than that, the save fails exactly as before: the
// intent is not applied, the store is marked degraded and retried. Retrying a
// write never re-runs a transition, so it cannot duplicate a queue action.
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200];   // at most 385 ms in all
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withTransientRetry(op, label, { delays = RETRY_DELAYS_MS, sleep = sleepSync } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = op();
      if (attempt) console.log(`[queue] ${label} succeeded after ${attempt} retr${attempt === 1 ? "y" : "ies"} (the file was held open)`);
      return out;
    } catch (e) {
      if (!TRANSIENT_FS_CODES.has(e && e.code) || attempt >= delays.length) throw e;
      sleep(delays[attempt]);
    }
  }
}

// ---- Durable writes (queue durability fix) ----
// After a power loss both queue-data.json and its .bak were found at full
// length and all zero bytes: each save rewrote both within a millisecond and
// flushed neither file's content. The helpers below make a save ask for its
// bytes to be on disk before anything is replaced. What they cannot do: help
// when the storage underneath ignores flush requests.

// Every byte, or an error: writeSync may write fewer bytes than asked without
// throwing (a disk that fills). No progress is treated as "no space".
function writeAll(fsImpl, fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let off = 0;
  while (off < buf.length) {
    const n = fsImpl.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw Object.assign(new Error("No space left to write the queue file"), { code: "ENOSPC" });
    off += n;
  }
}
// Write, flush, close — all three must succeed, or this throws.
function writeFileDurably(fsImpl, file, data) {
  const fd = fsImpl.openSync(file, "w");
  let failed = true;
  try { writeAll(fsImpl, fd, data); fsImpl.fsyncSync(fd); failed = false; }
  finally {
    // A close error after a successful flush still fails the save; after an
    // earlier error, the earlier error is the one reported.
    try { fsImpl.closeSync(fd); } catch (e) { if (!failed) throw e; }
  }
}
// Flush a file that was just copied. Strict: a failure fails the save.
function flushFile(fsImpl, file) {
  const fd = fsImpl.openSync(file, "r+");
  let failed = true;
  try { fsImpl.fsyncSync(fd); failed = false; }
  finally { try { fsImpl.closeSync(fd); } catch (e) { if (!failed) throw e; } }
}
// Flush the folder so a rename survives a sudden stop. An error fails the save
// (fail closed: the rename may not be durable) — note that the rename HAS
// happened by then, see persist(). The flush is skipped, and the save still
// succeeds, in exactly two known "a folder cannot be flushed here" cases:
//   - Windows: never attempted. Windows has no flush for a folder handle (the
//     attempt is refused), so there is nothing to ask for.
//   - elsewhere, the flush call itself answering EINVAL, ENOTSUP, EOPNOTSUPP
//     or ENOSYS: what a filesystem that does not implement a folder flush
//     answers (fsync(2): "fd is bound to a special file which does not
//     support synchronization"; the other three all mean "not supported /
//     not implemented").
// Nothing else is skipped: not being able to open the folder (EACCES, EMFILE,
// ENOENT, …) and every other flush error (EIO, ENOSPC, EDQUOT, EROFS, ESTALE,
// EBADF, an unknown code, …) fail the save. Where the flush is skipped a
// completed save's rename is NOT known to survive a sudden stop; that is
// logged once per process and returned to the caller.
const DIR_FLUSH_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);
function flushDir(fsImpl, dir, platform) {
  if (platform === "win32") return { skipped: "win32" };
  const fd = fsImpl.openSync(dir, "r");
  try { fsImpl.fsyncSync(fd); }
  catch (e) { if (DIR_FLUSH_UNSUPPORTED.has(e && e.code)) return { skipped: e.code }; throw e; }
  // The flush was answered above; no data went through this handle, so a
  // close error says nothing about the save.
  finally { try { fsImpl.closeSync(fd); } catch { /* see above */ } }
  return { skipped: null };
}
// A store is a JSON object keyed by printer id. null, an array, a number or a
// string parse as JSON but are not a store.
const isStoreRoot = v => v !== null && typeof v === "object" && !Array.isArray(v);

// fsImpl / retry / platform: injectable for tests (default: node's fs, the
// delays above, the platform this runs on).
function createQueueStore({ baseDir, degradedRetryMs = 15000, fileIO = defaultFileIO, fsImpl = fs, retry = {}, platform = process.platform }) {
  const dataDir = path.join(baseDir, "data");
  const PRIMARY_PATH = path.join(dataDir, "queue-data.json");
  const BAK_PATH = PRIMARY_PATH + ".bak";
  const TMP_PATH = PRIMARY_PATH + ".tmp";
  // Present while a "both queue files are bad" recovery has not been
  // acknowledged. That recovery moves the bad files aside, so without this a
  // restart would find no queue files at all and take it for a first run.
  const MARKER_PATH = PRIMARY_PATH + ".recovery-required";

  let store = {}; // printerId -> PrinterQueueState — the authoritative in-memory state
  let storeDegraded = false;
  let storeStoppedByAdmin = false;
  let queueStoreRecoveryRequired = false;
  let corruptFilePaths = [];
  let degradedRetryTimer = null;
  // Saving is refused while this is set (see load()):
  //   { kind: "unreadable", detail }               a queue file exists but could not be read (permissions, I/O).
  //                                                 It is not known to be corrupt, so it is neither moved aside nor
  //                                                 written over. Cleared only by a restart.
  //   { kind: "corrupt-primary-in-place", detail } the backup was loaded and the bad primary is still in place; an
  //                                                 ordinary save would copy it over the good backup. The only save
  //                                                 allowed is the recovery save in persist(), which keeps a copy of
  //                                                 the bad file, replaces it and never touches the backup. Every
  //                                                 save attempt retries that, and clears this when it works.
  // (A third reason, kept separately because it can come with either of the
  // others or alone: leftoverTmp below, reported as "leftover-tmp-in-place".)
  // Reported through flags server.js and the UI already honour — storeDegraded
  // for both, plus queueStoreRecoveryRequired for "unreadable" (the queue shown
  // may be empty or old, so nothing may rely on it) — and, additively, through
  // saveBlocked / saveBlockedDetail in the status.
  let saveBlock = null;
  let setAsidePaths = [];   // files moved aside at start-up that are not part of a "both corrupt" recovery
  // Set by load() when a leftover temporary file may be the only copy of
  // something: { ts, failed }. Until it has been moved aside, nothing may be
  // saved — a save reuses the temporary file's name and would overwrite it.
  // Every save attempt tries the move again (keepLeftoverTmp); `failed` holds
  // the error code of the last attempt that could not.
  let leftoverTmp = null;
  let dirFlushSkipLogged = false;
  let recoveryCarriedOver = false;   // recovery-required came from the marker left by an earlier run

  function markDegraded(error) {
    storeDegraded = true;
    // A refused save is announced once, where the block is set — not on every retry.
    if (error && !error.saveBlocked) console.error("[queue] persist failed:", error.message);
    if (saveBlock && saveBlock.kind === "unreadable") return;   // nothing a retry could change
    if (!degradedRetryTimer) {
      degradedRetryTimer = setInterval(() => {
        if (!storeDegraded) { clearInterval(degradedRetryTimer); degradedRetryTimer = null; return; }
        retrySave();
      }, degradedRetryMs);
      if (degradedRetryTimer.unref) degradedRetryTimer.unref();
    }
  }

  // ---- Atomic persistence (design doc Part D2/D4, round-3 issue #2, round-4
  // issues #3-#4; flushes added by the queue durability fix) ----
  // 1. serialize + sanity round-trip
  // 2. write ALL of .tmp, flush it, close it          (new generation durable)
  // 3. copy the CURRENT primary over .bak, flush .bak  (skip if there is no
  //    primary yet — first save/post-reset; fail closed on any other error)
  // 4. atomic rename .tmp -> primary
  // 5. flush the folder (skipped only where a folder cannot be flushed — see flushDir)
  // Any failure returns { ok: false }: nothing claims the save happened.
  //
  // Which complete generation is on disk at each point, given that the
  // primary was valid and durable before the save started:
  //   during 2      primary (old), .bak (older)
  //   during 3      primary (old), flushed .tmp (new); .bak is being rewritten
  //   after 4       primary (new), .bak (old)
  // The very first save has no earlier generation: until step 4 is durable,
  // a stop leaves a first-run folder (see load()).
  function recoveryRequiredError() {
    return Object.assign(new Error("the queue store needs an admin's reset before it can be saved"), { code: "QUEUE_RECOVERY_REQUIRED", saveBlocked: true });
  }
  function saveBlockedError() {
    return Object.assign(new Error("queue saves are blocked: " + saveBlock.detail), { code: "QUEUE_SAVE_BLOCKED", saveBlocked: true });
  }
  // Keeps the bytes of a bad primary under another name (copy, then flush)
  // before the recovery save replaces it. A copy rather than a rename: the
  // primary's name never goes missing, so a stop at any point leaves "bad
  // primary + good backup", which this version and earlier ones both recover.
  function keepCorruptPrimaryCopy() {
    if (saveBlock.keptAs) return;
    const dest = saveBlock.dest || (saveBlock.dest = freeName(PRIMARY_PATH + ".corrupt-" + Date.now()));
    try {
      withTransientRetry(() => fsImpl.copyFileSync(PRIMARY_PATH, dest), "queue recovery (keeping the corrupt file)", retry);
      withTransientRetry(() => flushFile(fsImpl, dest), "queue recovery (keeping the corrupt file)", retry);
    } catch (e) { if (!(e && e.code === "ENOENT")) throw e; return; }   // ENOENT: it is gone — nothing to keep, nothing in the way
    saveBlock.keptAs = dest;
    setAsidePaths.push(dest);
  }
  // Moves a leftover temporary file found at start-up out of the way, keeping
  // its bytes. Throws when it is there and cannot be moved: the save that
  // called this then fails without having touched it.
  function keepLeftoverTmp() {
    if (!leftoverTmp) return;
    let dest;
    try { dest = moveAside(TMP_PATH, ".leftover-", leftoverTmp.ts); }
    catch (e) {
      const code = (e && e.code) || "error";
      if (!leftoverTmp.failed) console.error("[queue] an unfinished save (queue-data.json.tmp) could not be moved aside (" + code + ") — queue saves are blocked so that it is not overwritten");
      leftoverTmp.failed = code;
      throw Object.assign(new Error("queue saves are blocked: " + leftoverTmpDetail()), { code: "QUEUE_SAVE_BLOCKED", saveBlocked: true });
    }
    leftoverTmp = null;
    if (dest) { setAsidePaths.push(dest); console.warn("[queue] an unfinished save was found and kept as " + path.basename(dest) + " (not loaded)"); }
  }
  // The error code only — this text is shown to signed-in users.
  const leftoverTmpDetail = () => "an unfinished save (queue-data.json.tmp) could not be moved aside (" + leftoverTmp.failed + "); it is not overwritten";
  function persist(candidateStore, { forReset = false } = {}) {
    try {
      // While recovery is required nothing ordinary is saved: memory is a
      // placeholder, and a save would put a valid-looking queue file where the
      // evidence was. Only acknowledgeReset()'s own save of the empty store
      // passes (forReset), and it does so with the marker still in place.
      if (queueStoreRecoveryRequired && !forReset) throw recoveryRequiredError();
      if (saveBlock && saveBlock.kind === "unreadable") throw saveBlockedError();
      const replacingCorruptPrimary = !!saveBlock;
      const json = JSON.stringify(candidateStore, null, 2);
      if (!isStoreRoot(JSON.parse(json))) throw new Error("queue store is not an object"); // sanity check — throws before anything touches disk

      fsImpl.mkdirSync(dataDir, { recursive: true });
      keepLeftoverTmp();                                       // throws -> the save fails, the leftover is untouched
      if (replacingCorruptPrimary) keepCorruptPrimaryCopy();   // throws -> the save fails and stays blocked
      withTransientRetry(() => writeFileDurably(fsImpl, TMP_PATH, json), "queue save (temporary file)", retry);

      // The backup step is skipped when the primary on disk is known to be
      // bad: copying it would destroy the one good generation.
      if (!replacingCorruptPrimary) {
        let backedUp = true;
        try {
          withTransientRetry(() => fsImpl.copyFileSync(PRIMARY_PATH, BAK_PATH), "queue save (backup)", retry);
        } catch (e) {
          if (e.code !== "ENOENT") throw e; // exists but unreadable/uncopyable — fail closed, don't touch primary
          backedUp = false;                 // ENOENT: no primary yet — nothing to back up, expected on first save.
        }
        if (backedUp) withTransientRetry(() => flushFile(fsImpl, BAK_PATH), "queue save (backup flush)", retry);
      }

      withTransientRetry(() => fsImpl.renameSync(TMP_PATH, PRIMARY_PATH), "queue save", retry);
      if (replacingCorruptPrimary) saveBlock = null;   // the primary on disk is a valid generation again
      // If this throws, the save is reported as failed although the rename
      // happened: an intent is then not applied in memory while the file
      // already holds it, until the degraded retry rewrites the file from
      // memory. Deliberate (fail closed): the rename may not survive a stop.
      const flushed = flushDir(fsImpl, dataDir, platform);
      if (flushed.skipped && !dirFlushSkipLogged) {
        dirFlushSkipLogged = true;
        console.warn("[queue] this " + (flushed.skipped === "win32" ? "platform" : "folder's filesystem (" + flushed.skipped + ")") + " cannot flush a folder: a queue save that has completed is not guaranteed to survive a sudden power loss");
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ---- Reading a queue file: three different answers, never mixed up ----
  //   { missing: true }     it is not there
  //   { malformed: true }   it was read, and is not a store (not JSON, or JSON that is not an object)
  //   { readError: e }      it is there but could not be read now (permissions, I/O) — NOT known to be corrupt
  //   { value }             a store
  function readStoreFile(file) {
    let text;
    // The same short, bounded retry as the writes: on Windows another process
    // holding the file for a moment is not "unreadable".
    try { text = withTransientRetry(() => fsImpl.readFileSync(file, "utf8"), "queue load", retry); }
    // ENOTDIR: a path component is not a folder, so the file cannot exist either.
    catch (e) { return e && (e.code === "ENOENT" || e.code === "ENOTDIR") ? { missing: true } : { readError: e || new Error("read failed") }; }
    let v;
    try { v = JSON.parse(text); } catch { return { malformed: true }; }
    return isStoreRoot(v) ? { value: v } : { malformed: true };
  }
  // Rename out of the way, keeping the bytes. Returns the new path, or null
  // when the file is not there. Throws when it is there and cannot be moved.
  // A name nothing has yet: moving or copying a file aside must never land on
  // (and so replace) something kept earlier.
  function freeName(base) {
    let name = base;
    for (let i = 1; fsImpl.existsSync(name); i++) name = base + "-" + i;
    return name;
  }
  const moveAside = (file, suffix, ts) => moveTo(file, freeName(file + suffix + ts));
  function moveTo(file, dest) {
    try { withTransientRetry(() => fsImpl.renameSync(file, dest), "queue move aside", retry); }
    catch (e) { if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null; throw e; }   // not there (see readStoreFile)
    return dest;
  }
  // The leftover of an interrupted save is never loaded and never promoted: it
  // holds a save that was not committed. It is kept under another name when it
  // may be the only copy of something (failed recovery, interrupted first
  // save) — see keepLeftoverTmp(); if that cannot be done, saving is blocked.
  // ---- The recovery marker ----
  // null when there is none. Its presence is what counts: one that cannot be
  // read or understood still means "recovery was not acknowledged".
  function readMarker() {
    let text;
    try { text = withTransientRetry(() => fsImpl.readFileSync(MARKER_PATH, "utf8"), "queue load (recovery marker)", retry); }
    catch (e) { return e && (e.code === "ENOENT" || e.code === "ENOTDIR") ? null : { files: [] }; }
    try {
      const v = JSON.parse(text);
      // Names only, and only this store's own set-aside files: the marker is data read from disk.
      const ok = n => typeof n === "string" && n === path.basename(n) && n.startsWith("queue-data.json.");
      return { files: Array.isArray(v && v.files) ? v.files.filter(ok) : [] };
    } catch { return { files: [] }; }
  }
  // Written and flushed (file, then folder) BEFORE any bad file is moved
  // aside. Throws if that cannot be done — the caller then moves nothing, and
  // a restart finds the bad files where they were.
  function writeMarker(files, ts) {
    withTransientRetry(() => writeFileDurably(fsImpl, MARKER_PATH, JSON.stringify({ format: 1, since: ts, files }, null, 2)), "queue recovery marker", retry);
    flushDir(fsImpl, dataDir, platform);
  }
  function removeMarker() {
    try { withTransientRetry(() => fsImpl.unlinkSync(MARKER_PATH), "queue recovery marker (remove)", retry); }
    catch (e) { if (!(e && (e.code === "ENOENT" || e.code === "ENOTDIR"))) throw e; }
  }
  function blockUnreadable(detail) {
    saveBlock = { kind: "unreadable", detail };
    storeDegraded = true;
    // Also "recovery required" for everything that already honours that flag
    // (dispatch, the file-delete guard, the banner): the queue held in memory
    // may be empty or old. A reset is refused — see acknowledgeReset().
    queueStoreRecoveryRequired = true;
    console.error("[queue] " + detail + " — queue saves and queue automation are blocked until this is fixed and SnapCon is restarted; nothing was moved or overwritten");
  }

  // ---- Startup load ----
  //   primary valid                         -> use it
  //   primary malformed, backup valid       -> use the backup; the next save would copy the bad primary over it, so
  //                                            saving is blocked except for the recovery save (keep a copy of the
  //                                            bad file, replace it, leave the backup alone), tried at once
  //   primary missing, backup valid         -> use the backup, and write the primary again from it
  //   neither file exists                   -> first run
  //   no valid file, at least one malformed -> global recovery-required; a marker is written, then every file is kept
  //                                            under another name (nothing is moved if the marker cannot be written)
  //   any needed file unreadable            -> saves blocked; nothing moved, nothing written, no reset offered
  //   recovery marker present               -> recovery-required carried over from the earlier run, whatever the queue
  //                                            files look like now; no queue file is loaded, moved or written (a
  //                                            leftover temporary file is moved aside, as everywhere else)
  function load() {
    saveBlock = null; setAsidePaths = []; corruptFilePaths = []; leftoverTmp = null;
    queueStoreRecoveryRequired = false; recoveryCarriedOver = false;
    const ts = Date.now();
    // The error code only: the message carries the server's full path, and
    // this text is shown to signed-in users.
    const describe = (file, e) => path.basename(file) + " could not be read (" + ((e && e.code) || "error") + ")";

    const marker = readMarker();
    if (marker) {
      // An admin has not acknowledged the earlier recovery. Queue files that
      // are here now (restored by hand, written by an older SnapCon, or left by
      // a stop in the middle of that recovery) are not taken into use and not
      // touched; a reset moves them aside before it writes anything.
      store = {};
      for (const file of [PRIMARY_PATH, BAK_PATH]) {
        const r = readStoreFile(file);
        if (r.readError) { blockUnreadable(describe(file, r.readError)); break; }   // a reset is refused too, as for any unreadable file
      }
      queueStoreRecoveryRequired = true; recoveryCarriedOver = true;
      corruptFilePaths = marker.files.map(n => path.join(dataDir, n)).filter(f => fsImpl.existsSync(f));
      leftoverTmp = { ts, failed: null };
      try { keepLeftoverTmp(); } catch { storeDegraded = true; }
      console.error("[queue] an unacknowledged queue recovery was carried over from before the restart (" + path.basename(MARKER_PATH) + " is present) — all queue automation stays disabled until an admin acknowledges a reset. Queue files now in the data folder are not used; a reset moves them aside. To use them instead: stop SnapCon, delete that marker file, start it again");
      return;
    }

    const primary = readStoreFile(PRIMARY_PATH);
    if (primary.value) {
      store = primary.value;
      try { fsImpl.unlinkSync(TMP_PATH); } catch { /* none, or it stays until the next save overwrites it */ }
      return;
    }

    const backup = readStoreFile(BAK_PATH);
    if (primary.readError) {
      // Shown from the backup when there is one, but nothing may be saved:
      // the primary is not known to be corrupt and must not be replaced.
      store = backup.value || {};
      blockUnreadable(describe(PRIMARY_PATH, primary.readError));
      return;
    }
    if (backup.readError) {
      store = {};
      blockUnreadable(describe(BAK_PATH, backup.readError) + (primary.malformed ? "; queue-data.json is not a valid queue file" : "; queue-data.json is missing"));
      return;
    }

    if (backup.value) {
      store = backup.value;
      // An unfinished save found next to a bad or missing primary may be the
      // newest thing there is: the recovery save below moves it aside before
      // it reuses the temporary file's name, and fails — leaving it, and the
      // primary, untouched — if it cannot. Never loaded.
      leftoverTmp = { ts, failed: null };
      if (primary.malformed) saveBlock = { kind: "corrupt-primary-in-place", detail: "queue-data.json is corrupt and still in place; the backup was loaded" };
      const result = persist(store);
      if (result.ok) {
        console.warn(primary.malformed ? "[queue] primary queue-data.json was corrupt — recovered from backup" : "[queue] queue-data.json was missing — loaded from backup");
      } else {
        if (saveBlock && !(leftoverTmp && leftoverTmp.failed)) console.error("[queue] " + saveBlock.detail + ", but the corrupt file could not be replaced yet — queue saves are blocked so that it is never copied over the backup");
        markDegraded(result.error);   // retried on the usual timer
      }
      return;
    }

    if (primary.missing && backup.missing) {
      // First run — nothing to load, not an error. A leftover temporary file
      // here is a first save that never completed: kept, not loaded.
      store = {};
      leftoverTmp = { ts, failed: null };
      try { keepLeftoverTmp(); } catch (e) { markDegraded(e); }   // blocked; tried again on the usual timer
      return;
    }

    // No valid generation, and at least one file that is not a store — a
    // store-level failure, not a per-printer recovery mismatch. Never
    // silently synthesize an empty queue and continue as if nothing happened
    // (design doc Part B, round-3 issue #8).
    store = {};
    queueStoreRecoveryRequired = true;
    // The marker first, so that the recovery outlives a restart; only then
    // are the files moved. If the marker cannot be made durable they stay
    // where they are, and a restart reaches this branch again from them.
    const plan = [];
    if (!primary.missing) plan.push([PRIMARY_PATH, freeName(PRIMARY_PATH + ".corrupt-" + ts)]);
    if (!backup.missing) plan.push([BAK_PATH, freeName(BAK_PATH + ".corrupt-" + ts)]);
    let markerWritten = false;
    try { writeMarker(plan.map(([, dest]) => path.basename(dest)), ts); markerWritten = true; }
    catch (e) { console.error("[queue] the recovery marker could not be written (" + ((e && e.code) || "error") + ") — the corrupt queue files are left in place"); }
    if (markerWritten) for (const [file, dest] of plan) {
      // One that cannot be moved stays in place; a reset moves it, or is refused.
      try { if (moveTo(file, dest)) corruptFilePaths.push(dest); }
      catch (e) { console.error("[queue] " + path.basename(file) + " could not be moved aside (" + ((e && e.code) || "error") + ") — left in place"); }
    }
    leftoverTmp = { ts, failed: null };
    try { keepLeftoverTmp(); } catch { storeDegraded = true; }   // blocked; a reset is refused until it can be moved
    console.error("[queue] queue-data.json and its backup are both corrupt — all queue automation disabled until an admin acknowledges a reset");
  }

  function getPrinterState(printerId) {
    return store[printerId] || defaultPrinterState();
  }

  function blockedReason() {
    if (queueStoreRecoveryRequired) return "recovery-required";
    if (storeDegraded) return "store-degraded";
    if (storeStoppedByAdmin) return "stopped-by-admin";
    return null;
  }

  // ---- Category A: single-printer intent-driven transitions. `transitionFn`
  // is one of QueueEngine's plain (state, ...args) => nextState functions —
  // it may throw if the precondition doesn't hold, which is surfaced as-is. ----
  function applyIntent(printerId, transitionFn, ...args) {
    const blocked = blockedReason();
    if (blocked) return { ok: false, reason: blocked };
    const current = getPrinterState(printerId);
    let nextState;
    try { nextState = transitionFn(current, ...args); }
    catch (e) { return { ok: false, reason: "invalid-transition", error: e }; }
    const candidateStore = { ...store, [printerId]: nextState };
    const result = persist(candidateStore);
    if (!result.ok) { markDegraded(result.error); return { ok: false, reason: "persist-failed", error: result.error }; }
    storeDegraded = false;
    store = candidateStore;
    return { ok: true, nextState };
  }

  // The claim is Category A too, but claimTransition's return shape
  // ({canClaim, item, nextState}) doesn't fit applyIntent's plain-nextState
  // contract, so it gets its own coordinator — this is the ONE function
  // allowed to move a printer's queueState out of "idle" (design doc Part C).
  function claimNextForDispatch(printerId) {
    const blocked = blockedReason();
    if (blocked) return { claimed: false, reason: blocked };
    const current = getPrinterState(printerId);
    const { canClaim, item, reason, nextState } = QueueEngine.claimTransition(current);
    if (!canClaim) return { claimed: false, reason };
    const candidateStore = { ...store, [printerId]: nextState };
    const result = persist(candidateStore);
    if (!result.ok) { markDegraded(result.error); return { claimed: false, reason: "persist-failed", error: result.error }; }
    storeDegraded = false;
    store = candidateStore;
    return { claimed: true, item, printerState: nextState };
  }

  // confirmManualBedClear returns {nextState, auditEvent} instead of a plain
  // nextState — its own coordinator for the same reason claim needs one.
  function confirmManualBedClear(printerId, actor) {
    const blocked = blockedReason();
    if (blocked) return { ok: false, reason: blocked };
    const current = getPrinterState(printerId);
    let nextState, auditEvent;
    try { ({ nextState, auditEvent } = QueueEngine.confirmManualBedClear(current, actor)); }
    catch (e) { return { ok: false, reason: "invalid-transition", error: e }; }
    const candidateStore = { ...store, [printerId]: nextState };
    const result = persist(candidateStore);
    if (!result.ok) { markDegraded(result.error); return { ok: false, reason: "persist-failed", error: result.error }; }
    storeDegraded = false;
    store = candidateStore;
    return { ok: true, nextState, auditEvent };
  }

  // ---- Category A, multi-printer: bulk enqueue / bulk profile actions
  // (round-4 issue #2). `computeAllFn(currentStore)` must have already
  // validated everything the caller needs to before this is called — it
  // returns { [printerId]: nextState, ... } for every printer it touches,
  // computed against the CURRENT store snapshot it's handed, never mutating
  // anything directly. One persist for the whole transaction; all-or-nothing
  // commit. ----
  function applyBulkIntent(computeAllFn) {
    const blocked = blockedReason();
    if (blocked) return { ok: false, reason: blocked };
    let updates;
    try { updates = computeAllFn(store); }
    catch (e) { return { ok: false, reason: "invalid-transition", error: e }; }
    const candidateStore = { ...store, ...updates };
    const result = persist(candidateStore);
    if (!result.ok) { markDegraded(result.error); return { ok: false, reason: "persist-failed", error: result.error }; }
    storeDegraded = false;
    store = candidateStore;
    return { ok: true, updates };
  }

  // ---- Category B: observed physical events. Memory is updated
  // unconditionally (it's recording something that already happened);
  // persistence is attempted best-effort afterward. ----
  function applyObserved(printerId, transitionFn, ...args) {
    const current = getPrinterState(printerId);
    const nextState = transitionFn(current, ...args);
    const candidateStore = { ...store, [printerId]: nextState };
    store = candidateStore; // committed regardless of persist outcome — see module header
    // Recovery required: recorded in memory only (a reset discards it), never
    // written, and not a save failure — there is nothing for a retry to do.
    if (queueStoreRecoveryRequired) return { ok: true, nextState, persisted: false };
    const result = persist(candidateStore);
    if (!result.ok) { markDegraded(result.error); return { ok: true, nextState, persisted: false }; }
    storeDegraded = false;
    return { ok: true, nextState, persisted: true };
  }

  // reconciliationPending is informational, not gating (design doc Part B) —
  // still routed through the same commit-then-persist shape as any other
  // observed update for consistency, just without needing QueueEngine's
  // involvement (it's a single-field flip, not a state transition).
  function setReconciliationPending(printerId, pending) {
    return applyObserved(printerId, (state) => ({ ...state, reconciliationPending: pending, updatedAt: Date.now() }));
  }

  // Assigning/unassigning a Printer Pool — trivial enough not to need a
  // dedicated QueueEngine export; validation (e.g. "queue must be empty to
  // unassign") is the caller's (server.js route's) responsibility.
  function assignPool(printerId) {
    return applyIntent(printerId, (state) => ({ ...defaultPrinterState(), ...state, queueState: "idle", updatedAt: Date.now() }));
  }
  function unassignPool(printerId) {
    return applyIntent(printerId, (state) => ({ ...state, queueState: "unmanaged", updatedAt: Date.now() }));
  }
  // Several printers in ONE save: all of them, or none (Queue Management
  // being switched on, and its undo). Same result shape as applyBulkIntent.
  function assignPoolMany(printerIds) {
    return applyBulkIntent(current => Object.fromEntries(printerIds.map(id =>
      [id, { ...defaultPrinterState(), ...(current[id] || {}), queueState: "idle", updatedAt: Date.now() }])));
  }
  function unassignPoolMany(printerIds) {
    return applyBulkIntent(current => Object.fromEntries(printerIds.map(id =>
      [id, { ...(current[id] || defaultPrinterState()), queueState: "unmanaged", updatedAt: Date.now() }])));
  }

  // ---- Global store-level controls (round-4 issue #1) ----
  function retrySave() {
    // While recovery is required, memory is an empty placeholder: saving it
    // would put a valid empty queue file on disk without anyone having
    // acknowledged a reset. Only the leftover temporary file is dealt with;
    // the store stays as it is until acknowledgeReset().
    if (queueStoreRecoveryRequired) {
      try { keepLeftoverTmp(); } catch (e) { return { ok: false, error: e }; }
      return { ok: false, error: persist(store).error };   // refused by persist() itself: never ok here
    }
    const result = persist(store);
    if (result.ok) { storeDegraded = false; return { ok: true }; }
    markDegraded(result.error);
    return { ok: false, error: result.error };
  }
  function stopAll() { storeStoppedByAdmin = true; }
  function resumeAll() { storeStoppedByAdmin = false; }
  function acknowledgeReset(confirmText) {
    if (confirmText !== "RESET") return { ok: false, error: "Confirmation text did not match", code: "reset_confirm_mismatch" };
    // A reset writes an empty store over the queue file. Never over one that
    // could not be read, or while the good backup is at risk.
    if (saveBlock) return { ok: false, error: "The queue file cannot be reset now: " + saveBlock.detail, code: "queue_store_save_blocked" };
    // Nor over an unfinished save that cannot be kept: checked before anything is reset.
    try { keepLeftoverTmp(); } catch { return { ok: false, error: "The queue file cannot be reset now: " + leftoverTmpDetail(), code: "queue_store_save_blocked" }; }
    // From here the reset is done in four steps, each made durable (its
    // folder flushed) before the next starts, all under the recovery marker:
    //   1. the marker is on disk (written now if this is an ordinary reset);
    //   2. the queue files still in place are moved aside — the backup first;
    //   3. the empty queue file is written;
    //   4. the marker is removed.
    // Whatever stops or fails after step 1, a restart finds the marker and
    // loads no queue file: never the queue being reset, never the backup's
    // older one — also on storage that keeps unflushed name changes out of
    // order, since no two steps share a flush. A failure answers ok:false and
    // leaves recovery required (in memory as on disk); nothing is written
    // over, and asking again repeats the steps that are still open.
    const ts = Date.now();
    const hadMarker = fsImpl.existsSync(MARKER_PATH);
    try {
      if (hadMarker) flushDir(fsImpl, dataDir, platform);
      else { fsImpl.mkdirSync(dataDir, { recursive: true }); writeMarker([], ts); }
    } catch (e) {
      // "Nothing was changed" is answered only when it is true of the disk: an
      // ordinary reset whose marker file was never created. A marker that
      // exists but could not be flushed is left where it is — taking it away
      // again would be one more unflushed change — and recovery is required
      // from now, as a restart that finds it would require. A restart that
      // does not find it loads the queue as it was (the current one).
      if (!hadMarker && !queueStoreRecoveryRequired && !fsImpl.existsSync(MARKER_PATH))
        return { ok: false, error: "The queue file cannot be reset now: the reset could not be started (" + ((e && e.code) || "error") + "); nothing was changed", code: "queue_store_save_blocked" };
      return resetIncomplete("the recovery marker could not be confirmed on disk, so after a restart the queue may be back as it was", e);
    }
    let doing = null;
    try {
      // The backup first: were the primary moved and the backup not, the
      // backup would be the newest queue file left in place.
      for (const file of [BAK_PATH, PRIMARY_PATH]) { doing = path.basename(file) + " could not be moved aside"; const dest = moveAside(file, ".before-reset-", ts); if (dest) setAsidePaths.push(dest); }
      doing = "the moves could not be made durable"; flushDir(fsImpl, dataDir, platform);
      doing = "the empty queue file could not be saved";
      const saved = persist({}, { forReset: true });
      if (!saved.ok) throw saved.error;
      doing = path.basename(MARKER_PATH) + " could not be removed"; removeMarker();
      doing = "the marker's removal could not be made durable"; flushDir(fsImpl, dataDir, platform);
    } catch (e) {
      return resetIncomplete(doing, e);
    }
    store = {};
    queueStoreRecoveryRequired = false; recoveryCarriedOver = false;
    corruptFilePaths = [];
    storeDegraded = false;
    return { ok: true };
  }
  // The reset began and did not finish. The live queue (if this was an
  // ordinary reset) is no longer used: the marker says so on disk, and memory
  // must not say otherwise. The error code only — this text is shown to users.
  function resetIncomplete(what, e) {
    store = {};
    queueStoreRecoveryRequired = true;
    console.error("[queue] a queue reset did not complete: " + what + " (" + ((e && e.code) || (e && e.message) || "error") + ") — queue recovery stays required; no file was overwritten");
    return { ok: false, code: "queue_reset_incomplete", error: "The queue reset did not complete: " + what + " (" + ((e && e.code) || "error") + "). Queue recovery is still required and no file was overwritten. Fix the problem, then reset again." };
  }
  function getGlobalStatus() {
    const unreadable = !!(saveBlock && saveBlock.kind === "unreadable");
    return {
      storeDegraded, storeStoppedByAdmin, queueStoreRecoveryRequired, corruptFilePaths: corruptFilePaths.slice(),
      // Additive (queue durability fix): why saving is refused, if it is, and
      // what start-up moved aside outside a "both corrupt" recovery.
      // An unreadable file is named first — a save and a reset are both refused
      // for it before anything else is looked at — then the unmovable leftover.
      saveBlocked: unreadable ? "unreadable" : leftoverTmp && leftoverTmp.failed ? "leftover-tmp-in-place" : (saveBlock ? saveBlock.kind : null),
      saveBlockedDetail: unreadable ? saveBlock.detail : leftoverTmp && leftoverTmp.failed ? leftoverTmpDetail() : (saveBlock ? saveBlock.detail : null),
      setAsidePaths: setAsidePaths.slice(),
      recoveryCarriedOver,
    };
  }
  function getCorruptFilePath(name) {
    return corruptFilePaths.find(p => path.basename(p).startsWith(name)) || null;
  }

  // ---- File-hash verification (design doc Part B/D6, round-3 issue #4,
  // round-4 issue #7) — lives here, not QueueEngine, since it needs fs
  // access. Cached by (size, mtime) for the routine pre-dispatch check;
  // `force` bypasses the cache for the moments identity itself is actually
  // in question (resolving file-changed, accepting a replacement, retrying
  // a previously-failed job). ----
  // Asynchronous, and the file is streamed: it often lives on a NAS, where a
  // synchronous read on the main thread froze the whole server for ~21 s per
  // call with the share unreachable (measured on Windows), and a whole-file
  // read of a large job blocked it for the length of the read even when
  // healthy. server.js passes netfs (worker threads); the default streams.
  const FILE_HASH_CACHE = new Map(); // absPath -> { size, mtimeMs, sha256 }
  async function computeFileHash(absPath, { force = false } = {}) {
    const st = await fileIO.stat(absPath); // rejects (ENOENT etc.) if missing — caller handles
    if (!force) {
      const cached = FILE_HASH_CACHE.get(absPath);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        return { sizeBytes: cached.size, sha256: cached.sha256 };
      }
    }
    const { sha256 } = await fileIO.hashFile(absPath);
    FILE_HASH_CACHE.set(absPath, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
    return { sizeBytes: st.size, sha256 };
  }

  return {
    load, getPrinterState,
    applyIntent, applyBulkIntent, applyObserved,
    claimNextForDispatch, confirmManualBedClear,
    setReconciliationPending, assignPool, unassignPool, assignPoolMany, unassignPoolMany,
    retrySave, stopAll, resumeAll, acknowledgeReset, getGlobalStatus, getCorruptFilePath,
    computeFileHash
  };
}

module.exports = { createQueueStore, defaultPrinterState, durable: { writeFileDurably, flushDir }, _internal: { withTransientRetry, TRANSIENT_FS_CODES, RETRY_DELAYS_MS } };

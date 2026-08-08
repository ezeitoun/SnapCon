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
function createQueueStore({ baseDir, degradedRetryMs = 15000 }) {
  const dataDir = path.join(baseDir, "data");
  const PRIMARY_PATH = path.join(dataDir, "queue-data.json");
  const BAK_PATH = PRIMARY_PATH + ".bak";
  const TMP_PATH = PRIMARY_PATH + ".tmp";

  let store = {}; // printerId -> PrinterQueueState — the authoritative in-memory state
  let storeDegraded = false;
  let storeStoppedByAdmin = false;
  let queueStoreRecoveryRequired = false;
  let corruptFilePaths = [];
  let degradedRetryTimer = null;

  function markDegraded(error) {
    storeDegraded = true;
    if (error) console.error("[queue] persist failed:", error.message);
    if (!degradedRetryTimer) {
      degradedRetryTimer = setInterval(() => {
        if (!storeDegraded) { clearInterval(degradedRetryTimer); degradedRetryTimer = null; return; }
        retrySave();
      }, degradedRetryMs);
      if (degradedRetryTimer.unref) degradedRetryTimer.unref();
    }
  }

  // ---- Atomic, crash-safe persistence (design doc Part D2/D4, round-3
  // issue #2, round-4 issues #3-#4) ----
  // 1. serialize + sanity round-trip, 2. write .tmp, 3. back up the CURRENT
  // primary (skip if it doesn't exist yet — first save/post-reset; fail
  // closed if it exists but can't be read), 4. atomic rename, 5. best-effort
  // directory fsync (POSIX only, never fatal).
  function persist(candidateStore) {
    try {
      const json = JSON.stringify(candidateStore, null, 2);
      JSON.parse(json); // sanity check — throws before anything touches disk if this is somehow unserializable

      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(TMP_PATH, json);

      try {
        fs.copyFileSync(PRIMARY_PATH, BAK_PATH);
      } catch (e) {
        if (e.code !== "ENOENT") throw e; // exists but unreadable/uncopyable — fail closed, don't touch primary
        // ENOENT: no primary yet — nothing to back up, expected on first save.
      }

      fs.renameSync(TMP_PATH, PRIMARY_PATH);

      try {
        const fd = fs.openSync(dataDir, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch { /* no directory-fsync support on this platform/filesystem — not fatal */ }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ---- Startup load, with a corrupt-primary→backup fallback chain, and a
  // global (not per-printer) recovery-required condition if both fail ----
  function load() {
    try { if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH); } catch {}

    const tryParse = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };

    if (!fs.existsSync(PRIMARY_PATH)) { store = {}; return; } // first run — nothing to load, not an error

    let loaded = tryParse(PRIMARY_PATH);
    if (loaded === undefined) {
      loaded = tryParse(BAK_PATH);
      if (loaded !== undefined) console.warn("[queue] primary queue-data.json was corrupt — recovered from backup");
    }

    if (loaded === undefined) {
      // Both primary and backup are unreadable — a store-level failure, not
      // a per-printer recovery mismatch. Never silently synthesize an empty
      // queue and continue as if nothing happened (design doc Part B,
      // round-3 issue #8).
      const ts = Date.now();
      corruptFilePaths = [];
      try { if (fs.existsSync(PRIMARY_PATH)) { const dest = PRIMARY_PATH + ".corrupt-" + ts; fs.renameSync(PRIMARY_PATH, dest); corruptFilePaths.push(dest); } } catch {}
      try { if (fs.existsSync(BAK_PATH)) { const dest = BAK_PATH + ".corrupt-" + ts; fs.renameSync(BAK_PATH, dest); corruptFilePaths.push(dest); } } catch {}
      queueStoreRecoveryRequired = true;
      console.error("[queue] queue-data.json and its backup are both corrupt — all queue automation disabled until an admin acknowledges a reset");
      store = {};
      return;
    }

    store = loaded || {};
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

  // ---- Global store-level controls (round-4 issue #1) ----
  function retrySave() {
    const result = persist(store);
    if (result.ok) { storeDegraded = false; return { ok: true }; }
    markDegraded(result.error);
    return { ok: false, error: result.error };
  }
  function stopAll() { storeStoppedByAdmin = true; }
  function resumeAll() { storeStoppedByAdmin = false; }
  function acknowledgeReset(confirmText) {
    if (confirmText !== "RESET") return { ok: false, error: "Confirmation text did not match" };
    store = {};
    queueStoreRecoveryRequired = false;
    corruptFilePaths = [];
    const result = persist(store);
    if (!result.ok) markDegraded(result.error); else storeDegraded = false;
    return { ok: true };
  }
  function getGlobalStatus() {
    return { storeDegraded, storeStoppedByAdmin, queueStoreRecoveryRequired, corruptFilePaths: corruptFilePaths.slice() };
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
  const FILE_HASH_CACHE = new Map(); // absPath -> { size, mtimeMs, sha256 }
  function computeFileHash(absPath, { force = false } = {}) {
    const st = fs.statSync(absPath); // throws (ENOENT etc.) if missing — caller handles
    if (!force) {
      const cached = FILE_HASH_CACHE.get(absPath);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        return { sizeBytes: cached.size, sha256: cached.sha256 };
      }
    }
    const buf = fs.readFileSync(absPath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    FILE_HASH_CACHE.set(absPath, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
    return { sizeBytes: st.size, sha256 };
  }

  return {
    load, getPrinterState,
    applyIntent, applyBulkIntent, applyObserved,
    claimNextForDispatch, confirmManualBedClear,
    setReconciliationPending, assignPool, unassignPool,
    retrySave, stopAll, resumeAll, acknowledgeReset, getGlobalStatus, getCorruptFilePath,
    computeFileHash
  };
}

module.exports = { createQueueStore, defaultPrinterState };

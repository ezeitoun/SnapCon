// queue/QueueEngine.js — pure state-transition logic for Queue Management.
// Every export here is (state, ...args) => result, with zero I/O — no fs, no
// network, no Express. QueueStore.js is the only module that owns/mutates
// authoritative state or touches disk; this module only ever computes what
// the NEXT state should look like, given the current one. That split exists
// specifically so atomicity (see QueueStore.claimNextForDispatch) comes from
// a real stateful coordinator, not from calling a "pure" function twice and
// hoping — a genuinely pure function has no shared state to race over, which
// means it can't provide atomicity on its own no matter how it's called.
//
// The one exception to "no I/O" is id generation (crypto.randomBytes) for
// items this module creates (retries) — matches the newPrinterId/newGroupId
// precedent elsewhere in this codebase; it's a self-contained concern with no
// external state to synchronize, not the same thing as file/network I/O.
const crypto = require("crypto");

const newQueueItemId = () => "qi_" + crypto.randomBytes(6).toString("hex");

const QUEUE_STATES = Object.freeze([
  "unmanaged", "idle", "dispatching", "printing",
  "awaiting_bed_clear", "bed_clear_running", "queue_attention_required"
]);

const ATTENTION_REASONS = Object.freeze([
  "print-failed", "dispatch-failed", "bed-clear-failed",
  "file-missing", "file-changed", "pool-invalid",
  "recovery-mismatch", "recovery-interrupted", "recovery-unknown-outcome"
]);

// Legal resolveAttention() actions per reason — deliberately narrow (e.g.
// "resume" is nonsensical for dispatch-failed, since nothing was ever
// printing). "use-current-file" isn't listed anywhere: it needs a fresh
// hash/size the generic action dispatch has no way to carry, so it's its own
// function (acceptFileChange) instead of a resolveAttention() action.
const RESOLUTIONS_BY_REASON = Object.freeze({
  "print-failed": ["resume", "retry", "skip", "stop"],
  "dispatch-failed": ["retry", "skip", "stop"],
  "bed-clear-failed": ["retry-bed-clear", "skip-bed-clear", "stop"],
  "file-missing": ["skip", "stop"],
  "file-changed": ["skip", "stop"],
  "pool-invalid": ["stop"], // reassignment happens outside the queue engine — see onPoolReassigned
  "recovery-mismatch": ["acknowledge", "stop"],
  "recovery-interrupted": ["retry", "skip", "stop"],
  "recovery-unknown-outcome": ["resume", "retry", "skip", "stop"]
});

// Reasons that mean "this item never actually started printing" — the only
// case where bed-clear can be skipped on Retry/Skip (the per-pool
// bedClearOnDispatchFailure toggle only ever applies here). Every other
// reason implies the printer reached "printing" at some point, so bed-clear
// is mandatory regardless of any toggle.
const NEVER_PRINTED_REASONS = Object.freeze(["dispatch-failed", "file-missing", "file-changed"]);

const MAX_RECENT_HISTORY = 20;
function pushHistory(history, item) {
  if (!item) return history;
  const next = [...history, item];
  return next.length > MAX_RECENT_HISTORY ? next.slice(next.length - MAX_RECENT_HISTORY) : next;
}

function attentionState(state, reason, detail) {
  return { ...state, queueState: "queue_attention_required", attentionReason: reason, attentionDetail: detail || null, updatedAt: Date.now() };
}

// ---- Claim (the one function whose result QueueStore treats as a
// candidate-to-persist-then-commit, never a direct mutation — see
// QueueStore.claimNextForDispatch for why atomicity lives there, not here) ----
function claimTransition(state) {
  if (state.queueState !== "idle") return { canClaim: false, reason: "not-idle" };
  if (state.queuePaused) return { canClaim: false, reason: "paused" };
  if (state.queueStopped) return { canClaim: false, reason: "stopped" };
  if (!state.queue.length) return { canClaim: false, reason: "empty" };
  const [item, ...rest] = state.queue;
  const claimedItem = { ...item, status: "dispatching" };
  const nextState = { ...state, queueState: "dispatching", queue: rest, currentItem: claimedItem, updatedAt: Date.now() };
  return { canClaim: true, item: claimedItem, nextState };
}

// ---- Dispatch outcome (Category B — the upload/start call already
// happened; this just records what it reported) ----
function onDispatchSuccess(state, itemId) {
  if (state.queueState !== "dispatching" || !state.currentItem || state.currentItem.id !== itemId) {
    throw new Error("onDispatchSuccess: no matching dispatching item");
  }
  return { ...state, queueState: "printing", currentItem: { ...state.currentItem, status: "printing", dispatchedAt: Date.now() }, updatedAt: Date.now() };
}

function onDispatchFailure(state, itemId, error) {
  if (state.queueState !== "dispatching" || !state.currentItem || state.currentItem.id !== itemId) {
    throw new Error("onDispatchFailure: no matching dispatching item");
  }
  const failedItem = { ...state.currentItem, status: "failed", finishedAt: Date.now() };
  return {
    ...state,
    queueState: "queue_attention_required",
    attentionReason: "dispatch-failed",
    attentionDetail: { code: (error && error.code) || "dispatch-error", message: (error && error.message) || "Dispatch failed", resumable: false },
    currentItem: failedItem,
    recentHistory: pushHistory(state.recentHistory, failedItem),
    updatedAt: Date.now()
  };
}

// A pre-dispatch file-hash mismatch (QueueStore verifies before ever calling
// uploadFile) — same dispatching->attention shape as onDispatchFailure, but
// distinct reasons since the resolution options genuinely differ (there's no
// "current file" to fall back to for file-missing, and file-changed offers
// its own dedicated accept path — see acceptFileChange).
function onFileVerificationFailed(state, itemId, kind, detail) {
  if (state.queueState !== "dispatching" || !state.currentItem || state.currentItem.id !== itemId) {
    throw new Error("onFileVerificationFailed: no matching dispatching item");
  }
  return attentionState(state, kind === "missing" ? "file-missing" : "file-changed", detail);
}

// ---- Print outcome (Category B) ----
function onProbeComplete(state) {
  if (state.queueState !== "printing" || !state.currentItem) throw new Error("onProbeComplete: not printing");
  const completedItem = { ...state.currentItem, status: "completed", finishedAt: Date.now() };
  return { ...state, queueState: "awaiting_bed_clear", currentItem: completedItem, recentHistory: pushHistory(state.recentHistory, completedItem), updatedAt: Date.now() };
}

function onProbeFailedOrCancelled(state, resumable, detail) {
  if (state.queueState !== "printing" || !state.currentItem) throw new Error("onProbeFailedOrCancelled: not printing");
  const failedItem = { ...state.currentItem, status: "failed", finishedAt: Date.now() };
  return {
    ...state,
    queueState: "queue_attention_required",
    attentionReason: "print-failed",
    attentionDetail: { code: (detail && detail.code) || "print-failed", message: (detail && detail.message) || "Print failed or was cancelled", resumable: !!resumable },
    currentItem: failedItem,
    recentHistory: pushHistory(state.recentHistory, failedItem),
    updatedAt: Date.now()
  };
}

// ---- Bed-clear lifecycle ----
// Starting is Category A (about to fire a macro/API call — QueueStore
// persists this candidate before actually calling queue/BedClear.js).
// Success/failure are Category B (recording what that already-fired call
// reported).
function onBedClearStarted(state) {
  if (state.queueState !== "awaiting_bed_clear") throw new Error("onBedClearStarted: not awaiting_bed_clear");
  return { ...state, queueState: "bed_clear_running", updatedAt: Date.now() };
}
function onBedClearSuccess(state) {
  if (state.queueState !== "bed_clear_running") throw new Error("onBedClearSuccess: not bed_clear_running");
  return { ...state, queueState: "idle", currentItem: null, updatedAt: Date.now() };
}
function onBedClearFailure(state, error) {
  if (state.queueState !== "bed_clear_running") throw new Error("onBedClearFailure: not bed_clear_running");
  return {
    ...state,
    queueState: "queue_attention_required",
    attentionReason: "bed-clear-failed",
    attentionDetail: { code: (error && error.code) || "bed-clear-error", message: (error && error.message) || "Bed-clear failed", resumable: false },
    updatedAt: Date.now()
  };
}

function buildRetryItem(original) {
  return {
    id: newQueueItemId(),
    status: "queued",
    alreadyUploaded: false,
    file: { name: original.file.name, sub: original.file.sub, sizeBytes: original.file.sizeBytes, sha256: original.file.sha256 },
    map: original.map, prefs: original.prefs,
    createdAt: Date.now(), dispatchedAt: null, finishedAt: null,
    queuedBy: original.queuedBy,
    retryOfItemId: original.id,
    dispatchSnapshot: null
  };
}

// ---- Resolving queue_attention_required (Category A — persisted before
// whatever it triggers proceeds) ----
function resolveAttention(state, action) {
  if (state.queueState !== "queue_attention_required") throw new Error("resolveAttention: not in attention state");
  const reason = state.attentionReason;
  const legal = RESOLUTIONS_BY_REASON[reason] || [];
  if (!legal.includes(action)) throw new Error(`resolveAttention: "${action}" is not valid for reason "${reason}"`);

  // Stop never clears the reason/detail — the unresolved failure doesn't
  // disappear because the queue was stopped, it just additionally won't
  // auto-advance once it eventually IS resolved.
  if (action === "stop") return { ...state, queueStopped: true, updatedAt: Date.now() };

  if (action === "resume") {
    return { ...state, queueState: "printing", attentionReason: null, attentionDetail: null, updatedAt: Date.now() };
  }
  if (action === "acknowledge") {
    // recovery-mismatch: trust whatever the printer is actually doing; don't
    // touch it, just stop treating this printer's queue as blocked.
    return { ...state, queueState: "idle", attentionReason: null, attentionDetail: null, currentItem: null, updatedAt: Date.now() };
  }
  if (action === "retry-bed-clear") {
    return { ...state, queueState: "awaiting_bed_clear", attentionReason: null, attentionDetail: null, updatedAt: Date.now() };
  }
  if (action === "skip-bed-clear") {
    return { ...state, queueState: "idle", attentionReason: null, attentionDetail: null, currentItem: null, updatedAt: Date.now() };
  }
  if (action === "retry" || action === "skip") {
    const needsBedClear = !NEVER_PRINTED_REASONS.includes(reason);
    const original = state.currentItem;
    const queueAdd = action === "retry" && original ? [buildRetryItem(original)] : [];
    const resolvedItem = action === "skip" && original ? { ...original, status: "skipped", finishedAt: Date.now() } : null;
    return {
      ...state,
      queueState: needsBedClear ? "awaiting_bed_clear" : "idle",
      attentionReason: null, attentionDetail: null,
      queue: [...queueAdd, ...state.queue],
      // While bed-clear still needs to run, keep the resolved item visible
      // as "what we're clearing up after" — otherwise clear it, nothing left
      // to reference.
      currentItem: needsBedClear ? (resolvedItem || original) : null,
      recentHistory: resolvedItem ? pushHistory(state.recentHistory, resolvedItem) : state.recentHistory,
      updatedAt: Date.now()
    };
  }
  throw new Error("resolveAttention: unhandled action " + action);
}

// file-changed's dedicated accept path — needs a freshly (forced, uncached)
// computed hash the generic resolveAttention() action dispatch has nowhere
// to carry. QueueStore is responsible for actually hashing the file before
// calling this; this function just applies the result and preserves what
// changed rather than silently overwriting the evidence.
function acceptFileChange(state, { sizeBytes, sha256, actor }) {
  if (state.queueState !== "queue_attention_required" || state.attentionReason !== "file-changed") {
    throw new Error("acceptFileChange: not a file-changed attention state");
  }
  const original = state.currentItem;
  const updatedItem = {
    ...original,
    status: "queued",
    file: {
      ...original.file,
      originallyExpectedSha256: original.file.originallyExpectedSha256 || original.file.sha256,
      sizeBytes, sha256,
      replacementAcceptedBy: actor && actor.userLabel,
      replacementAcceptedAt: Date.now()
    }
  };
  return { ...state, queueState: "idle", attentionReason: null, attentionDetail: null, queue: [updatedItem, ...state.queue], currentItem: null, updatedAt: Date.now() };
}

// Reassigning a printer's pool (a Settings action, not a queue action)
// clears a pool-invalid attention state as a side effect — called by
// server.js right after a successful reassignment, a no-op otherwise.
function onPoolReassigned(state) {
  if (state.queueState !== "queue_attention_required" || state.attentionReason !== "pool-invalid") return state;
  return { ...state, queueState: "idle", attentionReason: null, attentionDetail: null, updatedAt: Date.now() };
}

// ---- Manual bed-clear confirmation (Category A, and always audited — see
// Correction 2). Returns the audit payload alongside the state so the caller
// logs it after a successful persist, never before. ----
function confirmManualBedClear(state, actor) {
  if (state.queueState !== "awaiting_bed_clear") throw new Error("confirmManualBedClear: not awaiting_bed_clear");
  const auditEvent = {
    category: "job", event: "manual-bed-clear-confirmed",
    userId: actor && actor.userId, userLabel: actor && actor.userLabel,
    detail: {
      followedItem: state.currentItem ? { id: state.currentItem.id, file: state.currentItem.file && state.currentItem.file.name, status: state.currentItem.status } : null,
      queuePausedAtConfirmation: !!state.queuePaused,
      // resultedInDispatch is filled in by QueueStore after it separately
      // attempts a claim following this — not knowable from this function
      // alone, since claiming is its own Category-A step.
      resultedInDispatch: null
    }
  };
  const nextState = { ...state, queueState: "idle", currentItem: null, updatedAt: Date.now() };
  return { nextState, auditEvent };
}

// ---- Pause/Stop — both orthogonal booleans, neither ever replaces
// queueState (see the design doc's Part B for why the earlier "queue_stopped
// state" design was wrong) ----
function pauseQueue(state) { return { ...state, queuePaused: true, updatedAt: Date.now() }; }
function resumeQueue(state) { return { ...state, queuePaused: false, updatedAt: Date.now() }; }
function stopQueue(state) { return { ...state, queueStopped: true, updatedAt: Date.now() }; }

// ---- Clear — the "actually abort everything" action Stop deliberately
// isn't. Callers are responsible for telling the physical printer to cancel
// (if it's mid-print) BEFORE calling this — this function only ever reconciles
// SnapCon's own bookkeeping: whatever was printing is recorded as cancelled,
// every still-queued item is recorded as removed, and the printer is left
// idle (queuePaused/queueStopped are untouched, so it's immediately ready to
// accept and dispatch new work, same as any other idle printer).
function clearQueue(state) {
  let history = state.currentItem
    ? pushHistory(state.recentHistory, { ...state.currentItem, status: "cancelled", finishedAt: Date.now() })
    : state.recentHistory;
  for (const item of state.queue) {
    history = pushHistory(history, { ...item, status: "removed", finishedAt: Date.now() });
  }
  return {
    ...state,
    queue: [],
    currentItem: null,
    queueState: "idle",
    attentionReason: null,
    attentionDetail: null,
    recentHistory: history,
    updatedAt: Date.now()
  };
}

// ---- Recovery — implements the design doc's Part E table directly, reused
// by both server startup and "Resume Queue" (which must never just trust
// stale state after a printer sat stopped for a while) ----
function reconcileOnStartup(state, liveProbe) {
  const s = state.queueState;

  if (s === "dispatching") {
    const expected = state.currentItem && state.currentItem.file && state.currentItem.file.name;
    if (liveProbe.online && liveProbe.state === "printing" && liveProbe.filename && liveProbe.filename === expected) {
      return { ...state, queueState: "printing", updatedAt: Date.now() };
    }
    if (liveProbe.online && liveProbe.state === "printing") {
      return attentionState(state, "recovery-mismatch", { code: "recovery-mismatch", message: "Printer is printing a file SnapCon didn't dispatch: " + liveProbe.filename });
    }
    return attentionState(state, "recovery-interrupted", { code: "recovery-interrupted", message: "Dispatch was interrupted; outcome unknown" });
  }

  if (s === "printing") {
    const expected = state.currentItem && state.currentItem.file && state.currentItem.file.name;
    if (liveProbe.online && (liveProbe.state === "printing" || liveProbe.state === "paused") && (!liveProbe.filename || liveProbe.filename === expected)) {
      return { ...state, updatedAt: Date.now() }; // still owns it, nothing to reconcile
    }
    return attentionState(state, "recovery-unknown-outcome", {
      code: "recovery-unknown-outcome", message: "Print finished or failed while offline; outcome unknown",
      resumable: !!(liveProbe.online && liveProbe.state === "paused")
    });
  }

  if (s === "bed_clear_running") {
    return attentionState(state, "bed-clear-failed", { code: "recovery-interrupted", message: "Bed-clear was interrupted by a restart; outcome unknown" });
  }

  // awaiting_bed_clear (Manual — safe, still just waiting for a tap),
  // queue_attention_required (safe, same banner/reason resumes),
  // idle/unmanaged (nothing in flight) — no change needed.
  return { ...state, updatedAt: Date.now() };
}

function resumeFromStop(state, liveProbe) {
  const reconciled = reconcileOnStartup(state, liveProbe);
  return { ...reconciled, queueStopped: false, updatedAt: Date.now() };
}

// ---- Phase 1 move-compatibility rule (deliberately not dependent on the
// future Shared Queue matcher) — same connector type is the honest proxy for
// "this file's color/tool mapping still makes sense on the target printer." ----
function printersCompatibleForMove(source, target) {
  return !!source && !!target && source.connector === target.connector;
}

// ---- Auto-balance (opt-in per Printer Pool) ----
// When a printer's own queue is empty and it's about to sit idle, borrow the
// OLDEST waiting item (by createdAt, not array position — a printer's queue
// can be manually reordered) from whichever same-connector sibling in the
// same group currently has the LONGEST queue (ties broken by printer id, for
// determinism), rather than let it sit idle while siblings still have work
// stacked up. Reuses printersCompatibleForMove — the exact same rule the
// existing manual "move to another printer" action already enforces, so
// auto-balance can never move a job somewhere its color/tool mapping
// wouldn't make sense.
//
// `store` is a plain {printerId: state} snapshot (never mutated — every
// touched entry is replaced with a new object/array, matching this file's
// pure-function discipline throughout). `groups` is an array of
// { printers: [{id, connector}] }, one entry per auto-balance-enabled pool —
// built by the caller (server.js, which has CFG.printerPools/printers) since
// this file has no knowledge of pools or config. Computing every eligible
// printer's move in ONE pass against a single working copy (rather than
// calling this once per idle printer against stale state) is what makes it
// safe to run as a single QueueStore.applyBulkIntent transaction: two
// printers going idle in the same sweep tick can never both grab from the
// same donor, since the second one to process sees the first one's already-
// reduced queue.
function computeAutoBalanceMoves(store, groups) {
  const working = { ...store };
  const updates = {};
  for (const group of (groups || [])) {
    const printers = (group.printers || []).filter(gp => working[gp.id]);
    const idleCandidates = printers
      .filter(gp => { const s = working[gp.id]; return s.queueState === "idle" && !s.currentItem && s.queue.length === 0; })
      .map(gp => gp.id)
      .sort();

    for (const pid of idleCandidates) {
      const meta = printers.find(gp => gp.id === pid);
      // Excludes every printer in idleCandidates (frozen at the top of this
      // group's loop, not just `pid` itself) — a printer identified as
      // needing work this pass must never turn around and donate what it
      // just received to a DIFFERENT idle printer later in the same pass.
      const siblingIds = printers
        .filter(gp => !idleCandidates.includes(gp.id) && working[gp.id].queue.length > 0 && printersCompatibleForMove(meta, gp))
        .map(gp => gp.id)
        .sort((a, b) => {
          const diff = working[b].queue.length - working[a].queue.length;
          return diff !== 0 ? diff : (a < b ? -1 : 1);
        });
      if (!siblingIds.length) continue;
      const donor = siblingIds[0];
      const donorQueue = [...working[donor].queue];
      let oldestIdx = 0;
      for (let i = 1; i < donorQueue.length; i++) {
        if (donorQueue[i].createdAt < donorQueue[oldestIdx].createdAt) oldestIdx = i;
      }
      const [item] = donorQueue.splice(oldestIdx, 1);
      working[donor] = { ...working[donor], queue: donorQueue, updatedAt: Date.now() };
      working[pid] = { ...working[pid], queue: [...working[pid].queue, item], updatedAt: Date.now() };
      updates[donor] = working[donor];
      updates[pid] = working[pid];
    }
  }
  return updates;
}

module.exports = {
  QUEUE_STATES, ATTENTION_REASONS, RESOLUTIONS_BY_REASON, NEVER_PRINTED_REASONS, MAX_RECENT_HISTORY,
  newQueueItemId, pushHistory,
  claimTransition,
  onDispatchSuccess, onDispatchFailure, onFileVerificationFailed,
  onProbeComplete, onProbeFailedOrCancelled,
  onBedClearStarted, onBedClearSuccess, onBedClearFailure,
  resolveAttention, acceptFileChange, onPoolReassigned,
  confirmManualBedClear,
  pauseQueue, resumeQueue, stopQueue, clearQueue,
  reconcileOnStartup, resumeFromStop,
  printersCompatibleForMove, computeAutoBalanceMoves
};

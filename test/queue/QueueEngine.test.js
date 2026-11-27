// test/queue/QueueEngine.test.js — pure unit tests for queue/QueueEngine.js.
// Every function under test takes a plain state object and returns a new
// one; no server, no fs, no Express involved — matches the
// groupAccess.test.js/AuditLog.test.js pattern already established in this
// repo for testable pure/isolated modules.
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../../queue/QueueEngine");

function baseState(overrides) {
  return {
    queueState: "idle", queuePaused: false, queueStopped: false, reconciliationPending: false,
    attentionReason: null, attentionDetail: null,
    queue: [], currentItem: null, recentHistory: [], updatedAt: 0,
    ...overrides
  };
}
function item(id, overrides) {
  return { id, status: "queued", alreadyUploaded: false, file: { name: id + ".gcode", sub: "", sizeBytes: 100, sha256: "hash-" + id }, map: {}, prefs: {}, createdAt: 0, dispatchedAt: null, finishedAt: null, queuedBy: { userId: "u1", userLabel: "alice" }, retryOfItemId: null, dispatchSnapshot: null, ...overrides };
}

// ---- claimTransition ----
test("claimTransition: claims the front item when idle, unpaused, unstopped, non-empty", () => {
  const state = baseState({ queue: [item("i1"), item("i2")] });
  const r = E.claimTransition(state);
  assert.equal(r.canClaim, true);
  assert.equal(r.item.id, "i1");
  assert.equal(r.nextState.queueState, "dispatching");
  assert.equal(r.nextState.queue.length, 1);
  assert.equal(r.nextState.currentItem.id, "i1");
});

test("claimTransition: refuses when not idle", () => {
  const r = E.claimTransition(baseState({ queueState: "printing", queue: [item("i1")] }));
  assert.equal(r.canClaim, false);
  assert.equal(r.reason, "not-idle");
});

test("claimTransition: refuses when paused, stopped, or empty", () => {
  assert.equal(E.claimTransition(baseState({ queuePaused: true, queue: [item("i1")] })).canClaim, false);
  assert.equal(E.claimTransition(baseState({ queueStopped: true, queue: [item("i1")] })).canClaim, false);
  assert.equal(E.claimTransition(baseState({ queue: [] })).canClaim, false);
});

test("claimTransition: does not mutate the input state (pure)", () => {
  const state = baseState({ queue: [item("i1")] });
  const frozenQueueRef = state.queue;
  E.claimTransition(state);
  assert.equal(state.queueState, "idle");
  assert.equal(state.queue, frozenQueueRef);
  assert.equal(state.queue.length, 1);
});

// ---- dispatch outcome ----
test("onDispatchSuccess: dispatching -> printing", () => {
  const state = baseState({ queueState: "dispatching", currentItem: item("i1", { status: "dispatching" }) });
  const next = E.onDispatchSuccess(state, "i1");
  assert.equal(next.queueState, "printing");
  assert.equal(next.currentItem.status, "printing");
});

test("onDispatchFailure: dispatching -> queue_attention_required(dispatch-failed), item marked failed and moved to history", () => {
  const state = baseState({ queueState: "dispatching", currentItem: item("i1", { status: "dispatching" }) });
  const next = E.onDispatchFailure(state, "i1", { code: "econnrefused", message: "refused" });
  assert.equal(next.queueState, "queue_attention_required");
  assert.equal(next.attentionReason, "dispatch-failed");
  assert.equal(next.attentionDetail.code, "econnrefused");
  assert.equal(next.currentItem.status, "failed");
  assert.equal(next.recentHistory.length, 1);
  assert.equal(next.recentHistory[0].status, "failed");
});

test("onDispatchSuccess/onDispatchFailure: throw if the itemId doesn't match the current dispatching item", () => {
  const state = baseState({ queueState: "dispatching", currentItem: item("i1", { status: "dispatching" }) });
  assert.throws(() => E.onDispatchSuccess(state, "wrong-id"));
  assert.throws(() => E.onDispatchFailure(state, "wrong-id", {}));
});

test("onFileVerificationFailed: dispatching -> file-missing or file-changed", () => {
  const state = baseState({ queueState: "dispatching", currentItem: item("i1", { status: "dispatching" }) });
  const missing = E.onFileVerificationFailed(state, "i1", "missing", { code: "file-missing", message: "gone" });
  assert.equal(missing.attentionReason, "file-missing");
  const changed = E.onFileVerificationFailed(state, "i1", "changed", { code: "file-changed", message: "differs" });
  assert.equal(changed.attentionReason, "file-changed");
});

// ---- print outcome ----
test("onProbeComplete: printing -> awaiting_bed_clear, item completed and in history", () => {
  const state = baseState({ queueState: "printing", currentItem: item("i1", { status: "printing" }) });
  const next = E.onProbeComplete(state);
  assert.equal(next.queueState, "awaiting_bed_clear");
  assert.equal(next.currentItem.status, "completed");
  assert.equal(next.recentHistory[0].status, "completed");
});

test("onProbeFailedOrCancelled: printing -> queue_attention_required(print-failed), carries resumable flag", () => {
  const state = baseState({ queueState: "printing", currentItem: item("i1", { status: "printing" }) });
  const next = E.onProbeFailedOrCancelled(state, true, { code: "paused-error", message: "thermal" });
  assert.equal(next.attentionReason, "print-failed");
  assert.equal(next.attentionDetail.resumable, true);
});

// ---- bed-clear lifecycle ----
test("bed-clear lifecycle: awaiting_bed_clear -> bed_clear_running -> idle (success) or attention (failure)", () => {
  const start = baseState({ queueState: "awaiting_bed_clear", currentItem: item("i1", { status: "completed" }) });
  const running = E.onBedClearStarted(start);
  assert.equal(running.queueState, "bed_clear_running");
  const success = E.onBedClearSuccess(running);
  assert.equal(success.queueState, "idle");
  assert.equal(success.currentItem, null);
  const failure = E.onBedClearFailure(running, { code: "timeout", message: "macro timed out" });
  assert.equal(failure.queueState, "queue_attention_required");
  assert.equal(failure.attentionReason, "bed-clear-failed");
});

// ---- resolveAttention ----
test("resolveAttention: rejects an action not legal for the current reason", () => {
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "dispatch-failed", currentItem: item("i1", { status: "failed" }) });
  assert.throws(() => E.resolveAttention(state, "resume"), /not valid for reason/);
});

test("resolveAttention: Retry after print-failed requires bed-clear (extrusion had started)", () => {
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "print-failed", currentItem: item("i1", { status: "failed" }) });
  const next = E.resolveAttention(state, "retry");
  assert.equal(next.queueState, "awaiting_bed_clear");
  assert.equal(next.queue.length, 1);
  assert.equal(next.queue[0].retryOfItemId, "i1");
  assert.notEqual(next.queue[0].id, "i1");
});

test("resolveAttention: Retry after dispatch-failed skips bed-clear (nothing was ever printed)", () => {
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "dispatch-failed", currentItem: item("i1", { status: "failed" }) });
  const next = E.resolveAttention(state, "retry");
  assert.equal(next.queueState, "idle");
  assert.equal(next.queue.length, 1);
});

test("resolveAttention: Skip after print-failed marks the item skipped and still requires bed-clear", () => {
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "print-failed", currentItem: item("i1", { status: "failed" }) });
  const next = E.resolveAttention(state, "skip");
  assert.equal(next.queueState, "awaiting_bed_clear");
  assert.equal(next.recentHistory[0].status, "skipped");
  assert.equal(next.queue.length, 0); // skip never re-queues
});

test("resolveAttention: Resume returns to printing without touching the queue", () => {
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "print-failed", attentionDetail: { resumable: true }, currentItem: item("i1", { status: "failed" }) });
  const next = E.resolveAttention(state, "resume");
  assert.equal(next.queueState, "printing");
  assert.equal(next.attentionReason, null);
});

test("resolveAttention: Stop sets queueStopped but leaves the attention reason fully intact", () => {
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "bed-clear-failed", attentionDetail: { code: "x", message: "y" } });
  const next = E.resolveAttention(state, "stop");
  assert.equal(next.queueStopped, true);
  assert.equal(next.queueState, "queue_attention_required");
  assert.equal(next.attentionReason, "bed-clear-failed");
});

test("resolveAttention: bed-clear-failed offers Retry Bed-Clear and Skip Bed-Clear & Proceed, not Retry/Skip Job", () => {
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "bed-clear-failed" });
  assert.throws(() => E.resolveAttention(state, "retry"));
  assert.throws(() => E.resolveAttention(state, "skip"));
  const retried = E.resolveAttention(state, "retry-bed-clear");
  assert.equal(retried.queueState, "awaiting_bed_clear");
  const skipped = E.resolveAttention(baseState({ queueState: "queue_attention_required", attentionReason: "bed-clear-failed" }), "skip-bed-clear");
  assert.equal(skipped.queueState, "idle");
});

test("resolveAttention: file-missing never offers Use Current File (only skip/stop are legal)", () => {
  assert.deepEqual(E.RESOLUTIONS_BY_REASON["file-missing"], ["skip", "stop"]);
});

// ---- acceptFileChange ----
test("acceptFileChange: records both the original expected hash and the accepted replacement", () => {
  const original = item("i1", { status: "dispatching", file: { name: "a.gcode", sub: "", sizeBytes: 100, sha256: "old-hash" } });
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "file-changed", currentItem: original });
  const next = E.acceptFileChange(state, { sizeBytes: 200, sha256: "new-hash", actor: { userId: "u1", userLabel: "alice" } });
  assert.equal(next.queueState, "idle");
  const requeued = next.queue[0];
  assert.equal(requeued.file.sha256, "new-hash");
  assert.equal(requeued.file.sizeBytes, 200);
  assert.equal(requeued.file.originallyExpectedSha256, "old-hash");
  assert.equal(requeued.file.replacementAcceptedBy, "alice");
  assert.equal(typeof requeued.file.replacementAcceptedAt, "number");
});

// M7: a retry dispatches from the Library location the item was queued from,
// as the same Variant. Rebuilt without them, it looked in the G-code folder.
test("a retry keeps the item's Library location and the Variant it was queued as", () => {
  const library = { model: "m-1", modelName: "Beardie", contentKey: "k", variantKey: "k", plate: null, location: "nas:A/Beardie.gcode" };
  const original = item("i1", { status: "failed", file: { name: "Beardie.gcode", sub: "A", root: "nas", sizeBytes: 100, sha256: "h" }, library });
  const state = baseState({ queueState: "queue_attention_required", attentionReason: "dispatch-failed", currentItem: original });
  const retry = E.resolveAttention(state, "retry").queue[0];
  assert.equal(retry.file.root, "nas");
  assert.equal(retry.file.sub, "A");
  assert.deepEqual(retry.library, library);
  const plain = E.resolveAttention(baseState({ queueState: "queue_attention_required", attentionReason: "dispatch-failed", currentItem: item("i2", { status: "failed" }) }), "retry").queue[0];
  assert.equal("root" in plain.file, false, "a G-code folder item stays exactly as it was");
  assert.equal("library" in plain, false);
});

test("accepting a changed file drops the Library Variant: it is different content now", () => {
  const original = item("i1", { status: "dispatching", file: { name: "a.gcode", sub: "", root: "nas", sizeBytes: 100, sha256: "old" }, library: { model: "m-1", modelName: "Frog", contentKey: "old" } });
  const next = E.acceptFileChange(baseState({ queueState: "queue_attention_required", attentionReason: "file-changed", currentItem: original }), { sizeBytes: 200, sha256: "new", actor: { userLabel: "alice" } });
  assert.equal(next.queue[0].library, undefined);
  assert.deepEqual(next.queue[0].libraryReplaced, { model: "m-1", modelName: "Frog" });
  assert.equal(next.queue[0].file.root, "nas", "still the same place");
});

// ---- profile reassignment ----
test("onPoolReassigned: clears pool-invalid attention, no-op for any other reason", () => {
  const invalid = baseState({ queueState: "queue_attention_required", attentionReason: "pool-invalid" });
  assert.equal(E.onPoolReassigned(invalid).queueState, "idle");
  const other = baseState({ queueState: "queue_attention_required", attentionReason: "print-failed" });
  assert.equal(E.onPoolReassigned(other).attentionReason, "print-failed");
});

// ---- manual bed-clear confirmation ----
test("confirmManualBedClear: awaiting_bed_clear -> idle, returns an audit payload with the confirming actor", () => {
  const state = baseState({ queueState: "awaiting_bed_clear", currentItem: item("i1", { status: "completed" }), queuePaused: true });
  const { nextState, auditEvent } = E.confirmManualBedClear(state, { userId: "u1", userLabel: "alice" });
  assert.equal(nextState.queueState, "idle");
  assert.equal(auditEvent.event, "manual-bed-clear-confirmed");
  assert.equal(auditEvent.userLabel, "alice");
  assert.equal(auditEvent.detail.queuePausedAtConfirmation, true);
  assert.equal(auditEvent.detail.followedItem.id, "i1");
});

// ---- pause/stop are orthogonal, never replace queueState ----
test("pauseQueue/stopQueue never change queueState, only their own flag", () => {
  const state = baseState({ queueState: "printing" });
  assert.equal(E.pauseQueue(state).queueState, "printing");
  assert.equal(E.pauseQueue(state).queuePaused, true);
  assert.equal(E.stopQueue(state).queueState, "printing");
  assert.equal(E.stopQueue(state).queueStopped, true);
});

// ---- clearQueue: the real "abort everything" action ----
test("clearQueue: wipes queue and currentItem, resets to idle, clears attention", () => {
  const state = baseState({
    queueState: "queue_attention_required", attentionReason: "print-failed", attentionDetail: { code: "x" },
    currentItem: item("i1", { status: "failed" }), queue: [item("i2"), item("i3")]
  });
  const next = E.clearQueue(state);
  assert.equal(next.queueState, "idle");
  assert.equal(next.currentItem, null);
  assert.deepEqual(next.queue, []);
  assert.equal(next.attentionReason, null);
  assert.equal(next.attentionDetail, null);
});

test("clearQueue: records the current item as cancelled and each queued item as removed in history", () => {
  const state = baseState({ queueState: "printing", currentItem: item("i1", { status: "printing" }), queue: [item("i2"), item("i3")] });
  const next = E.clearQueue(state);
  assert.equal(next.recentHistory.length, 3);
  assert.equal(next.recentHistory[0].id, "i1");
  assert.equal(next.recentHistory[0].status, "cancelled");
  assert.equal(next.recentHistory[1].id, "i2");
  assert.equal(next.recentHistory[1].status, "removed");
  assert.equal(next.recentHistory[2].id, "i3");
  assert.equal(next.recentHistory[2].status, "removed");
});

test("clearQueue: no currentItem -> only queued items go to history, nothing 'cancelled'", () => {
  const state = baseState({ queueState: "idle", queue: [item("i1")] });
  const next = E.clearQueue(state);
  assert.equal(next.recentHistory.length, 1);
  assert.equal(next.recentHistory[0].status, "removed");
});

test("clearQueue: an item whose outcome is already in history isn't recorded again as cancelled (§36 F3)", () => {
  for (const [queueState, status] of [["awaiting_bed_clear", "completed"], ["bed_clear_running", "completed"], ["queue_attention_required", "failed"], ["queue_attention_required", "skipped"]]) {
    const cur = item("i1", { status });
    const next = E.clearQueue(baseState({ queueState, currentItem: cur, recentHistory: [cur], queue: [item("i2")] }));
    assert.deepEqual(next.recentHistory.map(i => [i.id, i.status]), [["i1", status], ["i2", "removed"]], queueState + "/" + status);
  }
});

test("clearQueue: a print that failed, was resumed and is printing again is recorded as cancelled", () => {
  const next = E.clearQueue(baseState({ queueState: "printing", currentItem: item("i1", { status: "failed" }), recentHistory: [item("i1", { status: "failed" })] }));
  assert.deepEqual(next.recentHistory.map(i => [i.id, i.status]), [["i1", "failed"], ["i1", "cancelled"]]);
});

test("clearQueue: another item with the same file name in history doesn't stop the current one being recorded", () => {
  const next = E.clearQueue(baseState({ queueState: "printing", currentItem: item("i2", { status: "printing" }), recentHistory: [{ ...item("i1"), file: item("i2").file, status: "completed" }] }));
  assert.deepEqual(next.recentHistory.map(i => [i.id, i.status]), [["i1", "completed"], ["i2", "cancelled"]]);
});

test("clearQueue: Clear's own cancel is cancelled by the user; an outcome nobody saw is unknown; a job never sent is removed", () => {
  const rows = s => s.recentHistory.map(i => [i.id, i.status, i.cancelledBy || null]);
  // Printing: cancelled now.
  assert.deepEqual(rows(E.clearQueue(baseState({ queueState: "printing", currentItem: item("i1", { status: "printing" }) }), { cancelledItemId: "i1" })), [["i1", "cancelled", "user"]]);
  // The printer reported the stop the cancel caused: that "failed" becomes the cancel, in place.
  const failed = item("i1", { status: "failed", finishedAt: 7 });
  const raced = E.clearQueue(baseState({ queueState: "queue_attention_required", attentionReason: "print-failed", currentItem: failed, recentHistory: [failed] }), { cancelledItemId: "i1" });
  assert.deepEqual(rows(raced), [["i1", "cancelled", "user"]]);
  assert.equal(raced.recentHistory[0].finishedAt, 7, "when the printer said it stopped");
  // The same failure with no cancel sent by this Clear stays a failure.
  assert.deepEqual(rows(E.clearQueue(baseState({ queueState: "queue_attention_required", attentionReason: "print-failed", currentItem: failed, recentHistory: [failed] }))), [["i1", "failed", null]]);
  // A completion is never overwritten, cancel or not.
  const done = item("i1", { status: "completed" });
  assert.deepEqual(rows(E.clearQueue(baseState({ queueState: "awaiting_bed_clear", currentItem: done, recentHistory: [done] }), { cancelledItemId: "i1" })), [["i1", "completed", null]]);
  // Unknown outcome, no cancel: unknown, not a guessed cancel.
  assert.deepEqual(rows(E.clearQueue(baseState({ queueState: "queue_attention_required", attentionReason: "recovery-unknown-outcome", currentItem: item("i1", { status: "printing" }) }))), [["i1", "unknown", null]]);
  assert.deepEqual(rows(E.clearQueue(baseState({ queueState: "queue_attention_required", attentionReason: "recovery-interrupted", currentItem: item("i1", { status: "dispatching" }) }))), [["i1", "unknown", null]]);
  // Never sent to the printer.
  assert.deepEqual(rows(E.clearQueue(baseState({ queueState: "queue_attention_required", attentionReason: "file-missing", currentItem: item("i1", { status: "dispatching" }) }))), [["i1", "removed", null]]);
});

test("clearQueue: leaves queuePaused/queueStopped untouched", () => {
  const state = baseState({ queueState: "printing", queueStopped: true, currentItem: item("i1") });
  assert.equal(E.clearQueue(state).queueStopped, true);
  const state2 = baseState({ queueState: "printing", queuePaused: true, currentItem: item("i1") });
  assert.equal(E.clearQueue(state2).queuePaused, true);
});

test("clearQueue: on an already-empty idle state is a harmless no-op on data, still returns idle", () => {
  const state = baseState({ queueState: "idle" });
  const next = E.clearQueue(state);
  assert.equal(next.queueState, "idle");
  assert.deepEqual(next.queue, []);
  assert.equal(next.currentItem, null);
  assert.deepEqual(next.recentHistory, []);
});

test("clearQueue: does not mutate the input state", () => {
  const state = baseState({ queueState: "printing", currentItem: item("i1"), queue: [item("i2")] });
  const snapshot = JSON.parse(JSON.stringify(state));
  E.clearQueue(state);
  assert.deepEqual(state, snapshot);
});

// ---- recovery (Part E of the design doc, encoded as tests) ----
test("reconcileOnStartup: dispatching + printer confirmed printing the expected file -> printing, no attention", () => {
  const state = baseState({ queueState: "dispatching", currentItem: item("i1", { status: "dispatching", file: { name: "i1.gcode", sub: "", sizeBytes: 1, sha256: "h" } }) });
  const next = E.reconcileOnStartup(state, { online: true, state: "printing", filename: "i1.gcode" });
  assert.equal(next.queueState, "printing");
});

test("reconcileOnStartup: dispatching + printer printing something else -> recovery-mismatch", () => {
  const state = baseState({ queueState: "dispatching", currentItem: item("i1", { status: "dispatching" }) });
  const next = E.reconcileOnStartup(state, { online: true, state: "printing", filename: "something-else.gcode" });
  assert.equal(next.attentionReason, "recovery-mismatch");
  // filename is additive (see server.js/app.js's translated recovery-mismatch
  // template) — message stays for compatibility with any other consumer.
  assert.equal(next.attentionDetail.filename, "something-else.gcode");
  assert.match(next.attentionDetail.message, /something-else\.gcode/);
});

test("reconcileOnStartup: dispatching + printer idle -> recovery-interrupted (never silently re-queued)", () => {
  const state = baseState({ queueState: "dispatching", currentItem: item("i1", { status: "dispatching" }) });
  const next = E.reconcileOnStartup(state, { online: true, state: "idle" });
  assert.equal(next.attentionReason, "recovery-interrupted");
});

test("reconcileOnStartup: printing + printer now idle -> recovery-unknown-outcome", () => {
  const state = baseState({ queueState: "printing", currentItem: item("i1", { status: "printing" }) });
  const next = E.reconcileOnStartup(state, { online: true, state: "idle" });
  assert.equal(next.attentionReason, "recovery-unknown-outcome");
});

test("reconcileOnStartup: printing + printer still printing the same file -> unchanged, no attention", () => {
  const state = baseState({ queueState: "printing", currentItem: item("i1", { status: "printing", file: { name: "i1.gcode", sub: "", sizeBytes: 1, sha256: "h" } }) });
  const next = E.reconcileOnStartup(state, { online: true, state: "printing", filename: "i1.gcode" });
  assert.equal(next.queueState, "printing");
  assert.equal(next.attentionReason, null);
});

// ---- onPrinterIdleWhilePrinting (docs/TODO.md §34) ----
function idleUnknown() {
  const state = baseState({ queueState: "printing", queue: [item("i2")], recentHistory: [item("h0", { status: "completed" })], currentItem: item("i1", { status: "printing", dispatchedAt: 5 }) });
  return E.onPrinterIdleWhilePrinting(state, "i1", { code: "printer-idle", message: "went idle" });
}

test("onPrinterIdleWhilePrinting: needs attention as an unknown outcome; the item stays, history and queue untouched, nothing advances", () => {
  const next = idleUnknown();
  assert.equal(next.queueState, "queue_attention_required");
  assert.equal(next.attentionReason, "recovery-unknown-outcome");
  assert.deepEqual(next.attentionDetail, { code: "printer-idle", message: "went idle", resumable: false });
  assert.equal(next.currentItem.id, "i1");
  assert.equal(next.currentItem.status, "printing", "not marked completed, failed or skipped");
  assert.equal(next.currentItem.finishedAt, null);
  assert.deepEqual(next.recentHistory.map(i => i.id), ["h0"]);
  assert.deepEqual(next.queue.map(i => i.id), ["i2"], "the next item is still waiting, not claimed");
});

test("onPrinterIdleWhilePrinting: only from printing, and only for the item observed", () => {
  const printing = baseState({ queueState: "printing", currentItem: item("i1", { status: "printing" }) });
  assert.throws(() => E.onPrinterIdleWhilePrinting(printing, "other", {}), /no matching printing item/);
  for (const queueState of ["idle", "dispatching", "awaiting_bed_clear", "queue_attention_required"]) {
    assert.throws(() => E.onPrinterIdleWhilePrinting({ ...printing, queueState }, "i1", {}), /no matching printing item/, queueState);
  }
});

test("onPrinterIdleWhilePrinting: Retry and Skip go through bed-clear, since the print may have run", () => {
  const retry = E.resolveAttention(idleUnknown(), "retry");
  assert.equal(retry.queueState, "awaiting_bed_clear");
  assert.equal(retry.queue[0].retryOfItemId, "i1", "a fresh retry item at the front");
  assert.deepEqual(retry.queue.slice(1).map(i => i.id), ["i2"]);
  const skip = E.resolveAttention(idleUnknown(), "skip");
  assert.equal(skip.queueState, "awaiting_bed_clear");
  assert.equal(skip.currentItem.status, "skipped");
  assert.deepEqual(skip.recentHistory.map(i => i.id), ["h0", "i1"]);
});

test("onPrinterIdleWhilePrinting: Stop keeps the reason and the item", () => {
  const stopped = E.resolveAttention(idleUnknown(), "stop");
  assert.equal(stopped.queueStopped, true);
  assert.equal(stopped.attentionReason, "recovery-unknown-outcome");
  assert.equal(stopped.currentItem.id, "i1");
});

// §34 item 5: an unknown outcome is raised for a printer that is not paused on
// the item, so Resume could only fail or resume a print the queue never sent.
test("recovery-unknown-outcome offers no Resume; print-failed keeps it", () => {
  assert.deepEqual([...E.RESOLUTIONS_BY_REASON["recovery-unknown-outcome"]], ["mark-completed", "retry", "skip", "stop"]);
  assert.throws(() => E.resolveAttention(idleUnknown(), "resume"), /not valid for reason "recovery-unknown-outcome"/);
  assert.ok(E.RESOLUTIONS_BY_REASON["print-failed"].includes("resume"), "a failed print may still be paused and resumable");
});

// §34 item 6: a person who saw the print finish says so.
test("mark-completed: recorded like a printer-reported completion, plus who decided; then bed-clear, nothing dispatched", () => {
  const before = Date.now();
  const s0 = idleUnknown();
  const next = E.resolveAttention(s0, "mark-completed");
  assert.equal(next.queueState, "awaiting_bed_clear");
  assert.equal(next.attentionReason, null);
  assert.equal(next.attentionDetail, null);
  assert.equal(next.currentItem.id, "i1");
  assert.equal(next.currentItem.status, "completed");
  assert.equal(next.currentItem.completedBy, "user");
  assert.ok(next.currentItem.finishedAt >= before);
  assert.deepEqual(next.recentHistory.map(i => [i.id, i.status]), [["h0", "completed"], ["i1", "completed"]]);
  assert.equal(next.recentHistory[1].completedBy, "user");
  assert.deepEqual(next.queue.map(i => i.id), ["i2"], "the next item waits");
  assert.equal(E.claimTransition(next).canClaim, false, "nothing dispatches until the bed is confirmed clear");
  // The same shape a printer-reported completion gives, except completedBy.
  const viaPrinter = E.onProbeComplete({ ...s0, queueState: "printing", attentionReason: null, attentionDetail: null });
  const strip = st => ({ ...st, updatedAt: 0, currentItem: { ...st.currentItem, finishedAt: 0, completedBy: undefined }, recentHistory: st.recentHistory.map(i => ({ ...i, finishedAt: 0, completedBy: undefined })) });
  assert.deepEqual(strip(next), strip(viaPrinter));
  assert.equal(viaPrinter.currentItem.completedBy, undefined, "a printer-reported completion carries no completedBy");
});

test("mark-completed: a stopped queue stays stopped", () => {
  const next = E.resolveAttention({ ...idleUnknown(), queueStopped: true }, "mark-completed");
  assert.equal(next.queueStopped, true);
  assert.equal(next.queueState, "awaiting_bed_clear");
});

test("mark-completed is only for an unknown outcome", () => {
  for (const reason of ["print-failed", "dispatch-failed", "bed-clear-failed", "file-missing", "file-changed", "pool-invalid", "recovery-mismatch", "recovery-interrupted"]) {
    const state = baseState({ queueState: "queue_attention_required", attentionReason: reason, currentItem: item("i1") });
    assert.throws(() => E.resolveAttention(state, "mark-completed"), /not valid for reason/, reason);
  }
  assert.throws(() => E.resolveAttention(baseState({ queueState: "printing", currentItem: item("i1") }), "mark-completed"), /not in attention state/);
});

test("reconcileOnStartup: bed_clear_running at crash time -> always surfaces as bed-clear-failed, never assumed", () => {
  const state = baseState({ queueState: "bed_clear_running" });
  const next = E.reconcileOnStartup(state, { online: true, state: "idle" });
  assert.equal(next.attentionReason, "bed-clear-failed");
});

test("reconcileOnStartup: awaiting_bed_clear and queue_attention_required are left untouched", () => {
  const waiting = baseState({ queueState: "awaiting_bed_clear" });
  assert.equal(E.reconcileOnStartup(waiting, { online: true, state: "idle" }).queueState, "awaiting_bed_clear");
  const attn = baseState({ queueState: "queue_attention_required", attentionReason: "print-failed" });
  assert.equal(E.reconcileOnStartup(attn, { online: true, state: "idle" }).attentionReason, "print-failed");
});

test("resumeFromStop: reconciles against a live probe before clearing queueStopped", () => {
  const state = baseState({ queueState: "printing", queueStopped: true, currentItem: item("i1", { status: "printing" }) });
  // Printer drifted while stopped — something else is on it now.
  const next = E.resumeFromStop(state, { online: true, state: "idle" });
  assert.equal(next.queueStopped, false);
  assert.equal(next.attentionReason, "recovery-unknown-outcome");
});

// ---- move compatibility (Phase 1 rule, no Shared Queue dependency) ----
test("printersCompatibleForMove: same connector allowed, different connector blocked", () => {
  assert.equal(E.printersCompatibleForMove({ connector: "snapmaker-u1-klipper" }, { connector: "snapmaker-u1-klipper" }), true);
  assert.equal(E.printersCompatibleForMove({ connector: "snapmaker-u1-klipper" }, { connector: "flashforge-ad5x" }), false);
});

// ---- computeAutoBalanceMoves (opt-in per Printer Pool) ----
const CONN = "snapmaker-u1-klipper";
function group(...ids) { return { printers: ids.map(id => ({ id, connector: CONN })) }; }

test("computeAutoBalanceMoves: idle-empty printer steals from the sibling with the longest queue", () => {
  const store = {
    a: baseState({ queue: [] }), // idle, empty -> candidate
    b: baseState({ queue: [item("b1", { createdAt: 10 })] }),
    c: baseState({ queue: [item("c1", { createdAt: 5 }), item("c2", { createdAt: 6 })] }) // longest
  };
  const updates = E.computeAutoBalanceMoves(store, [group("a", "b", "c")]);
  assert.equal(updates.a.queue.length, 1);
  assert.equal(updates.a.queue[0].id, "c1"); // oldest of c's two items
  assert.equal(updates.c.queue.length, 1);
  assert.equal(updates.c.queue[0].id, "c2");
  assert.equal(updates.b, undefined); // untouched — never had the longest queue
});

test("computeAutoBalanceMoves: takes the OLDEST item by createdAt, not queue[0] (queues can be manually reordered)", () => {
  const store = {
    a: baseState({ queue: [] }),
    b: baseState({ queue: [item("newer", { createdAt: 100 }), item("older", { createdAt: 1 })] })
  };
  const updates = E.computeAutoBalanceMoves(store, [group("a", "b")]);
  assert.equal(updates.a.queue[0].id, "older");
  assert.equal(updates.b.queue[0].id, "newer");
});

test("computeAutoBalanceMoves: ties in queue length broken by printer id", () => {
  const store = {
    a: baseState({ queue: [] }),
    z: baseState({ queue: [item("z1", { createdAt: 1 })] }),
    m: baseState({ queue: [item("m1", { createdAt: 1 })] })
  };
  const updates = E.computeAutoBalanceMoves(store, [group("a", "z", "m")]);
  // "m" sorts before "z" — deterministic tiebreak, not array/insertion order.
  assert.equal(updates.a.queue[0].id, "m1");
  assert.equal(updates.m.queue.length, 0);
  assert.equal(updates.z, undefined);
});

test("computeAutoBalanceMoves: never moves between incompatible connectors, even in the same group", () => {
  const store = {
    a: baseState({ queue: [] }),
    b: baseState({ queue: [item("b1")] })
  };
  const mixedGroup = { printers: [{ id: "a", connector: "snapmaker-u1-klipper" }, { id: "b", connector: "flashforge-ad5x" }] };
  const updates = E.computeAutoBalanceMoves(store, [mixedGroup]);
  assert.deepEqual(updates, {});
});

test("computeAutoBalanceMoves: no-op when no sibling has anything queued", () => {
  const store = { a: baseState({ queue: [] }), b: baseState({ queue: [] }) };
  assert.deepEqual(E.computeAutoBalanceMoves(store, [group("a", "b")]), {});
});

test("computeAutoBalanceMoves: a printer with a currentItem or non-idle state is never a borrower", () => {
  const store = {
    a: baseState({ queueState: "printing", currentItem: item("a-cur", { status: "printing" }), queue: [] }),
    b: baseState({ queue: [item("b1")] })
  };
  assert.deepEqual(E.computeAutoBalanceMoves(store, [group("a", "b")]), {});
});

test("computeAutoBalanceMoves: two printers going idle in the same pass never both grab from the same donor", () => {
  const store = {
    a: baseState({ queue: [] }),
    b: baseState({ queue: [] }),
    c: baseState({ queue: [item("c1", { createdAt: 1 }), item("c2", { createdAt: 2 })] })
  };
  const updates = E.computeAutoBalanceMoves(store, [group("a", "b", "c")]);
  const aItem = updates.a.queue[0] && updates.a.queue[0].id;
  const bItem = updates.b.queue[0] && updates.b.queue[0].id;
  assert.notEqual(aItem, undefined);
  assert.notEqual(bItem, undefined);
  assert.notEqual(aItem, bItem); // each got a different item, not the same one twice
  assert.equal(updates.c.queue.length, 0);
});

test("computeAutoBalanceMoves: does not mutate its input store", () => {
  const original = { a: baseState({ queue: [] }), b: baseState({ queue: [item("b1", { createdAt: 1 }), item("b2", { createdAt: 2 })] }) };
  const snapshot = JSON.parse(JSON.stringify(original));
  E.computeAutoBalanceMoves(original, [group("a", "b")]);
  assert.deepEqual(original, snapshot);
});

test("computeAutoBalanceMoves: printers outside any group are never touched", () => {
  const store = { a: baseState({ queue: [] }), outsider: baseState({ queue: [item("o1")] }) };
  assert.deepEqual(E.computeAutoBalanceMoves(store, [group("a")]), {});
});

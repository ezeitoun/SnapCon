// queue/poolChange.js — the changes that must land in BOTH records of
// "is this printer's queue managed": config.json (printer.printerPoolId,
// queueManagement.enabled) and the queue store (queueState).
//
// Order, for all of them: refuse while config.json could not be read at
// start-up (memory then holds defaults, and saving would write them over the
// real file) or while the queue store cannot save; change the queue store and
// CHECK the answer; only then change the settings and save them.
//
// saveConfig() must throw when the settings were not saved, and say on the
// error (`configFile`, see configLoader.js replaceConfigFile) what is on disk:
//   "unchanged" (or nothing said)  the settings in memory and the queue store
//                                  are put back; if the queue store cannot be
//                                  put back, that is said (code *_incomplete).
//                                  Not a promise that both records are always
//                                  as before — only that the answer says which;
//   "replaced-not-flushed"         config.json holds the change, so nothing is
//                                  put back: the change stands and is reported
//                                  as not confirmed (config_save_not_durable).
// A config.json that cannot be renamed over (EBUSY/EXDEV: it is a mount
// point) is an "unchanged" failure every time; the answer then says why.
//
// No file access here.
const unavailable = s => !!(s.queueStoreRecoveryRequired || s.storeDegraded || s.storeStoppedByAdmin);
const refused = reason => ({ ok: false, status: 503, code: "queue_store_unavailable", error: "The queue can't save changes right now", reason });
const configUnreadable = () => ({ ok: false, status: 409, code: "config_unreadable", error: "Config could not be read; not overwriting it" });
// The error code only: this text is shown to users.
const notReplaceable = e => (e && (e.code === "EBUSY" || e.code === "EXDEV"))
  ? " config.json cannot be replaced where it is (" + e.code + "), for example when it is mounted into a container as a single file. While that is so, this change cannot be saved from SnapCon. Mount a settings folder instead (see docker-config-migration.md in the docs folder)."
  : "";
const notDurable = (e, what) => ({ ok: false, status: 500, code: "config_save_not_durable", applied: true, cause: e,
  error: what + ", but the settings file could not be confirmed as safely stored (" + ((e && e.code) || "error") + "). Check it again after the next restart." });
// The answer for a failed save once memory (and the queue store, where there is one) has been dealt with.
function saveFailed(e, { undone = { ok: true }, unchangedText, incompleteCode, incompleteText }) {
  if (undone.ok) return { ok: false, status: 500, code: "config_save_failed", cause: e, error: unchangedText + notReplaceable(e) };
  return { ok: false, status: 500, code: incompleteCode, cause: e, undoReason: undone.reason, error: incompleteText + notReplaceable(e) };
}

// printerPoolId: the pool to assign, or null/undefined to take the printer out of its pool.
function changePrinterPool({ queueStore, printer, printerPoolId, saveConfig, configLoadFailed = false }) {
  if (configLoadFailed) return configUnreadable();
  if (unavailable(queueStore.getGlobalStatus())) return refused("store-unavailable");
  const wasManaged = queueStore.getPrinterState(printer.id).queueState !== "unmanaged";
  const previousPoolId = printer.printerPoolId;
  const changed = printerPoolId ? queueStore.assignPool(printer.id) : queueStore.unassignPool(printer.id);
  if (!changed.ok) return refused(changed.reason);   // nothing was changed anywhere
  printer.printerPoolId = printerPoolId || undefined;
  try { saveConfig(); return { ok: true }; }
  catch (e) {
    if (e && e.configFile === "replaced-not-flushed") return notDurable(e, "The pool was changed");
    printer.printerPoolId = previousPoolId;
    const undone = wasManaged ? queueStore.assignPool(printer.id) : queueStore.unassignPool(printer.id);
    return saveFailed(e, { undone, unchangedText: "The settings could not be saved, so the pool is as it was.", incompleteCode: "pool_change_incomplete",
      incompleteText: "The pool change was only partly saved: the queue has it, the settings do not. Fix the disk problem, then set this printer's pool again." });
  }
}

// Switching Queue Management on: every unmanaged printer becomes managed in
// ONE queue save (all or none), then the settings. setEnabled(on) flips the
// setting in memory (and may create the default pool); it must not save.
function enableQueueManagement({ queueStore, printers, defaultPoolId, setEnabled, saveConfig, configLoadFailed = false }) {
  if (configLoadFailed) return configUnreadable();
  if (unavailable(queueStore.getGlobalStatus())) return refused("store-unavailable");
  const toManage = printers.filter(p => queueStore.getPrinterState(p.id).queueState === "unmanaged").map(p => p.id);
  if (toManage.length) {
    const changed = queueStore.assignPoolMany(toManage);
    if (!changed.ok) return refused(changed.reason);
  }
  const givenPool = printers.filter(p => !p.printerPoolId);
  for (const p of givenPool) p.printerPoolId = defaultPoolId;
  setEnabled(true);
  try { saveConfig(); return { ok: true, managed: toManage.length }; }
  catch (e) {
    if (e && e.configFile === "replaced-not-flushed") return notDurable(e, "Queue Management was switched on");
    setEnabled(false);
    for (const p of givenPool) p.printerPoolId = undefined;
    const undone = toManage.length ? queueStore.unassignPoolMany(toManage) : { ok: true };
    return saveFailed(e, { undone, unchangedText: "The settings could not be saved, so Queue Management is still off.", incompleteCode: "queue_enable_incomplete",
      incompleteText: "Queue Management was not switched on, but the queue already has these printers as managed. Fix the disk problem, then switch it on again." });
  }
}

// Switching it off touches the settings only. A switch-off that was not saved
// would come back on at the next restart: an error, and not applied.
function disableQueueManagement({ isEnabled, setEnabled, saveConfig, configLoadFailed = false }) {
  if (configLoadFailed) return configUnreadable();
  const wasEnabled = !!isEnabled();
  setEnabled(false);
  try { saveConfig(); return { ok: true }; }
  catch (e) {
    if (e && e.configFile === "replaced-not-flushed") return notDurable(e, "Queue Management was switched off");
    setEnabled(wasEnabled);
    return saveFailed(e, { unchangedText: "The settings could not be saved, so Queue Management is " + (wasEnabled ? "still on." : "as it was.") });
  }
}

module.exports = { changePrinterPool, enableQueueManagement, disableQueueManagement };

// queue/migratePrinterPool.js — pure, no I/O. One-time schema migration from
// the pre-rename Queue Management shape ("Printer Profile") to the current
// one ("Printer Pool"): CFG.queueProfiles -> CFG.printerPools, each printer's
// queueProfileId -> printerPoolId, and the future dispatch-mode value
// "farm-pool" -> "shared-queue". Existing pool ids (including the protected
// "qp_default_manual") are preserved verbatim — only the container key, the
// printer's reference field name, and mode string are renamed, never the ids
// themselves, so an upgrade can never silently detach a printer from its
// pool. Safe to call on an already-migrated or brand-new config: whenever the
// old-format fields aren't present, this is a no-op (changed stays false).
function migratePrinterPoolConfig(rawCfg) {
  const cfg = { ...rawCfg };
  let changed = false;

  if (cfg.printerPools === undefined && Array.isArray(cfg.queueProfiles)) {
    cfg.printerPools = cfg.queueProfiles;
  }
  if (Object.prototype.hasOwnProperty.call(cfg, "queueProfiles")) {
    delete cfg.queueProfiles;
    changed = true;
  }

  if (Array.isArray(cfg.printers)) {
    const printers = cfg.printers.map(p => {
      if (!Object.prototype.hasOwnProperty.call(p, "queueProfileId")) return p;
      const next = { ...p };
      if (next.printerPoolId === undefined) next.printerPoolId = next.queueProfileId;
      delete next.queueProfileId;
      changed = true;
      return next;
    });
    cfg.printers = printers;
  }

  if (cfg.queueManagement && cfg.queueManagement.mode === "farm-pool") {
    cfg.queueManagement = { ...cfg.queueManagement, mode: "shared-queue" };
    changed = true;
  }

  return { cfg, changed };
}

module.exports = { migratePrinterPoolConfig };

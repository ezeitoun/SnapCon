const test = require("node:test");
const assert = require("node:assert/strict");
const { migratePrinterPoolConfig } = require("../../queue/migratePrinterPool");

test("migrates old-format queueProfiles/queueProfileId/farm-pool to printerPools/printerPoolId/shared-queue", () => {
  const oldCfg = {
    queueManagement: { enabled: true, mode: "farm-pool" },
    queueProfiles: [
      { id: "qp_default_manual", name: "Default Manual", type: "manual", isDefault: true }
    ],
    printers: [
      { id: "prt_1", name: "MK4S_01", queueProfileId: "qp_default_manual" },
      { id: "prt_2", name: "MK4S_02" } // no assignment — must survive untouched
    ]
  };
  const { cfg, changed } = migratePrinterPoolConfig(oldCfg);
  assert.equal(changed, true);
  assert.equal(cfg.queueProfiles, undefined);
  assert.deepEqual(cfg.printerPools, [
    { id: "qp_default_manual", name: "Default Manual", type: "manual", isDefault: true }
  ]);
  assert.equal(cfg.printers[0].printerPoolId, "qp_default_manual");
  assert.equal(cfg.printers[0].queueProfileId, undefined);
  assert.equal(cfg.printers[1].printerPoolId, undefined);
  assert.equal(cfg.printers[1].queueProfileId, undefined);
  assert.equal(cfg.queueManagement.mode, "shared-queue");
  // The old input object itself must be untouched (pure function).
  assert.equal(oldCfg.queueProfiles.length, 1);
  assert.equal(oldCfg.printers[0].queueProfileId, "qp_default_manual");
});

test("a second pass over an already-migrated config is a true no-op", () => {
  const migrated = {
    queueManagement: { enabled: true, mode: "shared-queue" },
    printerPools: [{ id: "qp_default_manual", name: "Default Manual" }],
    printers: [{ id: "prt_1", printerPoolId: "qp_default_manual" }]
  };
  const { cfg, changed } = migratePrinterPoolConfig(migrated);
  assert.equal(changed, false);
  assert.deepEqual(cfg, migrated);
});

test("a brand-new config with neither old nor new fields is a no-op", () => {
  const fresh = { queueManagement: { enabled: false, mode: "per-printer" } };
  const { cfg, changed } = migratePrinterPoolConfig(fresh);
  assert.equal(changed, false);
  assert.deepEqual(cfg, fresh);
});

test("printerPoolId already set is preserved even if a stray queueProfileId also exists", () => {
  const mixed = {
    printers: [{ id: "prt_1", printerPoolId: "pp_real", queueProfileId: "qp_stale" }]
  };
  const { cfg, changed } = migratePrinterPoolConfig(mixed);
  assert.equal(changed, true);
  assert.equal(cfg.printers[0].printerPoolId, "pp_real");
  assert.equal(cfg.printers[0].queueProfileId, undefined);
});

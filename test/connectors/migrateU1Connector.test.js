// test/connectors/migrateU1Connector.test.js — the retired-U1-connector
// migration. The behavior worth protecting is not "the string changed": it's
// that a printer keeps its identity (id, url, token, pool assignment, group
// access) across the swap, that nothing else in the fleet is touched, and
// that re-running is a true no-op so server.js can call it on every startup.
const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateU1ConnectorConfig, OLD_TYPE, NEW_TYPE } = require("../../connectors/migrateU1Connector");
const { CONNECTOR_TYPES, DEFAULT_TYPE } = require("../../connectors");

test("rewrites the retired U1 connector and leaves every other field verbatim", () => {
  const oldCfg = {
    printers: [
      {
        id: "prt_1", name: "U1 Pink", url: "http://192.168.1.50", connector: OLD_TYPE,
        token: "secret", serial: "SN123", printerPoolId: "qp_default_manual",
        allowedGroups: ["grp_1"], tags: ["garage"], forceDefaults: false
      }
    ]
  };
  const { cfg, changed } = migrateU1ConnectorConfig(oldCfg);
  assert.equal(changed, true);
  assert.deepEqual(cfg.printers[0], { ...oldCfg.printers[0], connector: NEW_TYPE });
  // Pure — the caller's object must not be mutated.
  assert.equal(oldCfg.printers[0].connector, OLD_TYPE);
});

test("printers on other connectors are untouched, and only the matching ones flip", () => {
  const { cfg, changed } = migrateU1ConnectorConfig({
    printers: [
      { id: "prt_1", connector: OLD_TYPE },
      { id: "prt_2", connector: "creality-klipper" },
      { id: "prt_3", connector: "flashforge-adventurer" },
      { id: "prt_4", connector: NEW_TYPE },
      { id: "prt_5" } // no connector at all — the server derives one; not this migration's job
    ]
  });
  assert.equal(changed, true);
  assert.deepEqual(cfg.printers.map(p => p.connector), [
    NEW_TYPE, "creality-klipper", "flashforge-adventurer", NEW_TYPE, undefined
  ]);
});

test("a second pass over an already-migrated config is a true no-op", () => {
  const migrated = { printers: [{ id: "prt_1", connector: NEW_TYPE }] };
  const { cfg, changed } = migrateU1ConnectorConfig(migrated);
  assert.equal(changed, false);
  assert.deepEqual(cfg, migrated);
  // Identity, not just equality: server.js re-points its module-level
  // PRINTERS at cfg.printers on every startup, so an untouched config must
  // hand back the same objects rather than equal-looking copies.
  assert.equal(cfg.printers, migrated.printers);
  assert.equal(cfg.printers[0], migrated.printers[0]);
});

test("a config with no printers array at all survives untouched", () => {
  for (const input of [{}, { printers: undefined }, { printers: [] }]) {
    const { cfg, changed } = migrateU1ConnectorConfig(input);
    assert.equal(changed, false);
    assert.deepEqual(cfg, input);
  }
});

test("the migration's target is a registered connector, and the retired one is not", () => {
  // Guards the pairing between this module and connectors/index.js: migrating
  // to a type the REGISTRY doesn't know would leave every U1 falling back to
  // DEFAULT_TYPE, and re-registering the old type would make the migration
  // rewrite a connector a user could still legitimately pick.
  assert.ok(CONNECTOR_TYPES.includes(NEW_TYPE));
  assert.ok(!CONNECTOR_TYPES.includes(OLD_TYPE));
  assert.equal(DEFAULT_TYPE, NEW_TYPE);
});

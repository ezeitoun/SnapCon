const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Store = require("../../remote-access/RemoteAccessStore");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-store-"));
}

test("load() returns defaults when no file exists yet", () => {
  const dir = tempBaseDir();
  const cfg = Store.load(dir);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.hubId, null);
});

test("save()/load() round-trip persists a patch", () => {
  const dir = tempBaseDir();
  Store.save(dir, { enabled: true, hubId: "hub_1", hostname: "hub1.snapcon.app" });
  const cfg = Store.load(dir);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.hubId, "hub_1");
  assert.equal(cfg.hostname, "hub1.snapcon.app");
});

test("save() never writes a tunnelToken field even if a caller mistakenly passes one", () => {
  const dir = tempBaseDir();
  Store.save(dir, { enabled: true, tunnelToken: "should-not-be-here" });
  const raw = fs.readFileSync(Store.filePath(dir), "utf8");
  assert.ok(!raw.includes("should-not-be-here"), "raw persisted file must never contain a token value");
});

test("getOrCreateInstallationId() is generated once and stable across calls", () => {
  const dir = tempBaseDir();
  const id1 = Store.getOrCreateInstallationId(dir);
  const id2 = Store.getOrCreateInstallationId(dir);
  assert.equal(id1, id2);
  assert.equal(Store.load(dir).installationId, id1);
});

test("getOrCreateInstallationId() persists across a fresh load of the same directory", () => {
  const dir = tempBaseDir();
  const id1 = Store.getOrCreateInstallationId(dir);
  // simulate a process restart: nothing cached in memory, re-read from disk
  const cfg = Store.load(dir);
  assert.equal(cfg.installationId, id1);
});

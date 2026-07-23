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

test("save() never writes a privateKey or ed25519PrivateKeyJwk field even if a caller mistakenly passes one", () => {
  const dir = tempBaseDir();
  Store.save(dir, { enabled: true, privateKey: "should-not-be-here", ed25519PrivateKeyJwk: "should-not-be-here-either" });
  const raw = fs.readFileSync(Store.filePath(dir), "utf8");
  assert.ok(!raw.includes("should-not-be-here"), "raw persisted file must never contain a private key value");
  assert.ok(!raw.includes("should-not-be-here-either"), "raw persisted file must never contain a private key value");
});

test("registration fields round-trip through save()/load() with correct defaults", () => {
  const dir = tempBaseDir();
  let cfg = Store.load(dir);
  assert.equal(cfg.registrationSessionId, null);
  assert.equal(cfg.registerUrl, null);
  assert.equal(cfg.registrationExpiresAt, null);

  Store.save(dir, { installationId: "inst_abc", registrationSessionId: "regsess_1", registerUrl: "https://api.snapcon.app/register/regsess_1", registrationExpiresAt: "2026-07-21T15:00:00.000Z" });
  cfg = Store.load(dir);
  assert.equal(cfg.installationId, "inst_abc");
  assert.equal(cfg.registrationSessionId, "regsess_1");
  assert.equal(cfg.registerUrl, "https://api.snapcon.app/register/regsess_1");
  assert.equal(cfg.registrationExpiresAt, "2026-07-21T15:00:00.000Z");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRemoteAccessService } = require("../../remote-access/RemoteAccessService");
const Store = require("../../remote-access/RemoteAccessStore");
const { CODES, ProvisioningError } = require("../../remote-access/RemoteAccessApiClient");
const { getSecureCredentialStore } = require("../../remote-access/SecureCredentialStore");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-service-"));
}

// Safety net, not a substitute for cleaning up in each test: enable()/
// startupInit() arm a self-re-scheduling probe timer that runs forever until
// disable() is called — a test that forgets to disable() leaves a REAL,
// indefinitely-repeating timer alive, which previously kept this entire test
// FILE's process running for over an hour before it was noticed and killed
// manually. Every service created via makeService() is tracked here and
// force-disabled after all tests in this file finish, regardless of whether
// the individual test remembered to.
const createdServices = [];
test.after(async () => {
  for (const svc of createdServices) { try { await svc.disable(); } catch {} }
});

function fakeProcessManager() {
  let running = false;
  const startCalls = [];
  return {
    startCalls,
    async start(token) { startCalls.push(token); running = true; },
    async stop() { running = false; },
    getStatus() { return { processRunning: running, sawConnectionEvidence: false, restartCount: 0, lastError: null }; },
    onStatusChange() {}
  };
}

function fakeApiClientAlwaysProvisions(hub) {
  const calls = [];
  return {
    calls,
    isDevelopmentPreview: () => true,
    async provisionHub(args) { calls.push(args); return hub; }
  };
}

function makeService(dir, overrides = {}) {
  const usersEnabled = overrides.usersEnabled !== undefined ? overrides.usersEnabled : true;
  const users = overrides.users || [{ role: "admin" }];
  const svc = createRemoteAccessService({
    baseDir: dir,
    getConfig: () => ({ usersEnabled }),
    getUsers: () => users,
    port: 4545,
    apiClient: overrides.apiClient || fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned" }),
    processManager: overrides.processManager || fakeProcessManager()
  });
  createdServices.push(svc);
  return svc;
}

test("validateRemoteAccessSecurity: disallowed when usersEnabled is false", () => {
  const dir = tempBaseDir();
  const svc = makeService(dir, { usersEnabled: false });
  const result = svc.validateRemoteAccessSecurity();
  assert.equal(result.allowed, false);
  assert.match(result.reason, /User Access Management|login/i);
});

test("validateRemoteAccessSecurity: disallowed when usersEnabled is true but no admin exists", () => {
  const dir = tempBaseDir();
  const svc = makeService(dir, { usersEnabled: true, users: [{ role: "regular" }] });
  const result = svc.validateRemoteAccessSecurity();
  assert.equal(result.allowed, false);
  assert.match(result.reason, /admin/i);
});

test("validateRemoteAccessSecurity: allowed when usersEnabled is true and an admin exists", () => {
  const dir = tempBaseDir();
  const svc = makeService(dir, { usersEnabled: true, users: [{ role: "admin" }] });
  assert.equal(svc.validateRemoteAccessSecurity().allowed, true);
});

test("enable() refuses and never calls provisionHub when the security precondition fails", async () => {
  const dir = tempBaseDir();
  const apiClient = fakeApiClientAlwaysProvisions({});
  const svc = makeService(dir, { usersEnabled: false, apiClient });
  const result = await svc.enable();
  assert.equal(result.ok, false);
  assert.equal(apiClient.calls.length, 0, "provisionHub must never be called when the security check fails");
});

test("enable() on a fresh install provisions once, persists hub info (no token in the plain JSON), and starts the process with the token", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned" });
  const svc = makeService(dir, { apiClient, processManager: pm });

  const result = await svc.enable();
  assert.equal(result.ok, true);
  assert.equal(apiClient.calls.length, 1);
  assert.deepEqual(pm.startCalls, ["tok_1"]);

  const persisted = Store.load(dir);
  assert.equal(persisted.hubId, "hub_1");
  assert.equal(persisted.enabled, true);
  const raw = fs.readFileSync(Store.filePath(dir), "utf8");
  assert.ok(!raw.includes("tok_1"), "the raw token must never land in the persisted plain-JSON store");
  await svc.disable(); // stop the probe cycle enable() armed — see the test.after() note above
});

test("enable() called again (re-enable) reuses the existing hub/token — provisionHub is not called a second time", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned" });
  const svc = makeService(dir, { apiClient, processManager: pm });

  await svc.enable();
  await svc.disable();
  await svc.enable(); // re-enable after disable — must reuse, not re-provision

  assert.equal(apiClient.calls.length, 1, "a re-enable must never call provisionHub again");
  assert.deepEqual(pm.startCalls, ["tok_1", "tok_1"]);
  await svc.disable();
});

test("enable() surfaces AMBIGUOUS_TIMEOUT distinctly and never lets the manager auto-retry", async () => {
  const dir = tempBaseDir();
  const apiClient = {
    isDevelopmentPreview: () => true,
    calls: [],
    async provisionHub() { this.calls.push(1); throw new ProvisioningError(CODES.AMBIGUOUS_TIMEOUT, "timed out"); }
  };
  const svc = makeService(dir, { apiClient });
  const result = await svc.enable();
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.AMBIGUOUS_TIMEOUT);
  assert.equal(apiClient.calls.length, 1, "RemoteAccessService itself must never retry an ambiguous provisioning call");
});

test("disable() stops the process but retains hubId/hostname/token for a later re-enable", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const svc = makeService(dir, { processManager: pm });
  await svc.enable();
  await svc.disable();

  assert.equal(pm.getStatus().processRunning, false);
  const persisted = Store.load(dir);
  assert.equal(persisted.enabled, false);
  assert.equal(persisted.hubId, "hub_1", "hubId must be retained across disable()");
  const secureStore = await getSecureCredentialStore(dir, { allowInsecureFallback: true });
  assert.equal(await secureStore.get("tunnelToken"), "tok_1", "the token must still be retrievable after disable() — disable is not delete");
});

test("startupInit() is a no-op when persisted state is not enabled", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const svc = makeService(dir, { processManager: pm });
  await svc.startupInit();
  assert.equal(pm.startCalls.length, 0);
});

test("startupInit() starts the process from the stored token without provisioning again", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned" });
  const svc = makeService(dir, { apiClient, processManager: pm });
  await svc.enable(); // simulates a prior session having enabled it

  const pm2 = fakeProcessManager(); // simulates a fresh process manager after a SnapCon restart
  const svc2 = makeService(dir, { apiClient, processManager: pm2 });
  await svc2.startupInit();

  assert.deepEqual(pm2.startCalls, ["tok_1"]);
  assert.equal(apiClient.calls.length, 1, "startupInit() must never provision — only the original enable() call should have");
  await svc.disable();
  await svc2.disable();
});

test("startupInit() surfaces a clean error state and never starts anything when the token is missing", async () => {
  const dir = tempBaseDir();
  Store.save(dir, { enabled: true, hubId: "hub_1", hostname: "h.snapcon.app", publicUrl: "https://h.snapcon.app" });
  // deliberately: no secureStore.set("tunnelToken", ...) was ever called for this dir
  const pm = fakeProcessManager();
  const svc = makeService(dir, { processManager: pm });
  await svc.startupInit();
  assert.equal(pm.startCalls.length, 0, "must never start the process with no token");
  assert.equal(svc.getStatus().state, "error");
  assert.match(svc.getStatus().lastError, /missing|could not be decrypted/i);
});

test("getStatus() never includes the token in any field", async () => {
  const dir = tempBaseDir();
  const svc = makeService(dir);
  await svc.enable();
  const status = svc.getStatus();
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes("tok_1"));
  assert.equal(status.developmentPreview, true);
  await svc.disable();
});

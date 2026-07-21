const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRemoteAccessService } = require("../../remote-access/RemoteAccessService");
const Store = require("../../remote-access/RemoteAccessStore");
const { CODES, ProvisioningError } = require("../../remote-access/RemoteAccessApiClient");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-service-"));
}

// Without this, enable()/startupInit() call the REAL getSecureCredentialStore(),
// which spawns a real powershell.exe (Windows DPAPI probe) on every single
// call — ~0.5-1s each, on every enable()/startupInit() in every test, and
// (worse) real timing that made the concurrent-enable() serialization test
// below flaky, since the assertion window needed to outlast an unpredictable
// real subprocess spawn. Backed by a real Map keyed by baseDir so multiple
// loadSecureStore() calls against the same directory within one test (e.g.
// disable() then re-enable()) still see the same persisted token.
function fakeSecureCredentialStoreFn() {
  const backingStores = new Map();
  return async function fakeGetSecureCredentialStore(dir) {
    if (!backingStores.has(dir)) backingStores.set(dir, new Map());
    const store = backingStores.get(dir);
    return {
      usingInsecureFallback: false,
      async get(key) { return store.has(key) ? store.get(key) : null; },
      async set(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); }
    };
  };
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

// Simulates the real bug this was written to catch: the child process fails
// to spawn/immediately exits, CloudflaredManager captures its own lastError,
// but start() itself never throws (matches the real CloudflaredManager,
// which logs the failure into its status rather than rejecting start()).
function fakeProcessManagerThatFailsToSpawn(errorMessage) {
  const startCalls = [];
  return {
    startCalls,
    async start(token) { startCalls.push(token); },
    async stop() {},
    getStatus() { return { processRunning: false, sawConnectionEvidence: false, restartCount: 0, lastError: errorMessage }; },
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

// Shared across every makeService() call in this file (keyed internally by
// baseDir, so different tests' distinct temp dirs never collide) — this is
// what lets two service instances created for the SAME dir (e.g. simulating
// a SnapCon restart) see the same persisted fake token.
const sharedFakeSecureStore = fakeSecureCredentialStoreFn();

function makeService(dir, overrides = {}) {
  const usersEnabled = overrides.usersEnabled !== undefined ? overrides.usersEnabled : true;
  const users = overrides.users || [{ role: "admin" }];
  const svc = createRemoteAccessService({
    baseDir: dir,
    getConfig: () => ({ usersEnabled }),
    getUsers: () => users,
    port: 4545,
    apiClient: overrides.apiClient || fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned" }),
    processManager: overrides.processManager || fakeProcessManager(),
    probeFn: overrides.probeFn || (async () => false), // fails fast by default — no real network calls in tests
    getSecureCredentialStoreFn: overrides.getSecureCredentialStoreFn || sharedFakeSecureStore,
    // Without this override, enable()/startupInit() call the REAL
    // CFM.ensureInstalled(), which — for a fresh temp baseDir with no
    // existing binary — downloads the actual ~50MB cloudflared binary from
    // GitHub on every single test that calls enable(). That's slow,
    // network-dependent, and flaky offline/in CI; every test in this file
    // is about RemoteAccessService's own orchestration logic, not binary
    // installation (already covered by checksumVerification.test.js).
    ensureInstalledFn: overrides.ensureInstalledFn || (async () => {})
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
  const secureStore = await sharedFakeSecureStore(dir);
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

// Regression test for a real bug hit during manual testing: enable()
// succeeded (provisioning worked, a public URL was assigned), but the
// underlying cloudflared process failed to actually run — and getStatus()
// showed "Tunnel process: Stopped" with an EMPTY "Last error" and a state
// stuck on "starting" forever, because getStatus() only ever surfaced
// RemoteAccessService's own lastError, never CloudflaredManager's, and
// recomputeState() had no path to "error" for "process never came up."
test("getStatus() surfaces the process manager's own lastError, and state moves to error, when the process fails to spawn", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManagerThatFailsToSpawn("cloudflared binary is not installed — call ensureInstalled() first.");
  const svc = makeService(dir, { processManager: pm });

  await svc.enable();
  const status = svc.getStatus();
  assert.equal(status.processRunning, false);
  assert.equal(status.lastError, "cloudflared binary is not installed — call ensureInstalled() first.",
    "the process manager's own error must reach the client, not just RemoteAccessService's higher-level lastError");
  assert.equal(status.state, "error", "a process that never came up (with a concrete captured error) must not stay stuck on 'starting' forever");
  await svc.disable();
});

// Hardening: found by code review, not live testing. runProbe() used to
// unconditionally reschedule itself at the end regardless of whether
// disable() had run while it was mid-flight (each probe awaits up to two
// real HTTP requests) — meaning a Disable click during that window would
// leave a probe loop running forever against a now-dead tunnel, since
// clearTimeout() only cancels the NEXT scheduled probe, not one already
// in flight.
test("disable() during an in-flight probe discards its stale result instead of applying it", async () => {
  const dir = tempBaseDir();
  const pendingResolvers = [];
  const probeFn = () => new Promise(resolve => { pendingResolvers.push(resolve); });
  const svc = makeService(dir, { probeFn });

  await svc.enable(); // schedules a probe with delay 0 — it starts almost immediately and gets stuck awaiting probeFn
  await svc.disable(); // bumps the probe generation while that probe is still stuck mid-flight

  // Let every probeFn call currently pending (local + public, whichever
  // ran) resolve as if the tunnel were healthy — if the generation guard is
  // missing, this stale result would otherwise get applied.
  for (let round = 0; round < 3; round++) {
    while (pendingResolvers.length) pendingResolvers.shift()(true);
    await new Promise(r => setTimeout(r, 30));
  }

  const status = svc.getStatus();
  assert.equal(status.publicEndpointHealthy, false, "a probe cancelled by disable() must not apply its stale (post-disable) result");
  assert.equal(status.localServiceReachable, false, "same for the local reachability flag");
  assert.equal(status.state, "disabled");
});

// Hardening: found by code review, not live testing. Nothing previously
// stopped two overlapping enable() calls (e.g. a double-clicked Enable
// button, or a retried request) from both reaching the "no existing hub"
// branch and both calling provisionHub() — creating two Hubs, exactly the
// duplicate-provisioning risk this whole design exists to avoid.
test("concurrent enable() calls are serialized — provisionHub is only ever called once", async () => {
  const dir = tempBaseDir();
  let provisionCalls = 0;
  let resolveProvision;
  const apiClient = {
    isDevelopmentPreview: () => true,
    async provisionHub() {
      provisionCalls++;
      return new Promise(resolve => { resolveProvision = resolve; });
    }
  };
  const svc = makeService(dir, { apiClient });

  const p1 = svc.enable(); // starts, gets stuck awaiting provisionHub's unresolved promise
  const p2 = svc.enable(); // called immediately after, before p1 has resolved anything

  await new Promise(r => setTimeout(r, 20)); // let p1 reach its stuck await; p2 must still be waiting its turn
  assert.equal(provisionCalls, 1, "a second concurrent enable() must not call provisionHub while the first is still in flight");

  resolveProvision({ hubId: "hub_1", hostname: "h.snapcon.app", publicUrl: "https://h.snapcon.app", tunnelId: "t1", tunnelToken: "tok_1", status: "provisioned" });
  await p1;
  await p2; // now runs — persisted.hubId/token already exist from p1, so it must reuse them, not provision again

  assert.equal(provisionCalls, 1, "the second call, once it actually runs after the first fully settles, must reuse the existing hub rather than provisioning again");
  await svc.disable();
});

// Hardening: found by code review. processManager.start() isn't expected to
// throw (spawn failures land in its own getStatus().lastError instead) —
// but enable()/startupInit() previously had no try/catch around the call at
// all, so if it ever DID throw for any reason (e.g. InstanceLock.record()
// failing to write — itself hardened separately), the exception would
// propagate uncaught past the "state = 'starting'" assignment, leaving the
// UI stuck on "Starting" forever with no error surfaced anywhere — the same
// class of bug fixed earlier for a different failure path.
test("enable() surfaces a clean error state if processManager.start() unexpectedly throws, instead of leaving state stuck on starting", async () => {
  const dir = tempBaseDir();
  const pm = {
    async start() { throw new Error("simulated unexpected spawn failure"); },
    async stop() {},
    getStatus() { return { processRunning: false, sawConnectionEvidence: false, restartCount: 0, lastError: null }; },
    onStatusChange() {}
  };
  const svc = makeService(dir, { processManager: pm });

  const result = await svc.enable();
  assert.equal(result.ok, false);
  assert.match(svc.getStatus().lastError, /simulated unexpected spawn failure/);
  assert.equal(svc.getStatus().state, "error", "must not remain stuck on 'starting' when start() throws");
});

test("startupInit() surfaces a clean error state if processManager.start() unexpectedly throws", async () => {
  const dir = tempBaseDir();
  const workingPm = fakeProcessManager();
  const svc1 = makeService(dir, { processManager: workingPm });
  await svc1.enable(); // establishes a real stored hub/token to restore from
  await svc1.disable();

  const throwingPm = {
    async start() { throw new Error("simulated unexpected spawn failure on restart"); },
    async stop() {},
    getStatus() { return { processRunning: false, sawConnectionEvidence: false, restartCount: 0, lastError: null }; },
    onStatusChange() {}
  };
  Store.save(dir, { enabled: true }); // simulate the config still being enabled at next boot
  const svc2 = makeService(dir, { processManager: throwingPm });
  await svc2.startupInit();

  assert.equal(svc2.getStatus().state, "error");
  assert.match(svc2.getStatus().lastError, /simulated unexpected spawn failure on restart/);
});

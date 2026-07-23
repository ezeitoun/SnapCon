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

function futureIso(msFromNow = 15 * 60000) {
  return new Date(Date.now() + msFromNow).toISOString();
}

// Registration + provisioning now complete asynchronously after enable()
// returns (see RemoteAccessService.js: enable() on a fresh install kicks off
// a registration-session poll rather than provisioning synchronously) — so
// tests that need the flow to have actually finished poll for it instead of
// asserting immediately after `await svc.enable()`.
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor() timed out waiting for condition to become true");
}

// Without this, enable()/startupInit() call the REAL getSecureCredentialStore(),
// which spawns a real powershell.exe (Windows DPAPI probe) on every single
// call — ~0.5-1s each, on every enable()/startupInit() in every test, and
// (worse) real timing that made the concurrent-enable() serialization test
// below flaky, since the assertion window needed to outlast an unpredictable
// real subprocess spawn. Backed by a real Map keyed by baseDir so multiple
// loadSecureStore() calls against the same directory within one test (e.g.
// disable() then re-enable()) still see the same persisted fake token.
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

// Default fake API client covering the full fresh-install flow: an unsigned
// registration session that's immediately "approved" (no real human/browser
// involved in tests), followed by provisionHub() returning the given hub.
// `calls` tracks provisionHub invocations specifically (matches the old
// tests' naming/shape); `registrationCalls` tracks createRegistrationSession.
function fakeApiClientAlwaysProvisions(hub) {
  const calls = [];
  const registrationCalls = [];
  return {
    calls,
    registrationCalls,
    async createRegistrationSession(args) {
      registrationCalls.push(args);
      return { sessionId: "regsess_1", installationId: "inst_1", registerUrl: "https://api.snapcon.app/register/regsess_1", expiresAt: futureIso() };
    },
    async getRegistrationSessionStatus(sessionId) {
      return { sessionId, status: "approved", installationId: "inst_1", expiresAt: futureIso() };
    },
    async provisionHub(args) { calls.push(args); return hub; },
    async disableHub() { throw new Error("disableHub not configured on this fake — override it explicitly for removeRemoteAccess() tests"); }
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
    apiClient: overrides.apiClient || fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false }),
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

test("enable() on a fresh install registers, provisions once, persists hub info (no token in the plain JSON), and starts the process with the token", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false });
  const svc = makeService(dir, { apiClient, processManager: pm });

  const result = await svc.enable();
  assert.equal(result.ok, true);
  await waitFor(() => pm.startCalls.length >= 1);

  assert.equal(apiClient.registrationCalls.length, 1);
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
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false });
  const svc = makeService(dir, { apiClient, processManager: pm });

  await svc.enable();
  await waitFor(() => pm.startCalls.length >= 1);
  await svc.disable();
  await svc.enable(); // re-enable after disable — must reuse, not re-provision

  assert.equal(apiClient.calls.length, 1, "a re-enable must never call provisionHub again");
  assert.deepEqual(pm.startCalls, ["tok_1", "tok_1"]);
  await svc.disable();
});

test("a provisionHub failure during registration completion surfaces as AMBIGUOUS_TIMEOUT in getStatus() and is never auto-retried", async () => {
  const dir = tempBaseDir();
  let provisionCalls = 0;
  const apiClient = {
    async createRegistrationSession() { return { sessionId: "regsess_1", installationId: "inst_1", registerUrl: "https://api.snapcon.app/register/regsess_1", expiresAt: futureIso() }; },
    async getRegistrationSessionStatus(sessionId) { return { sessionId, status: "approved", installationId: "inst_1", expiresAt: futureIso() }; },
    async provisionHub() { provisionCalls++; throw new ProvisioningError(CODES.AMBIGUOUS_TIMEOUT, "timed out"); }
  };
  const svc = makeService(dir, { apiClient });

  const result = await svc.enable();
  assert.equal(result.ok, true, "enable() itself only kicks off registration on a fresh install — provisioning happens later, asynchronously");
  await waitFor(() => svc.getStatus().state === "error");
  assert.match(svc.getStatus().lastError, /outcome unknown/i);
  assert.equal(provisionCalls, 1, "RemoteAccessService itself must never retry an ambiguous provisioning call");
  await svc.disable();
});

test("registration ending in 'expired' or 'rejected' surfaces as an error state and never calls provisionHub", async () => {
  for (const finalStatus of ["expired", "rejected"]) {
    const dir = tempBaseDir();
    let provisionCalls = 0;
    const apiClient = {
      async createRegistrationSession() { return { sessionId: "regsess_1", installationId: "inst_1", registerUrl: "https://api.snapcon.app/register/regsess_1", expiresAt: futureIso() }; },
      async getRegistrationSessionStatus(sessionId) { return { sessionId, status: finalStatus, installationId: "inst_1", expiresAt: futureIso() }; },
      async provisionHub() { provisionCalls++; throw new Error("must not be called for a " + finalStatus + " session"); }
    };
    const svc = makeService(dir, { apiClient });
    await svc.enable();
    await waitFor(() => svc.getStatus().state === "error");
    assert.match(svc.getStatus().lastError, new RegExp(finalStatus, "i"));
    assert.equal(provisionCalls, 0, finalStatus + " must never call provisionHub");
    await svc.disable();
  }
});

// The single most important regression guard for the new dedicated
// registrationGeneration counter — exact analog of the existing
// "disable() during an in-flight probe" test below, for the registration
// poll loop instead of the connection probe loop.
test("disable() mid-registration discards the stale poll result instead of provisioning after the fact", async () => {
  const dir = tempBaseDir();
  let resolveStatus;
  let provisionCalls = 0;
  const apiClient = {
    async createRegistrationSession() { return { sessionId: "regsess_1", installationId: "inst_1", registerUrl: "https://api.snapcon.app/register/regsess_1", expiresAt: futureIso() }; },
    getRegistrationSessionStatus() { return new Promise(resolve => { resolveStatus = resolve; }); },
    async provisionHub() { provisionCalls++; return { hubId: "hub_1", hostname: "hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false }; }
  };
  const svc = makeService(dir, { apiClient });

  await svc.enable(); // registers, schedules the first poll (delay 0) — gets stuck awaiting getRegistrationSessionStatus
  await new Promise(r => setTimeout(r, 20)); // let the poll actually reach its stuck await
  await svc.disable(); // bumps registrationGeneration while the poll is still mid-flight

  resolveStatus({ sessionId: "regsess_1", status: "approved", installationId: "inst_1", expiresAt: futureIso() });
  await new Promise(r => setTimeout(r, 50)); // give the stale continuation a chance to (wrongly) run if the guard were missing

  assert.equal(provisionCalls, 0, "a registration approval discovered after disable() must not resurrect provisioning");
  assert.equal(svc.getStatus().state, "disabled");
});

test("disable() stops the process but retains hubId/hostname/token for a later re-enable", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const svc = makeService(dir, { processManager: pm });
  await svc.enable();
  await waitFor(() => pm.startCalls.length >= 1);
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
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false });
  const svc = makeService(dir, { apiClient, processManager: pm });
  await svc.enable(); // simulates a prior session having enabled it
  await waitFor(() => pm.startCalls.length >= 1);

  const pm2 = fakeProcessManager(); // simulates a fresh process manager after a SnapCon restart
  const svc2 = makeService(dir, { apiClient, processManager: pm2 });
  await svc2.startupInit();

  assert.deepEqual(pm2.startCalls, ["tok_1"]);
  assert.equal(apiClient.calls.length, 1, "startupInit() must never provision — only the original enable() call should have");
  await svc.disable();
  await svc2.disable();
});

test("a legacy install (persisted hubId/token, no installationId or identity) reconnects via startupInit() without any registration/provisioning calls", async () => {
  const dir = tempBaseDir();
  Store.save(dir, { enabled: true, hubId: "hub_5a23cd576411", hostname: "5a23cd576411.snapcon.app", publicUrl: "https://5a23cd576411.snapcon.app", tunnelId: "c3d018ff-255c-45dd-936e-5abe83f07e4f" });
  const secureStore = await sharedFakeSecureStore(dir);
  await secureStore.set("tunnelToken", "legacy-tok");
  const pm = fakeProcessManager();
  let registrationCalls = 0, provisionCalls = 0;
  const apiClient = {
    async createRegistrationSession() { registrationCalls++; throw new Error("must not be called for a legacy reuse"); },
    async provisionHub() { provisionCalls++; throw new Error("must not be called for a legacy reuse"); }
  };
  const svc = makeService(dir, { apiClient, processManager: pm });
  await svc.startupInit();

  assert.deepEqual(pm.startCalls, ["legacy-tok"]);
  assert.equal(registrationCalls, 0);
  assert.equal(provisionCalls, 0);
  await svc.disable();
});

test("enable() on a legacy install (persisted hubId, no installationId) reuses the existing token without any registration/provisioning calls", async () => {
  const dir = tempBaseDir();
  Store.save(dir, { hubId: "hub_5a23cd576411", hostname: "5a23cd576411.snapcon.app", publicUrl: "https://5a23cd576411.snapcon.app", tunnelId: "c3d018ff-255c-45dd-936e-5abe83f07e4f" });
  const secureStore = await sharedFakeSecureStore(dir);
  await secureStore.set("tunnelToken", "legacy-tok");
  const pm = fakeProcessManager();
  let registrationCalls = 0, provisionCalls = 0;
  const apiClient = {
    async createRegistrationSession() { registrationCalls++; throw new Error("must not be called"); },
    async provisionHub() { provisionCalls++; throw new Error("must not be called"); }
  };
  const svc = makeService(dir, { apiClient, processManager: pm });
  const result = await svc.enable();

  assert.equal(result.ok, true);
  assert.deepEqual(pm.startCalls, ["legacy-tok"]);
  assert.equal(registrationCalls, 0);
  assert.equal(provisionCalls, 0);
  await svc.disable();
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

test("getStatus() never includes the token or private key in any field", async () => {
  const dir = tempBaseDir();
  const svc = makeService(dir);
  await svc.enable();
  await waitFor(() => svc.getStatus().state !== "registering" && svc.getStatus().state !== "provisioning" && svc.getStatus().state !== "downloading");
  const status = svc.getStatus();
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes("tok_1"));
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
  await waitFor(() => svc.getStatus().state === "error");
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

  await svc.enable();
  await waitFor(() => pendingResolvers.length > 0); // wait for provisioning to finish and the first probe to be scheduled/in-flight
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

test("concurrent enable() calls on a fresh install are serialized — only one registration session (and one provisionHub call) is ever created", async () => {
  const dir = tempBaseDir();
  let registrationCalls = 0;
  let provisionCalls = 0;
  const apiClient = {
    async createRegistrationSession() {
      registrationCalls++;
      return { sessionId: "regsess_1", installationId: "inst_1", registerUrl: "https://api.snapcon.app/register/regsess_1", expiresAt: futureIso() };
    },
    async getRegistrationSessionStatus(sessionId) {
      return { sessionId, status: "approved", installationId: "inst_1", expiresAt: futureIso() };
    },
    async provisionHub() {
      provisionCalls++;
      return { hubId: "hub_1", hostname: "hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false };
    }
  };
  const svc = makeService(dir, { apiClient });

  const [r1, r2] = await Promise.all([svc.enable(), svc.enable()]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(registrationCalls, 1, "a second concurrent enable() must reuse the session the first one created, not create a new one");

  await waitFor(() => provisionCalls >= 1);
  await new Promise(r => setTimeout(r, 30)); // let any stale/duplicate continuation, if one existed, also have a chance to run
  assert.equal(provisionCalls, 1, "provisionHub must only ever be called once even with two concurrent enable() calls");
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
  assert.equal(result.ok, true, "enable() itself only kicks off registration on a fresh install — the failure happens later, asynchronously");
  await waitFor(() => svc.getStatus().state === "error");
  assert.match(svc.getStatus().lastError, /simulated unexpected spawn failure/);
  assert.equal(svc.getStatus().state, "error", "must not remain stuck on 'starting' when start() throws");
});

test("startupInit() surfaces a clean error state if processManager.start() unexpectedly throws", async () => {
  const dir = tempBaseDir();
  const workingPm = fakeProcessManager();
  const svc1 = makeService(dir, { processManager: workingPm });
  await svc1.enable(); // establishes a real stored hub/token to restore from
  await waitFor(() => workingPm.startCalls.length >= 1);
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

// Regression tests for fixes applied after a code review of this feature.

function controllableProcessManager() {
  let status = { processRunning: false, sawConnectionEvidence: false, restartCount: 0, lastError: null };
  let listener = null;
  return {
    async start() { status.processRunning = true; },
    async stop() { status.processRunning = false; },
    getStatus() { return { ...status }; },
    onStatusChange(fn) { listener = fn; },
    // test-only: simulates CloudflaredManager reporting a status change
    // (e.g. a new stdout line, a crash, a successful restart) and firing
    // the registered onCloudflaredEvent callback exactly like the real
    // stdout/stderr 'data' handlers do.
    simulate(patch) { Object.assign(status, patch); if (listener) listener({}); }
  };
}

test("recomputeState() does not crash when Store.save() throws (e.g. a disk-full/permissions error at the exact moment of first connecting)", async () => {
  const dir = tempBaseDir();
  const pm = controllableProcessManager();
  const svc = makeService(dir, { processManager: pm, probeFn: async () => true });
  await svc.enable();
  await waitFor(() => pm.getStatus().processRunning === true);

  const originalSave = Store.save;
  Store.save = () => { throw new Error("simulated disk-full error"); };
  try {
    // Drives recomputeState() into the branch that calls Store.save() —
    // must not throw synchronously out of simulate()/onCloudflaredEvent,
    // which in the real system is called from an uncatchable context
    // (a child-process stream 'data' handler / an un-awaited setTimeout).
    await new Promise(r => setTimeout(r, 50)); // let the probe (probeFn always true) resolve at least once
    pm.simulate({ sawConnectionEvidence: true });
  } finally {
    Store.save = originalSave;
  }
  // No assertion beyond "didn't throw" — reaching here at all is the point.
  await svc.disable();
});

test("recomputeState() recovers out of 'error' once the process genuinely comes back up (no longer permanently stuck)", async () => {
  const dir = tempBaseDir();
  const pm = controllableProcessManager();
  const svc = makeService(dir, { processManager: pm, probeFn: async () => true });
  await svc.enable();
  await waitFor(() => pm.getStatus().processRunning === true);

  // Simulate an early crash with a captured error, before ever connecting.
  pm.simulate({ processRunning: false, lastError: "simulated early crash" });
  assert.equal(svc.getStatus().state, "error", "a genuine early failure must still be reported as an error");

  // Simulate CloudflaredManager's own backoff-restart succeeding afterwards.
  pm.simulate({ processRunning: true, sawConnectionEvidence: true, lastError: null });
  await new Promise(r => setTimeout(r, 50)); // let the (always-true) probe mark publicEndpointHealthy
  pm.simulate({}); // re-trigger recomputeState() now that the probe has resolved

  assert.equal(svc.getStatus().state, "connected", "a real recovery must be reflected, not stuck on 'error' forever");
  await svc.disable();
});

test("a successful reconnect clears a stale lastError instead of showing it next to a Connected badge", async () => {
  const dir = tempBaseDir();
  const pm = controllableProcessManager();
  const svc = makeService(dir, { processManager: pm, probeFn: async () => true });
  await svc.enable();
  await waitFor(() => pm.getStatus().processRunning === true);

  pm.simulate({ processRunning: false, lastError: "simulated early crash" });
  assert.match(svc.getStatus().lastError, /simulated early crash/);

  pm.simulate({ processRunning: true, sawConnectionEvidence: true, lastError: null });
  await new Promise(r => setTimeout(r, 50));
  pm.simulate({});

  assert.equal(svc.getStatus().state, "connected");
  assert.equal(svc.getStatus().lastError, null, "a stale error from an earlier failed attempt must not linger once genuinely connected");
  await svc.disable();
});

test("enable() refuses (does not provision a second Hub) when a Hub is already persisted but its token can't be read back", async () => {
  const dir = tempBaseDir();
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false });
  const pm = fakeProcessManager();
  const svc = makeService(dir, { apiClient, processManager: pm });
  await svc.enable(); // establishes a real persisted hubId + token
  await waitFor(() => pm.startCalls.length >= 1);
  await svc.disable();

  // Simulate the token becoming unreadable (corrupted/deleted keychain
  // entry) while hubId remains persisted — the exact scenario that
  // previously fell through to silently provisioning a second Hub.
  const brokenSecureStore = async () => ({
    usingInsecureFallback: false,
    async get() { return null; }, // token unreadable
    async set() {}, async delete() {}
  });
  const svc2 = makeService(dir, { apiClient, processManager: pm, getSecureCredentialStoreFn: brokenSecureStore });
  Store.save(dir, { enabled: false }); // disable() already did this; explicit for clarity
  const result = await svc2.enable();

  assert.equal(result.ok, false);
  assert.match(result.error, /already provisioned|missing or could not be decrypted/i);
  assert.equal(apiClient.calls.length, 1, "must NOT call provisionHub again — the original enable() call above is the only one that should have");
  const persisted = Store.load(dir);
  assert.equal(persisted.hubId, "hub_1", "the original hubId must be left untouched, not overwritten by a second provisioning attempt");
});

// ---- removeRemoteAccess() ----

test("removeRemoteAccess() happy path: stops the process, calls disableHub once, clears secrets and persisted fields", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const disableHubCalls = [];
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false });
  apiClient.disableHub = async (args) => { disableHubCalls.push(args); return { hubId: "hub_1", status: "revoked", deletionStatus: "complete" }; };
  const svc = makeService(dir, { apiClient, processManager: pm });
  await svc.enable();
  await waitFor(() => pm.startCalls.length >= 1);

  const result = await svc.removeRemoteAccess();
  assert.equal(result.ok, true);
  assert.equal(result.warning, null);
  assert.equal(disableHubCalls.length, 1);
  assert.equal(disableHubCalls[0].hubId, "hub_1");
  assert.equal(pm.getStatus().processRunning, false);

  const persisted = Store.load(dir);
  assert.equal(persisted.hubId, null);
  assert.equal(persisted.installationId, null);
  assert.equal(persisted.registrationSessionId, null);

  const secureStore = await sharedFakeSecureStore(dir);
  assert.equal(await secureStore.get("tunnelToken"), null);
  assert.equal(await secureStore.get("ed25519PrivateKeyJwk"), null);
});

test("removeRemoteAccess() on AMBIGUOUS_TIMEOUT does not clear local state — a second call is expected to work", async () => {
  const dir = tempBaseDir();
  const pm = fakeProcessManager();
  const apiClient = fakeApiClientAlwaysProvisions({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false });
  let shouldFail = true;
  apiClient.disableHub = async () => {
    if (shouldFail) { shouldFail = false; throw new ProvisioningError(CODES.AMBIGUOUS_TIMEOUT, "timed out"); }
    return { hubId: "hub_1", status: "revoked", deletionStatus: "complete" };
  };
  const svc = makeService(dir, { apiClient, processManager: pm });
  await svc.enable();
  await waitFor(() => pm.startCalls.length >= 1);

  const first = await svc.removeRemoteAccess();
  assert.equal(first.ok, false);
  assert.equal(first.code, CODES.AMBIGUOUS_TIMEOUT);
  assert.equal(Store.load(dir).hubId, "hub_1", "local state must be retained after an ambiguous outcome — a retry must still be possible");

  const second = await svc.removeRemoteAccess();
  assert.equal(second.ok, true);
  assert.equal(Store.load(dir).hubId, null);
});

test("removeRemoteAccess() against a legacy install with no signable identity skips disableHub, clears local state, and returns a manual-cleanup warning", async () => {
  const dir = tempBaseDir();
  // Matches a real pre-Milestone-B install: hubId persisted, but no
  // installationId and no stored private key were ever set for this dir.
  Store.save(dir, { enabled: false, hubId: "hub_5a23cd576411", hostname: "5a23cd576411.snapcon.app", publicUrl: "https://5a23cd576411.snapcon.app", tunnelId: "c3d018ff-255c-45dd-936e-5abe83f07e4f" });
  let disableHubCalled = false;
  const apiClient = { async disableHub() { disableHubCalled = true; } };
  const svc = makeService(dir, { apiClient });

  const result = await svc.removeRemoteAccess();
  assert.equal(result.ok, true);
  assert.match(result.warning, /manually|Cloudflare dashboard/i);
  assert.equal(disableHubCalled, false, "there is no way to sign a DELETE for a legacy install — disableHub must never be called");
  assert.equal(Store.load(dir).hubId, null, "local state must still be cleared even though the backend couldn't be reached");
});

test("removeRemoteAccess() is a no-op when nothing is provisioned locally", async () => {
  const dir = tempBaseDir();
  const svc = makeService(dir);
  const result = await svc.removeRemoteAccess();
  assert.equal(result.ok, true);
});

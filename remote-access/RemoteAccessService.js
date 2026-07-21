// remote-access/RemoteAccessService.js — the orchestrator. This is the ONLY
// module server.js talks to for Remote Access; it in turn owns
// RemoteAccessStore, SecureCredentialStore, CloudflaredManager, and
// RemoteAccessApiClient. Nothing outside this file ever touches a
// child_process, a secret, or the provisioning backend directly — the
// handful of requireAdmin routes server.js registers on top of this are the
// narrow API surface the browser is allowed to reach.
const Store = require("./RemoteAccessStore");
const CFM = require("./CloudflaredManager");
const ApiClient = require("./RemoteAccessApiClient");
const { getSecureCredentialStore } = require("./SecureCredentialStore");
const { redact } = require("./redact");

// Any completed HTTP response counts as "reachable" — the point is proving
// the request round-tripped through Cloudflare's edge back to this SnapCon
// instance, not that it got a specific status. Only a network-level failure
// (timeout, refused, DNS, TLS) means "not reachable." See plan: "Public
// endpoint probe."
async function probeUrl(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const PROBE_STEADY_MS = 20000; // within the specified 15-30s range

// baseDir: server.js's BASE_DIR. getConfig()/getUsers(): closures reading
// server.js's live CFG/USERS globals — passed in rather than imported so
// this module never needs to know about server.js's load/save timing, and
// so tests can inject fakes. port: the actually-configured listen port
// (never hardcoded 4545).
function createRemoteAccessService({ baseDir, getConfig, getUsers, port, apiClient = ApiClient, processManager = CFM.createProcessManager(baseDir) }) {
  let state = "disabled";
  let lastError = null;
  let publicEndpointHealthy = false;
  let localServiceReachable = false;
  let usingInsecureFallback = false;
  let everConnectedThisSession = false;
  let probeTimer = null;
  let probeFailureCount = 0;

  function validateRemoteAccessSecurity() {
    const cfg = getConfig();
    if (!cfg.usersEnabled) {
      return { allowed: false, reason: "SnapCon login protection (User Access Management) is not enabled. Enable it in Settings → General first." };
    }
    if (!getUsers().some(u => u.role === "admin")) {
      return { allowed: false, reason: "No Admin account exists yet." };
    }
    // SnapCon has no reverse-proxy-only / forward-auth / trusted-localhost
    // auth mode today — this is the entire policy. If such a mode is ever
    // added, it must be checked here too, since a tunnel pointed straight at
    // this process would otherwise bypass it.
    return { allowed: true };
  }

  function recomputeState() {
    const persisted = Store.load(baseDir);
    if (!persisted.enabled) { state = "disabled"; return; }
    if (state === "error") return; // sticky until the next enable()/startupInit() attempt
    const cfmStatus = processManager.getStatus();
    const allThreeGood = cfmStatus.processRunning && cfmStatus.sawConnectionEvidence && publicEndpointHealthy;
    if (allThreeGood) {
      if (state !== "connected") Store.save(baseDir, { lastConnectedAt: new Date().toISOString() });
      state = "connected";
      everConnectedThisSession = true;
    } else if (everConnectedThisSession) {
      state = "reconnecting"; // was healthy before, this is a transient blip the backoff-restart is already handling
    } else if (cfmStatus.processRunning) {
      state = "starting";
    } else if (cfmStatus.lastError) {
      // Never successfully connected this session AND the process isn't
      // running AND there's a concrete captured error (e.g. spawn failed,
      // exited immediately) — this is not "still starting up," it's stuck.
      // Distinct from the reconnecting case above: a healthy system's own
      // transient crash-and-auto-restart cycle never reaches this branch
      // because everConnectedThisSession is already true by then.
      state = "error";
      if (!lastError) lastError = cfmStatus.lastError;
    }
    // else: leave whatever phase state (provisioning/downloading/starting)
    // enable()/startupInit() already set — the process hasn't come up yet
    // and nothing concrete has failed either.
  }

  function scheduleProbe(delayMs) {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(runProbe, delayMs);
  }

  // CloudflaredManager already redacts the token out of every line before
  // it reaches here — this is what actually puts a trail in the console
  // ("Capture stdout and stderr... redact secrets before writing anything
  // to logs"). Previously this callback discarded the line entirely and
  // only re-derived state, so a spawn failure or an early crash had no
  // visible trace anywhere (console or the status API) — see the getStatus()
  // lastError fix above for the other half of that gap.
  function onCloudflaredEvent(evt) {
    if (evt && evt.line) console.log("[remote-access] cloudflared: " + evt.line);
    recomputeState();
  }

  async function runProbe() {
    const persisted = Store.load(baseDir);
    const localOk = await probeUrl("http://127.0.0.1:" + port + "/api/remote-access/probe", 5000);
    localServiceReachable = localOk;
    let publicOk = false;
    if (persisted.publicUrl) publicOk = await probeUrl(persisted.publicUrl.replace(/\/+$/, "") + "/api/remote-access/probe", 5000);
    publicEndpointHealthy = publicOk;

    if (publicOk) { probeFailureCount = 0; scheduleProbe(PROBE_STEADY_MS); }
    else { probeFailureCount++; scheduleProbe(CFM.backoffDelay(probeFailureCount - 1)); }
    recomputeState();
  }

  async function loadSecureStore() {
    const persisted = Store.load(baseDir);
    return getSecureCredentialStore(baseDir, { allowInsecureFallback: !!persisted.allowInsecureFallback });
  }

  async function enable() {
    const security = validateRemoteAccessSecurity();
    if (!security.allowed) return { ok: false, error: security.reason };

    let secureStore;
    try {
      secureStore = await loadSecureStore();
    } catch (e) {
      state = "error"; lastError = e.message;
      return { ok: false, error: e.message };
    }
    usingInsecureFallback = !!secureStore.usingInsecureFallback;

    const persisted = Store.load(baseDir);
    Store.save(baseDir, { enabled: true });

    let tunnelToken;
    if (persisted.hubId && await secureStore.get("tunnelToken")) {
      // Re-enable: reuse the existing Hub/token, never provision a new one.
      tunnelToken = await secureStore.get("tunnelToken");
    } else {
      state = "provisioning";
      let hub;
      try {
        const installationId = Store.getOrCreateInstallationId(baseDir);
        hub = await apiClient.provisionHub({ installationId, localOrigin: "http://localhost:" + port });
      } catch (e) {
        state = "error";
        lastError = e.code === ApiClient.CODES.AMBIGUOUS_TIMEOUT
          ? "Provisioning request did not complete — outcome unknown. Do not click Enable again until you've confirmed whether a Hub was already created (see backend). " + redact(e.message, [])
          : redact(e.message, []);
        return { ok: false, error: lastError, code: e.code };
      }
      Store.save(baseDir, { hubId: hub.hubId, hostname: hub.hostname, publicUrl: hub.publicUrl, tunnelId: hub.tunnelId, createdAt: new Date().toISOString() });
      await secureStore.set("tunnelToken", hub.tunnelToken);
      tunnelToken = hub.tunnelToken;
    }

    state = "downloading";
    try {
      await CFM.ensureInstalled(baseDir);
    } catch (e) {
      state = "error"; lastError = redact(e.message, [tunnelToken]);
      return { ok: false, error: lastError };
    }

    state = "starting";
    processManager.onStatusChange(onCloudflaredEvent);
    await processManager.start(tunnelToken);
    Store.save(baseDir, { autoStart: true, cloudflaredVersion: CFM.getVersion(baseDir) });
    everConnectedThisSession = false;
    scheduleProbe(0);
    recomputeState();
    return { ok: true, pending: true };
  }

  // User-initiated: stops the tunnel but deliberately keeps the token and
  // hub identity so re-enabling reuses the same Hub/URL. Permanent deletion
  // is a separate, not-yet-exposed future action (see disableForRemoval note
  // below) pending a real DELETE /v1/hubs/{hubId} on the backend.
  async function disable() {
    clearTimeout(probeTimer);
    await processManager.stop();
    Store.save(baseDir, { enabled: false, autoStart: false });
    state = "disabled";
    lastError = null; // don't leave a stale error visible after an explicit, successful disable
    everConnectedThisSession = false;
    return { ok: true };
  }

  // Process exit (SIGINT/SIGTERM), not a user action: stops the child only,
  // never touches enabled/autoStart/the stored token, so the next boot's
  // startupInit() still reconnects automatically.
  async function disableForShutdown() {
    clearTimeout(probeTimer);
    await processManager.stop();
  }

  // TODO(milestone-b): the future "Remove Remote Access" action — deletes
  // the stored token and calls apiClient.disableHub() once that backend
  // endpoint exists. Not implemented, not exposed, not called anywhere in
  // Milestone A; present only so the shape is settled ahead of time.
  async function removeRemoteAccess() {
    throw new Error("Not implemented in Milestone A — see TODO in RemoteAccessService.removeRemoteAccess.");
  }

  async function startupInit() {
    const persisted = Store.load(baseDir);
    if (!persisted.enabled) { state = "disabled"; return; }

    const security = validateRemoteAccessSecurity();
    if (!security.allowed) {
      state = "error";
      lastError = "Remote Access was enabled, but " + security.reason + " Disable and re-enable once fixed.";
      return;
    }

    let secureStore;
    try {
      secureStore = await loadSecureStore();
    } catch (e) {
      state = "error"; lastError = "Stored credential is unavailable: " + e.message;
      return;
    }
    usingInsecureFallback = !!secureStore.usingInsecureFallback;

    const token = await secureStore.get("tunnelToken");
    if (!token) {
      // Never silently re-provision — this requires an explicit human
      // decision (re-enable), matching "don't silently provision a new
      // tunnel on every application start."
      state = "error";
      lastError = "Stored tunnel token is missing or could not be decrypted. Disable and re-enable Remote Access.";
      return;
    }

    state = "downloading";
    try {
      await CFM.ensureInstalled(baseDir);
    } catch (e) {
      state = "error"; lastError = redact(e.message, [token]);
      return;
    }

    state = "starting";
    processManager.onStatusChange(onCloudflaredEvent);
    await processManager.start(token);
    everConnectedThisSession = false;
    scheduleProbe(0);
    recomputeState();
  }

  function getStatus() {
    const persisted = Store.load(baseDir);
    const cfmStatus = processManager.getStatus();
    return {
      enabled: persisted.enabled,
      state,
      developmentPreview: apiClient.isDevelopmentPreview(),
      processRunning: cfmStatus.processRunning,
      logConnectionSeen: cfmStatus.sawConnectionEvidence,
      publicEndpointHealthy,
      localServiceReachable,
      publicUrl: persisted.publicUrl,
      hostname: persisted.hostname,
      lastConnectedAt: persisted.lastConnectedAt,
      // Bug fix: this used to be just the service-level `lastError` (set
      // only for security/provisioning/checksum/missing-token failures),
      // which meant a failure INSIDE the process itself (spawn error, exit
      // code, stderr line — CloudflaredManager's own `lastError`) was never
      // visible anywhere — "Tunnel process: Stopped" with an empty "Last
      // error" field and no console output either. Once we're past the
      // lifecycle stages that set the service-level error, the process's
      // own error is the relevant one to show.
      lastError: lastError || cfmStatus.lastError,
      restartCount: cfmStatus.restartCount,
      usingInsecureFallback
      // NEVER includes the token, in any form.
    };
  }

  return {
    validateRemoteAccessSecurity, enable, disable, disableForShutdown, removeRemoteAccess,
    startupInit, getStatus,
    // exported for tests only
    _internal: { recomputeState, scheduleProbe, probeUrl }
  };
}

module.exports = { createRemoteAccessService };

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
const { createSerializer } = require("./serialize");

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
function createRemoteAccessService({ baseDir, getConfig, getUsers, port, apiClient = ApiClient, processManager = CFM.createProcessManager(baseDir), probeFn = probeUrl, ensureInstalledFn = CFM.ensureInstalled, getSecureCredentialStoreFn = getSecureCredentialStore }) {
  let state = "disabled";
  let lastError = null;
  let publicEndpointHealthy = false;
  let localServiceReachable = false;
  let usingInsecureFallback = false;
  let everConnectedThisSession = false;
  let probeTimer = null;
  let probeFailureCount = 0;
  // Incremented by disable()/disableForShutdown(). A probe that's already
  // mid-flight (awaiting up to two 5s HTTP requests) when that happens would
  // otherwise still reschedule itself at the end, resurrecting an indefinite
  // probe loop against a now-dead tunnel after the user thought everything
  // was stopped. Each scheduled probe captures the generation it was
  // scheduled under and checks it's unchanged before applying results or
  // rescheduling.
  let probeGeneration = 0;

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
    // No longer sticky: an "error" set here (cfmStatus.lastError branch,
    // below) must be able to clear itself once CloudflaredManager's own
    // backoff-restart actually succeeds — otherwise the UI is stuck showing
    // "Error" forever even after a genuine, automatic recovery, and the only
    // way out is a manual disable/enable. "Fatal" errors set directly by
    // enable()/startupInit() (missing token, checksum mismatch, security
    // failure) are unaffected: those return before the process is ever
    // (re)started, so cfmStatus.processRunning stays false and none of the
    // branches below fire — state simply stays whatever those functions set.
    const cfmStatus = processManager.getStatus();
    const allThreeGood = cfmStatus.processRunning && cfmStatus.sawConnectionEvidence && publicEndpointHealthy;
    if (allThreeGood) {
      if (state !== "connected") {
        try {
          Store.save(baseDir, { lastConnectedAt: new Date().toISOString() });
        } catch (e) {
          // Best-effort bookkeeping, not something worth taking the whole
          // server down over — recomputeState() is reachable from a
          // synchronous stream-data handler and an un-awaited setTimeout
          // callback, neither of which has anything else to catch this.
          console.error("[remote-access] failed to persist lastConnectedAt (non-fatal):", e.message);
        }
      }
      state = "connected";
      lastError = null; // a stale error from an earlier failed attempt shouldn't linger next to a healthy "Connected" badge
      everConnectedThisSession = true;
    } else if (everConnectedThisSession) {
      state = "reconnecting"; // was healthy before, this is a transient blip the backoff-restart is already handling
    } else if (cfmStatus.processRunning) {
      state = "starting";
    } else if (cfmStatus.lastError) {
      // Never successfully connected this session AND the process isn't
      // running AND there's a concrete captured error (e.g. spawn failed,
      // exited immediately) — this is not "still starting up," it's stuck
      // (unless/until a later backoff-triggered restart succeeds, at which
      // point processRunning flips true and this branch stops being reached).
      state = "error";
      if (!lastError) lastError = cfmStatus.lastError;
    }
    // else: leave whatever phase state (provisioning/downloading/starting)
    // enable()/startupInit() already set — the process hasn't come up yet
    // and nothing concrete has failed either.
  }

  function scheduleProbe(delayMs) {
    const myGeneration = probeGeneration;
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => runProbe(myGeneration), delayMs);
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

  async function runProbe(myGeneration) {
    const persisted = Store.load(baseDir);
    // Independent checks (local vs. public) — run concurrently rather than
    // sequentially, so a probe cycle costs ~one 5s timeout in the worst case
    // instead of up to two stacked ones.
    const [localOk, publicOk] = await Promise.all([
      probeFn("http://127.0.0.1:" + port + "/api/remote-access/probe", 5000),
      persisted.publicUrl ? probeFn(persisted.publicUrl.replace(/\/+$/, "") + "/api/remote-access/probe", 5000) : Promise.resolve(false)
    ]);

    // disable()/disableForShutdown() ran while the two awaits above were in
    // flight — don't apply stale results and, critically, don't reschedule:
    // this is what stops the probe loop from surviving past disable().
    if (myGeneration !== probeGeneration) return;

    localServiceReachable = localOk;
    publicEndpointHealthy = publicOk;
    if (publicOk) { probeFailureCount = 0; scheduleProbe(PROBE_STEADY_MS); }
    else { probeFailureCount++; scheduleProbe(CFM.backoffDelay(probeFailureCount - 1)); }
    recomputeState();
  }

  async function loadSecureStore() {
    const persisted = Store.load(baseDir);
    return getSecureCredentialStoreFn(baseDir, { allowInsecureFallback: !!persisted.allowInsecureFallback });
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
    if (persisted.hubId) {
      const existingToken = await secureStore.get("tunnelToken");
      if (!existingToken) {
        // A Hub is already provisioned but its token can't be read back —
        // NEVER silently provision a second one to paper over this (that
        // orphans the first Hub on the backend forever; there's no working
        // delete yet). Matches startupInit()'s identical guard for the same
        // scenario — this function must refuse the exact same way, not
        // fall through to re-provisioning.
        state = "error";
        lastError = "A Hub (" + persisted.hubId + ") is already provisioned, but its stored tunnel token is missing or could not be decrypted. Disable and re-enable only after restoring or clearing the stored credential — re-enabling as-is will not create a new Hub automatically.";
        return { ok: false, error: lastError };
      }
      // Re-enable: reuse the existing Hub/token, never provision a new one.
      tunnelToken = existingToken;
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
      await ensureInstalledFn(baseDir);
    } catch (e) {
      state = "error"; lastError = redact(e.message, [tunnelToken]);
      return { ok: false, error: lastError };
    }

    state = "starting";
    processManager.onStatusChange(onCloudflaredEvent);
    try {
      await processManager.start(tunnelToken);
    } catch (e) {
      // Defensive: processManager.start() isn't expected to throw (spawn
      // failures land in its own lastError, surfaced via getStatus()
      // already) — but if it ever does for an unforeseen reason, this is
      // what stops the UI getting stuck on "Starting" forever with no
      // console trace either, same class of bug as the earlier fix for
      // invisible process-manager errors.
      state = "error"; lastError = redact(e.message, [tunnelToken]);
      return { ok: false, error: lastError };
    }
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
    probeGeneration++; // invalidate any in-flight probe — see the note by its declaration above
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
    probeGeneration++;
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
      await ensureInstalledFn(baseDir);
    } catch (e) {
      state = "error"; lastError = redact(e.message, [token]);
      return;
    }

    state = "starting";
    processManager.onStatusChange(onCloudflaredEvent);
    try {
      await processManager.start(token);
    } catch (e) {
      state = "error"; lastError = redact(e.message, [token]);
      return;
    }
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

  // enable()/disable()/startupInit() all mutate the same persisted state and
  // the same CloudflaredManager instance across multiple `await` points —
  // without this, two overlapping calls (a double-clicked Enable button, or
  // Disable clicked mid-provision) could interleave: e.g. two concurrent
  // enable() calls both seeing no existing hubId and both calling
  // provisionHub(), creating two Hubs — exactly the duplicate-provisioning
  // risk the rest of this design exists to avoid. Serializing them means a
  // second call simply waits for the first to fully settle before it starts,
  // rather than racing. disableForShutdown() is deliberately NOT included:
  // process exit is bounded (server.js force-exits 3s after signaling
  // shutdown) and must not wait behind a slow in-flight enable().
  //
  // Shared with CloudflaredManager's start()/stop()/restart(), which needed
  // the identical fix one layer down — see remote-access/serialize.js.
  const serialize = createSerializer();

  return {
    validateRemoteAccessSecurity,
    enable: serialize(enable),
    disable: serialize(disable),
    disableForShutdown,
    removeRemoteAccess,
    startupInit: serialize(startupInit),
    getStatus,
    // exported for tests only
    _internal: { recomputeState, scheduleProbe, probeUrl }
  };
}

module.exports = { createRemoteAccessService };

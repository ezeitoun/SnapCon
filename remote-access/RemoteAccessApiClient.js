// remote-access/RemoteAccessApiClient.js — client for the SnapCon Remote
// Access provisioning backend. Only provisionHub() is implemented against a
// real endpoint today; getHubStatus()/disableHub()/rotateTunnelToken() are
// present as named stubs so call sites elsewhere never need a rename when
// the backend grows those endpoints (Milestone B). None of the stubs are
// called anywhere in this codebase yet.
//
// Auth today is a single shared X-SnapCon-Provisioning-Key header — this is
// Development Preview only (see isDevelopmentPreview()), explicitly not a
// mechanism suitable for real customers. It is designed to be swapped for
// per-installation account/Hub-pairing auth later without callers changing.
//
// Env read at call time (not cached at module load) so tests can override
// per test:
//   SNAPCON_REMOTE_API_URL   default https://api.snapcon.app
//   SNAPCON_PROVISIONING_KEY no default; required for provisionHub() to run
const crypto = require("crypto");

function baseUrl() {
  return (process.env.SNAPCON_REMOTE_API_URL || "https://api.snapcon.app").replace(/\/+$/, "");
}
function provisioningKey() {
  return process.env.SNAPCON_PROVISIONING_KEY || "";
}
function isDevelopmentPreview() {
  // Today this is the ONLY auth mode that exists, so it's always true — kept
  // as its own function so Milestone B can flip it based on real auth
  // instead of every call site needing to know how.
  return true;
}

class ProvisioningError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "ProvisioningError";
    this.code = code; // one of the CODES below
    if (extra) Object.assign(this, extra);
  }
}
const CODES = Object.freeze({
  NO_PROVISIONING_KEY: "NO_PROVISIONING_KEY",
  AUTH_FAILED: "AUTH_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  BACKEND_ERROR: "BACKEND_ERROR",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  MISSING_TOKEN: "MISSING_TOKEN",
  // Request timed out or the connection dropped before any response
  // arrived — the true server-side outcome is UNKNOWN (a Hub may or may not
  // have been created). Never auto-retried anywhere in this codebase; the
  // admin must make the next move. See remote-access plan, "Provisioning
  // error handling."
  AMBIGUOUS_TIMEOUT: "AMBIGUOUS_TIMEOUT"
});

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// installationId: from RemoteAccessStore.getOrCreateInstallationId(baseDir)
// — stable across calls/restarts, so a retried logical provision attempt
// reuses the same Idempotency-Key even though the backend doesn't guarantee
// idempotency from that header alone yet (see plan: this is a client-side
// best-effort, not a substitute for the backend's own unique constraint).
async function provisionHub({ installationId, localOrigin }) {
  if (!provisioningKey()) {
    throw new ProvisioningError(CODES.NO_PROVISIONING_KEY, "SNAPCON_PROVISIONING_KEY is not set — Development Preview provisioning refuses to run without it.");
  }
  const idempotencyKey = crypto.createHash("sha256").update(installationId + ":provision").digest("hex");

  let res;
  try {
    res = await fetchWithTimeout(baseUrl() + "/v1/hubs/provision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SnapCon-Provisioning-Key": provisioningKey(),
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({ installationId, localOrigin })
    }, 10000);
  } catch (e) {
    // Covers AbortError (timeout) and any network-level failure (DNS,
    // connection refused, TLS, dropped mid-request) — all of these mean the
    // real outcome on the backend is unknown, not "failed."
    throw new ProvisioningError(CODES.AMBIGUOUS_TIMEOUT,
      "Provisioning request did not complete (network error or timeout) — outcome unknown. Do not retry automatically; a Hub may already have been created.",
      { cause: e.message });
  }

  if (res.status === 401) throw new ProvisioningError(CODES.AUTH_FAILED, "Provisioning backend rejected the request (401) — check SNAPCON_PROVISIONING_KEY.");
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    throw new ProvisioningError(CODES.RATE_LIMITED, "Provisioning backend rate-limited this request (429).", { retryAfter });
  }
  if (res.status >= 500) throw new ProvisioningError(CODES.BACKEND_ERROR, "Provisioning backend returned a server error (" + res.status + ").");

  let body;
  try {
    body = await res.json();
  } catch {
    throw new ProvisioningError(CODES.INVALID_RESPONSE, "Provisioning backend returned a response that was not valid JSON.");
  }
  if (!res.ok) {
    throw new ProvisioningError(CODES.BACKEND_ERROR, "Provisioning backend returned HTTP " + res.status + ".");
  }
  if (!body || typeof body.tunnelToken !== "string" || !body.tunnelToken) {
    throw new ProvisioningError(CODES.MISSING_TOKEN, "Provisioning response did not include a tunnelToken.");
  }
  return {
    hubId: body.hubId, hostname: body.hostname, publicUrl: body.publicUrl,
    tunnelId: body.tunnelId, tunnelToken: body.tunnelToken, status: body.status
  };
}

// ---- Milestone B scaffolding — not implemented on the backend yet, not
// called anywhere in this codebase. Present now so Milestone A's call sites
// (and the future "Remove Remote Access" action) don't need restructuring
// later. ----
async function getHubStatus() {
  throw new Error("Not implemented: GET /v1/hubs/{hubId} does not exist on the backend yet.");
}
async function disableHub() {
  // TODO(milestone-b): once DELETE /v1/hubs/{hubId} ships, this is what
  // RemoteAccessService's future "Remove Remote Access" action calls.
  throw new Error("Not implemented: DELETE /v1/hubs/{hubId} does not exist on the backend yet.");
}
async function rotateTunnelToken() {
  throw new Error("Not implemented: POST /v1/hubs/{hubId}/rotate-token does not exist on the backend yet.");
}

module.exports = {
  CODES, ProvisioningError,
  isDevelopmentPreview,
  provisionHub, getHubStatus, disableHub, rotateTunnelToken
};

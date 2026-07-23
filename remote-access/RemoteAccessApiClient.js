// remote-access/RemoteAccessApiClient.js — client for the SnapCon Remote
// Access provisioning backend (Milestone B). Implements the real, deployed
// contract at https://api.snapcon.app — see
// D:\code\scbe\snapcon-api\docs\CLIENT_INTEGRATION.md, which this file
// implements exactly.
//
// Auth: every /v1/hubs/* call is signed with the installation's Ed25519
// private key (see Ed25519Identity.js). Signing happens INSIDE this module
// (not the caller) — each signed function takes an `identity` (
// { installationId, privateKey }) and signs internally per-call, generating
// a fresh timestamp/nonce every time. Registration endpoints are unsigned.
//
// Env read at call time (not cached at module load) so tests can override
// per test:
//   SNAPCON_REMOTE_API_URL   default https://api.snapcon.app
const Ed25519Identity = require("./Ed25519Identity");

function baseUrl() {
  return (process.env.SNAPCON_REMOTE_API_URL || "https://api.snapcon.app").replace(/\/+$/, "");
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
  AUTH_FAILED: "AUTH_FAILED",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  STALE_TIMESTAMP: "STALE_TIMESTAMP",
  REPLAY_DETECTED: "REPLAY_DETECTED",
  UNKNOWN_INSTALLATION: "UNKNOWN_INSTALLATION",
  INSTALLATION_SUSPENDED: "INSTALLATION_SUSPENDED",
  INSTALLATION_REVOKED: "INSTALLATION_REVOKED",
  RATE_LIMITED: "RATE_LIMITED",
  BACKEND_ERROR: "BACKEND_ERROR",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  MISSING_TOKEN: "MISSING_TOKEN",
  INVALID_PUBLIC_KEY: "INVALID_PUBLIC_KEY",
  HUB_NOT_FOUND: "HUB_NOT_FOUND",
  SESSION_INVALID: "SESSION_INVALID",
  // Rotation is a deliberate, expected 503 today (see backend doc's
  // "Status right now") — distinct from BACKEND_ERROR so callers can show
  // "temporarily unavailable" instead of a generic failure, and must never
  // auto-retry-loop on it.
  ROTATION_UNAVAILABLE: "ROTATION_UNAVAILABLE",
  // Request timed out or the connection dropped before any response
  // arrived — the true server-side outcome is UNKNOWN. Never auto-retried
  // anywhere in this codebase; the admin must make the next move.
  AMBIGUOUS_TIMEOUT: "AMBIGUOUS_TIMEOUT"
});

// Maps the signed-endpoint 401/404/429/503 error-code shapes
// ({ error: "<snake_case_code>", message }) to CODES, per the backend
// doc's error table. Any unrecognized 401 sub-code still falls back to
// AUTH_FAILED so an unanticipated backend addition fails safe (visible
// "auth failed") rather than falling through to a generic BACKEND_ERROR.
const ERROR_CODE_MAP = {
  invalid_signature: CODES.INVALID_SIGNATURE,
  stale_timestamp: CODES.STALE_TIMESTAMP,
  replay_detected: CODES.REPLAY_DETECTED,
  unknown_installation: CODES.UNKNOWN_INSTALLATION,
  installation_suspended: CODES.INSTALLATION_SUSPENDED,
  installation_revoked: CODES.INSTALLATION_REVOKED,
  rate_limited: CODES.RATE_LIMITED,
  token_rotation_unavailable: CODES.ROTATION_UNAVAILABLE,
  hub_not_found: CODES.HUB_NOT_FOUND,
  invalid_public_key: CODES.INVALID_PUBLIC_KEY
};

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function doFetch(path, { method, body, headers }) {
  let res;
  try {
    res = await fetchWithTimeout(baseUrl() + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body !== undefined ? body : undefined
    }, 10000);
  } catch (e) {
    // Covers AbortError (timeout) and any network-level failure (DNS,
    // connection refused, TLS, dropped mid-request) — all of these mean the
    // real outcome on the backend is unknown, not "failed."
    throw new ProvisioningError(CODES.AMBIGUOUS_TIMEOUT,
      "Request to " + path + " did not complete (network error or timeout) — outcome unknown. Do not retry automatically.",
      { cause: e.message });
  }
  return res;
}

async function parseErrorBody(res) {
  try {
    const body = await res.json();
    return (body && typeof body.error === "string") ? body.error : null;
  } catch {
    return null;
  }
}

// Shared handling for the signed Hub-lifecycle endpoints' non-2xx statuses.
// Returns nothing (throws) — callers only reach past this on res.ok.
async function throwForErrorStatus(res) {
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    throw new ProvisioningError(CODES.RATE_LIMITED, "Backend rate-limited this request (429).", { retryAfter });
  }
  if (res.status === 503) {
    const errorCode = await parseErrorBody(res);
    if (errorCode === "token_rotation_unavailable") {
      throw new ProvisioningError(CODES.ROTATION_UNAVAILABLE, "Tunnel token rotation is temporarily unavailable.");
    }
    throw new ProvisioningError(CODES.BACKEND_ERROR, "Backend returned 503.");
  }
  if (res.status === 404) {
    const errorCode = await parseErrorBody(res);
    throw new ProvisioningError(CODES.HUB_NOT_FOUND, "Hub not found.", { errorCode });
  }
  if (res.status === 401) {
    const errorCode = await parseErrorBody(res);
    const mapped = errorCode && ERROR_CODE_MAP[errorCode];
    throw new ProvisioningError(mapped || CODES.AUTH_FAILED, "Backend rejected the request's signature (401" + (errorCode ? ": " + errorCode : "") + ").", { errorCode });
  }
  if (res.status === 400) {
    const errorCode = await parseErrorBody(res);
    const mapped = errorCode && ERROR_CODE_MAP[errorCode];
    throw new ProvisioningError(mapped || CODES.BACKEND_ERROR, "Backend rejected the request (400" + (errorCode ? ": " + errorCode : "") + ").", { errorCode });
  }
  if (res.status >= 500) throw new ProvisioningError(CODES.BACKEND_ERROR, "Backend returned a server error (" + res.status + ").");
  throw new ProvisioningError(CODES.BACKEND_ERROR, "Backend returned HTTP " + res.status + ".");
}

async function parseJsonOrThrow(res) {
  try {
    return await res.json();
  } catch {
    throw new ProvisioningError(CODES.INVALID_RESPONSE, "Backend returned a response that was not valid JSON.");
  }
}

// ---- Registration (unsigned) ----

async function createRegistrationSession({ publicKey, appVersion, platform, architecture } = {}) {
  const bodyStr = JSON.stringify({ publicKey, keyAlgorithm: "ed25519", appVersion, platform, architecture });
  const res = await doFetch("/v1/registration-sessions", { method: "POST", body: bodyStr });
  if (!res.ok) return throwForErrorStatus(res);

  const body = await parseJsonOrThrow(res);
  for (const field of ["sessionId", "installationId", "registerUrl", "expiresAt"]) {
    if (typeof body[field] !== "string" || !body[field]) {
      throw new ProvisioningError(CODES.INVALID_RESPONSE, "Registration session response is missing a valid '" + field + "'.");
    }
  }
  // registerUrl gets opened in the system browser and displayed as a
  // clickable link in the UI — same self-XSS-defense rationale as the old
  // publicUrl check: only https:// (the only scheme the real backend would
  // ever emit) is accepted.
  if (!/^https:\/\//i.test(body.registerUrl)) {
    throw new ProvisioningError(CODES.INVALID_RESPONSE, "Registration session response's registerUrl is not an https:// URL.");
  }
  return {
    sessionId: body.sessionId, installationId: body.installationId,
    registerUrl: body.registerUrl, expiresAt: body.expiresAt
  };
}

const VALID_SESSION_STATUSES = new Set(["pending", "approved", "expired", "rejected"]);

async function getRegistrationSessionStatus(sessionId) {
  const res = await doFetch("/v1/registration-sessions/" + encodeURIComponent(sessionId), { method: "GET" });
  if (!res.ok) {
    if (res.status === 404) throw new ProvisioningError(CODES.SESSION_INVALID, "Registration session not found.");
    return throwForErrorStatus(res);
  }
  const body = await parseJsonOrThrow(res);
  if (typeof body.status !== "string" || !VALID_SESSION_STATUSES.has(body.status)) {
    throw new ProvisioningError(CODES.INVALID_RESPONSE, "Registration session response has an unrecognized status.");
  }
  return { sessionId: body.sessionId, status: body.status, installationId: body.installationId, expiresAt: body.expiresAt };
}

// ---- Hub lifecycle (signed) ----

async function signedRequest({ identity, method, path, bodyStr }) {
  const { headers } = await Ed25519Identity.signRequest({
    privateKey: identity.privateKey,
    installationId: identity.installationId,
    method,
    pathWithQuery: path,
    body: bodyStr || ""
  });
  return doFetch(path, { method, headers, body: bodyStr });
}

async function provisionHub({ identity, recoverToken } = {}) {
  const bodyStr = JSON.stringify(recoverToken ? { recoverToken: true } : {});
  const res = await signedRequest({ identity, method: "POST", path: "/v1/hubs/provision", bodyStr });
  if (!res.ok) return throwForErrorStatus(res);

  const body = await parseJsonOrThrow(res);
  for (const field of ["hubId", "hostname", "status"]) {
    if (typeof body[field] !== "string" || !body[field]) {
      throw new ProvisioningError(CODES.INVALID_RESPONSE, "Provisioning response is missing a valid '" + field + "'.");
    }
  }
  // hostname gets concatenated into a URL and set as a clickable anchor's
  // href in the browser — reject anything that could turn that
  // concatenation into something other than a plain https:// origin before
  // it's ever used, equivalent-or-greater scrutiny to the old direct
  // publicUrl check now that the client builds the URL itself.
  if (/[:/\s]/.test(body.hostname)) {
    throw new ProvisioningError(CODES.INVALID_RESPONSE, "Provisioning response's hostname is not a bare hostname.");
  }
  const publicUrl = "https://" + body.hostname;

  if (body.existing === true) {
    // Every call after the first — by contract tunnelToken is null here.
    // This is success, not MISSING_TOKEN.
    return { hubId: body.hubId, hostname: body.hostname, publicUrl, tunnelId: body.tunnelId || null, tunnelToken: null, status: body.status, existing: true };
  }
  if (typeof body.tunnelToken !== "string" || !body.tunnelToken) {
    throw new ProvisioningError(CODES.MISSING_TOKEN, "Provisioning response did not include a tunnelToken.");
  }
  return { hubId: body.hubId, hostname: body.hostname, publicUrl, tunnelId: body.tunnelId, tunnelToken: body.tunnelToken, status: body.status, existing: false };
}

async function getHubStatus({ identity, hubId }) {
  const res = await signedRequest({ identity, method: "GET", path: "/v1/hubs/" + encodeURIComponent(hubId) });
  if (!res.ok) return throwForErrorStatus(res);
  const body = await parseJsonOrThrow(res);
  // Never surfaces a token-shaped field, even if the backend somehow sent
  // one — this response is not supposed to ever carry a real token.
  return {
    hubId: body.hubId, hostname: body.hostname, status: body.status,
    createdAt: body.createdAt, updatedAt: body.updatedAt,
    tokenRotatedAt: body.tokenRotatedAt || null, deletionStatus: body.deletionStatus || null
  };
}

async function rotateTunnelToken({ identity, hubId }) {
  const res = await signedRequest({ identity, method: "POST", path: "/v1/hubs/" + encodeURIComponent(hubId) + "/rotate-token", bodyStr: "" });
  if (!res.ok) return throwForErrorStatus(res);
  const body = await parseJsonOrThrow(res);
  if (typeof body.tunnelToken !== "string" || !body.tunnelToken) {
    throw new ProvisioningError(CODES.MISSING_TOKEN, "Rotation response did not include a tunnelToken.");
  }
  return { hubId: body.hubId, tunnelToken: body.tunnelToken, status: body.status };
}

async function disableHub({ identity, hubId }) {
  const res = await signedRequest({ identity, method: "DELETE", path: "/v1/hubs/" + encodeURIComponent(hubId) });
  if (!res.ok) return throwForErrorStatus(res);
  const body = await parseJsonOrThrow(res);
  // Idempotent — a second call succeeding again is expected, not an error.
  return { hubId: body.hubId, status: body.status, deletionStatus: body.deletionStatus };
}

module.exports = {
  CODES, ProvisioningError,
  createRegistrationSession, getRegistrationSessionStatus,
  provisionHub, getHubStatus, rotateTunnelToken, disableHub
};

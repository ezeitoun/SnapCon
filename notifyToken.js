// notifyToken.js — the local credential that authenticates the same-machine
// CLI hook (`SnapCon --load <file> --printer <name>`, no `--snapcon`) against
// /api/notify-load's privileged file-path branch. Extracted from server.js
// specifically so this is unit-testable without requiring server.js itself,
// which starts a real listening server as a side effect of being required
// (see configLoader.js for the same rationale applied to config.json).
//
// See CODE_AUDIT.md P0-3: req.socket.remoteAddress alone can't tell a
// genuinely local caller apart from Remote Access's tunnel-forwarded traffic
// (cloudflared runs as a local child process connecting to
// http://localhost:<port>, per snapcon-api's hardcoded SNAPCON_ORIGIN — so
// tunnel-forwarded requests look identical to loopback at the socket level).
// This token is what actually establishes "this really is the local
// machine" — proof of local filesystem access, not a network-location
// inference. isLoopback() stays as an *additional* check in server.js, not
// a substitute for this one.
//
// There is exactly ONE writer: the long-running server, once, at startup
// (ensureNotifyToken). The CLI invocation is a separate, short-lived process
// each time and only ever READS (readNotifyToken) — it never generates or
// persists a value. This is deliberate: if both the server and the CLI could
// independently generate a token, a race (or a persistence failure on one
// side but not the other) could leave them holding different values with no
// way to detect it. With a single writer, that's structurally impossible —
// the CLI either reads what the server already established, or it reads
// nothing and fails clearly.
const fs = require("fs");
const crypto = require("crypto");

const TOKEN_RE = /^[0-9a-f]{64}$/;

function readNotifyToken(tokenPath) {
  try {
    const data = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    if (data && typeof data.token === "string" && TOKEN_RE.test(data.token)) return data.token;
  } catch {}
  return null;
}

// Server-only. Returns the persisted token, generating and persisting a new
// one if none exists yet. Returns null (never throws) if a fresh token
// could not be durably persisted — the caller must fail closed in that case
// (refuse the privileged path entirely) rather than fall back to an
// in-memory-only value, which the CLI (a separate process) could never
// learn anyway and would just produce confusing, silently-mismatched state.
function ensureNotifyToken(tokenPath) {
  const existing = readNotifyToken(tokenPath);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(tokenPath, JSON.stringify({ token }, null, 2));
  } catch (e) {
    console.error(`[notify] could not persist a local notify token at ${tokenPath} — the local file-path print path (SnapCon --load/--printer, without --snapcon) will be unavailable until this is fixed: ${e.message}`);
    return null;
  }
  return token;
}

function timingSafeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { readNotifyToken, ensureNotifyToken, timingSafeTokenEqual };

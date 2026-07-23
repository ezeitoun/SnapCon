// remote-access/Ed25519Identity.js — per-installation Ed25519 keypair
// generation, encoding, and request signing for the Milestone B backend
// contract (see D:\code\scbe\snapcon-api\docs\CLIENT_INTEGRATION.md, which
// this module implements exactly). Pure crypto: no filesystem/store
// knowledge, same narrow-utility shape as redact.js/serialize.js.
const nodeCrypto = require("node:crypto");
const { webcrypto } = require("node:crypto");

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generateKeypair() {
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { publicKey, privateKey };
}

async function exportPublicKeyB64Url(publicKey) {
  const raw = await webcrypto.subtle.exportKey("raw", publicKey);
  return b64url(new Uint8Array(raw));
}

// Single-line JSON (JSON.stringify with no indent argument never emits a
// newline) — required by SecureCredentialStore.js's Windows DPAPI backend,
// which reads a stored value one line at a time over stdin and rejects
// anything containing \r\n.
async function exportPrivateKeyJwk(privateKey) {
  const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  return JSON.stringify(jwk);
}

async function importPrivateKeyJwk(jwkString) {
  const jwk = JSON.parse(jwkString);
  return webcrypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
}

// WebCrypto's JWK export for an Ed25519 (OKP) private key includes the
// public key coordinate alongside the private scalar ({ kty: "OKP", crv:
// "Ed25519", x: "<public, base64url>", d: "<private, base64url>" }) — so a
// stored private key JWK is enough to recover the matching public key
// without re-deriving it, e.g. to retry a failed registration session with
// the same already-generated keypair.
function publicKeyB64UrlFromPrivateJwk(jwkString) {
  return JSON.parse(jwkString).x;
}

// Sync, unlike the backend doc's reference implementation (which uses the
// async webcrypto.subtle.digest) — matches this codebase's existing
// crypto.createHash idiom and avoids an unnecessary await on every signed
// call. Verified to produce the identical documented empty-body constant.
function sha256Hex(bodyStrOrBuffer) {
  return nodeCrypto.createHash("sha256").update(bodyStrOrBuffer || "").digest("hex");
}

// 16 random bytes, hex-encoded (32 hex chars) — the literal reading of the
// backend contract's nonce requirement.
function randomNonceHex() {
  return nodeCrypto.randomBytes(16).toString("hex");
}

function canonicalString({ method, pathWithQuery, installationId, timestamp, nonce, bodyHashHex }) {
  return [method, pathWithQuery, installationId, String(timestamp), nonce, bodyHashHex].join("\n");
}

// nowFn/nonceFn are injectable purely for deterministic tests — same DI
// convention as CloudflaredManager's spawnFn/setTimeoutFn. A fresh
// timestamp/nonce is generated on every call: the backend enforces
// single-use nonces (401 replay_detected), so a retry must never resend
// identical signed bytes.
async function signRequest({ privateKey, installationId, method, pathWithQuery, body, nowFn = () => Math.floor(Date.now() / 1000), nonceFn = randomNonceHex }) {
  const bodyHashHex = sha256Hex(body || "");
  const timestamp = nowFn();
  const nonce = nonceFn();
  const canonical = canonicalString({ method, pathWithQuery, installationId, timestamp, nonce, bodyHashHex });
  const signature = await webcrypto.subtle.sign("Ed25519", privateKey, Buffer.from(canonical, "utf8"));
  return {
    headers: {
      "X-SnapCon-Installation-Id": installationId,
      "X-SnapCon-Timestamp": String(timestamp),
      "X-SnapCon-Nonce": nonce,
      "X-SnapCon-Signature": b64url(new Uint8Array(signature))
    }
  };
}

module.exports = {
  generateKeypair, exportPublicKeyB64Url, exportPrivateKeyJwk, importPrivateKeyJwk,
  publicKeyB64UrlFromPrivateJwk,
  sha256Hex, randomNonceHex, canonicalString, signRequest
};

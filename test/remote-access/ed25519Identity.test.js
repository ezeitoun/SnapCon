const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const Ed25519Identity = require("../../remote-access/Ed25519Identity");

test("generateKeypair() + exportPublicKeyB64Url() produces a 32-byte base64url key", async () => {
  const { publicKey } = await Ed25519Identity.generateKeypair();
  const b64 = await Ed25519Identity.exportPublicKeyB64Url(publicKey);
  assert.match(b64, /^[A-Za-z0-9_-]{43}$/, "raw 32-byte Ed25519 key base64url-encoded is exactly 43 chars with no padding");
});

test("signRequest() produces a signature that verifies against the exported public key", async () => {
  const { publicKey, privateKey } = await Ed25519Identity.generateKeypair();
  const { headers } = await Ed25519Identity.signRequest({
    privateKey,
    installationId: "inst_abc",
    method: "POST",
    pathWithQuery: "/v1/hubs/provision",
    body: "{}"
  });

  const canonical = Ed25519Identity.canonicalString({
    method: "POST",
    pathWithQuery: "/v1/hubs/provision",
    installationId: "inst_abc",
    timestamp: headers["X-SnapCon-Timestamp"],
    nonce: headers["X-SnapCon-Nonce"],
    bodyHashHex: Ed25519Identity.sha256Hex("{}")
  });

  const sigBytes = Buffer.from(headers["X-SnapCon-Signature"].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ok = await webcrypto.subtle.verify("Ed25519", publicKey, sigBytes, Buffer.from(canonical, "utf8"));
  assert.equal(ok, true);
});

test("exportPrivateKeyJwk()/importPrivateKeyJwk() round-trip preserves signing capability, and the JWK string is single-line", async () => {
  const { privateKey } = await Ed25519Identity.generateKeypair();
  const jwkString = await Ed25519Identity.exportPrivateKeyJwk(privateKey);
  assert.ok(!/[\r\n]/.test(jwkString), "the DPAPI backend rejects any stored value containing a newline — the exported JWK must be single-line");

  const reimported = await Ed25519Identity.importPrivateKeyJwk(jwkString);
  const { headers } = await Ed25519Identity.signRequest({
    privateKey: reimported,
    installationId: "inst_abc",
    method: "GET",
    pathWithQuery: "/v1/hubs/hub_1",
    body: ""
  });
  assert.match(headers["X-SnapCon-Signature"], /^[A-Za-z0-9_-]+$/);
});

test("publicKeyB64UrlFromPrivateJwk() recovers the same public key that was originally exported", async () => {
  const { publicKey, privateKey } = await Ed25519Identity.generateKeypair();
  const expectedPublicB64 = await Ed25519Identity.exportPublicKeyB64Url(publicKey);
  const jwkString = await Ed25519Identity.exportPrivateKeyJwk(privateKey);
  const recovered = Ed25519Identity.publicKeyB64UrlFromPrivateJwk(jwkString);
  assert.equal(recovered, expectedPublicB64);
});

test("canonicalString() matches an exact literal for fixed inputs", () => {
  const s = Ed25519Identity.canonicalString({
    method: "POST", pathWithQuery: "/v1/hubs/provision", installationId: "inst_abc",
    timestamp: 1753200000, nonce: "9f2c1a4b7d3e8f01a2b3c4d5e6f70819",
    bodyHashHex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  });
  assert.equal(s, "POST\n/v1/hubs/provision\ninst_abc\n1753200000\n9f2c1a4b7d3e8f01a2b3c4d5e6f70819\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("sha256Hex('') equals the documented empty-body constant", () => {
  assert.equal(Ed25519Identity.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("signRequest() with injected nowFn/nonceFn matches hand-computed headers exactly", async () => {
  const { privateKey } = await Ed25519Identity.generateKeypair();
  const { headers } = await Ed25519Identity.signRequest({
    privateKey, installationId: "inst_abc", method: "DELETE", pathWithQuery: "/v1/hubs/hub_1", body: "",
    nowFn: () => 1753200000, nonceFn: () => "9f2c1a4b7d3e8f01a2b3c4d5e6f70819"
  });
  assert.equal(headers["X-SnapCon-Timestamp"], "1753200000");
  assert.equal(headers["X-SnapCon-Nonce"], "9f2c1a4b7d3e8f01a2b3c4d5e6f70819");
  assert.equal(headers["X-SnapCon-Installation-Id"], "inst_abc");
});

test("randomNonceHex() never repeats across many calls", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const n = Ed25519Identity.randomNonceHex();
    assert.match(n, /^[0-9a-f]{32}$/);
    assert.ok(!seen.has(n), "nonce collision");
    seen.add(n);
  }
});

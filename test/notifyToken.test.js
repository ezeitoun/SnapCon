// test/notifyToken.test.js — unit tests for the local notify-token logic
// (notifyToken.js), extracted from server.js specifically so this is
// testable without requiring server.js itself (which starts a real
// listening server as a side effect of being required).
//
// Regression coverage for CODE_AUDIT.md's P0-3: /api/notify-load's
// file-path branch used to trust req.socket.remoteAddress alone, which
// Remote Access's tunnel-forwarded traffic can satisfy without ever being
// on the local machine. These tests cover the credential that now actually
// authenticates that branch, including the fail-closed behavior required
// when the token can't be durably persisted (never falling back to an
// in-memory-only value the CLI, a separate process, could never learn).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readNotifyToken, ensureNotifyToken, timingSafeTokenEqual } = require("../notifyToken");

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-notifytoken-test-"));
}

function withCapturedErrors(fn) {
  const original = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.join(" "));
  try { return { result: fn(), messages }; }
  finally { console.error = original; }
}

test("ensureNotifyToken: missing file generates, persists, and returns a 64-hex-char token", () => {
  const dir = scratchDir();
  const tokenPath = path.join(dir, "notify-token.json");
  const token = ensureNotifyToken(tokenPath);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(tokenPath, "utf8")), { token });
});

test("ensureNotifyToken: an existing valid file is returned unchanged, never rewritten", () => {
  const dir = scratchDir();
  const tokenPath = path.join(dir, "notify-token.json");
  const first = ensureNotifyToken(tokenPath);
  const rawBefore = fs.readFileSync(tokenPath, "utf8");
  const second = ensureNotifyToken(tokenPath);
  assert.equal(second, first);
  assert.equal(fs.readFileSync(tokenPath, "utf8"), rawBefore);
});

test("ensureNotifyToken: corrupt/malformed file content is treated as missing and regenerated", () => {
  const dir = scratchDir();
  const tokenPath = path.join(dir, "notify-token.json");
  fs.writeFileSync(tokenPath, "{ not valid json");
  const token = ensureNotifyToken(tokenPath);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test("ensureNotifyToken: a persistence failure logs clearly and returns null (fail closed) rather than an ephemeral in-memory token", () => {
  const dir = scratchDir();
  const tokenPath = path.join(dir, "notify-token.json");
  fs.mkdirSync(tokenPath); // makes writeFileSync throw EISDIR
  const { result, messages } = withCapturedErrors(() => ensureNotifyToken(tokenPath));
  assert.equal(result, null, "must fail closed, never return a value the CLI (a separate process) could never independently learn");
  assert.ok(messages.some(m => m.includes("could not persist")), "must log the persistence failure clearly");
});

test("readNotifyToken: missing file returns null and never creates one (the CLI must never be a writer)", () => {
  const dir = scratchDir();
  const tokenPath = path.join(dir, "notify-token.json");
  const token = readNotifyToken(tokenPath);
  assert.equal(token, null);
  assert.equal(fs.existsSync(tokenPath), false);
});

test("readNotifyToken: reads back exactly what ensureNotifyToken persisted", () => {
  const dir = scratchDir();
  const tokenPath = path.join(dir, "notify-token.json");
  const written = ensureNotifyToken(tokenPath);
  assert.equal(readNotifyToken(tokenPath), written);
});

test("readNotifyToken: corrupt file content returns null rather than throwing", () => {
  const dir = scratchDir();
  const tokenPath = path.join(dir, "notify-token.json");
  fs.writeFileSync(tokenPath, "not json at all");
  assert.equal(readNotifyToken(tokenPath), null);
});

test("timingSafeTokenEqual: matching tokens are equal", () => {
  const t = "a".repeat(64);
  assert.equal(timingSafeTokenEqual(t, t), true);
});

test("timingSafeTokenEqual: a wrong token is rejected", () => {
  assert.equal(timingSafeTokenEqual("a".repeat(64), "b".repeat(64)), false);
});

test("timingSafeTokenEqual: different-length values are rejected without throwing", () => {
  assert.equal(timingSafeTokenEqual("short", "a".repeat(64)), false);
});

test("timingSafeTokenEqual: missing/undefined header value is rejected without throwing", () => {
  assert.equal(timingSafeTokenEqual(undefined, "a".repeat(64)), false);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  getSecureCredentialStore, NoSecureStorageAvailableError, InsecureFileFallbackStore, _internal
} = require("../../remote-access/SecureCredentialStore");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-secure-"));
}
const unavailableCandidate = { label: "fake-unavailable", async probe() { return false; } };
const throwingCandidate = { label: "fake-throws", async probe() { throw new Error("boom"); } };

test("resolveStore throws NoSecureStorageAvailableError when native probe fails and fallback is not opted into", async () => {
  const dir = tempBaseDir();
  await assert.rejects(
    () => _internal.resolveStore(dir, unavailableCandidate, { allowInsecureFallback: false }),
    NoSecureStorageAvailableError
  );
});

test("resolveStore throws NoSecureStorageAvailableError even if the candidate's probe() itself throws", async () => {
  const dir = tempBaseDir();
  await assert.rejects(
    () => _internal.resolveStore(dir, throwingCandidate, { allowInsecureFallback: false }),
    NoSecureStorageAvailableError
  );
});

test("resolveStore never silently falls back — allowInsecureFallback defaults to false", async () => {
  const dir = tempBaseDir();
  await assert.rejects(() => _internal.resolveStore(dir, unavailableCandidate));
});

test("resolveStore uses InsecureFileFallbackStore only when allowInsecureFallback:true is explicit, and flags it", async () => {
  const dir = tempBaseDir();
  const store = await _internal.resolveStore(dir, unavailableCandidate, { allowInsecureFallback: true });
  assert.equal(store.usingInsecureFallback, true);
  await store.set("tunnelToken", "super-secret-value");
  assert.equal(await store.get("tunnelToken"), "super-secret-value");
});

test("resolveStore returns the native candidate (usingInsecureFallback:false) when its probe succeeds", async () => {
  const dir = tempBaseDir();
  const workingCandidate = {
    label: "fake-working",
    async probe() { return true; },
    async get() { return "value"; }, async set() {}, async delete() {}
  };
  const store = await _internal.resolveStore(dir, workingCandidate, { allowInsecureFallback: false });
  assert.equal(store.usingInsecureFallback, false);
});

test("InsecureFileFallbackStore: set/get/delete round-trip", async () => {
  const dir = tempBaseDir();
  const store = new InsecureFileFallbackStore(dir);
  assert.equal(await store.get("k"), null);
  await store.set("k", "hello world");
  assert.equal(await store.get("k"), "hello world");
  await store.delete("k");
  assert.equal(await store.get("k"), null);
});

test("InsecureFileFallbackStore: tampered ciphertext fails closed (returns null, never throws or returns garbage)", async () => {
  const dir = tempBaseDir();
  const store = new InsecureFileFallbackStore(dir);
  await store.set("k", "hello world");
  const tokenFile = store._tokenFile("k");
  const raw = fs.readFileSync(tokenFile);
  raw[raw.length - 1] ^= 0xff; // flip a byte in the ciphertext/tag
  fs.writeFileSync(tokenFile, raw);
  const result = await store.get("k");
  assert.equal(result, null, "GCM auth-tag mismatch must fail closed, not return corrupted plaintext");
});

test("InsecureFileFallbackStore: the on-disk key file is never equal to the stored ciphertext (sanity, not a real security claim)", async () => {
  const dir = tempBaseDir();
  const store = new InsecureFileFallbackStore(dir);
  await store.set("k", "hello world");
  const key = fs.readFileSync(store._keyFile());
  const ct = fs.readFileSync(store._tokenFile("k"));
  assert.notEqual(key.toString("hex"), ct.toString("hex"));
});

test("getSecureCredentialStore() smoke test on the current platform: either resolves natively or throws cleanly (never silently falls back without allowInsecureFallback)", async () => {
  const dir = tempBaseDir();
  try {
    const store = await getSecureCredentialStore(dir, { allowInsecureFallback: false });
    assert.equal(store.usingInsecureFallback, false);
  } catch (e) {
    assert.ok(e instanceof NoSecureStorageAvailableError);
  }
});

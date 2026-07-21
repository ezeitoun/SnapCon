const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CFM = require("../../remote-access/CloudflaredManager");

function tempBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-ra-cfm-"));
}

function withFetch(impl, fn) {
  const prev = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = prev; });
}

const FAKE_KEY = "fake-platform-x64";
function fakeManifest(assetBytes) {
  const hash = crypto.createHash("sha256").update(assetBytes).digest("hex");
  return { version: "9999.1.1", checksums: { [FAKE_KEY]: { asset: "fake-cloudflared-binary", sha256: hash } } };
}

// download()/ensureInstalled() only look up RELEASES by key for the asset
// filename/localBin — inject the same shape CloudflaredManager already
// expects by temporarily patching RELEASES for our fake key.
CFM.RELEASES[FAKE_KEY] = { asset: "fake-cloudflared-binary", localBin: "fake-cloudflared-binary" };

test("download() accepts a payload whose hash matches the manifest, writes meta.json with verified:true", async () => {
  const dir = tempBaseDir();
  const payload = Buffer.from("pretend this is a cloudflared binary, version A");
  const manifest = fakeManifest(payload);
  await withFetch(async () => ({ ok: true, arrayBuffer: async () => payload }), async () => {
    const finalPath = await CFM.download(dir, FAKE_KEY, manifest);
    assert.ok(fs.existsSync(finalPath));
    assert.deepEqual(fs.readFileSync(finalPath), payload);
  });
  const meta = CFM._internal.readMeta(dir);
  assert.equal(meta.verified, true);
  assert.equal(meta.version, "9999.1.1");
  assert.equal(meta.checksumSource, "vendor");
});

test("download() rejects a payload whose hash does not match the manifest, and writes nothing", async () => {
  const dir = tempBaseDir();
  const payload = Buffer.from("real payload");
  const manifest = fakeManifest(Buffer.from("a completely different payload")); // checksum for different bytes
  await withFetch(async () => ({ ok: true, arrayBuffer: async () => payload }), async () => {
    await assert.rejects(() => CFM.download(dir, FAKE_KEY, manifest), CFM.ChecksumMismatchError);
  });
  assert.equal(CFM._internal.readMeta(dir), null, "no meta.json should be written on a checksum mismatch");
  assert.equal(fs.existsSync(path.join(CFM.binDir(dir), "fake-cloudflared-binary")), false, "no binary should be left on disk on a checksum mismatch");
});

test("ensureInstalled() is a no-op when a verified, matching binary already exists on disk", async () => {
  const dir = tempBaseDir();
  const payload = Buffer.from("stable good binary");
  const manifest = fakeManifest(payload);
  let fetchCalls = 0;
  await withFetch(async () => { fetchCalls++; return { ok: true, arrayBuffer: async () => payload }; }, async () => {
    await CFM.ensureInstalled(dir, FAKE_KEY, manifest);
    await CFM.ensureInstalled(dir, FAKE_KEY, manifest); // second call should be a no-op, no re-download
  });
  assert.equal(fetchCalls, 1, "ensureInstalled must not re-download an already-verified, matching binary");
});

test("ensureInstalled() detects on-disk tampering since the last verification, deletes the file, and fails closed", async () => {
  const dir = tempBaseDir();
  const payload = Buffer.from("originally good binary");
  const manifest = fakeManifest(payload);
  await withFetch(async () => ({ ok: true, arrayBuffer: async () => payload }), async () => {
    await CFM.ensureInstalled(dir, FAKE_KEY, manifest);
  });
  // tamper with the on-disk binary after it was installed+verified
  const finalPath = path.join(CFM.binDir(dir), "fake-cloudflared-binary");
  fs.writeFileSync(finalPath, Buffer.from("tampered bytes, not what was verified"));

  await assert.rejects(() => CFM.ensureInstalled(dir, FAKE_KEY, manifest), CFM.ChecksumMismatchError);
  assert.equal(fs.existsSync(finalPath), false, "tampered binary must be deleted, not left in place");
  assert.equal(CFM._internal.readMeta(dir), null, "meta.json must be deleted alongside the tampered binary");
});

test("ensureInstalled() / download() reject an unsupported platform cleanly, never falling back to an unverified download", async () => {
  const dir = tempBaseDir();
  await assert.rejects(() => CFM.ensureInstalled(dir, "totally-unsupported-platform", CFM.MANIFEST), CFM.UnsupportedPlatformError);
  await assert.rejects(() => CFM.download(dir, "totally-unsupported-platform", CFM.MANIFEST), CFM.UnsupportedPlatformError);
});

test("the real committed manifest excludes darwin-x64, darwin-arm64, and win32-arm64 (documented, verified finding)", () => {
  const real = CFM.MANIFEST;
  assert.equal(real.checksums["darwin-x64"], undefined);
  assert.equal(real.checksums["darwin-arm64"], undefined);
  assert.equal(real.checksums["win32-arm64"], undefined);
  assert.ok(real.checksums["win32-x64"]);
  assert.ok(real.checksums["linux-x64"]);
  assert.ok(real.checksums["linux-arm64"]);
});

test("the real committed manifest's checksums are well-formed 64-char hex SHA-256 strings", () => {
  const real = CFM.MANIFEST;
  for (const [key, entry] of Object.entries(real.checksums)) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, key + " must have a valid-looking sha256");
    assert.ok(entry.asset && entry.asset.length > 0, key + " must name a real asset");
  }
});

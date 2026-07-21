// remote-access/CloudflaredManager.js — downloads, verifies, and (later
// commit) runs the `cloudflared` binary. One class + a platform lookup
// table, not per-OS adapter classes: the actual per-OS divergence here is a
// filename and a download URL, not the download/verify logic itself.
//
// Binary verification is fail-closed and uses only a committed, human-
// reviewed checksum manifest (cloudflared-checksums.json) — never a runtime
// checksum fetch, never trust-on-first-use. See that file's own "note" field
// for how it was produced and which platforms were deliberately excluded.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const MANIFEST = require("./cloudflared-checksums.json");

// asset: the exact GitHub release asset name for this platform/arch.
// localBin: the filename the verified binary is stored as on disk.
// Every entry here MUST have a matching key in cloudflared-checksums.json —
// enforced by ensureInstalled()'s lookup, not assumed.
const RELEASES = {
  "win32-x64": { asset: "cloudflared-windows-amd64.exe", localBin: "cloudflared.exe" },
  "linux-x64": { asset: "cloudflared-linux-amd64", localBin: "cloudflared" },
  "linux-arm64": { asset: "cloudflared-linux-arm64", localBin: "cloudflared" }
};

class UnsupportedPlatformError extends Error {
  constructor(platformKey) {
    super("cloudflared is not available for this platform (" + platformKey + ") in this SnapCon build — see remote-access/cloudflared-checksums.json for why.");
    this.name = "UnsupportedPlatformError";
  }
}
class ChecksumMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChecksumMismatchError";
  }
}

function platformKey() {
  return os.platform() + "-" + os.arch();
}
function binDir(baseDir) {
  return path.join(baseDir, "remote-access-data", "bin");
}
function metaPath(baseDir) {
  return path.join(binDir(baseDir), "meta.json");
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readMeta(baseDir) {
  try { return JSON.parse(fs.readFileSync(metaPath(baseDir), "utf8")); }
  catch { return null; }
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// Downloads the asset for `key`, verifies it against the committed manifest
// BEFORE it's ever written to its final, executable path, and fails closed
// (no file left behind, no meta.json written) on any mismatch. Returns the
// final binary path on success.
//
// `manifest` defaults to the real committed cloudflared-checksums.json —
// overridable only so tests can exercise match/mismatch/missing-platform
// behavior with crafted small payloads instead of a real multi-MB binary
// and a real network call.
async function download(baseDir, key, manifest = MANIFEST) {
  const entry = RELEASES[key];
  const checksumEntry = manifest.checksums[key];
  if (!entry || !checksumEntry) throw new UnsupportedPlatformError(key);

  const url = "https://github.com/cloudflare/cloudflared/releases/download/" + manifest.version + "/" + entry.asset;
  const res = await fetchWithTimeout(url, {}, 60000);
  if (!res.ok) throw new Error("Failed to download cloudflared (" + url + "): HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = sha256(buf);
  if (hash !== checksumEntry.sha256) {
    throw new ChecksumMismatchError(
      "Downloaded cloudflared asset (" + entry.asset + ") does not match the committed checksum for version " + manifest.version +
      " — refusing to install. Expected " + checksumEntry.sha256 + ", got " + hash + "."
    );
  }

  const dir = binDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, entry.localBin);
  const partPath = finalPath + ".part";
  fs.writeFileSync(partPath, buf, { mode: 0o755 });
  fs.renameSync(partPath, finalPath);
  if (process.platform !== "win32") { try { fs.chmodSync(finalPath, 0o755); } catch {} }

  const meta = {
    version: manifest.version,
    platform: os.platform(),
    architecture: os.arch(),
    downloadedAt: new Date().toISOString(),
    verified: true,
    sha256: hash,
    checksumSource: "vendor" // committed manifest, reviewed against Cloudflare's own published release-notes checksums
  };
  fs.writeFileSync(metaPath(baseDir), JSON.stringify(meta, null, 2));
  return finalPath;
}

// Idempotent: no-ops if a verified, matching-version binary already exists
// on disk AND its bytes still hash correctly (protects against on-disk
// tampering between runs, not just at download time). Otherwise
// (re)downloads. Throws UnsupportedPlatformError for any platform not in
// the committed manifest — never runs anything unverified.
async function ensureInstalled(baseDir, key = platformKey(), manifest = MANIFEST) {
  const entry = RELEASES[key];
  const checksumEntry = manifest.checksums[key];
  if (!entry || !checksumEntry) throw new UnsupportedPlatformError(key);

  const finalPath = path.join(binDir(baseDir), entry.localBin);
  const meta = readMeta(baseDir);

  if (meta && meta.version === manifest.version && meta.verified === true && fs.existsSync(finalPath)) {
    const buf = fs.readFileSync(finalPath);
    const hash = sha256(buf);
    if (hash === checksumEntry.sha256) return finalPath; // still valid, no-op
    // On-disk binary no longer matches the committed checksum since it was
    // last verified — fail closed, never run it, never silently redownload.
    try { fs.unlinkSync(finalPath); } catch {}
    try { fs.unlinkSync(metaPath(baseDir)); } catch {}
    throw new ChecksumMismatchError(
      "cloudflared binary on disk failed its integrity check (does not match the committed checksum) and was removed. Re-enable Remote Access to reinstall it."
    );
  }

  return download(baseDir, key, manifest);
}

function getVersion(baseDir) {
  const meta = readMeta(baseDir);
  return meta ? meta.version : null;
}

function getBinaryPath(baseDir) {
  const entry = RELEASES[platformKey()];
  return entry ? path.join(binDir(baseDir), entry.localBin) : null;
}

module.exports = {
  RELEASES, MANIFEST,
  UnsupportedPlatformError, ChecksumMismatchError,
  platformKey, binDir, ensureInstalled, download, getVersion, getBinaryPath,
  // exported for tests only
  _internal: { readMeta, metaPath, sha256 }
};

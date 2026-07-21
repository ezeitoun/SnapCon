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
const cp = require("child_process");
const InstanceLock = require("./InstanceLock");
const { redact } = require("./redact");

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

// The timeout here covers the FULL download — connecting AND reading the
// entire body — not just getting the Response object back. A naive
// `await fetch(url, {signal})` followed by a separate `await
// res.arrayBuffer()`, with the timer cleared as soon as fetch() resolves,
// would leave the actual multi-MB body read completely unbounded: a
// connection that stalls partway through would hang forever. That matters
// more here than it might look — ensureInstalled() is only ever called from
// within enable()/startupInit(), which are now serialized through one
// operation queue, so a single hung download would block every future
// Remote Access operation indefinitely, not just itself.
async function fetchBufferWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
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
  let buf;
  try {
    buf = await fetchBufferWithTimeout(url, 60000);
  } catch (e) {
    throw new Error("Failed to download cloudflared (" + url + "): " + e.message);
  }
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

// ---- Process lifecycle ----
// Pure function, kept separate from the actual scheduling below specifically
// so it (and the scheduling logic, via injected timer functions) can be unit
// tested without relying on real elapsed time / fake-timer libraries.
const BACKOFF_TABLE_MS = [2000, 5000, 10000, 30000, 60000];
function backoffDelay(restartCount) {
  const idx = Math.min(Math.max(restartCount, 0), BACKOFF_TABLE_MS.length - 1);
  return BACKOFF_TABLE_MS[idx];
}

// Best-effort signal only — ONE of three inputs to the "Connected" state
// RemoteAccessService computes (process-alive, this log evidence, and an
// outbound public-endpoint probe). Never treated as sufficient on its own.
// Verify this pattern against real `cloudflared tunnel run` output during
// manual testing — exact wording can change between cloudflared versions.
const CONNECTION_EVIDENCE_RE = /registered tunnel connection|connection.*(established|registered)|connected to/i;

// spawnFn/setTimeoutFn/clearTimeoutFn are injectable purely for testing —
// production callers use the real child_process.spawn/setTimeout/clearTimeout
// defaults. Each call to createProcessManager owns its own private state
// (no shared module-level mutable state), so tests can create independent
// instances without interfering with each other.
function createProcessManager(baseDir, { spawnFn = cp.spawn, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let child = null;
  let running = false;
  let intentionalStop = false;
  let restartCount = 0;
  let restartTimer = null;
  let sawConnectionEvidence = false;
  let lastExitInfo = null;
  let lastError = null;
  let currentToken = null;
  let statusListener = null;

  function scheduleRestart() {
    if (intentionalStop || restartTimer) return;
    const delay = backoffDelay(restartCount);
    restartTimer = setTimeoutFn(() => {
      restartTimer = null;
      restartCount++;
      spawnChild();
    }, delay);
  }

  function handleLine(line) {
    if (CONNECTION_EVIDENCE_RE.test(line)) sawConnectionEvidence = true;
    if (statusListener) statusListener({ line: redact(line, [currentToken]) });
  }

  function spawnChild() {
    const binPath = getBinaryPath(baseDir);
    if (!binPath || !fs.existsSync(binPath)) {
      lastError = "cloudflared binary is not installed — call ensureInstalled() first.";
      return;
    }
    sawConnectionEvidence = false;
    // Reset on every fresh spawn attempt (initial start and every backoff-
    // triggered restart alike) so a stale error from several restarts ago
    // never lingers in getStatus() once a newer attempt is underway.
    lastError = null;
    // Spawn-scoped env object only — process.env itself is never mutated.
    const env = { ...process.env, TUNNEL_TOKEN: currentToken };
    // --no-autoupdate is a TUNNEL COMMAND OPTION, not a `run` subcommand
    // option — cloudflared's own usage line is
    // "cloudflared tunnel [tunnel command options] run [subcommand options]",
    // so it must come BEFORE "run". Confirmed live: placing it after "run"
    // produces "Incorrect Usage: flag provided but not defined: -no-autoupdate"
    // from the real binary, since `run`'s own flag parser doesn't recognize
    // a flag that belongs to the parent `tunnel` command's flag set.
    child = spawnFn(binPath, ["tunnel", "--no-autoupdate", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    running = true;
    if (child.pid) InstanceLock.record(baseDir, child.pid);

    let stdoutBuf = "", stderrBuf = "";
    if (child.stdout) child.stdout.on("data", d => {
      stdoutBuf += d.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) { handleLine(stdoutBuf.slice(0, idx)); stdoutBuf = stdoutBuf.slice(idx + 1); }
    });
    if (child.stderr) child.stderr.on("data", d => {
      stderrBuf += d.toString("utf8");
      let idx;
      while ((idx = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, idx); stderrBuf = stderrBuf.slice(idx + 1);
        lastError = redact(line, [currentToken]);
        handleLine(line);
      }
    });
    child.on("exit", (code, signal) => {
      running = false;
      child = null;
      lastExitInfo = { code, signal, at: new Date().toISOString() };
      InstanceLock.clear(baseDir);
      if (intentionalStop) { restartCount = 0; }
      else { scheduleRestart(); }
    });
    child.on("error", e => { lastError = redact(e.message, [currentToken]); });
  }

  async function start(token) {
    currentToken = token;
    if (running) return getStatus(); // duplicate-start is a no-op, not an error
    if (restartTimer) { clearTimeoutFn(restartTimer); restartTimer = null; }
    await InstanceLock.resolveBeforeStart(baseDir); // own-orphan cleanup — see InstanceLock.js; never "attaches"
    intentionalStop = false;
    spawnChild();
    return getStatus();
  }

  function stop() {
    intentionalStop = true;
    if (restartTimer) { clearTimeoutFn(restartTimer); restartTimer = null; }
    restartCount = 0;
    if (!running || !child) { InstanceLock.clear(baseDir); return Promise.resolve(getStatus()); }
    const proc = child;
    return new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(getStatus()); } };
      proc.once("exit", finish);
      try { proc.kill("SIGTERM"); } catch { finish(); return; }
      setTimeoutFn(() => {
        if (settled) return;
        try { proc.kill("SIGKILL"); } catch {}
      }, 5000);
    });
  }

  async function restart() {
    const token = currentToken;
    await stop();
    return start(token);
  }

  function getStatus() {
    return { processRunning: running, restartCount, sawConnectionEvidence, lastExitInfo, lastError };
  }

  function onStatusChange(fn) { statusListener = fn; }

  // Without this, start() and stop() aren't mutually exclusive: start()
  // awaits InstanceLock.resolveBeforeStart() before `running` ever becomes
  // true, so a stop() call landing in that window sees "nothing running,"
  // returns immediately, and then the in-flight start() spawns a child
  // anyway — undoing the stop it just reported as complete. Today
  // RemoteAccessService happens to never call start()/stop() concurrently
  // (its own enable()/disable() are serialized), but this module shouldn't
  // depend on every caller getting that right independently — the same class
  // of bug had to be fixed one layer up for exactly this reason.
  let opChain = Promise.resolve();
  function serialize(fn) {
    return (...args) => {
      const run = () => fn(...args);
      const started = opChain.then(run, run);
      opChain = started.then(() => {}, () => {});
      return started;
    };
  }

  return { start: serialize(start), stop: serialize(stop), restart: serialize(restart), getStatus, onStatusChange };
}

module.exports = {
  RELEASES, MANIFEST,
  UnsupportedPlatformError, ChecksumMismatchError,
  platformKey, binDir, ensureInstalled, download, getVersion, getBinaryPath,
  backoffDelay, createProcessManager,
  // exported for tests only
  _internal: { readMeta, metaPath, sha256, fetchBufferWithTimeout }
};

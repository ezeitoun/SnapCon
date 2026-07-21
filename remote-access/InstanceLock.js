// remote-access/InstanceLock.js — single-instance protection for the
// cloudflared child process. Records the PID SnapCon itself last spawned so
// a crash-and-relaunch (or two SnapCon instances) can't end up running two
// tunnels against the same token concurrently.
//
// IMPORTANT: this module never "attaches" to or monitors a process it did
// not spawn in the current run. Node cannot retroactively capture stdout
// from a process it didn't launch with piped stdio — claiming to "monitor"
// an orphan would be dishonest. The only actions available for a live
// orphan are: recognize it as our own past mistake and kill it, or leave it
// alone because it no longer looks like ours. Either way, CloudflaredManager
// then spawns a brand new, fully piped, fully supervised child — that is the
// only process this module or CloudflaredManager ever reads output from.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

function lockPath(baseDir) {
  return path.join(baseDir, "remote-access-data", "cloudflared.lock");
}

function readLock(baseDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(baseDir), "utf8"));
    return (raw && typeof raw.pid === "number") ? raw : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    // Signal 0 sends nothing but still validates the PID exists and this
    // process has permission to signal it — standard liveness check.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort: does the given live PID still look like a cloudflared
// process? Used only to decide "is this our own orphan" — never to justify
// touching a PID that doesn't match.
//
// Time-bounded (unlike an earlier version of this function): resolveBeforeStart()
// awaits this from inside start(), and start()/stop() are serialized at the
// CloudflaredManager level — an unbounded tasklist/proc read here would mean
// a subsequent stop() call (including the one the graceful-shutdown path in
// server.js depends on) could queue behind it indefinitely, breaking the
// "shutdown is always bounded" guarantee that whole path exists for. A
// timeout here resolves false (the safe default — "doesn't clearly look like
// ours," per this function's own contract of never justifying touching a
// PID that doesn't match) rather than leaving the caller hanging.
function looksLikeCloudflared(pid, timeoutMs = 3000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => finish(false), timeoutMs);

    if (os.platform() === "win32") {
      const child = spawn("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"]);
      let out = "";
      child.stdout.on("data", d => { out += d; });
      child.on("error", () => { clearTimeout(timer); finish(false); });
      child.on("close", () => { clearTimeout(timer); finish(/cloudflared/i.test(out)); });
    } else {
      fs.readFile("/proc/" + pid + "/cmdline", (err, data) => {
        clearTimeout(timer);
        if (err) { finish(false); return; }
        finish(/cloudflared/i.test(data.toString("utf8")));
      });
    }
  });
}

// Returns { action: "spawn-fresh" } after resolving any stale/orphaned
// state — callers should always end up spawning a brand new child
// themselves; this function's only job is making that safe.
async function resolveBeforeStart(baseDir) {
  const lock = readLock(baseDir);
  if (!lock) return { action: "spawn-fresh" };

  if (!isPidAlive(lock.pid)) {
    clear(baseDir);
    return { action: "spawn-fresh" };
  }

  const isOurs = await looksLikeCloudflared(lock.pid);
  if (isOurs) {
    // Our own orphan from a prior run that exited without cleanup — this is
    // a cleanup of our own past mistake, not an attach/adopt of a stranger.
    try { process.kill(lock.pid, "SIGTERM"); } catch {}
    await new Promise(r => setTimeout(r, 1500));
    if (isPidAlive(lock.pid)) { try { process.kill(lock.pid, "SIGKILL"); } catch {} }
  }
  // Whether or not it matched, the recorded PID no longer represents a
  // process we can safely claim ownership of going forward.
  clear(baseDir);
  return { action: "spawn-fresh" };
}

// Best-effort: the lock file is a safety net for detecting an orphan on a
// FUTURE run, not something the CURRENT run's tunnel depends on to function.
// A write failure here (permissions, disk full) shouldn't be allowed to
// propagate up through spawnChild() — called synchronously right after a
// real spawn succeeds — and fail the whole start() call over what is, this
// session, a non-essential bookkeeping write.
function record(baseDir, pid) {
  try {
    const dir = path.dirname(lockPath(baseDir));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath(baseDir), JSON.stringify({ pid, recordedAt: Date.now() }));
  } catch (e) {
    console.error("[remote-access] failed to record instance lock (non-fatal):", e.message);
  }
}

function clear(baseDir) {
  try { fs.unlinkSync(lockPath(baseDir)); } catch {}
}

module.exports = { resolveBeforeStart, record, clear, readLock, isPidAlive, looksLikeCloudflared };

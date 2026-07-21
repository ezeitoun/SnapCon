// remote-access/SecureCredentialStore.js — get/set/delete for the one secret
// this feature ever handles: the Cloudflare tunnel token.
//
// OS-native storage only, by default:
//   - Windows: DPAPI via a PowerShell child process (CurrentUser scope,
//     stdin/stdout only, never argv, never a temp file).
//   - macOS:   Keychain via the `security` CLI.
//   - Linux:   Secret Service via `secret-tool` (libsecret), stdin/stdout.
// No new npm dependency (no keytar) — see remote-access plan for why: pkg
// cross-compiles 4 targets from one machine, and native addons are a common
// breakage source for that build model.
//
// If no native mechanism is available, get/set/delete THROW
// NoSecureStorageAvailableError — there is no silent downgrade. A caller may
// explicitly opt into InsecureFileFallbackStore (constructor flag, default
// off) as a clearly-named, clearly-worse last resort; it is never selected
// automatically.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

class NoSecureStorageAvailableError extends Error {
  constructor(reason) {
    super("No OS-native secure credential storage available" + (reason ? ": " + reason : ""));
    this.name = "NoSecureStorageAvailableError";
  }
}

// ---- shared child-process helper: spawn, optionally write `input` to
// stdin, collect stdout/stderr, never throw on a non-zero exit code (the
// caller decides what that means) — only throws on a spawn-level failure
// (e.g. ENOENT, the binary itself doesn't exist). ----
function run(cmd, args, { input, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "", stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(cmd + " timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

function isBinaryMissing(err) {
  return !!err && (err.code === "ENOENT" || /not recognized|command not found/i.test(err.message || ""));
}

// ---- macOS: Keychain via `security` ----
// KNOWN, DOCUMENTED LIMITATION: `security add-generic-password -w <value>`
// takes the secret as a CLI argument — the standard `security` tool has no
// stdin-based write path. The token is therefore visible in that one
// process's argv (e.g. to another local process polling `ps`) for the brief
// window that single command runs. It is never logged, never written to any
// file unencrypted, and read-back is captured from stdout only. Accepted for
// Milestone A (a single-owner development machine) rather than excluding
// macOS outright; revisit before this ever leaves Development Preview.
function macKeychainStore() {
  const account = "snapcon";
  return {
    label: "macOS Keychain",
    async probe() {
      try {
        const r = await run("security", ["find-generic-password", "-a", account, "-s", "__snapcon_probe__", "-w"]);
        return true; // any exit code from a real `security` run means the tool is present
      } catch (e) {
        if (isBinaryMissing(e)) return false;
        return true;
      }
    },
    async get(key) {
      const r = await run("security", ["find-generic-password", "-a", account, "-s", key, "-w"]);
      if (r.code !== 0) return null;
      return r.stdout.replace(/\r?\n$/, "");
    },
    async set(key, value) {
      const r = await run("security", ["add-generic-password", "-a", account, "-s", key, "-w", value, "-U"]);
      if (r.code !== 0) throw new Error("security add-generic-password failed: " + r.stderr.trim());
    },
    async delete(key) {
      await run("security", ["delete-generic-password", "-a", account, "-s", key]).catch(() => {});
    }
  };
}

// ---- Linux: Secret Service via `secret-tool` (libsecret) ----
// Not guaranteed installed (needs libsecret + a running keyring daemon,
// commonly absent on headless/minimal servers) — probed before use.
function linuxSecretToolStore() {
  const service = "snapcon";
  return {
    label: "Linux Secret Service (secret-tool)",
    async probe() {
      try {
        await run("secret-tool", ["lookup", "service", service, "account", "__snapcon_probe__"]);
        return true;
      } catch (e) {
        if (isBinaryMissing(e)) return false;
        return true;
      }
    },
    async get(key) {
      const r = await run("secret-tool", ["lookup", "service", service, "account", key]);
      if (r.code !== 0 || !r.stdout) return null;
      return r.stdout.replace(/\r?\n$/, "");
    },
    async set(key, value) {
      const r = await run("secret-tool", ["store", "--label=SnapCon Remote Access Token", "service", service, "account", key], { input: value });
      if (r.code !== 0) throw new Error("secret-tool store failed: " + r.stderr.trim());
    },
    async delete(key) {
      await run("secret-tool", ["clear", "service", service, "account", key]).catch(() => {});
    }
  };
}

// ---- Windows: DPAPI via PowerShell, CurrentUser scope ----
// ConvertTo-SecureString / ConvertFrom-SecureString with no explicit -Key
// uses DPAPI bound to the current Windows user account on the current
// machine (the default scope) — decryptable only by that same account.
// Token flows over stdin/stdout only: never argv, never a temp script file,
// never an intermediate plaintext file. The PowerShell command text itself
// contains no secret (it's a static string), so no .ps1 asset is needed
// on disk (which would also need a pkg.assets entry).
const PS_ENCRYPT = "$t = [Console]::In.ReadLine(); $s = ConvertTo-SecureString -String $t -AsPlainText -Force; Write-Output (ConvertFrom-SecureString -SecureString $s)";
const PS_DECRYPT = "$c = [Console]::In.ReadLine(); $s = ConvertTo-SecureString -String $c; $b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); Write-Output ([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))";

function windowsDpapiStore(baseDir) {
  const secureDir = path.join(baseDir, "remote-access-data", "secure");
  const blobPath = key => path.join(secureDir, key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".dpapi");
  return {
    label: "Windows DPAPI (CurrentUser)",
    async probe() {
      try {
        const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { input: "1\n" + "$PSVersionTable.PSVersion.Major\n" });
        return true;
      } catch (e) {
        if (isBinaryMissing(e)) return false;
        return true;
      }
    },
    async get(key) {
      let ciphertext;
      try { ciphertext = fs.readFileSync(blobPath(key), "utf8").trim(); }
      catch { return null; }
      if (!ciphertext) return null;
      try {
        const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_DECRYPT], { input: ciphertext + "\n" });
        if (r.code !== 0) return null; // corrupted blob / DPAPI key changed (e.g. profile reset) — treat as missing, never throw
        const out = r.stdout.replace(/\r?\n$/, "");
        return out || null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      // PS_ENCRYPT reads the value via [Console]::In.ReadLine() — a single
      // line. A value containing an embedded newline would be silently
      // truncated at the first one before it's ever encrypted, and nothing
      // downstream (the read path, cloudflared itself) would have any way
      // to tell the stored token isn't the real one — it would just fail
      // with a confusing, unrelated-looking auth error. Loud failure here,
      // while the correct value is still in hand, beats silent corruption.
      if (/[\r\n]/.test(value)) throw new Error("Cannot store a secret containing a newline via the line-based DPAPI protocol.");
      const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_ENCRYPT], { input: value + "\n" });
      if (r.code !== 0 || !r.stdout.trim()) throw new Error("DPAPI encrypt failed: " + r.stderr.trim());
      fs.mkdirSync(secureDir, { recursive: true });
      fs.writeFileSync(blobPath(key), r.stdout.trim() + "\n", { mode: 0o600 });
    },
    async delete(key) {
      try { fs.unlinkSync(blobPath(key)); } catch {}
    }
  };
}

// ---- Fallback: explicitly insecure, explicitly opt-in, default off ----
// A file-encrypted store whose key lives beside its own ciphertext protects
// against nothing an attacker with filesystem read access doesn't already
// have. This class exists only so a headless/dev box with no OS keyring can
// still be used at all, and only when the caller sets allowInsecureFallback
// explicitly — it is never chosen automatically.
class InsecureFileFallbackStore {
  constructor(baseDir) {
    this.dir = path.join(baseDir, "remote-access-data", "secure");
    this.label = "INSECURE local file fallback (no OS keyring available)";
  }
  _keyFile() { return path.join(this.dir, "keyfile.bin"); }
  _tokenFile(key) { return path.join(this.dir, key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".enc"); }
  _loadOrCreateKey() {
    fs.mkdirSync(this.dir, { recursive: true });
    try { return fs.readFileSync(this._keyFile()); }
    catch {
      const k = crypto.randomBytes(32);
      fs.writeFileSync(this._keyFile(), k, { mode: 0o600 });
      return k;
    }
  }
  async get(key) {
    let raw;
    try { raw = fs.readFileSync(this._tokenFile(key)); }
    catch { return null; }
    try {
      const k = this._loadOrCreateKey();
      const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      return null; // tampered/corrupted ciphertext — treat as missing, never throw
    }
  }
  async set(key, value) {
    const k = this._loadOrCreateKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(this._tokenFile(key), Buffer.concat([iv, tag, ct]), { mode: 0o600 });
  }
  async delete(key) {
    try { fs.unlinkSync(this._tokenFile(key)); } catch {}
  }
}

let warnedFallbackOnce = false;

// Cascade logic, factored out from platform selection specifically so tests
// can exercise "native probe fails -> refuse" and "-> opt-in fallback" with
// an injected fake candidate, without depending on the real OS mechanism
// available on whatever machine runs the test suite.
async function resolveStore(baseDir, candidate, { allowInsecureFallback = false, platformLabel = os.platform() } = {}) {
  if (candidate) {
    try {
      if (await candidate.probe()) return { ...candidate, usingInsecureFallback: false };
    } catch {
      // probe itself threw (unexpected) — fall through to the same
      // refuse-or-opt-in-fallback logic as "not available"
    }
  }

  if (!allowInsecureFallback) {
    throw new NoSecureStorageAvailableError(
      candidate ? "native mechanism (" + candidate.label + ") is not available on this system" : "no native mechanism for platform " + platformLabel
    );
  }

  if (!warnedFallbackOnce) {
    warnedFallbackOnce = true;
    console.warn("[remote-access] OS-native secure storage unavailable; falling back to an INSECURE local encrypted file (allowInsecureFallback=true). This is not real secure storage — see SecureCredentialStore.js.");
  }
  const fallback = new InsecureFileFallbackStore(baseDir);
  return {
    label: fallback.label,
    get: fallback.get.bind(fallback),
    set: fallback.set.bind(fallback),
    delete: fallback.delete.bind(fallback),
    usingInsecureFallback: true
  };
}

// baseDir: server.js's BASE_DIR (next-to-exe in pkg, project root in dev).
// allowInsecureFallback: explicit opt-in, default false — see plan.
async function getSecureCredentialStore(baseDir, { allowInsecureFallback = false } = {}) {
  const platform = os.platform();
  const candidate =
    platform === "win32" ? windowsDpapiStore(baseDir) :
    platform === "darwin" ? macKeychainStore() :
    platform === "linux" ? linuxSecretToolStore() :
    null;
  return resolveStore(baseDir, candidate, { allowInsecureFallback, platformLabel: platform });
}

module.exports = {
  getSecureCredentialStore,
  NoSecureStorageAvailableError,
  InsecureFileFallbackStore,
  // exported for tests only — not part of the public interface
  _internal: { macKeychainStore, linuxSecretToolStore, windowsDpapiStore, run, isBinaryMissing, resolveStore }
};

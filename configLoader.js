// configLoader.js — read+parse+quarantine logic for config.json, extracted
// from server.js specifically so this one narrow, safety-critical piece is
// unit-testable without requiring server.js itself, which starts a real
// listening server and touches this repo's own config.json as a side effect
// of being required (see test/groupAccess.test.js for the same rationale
// applied to a different piece of server.js).
//
// A missing file (ENOENT) is a legitimate first run — silent, unchanged
// behavior. Anything else (unparseable JSON, a top-level JSON value that
// isn't a config object, an unreadable file) is a genuine failure: logged
// loudly, and — whenever the original bytes were actually read (unparseable
// JSON, wrong top-level type) — the original file is renamed aside with a
// timestamp (mirroring queue/QueueStore.js's own corrupt-file quarantine
// convention) rather than ever being silently destroyed.
const fs = require("fs");
const path = require("path");
const { writeFileDurably, flushDir } = require("./queue/QueueStore").durable;

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// Shared by both "unparseable JSON" and "valid JSON, wrong top-level type" —
// same recovery guarantee either way: log loudly, preserve the original
// bytes under a timestamped name, report the failure to the caller so it
// never gets treated as a successful load.
function quarantine(configPath, defaultCfg, reason) {
  console.error(`[config] ${reason} — starting with defaults until this is fixed`);
  const quarantinePath = `${configPath}.corrupt-${Date.now()}`;
  let quarantined = false;
  try {
    fs.renameSync(configPath, quarantinePath);
    quarantined = true;
    console.error(`[config] preserved the unreadable file as ${quarantinePath}`);
  } catch (renameErr) {
    console.error(`[config] could not move the corrupt file aside: ${renameErr.message}`);
  }
  return { cfg: { ...defaultCfg }, loadFailed: true, quarantinePath: quarantined ? quarantinePath : null };
}

function loadConfigFile(configPath, defaultCfg) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { cfg: { ...defaultCfg }, loadFailed: false, quarantinePath: null };
    console.error(`[config] could not read ${configPath} — starting with defaults until this is fixed: ${e.message}`);
    return { cfg: { ...defaultCfg }, loadFailed: true, quarantinePath: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return quarantine(configPath, defaultCfg, `${configPath} contains invalid JSON: ${e.message}`);
  }

  // JSON.parse happily accepts "null", "42", "\"x\"", "true", "[]" as valid
  // JSON, but a SnapCon config.json is always a top-level object — none of
  // those are a usable configuration, and reporting one as a successful load
  // would hand the caller a value whose own fields (e.g. CFG.gcodeFolder)
  // can't be read without crashing. This is intentionally just a top-level
  // shape check, not property-by-property schema validation.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return quarantine(configPath, defaultCfg, `${configPath} does not contain a configuration object (found ${describeType(parsed)})`);
  }

  return { cfg: parsed, loadFailed: false, quarantinePath: null };
}

// ---- Replacing config.json as a whole ----
// Used by the routes that change config.json together with the queue store
// (pool changes, Queue Management on/off): there a half-written config.json
// is worse than a failed save. The new text is written and flushed to
// config.json.tmp, renamed over config.json, and the folder is flushed.
//
// Throws on any failure, and the error's `configFile` says what is on disk:
//   "unchanged"             config.json is byte for byte what it was;
//   "replaced-not-flushed"  config.json holds the NEW text, but it could not
//                           be confirmed as safely stored.
// `code` is the filesystem's error code.
//
// config.json itself is never opened for writing here: the only file written
// is the temporary one. So a config.json that is itself a mount point —
// Docker's single-file bind mount, which docker-compose.yml uses — cannot be
// saved by this function at all: the rename is refused (EBUSY, or EXDEV) and
// that is reported as a failed save, file "unchanged". Writing it where it is
// would cut it short first, and a process that stops before every byte is
// back cannot repair anything. A read-only config.json is left alone too (a
// rename could replace it; that is not what read-only is for).
// The supported Docker layout mounts the FOLDER that holds config.json
// instead (SNAPCON_CONFIG_DIR, see resolveConfigLocation below).
//
// The new file keeps config.json's permissions, and its owner and group
// where the process is allowed to set them (root in a container replacing a
// file that belongs to the host's user). Where it is not allowed, the new
// file belongs to the user SnapCon runs as, as before.
function replaceConfigFile(configPath, text, { fsImpl = fs, platform = process.platform } = {}) {
  const fail = (e, configFile) => Object.assign(new Error("config.json could not be saved (" + ((e && e.code) || "error") + ")"), { code: (e && e.code) || "ERROR", configFile, cause: e });
  let target = configPath, mode, owner;
  try { target = fsImpl.realpathSync(configPath); } catch { /* not there yet: created below */ }
  try { const st = fsImpl.statSync(target); mode = st.mode & 0o777; owner = { uid: st.uid, gid: st.gid }; fsImpl.accessSync(target, fs.constants.W_OK); }
  catch (e) { if (e.code !== "ENOENT") throw fail(e, "unchanged"); }
  const tmp = target + ".tmp";
  const dropTmp = () => { try { fsImpl.unlinkSync(tmp); } catch { /* none */ } };
  try {
    // Created with config.json's own permissions from the start (it can hold
    // tokens): never readable more widely while it is being written.
    dropTmp();
    if (mode !== undefined) {
      fsImpl.closeSync(fsImpl.openSync(tmp, "wx", mode)); fsImpl.chmodSync(tmp, mode);
      if (typeof process.getuid === "function" && (owner.uid !== process.getuid() || owner.gid !== process.getgid())) {
        try { fsImpl.chownSync(tmp, owner.uid, owner.gid); } catch { /* not allowed: the new file is ours */ }
      }
    }
    writeFileDurably(fsImpl, tmp, text);
  } catch (e) { dropTmp(); throw fail(e, "unchanged"); }
  try { fsImpl.renameSync(tmp, target); }
  catch (e) { dropTmp(); throw fail(e, "unchanged"); }
  try { flushDir(fsImpl, path.dirname(target), platform); }
  catch (e) { throw fail(e, "replaced-not-flushed"); }
}

// ---- Where config.json lives ----
// By default config.json sits beside the application (baseDir), as it always
// has. SNAPCON_CONFIG_DIR names a FOLDER to keep it in instead. It exists for
// containers: a folder can be mounted so that config.json inside it can be
// replaced as a whole (replaceConfigFile above), which a config.json mounted
// as a single file cannot. A relative value is taken from baseDir. Only
// config.json moves; every other file stays where it was.
function resolveConfigLocation({ baseDir, env = process.env }) {
  const legacyPath = path.join(baseDir, "config.json");
  const raw = typeof env.SNAPCON_CONFIG_DIR === "string" ? env.SNAPCON_CONFIG_DIR.trim() : "";
  if (!raw) return { configPath: legacyPath, configDir: null, legacyPath };
  const configDir = path.resolve(baseDir, raw);
  return { configPath: path.join(configDir, "config.json"), configDir, legacyPath };
}

// Is there anything here that only an installation already in use would have?
// Returns what was found (a short name), or null. Read errors count as
// "found": when it cannot be told, the answer must not be "nothing here".
function existingInstallEvidence(baseDir, fsImpl = fs) {
  // users.json: an empty file (the quick start's `touch`), or one holding no
  // accounts, is not evidence. Anything that cannot be read as that — bad
  // JSON, another shape, a folder with something in it — is.
  const usersPath = path.join(baseDir, "users.json");
  try {
    const raw = fsImpl.readFileSync(usersPath, "utf8");
    if (raw.trim()) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return "users.json (unreadable)"; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "users.json (unreadable)";
      if (parsed.users !== undefined && !Array.isArray(parsed.users)) return "users.json (unreadable)";
      if (Array.isArray(parsed.users) && parsed.users.length) return "users.json (user accounts)";
    }
  } catch (e) {
    if (e.code === "EISDIR") {
      // Docker makes a folder when the file to mount did not exist. Empty: nothing was ever stored in it.
      try { if (fsImpl.readdirSync(usersPath).length) return "users.json (unreadable)"; } catch { return "users.json (unreadable)"; }
    } else if (e.code !== "ENOENT") return "users.json (unreadable)";
  }
  try { fsImpl.statSync(path.join(baseDir, "data", "queue-data.json")); return "data/queue-data.json (queue)"; }
  catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") return "data/queue-data.json (unreadable)"; }
  try { if (fsImpl.readdirSync(path.join(baseDir, "remote-access-data")).length) return "remote-access-data (Remote Access identity)"; }
  catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") return "remote-access-data (unreadable)"; }
  return null;
}

// Reads config.json for a start with a settings folder, where nothing may be
// guessed: { state: "missing" } only when there is no entry of that name at
// all; { state: "ok", cfg }; otherwise { state: "unusable", why } — a folder
// or other non-file, a link to nothing, a file that cannot be read, JSON that
// does not parse, JSON that is not an object (an empty file included).
// Nothing is moved, renamed or written: the file stays as found.
function readConfigStrict(configPath, fsImpl = fs) {
  let lst;
  try { lst = fsImpl.lstatSync(configPath); }
  catch (e) { return e.code === "ENOENT" ? { state: "missing" } : { state: "unusable", why: "it cannot be examined (" + (e.code || "error") + ")" }; }
  let st = lst;
  if (lst.isSymbolicLink()) {
    try { st = fsImpl.statSync(configPath); }
    catch (e) { return { state: "unusable", why: e.code === "ENOENT" ? "it is a link to a file that does not exist" : "it is a link that cannot be followed (" + (e.code || "error") + ")" }; }
  }
  if (!st.isFile()) return { state: "unusable", why: st.isDirectory() ? "it is a folder, not a file" : "it is not a regular file" };
  let raw;
  try { raw = fsImpl.readFileSync(configPath, "utf8"); }
  catch (e) { return { state: "unusable", why: "it cannot be read (" + (e.code || "error") + ")" }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { state: "unusable", why: raw.trim() ? "it is not valid JSON" : "it is empty" }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unusable", why: "it does not hold a settings object (found " + describeType(parsed) + ")" };
  return { state: "ok", cfg: parsed };
}

// Start-up with SNAPCON_CONFIG_DIR: the check AND the load, in one step.
// Outside a settings folder, a config.json that is missing means a first
// run and one that cannot be used means "start with defaults and warn"
// (loadConfigFile above). Defaults have user accounts switched off. In a
// settings folder that was just introduced, either is more likely a
// migration that went wrong, and defaults would open an installation that
// had sign-in switched on. So with a settings folder:
//   - the folder must exist (it is never created here: a folder made inside
//     a container that was not mounted is lost with the container);
//   - a config.json in it that is a usable settings object: start with it.
//     The settings read here are the ones returned (`load`), so the caller
//     starts with exactly what was checked and never reads the file again;
//   - a config.json in it that is anything else: refuse to start. It is left
//     exactly as found — not set aside, not rewritten — for recovery;
//   - none, and a config.json at the old place, or anything else that only
//     a used installation has: refuse to start, and say what to do;
//   - none, and nothing else: a first run, with defaults, as before.
// A deliberate fresh start on a used installation is an explicit act: put a
// config.json holding {} in the folder.
// Returns { ok: true, firstRun, load } — load is loadConfigFile's shape —
// or { ok: false, code, message }.
function checkConfigDir({ configDir, configPath, legacyPath, baseDir, defaultCfg = {}, fsImpl = fs }) {
  const refuse = (code, lines) => ({ ok: false, code, message: lines.join("\n") });
  let st;
  try { st = fsImpl.statSync(configDir); }
  catch (e) {
    return refuse("config_dir_missing", [
      "SNAPCON_CONFIG_DIR is set to " + configDir + ", but that folder cannot be used (" + (e.code || "error") + ").",
      "Create it, and in a container mount it from the host; then start SnapCon again.",
    ]);
  }
  if (!st.isDirectory()) return refuse("config_dir_not_a_folder", ["SNAPCON_CONFIG_DIR is set to " + configDir + ", which is not a folder."]);
  try { fsImpl.accessSync(configDir, fs.constants.W_OK); }
  catch (e) { return refuse("config_dir_not_writable", ["The settings folder " + configDir + " is not writable (" + (e.code || "error") + "). SnapCon saves config.json by replacing it, which needs to write in the folder."]); }
  const read = readConfigStrict(configPath, fsImpl);
  if (read.state === "ok") return { ok: true, firstRun: false, load: { cfg: read.cfg, loadFailed: false, quarantinePath: null } };
  if (read.state === "unusable") return refuse("config_unusable", [
    "The settings file " + configPath + " cannot be used: " + read.why + ".",
    "SnapCon is not starting, because it would start with default settings (with user accounts switched off). The file has been left exactly as it is.",
    "To recover: stop SnapCon, replace it with a good copy of your config.json (the one from before the move, or a backup), and start it again.",
    "To start from scratch on purpose: keep a copy of this file, then put a config.json containing {} in its place.",
    "See docs/docker-config-migration.md.",
  ]);
  const how = [
    "To keep the existing settings: stop SnapCon, copy the existing config.json to " + configPath + ", and start it again.",
    "To start from scratch on purpose: put a config.json containing {} there instead.",
    "See docs/docker-config-migration.md.",
  ];
  let legacy = false;
  try { fsImpl.lstatSync(legacyPath); legacy = true; } catch (e) { if (e.code !== "ENOENT") legacy = true; }
  if (legacy) return refuse("config_not_migrated", [
    "There is no config.json in the settings folder " + configDir + ", but there is one at the old place (" + legacyPath + ").",
    "SnapCon is not starting, because it would start with default settings and ignore the existing ones (with user accounts switched off).",
    ...how,
  ]);
  const evidence = existingInstallEvidence(baseDir, fsImpl);
  if (evidence) return refuse("config_missing_on_existing_install", [
    "There is no config.json in the settings folder " + configDir + ", but this installation has been used before: found " + evidence + ".",
    "SnapCon is not starting, because it would start with default settings (with user accounts switched off).",
    ...how,
  ]);
  return { ok: true, firstRun: true, load: { cfg: { ...defaultCfg }, loadFailed: false, quarantinePath: null } };
}

// Is this path itself a mount point (Linux: listed in /proc/self/mountinfo)?
// True / false, or null where it cannot be told (not Linux, file unreadable).
// Used only to WARN at start-up that a single-file mounted config.json
// cannot be replaced; nothing is decided from it.
function isMountPoint(p, { fsImpl = fs, mountinfoPath = "/proc/self/mountinfo" } = {}) {
  let text, target = p;
  try { text = fsImpl.readFileSync(mountinfoPath, "utf8"); } catch { return null; }
  try { target = fsImpl.realpathSync(p); } catch { /* compare as given */ }
  const unescape = s => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f.length > 4 && unescape(f[4]) === target) return true;
  }
  return false;
}

module.exports = { loadConfigFile, replaceConfigFile, resolveConfigLocation, checkConfigDir, readConfigStrict, existingInstallEvidence, isMountPoint };

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

module.exports = { loadConfigFile };

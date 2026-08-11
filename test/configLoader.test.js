// test/configLoader.test.js — unit tests for the config.json read/parse/
// quarantine logic (configLoader.js), extracted from server.js specifically
// so this is testable without requiring server.js itself (which starts a
// real listening server and touches this repo's own config.json as a side
// effect of being required).
//
// Regression coverage for CODE_AUDIT.md's P0-1: a corrupt config.json used
// to be silently discarded and then permanently overwritten with near-empty
// defaults, with zero logging. These tests would have failed against the
// old inline try/catch in server.js's loadConfig(), which returned nothing,
// logged nothing, and could not be unit-tested at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfigFile } = require("../configLoader");

const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [] };

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-configloader-test-"));
}

function withCapturedErrors(fn) {
  const original = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.join(" "));
  try { return { result: fn(), messages }; }
  finally { console.error = original; }
}

test("loadConfigFile: missing file (legitimate first run) is silent — no log, no write, defaults returned", () => {
  const dir = scratchDir();
  const configPath = path.join(dir, "config.json");
  const { result, messages } = withCapturedErrors(() => loadConfigFile(configPath, DEFAULT_CFG));
  assert.deepEqual(result, { cfg: { ...DEFAULT_CFG }, loadFailed: false, quarantinePath: null });
  assert.equal(messages.length, 0, "a fresh install must never log a false 'corrupted' warning");
  assert.equal(fs.existsSync(configPath), false, "loadConfigFile itself must never create a file");
});

test("loadConfigFile: a valid config.json parses normally, untouched, loadFailed:false", () => {
  const dir = scratchDir();
  const configPath = path.join(dir, "config.json");
  const original = JSON.stringify({ printers: [{ id: "p_1", name: "U1" }], port: 4545 });
  fs.writeFileSync(configPath, original);
  const { result, messages } = withCapturedErrors(() => loadConfigFile(configPath, DEFAULT_CFG));
  assert.equal(result.loadFailed, false);
  assert.equal(result.quarantinePath, null);
  assert.deepEqual(result.cfg, JSON.parse(original));
  assert.equal(messages.length, 0);
  assert.equal(fs.readFileSync(configPath, "utf8"), original, "a valid file must never be rewritten by the loader itself");
});

test("loadConfigFile: corrupt JSON logs loudly, quarantines the original with its exact bytes preserved, and reports loadFailed:true", () => {
  const dir = scratchDir();
  const configPath = path.join(dir, "config.json");
  const corruptBytes = '{ "printers": [ { "name": "U1", } ] '; // trailing comma + unclosed brace
  fs.writeFileSync(configPath, corruptBytes);

  const { result, messages } = withCapturedErrors(() => loadConfigFile(configPath, DEFAULT_CFG));

  assert.equal(result.loadFailed, true);
  assert.deepEqual(result.cfg, { ...DEFAULT_CFG });
  assert.ok(messages.some(m => m.includes("invalid JSON")), "must log loudly on real corruption");

  assert.equal(fs.existsSync(configPath), false, "the corrupt file must not be left at the primary path where a later write could overwrite it");
  assert.ok(result.quarantinePath, "a quarantine path must be reported");
  assert.ok(/\.corrupt-\d+$/.test(result.quarantinePath), "quarantine path should follow the <path>.corrupt-<timestamp> convention");
  assert.equal(fs.readFileSync(result.quarantinePath, "utf8"), corruptBytes, "the ORIGINAL corrupt bytes must be preserved verbatim — this is the actual data-loss regression test");
});

test("loadConfigFile: valid JSON whose top-level value isn't a config object (null, array, string, number, boolean) is quarantined and reported as a load failure, not a successful load", () => {
  const cases = [
    ["null", "null"],
    ["an array", "[1,2,3]"],
    ["a string", '"just a string"'],
    ["a number", "42"],
    ["a boolean", "true"],
  ];
  for (const [label, json] of cases) {
    const dir = scratchDir();
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, json);

    const { result, messages } = withCapturedErrors(() => loadConfigFile(configPath, DEFAULT_CFG));

    assert.equal(result.loadFailed, true, `${label}: must not be reported as a successful load`);
    assert.deepEqual(result.cfg, { ...DEFAULT_CFG }, `${label}: must fall back to defaults`);
    assert.equal(fs.existsSync(configPath), false, `${label}: the original must not be left at the primary path`);
    assert.ok(result.quarantinePath, `${label}: a quarantine path must be reported`);
    assert.equal(fs.readFileSync(result.quarantinePath, "utf8"), json, `${label}: the original bytes must be preserved verbatim`);
    assert.ok(messages.some(m => m.includes("does not contain a configuration object")), `${label}: must log a message distinct from the invalid-JSON case`);
  }
});

test("loadConfigFile: an unreadable path (e.g. a directory, not a file) logs a distinct message, attempts no rename, and still reports loadFailed:true", () => {
  const dir = scratchDir();
  const configPath = path.join(dir, "config.json");
  fs.mkdirSync(configPath); // makes readFileSync throw EISDIR, not ENOENT

  const { result, messages } = withCapturedErrors(() => loadConfigFile(configPath, DEFAULT_CFG));

  assert.equal(result.loadFailed, true);
  assert.equal(result.quarantinePath, null, "nothing was actually read, so nothing should be quarantined");
  assert.deepEqual(result.cfg, { ...DEFAULT_CFG });
  assert.ok(messages.some(m => m.includes("could not read")), "must use a distinct message from the invalid-JSON case");
  assert.ok(fs.existsSync(configPath), "the directory itself must be left alone");
});

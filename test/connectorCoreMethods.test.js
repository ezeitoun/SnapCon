// test/connectorCoreMethods.test.js — every registered connector must
// implement the whole control contract, and every control must fail with a
// sentence rather than a TypeError.
//
// The bug this exists for: the Bambu Lab connector shipped its first build with
// only probe() implemented. Pressing Heat bed on a Bambu printer produced
// "getConnector(...).bedTemp is not a function" — a stack trace shown to the
// operator, from a control SnapCon had offered them. connector-compat-test.js
// already listed the required methods, but its own tests only exercise
// synthetic connector objects, so nothing checked the connectors that actually
// ship.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CONNECTOR_TYPES, getConnector } = require("../connectors");
const { CORE_METHODS } = require("../connector-compat-test");

// Optional connector methods: a connector may or may not have these, so every
// call site must check first. The bug: /api/printer-files called listFiles()
// unguarded, so pressing Print on a printer whose connector has none produced
// "getConnector(...).listFiles is not a function" where the file picker should
// have opened. Every other optional method in server.js was already guarded —
// this is the check that keeps the next one from slipping through.
const OPTIONAL_METHODS = [
  "listFiles", "getFileMetadata", "getThumbnail", "getPlate", "excludeObject",
  "unloadFilament", "setFilamentColor", "getHealth", "querySyncFiles", "getInventory",
  "discoverAt", "applyHeadMapping", "getCameraSnapshot", "openCameraStream", "getFirmwareInfo"
];

const serverSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");

for (const method of OPTIONAL_METHODS) {
  // Both shapes count: a connector held in a local (`c.listFiles(p)`) and one
  // fetched inline (`getConnector(p.connector).listFiles(p)`). The inline shape
  // is where the bug actually was, and a pattern that only knew about locals
  // passed while the route still crashed.
  const calls = [...serverSrc.matchAll(new RegExp(`(?:\\b(?:c|conn|connector)|getConnector\\([^)]*\\))\\.${method}\\s*\\(`, "g"))];
  if (!calls.length) continue;
  test(`server.js checks a connector has ${method}() before calling it`, () => {
    // The guard may read `if (!c.x)`, `!c.x ||`, `c.x ? ... :` or `&& c.x` —
    // what matters is that the name is tested somewhere, not just invoked.
    const guard = new RegExp(`(!\\s*(?:c|conn|connector)\\.${method}\\b|(?:c|conn|connector)\\.${method}\\s*(?:\\?|&&)|&&\\s*(?:c|conn|connector)\\.${method}\\b)`);
    assert.match(serverSrc, guard,
      `${method}() is called but never checked — a connector without it crashes the route`);
  });
}

for (const type of CONNECTOR_TYPES) {
  test(`${type}: implements every core method`, () => {
    const c = getConnector(type);
    const missing = CORE_METHODS.filter(m => typeof c[m] !== "function");
    assert.deepEqual(missing, [], "a control the UI can reach must exist, even if it only explains why it cannot run");
  });

  test(`${type}: a control that fails explains itself instead of throwing a TypeError`, async () => {
    const c = getConnector(type);
    // Pointed at a printer that is not there. Failing is the expected outcome
    // for a real connector; the simulator legitimately succeeds, and that is
    // fine. What must never happen is a programming error reaching the
    // operator — server.js shows connector error messages verbatim.
    const p = { name: "Nowhere", url: "http://127.0.0.1:1", ip: "127.0.0.1", serial: "TEST", verificationCode: "test" };
    for (const m of ["pause", "resume", "cancel", "bedTemp"]) {
      const arg = m === "bedTemp" ? 0 : undefined;
      let err = null;
      try { await c[m](p, arg); } catch (e) { err = e; }
      if (!err) continue;
      assert.ok(err instanceof Error, `${m} must fail with an Error`);
      assert.ok(String(err.message).trim().length > 10, `${m} must say something useful, got: ${err.message}`);
      assert.doesNotMatch(String(err.message), /is not a function|undefined is not|cannot read propert/i,
        `${m} leaked a programming error to the operator`);
    }
  });
}

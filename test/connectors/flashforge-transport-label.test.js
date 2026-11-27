// test/connectors/flashforge-transport-label.test.js — reporting WHICH
// protocol a FlashForge printer is actually being driven over.
//
// A FlashForge runs either its stock API on :8898 or, once a firmware mod is
// installed, Moonraker on :7125. SnapCon detects which and silently changes
// what it can do accordingly — but until now nothing in the UI ever said
// which one it settled on, even though the Settings hint promises "SnapCon
// normally detects which is live and re-checks if it changes".
//
// What is reported is the TRANSPORT, never the mod. SnapCon cannot tell ZMOD
// from Forge-X: printStartOverridden (flashforge-adventurer.js) is a probe for
// one overridden macro and is explicitly tri-state with null-for-unknown, and
// the zmod_ifs_* objects the AD5X looks for only exist when an IFS unit is
// fitted. Labelling a card "ZMOD" off either would be presenting an inference
// as a printer-reported fact (CLAUDE.md section 2).
const test = require("node:test");
const assert = require("node:assert/strict");
const mode = require("../../connectors/flashforge-mode");

const CONNECTORS = [
  ["flashforge-ad5x", require("../../connectors/flashforge-ad5x")],
  ["flashforge-adventurer", require("../../connectors/flashforge-adventurer")],
];

// p.id is the cache key the mode module uses, so each test gets its own.
let n = 0;
const printer = (over = {}) => Object.assign({ id: "ff" + (++n), name: "5M PRO", url: "http://192.168.40.31" }, over);

test.beforeEach(() => mode._resetAll());

for (const [name, conn] of CONNECTORS) {
  test(`${name}: exports getTransport`, () => {
    assert.equal(typeof conn.getTransport, "function");
  });

  test(`${name}: reports nothing before the first successful probe`, () => {
    // The profile lives in memory only and is gone after a restart. Absence of
    // data is valid state (section 2) — a blank tag for one poll is correct,
    // guessing "native" is not.
    assert.equal(conn.getTransport(printer()), null);
    assert.equal(conn.getTransport(null), null);
  });

  test(`${name}: reports the detected transport once a profile exists`, () => {
    const p = printer();
    mode.setProfile(p, { transport: "moonraker" });
    assert.equal(conn.getTransport(p), "moonraker");

    const q = printer();
    mode.setProfile(q, { transport: "native" });
    assert.equal(conn.getTransport(q), "native");
  });

  test(`${name}: an admin's pin wins over whatever was last detected`, () => {
    // A pinned printer never runs detection at all (flashforge-mode's pin
    // short-circuit), so a stale profile must not outrank the pin.
    const p = printer({ transport: "native" });
    mode.setProfile(p, { transport: "moonraker" });
    assert.equal(conn.getTransport(p), "native");
  });

  test(`${name}: a junk pin is ignored rather than echoed back`, () => {
    // p.transport is allowlisted on save, but config.json is editable by hand
    // and is untrusted input on load (section 8).
    const p = printer({ transport: "sideways" });
    mode.setProfile(p, { transport: "moonraker" });
    assert.equal(conn.getTransport(p), "moonraker", "falls back to what was detected");

    const q = printer({ transport: "sideways" });
    assert.equal(conn.getTransport(q), null, "and to nothing when there is no detection either");
  });

  test(`${name}: is synchronous — every fleet row calls it and cannot await`, () => {
    // Same contract getCapabilities(p) already has on these connectors: the
    // server builds rows synchronously, so this must never return a promise
    // and must never touch the network.
    const p = printer();
    mode.setProfile(p, { transport: "native" });
    const got = conn.getTransport(p);
    assert.equal(typeof got, "string");
    assert.ok(!(got instanceof Promise));
  });
}

test("no non-FlashForge connector claims a transport", () => {
  // Every other connector speaks exactly one protocol, so a tag would imply a
  // choice that does not exist — the same reason the Settings control is
  // gated to these two.
  const REGISTRY = require("../../connectors");
  for (const [type, mod] of Object.entries(REGISTRY.REGISTRY || {})) {
    if (type.startsWith("flashforge")) continue;
    assert.equal(typeof (mod || {}).getTransport, "undefined", `${type} must not export getTransport`);
  }
});

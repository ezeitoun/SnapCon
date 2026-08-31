// test/connectors/flashforge-endpoint.test.js — which host:port each transport
// talks to, for every combination of pin and stored port.
//
// Regression for a real defect: address.defaultPort was 8898, the Settings row
// pre-fills a new printer's port with the connector default, so every FlashForge
// printer added through the UI persisted ":8898" — which BOTH transports then
// honoured. Detection probed 8898 twice and reported a healthy ZMOD printer as
// offline.
//
// The rule this encodes:
//   AUTO   — a stored port equal to a CONVENTIONAL transport default (8898 or
//            7125) tells Auto nothing it does not already know, so it is not
//            authoritative; each transport probes its own default. Any other
//            port is information Auto lacks and IS authoritative, on both.
//   PINNED — the stored port is ALWAYS authoritative, including unusual
//            combinations such as Moonraker on 8898 or native on 7125.
//
// Deliberately NOT encoded: "8898 can only be native" or "7125 can only be
// Moonraker". Rows 6 and 10 exist to prove those beliefs are absent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fm = require("../../connectors/flashforge-moonraker");

const NATIVE = "8898", MOON = "7125";
const P = (url, transport) => ({ id: "e" + Math.random(), name: "FF", url, ...(transport ? { transport } : {}) });
const nat = p => fm.resolveEndpoint(p, { want: "native", nativePort: NATIVE, moonrakerPort: MOON });
const moo = p => fm.resolveEndpoint(p, { want: "moonraker", nativePort: NATIVE, moonrakerPort: MOON });

// ---- Auto mode ----

test("row 1 — auto, no stored port: each transport uses its own default", () => {
  const p = P("http://192.0.2.10");
  assert.equal(nat(p), "http://192.0.2.10:8898");
  assert.equal(moo(p), "http://192.0.2.10:7125");
});

test("row 2 — auto, stored 8898: conventional default is not authoritative", () => {
  // The legacy shape our own UI generated.
  const p = P("http://192.0.2.10:8898");
  assert.equal(nat(p), "http://192.0.2.10:8898");
  assert.equal(moo(p), "http://192.0.2.10:7125", "must not probe 8898 for Moonraker");
});

test("row 3 — auto, stored 7125: same rule, symmetric", () => {
  const p = P("http://192.0.2.10:7125");
  assert.equal(nat(p), "http://192.0.2.10:8898", "must not probe 7125 for native");
  assert.equal(moo(p), "http://192.0.2.10:7125");
});

test("row 4 — auto, custom port: authoritative on BOTH transports, no fallback", () => {
  for (const port of ["5000", "7126", "8080", "443"]) {
    const p = P(`http://192.0.2.10:${port}`);
    assert.equal(nat(p), `http://192.0.2.10:${port}`, "native must honour custom " + port);
    assert.equal(moo(p), `http://192.0.2.10:${port}`, "moonraker must honour custom " + port);
  }
});

// ---- Pinned: native ----

test("row 5 — native pin, no port: the pinned transport's default", () => {
  assert.equal(nat(P("http://192.0.2.10", "native")), "http://192.0.2.10:8898");
});

test("row 6 — native pin, explicit 8898: honoured", () => {
  assert.equal(nat(P("http://192.0.2.10:8898", "native")), "http://192.0.2.10:8898");
});

test("row 7 — native pin, custom port: honoured, never substituted", () => {
  assert.equal(nat(P("http://192.0.2.10:9999", "native")), "http://192.0.2.10:9999");
});

test("native pinned to 7125 is honoured — we encode no belief that 7125 cannot be native", () => {
  assert.equal(nat(P("http://192.0.2.10:7125", "native")), "http://192.0.2.10:7125");
});

// ---- Pinned: moonraker ----

test("row 8 — moonraker pin, no port: the pinned transport's default", () => {
  assert.equal(moo(P("http://192.0.2.10", "moonraker")), "http://192.0.2.10:7125");
});

test("row 9 — moonraker pin, explicit 7125: honoured", () => {
  assert.equal(moo(P("http://192.0.2.10:7125", "moonraker")), "http://192.0.2.10:7125");
});

test("row 10 — moonraker pin, explicit 8898: honoured, THE intentional-config escape hatch", () => {
  // This is how a user expresses "Moonraker really does live on 8898".
  assert.equal(moo(P("http://192.0.2.10:8898", "moonraker")), "http://192.0.2.10:8898");
});

test("row 10 — moonraker pin, arbitrary custom port: honoured", () => {
  assert.equal(moo(P("http://192.0.2.10:5000", "moonraker")), "http://192.0.2.10:5000");
});

// ---- shape ----

test("scheme and host are preserved verbatim", () => {
  assert.equal(moo(P("https://printer.local")), "https://printer.local:7125");
  assert.equal(nat(P("https://printer.local:5000")), "https://printer.local:5000");
});

test("the module encodes no port constants of its own — the caller supplies both", () => {
  // Passing different defaults must change the answer; nothing is hardcoded.
  const p = P("http://192.0.2.10");
  assert.equal(fm.resolveEndpoint(p, { want: "native", nativePort: "1111", moonrakerPort: "2222" }), "http://192.0.2.10:1111");
  assert.equal(fm.resolveEndpoint(p, { want: "moonraker", nativePort: "1111", moonrakerPort: "2222" }), "http://192.0.2.10:2222");
});

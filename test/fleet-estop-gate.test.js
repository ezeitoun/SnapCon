// test/fleet-estop-gate.test.js — the E-Stop button must not promise a halt a
// printer cannot perform.
//
// Verified live on a real FlashForge 5M Pro (firmware 5.1.7): its stock
// firmware ACKNOWLEDGES ~M112 and never halts. Confirmed three ways — idle via
// script, mid-print via script, and mid-print via this very button — with the
// operator having to cancel the print by hand each time. The connectors now
// report `capabilities.estop === false` for the native transport, and a real
// halt (`/printer/emergency_stop`) only for ZMOD/Moonraker.
//
// DELIBERATE DEVIATION from the surrounding convention, called out per
// CLAUDE.md section 5: every other capability gate in this file HIDES its
// control (camera, webUi, excludeObject). E-Stop is shown DISABLED with a title
// explaining why instead. Silently removing an emergency control teaches an
// operator it does not exist; saying why sends them to Cancel or the power
// switch. Disabled controls carry a title for exactly this reason.
//
// The gate is `=== false`, never a truthiness check: connectors with a working
// e-stop (U1, Creality, Klipper) do not declare the flag at all, and
// `!p.capabilities?.estop` would disable the button on every one of them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  const end = appSrc.indexOf("\n}", start);
  return appSrc.slice(start, end + 2);
}

const env = vm.createContext({});
vm.runInContext(extractFn("estopUnsupported"), env);
const unsupported = p => vm.runInContext("estopUnsupported", env)(p);

test("estopUnsupported: true only when a connector explicitly reports estop:false", () => {
  assert.equal(unsupported({ capabilities: { estop: false } }), true);
});

test("estopUnsupported: a connector that never declares the flag keeps its button", () => {
  // U1, Creality and generic Klipper all have a real, working emergency stop
  // and simply do not declare the capability. A truthiness check here would
  // disable E-Stop across the entire rest of the fleet.
  assert.equal(unsupported({ capabilities: {} }), false, "absent flag must not disable");
  assert.equal(unsupported({ capabilities: { camera: true } }), false);
  assert.equal(unsupported({}), false, "no capabilities object at all");
  assert.equal(unsupported({ capabilities: null }), false);
});

test("estopUnsupported: a ZMOD FlashForge reporting estop:true keeps its button", () => {
  assert.equal(unsupported({ capabilities: { estop: true } }), false);
});

// ---- both render paths must be gated, not just the card ----

function estopButtonLines() {
  return appSrc.split("\n").filter(l => l.includes("data-estop=") && l.includes("<button"));
}

test("every E-Stop button render path is gated on the capability", () => {
  const lines = estopButtonLines();
  assert.equal(lines.length, 2, "card grid + list view; a new one must be gated too: " + lines.length);
  for (const l of lines) {
    assert.match(l, /estopUnsupported\(p\)/,
      "an ungated E-Stop button would still promise a halt this printer cannot do");
  }
});

test("a disabled E-Stop explains itself rather than leaving the operator guessing", () => {
  for (const l of estopButtonLines()) {
    assert.match(l, /action_estop_unsupported_title/,
      "CLAUDE.md section 5: a disabled control carries a title saying why");
  }
});

test("the E-Stop button is still disabled by the existing permission gate", () => {
  // The capability gate is added to canAct(), never replaces it — a viewer
  // without permission must not gain an enabled E-Stop.
  for (const l of estopButtonLines()) assert.match(l, /canAct\(\)/);
});

// ---- the copy has to exist in the shipped locales ----

for (const loc of ["en", "es"]) {
  test(`${loc}.json carries the unsupported-e-stop title`, () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", loc + ".json"), "utf8"));
    const s = j.printer && j.printer.action_estop_unsupported_title;
    assert.ok(s && String(s).trim(), "missing printer.action_estop_unsupported_title");
  });
}

// Deliberately NOT an absolute number. An earlier version of this asserted
// "> 52" — the working tree's value on the day it was written — which says
// nothing durable: it breaks on the next bump for a correct tree, and passes
// for a stale one that merely happens to sit above the constant.
//
// What actually has to hold is that the two shipped locales agree. _meta.version
// is what clients compare to decide whether to refetch, so en and es drifting
// apart means one language updates and the other silently serves stale strings.
test("the bundled locales agree on _meta.version", () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));
  assert.equal(typeof en._meta.version, "number");
  assert.equal(es._meta.version, en._meta.version,
    "a client refetching English but not Spanish would serve stale Spanish strings");
});

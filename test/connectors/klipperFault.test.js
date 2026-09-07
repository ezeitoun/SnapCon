// test/connectors/klipperFault.test.js — the single normalization rule for
// Klipper machine health (docs/TODO.md item 9b).
//
// Klippy's own `webhooks` object reports whether the MACHINE is alive,
// independently of what `print_stats` says about the JOB. None of the four
// Klipper status implementations read it, so a printer whose Klipper had shut
// down reported online:true / state:"standby" with a frozen-but-plausible
// print_stats -- confirmed live on a SPARKX i7 sitting in
// webhooks.state:"shutdown" with a real state_message while SnapCon showed it
// idle.
//
// Health wins over job state, absolutely. This helper is shared rather than
// copied into each connector precisely because it is a safety property: three
// HTTP connectors plus snapmaker-u1-klipper-ws.js's deliberately-duplicated
// normalizeU1State() all need it, and four copies is how such a rule drifts.
//
// Verified live 2026-09-07 across all 18 Klipper-family printers on this
// network (15 U1 + 2 Ender-3 V3 Plus + 1 SPARKX i7):
//   - `webhooks` is advertised by printer/objects/list on 18/18
//   - a healthy machine reports {state:"ready", state_message:"Printer is ready"}
// That second fact is why the ready->null case below is mandatory rather than
// cosmetic: state_message is populated even when nothing is wrong, so a helper
// that passed it through unconditionally would set p.message on every healthy
// printer -- which is the flag the fleet card uses to suppress its entire
// progress/thumbnail/lanes block.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("../../connectors/http-utils");
const klipperFault = http.klipperFault;

const READY = { state: "ready", state_message: "Printer is ready" };

test("a healthy printer produces no fault, even though state_message is populated", () => {
  assert.equal(klipperFault({ webhooks: READY }), null,
    "verified live: all 18 machines report state_message while perfectly healthy");
});

test("shutdown is a fault, and carries Klipper's own diagnostic text", () => {
  const f = klipperFault({ webhooks: {
    state: "shutdown",
    state_message: "Internal error on command:G1\nOnce the underlying issue is corrected, use the FIRMWARE_RESTART command"
  } });
  assert.equal(f.state, "error");
  assert.equal(f.errorCode, "KLIPPER_SHUTDOWN");
  assert.match(f.message, /Internal error on command:G1/,
    "state_message is the only genuinely diagnostic thing Klipper gives us here");
});

test("error is a fault too, and is not mislabelled as a shutdown", () => {
  const f = klipperFault({ webhooks: { state: "error", state_message: "Option 'x' in section 'y' must be specified" } });
  assert.equal(f.state, "error");
  assert.equal(f.errorCode, "KLIPPER_ERROR",
    "a config error is not a shutdown -- reusing that code would mislabel it");
});

test("startup is not treated as a fault", () => {
  assert.equal(klipperFault({ webhooks: { state: "startup", state_message: "" } }), null,
    "never observed here: Moonraker refuses object queries while Klippy is not ready, "
    + "so this resolves through the existing !ok -> online:false path instead");
});

test("an unrecognised future state value is not guessed at", () => {
  assert.equal(klipperFault({ webhooks: { state: "something_new" } }), null);
});

test("a fault survives a state_message the printer left empty", () => {
  const f = klipperFault({ webhooks: { state: "shutdown" } });
  assert.equal(f.state, "error");
  assert.equal(f.errorCode, "KLIPPER_SHUTDOWN");
  assert.equal(f.message, "",
    "errorCode alone still trips the card's error branch, so nothing is silently swallowed");
});

test("a status dict with no webhooks object produces no fault", () => {
  assert.equal(klipperFault({ print_stats: { state: "printing" } }), null,
    "a connector whose query has not been updated must not start reporting errors");
});

test("klipperFault tolerates malformed input instead of throwing", () => {
  assert.equal(klipperFault(undefined), null);
  assert.equal(klipperFault(null), null);
  assert.equal(klipperFault({}), null);
  assert.equal(klipperFault({ webhooks: null }), null);
  assert.equal(klipperFault({ webhooks: "shutdown" }), null);
});

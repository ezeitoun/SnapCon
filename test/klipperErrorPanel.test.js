// test/klipperErrorPanel.test.js — how a Klipper machine fault reads on the
// fleet card (docs/TODO.md item 9b).
//
// Two requirements that pull against each other:
//
//  1. A known Klipper shutdown must not be titled "Unknown error". That is what
//     lookupKlipperError() falls back to for any code with no table entry.
//  2. webhooks.state_message must survive to the operator. It is the only
//     genuinely diagnostic thing Klipper gives us here -- it names the actual
//     failure ("Lost communication with MCU", "Internal error on command:G1")
//     and tells them the fix is FIRMWARE_RESTART.
//
// Naively adding a table entry satisfies (1) and breaks (2), because the entry's
// static description replaced the live message. The rule instead is: an entry
// with an EMPTY description defers to the live message. All 413 pre-existing
// Snapmaker entries have a non-empty description, so none of them change
// behavior -- verified by the last test here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const codesSrc = fs.readFileSync(path.join(ROOT, "public", "error-codes.js"), "utf8");

const sandbox = { t: k => "i18n:" + k };
vm.createContext(sandbox);
vm.runInContext(codesSrc, sandbox);
const start = appSrc.indexOf("function lookupKlipperError(");
assert.ok(start > 0, "lookupKlipperError must exist in public/app.js");
vm.runInContext(appSrc.slice(start, appSrc.indexOf("\n}", start) + 2), sandbox);
const lookup = (code, msg) => vm.runInContext("lookupKlipperError", sandbox)(code, msg);
const CODES = vm.runInContext("ERROR_CODES", sandbox);

const SHUTDOWN_MSG = "Lost communication with MCU 'mcu'\nOnce the underlying issue is corrected, use the FIRMWARE_RESTART command to reset the firmware.";

test("the synthetic Klipper codes exist and are brand-neutral", () => {
  assert.ok(CODES.KLIPPER_SHUTDOWN, "the code the connectors emit must resolve to a real entry");
  assert.ok(CODES.KLIPPER_ERROR);
  for (const k of ["KLIPPER_SHUTDOWN", "KLIPPER_ERROR"]) {
    assert.doesNotMatch(CODES[k].t, /snapmaker|u1/i,
      "this table is Snapmaker-keyed, but these two entries serve every Klipper connector");
  }
});

test("a shutdown is titled properly, not 'Unknown error'", () => {
  const e = lookup("KLIPPER_SHUTDOWN", SHUTDOWN_MSG);
  assert.doesNotMatch(e.title, /unknown/i);
  assert.match(e.title, /klipper/i, "the operator should see what actually failed");
});

test("Klipper's live diagnostic text reaches the operator", () => {
  const e = lookup("KLIPPER_SHUTDOWN", SHUTDOWN_MSG);
  assert.match(e.description, /Lost communication with MCU/,
    "a static table description here would hide the one useful fact we have");
  assert.match(e.description, /FIRMWARE_RESTART/, "…including the actual remedy");
});

test("a config error is titled distinctly from a shutdown", () => {
  const shut = lookup("KLIPPER_SHUTDOWN", "x");
  const err = lookup("KLIPPER_ERROR", "Option 'x' in section 'y' must be specified");
  assert.notEqual(shut.title, err.title, "different Klipper conditions, different remedies");
  assert.match(err.description, /must be specified/);
});

test("the code itself is still surfaced", () => {
  assert.equal(lookup("KLIPPER_SHUTDOWN", SHUTDOWN_MSG).code, "KLIPPER_SHUTDOWN");
});

test("a fault with no state_message still renders without blowing up", () => {
  const e = lookup("KLIPPER_SHUTDOWN", "");
  assert.match(e.title, /klipper/i);
  assert.equal(typeof e.description, "string");
});

test("every pre-existing Snapmaker code still shows its own curated description", () => {
  const sample = "0003-0522-0000-0002";
  assert.ok(CODES[sample], "fixture code must still be in the table");
  const e = lookup(sample, "some raw printer chatter that must not win");
  assert.equal(e.description, CODES[sample].d,
    "the curated text outranks the raw message for every code that has one");
  const emptyDesc = Object.keys(CODES).filter(k => !CODES[k].d && !k.startsWith("KLIPPER_"));
  assert.deepEqual(emptyDesc, [],
    "the defer-to-message rule keys off an empty description, so no legacy entry may have one");
});

test("an unknown code still falls back exactly as before", () => {
  const e = lookup("9999-0000-0000-0000", "raw text");
  assert.equal(e.description, "raw text");
  assert.match(e.title, /unknown_error_title|9999/);
});

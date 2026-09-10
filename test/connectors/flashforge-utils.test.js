// test/connectors/flashforge-utils.test.js — regression test for C-4 (stored
// XSS via unsanitized FlashForge filament color). getFileMetadata() must run
// materialColor through normHex() so a malicious/compromised printer's
// "/gcodeList" response can never hand the browser anything other than a
// strict #RRGGBB/#RGB string or null — normHex() is also the sole gate
// public/app.js relies on before this value reaches a style="background:..."
// template.
const test = require("node:test");
const assert = require("node:assert/strict");
const ff = require("../../connectors/flashforge-utils");

const p = { name: "Test FlashForge", url: "http://127.0.0.1:1", serial: "s", verificationCode: "0000" };

function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

test("getFileMetadata sanitizes a well-formed materialColor through normHex", async () => {
  const result = await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ code: 0, gcodeListDetail: [{ gcodeFileName: "a.gcode", gcodeToolDatas: [{ materialColor: "#ff0000", materialName: "PLA" }] }] }) }),
    () => ff.getFileMetadata(p, "a.gcode")
  );
  assert.equal(result.palette[0].hex, "#FF0000");
});

test("getFileMetadata neutralizes an XSS-shaped materialColor instead of passing it through", async () => {
  const malicious = 'red" onmouseover="fetch(1)';
  const result = await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ code: 0, gcodeListDetail: [{ gcodeFileName: "a.gcode", gcodeToolDatas: [{ materialColor: malicious, materialName: "PLA" }] }] }) }),
    () => ff.getFileMetadata(p, "a.gcode")
  );
  assert.equal(result.palette[0].hex, null, "a non-hex-shaped value must become null, never pass through verbatim");
  assert.ok(!JSON.stringify(result).includes("onmouseover"), "the raw malicious string must not survive into the response at all");
});

test("getFileMetadata neutralizes a materialColor that attempts an HTML tag breakout", async () => {
  const malicious = '"><img src=x onerror=alert(1)>';
  const result = await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ code: 0, gcodeListDetail: [{ gcodeFileName: "a.gcode", gcodeToolDatas: [{ materialColor: malicious, materialName: "PLA" }] }] }) }),
    () => ff.getFileMetadata(p, "a.gcode")
  );
  assert.equal(result.palette[0].hex, null);
});

// ---- decodeCommonStatus: fields that a real Adventurer 5M Pro (firmware
// 3.1.5) reports but the decoder was reading under the wrong name, or
// discarding outright. Both fixes live in code SHARED with
// flashforge-ad5x.js, so each is deliberately additive — an AD5X that
// behaves the way the old code assumed must keep working unchanged.

// coolingFanSpeed is a PERCENTAGE (0-100), not the 0-255 PWM the documented
// example payload implied. Settled live on a real 5M Pro (firmware 5.1.7) on
// 2026-09-09 by comparing what the file COMMANDS against what the printer
// REPORTS, which is stronger than reading a number off the panel:
//
//   boat_pla_14m3s.gcode contains only two fan commands, M106 S0 (x7) and
//   M106 S255 (x802) — no intermediate values anywhere in the file. While
//   printing inside an S255 (full-speed) region the printer reported
//   coolingFanSpeed = 100, and on pause it dropped to 0.
//
// Under a 0-255 PWM reading, full speed would report 255. It reported 100.
// The old /255 therefore turned a true 100% into a displayed 39% on every
// FlashForge — under-reporting by 2.55x.
test("fanPct: coolingFanSpeed is a percentage, NOT 0-255 PWM (live-confirmed)", () => {
  // The exact value a real 5M Pro reports at M106 S255.
  assert.equal(ff.decodeCommonStatus(p, { status: "building", coolingFanSpeed: 100 }).fanPct, 100,
    "full-speed cooling must read as 100%, not 39%");
});

test("fanPct: a mid-range coolingFanSpeed passes through unscaled", () => {
  assert.equal(ff.decodeCommonStatus(p, { status: "building", coolingFanSpeed: 50 }).fanPct, 50);
  assert.equal(ff.decodeCommonStatus(p, { status: "building", coolingFanSpeed: 30 }).fanPct, 30);
});

test("fanPct: fan off reports 0 (confirmed live on pause)", () => {
  assert.equal(ff.decodeCommonStatus(p, { status: "pause", coolingFanSpeed: 0 }).fanPct, 0);
});

test("fanPct reads coolingFanSpeed, the field a real 5M Pro actually reports", () => {
  // The old decoder only looked at coolingFanLeftSpeed, which does not exist
  // in the live payload at all — so fanPct was null on every real printer.
  // Uses a realistic value on purpose: a real printer reports 0-100 here, and
  // a 255 in this test would quietly re-assert the PWM reading that turned out
  // to be wrong (see the percentage tests above).
  const st = ff.decodeCommonStatus(p, { status: "building", coolingFanSpeed: 60 });
  assert.equal(st.fanPct, 60);
});

test("fanPct still falls back to coolingFanLeftSpeed so an AD5X using the documented name cannot regress", () => {
  const st = ff.decodeCommonStatus(p, { status: "building", coolingFanLeftSpeed: 128 });
  assert.equal(st.fanPct, 50);
});

test("fanPct prefers the confirmed field when a printer somehow reports both", () => {
  const st = ff.decodeCommonStatus(p, { status: "building", coolingFanSpeed: 255, coolingFanLeftSpeed: 0 });
  assert.equal(st.fanPct, 100);
});

test("fanPct stays null when the printer reports no fan field at all", () => {
  assert.equal(ff.decodeCommonStatus(p, { status: "ready" }).fanPct, null);
});

test("fanPct is clamped into 0-100 rather than emitting a nonsense percentage", () => {
  assert.equal(ff.decodeCommonStatus(p, { status: "building", coolingFanSpeed: 9999 }).fanPct, 100);
  assert.equal(ff.decodeCommonStatus(p, { status: "building", coolingFanSpeed: -5 }).fanPct, 0);
});

test("errorCode carries the printer's real fault code instead of being hardcoded empty", () => {
  // Previously `errorCode: ""` unconditionally, so http-utils.js's fault
  // history and the fleet error panel never saw a FlashForge fault code.
  const st = ff.decodeCommonStatus(p, { status: "error", errorCode: "E0021" });
  assert.equal(st.errorCode, "E0021");
});

test("errorCode accepts a numeric code without stringifying it into something useless", () => {
  assert.equal(ff.decodeCommonStatus(p, { status: "error", errorCode: 21 }).errorCode, "21");
});

test("a healthy printer's empty errorCode stays empty (confirmed live: idle 5M Pro reports \"\")", () => {
  assert.equal(ff.decodeCommonStatus(p, { status: "ready", errorCode: "" }).errorCode, "");
});

test("a zero-sentinel errorCode is treated as no fault, not as a permanent attention badge", () => {
  // public/app.js:330 flags 'attention' for ANY truthy errorCode, and "0" is
  // a truthy string — without this guard a firmware reporting a benign zero
  // would pin every FlashForge printer to a permanent attention state.
  for (const sentinel of ["0", "0000", "  0000  "]) {
    assert.equal(ff.decodeCommonStatus(p, { status: "ready", errorCode: sentinel }).errorCode, "",
      `"${sentinel}" must not read as a real fault`);
  }
});

test("a non-string, non-number errorCode cannot leak \"[object Object]\" into the UI", () => {
  assert.equal(ff.decodeCommonStatus(p, { status: "error", errorCode: { code: 5 } }).errorCode, "");
  assert.equal(ff.decodeCommonStatus(p, { status: "ready" }).errorCode, "");
});

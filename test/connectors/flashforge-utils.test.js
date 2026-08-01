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

// test/connectors/flashforge-autolevel.test.js — Auto-level before a print on
// the Adventurer 5M / 5M PRO (docs/TODO.md §40).
//
// Before: the native start always sent levelingBeforePrint:false and the
// connector declared autoLevel:false, so the Settings switch and the per-job
// checkbox were hidden and the printer never leveled. The flag was verified
// live on a 5M PRO (2026-10-26): with true it heats the bed to 60 °C, cleans
// the nozzle and levels before the print. Moonraker mode does not send it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ff = require("../../connectors/flashforge-utils");
const adv = require("../../connectors/flashforge-adventurer");

// /printGcode answers Success and the printer then reports printing, so the
// start confirms on the first poll. Records each start's body.
function mockPrinter() {
  const starts = [];
  const handler = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (p === "/printGcode") {
      starts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ code: 0, message: "Success" }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, detail: { status: starts.length ? "printing" : "ready" } }) };
  };
  return { handler, starts };
}
async function startWith(printer, opts) {
  const m = mockPrinter();
  const real = global.fetch;
  global.fetch = m.handler;
  try { await adv.startPrintFile(printer, "Part.gcode", opts); }
  finally { global.fetch = real; }
  assert.equal(m.starts.length, 1, "one start");
  assert.equal(m.starts[0].fileName, "Part.gcode");
  return m.starts[0].levelingBeforePrint;
}
const P = extra => ({ id: "ff5m", name: "5M PRO", url: "http://127.0.0.1:1", transport: "native", serial: "SN1", verificationCode: "code", ...extra });

test("native transport offers Auto-level; Moonraker mode does not", () => {
  assert.equal(adv.capabilities.autoLevel, true);
  assert.equal(adv.getCapabilities(P()).autoLevel, true);
  assert.equal(adv.getCapabilities(P({ transport: "moonraker" })).autoLevel, false);
});

test("the job's Auto-level choice is sent with the start", async () => {
  assert.equal(await startWith(P(), { prefs: { autoLevel: true } }), true);
  assert.equal(await startWith(P({ autoLevel: true }), { prefs: { autoLevel: false } }), false, "an explicit off wins over the printer's default");
});

test("with no choice for the job, the printer's own default is used", async () => {
  assert.equal(await startWith(P({ autoLevel: true }), { prefs: {} }), true);
  assert.equal(await startWith(P({ autoLevel: true }), {}), true);
  assert.equal(await startWith(P(), undefined), false, "no choice and no default: no leveling, as before");
});

test("the upload never starts or levels by itself", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "connectors", "flashforge-utils.js"), "utf8");
  assert.match(src, /printNow: "false", levelingBeforePrint: "false"/);
});

// server.js has no express harness; the three places that start a print are
// pinned at the call. Without prefs the connector can only use the default.
test("every start path in server.js hands the job's prefs to the connector", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const calls = src.match(/c\.startPrintFile\([^)]*\)/g);
  assert.deepEqual(calls, [
    "c.startPrintFile(p, name, { plate, prefs })",          // /api/print
    "c.startPrintFile(p, filename, { plate, prefs })",      // /api/printfile
    "c.startPrintFile(p, name, { prefs: item.prefs })",     // queue dispatch
  ]);
});

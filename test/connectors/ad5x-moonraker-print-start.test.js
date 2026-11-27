// test/connectors/ad5x-moonraker-print-start.test.js — the per-printer opt-in
// that lets SnapCon start a print on an AD5X running ZMOD (Moonraker).
//
// Why it was refused outright until now: ZMOD replaces Klipper's built-in
// SDCARD_PRINT_FILE with its own macro. Read live off an AD5X on ZMOD, its
// object list has SDCARD_PRINT_FILE present, NO BASE_SDCARD_PRINT_FILE to
// fall back to, and a _ZSDCARD_PRINT_FILE / _ZSDCARD_PRINT_FILE_CONTINUE
// pair — a start macro split into "begin" and "continue", which is what you
// build around an interruption. If that interruption is a touchscreen
// confirmation, an unattended queue start would hang waiting for a human.
//
// That is still unverified on hardware, so the refusal stays the DEFAULT. The
// setting lets an operator who is standing at the printer accept the risk
// deliberately. It must never be assumed: anything other than an explicit
// true keeps the refusal.
const test = require("node:test");
const assert = require("node:assert/strict");
const mode = require("../../connectors/flashforge-mode");
const ad5x = require("../../connectors/flashforge-ad5x");

let n = 0;
const printer = (over = {}) => Object.assign(
  { id: "ff" + (++n), name: "AD5X Blue", url: "http://192.168.40.212", transport: "moonraker" }, over);

function withMockFetch(handler, fn) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = real; });
}
// Records every request the connector makes so "nothing was sent" is provable.
function spy() {
  const calls = [];
  return {
    calls,
    handler: async (url, init) => {
      calls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({ result: "ok" }) };
    },
  };
}

test.beforeEach(() => mode._resetAll());

test("refuses by default, and sends nothing to the printer", async () => {
  const s = spy();
  await withMockFetch(s.handler, async () => {
    await assert.rejects(() => ad5x.startPrintFile(printer(), "Ferret.gcode"), /not yet verified/i);
  });
  assert.equal(s.calls.length, 0, "a refused start must not touch the printer at all");
});

test("the refusal tells the operator the setting exists", async () => {
  // A dead end with no way forward is what sent the user hunting through
  // Fluidd; the message should say this is a choice they can make.
  const s = spy();
  await withMockFetch(s.handler, async () => {
    await assert.rejects(() => ad5x.startPrintFile(printer(), "Ferret.gcode"), /settings/i);
  });
});

test("only an explicit true opts in — nothing else is treated as consent", async () => {
  for (const v of [undefined, null, false, 0, "", "false", "no", 1, "true"]) {
    const s = spy();
    await withMockFetch(s.handler, async () => {
      await assert.rejects(
        () => ad5x.startPrintFile(printer({ allowMoonrakerPrintStart: v }), "Ferret.gcode"),
        /not yet verified/i,
        `allowMoonrakerPrintStart=${JSON.stringify(v)} must not start a print`
      );
    });
    assert.equal(s.calls.length, 0);
  }
});

test("with the setting on, the print is actually started over Moonraker", async () => {
  const s = spy();
  await withMockFetch(s.handler, () =>
    ad5x.startPrintFile(printer({ allowMoonrakerPrintStart: true }), "Ferret.gcode"));
  assert.ok(s.calls.length > 0, "something must reach the printer");
  const hit = s.calls.find(c => /print/i.test(c.url) || /print/i.test(String(c.body || "")));
  assert.ok(hit, "a print-start request must be among them: " + JSON.stringify(s.calls.map(c => c.url)));
  // :7125 is Moonraker; :8898 is the stock API that modded firmware closes.
  assert.ok(s.calls.every(c => !c.url.includes(":8898")), "must not fall back to the native API");
});

test("the setting has no effect on a printer running stock firmware", async () => {
  // It is a Moonraker-path gate. A native AD5X already starts prints through
  // the FlashForge API, and this must not change or bypass that.
  const s = spy();
  await withMockFetch(s.handler, async () => {
    // The stub's payload is not a real FlashForge response, so the call may
    // reject — irrelevant here. What matters is WHERE it was routed.
    try { await ad5x.startPrintFile(printer({ transport: "native", allowMoonrakerPrintStart: true }), "Ferret.gcode"); }
    catch { /* routing is the assertion, not the stub's reply */ }
  });
  assert.ok(s.calls.some(c => c.url.includes(":8898")), "native start still goes to the stock API");
  assert.ok(!s.calls.some(c => /not yet verified/.test(String(c.body || ""))), "no Moonraker gate involved");
});

test("the gate's reasoning stays recorded in the source", () => {
  // This refusal exists because of a specific, still-unverified hardware
  // behaviour. If someone deletes the explanation the next person has no way
  // to know what has to be tested before the default can change.
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "connectors", "flashforge-ad5x.js"), "utf8");
  const at = src.indexOf("startPrintFileMoonraker");
  const around = src.slice(Math.max(0, at - 2000), at + 600);
  assert.match(around, /touchscreen/i, "the risk must stay named");
  assert.match(around, /verif/i, "and what would lift the gate");
});

// test/connectors/flashforge-estop-native.test.js — FlashForge's NATIVE
// protocol has no working emergency stop, so SnapCon must stop offering one.
//
// Verified live on a real 5M Pro (firmware 5.1.7) on 2026-09-09, three ways:
//
//   idle, via script      estop() resolved "success"; printer sat at `ready`
//                         for a full 30s watch, temps unchanged, API responsive
//   mid-print, via script printer kept extruding
//   mid-print, via the UI printer kept extruding; the operator had to cancel
//                         the print by hand
//
// The raw TCP capture shows why:
//
//   ~M601 S1  ->  "CMD M601 Received.\r\nControl Success V2.1.\r\nok\r\n"
//   ~M112     ->  "CMD M112 Received.\r\nok\r\n"     <- acknowledged
//   ~M119     ->  "MachineStatus: READY  MoveMode: READY"   <- never halted
//
// The firmware ACCEPTS M112 and ignores it. sendTcpSequence's success rule was
// "M112 may never reply cleanly once the halt begins, so getting that far means
// it worked" — the exact opposite of what this hardware does, so the signal
// meant to PROVE the stop landed is produced by a printer that did nothing.
//
// Worse than merely misleading: the connectors' cross-transport retry is
// `try native, catch -> try moonraker`. A native estop that RESOLVES means the
// Moonraker fallback is never attempted, so a ZMOD printer misdetected as
// native would have its emergency stop silently swallowed. Making native throw
// restores that safety net rather than just removing a lie.
//
// Moonraker/ZMOD is unaffected and keeps a real halt: /printer/emergency_stop.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const ff = require("../../connectors/flashforge-utils");
const adv = require("../../connectors/flashforge-adventurer");
const ad5x = require("../../connectors/flashforge-ad5x");
const mode = require("../../connectors/flashforge-mode");

const HOST = "192.0.2.77";
const base = { id: "ffe", name: "5M PRO", url: `http://${HOST}`, serial: "S", verificationCode: "C" };
const nativeP = () => ({ ...base, transport: "native" });
const moonP = () => ({ ...base, transport: "moonraker" });

// Records any attempt to open a TCP socket, and refuses it — nothing in these
// tests may reach a real machine.
function watchTcp() {
  const original = net.createConnection;
  const attempts = [];
  net.createConnection = (opts, ...rest) => {
    attempts.push({ host: opts && opts.host, port: opts && opts.port });
    const s = new (require("events").EventEmitter)();
    s.write = () => {}; s.end = () => {}; s.destroy = () => {};
    setImmediate(() => s.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    return s;
  };
  return { attempts, restore: () => { net.createConnection = original; } };
}

// Records every HTTP request; Moonraker calls fail unless told otherwise.
function watchFetch({ moonrakerWorks = false } = {}) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url || input);
    urls.push(url);
    if (url.includes("/printer/emergency_stop")) {
      if (!moonrakerWorks) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return new Response(JSON.stringify({ result: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}

// ---- the capability ----

test("native FlashForge does not advertise an emergency stop", () => {
  assert.equal(adv.capabilities.estop, false, "5M / 5M Pro stock firmware");
  assert.equal(ad5x.capabilities.estop, false, "AD5X stock firmware");
});

test("a Moonraker/ZMOD FlashForge DOES advertise one", () => {
  assert.equal(adv.getCapabilities({ ...base, transport: "moonraker" }).estop, true);
  assert.equal(ad5x.getCapabilities({ ...base, transport: "moonraker" }).estop, true);
});

test("native transport reports the capability as false through getCapabilities too", () => {
  assert.equal(adv.getCapabilities({ ...base, transport: "native" }).estop, false);
  assert.equal(ad5x.getCapabilities({ ...base, transport: "native" }).estop, false);
});

// ---- the native helper ----

test("the native estop helper refuses, and opens no TCP socket at all", async () => {
  const tcp = watchTcp();
  try {
    await assert.rejects(ff.estop(nativeP()), /not available|isn't available/i,
      "M112 is accepted and ignored by this firmware — sending it teaches the operator a lie");
    assert.equal(tcp.attempts.length, 0,
      "no point opening 8899 for a command the printer will acknowledge and discard");
  } finally { tcp.restore(); }
});

test("the raw TCP control helper is retained, not deleted", () => {
  // The protocol knowledge (M601 acquires a connection-scoped control session)
  // is hard-won and is the only known raw-gcode path into these printers. It
  // stays available for a future VERIFIED stop; it just isn't wired to estop.
  assert.equal(typeof ff._internal.sendTcpSequence, "function");
});

// ---- the connectors ----

for (const [label, conn] of [["adventurer", adv], ["ad5x", ad5x]]) {
  test(`${label}: a native e-stop fails loudly instead of reporting success`, async () => {
    const tcp = watchTcp(); const f = watchFetch();
    try {
      await assert.rejects(conn.estop(nativeP()), /not available|isn't available/i);
      assert.equal(tcp.attempts.length, 0, "native must not send M112");
    } finally { tcp.restore(); f.restore(); }
  });

  test(`${label}: a native e-stop STILL tries Moonraker, so a misdetected ZMOD is not swallowed`, async () => {
    const tcp = watchTcp(); const f = watchFetch({ moonrakerWorks: true });
    try {
      // Detected native, but the machine really is running Klipper. The
      // cross-transport retry must still find it.
      await conn.estop(nativeP());
      assert.ok(f.urls.some(u => u.includes("/printer/emergency_stop")),
        "the fallback is the whole reason the retry exists: " + JSON.stringify(f.urls));
      assert.equal(tcp.attempts.length, 0);
    } finally { tcp.restore(); f.restore(); }
  });

  test(`${label}: a Moonraker e-stop performs a real Klipper halt`, async () => {
    const f = watchFetch({ moonrakerWorks: true });
    try {
      await conn.estop(moonP());
      assert.ok(f.urls.some(u => u.includes("/printer/emergency_stop")),
        "ZMOD keeps a genuine emergency stop: " + JSON.stringify(f.urls));
    } finally { f.restore(); }
  });
}

// ---- everyone else is untouched ----

test("connectors with a working e-stop do not acquire the false flag", () => {
  const u1 = require("../../connectors/snapmaker-u1-klipper");
  const creality = require("../../connectors/creality-klipper");
  // They simply don't declare it, and the UI gate is `estop !== false`, so
  // nothing about their E-Stop button changes.
  assert.notEqual(u1.capabilities.estop, false);
  assert.notEqual(creality.capabilities.estop, false);
});

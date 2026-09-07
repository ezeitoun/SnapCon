// test/connectors/klipperHealthPrecedence.test.js — machine health beats job
// state in every Klipper-family connector (docs/TODO.md item 9b).
//
// The bug: none of the connectors queried Klippy's `webhooks` object, so a
// printer whose Klipper had shut down reported online:true with whatever
// print_stats happened to be frozen at. Confirmed live on a SPARKX i7 sitting
// in webhooks.state "shutdown" with a real state_message while SnapCon showed
// it idle. Downstream that meant isPrinterIdle() would dispatch a queued job
// onto a crashed machine and firmwareDeployBlockedBy() would flash one.
//
// The payloads below deliberately pair a shutdown with a CONVINCING stale job:
// print_stats says "printing", virtual_sdcard says is_active with real
// progress, and there is a filename. That combination is the actual failure
// mode -- Klipper freezes those fields rather than clearing them -- and every
// connector must still report state:"error".
//
// Stale metadata is deliberately PRESERVED on the payload (filename, progress,
// elapsed). It is diagnostic, and suppressing the active-print UI is the
// frontend's job, driven by message/errorCode -- not something the connector
// achieves by destroying data.
const test = require("node:test");
const assert = require("node:assert/strict");

const creality = require("../../connectors/creality-klipper");
const moonraker = require("../../connectors/klipper-moonraker");
const u1 = require("../../connectors/snapmaker-u1-klipper");

const SHUTDOWN_MSG = "Internal error on command:G1\nOnce the underlying issue is corrected, use the FIRMWARE_RESTART command to reset the firmware.";

// A stale-but-plausible job frozen underneath a dead Klipper.
function shutdownStatus() {
  return {
    webhooks: { state: "shutdown", state_message: SHUTDOWN_MSG },
    print_stats: { state: "printing", filename: "Beardie (7h35m).gcode", print_duration: 4210, filament_used: 12345, message: "" },
    display_status: { progress: 0.42 },
    virtual_sdcard: { is_active: true, progress: 0.42 },
    heater_bed: { temperature: 60, target: 60 },
    extruder: { temperature: 215, target: 215 },
    toolhead: { extruder: "extruder" },
    fan: { speed: 1 },
    gcode_move: { speed_factor: 1 }
  };
}
function healthyStatus() {
  const st = shutdownStatus();
  st.webhooks = { state: "ready", state_message: "Printer is ready" };
  return st;
}

// Records every URL fetched so the query-string assertions below are real
// rather than assumed, and answers only the objects/query call.
function mockFetch(status, urls) {
  return async (url) => {
    urls.push(String(url));
    if (String(url).includes("/printer/objects/query")) {
      return { ok: true, status: 200, json: async () => ({ result: { status } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
async function probeWith(conn, p, status) {
  const urls = [];
  const real = global.fetch;
  global.fetch = mockFetch(status, urls);
  try { return { st: await conn.probe(p), urls }; }
  finally { global.fetch = real; }
}

const CASES = [
  ["creality-klipper", creality, { name: "i7", url: "http://192.168.4.240:7125" }],
  ["klipper-moonraker", moonraker, { name: "Generic", url: "http://192.168.4.99:7125" }],
  ["snapmaker-u1-klipper", u1, { name: "U1 Black", url: "http://192.168.4.191" }]
];

for (const [label, conn, printer] of CASES) {
  test(`${label}: asks for the webhooks object in its existing query`, async () => {
    const { urls } = await probeWith(conn, printer, healthyStatus());
    const q = urls.find(u => u.includes("/printer/objects/query"));
    assert.ok(q, "probe must still issue exactly one objects/query");
    assert.match(q, /[?&]webhooks(&|$)/, "webhooks must ride the existing query — no extra request");
  });

  test(`${label}: a Klipper shutdown reports error, not the stale "printing"`, async () => {
    const { st } = await probeWith(conn, printer, shutdownStatus());
    assert.equal(st.online, true, "Moonraker answered — reachability is a separate fact from health");
    assert.equal(st.state, "error", "health must win over a frozen print_stats");
    assert.equal(st.errorCode, "KLIPPER_SHUTDOWN");
    assert.match(st.message, /FIRMWARE_RESTART/, "Klipper's own diagnostic text must survive");
  });

  test(`${label}: stale job metadata is preserved for diagnostics`, async () => {
    const { st } = await probeWith(conn, printer, shutdownStatus());
    assert.equal(st.filename, "Beardie (7h35m).gcode",
      "the connector must not destroy data — the UI decides what to render");
    assert.equal(st.progress, 0.42);
  });

  test(`${label}: a healthy printer is completely unaffected`, async () => {
    const { st } = await probeWith(conn, printer, healthyStatus());
    assert.equal(st.state, "printing");
    assert.equal(st.errorCode || "", "", "state_message on a healthy machine must never become an errorCode");
    assert.equal(st.message || "", "", "…nor a message, which would blank the card's whole progress block");
  });
}

// Creality-specific: its standby+is_active override (which promotes a
// mid-START_PRINT standby to "printing") must sit UNDER the health check, or a
// shutdown during START_PRINT would be reported as an active print.
test("creality-klipper: the sdActive override never outranks a shutdown", async () => {
  const status = shutdownStatus();
  status.print_stats.state = "standby";
  status.virtual_sdcard.is_active = true;
  const { st } = await probeWith(creality, { name: "i7", url: "http://192.168.4.240:7125" }, status);
  assert.equal(st.state, "error",
    "standby+is_active would otherwise be promoted to 'printing' on a dead machine");
});

// The U1 decodes its own structured Snapmaker fault from print_stats.exception.
// A real printer-reported code is more specific than our generic one, so it
// must not be overwritten.
test("snapmaker-u1-klipper: a real Snapmaker error code outranks the generic Klipper one", async () => {
  const status = shutdownStatus();
  status.print_stats.exception = { level: 3, id: 522, index: 0, code: 2, message: "System Anomaly" };
  const { st } = await probeWith(u1, { name: "U1 Black", url: "http://192.168.4.191" }, status);
  assert.equal(st.state, "error", "still an error either way");
  assert.equal(st.errorCode, "0003-0522-0000-0002",
    "the printer's own specific code is better diagnostics than KLIPPER_SHUTDOWN");
});

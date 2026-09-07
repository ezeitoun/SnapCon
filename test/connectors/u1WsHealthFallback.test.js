// test/connectors/u1WsHealthFallback.test.js — the U1 WebSocket connector's
// half of docs/TODO.md item 9b.
//
// This connector is the PRIMARY status path for every U1 (15 of them here), so
// fixing only the three HTTP connectors would have left the machines we care
// about most still reporting a cached "standby" through a Klipper shutdown.
//
// Two independent mechanisms, deliberately:
//
//  1. `webhooks` joins the subscription, so normalizeU1State() runs the same
//     shared klipperFault() rule as every other Klipper connector. Verified
//     live 2026-09-07: printer.objects.subscribe with webhooks:null returns it
//     in the baseline on a real U1.
//
//  2. Moonraker's notify_klippy_shutdown / notify_klippy_disconnected mark the
//     cached subscription state untrustworthy, so isHealthy() fails and probe()
//     falls through to the HTTP base connector. This exists because whether
//     Moonraker pushes a `webhooks` status DELTA at the moment Klippy dies
//     could not be verified without causing a real shutdown -- so the safety
//     property does not depend on it.
//
// Note what (2) deliberately does NOT do: it never synthesizes an error state
// from the notification itself. It only invalidates the cache. The HTTP probe
// is then authoritative, and normalization happens in exactly one place. That
// also preserves the distinction between a shutdown (Moonraker still answers →
// online:true, state:"error") and Klippy being disconnected (the query itself
// fails → the existing online:false path), rather than forcing either outcome.
const test = require("node:test");
const assert = require("node:assert/strict");
const ws = require("../../connectors/snapmaker-u1-klipper-ws");
const { normalizeU1State, OBJECTS, handleMessage, isHealthy, newConn } = ws._internal;

const P = { id: "u1-black", name: "U1 Black", url: "http://192.168.4.191" };

function healthyConn() {
  const c = newConn(P);
  c.connectionState = "ready";
  c.haveBaseline = true;
  c.lastHeartbeatAt = Date.now();
  c.ws = { sent: [], send(s) { this.sent.push(JSON.parse(s)); } };
  return c;
}
const notify = (c, method) => handleMessage(P, c, { data: JSON.stringify({ jsonrpc: "2.0", method, params: [] }) });

test("webhooks is part of the subscription, or the WS path can never see a fault", () => {
  assert.ok(Object.prototype.hasOwnProperty.call(OBJECTS, "webhooks"),
    "verified live: printer.objects.subscribe returns webhooks in its baseline");
});

test("normalizeU1State reports a shutdown as error, over a stale printing job", () => {
  const st = normalizeU1State(P, {
    webhooks: { state: "shutdown", state_message: "Lost communication with MCU 'mcu'" },
    print_stats: { state: "printing", filename: "Beardie (7h35m).gcode", print_duration: 900 },
    virtual_sdcard: { is_active: true, progress: 0.5 },
    display_status: { progress: 0.5 }
  });
  assert.equal(st.online, true);
  assert.equal(st.state, "error");
  assert.equal(st.errorCode, "KLIPPER_SHUTDOWN");
  assert.match(st.message, /Lost communication/);
  assert.equal(st.filename, "Beardie (7h35m).gcode", "stale metadata kept for diagnostics");
});

test("normalizeU1State leaves a healthy printer alone", () => {
  const st = normalizeU1State(P, {
    webhooks: { state: "ready", state_message: "Printer is ready" },
    print_stats: { state: "printing", filename: "a.gcode" },
    virtual_sdcard: { progress: 0.1 }
  });
  assert.equal(st.state, "printing");
  assert.equal(st.errorCode || "", "", "'Printer is ready' must never surface as a fault");
  assert.equal(st.message || "", "");
});

test("notify_klippy_shutdown makes the cached WS state untrustworthy", () => {
  const c = healthyConn();
  assert.equal(isHealthy(c), true, "precondition: this connection was serving cached state");
  notify(c, "notify_klippy_shutdown");
  assert.equal(isHealthy(c), false,
    "probe() must now fall through to the HTTP base connector for a fresh read");
});

test("notify_klippy_disconnected does the same", () => {
  const c = healthyConn();
  notify(c, "notify_klippy_disconnected");
  assert.equal(isHealthy(c), false);
});

test("invalidation does not invent a printer state of its own", () => {
  const c = healthyConn();
  c.rawState = { print_stats: { state: "printing" } };
  notify(c, "notify_klippy_shutdown");
  assert.deepEqual(c.rawState, { print_stats: { state: "printing" } },
    "the notification is evidence the cache is stale, not evidence of what the printer now is — "
    + "the HTTP probe and klipperFault() decide that");
});

test("notify_klippy_ready re-subscribes, so the WS path can actually recover", () => {
  const c = healthyConn();
  notify(c, "notify_klippy_shutdown");
  c.ws.sent.length = 0;
  notify(c, "notify_klippy_ready");
  const sub = c.ws.sent.find(m => m.method === "printer.objects.subscribe");
  assert.ok(sub, "Moonraker drops object subscriptions across a Klippy restart — "
    + "without re-subscribing this connector would sit in HTTP fallback forever");
  assert.ok(Object.prototype.hasOwnProperty.call(sub.params.objects, "webhooks"));
});

test("an ordinary status delta still merges — no regression", () => {
  const c = healthyConn();
  c.rawState = { print_stats: { state: "standby", filename: "" } };
  handleMessage(P, c, { data: JSON.stringify({
    jsonrpc: "2.0", method: "notify_status_update", params: [{ print_stats: { state: "printing" } }]
  }) });
  assert.equal(c.rawState.print_stats.state, "printing");
  assert.equal(isHealthy(c), true, "a normal delta must not invalidate anything");
});

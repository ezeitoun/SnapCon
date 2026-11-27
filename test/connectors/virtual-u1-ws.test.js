// test/connectors/virtual-u1-ws.test.js — the U1 WebSocket connector
// (connectors/snapmaker-u1-klipper-ws.js, the one every real U1 uses) against
// the virtual U1, over a real WebSocket: subscribe, status deltas, Klippy
// notifications, and the fall back to HTTP and recovery from it.
//
// The simulator listens on a test port, and the connector reaches it there:
// its WebSocket address keeps the printer's port (http.websocketUrl).
const test = require("node:test");
const assert = require("node:assert/strict");
const ws = require("../../connectors/snapmaker-u1-klipper-ws");
const base = require("../../connectors/snapmaker-u1-klipper");
const { startVirtualU1 } = require("../../fixtures/virtual-u1");

let nextId = 0;
async function virtualU1(t, opts) {
  const u1 = await startVirtualU1(opts);
  t.after(() => u1.close());
  // A fresh printer id per test: the connector keeps one connection per id.
  return { u1, p: { id: "virtual-ws-" + (++nextId), name: "Virtual U1", url: u1.url } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const queries = u1 => u1.server.requests.filter(r => r.startsWith("GET /printer/objects/query")).length;

// The first probe() opens the socket after a random start delay of up to 2s;
// wait until the subscription is serving status from its cache.
async function untilSubscribed(u1, p, ms = 8000) {
  await ws.probe(p);
  const end = Date.now() + ms;
  for (;;) {
    const before = queries(u1);
    await ws.probe(p);
    if (queries(u1) === before) return;
    if (Date.now() > end) throw new Error("WebSocket subscription never became healthy");
    await sleep(100);
  }
}

// Let a delta cross the socket.
const settle = () => sleep(50);

test("subscribes with the same objects as the HTTP probe, then serves status without HTTP", async t => {
  const { u1, p } = await virtualU1(t);
  await untilSubscribed(u1, p);
  assert.ok(u1.server.rpcLog.includes("printer.objects.subscribe"));
  const before = queries(u1);
  for (let i = 0; i < 5; i++) await ws.probe(p);
  assert.equal(queries(u1), before, "no HTTP status query while the socket is healthy");
});

test("the WebSocket and HTTP paths agree on the same printer state", async t => {
  const { u1, p } = await virtualU1(t);
  await untilSubscribed(u1, p);
  u1.model.addFile("Parity.gcode", { tools: [0, 2], layers: 4, secondsPerLayer: 40 });
  await base.applyHeadMapping(p, [0, 2], { 0: 1, 2: 3 }, {});
  await base.startPrintFile(p, "Parity.gcode");
  for (const step of [0, 30, 45, 60]) {
    u1.model.advance(step);
    await settle();
    assert.deepEqual(await ws.probe(p), await base.probe(p), `after +${step}s`);
  }
});

test("deltas carry a print forward: layers, progress and tool changes, all without HTTP", async t => {
  const { u1, p } = await virtualU1(t);
  await untilSubscribed(u1, p);
  await base.applyHeadMapping(p, [0, 1, 2, 3], { 0: 3, 1: 2, 2: 1, 3: 0 }, {});
  await base.startPrintFile(p, "Virtual dragon (4 colours).gcode");
  await settle();
  const before = queries(u1);
  const heads = new Set();
  let lastProgress = -1;
  for (let i = 0; i < 40; i++) {
    u1.model.advance(15);
    await settle();
    const st = await ws.probe(p);
    assert.equal(st.state, "printing");
    assert.ok(st.progress >= lastProgress, "progress never goes backwards");
    lastProgress = st.progress;
    heads.add(st.activeExt);
  }
  assert.deepEqual([...heads].sort(), [0, 1, 2, 3], "all four heads were picked in turn");
  assert.equal(queries(u1), before, "every one of those reads came from deltas");
});

test("a Klippy shutdown sends probe() to HTTP, which reports it; Klippy ready re-subscribes", async t => {
  const { u1, p } = await virtualU1(t);
  await untilSubscribed(u1, p);
  u1.server.klippyShutdown("Lost communication with MCU 'mcu e2'");
  await settle();
  const st = await ws.probe(p);
  assert.equal(st.state, "error");
  assert.equal(st.errorCode, "KLIPPER_SHUTDOWN");
  assert.match(st.message, /mcu e2/);

  const subscribes = u1.server.rpcLog.filter(m => m === "printer.objects.subscribe").length;
  u1.server.klippyReady();
  await settle();
  assert.equal(u1.server.rpcLog.filter(m => m === "printer.objects.subscribe").length, subscribes + 1, "re-subscribed on notify_klippy_ready");
  await untilSubscribed(u1, p);
  assert.equal((await ws.probe(p)).state, "standby");
});

test("Klippy disconnected: falls back to HTTP and reads offline, never a stale 'ready'", async t => {
  const { u1, p } = await virtualU1(t);
  await untilSubscribed(u1, p);
  u1.server.klippyDisconnect();
  await settle();
  const st = await ws.probe(p);
  assert.equal(st.online, false);
  assert.equal(st.error, "HTTP 503");
  u1.server.klippyReady();
  await settle();
  await untilSubscribed(u1, p);
  assert.equal((await ws.probe(p)).online, true);
});

test("the printer dropping off the network: HTTP fallback reads offline; it reconnects when back", async t => {
  const { u1, p } = await virtualU1(t);
  await untilSubscribed(u1, p);
  await u1.server.offline();
  await settle();
  assert.equal((await ws.probe(p)).online, false);
  await u1.server.online();
  // Reconnect backoff starts at 1s (plus jitter).
  await untilSubscribed(u1, p, 10000);
  assert.equal((await ws.probe(p)).online, true);
});

test("a subscribe that is never answered leaves the connector on HTTP", async t => {
  const { u1, p } = await virtualU1(t);
  u1.server.faults.rpcSilent = true;
  await ws.probe(p);
  await sleep(2500); // past the connect delay; the 5s subscribe timeout is still running
  const before = queries(u1);
  const st = await ws.probe(p);
  assert.equal(st.online, true);
  assert.equal(queries(u1), before + 1, "served by an HTTP query, not an unconfirmed cache");
});

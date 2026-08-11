// test/connectors/snapmaker-u1-klipper-ws.test.js — the experimental U1
// connector's own behavior: WebSocket baseline/delta merging, HTTP fallback,
// staleness, reconnection, and dedup. Uses node:test's built-in mock timers
// so backoff/heartbeat/jitter don't cost real wall-clock time, and a small
// FakeWebSocket standing in for the native WebSocket global.
const test = require("node:test");
const assert = require("node:assert/strict");
const conn = require("../../connectors/snapmaker-u1-klipper-ws");

// ---- fake transports ----
function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}
function mockQueryResponse(status) {
  return async () => ({ ok: true, status: 200, json: async () => ({ result: { status } }) });
}
function fetchShouldNotBeCalled() {
  return async () => { throw new Error("HTTP fallback used when the WebSocket should have served the cache"); };
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    FakeWebSocket.created.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose({}); }
  open() { this.readyState = 1; this.onopen && this.onopen({}); }
  message(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
  lastRpc(method) { const m = this.sent.filter(s => s.method === method); return m[m.length - 1]; }
  respond(method, result) { const req = this.lastRpc(method); this.message({ jsonrpc: "2.0", result, id: req.id }); }
  notify(delta) { this.message({ jsonrpc: "2.0", method: "notify_status_update", params: [delta, Date.now() / 1000] }); }
}
FakeWebSocket.created = [];

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function withFakeWs(fn) {
  const real = global.WebSocket;
  FakeWebSocket.created = [];
  global.WebSocket = FakeWebSocket;
  return Promise.resolve(fn()).finally(() => { global.WebSocket = real; });
}

let nextId = 1;
function printer(overrides) { return { id: "p_" + (nextId++), name: "Test U1", url: "http://10.0.0." + nextId, ...overrides }; }

// Several tests run more than one printer's connection lifecycle in the same
// mock-timers tick window, where pending jittered connect timers can fire out
// of registration order — "the last socket created" isn't reliably "this
// printer's socket". Match by hostname instead.
function wsFor(p) {
  const host = new URL(p.url).hostname;
  const matches = FakeWebSocket.created.filter(w => w.url.includes("//" + host + "/"));
  return matches[matches.length - 1];
}

// First probe() always happens before the (jittered) WS connect has even
// started, so it necessarily goes over HTTP — this brings a printer's
// connection all the way to "ready" and returns its FakeWebSocket.
async function bringToReady(t, p, baselineStatus) {
  await withMockFetch(mockQueryResponse(baselineStatus), () => conn.probe(p));
  t.mock.timers.tick(2000); // covers STARTUP_JITTER_MS
  await flush();
  const ws = wsFor(p);
  ws.open();
  await flush();
  ws.respond("printer.objects.subscribe", { status: baselineStatus });
  await flush();
  return ws;
}

test("probe(): before the WebSocket connects, falls back to HTTP", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    const status = { print_stats: { state: "printing", filename: "a.gcode" } };
    const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(p));
    assert.equal(result.online, true);
    assert.equal(result.state, "printing");
    assert.equal(result.filename, "a.gcode");
  });
});

test("probe(): once the WebSocket has a baseline, serves it from cache without touching HTTP", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    const baseline = { print_stats: { state: "printing", filename: "cached.gcode" }, heater_bed: { temperature: 60, target: 60 } };
    await bringToReady(t, p, baseline);
    const result = await withMockFetch(fetchShouldNotBeCalled(), () => conn.probe(p));
    assert.equal(result.filename, "cached.gcode");
    assert.deepEqual(result.bed, { temp: 60, target: 60 });
  });
});

test("delta merge: a partial notify_status_update only changes the fields it names, others survive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    const baseline = {
      print_stats: { state: "printing", filename: "keep-me.gcode" },
      heater_bed: { temperature: 60, target: 60 },
      extruder2: { temperature: 219, target: 220 },
      virtual_sdcard: { progress: 0.1 }
    };
    const ws = await bringToReady(t, p, baseline);
    ws.notify({ virtual_sdcard: { progress: 0.52 } }); // only progress changes
    await flush();
    const result = await withMockFetch(fetchShouldNotBeCalled(), () => conn.probe(p));
    assert.equal(result.progress, 0.52);
    assert.equal(result.filename, "keep-me.gcode"); // untouched by the delta
    assert.deepEqual(result.bed, { temp: 60, target: 60 }); // untouched
    assert.deepEqual(result.hotend, { temp: 219, target: 220 }); // untouched
  });
});

test("delta merge: a field within an object is replaced wholesale, not deep-merged into a stale partial", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    const baseline = { heater_bed: { temperature: 60, target: 60 } };
    const ws = await bringToReady(t, p, baseline);
    ws.notify({ heater_bed: { temperature: 61 } }); // target omitted — must be preserved, not dropped
    await flush();
    const result = await conn.probe(p);
    assert.deepEqual(result.bed, { temp: 61, target: 60 });
  });
});

test("WebSocket disconnect falls back to HTTP again until it reconnects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    const ws = await bringToReady(t, p, { print_stats: { state: "printing" } });
    ws.close();
    await flush();
    const status = { print_stats: { state: "paused" } };
    const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(p));
    assert.equal(result.state, "paused");
  });
});

test("reconnect requires a fresh baseline — a delta arriving before re-subscribing is not trusted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    await bringToReady(t, p, { print_stats: { state: "printing" } });
    // Simulate an unexpected close, then advance through reconnect backoff.
    FakeWebSocket.created[FakeWebSocket.created.length - 1].close();
    await flush();
    t.mock.timers.tick(2000); // covers first backoff step
    await flush();
    const ws2 = wsFor(p);
    assert.notEqual(ws2, undefined);
    ws2.open();
    await flush();
    // A notification arriving before the subscribe response comes back —
    // probe() must still not trust WS state (no baseline yet this round).
    ws2.notify({ print_stats: { state: "printing" } });
    await flush();
    const midResult = await withMockFetch(mockQueryResponse({ print_stats: { state: "http-fallback" } }), () => conn.probe(p));
    assert.equal(midResult.state, "http-fallback");
    // Now the fresh baseline lands — WS is trusted again.
    ws2.respond("printer.objects.subscribe", { status: { print_stats: { state: "printing-again" } } });
    await flush();
    const result = await withMockFetch(fetchShouldNotBeCalled(), () => conn.probe(p));
    assert.equal(result.state, "printing-again");
  });
});

test("no duplicate sockets: overlapping probe() calls before the connect fires only ever open one WebSocket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    const status = { print_stats: { state: "standby" } };
    await withMockFetch(mockQueryResponse(status), () =>
      Promise.all([conn.probe(p), conn.probe(p), conn.probe(p)])
    );
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(FakeWebSocket.created.length, 1);
  });
});

test("heartbeat keeps an idle printer healthy — no false 'stale' fallback just because nothing changed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    const baseline = { print_stats: { state: "standby" } };
    const ws = await bringToReady(t, p, baseline);
    // Advance well past what a naive "time since last delta" rule would call
    // stale, answering every heartbeat along the way — nothing else changes.
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(25000); // HEARTBEAT_INTERVAL_MS
      await flush();
      const req = ws.lastRpc("server.info");
      if (req) ws.respond("server.info", {});
      await flush();
    }
    const result = await withMockFetch(fetchShouldNotBeCalled(), () => conn.probe(p));
    assert.equal(result.state, "standby");
  });
});

test("repeated heartbeat misses force a reconnect and HTTP fallback in the meantime", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const p = printer();
    await bringToReady(t, p, { print_stats: { state: "printing" } });
    // Never respond to heartbeats — each one times out (HEARTBEAT_TIMEOUT_MS)
    // and counts as a miss; HEARTBEAT_MAX_MISSES of them closes the socket.
    t.mock.timers.tick(25000); await flush();
    t.mock.timers.tick(8000); await flush(); // heartbeat #1 times out
    t.mock.timers.tick(25000); await flush();
    t.mock.timers.tick(8000); await flush(); // heartbeat #2 times out -> socket closed
    const status = { print_stats: { state: "unresponsive-fallback" } };
    const result = await withMockFetch(mockQueryResponse(status), () => conn.probe(p));
    assert.equal(result.state, "unresponsive-fallback");
  });
});

test("two printers get independent connections and rawState never crosses between them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWs(async () => {
    const pA = printer({ name: "Printer A" });
    const pB = printer({ name: "Printer B" });
    await bringToReady(t, pA, { print_stats: { state: "printing", filename: "a.gcode" } });
    await bringToReady(t, pB, { print_stats: { state: "paused", filename: "b.gcode" } });
    assert.equal(FakeWebSocket.created.length, 2);
    const resultA = await withMockFetch(fetchShouldNotBeCalled(), () => conn.probe(pA));
    const resultB = await withMockFetch(fetchShouldNotBeCalled(), () => conn.probe(pB));
    assert.equal(resultA.filename, "a.gcode");
    assert.equal(resultA.state, "printing");
    assert.equal(resultB.filename, "b.gcode");
    assert.equal(resultB.state, "paused");
  });
});

test("HTTP and WebSocket paths normalize the same raw status identically", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const status = {
    print_task_config: { filament_exist: [true, false, true, false], filament_color_rgba: ["112233FF", null, "445566FF", null], filament_type: ["PLA", null, "PETG", null], filament_sub_type: [null, null, "SILK", null], filament_official: [true, false, false, false] },
    print_stats: { state: "printing", filename: "equal.gcode", print_duration: 100, filament_used: 50, info: { current_layer: 3, total_layer: 10 } },
    virtual_sdcard: { progress: 0.3 },
    heater_bed: { temperature: 60, target: 60 },
    extruder1: { temperature: 210, target: 210 },
    toolhead: { extruder: "extruder1" },
    fan: { speed: 0.5 },
    gcode_move: { speed_factor: 1 },
    exclude_object: { objects: [{ name: "x" }], excluded_objects: [], current_object: "x" }
  };
  await withFakeWs(async () => {
    const p = printer();
    const httpResult = await withMockFetch(mockQueryResponse(status), () => conn.probe(p));
    const p2 = printer();
    await bringToReady(t, p2, status);
    const wsProbe = await withMockFetch(fetchShouldNotBeCalled(), () => conn.probe(p2));
    // Names differ (different printer objects) — everything else must match exactly.
    const { name: _n1, ...httpRest } = httpResult;
    const { name: _n2, ...wsRest } = wsProbe;
    assert.deepEqual(httpRest, wsRest);
  });
});

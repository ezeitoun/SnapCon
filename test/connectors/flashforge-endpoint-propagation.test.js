// test/connectors/flashforge-endpoint-propagation.test.js — no split brain.
//
// A legacy Auto printer stored as ":8898" must detect Moonraker on :7125 AND
// then use :7125 for every subsequent operation. The failure mode guarded
// against is subtle: detection succeeds, the printer reads online, and then
// pause/cancel/files/camera silently reconstruct the stored :8898 and fail.
//
// This binds the real conventional ports on loopback so the legacy shape is
// reproduced exactly, with no test-only hooks in production code. If either
// port is already in use on this machine the test skips rather than lying.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mode = require("../../connectors/flashforge-mode");
const fm = require("../../connectors/flashforge-moonraker");
const ad5x = require("../../connectors/flashforge-ad5x");
const adv = require("../../connectors/flashforge-adventurer");

const json = (res, b) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };

function listen(srv, port) {
  return new Promise(res => {
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => res(true));
  });
}

async function legacyPrinter() {
  const seen = { moonraker: [], native: [] };
  const moon = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); seen.moonraker.push(req.method + " " + u.pathname);
    if (u.pathname === "/printer/info") return json(res, { result: { state: "ready" } });
    if (u.pathname === "/server/webcams/list") return json(res, { result: { webcams: [] } });
    if (u.pathname === "/printer/objects/list") return json(res, { result: { objects: ["print_stats", "virtual_sdcard", "toolhead"] } });
    if (u.pathname === "/printer/gcode/script") return json(res, { result: "ok" });
    if (u.pathname === "/printer/print/pause" || u.pathname === "/printer/print/cancel") return json(res, { result: "ok" });
    if (u.pathname === "/server/files/list") return json(res, { result: [] });
    if (u.pathname === "/printer/objects/query") return json(res, { result: { eventtime: 1, status: {
      print_stats: { state: "standby", info: {} }, virtual_sdcard: {}, heater_bed: {}, extruder: {}, toolhead: {}, exclude_object: { objects: [] } } } });
    res.statusCode = 404; res.end();
  });
  // Stands in for the dead native API on a modded printer: reachable but not
  // FlashForge. Any hit here after detection is a split brain.
  const native = http.createServer((req, res) => { seen.native.push(req.method + " " + req.url); res.statusCode = 404; res.end(); });
  if (!await listen(moon, 7125)) return null;
  if (!await listen(native, 8898)) { moon.close(); return null; }
  return { seen, close: () => { moon.close(); native.close(); } };
}

// One server pair for both connectors: rebinding 7125/8898 between tests races
// with TIME_WAIT on some platforms, and the thing under test is the connector,
// not the socket.
test("a legacy :8898 config detects Moonraker and never falls back to the stored port", async t => {
  const s = await legacyPrinter();
  if (!s) return t.skip("ports 7125/8898 unavailable on this machine");
  try {
    for (const [label, conn] of [["ad5x", ad5x], ["adventurer", adv]]) {
      mode._resetAll(); fm._resetCaches();
      s.seen.moonraker.length = 0; s.seen.native.length = 0;

      // Exactly what the buggy Add Printer flow persisted.
      const p = { id: "prop_" + label, name: "FF", url: "http://127.0.0.1:8898" };

      const r = await conn.probe(p);
      assert.equal(r.online, true, label + ": detection must resolve Moonraker on 7125");
      assert.ok(s.seen.moonraker.length > 0, label + ": Moonraker must have been probed");

      const nativeAfterDetection = s.seen.native.length;
      await conn.pause(p).catch(() => {});
      await conn.cancel(p).catch(() => {});
      await conn.listFiles(p).catch(() => {});
      conn.getCapabilities(p);

      // http-utils implements pause/cancel as gcode macros (PAUSE / CANCEL_PRINT),
      // not the Moonraker print endpoints — assert on the transport, not the shape.
      const scripts = s.seen.moonraker.filter(x => x.includes("/printer/gcode/script")).length;
      assert.ok(scripts >= 2, label + ": pause and cancel must reach Moonraker: " + s.seen.moonraker.join(", "));
      assert.ok(s.seen.moonraker.some(x => x.includes("/server/files/list")),
        label + ": listFiles must reach Moonraker");
      assert.equal(s.seen.native.length, nativeAfterDetection,
        label + ": no post-detection operation may reconstruct the stored :8898");

      // The mode cache keys on p.id and invalidates on a p.url change, so any
      // operation that looks the profile up with a url-REWRITTEN printer would
      // silently delete the entry — forcing a full re-detection on the next poll
      // and destroying the sticky-capabilities guarantee. Operations must hand
      // mode.* the ORIGINAL printer and rewrite only for the transport call.
      assert.ok(mode.getProfile(p), label + ": operations must not wipe the mode cache");
      await conn.getCameraSnapshot(p).catch(() => {});
      assert.ok(mode.getProfile(p), label + ": getCameraSnapshot must not wipe the mode cache");
      await conn.startPrintFile(p, "x.gcode").catch(() => {});
      assert.ok(mode.getProfile(p), label + ": startPrintFile must not wipe the mode cache");
    }
  } finally { s.close(); }
});

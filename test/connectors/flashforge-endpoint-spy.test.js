// test/connectors/flashforge-endpoint-spy.test.js — deterministic companion to
// flashforge-endpoint-propagation.test.js.
//
// That test binds the real 7125/8898 to reproduce the legacy shape end to end,
// but skips if either port is occupied — so on a CI box already running
// Moonraker the coverage would silently evaporate. This one patches
// globalThis.fetch instead: no sockets, no ports, never skips, and it can
// assert the EXACT url of every request rather than just which listener saw it.
//
// No production hooks: the only thing touched is the global fetch, restored in
// a finally block.
const test = require("node:test");
const assert = require("node:assert/strict");
const mode = require("../../connectors/flashforge-mode");
const fm = require("../../connectors/flashforge-moonraker");
const ad5x = require("../../connectors/flashforge-ad5x");
const adv = require("../../connectors/flashforge-adventurer");

const HOST = "192.0.2.10";
const LEGACY_URL = `http://${HOST}:8898`;   // exactly what the buggy Add Printer flow persisted
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

const json = b => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

// A modded printer: native 8898 is dead, Moonraker answers on 7125, and a
// camera proxy sits on the printer's plain web port (the usual ZMOD layout).
function respond(url) {
  const u = new URL(url);
  if (u.port === "8898") return new Response("", { status: 502 });      // stock API is down
  if (u.port === "7125") {
    if (u.pathname === "/printer/info") return json({ result: { state: "ready" } });
    if (u.pathname === "/server/webcams/list")
      return json({ result: { webcams: [{ name: "cam", enabled: true, snapshot_url: "/webcam/?action=snapshot" }] } });
    if (u.pathname === "/printer/objects/list")
      return json({ result: { objects: ["print_stats", "virtual_sdcard", "toolhead", "exclude_object"] } });
    if (u.pathname === "/printer/objects/query")
      return json({ result: { eventtime: 1, status: {
        print_stats: { state: "standby", info: {} }, virtual_sdcard: {}, heater_bed: {},
        extruder: {}, toolhead: {}, exclude_object: { objects: [] } } } });
    if (u.pathname === "/printer/gcode/script") return json({ result: "ok" });
    if (u.pathname === "/server/files/list") return json({ result: [] });
    if (u.pathname.startsWith("/server/files/config/")) return json({});
    return new Response("", { status: 404 });
  }
  // Camera proxy on the printer's own web port — a legitimate non-7125 target.
  if (!u.port && u.pathname === "/webcam/") return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response("", { status: 404 });
}

function installSpy() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url || input);
    calls.push({ url, method: String(init.method || "GET").toUpperCase() });
    try { return respond(url); } catch { return new Response("", { status: 404 }); }
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

for (const [label, conn] of [["ad5x", ad5x], ["adventurer", adv]]) {
  test(`${label}: after Auto resolves a legacy :8898 config, operations use :7125 and never :8898`, async () => {
    mode._resetAll(); fm._resetCaches();
    const spy = installSpy();
    try {
      const p = { id: "spy_" + label, name: "FF", url: LEGACY_URL };

      const r = await conn.probe(p);
      assert.equal(r.online, true, "Auto must resolve Moonraker on 7125");
      assert.equal(mode.getProfile(p).transport, "moonraker");

      // Detection is allowed to try 8898 — that is how it learns the stock API
      // is down. Everything AFTER detection must not.
      const afterDetection = spy.calls.length;

      await conn.pause(p).catch(() => {});
      await conn.cancel(p).catch(() => {});
      await conn.listFiles(p).catch(() => {});

      const post = spy.calls.slice(afterDetection);
      assert.ok(post.length > 0, "operations must have issued requests");
      const strayed = post.filter(c => new URL(c.url).port === "8898");
      assert.deepEqual(strayed, [], "no operation may fall back to the stored :8898");
      const onMoonraker = post.filter(c => new URL(c.url).port === "7125");
      assert.equal(onMoonraker.length, post.length,
        "every Moonraker API call must use :7125, saw: " + post.map(c => c.url).join(", "));
    } finally { spy.restore(); }
  });

  test(`${label}: getCameraSnapshot does not erase the cached mode/profile`, async () => {
    // The exact defect: byMode hands its callback a url-REWRITTEN printer, and
    // the mode cache invalidates on a url change, so looking the profile up with
    // that copy deleted the entry.
    mode._resetAll(); fm._resetCaches();
    const spy = installSpy();
    try {
      const p = { id: "spycam_" + label, name: "FF", url: LEGACY_URL };
      await conn.probe(p);
      const before = mode.getProfile(p);
      assert.ok(before, "profile must exist after detection");

      await conn.getCameraSnapshot(p).catch(() => {});

      const after = mode.getProfile(p);
      assert.ok(after, "profile must survive getCameraSnapshot");
      assert.equal(after, before, "the SAME profile object must remain — not a rebuilt one");
      assert.equal(after.transport, "moonraker");
    } finally { spy.restore(); }
  });

  test(`${label}: mode cache identity is the ORIGINAL printer, never the rewritten copy`, async () => {
    mode._resetAll(); fm._resetCaches();
    const spy = installSpy();
    try {
      const p = { id: "spyid_" + label, name: "FF", url: LEGACY_URL };
      await conn.probe(p);
      // The transport-facing copy carries a different url; it must never be the
      // key used for cache access, or every lookup would drop the entry.
      const rewritten = { ...p, url: fm.resolveEndpoint(p, { want: "moonraker", nativePort: "8898", moonrakerPort: "7125" }) };
      assert.notEqual(rewritten.url, p.url, "the rewritten copy must actually differ");
      assert.ok(mode.getProfile(p), "profile is reachable under the original identity");
      // Looking it up under the rewritten copy is what destroyed the entry.
      mode.getProfile(rewritten);
      assert.equal(mode.getProfile(p), undefined,
        "sanity: a rewritten lookup DOES drop the entry — which is why operations must not do it");
    } finally { spy.restore(); }
  });
}

test("adventurer: startPrintFile does not erase the cached mode/profile", async () => {
  // The third affected call site.
  mode._resetAll(); fm._resetCaches();
  const spy = installSpy();
  try {
    const p = { id: "spyprint", name: "FF", url: LEGACY_URL };
    await adv.probe(p);
    const before = mode.getProfile(p);
    assert.ok(before, "profile must exist after detection");

    await adv.startPrintFile(p, "cube.gcode").catch(() => {});

    const after = mode.getProfile(p);
    assert.ok(after, "profile must survive startPrintFile");
    assert.equal(after, before, "the SAME profile object must remain");
    // and the print-start itself went to Moonraker, not the stored 8898
    const strayed = spy.calls.filter(c => new URL(c.url).port === "8898" && c.url.includes("gcode/script"));
    assert.deepEqual(strayed, [], "print-start must not use the stored :8898");
  } finally { spy.restore(); }
});

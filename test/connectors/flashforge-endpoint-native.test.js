// test/connectors/flashforge-endpoint-native.test.js — the native-direction
// counterpart to flashforge-endpoint-spy.test.js.
//
// The Moonraker side was covered first, which let a mirror-image defect
// through: detection resolved native on 8898 while probeNative and the other
// native call sites passed the RAW printer to flashforge-utils, so they
// inherited whatever port was stored. A stock printer with 7125 typed into the
// port field detected as native and then failed every operation with
// "FlashForge HTTP 502".
//
// Same design rule as the Moonraker side: mode/cache calls get the original
// printer identity, transport calls get the endpoint-rewritten printer.
//
// Deterministic — patches globalThis.fetch, binds no ports, never skips.
const test = require("node:test");
const assert = require("node:assert/strict");
const mode = require("../../connectors/flashforge-mode");
const fm = require("../../connectors/flashforge-moonraker");
const ad5x = require("../../connectors/flashforge-ad5x");
const adv = require("../../connectors/flashforge-adventurer");

const HOST = "192.0.2.10";
// Auto mode, but a conventional NON-native port is stored — e.g. the user typed
// 7125 into the port field. Native must still resolve to, and stay on, 8898.
const STORED_URL = "http://" + HOST + ":7125";

const json = b => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

// A STOCK FlashForge printer: the native API answers on 8898, nothing else does.
function respond(url) {
  const u = new URL(url);
  if (u.port !== "8898") return new Response("", { status: 502 });
  const detail = {
    status: "ready", printProgress: 0, platTemp: 20, platTargetTemp: 0, rightTemp: 21, rightTargetTemp: 0,
    hasMatlStation: true,
    matlStationInfo: {
      slotCnt: 4, currentSlot: 1,
      slotInfos: [{ slotId: 1, hasFilament: true, materialColor: "#FF0000", materialName: "PLA" }]
    }
  };
  if (u.pathname === "/detail") return json({ code: 0, detail });
  if (u.pathname === "/control") return json({ code: 0 });
  if (u.pathname === "/printGcode") return json({ code: 0 });
  if (u.pathname === "/gcodeList") return json({ code: 0, gcodeListDetail: [] });
  return json({ code: 0 });
}

function installSpy() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url || input);
    calls.push({ url, method: String(init.method || "GET").toUpperCase() });
    try { return respond(url); } catch { return new Response("", { status: 502 }); }
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const portsOf = calls => [...new Set(calls.map(c => new URL(c.url).port))].sort();

for (const [label, conn] of [["ad5x", ad5x], ["adventurer", adv]]) {
  test(label + ": Auto resolves native on 8898 even though 7125 is stored", async () => {
    mode._resetAll(); fm._resetCaches();
    const spy = installSpy();
    try {
      const p = { id: "nat_" + label, name: "FF", url: STORED_URL };
      const r = await conn.probe(p);
      assert.equal(r.online, true, "a reachable stock printer must not read as offline");
      assert.equal(mode.getProfile(p).transport, "native");
      assert.ok(spy.calls.some(c => new URL(c.url).port === "8898"), "native must have been probed on 8898");
    } finally { spy.restore(); }
  });

  test(label + ": probeNative uses the resolved native endpoint, not the stored 7125", async () => {
    mode._resetAll(); fm._resetCaches();
    const spy = installSpy();
    try {
      const p = { id: "natprobe_" + label, name: "FF", url: STORED_URL };
      await conn.probe(p);
      const detailCalls = spy.calls.filter(c => new URL(c.url).pathname === "/detail");
      assert.ok(detailCalls.length > 0, "the native probe must have run");
      const strayed = detailCalls.filter(c => new URL(c.url).port !== "8898");
      assert.deepEqual(strayed, [], "no /detail may use the stored 7125: " + detailCalls.map(c => c.url).join(", "));
    } finally { spy.restore(); }
  });

  test(label + ": native operations stay on the resolved endpoint", async () => {
    mode._resetAll(); fm._resetCaches();
    const spy = installSpy();
    try {
      const p = { id: "natops_" + label, name: "FF", url: STORED_URL };
      await conn.probe(p);
      const after = spy.calls.length;
      await conn.pause(p).catch(() => {});
      await conn.cancel(p).catch(() => {});
      await conn.bedTemp(p, 60).catch(() => {});
      const post = spy.calls.slice(after);
      assert.ok(post.length > 0, "operations must have issued requests");
      assert.deepEqual(portsOf(post), ["8898"],
        "every native operation must use 8898, saw: " + post.map(c => c.url).join(", "));
    } finally { spy.restore(); }
  });

  test(label + ": native operations do not erase the cached mode/profile", async () => {
    mode._resetAll(); fm._resetCaches();
    const spy = installSpy();
    try {
      const p = { id: "natcache_" + label, name: "FF", url: STORED_URL };
      await conn.probe(p);
      const before = mode.getProfile(p);
      assert.ok(before, "profile must exist after detection");
      await conn.pause(p).catch(() => {});
      await conn.getCameraSnapshot(p).catch(() => {});
      const afterProf = mode.getProfile(p);
      assert.ok(afterProf, "profile must survive native operations");
      assert.equal(afterProf, before, "the SAME profile object must remain");
    } finally { spy.restore(); }
  });
}

test("ad5x: the native print-start path stays on the resolved endpoint", async () => {
  mode._resetAll(); fm._resetCaches();
  const spy = installSpy();
  try {
    const p = { id: "natprint", name: "FF", url: STORED_URL };
    await ad5x.probe(p);
    const after = spy.calls.length;
    await ad5x.startPrintFile(p, "cube.gcode").catch(() => {});
    const post = spy.calls.slice(after);
    assert.ok(post.length > 0, "print-start must have issued requests");
    assert.deepEqual(portsOf(post), ["8898"],
      "gcodeList/detail/printGcode must all use 8898: " + post.map(c => c.url).join(", "));
  } finally { spy.restore(); }
});

test("ad5x: unloadFilament uses the resolved native endpoint", async () => {
  mode._resetAll(); fm._resetCaches();
  const spy = installSpy();
  try {
    const p = { id: "natunload", name: "FF", url: STORED_URL };
    await ad5x.probe(p);
    const after = spy.calls.length;
    await ad5x.unloadFilament(p, [0]).catch(() => {});
    const post = spy.calls.slice(after);
    assert.ok(post.length > 0, "unloadFilament must have issued a request");
    assert.deepEqual(portsOf(post), ["8898"], "ms_cmd must use 8898: " + post.map(c => c.url).join(", "));
  } finally { spy.restore(); }
});

test("ad5x: setFilamentColor reads /detail and writes /control on the resolved endpoint", async () => {
  mode._resetAll(); fm._resetCaches();
  const spy = installSpy();
  try {
    const p = { id: "natcolor", name: "FF", url: STORED_URL };
    await ad5x.probe(p);
    const after = spy.calls.length;
    await ad5x.setFilamentColor(p, 0, "#FF0000").catch(() => {});
    const post = spy.calls.slice(after);
    assert.ok(post.length >= 2, "setFilamentColor reads /detail then writes /control");
    assert.deepEqual(portsOf(post), ["8898"], "both must use 8898: " + post.map(c => c.url).join(", "));
  } finally { spy.restore(); }
});

// ---- the rules that must NOT change ----

test("a genuinely custom port is still authoritative for native in Auto", () => {
  const p = { id: "c1", name: "F", url: "http://" + HOST + ":5000" };
  assert.equal(fm.resolveEndpoint(p, { want: "native", nativePort: "8898", moonrakerPort: "7125" }),
    "http://" + HOST + ":5000");
});

test("a native pin keeps its explicit port, including 7125", () => {
  const p = { id: "c2", name: "F", url: "http://" + HOST + ":7125", transport: "native" };
  assert.equal(fm.resolveEndpoint(p, { want: "native", nativePort: "8898", moonrakerPort: "7125" }),
    "http://" + HOST + ":7125");
});

// test/healthRoute.test.js — GET /api/health always answers (docs/TODO.md §50).
// Before: a connector whose getHealth threw (any offline FlashForge printer,
// and every online stock-firmware AD5X / 5M PRO) left the request open
// forever with an [unhandledRejection] in the log (Express 4 does not catch a
// rejected async handler). Owner's requirements (2026-11-09): offline and
// stock-firmware FlashForge printers get the structured skip; ZMOD keeps its
// Health; connector/helper failures are 502; a deadline is 504; the response
// shape is kept; no stack or internal error reaches the client; one log line
// per failure; late resolution or rejection is harmless; timers are cleaned
// up; the Health page's own request is bounded.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { routeEnd } = require("./helpers/routeEnd");

const ROOT = path.join(__dirname, "..");
const serverSrc = ["server.js", "routes/health.js"].map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const T = (name, fn) => test(name, { timeout: 5000 }, fn);
const tick = () => new Promise(r => setImmediate(r));
// Objects made inside the vm sandbox have that realm's prototypes: compare plain copies.
const plain = o => JSON.parse(JSON.stringify(o));

let unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));
test.afterEach(() => { assert.deepEqual(unhandled, [], "no unhandled promise rejections"); unhandled = []; });

// ---------- the route, run from server.js's own source ----------
const DEADLINE_MS = 40;
function route(over = {}) {
  const start = serverSrc.indexOf("const HEALTH_DEADLINE_MS = 25 * 1000;");
  const at = serverSrc.indexOf('app.get("/api/health", requireAuth', start);
  assert.ok(start > 0 && at > start, "the route and its deadline exist");
  const src = serverSrc.slice(start, serverSrc.indexOf("function registerHealthRoutes", start)).replace("const HEALTH_DEADLINE_MS = 25 * 1000;", `const HEALTH_DEADLINE_MS = ${DEADLINE_MS};`) + serverSrc.slice(at, serverSrc.indexOf("\n  });\n", at) + 6).replace(/^  /gm, "");
  const warns = [], timers = new Set();
  const P = { id: "p_1", name: "AD5X Red", connector: "fake" };
  const conn = { getHealth: async () => ({ online: true, heaters: { available: true } }), querySyncFiles: () => {}, ...over.conn };
  const sandbox = {
    Symbol, Promise,
    app: { get: (p, mw, h) => { sandbox.handler = h; } }, requireAuth: () => {},
    getPrinters: () => [P], printerVisibleTo: () => true, getConnector: () => conn, getConfig: () => ({}),
    probeCached: over.probeCached || (async () => ({ online: true, state: "standby" })),
    annotateHeaterStates: over.annotateHeaterStates || (() => {}),
    annotateGcodeUnusedCount: over.annotateGcodeUnusedCount || (async () => {}),
    computeHealthAttention: over.computeHealthAttention || (() => []),
    console: { warn: m => warns.push(m), log: () => {}, error: () => {} },
    setTimeout: (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; },
    clearTimeout: t => { timers.delete(t); clearTimeout(t); },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const call = async (q = { printer: "0" }) => {
    const res = { code: 200, bodies: [], status(c) { this.code = c; return this; }, json(b) { this.bodies.push(b); return this; } };
    await sandbox.handler({ query: q, user: null }, res);
    return res;
  };
  return { call, warns, timers };
}

T("success: 200 with the same shape as before (id, name, health, attention, sync fields)", async () => {
  const r = route({ computeHealthAttention: () => [{ severity: "warning", title: "Recent fault" }] });
  const res = await r.call();
  assert.equal(res.code, 200); assert.equal(res.bodies.length, 1);
  assert.deepEqual(Object.keys(res.bodies[0]).sort(), ["attentionReasons", "heaters", "id", "name", "needsAttention", "online", "syncFolders", "syncSupported"].sort());
  assert.equal(r.warns.length, 0); assert.equal(r.timers.size, 0, "the deadline timer is cleared");
});

T("unknown printer and 'not supported' answers are unchanged", async () => {
  let res = await route().call({ printer: "9" });
  assert.equal(res.code, 400); assert.deepEqual(plain(res.bodies[0]), { error: "Unknown printer" });
  res = await route({ conn: { getHealth: undefined } }).call();
  assert.equal(res.code, 200); assert.deepEqual(plain(res.bodies[0]), { id: "p_1", name: "AD5X Red", online: true, skipped: true, reason: "not supported" });
});

T("a skip from the connector (offline, stock firmware) is a 200 skip with no attention and no log line", async () => {
  const r = route({ conn: { getHealth: async () => ({ online: false, skipped: true, reason: "fetch failed", reasonCode: "offline" }) } });
  const res = await r.call();
  assert.equal(res.code, 200); assert.equal(res.bodies[0].skipped, true); assert.equal(res.bodies[0].reasonCode, "offline");
  assert.equal(res.bodies[0].needsAttention, undefined); assert.equal(r.warns.length, 0);
});

for (const [what, over] of [
  ["getHealth throws", { conn: { getHealth: async () => { throw new Error("Moonraker 500 at http://192.0.2.9:7125/secret"); } } }],
  ["getHealth throws synchronously", { conn: { getHealth: () => { throw new Error("Moonraker 500 at http://192.0.2.9:7125/secret"); } } }],
  ["probeCached throws", { probeCached: async () => { throw new Error("Moonraker 500 at http://192.0.2.9:7125/secret"); } }],
  ["annotateGcodeUnusedCount throws", { annotateGcodeUnusedCount: async () => { throw new Error("Moonraker 500 at http://192.0.2.9:7125/secret"); } }],
  ["computeHealthAttention throws", { computeHealthAttention: () => { throw new Error("Moonraker 500 at http://192.0.2.9:7125/secret"); } }],
  ["getHealth returns nothing", { conn: { getHealth: async () => undefined } }],
]) {
  T(`${what}: 502 in the skipped shape, a generic reason, one log line with the cause`, async () => {
    const r = route(over);
    const res = await r.call();
    assert.equal(res.code, 502); assert.equal(res.bodies.length, 1);
    assert.deepEqual(plain(res.bodies[0]), { id: "p_1", name: "AD5X Red", skipped: true, reason: "Could not read this printer's health.", reasonCode: "connector_error" });
    assert.doesNotMatch(JSON.stringify(res.bodies[0]), /192\.0\.2|secret|Error|at /, "nothing internal reaches the client");
    assert.equal(r.warns.length, 1); assert.match(r.warns[0], /^\[health\] AD5X Red: could not read health: /);
    assert.equal(r.timers.size, 0);
  });
}

T("never answers: 504 at the deadline, one log line, timer gone", async () => {
  const r = route({ conn: { getHealth: () => new Promise(() => {}) } });
  const t0 = Date.now(); const res = await r.call();
  assert.ok(Date.now() - t0 >= DEADLINE_MS - 5);
  assert.equal(res.code, 504);
  assert.deepEqual(plain(res.bodies[0]), { id: "p_1", name: "AD5X Red", skipped: true, reason: "The printer took too long to report its health.", reasonCode: "timeout" });
  assert.equal(r.warns.length, 1); assert.match(r.warns[0], /no answer within/);
  assert.equal(r.timers.size, 0);
});

T("a late rejection after the 504 is handled: no unhandled rejection, no second log line, no second response", async () => {
  let reject; const r = route({ conn: { getHealth: () => new Promise((_, j) => { reject = j; }) } });
  const res = await r.call();
  assert.equal(res.code, 504);
  reject(new Error("too late")); await tick(); await tick();
  assert.equal(r.warns.length, 1); assert.equal(res.bodies.length, 1);
});

T("a late success after the 504 changes nothing", async () => {
  let resolve; const r = route({ conn: { getHealth: () => new Promise(ok => { resolve = ok; }) } });
  const res = await r.call();
  resolve({ online: true }); await tick(); await tick();
  assert.equal(res.code, 504); assert.equal(res.bodies.length, 1); assert.equal(r.warns.length, 1);
});

T("the deadline is 25 s in server.js, under the Health page's own 30 s limit", () => {
  assert.match(serverSrc, /const HEALTH_DEADLINE_MS = 25 \* 1000;/);
  assert.match(appSrc, /fetch\("\/api\/health\?printer="\+pid,\{signal:AbortSignal\.timeout\(30000\)\}\)/);
});

// ---------- the FlashForge connectors, with a fake network ----------
const http = require("../connectors/http-utils");
const mode = require("../connectors/flashforge-mode");
const fm = require("../connectors/flashforge-moonraker");
const ad5x = require("../connectors/flashforge-ad5x");
const adv = require("../connectors/flashforge-adventurer");
const realFetch = global.fetch;
function spy(respond) {
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(String(url)); return respond(new URL(String(url)), opts); };
  return calls;
}
const json = b => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
test.afterEach(() => { global.fetch = realFetch; mode._resetAll(); fm._resetCaches(); });

for (const [label, conn] of [["AD5X", ad5x], ["5M PRO (Adventurer)", adv]]) {
  T(`${label}: offline — a structured offline skip, before any transport detection or network call`, async () => {
    const calls = spy(() => { throw new Error("no network in this test"); });
    const p = { id: "t_" + label, name: label, url: "http://192.0.2.20" };              // transport unknown, as right after a restart
    const h = await conn.getHealth(p, { online: false, error: "Could not reach " + label + ": fetch failed" });
    assert.deepEqual(h, { online: false, skipped: true, reason: "Could not reach " + label + ": fetch failed", reasonCode: "offline" });
    assert.equal(calls.length, 0);
  });

  T(`${label}: online on stock firmware — a structured unsupported_firmware skip (no throw)`, async () => {
    const calls = spy(() => { throw new Error("no network in this test"); });
    const h = await conn.getHealth({ id: "s_" + label, name: label, url: "http://192.0.2.21", transport: "native" }, { online: true, state: "standby" });
    assert.deepEqual(h, { online: true, skipped: true, reason: "Health is not available on this printer's stock firmware", reasonCode: "unsupported_firmware" });
    assert.equal(calls.length, 0);
  });

  T(`${label}: online, transport unknown (after a restart): detection decides; stock firmware answers natively`, async () => {
    const calls = spy(u => {
      if (u.port === "8898" && u.pathname === "/detail") return json({ code: 0, detail: { status: "ready" } });
      throw new Error("ECONNREFUSED");                                               // nothing on Moonraker's 7125
    });
    const h = await conn.getHealth({ id: "u_" + label, name: label, url: "http://192.0.2.22" }, { online: true, state: "standby" });
    assert.equal(h.reasonCode, "unsupported_firmware");
    assert.ok(calls.some(c => c.includes(":8898/detail")), "detection ran");
  });

  T(`${label}: ZMOD — Health is read from Moonraker as before`, async () => {
    const calls = spy(u => {
      if (u.port !== "7125") throw new Error("not Moonraker");
      if (u.pathname === "/printer/objects/list") return json({ result: { objects: ["extruder", "heater_bed", "mcu"] } });
      if (u.pathname === "/server/files/roots") return json({ result: [{ name: "gcodes" }] });
      return new Response("", { status: 404 });
    });
    const h = await conn.getHealth({ id: "z_" + label, name: label, url: "http://192.0.2.23", transport: "moonraker" }, { online: true, state: "standby" });
    assert.notEqual(h.skipped, true, "not a skip");
    assert.ok(calls.some(c => c.includes(":7125/printer/objects/list")), "Moonraker was asked");
  });
}

T("U1, Creality and generic Klipper keep the shared Moonraker Health unchanged", () => {
  const same = http.queryHealth;
  assert.equal(require("../connectors/klipper-moonraker").getHealth, same);
  assert.equal(require("../connectors/creality-klipper").getHealth, same);
  assert.equal(require("../connectors/snapmaker-u1-klipper").getHealth, same);
  assert.equal(require("../connectors/snapmaker-u1-klipper-ws").getHealth, same);
});

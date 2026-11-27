// test/healthBehaviour.test.js — behavior pins for GET /api/health and its
// helpers, written BEFORE any refactoring (docs/refactoring-policy.md §3.1)
// for the six behaviors no test covered (Phase 1 assessment, 2026-11-13):
//   1. group visibility: a printer the user cannot see answers 400;
//   2. authentication: the route sits behind requireAuth, which runs first
//      and can end the request before the handler;
//   3. heater dwell across requests (heaterStableSince) — mocked clock;
//   4. fan mismatch across consecutive checks (fanMismatchSeen);
//   5. module-state lifetime: kept across requests and across a config
//      reload (PRINTERS/CFG reassigned), empty again after a restart;
//   6. annotateGcodeUnusedCount.
// The real-time (31 s) dwell and real HTTP authentication are pinned by the
// contract harness (tools/refactor/harness). Loads the code through
// test/helpers/healthCode.js — only that loader may change when the code moves.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHealthCode } = require("./helpers/healthCode");

const P = (id = "p_1", extra = {}) => ({ id, name: "U1 " + id, connector: "fake", url: "http://192.0.2.10", ...extra });
const plain = o => JSON.parse(JSON.stringify(o));
const heaters = list => ({ online: true, skipped: false, heaters: { available: true, list } });
const fans = list => ({ online: true, skipped: false, fans: { available: true, list } });

// ---------- 1. group visibility ----------
test("1. a printer the user cannot see answers 400 Unknown printer; visibility is asked with (req.user, printer)", async () => {
  const seen = [];
  const user = { id: "u1", role: "view", groupIds: ["g2"] };
  const printers = [P("p_1")];
  const h = loadHealthCode({ printers, printerVisibleTo: (u, p) => { seen.push([u, p]); return false; },
    getConnector: () => ({ getHealth: async () => { throw new Error("must not be called"); } }) });
  const r = await h.request({ query: { printer: "0" }, user });
  assert.equal(r.status, 400);
  assert.deepEqual(plain(r.body), { error: "Unknown printer" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], user, "the request's user");
  assert.equal(seen[0][1], printers[0], "the printer at that index");
});

test("1. the same printer, visible, answers 200; an out-of-range index is 400 without asking visibility", async () => {
  let asked = 0;
  const h = loadHealthCode({ printers: [P("p_1")], printerVisibleTo: () => { asked++; return true; },
    getConnector: () => ({ getHealth: async () => ({ online: true, skipped: true, reason: "x" }) }) });
  assert.equal((await h.request({ query: { printer: "0" }, user: { role: "view" } })).status, 200);
  const r = await h.request({ query: { printer: "5" }, user: { role: "view" } });
  assert.equal(r.status, 400);
  assert.deepEqual(plain(r.body), { error: "Unknown printer" });
  assert.equal(asked, 1);
});

// ---------- 2. authentication ----------
test("2. GET /api/health is registered with requireAuth as its only middleware, before the handler", () => {
  const requireAuth = (req, res, next) => next();
  const h = loadHealthCode({ requireAuth });
  const healthRoutes = h.routes.filter(r => r.path === "/api/health");
  assert.equal(healthRoutes.length, 1, "registered once");
  assert.equal(healthRoutes[0].handlers.length, 2, "one middleware + the handler");
  assert.equal(healthRoutes[0].handlers[0], requireAuth, "requireAuth itself, first");
});

test("2. when requireAuth refuses, the handler never runs (no printer is probed)", async () => {
  let probed = 0;
  const h = loadHealthCode({ printers: [P()], requireAuth: (req, res) => res.status(401).json({ error: "Not signed in" }),
    probeCached: async () => { probed++; return { online: true }; } });
  const r = await h.request();
  assert.equal(r.status, 401);
  assert.equal(r.bodies.length, 1);
  assert.equal(probed, 0);
});

// ---------- 3. heater dwell (mocked clock) ----------
test("3. heater dwell: idle / heating / cooling / settling, then stable at exactly 30 s in band; leaving the band restarts it", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const h = loadHealthCode();
  assert.equal(h.HEATER_DWELL_MS, 30000);
  assert.equal(h.HEATER_TARGET_BAND_C, 3);
  const p = P();
  const read = (temperature, target, name = "extruder") => { const x = heaters([{ name, temperature, target, power: 0.5 }]); h.annotateHeaterStates(p, x); return x.heaters.list[0].state; };
  assert.equal(read(25, 0), "idle");
  assert.equal(read(100, 200), "heating");
  assert.equal(read(250, 200), "cooling");
  assert.equal(read(197, 200), "settling", "within 3 °C: first seen in band");
  t.mock.timers.tick(29_999);
  assert.equal(read(203, 200), "settling", "29.999 s in band");
  t.mock.timers.tick(1);
  assert.equal(read(200, 200), "stable", "30 s in band");
  assert.equal(read(196, 200), "heating", "out of band clears the dwell");
  assert.equal(read(200, 200), "settling", "re-earns the dwell from now");
  t.mock.timers.tick(30_000);
  assert.equal(read(200, 200), "stable");
  assert.equal(read(200, 0), "idle", "no target clears it");
  assert.equal(read(200, 200), "settling");
});

test("3. heater dwell is per printer and per heater; a null temperature is never in band", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  const h = loadHealthCode();
  const state = (p, name, temperature, target) => { const x = heaters([{ name, temperature, target, power: 0 }]); h.annotateHeaterStates(p, x); return x.heaters.list[0].state; };
  state(P("a"), "extruder", 200, 200);
  t.mock.timers.tick(20_000);
  state(P("b"), "extruder", 200, 200);
  state(P("a"), "heater_bed", 60, 60);
  t.mock.timers.tick(10_000);
  assert.equal(state(P("a"), "extruder", 200, 200), "stable");
  assert.equal(state(P("b"), "extruder", 200, 200), "settling");
  assert.equal(state(P("a"), "heater_bed", 60, 60), "settling");
  assert.equal(state(P("a"), "extruder2", null, 200), "cooling", "null temperature: not in band, and not below target");
  assert.deepEqual([...h.heaterStableSince.keys()].sort(), ["a|extruder", "a|heater_bed", "b|extruder"]);
  const unavailable = { heaters: { available: false } };
  h.annotateHeaterStates(P("a"), unavailable);
  assert.deepEqual(unavailable, { heaters: { available: false } }, "unavailable heaters are left alone");
});

// ---------- 4. fan mismatch across checks ----------
test("4. a commanded fan that is not spinning is flagged only on the second consecutive check; recovery resets", () => {
  const h = loadHealthCode();
  const p = P();
  const check = (speed, rpm, name = "fan") => plain(h.checkFanMismatch(p, fans([{ name, speed, rpm }])));
  assert.deepEqual(check(0.8, 10), [], "first observation only records");
  assert.deepEqual(check(0.8, 10.4), [{ severity: "warning", title: "Fan not spinning", detail: "fan is commanded on but reporting 10 RPM.", suggestedComponent: "Fans", code: "fan-not-spinning", name: "fan", rpm: 10 }]);
  assert.deepEqual(check(0.8, 12), [{ severity: "warning", title: "Fan not spinning", detail: "fan is commanded on but reporting 12 RPM.", suggestedComponent: "Fans", code: "fan-not-spinning", name: "fan", rpm: 12 }], "keeps flagging while it persists");
  assert.deepEqual(check(0.8, 3000), [], "spinning: cleared");
  assert.deepEqual(check(0.8, 10), [], "first observation again after recovery");
});

test("4. fan rules: rpm null is never 'stopped'; speed at or below 0.1 is not commanded; 50 rpm is spinning; per printer and fan", () => {
  const h = loadHealthCode();
  const run = (p, f) => plain(h.checkFanMismatch(p, fans([f])));
  for (let i = 0; i < 2; i++) assert.deepEqual(run(P(), { name: "fan", speed: 1, rpm: null }), []);
  for (let i = 0; i < 2; i++) assert.deepEqual(run(P(), { name: "fan", speed: 0.1, rpm: 0 }), []);
  for (let i = 0; i < 2; i++) assert.deepEqual(run(P(), { name: "fan", speed: 1, rpm: 50 }), []);
  run(P("a"), { name: "fan", speed: 1, rpm: 0 });
  assert.deepEqual(run(P("b"), { name: "fan", speed: 1, rpm: 0 }), [], "another printer's first observation");
  assert.deepEqual(run(P("a"), { name: "heater_fan hotend", speed: 1, rpm: 0 }), [], "another fan's first observation");
  assert.equal(run(P("a"), { name: "fan", speed: 1, rpm: 0 }).length, 1);
  assert.deepEqual([...h.fanMismatchSeen.keys()].sort(), ["a|fan", "a|heater_fan hotend", "b|fan"]);
  assert.deepEqual(plain(h.checkFanMismatch(P(), { fans: { available: false } })), []);
});

// ---------- 5. module-state lifetime ----------
function healthWith(state, over = {}) {
  return loadHealthCode({ printers: [P("p_1")], getConnector: () => ({ getHealth: async () => state.next() }), ...over });
}
test("5. state lives across requests and across a config reload (PRINTERS/CFG reassigned); a restart starts empty", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 9_000_000 });
  const reading = () => ({ online: true, skipped: false, heaters: { available: true, list: [{ name: "extruder", temperature: 200, target: 200, power: 0.3 }] },
    fans: { available: true, list: [{ name: "fan", speed: 1, rpm: 0 }] } });
  const h = healthWith({ next: reading });
  const r1 = await h.request();
  assert.equal(r1.body.heaters.list[0].state, "settling");
  assert.equal(r1.body.needsAttention, undefined, "first fan observation: no attention");
  // Reload: new array and new config object, same printer id (as loadConfig does).
  h.setPrinters([P("p_1", { name: "renamed" })]);
  h.setConfig({ logsFolder: "x" });
  t.mock.timers.tick(30_000);
  const r2 = await h.request();
  assert.equal(r2.body.name, "renamed", "the reloaded printer list is used");
  assert.equal(r2.body.heaters.list[0].state, "stable", "dwell kept across the reload");
  assert.equal(r2.body.needsAttention, true, "fan mismatch remembered across the reload");
  assert.deepEqual(plain(r2.body.attentionReasons).map(x => x.code), ["fan-not-spinning"]);
  assert.deepEqual(plain(r2.body.syncFolders), { logs: true, camera: false, gcodes: false }, "the reloaded config is used");
  // Restart: a new load has empty state.
  const h2 = healthWith({ next: reading });
  assert.equal(h2.heaterStableSince.size, 0);
  assert.equal(h2.fanMismatchSeen.size, 0);
  const r3 = await h2.request();
  assert.equal(r3.body.heaters.list[0].state, "settling");
  assert.equal(r3.body.needsAttention, undefined);
});

test("5. a printer removed by a reload keeps its entries (nothing prunes them); others are unaffected", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 9_500_000 });
  const h = loadHealthCode({ printers: [P("a"), P("b")], getConnector: () => ({ getHealth: async () => heaters([{ name: "extruder", temperature: 200, target: 200 }]) }) });
  await h.request({ query: { printer: "0" } });
  await h.request({ query: { printer: "1" } });
  h.setPrinters([P("b")]);
  t.mock.timers.tick(30_000);
  const r = await h.request({ query: { printer: "0" } });
  assert.equal(r.body.id, "b");
  assert.equal(r.body.heaters.list[0].state, "stable");
  assert.deepEqual([...h.heaterStableSince.keys()].sort(), ["a|extruder", "b|extruder"]);
});

// ---------- 6. annotateGcodeUnusedCount ----------
function gcodesHealth(fileNames) {
  return { storage: { available: true, categories: { gcodes: { bytes: 1, fileCount: fileNames.length, available: true, fileNames } } } };
}
test("6. unused G-code count: files not printed within gcodeSyncRetentionDays; the file list is removed from the answer", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const calls = [];
  const h = loadHealthCode({ config: { gcodeSyncRetentionDays: 7 }, connHttp: { baseUrl: p => "BASE:" + p.id, queryRecentlyPrintedFiles: async (base, since) => { calls.push([base, since]); return new Set(["a.gcode", "c.gcode"]); } } });
  const x = gcodesHealth(["a.gcode", "b.gcode", "c.gcode", "d.gcode"]);
  await h.annotateGcodeUnusedCount(P("p_9"), x);
  assert.deepEqual(plain(x.storage.categories.gcodes), { bytes: 1, fileCount: 4, available: true, unusedCount: 2, unusedThresholdDays: 7 });
  assert.deepEqual(calls, [["BASE:p_9", 1_700_000_000 - 7 * 86400]]);
});

test("6. history failure: no count, list still removed; no retention or no list: untouched (list kept)", async () => {
  const failing = loadHealthCode({ config: { gcodeSyncRetentionDays: 3 }, connHttp: { baseUrl: () => "B", queryRecentlyPrintedFiles: async () => { throw new Error("Moonraker 500"); } } });
  const x = gcodesHealth(["a.gcode"]);
  await failing.annotateGcodeUnusedCount(P(), x);
  assert.deepEqual(plain(x.storage.categories.gcodes), { bytes: 1, fileCount: 1, available: true });
  let asked = 0;
  const noRetention = loadHealthCode({ config: {}, connHttp: { baseUrl: () => "B", queryRecentlyPrintedFiles: async () => { asked++; return new Set(); } } });
  const y = gcodesHealth(["a.gcode"]);
  await noRetention.annotateGcodeUnusedCount(P(), y);
  assert.deepEqual(plain(y.storage.categories.gcodes), { bytes: 1, fileCount: 1, available: true, fileNames: ["a.gcode"] }, "returns early: the list stays");
  assert.equal(asked, 0);
  const z = { storage: { available: false } };
  await noRetention.annotateGcodeUnusedCount(P(), z);
  assert.deepEqual(z, { storage: { available: false } });
});

test("6. through the route: the answer carries the count, never the raw file list", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const h = loadHealthCode({ printers: [P()], config: { gcodeSyncRetentionDays: 1 },
    getConnector: () => ({ getHealth: async () => ({ online: true, skipped: false, ...gcodesHealth(["a.gcode", "b.gcode"]) }) }),
    connHttp: { baseUrl: () => "B", queryRecentlyPrintedFiles: async () => new Set(["b.gcode"]) } });
  const r = await h.request();
  assert.equal(r.status, 200);
  assert.deepEqual(plain(r.body.storage.categories.gcodes), { bytes: 1, fileCount: 2, available: true, unusedCount: 1, unusedThresholdDays: 1 });
});

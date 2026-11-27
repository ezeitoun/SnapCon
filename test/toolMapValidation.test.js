// test/toolMapValidation.test.js — a toolhead map from a request is checked
// before anything uses it (docs/TODO.md §38). Its values reach G-code: the U1's
// SET_PRINT_EXTRUDER_MAP took them as they came.
const test = require("node:test");
const { routeEnd } = require("./helpers/routeEnd");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const fnSrc = m => { const at = serverSrc.indexOf(m); assert.ok(at >= 0, m); return serverSrc.slice(at, at + serverSrc.slice(at).search(/\r?\n\}\r?\n/) + 3); };
const routeSrc = m => { const at = serverSrc.indexOf(m); assert.ok(at >= 0, m); return serverSrc.slice(at, routeEnd(serverSrc, at, true) + 5); };
const { getCapabilities } = require("../connectors");

const U1 = { id: "u", name: "U1 A", connector: "snapmaker-u1-klipper-ws", printerPoolId: "pool" };
const AD5X = { id: "a", name: "AD5X", connector: "flashforge-ad5x", transport: "native", printerPoolId: "pool" };
const GENERIC = { id: "g", name: "Klipper", connector: "klipper-moonraker", printerPoolId: "pool" };

function harness(printers = [U1]) {
  const routes = {};
  const later = [];
  const env = {
    console: { warn() {}, log() {} }, Object, Array, Number, String, JSON, Math,
    getCapabilities, PRINTERS: printers, CFG: { printerPools: [{ id: "pool" }] },
    printerById: id => printers.find(p => p.id === id), printerVisibleTo: () => true,
    requireRegular: (q, r, n) => n(), actorFromReq: () => ({ userId: "u" }),
    // Reached only by a request whose map checked out.
    resolveQueuedFile: async (q, r) => { later.push("resolved"); r.status(418).json({ reached: true }); return null; },
    resolveFileRef: async () => { later.push("resolved"); throw new Error("reached"); }, replyFileRefError: (r) => { r.status(418).json({ reached: true }); return true; },
    fileTypeRefusal: () => ({ reached: true }), assertNotActiveJobFile: async () => {}, withGcodeHolds: h => h, holdGcodeFile: () => true,
    app: { post: (r, ...f) => { routes[r] = f[f.length - 1]; } },
  };
  vm.createContext(env);
  vm.runInContext(fnSrc("function checkToolMap("), env);
  for (const r of ['app.post("/api/print", requireRegular', 'app.post("/api/printfile"', 'app.post("/api/queue/:printerId/items"', 'app.post("/api/queue/send"']) vm.runInContext(routeSrc(r), env);
  const call = async (r, body, params = {}) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[r]({ user: { id: "u" }, body, params }, res);
    return res;
  };
  return { env, call, later };
}

const BAD = [
  ["not an object", "1"], ["an array", [1, 2]], ["a number", 7], ["true", true],
  ["G-code in a value", { 0: "1\nM112" }], ["G-code in a key", { "0\nM112": 1 }],
  ["a negative head", { 0: -1 }], ["a fraction", { 0: 1.5 }], ["null", { 0: null }], ["true as a head", { 0: true }],
  ["an empty head", { 0: "" }], ["an array as a head", { 0: [1] }], ["an exponent", { 0: "1e1" }], ["a color that is not a number", { x: 1 }],
  ["a head past the printer's four", { 0: 4 }], ["a color past 31", { 32: 0 }], ["one bad among good", { 0: 1, 1: 9 }],
];
for (const [what, map] of BAD) {
  test(`refused before anything else happens, on all four routes: ${what}`, async () => {
    const h = harness();
    const routes = [
      ["/api/print", { file: "a.gcode", printer: 0, map }],
      ["/api/printfile", { printer: 0, filename: "a.gcode", map }],
      ["/api/queue/:printerId/items", { files: [{ name: "a.gcode", map }] }, { printerId: "u" }],
      ["/api/queue/send", { files: [{ name: "a.gcode", map }], poolId: "pool" }],
    ];
    for (const [r, body, params] of routes) {
      const res = await h.call(r, body, params);
      assert.equal(res.code, 400, r);
      assert.equal(res.body.code, "bad_tool_map", r);
      assert.match(res.body.error, /U1 A: colors are 0-31 and heads 0-3/, r);
    }
    assert.deepEqual(h.later, [], "no file was looked at");
  });
}

test("valid maps go through, numbers as numbers, on every route", async () => {
  const h = harness();
  assert.deepEqual({ ...h.env.checkToolMap({ 0: 3, 31: "0" }, U1).map }, { 0: 3, 31: 0 });
  assert.deepEqual({ ...h.env.checkToolMap({ 0: 1, 1: 1 }, U1).map }, { 0: 1, 1: 1 }, "several colors may share a head");
  for (const empty of [undefined, null, {}]) assert.deepEqual({ ...h.env.checkToolMap(empty, U1).map }, {});
  assert.equal((await h.call("/api/queue/:printerId/items", { files: [{ name: "a.gcode", map: { 0: 3 } }] }, { printerId: "u" })).code, 418);
  assert.equal((await h.call("/api/queue/send", { files: [{ name: "a.gcode", map: { 0: 3 } }], poolId: "pool" })).code, 418);
});

test("the limits are the connector's own: the AD5X's 16 tools and 4 ports; 32 where none is stated", () => {
  const h = harness();
  assert.ok(h.env.checkToolMap({ 15: 3 }, AD5X).map);
  assert.ok(h.env.checkToolMap({ 16: 0 }, AD5X).error);
  assert.ok(h.env.checkToolMap({ 0: 4 }, AD5X).error);
  assert.ok(h.env.checkToolMap({ 31: 31 }, GENERIC).map);
  assert.ok(h.env.checkToolMap({ 0: 32 }, GENERIC).error);
});

test("a queue send is checked against every printer in the pool", async () => {
  const h = harness([U1, GENERIC]);
  const res = await h.call("/api/queue/send", { files: [{ name: "a.gcode", map: { 0: 5 } }], poolId: "pool" });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /U1 A/);
});

test("at the sink: a U1 sends nothing for a map saved before the check, such as an old queue item", async t => {
  const u1 = require("../connectors/snapmaker-u1-klipper");
  const seen = [];
  const srv = http.createServer((q, r) => { seen.push(q.url); q.resume(); q.on("end", () => r.end('{"result":"ok"}')); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const p = { name: "U1", url: `http://127.0.0.1:${srv.address().port}` };
  for (const [tools, map] of [[[0], { 0: "1\nM112" }], [[0], { 0: 4 }], [[0], { 0: -1 }], [[0], {}], [["0\nM112"], { "0\nM112": 1 }], [[32], { 32: 0 }]]) {
    await assert.rejects(u1.applyHeadMapping(p, tools, map), /not valid/);
  }
  assert.deepEqual(seen, []);
  await u1.applyHeadMapping(p, [0, 1], { 0: 3, 1: "0" });
  assert.equal(seen.length, 1);
});

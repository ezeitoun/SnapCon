// test/rediscoverRoute.test.js — the two server routes behind Settings >
// Printers "Rediscover" (docs/TODO.md §35): the read of each saved printer,
// and the save of a set of corrections.
//
// The routes are taken from server.js and run against the real connector
// registry, the real address composer and public/rediscover.js, with
// config.json replaced by a variable. What they must keep: a swap is saved in
// one write, nothing is saved that would leave two printers with one address,
// serial or name, a printer changed since the scan is refused, and every other
// field of the record (id, pool, tokens, settings) is left as it was.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const connectors = require("../connectors");
const address = require("../connectors/address");
const Rediscover = require("../public/rediscover.js");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
function extractFn(name) {
  const at = serverSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}
const routesSrc = (() => {
  const from = serverSrc.indexOf("const rediscoverCheckable");
  const apply = serverSrc.indexOf('app.post("/api/rediscover/apply"');
  assert.ok(from > 0 && apply > from);
  return serverSrc.slice(from, serverSrc.indexOf("\n});\n", apply) + 5);
})();

const U1 = (id, n, extra = {}) => ({ name: "U1 " + id, url: "http://192.168.40." + n, ip: "192.168.40." + n, connector: "snapmaker-u1-klipper-ws", brand: "Snapmaker", serial: "SN-" + id, id, ...extra });

function harness(printers, opts = {}) {
  const h = { writes: [], audits: [], routes: {} };
  const ctx = vm.createContext({
    app: { get: (p, ...f) => { h.routes["GET " + p] = f[f.length - 1]; }, post: (p, ...f) => { h.routes["POST " + p] = f[f.length - 1]; } },
    requireAdmin: () => {},
    getConnector: opts.getConnector || connectors.getConnector,
    getAddress: connectors.getAddress, CONNECTOR_TYPES: connectors.CONNECTOR_TYPES, DEFAULT_CONNECTOR_TYPE: connectors.DEFAULT_TYPE,
    isValidHost: address.isValidHost, normalizePort: address.normalizePort, parseAddressUrl: address.parseAddressUrl, composeAddressUrl: address.composeAddressUrl,
    Rediscover, CONFIG_PATH: "config.json",
    fs: { writeFileSync: (p, data) => { if (opts.writeFails) throw new Error("disk full"); h.writes.push(JSON.parse(data)); } },
    auditLog: { log: e => h.audits.push(JSON.parse(JSON.stringify(e))) },
    actorFromReq: () => ({ actor: "admin" }),
    Promise, Object, Array, JSON, String, Map,
  });
  vm.runInContext(`var CFG = ${JSON.stringify({ printers, other: "kept" })};
    var CONFIG_LOAD_FAILED = ${!!opts.loadFailed};
    var PRINTERS = CFG.printers.filter(p => !p.hidden);
    function loadConfig() { CFG = JSON.parse(JSON.stringify(CFG)); PRINTERS = CFG.printers.filter(p => !p.hidden); }
    function publicCfg() { return { printers: PRINTERS }; }`, ctx);
  vm.runInContext(extractFn("resolvePrinterAddress") + "\n" + routesSrc, ctx);
  h.cfg = () => vm.runInContext("CFG", ctx);
  const call = async (key, body) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    await h.routes[key]({ body, user: { role: "admin" } }, res);
    // Objects built inside the vm context have its prototypes; a JSON copy
    // compares like the response a browser would get.
    res.body = JSON.parse(JSON.stringify(res.body));
    return res;
  };
  h.apply = changes => call("POST /api/rediscover/apply", { changes });
  h.read = () => call("GET /api/rediscover/printers");
  h.expect = id => { const p = h.cfg().printers.find(x => x.id === id); return { url: p.url, serial: p.serial || "", name: p.name }; };
  return h;
}

test("a swap is saved in one write: both addresses change together, and nothing else on either record does", async () => {
  const A = U1("A", 10, { printerPoolId: "pool1", token: "secret-a", tags: ["red"], location: "Shelf 1" });
  const B = U1("B", 11, { printerPoolId: "pool2", autoLevel: true });
  const h = harness([A, B]);
  const res = await h.apply([{ id: "A", ip: "192.168.40.11", expect: h.expect("A") }, { id: "B", ip: "192.168.40.10", expect: h.expect("B") }]);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(h.writes.length, 1, "one write, never a state with one address on both");
  const [a, b] = h.writes[0].printers;
  assert.deepEqual(a, { ...A, url: "http://192.168.40.11", ip: "192.168.40.11" });
  assert.deepEqual(b, { ...B, url: "http://192.168.40.10", ip: "192.168.40.10" });
  assert.equal(h.writes[0].other, "kept", "the rest of config.json is untouched");
});

test("half a swap is refused (it would put two printers on one address) and nothing is written", async () => {
  const h = harness([U1("A", 10), U1("B", 11)]);
  const res = await h.apply([{ id: "A", ip: "192.168.40.11", expect: h.expect("A") }]);
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "duplicate");
  assert.match(res.body.error, /same address as U1 B/);
  assert.equal(h.writes.length, 0);
});

test("a serial correction is refused when another printer already has that serial", async () => {
  const h = harness([U1("A", 10), U1("B", 11)]);
  const res = await h.apply([{ id: "A", serial: "sn-b", expect: h.expect("A") }]);
  assert.equal(res.code, 409);
  assert.match(res.body.error, /same serial/);
  assert.equal(h.writes.length, 0);
});

test("a rename is refused onto a name the slicer hook can't tell apart from another printer's", async () => {
  const h = harness([U1("A", 10), U1("B", 11, { name: "Shelf Navy" })]);
  const res = await h.apply([{ id: "A", name: "shelf_navy", expect: h.expect("A") }]);
  assert.equal(res.code, 409);
  assert.match(res.body.error, /same name/);
});

test("a duplicate that was already there doesn't block an unrelated correction", async () => {
  const h = harness([U1("A", 10, { serial: "SN-X" }), U1("B", 11, { serial: "SN-X" })]);
  const res = await h.apply([{ id: "B", ip: "192.168.40.12", expect: h.expect("B") }]);
  assert.equal(res.code, 200, JSON.stringify(res.body));
});

test("a printer changed after the scan is refused, not overwritten", async () => {
  const h = harness([U1("A", 10)]);
  const res = await h.apply([{ id: "A", serial: "SN-NEW", expect: { url: "http://192.168.40.99", serial: "SN-A", name: "U1 A" } }]);
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "stale");
  assert.equal(h.writes.length, 0);
});

test("only printers that can be asked for a serial: a FlashForge serial (its login credential) is refused", async () => {
  const ff = { id: "F", name: "5M PRO", url: "http://192.168.20.198", ip: "192.168.20.198", connector: "flashforge-adventurer", serial: "SNMOM" };
  const h = harness([ff]);
  const res = await h.apply([{ id: "F", serial: "SNOTHER", expect: h.expect("F") }]);
  assert.equal(res.code, 400);
  assert.equal(h.writes.length, 0);
});

test("the Virtual U1, which always runs on this machine, can't be given another address", async () => {
  const v = { id: "V", name: "VU1", url: "http://127.0.0.1:7126", ip: "127.0.0.1", port: 7126, connector: "virtual-u1", serial: "SN-V" };
  const h = harness([v]);
  const res = await h.apply([{ id: "V", ip: "192.168.40.5", expect: h.expect("V") }]);
  assert.equal(res.code, 400);
});

test("bad input is refused: an unknown printer, a printer named twice, a malformed serial or address, nothing to change", async () => {
  const h = harness([U1("A", 10)]);
  const e = h.expect("A");
  for (const changes of [
    [{ id: "nope", ip: "192.168.40.3", expect: e }],
    [{ id: "A", ip: "192.168.40.3", expect: e }, { id: "A", serial: "SN-Z", expect: e }],
    [{ id: "A", serial: "SN A;rm", expect: e }],
    [{ id: "A", ip: "http://x/y", expect: e }],
    [{ id: "A", expect: e }],
    [],
  ]) {
    const res = await h.apply(changes);
    assert.equal(res.code, 400, JSON.stringify(changes));
  }
  assert.equal(h.writes.length, 0);
});

test("a config that failed to load is never overwritten", async () => {
  const h = harness([U1("A", 10)], { loadFailed: true });
  const res = await h.apply([{ id: "A", ip: "192.168.40.3", expect: h.expect("A") }]);
  assert.equal(res.code, 409);
  assert.equal(h.writes.length, 0);
});

test("a failed write leaves the running config as it was", async () => {
  const h = harness([U1("A", 10)], { writeFails: true });
  const res = await h.apply([{ id: "A", ip: "192.168.40.3", expect: h.expect("A") }]);
  assert.equal(res.code, 500);
  assert.equal(h.cfg().printers[0].ip, "192.168.40.10");
});

test("printers hidden while virtual printers are off stay in config.json", async () => {
  const hidden = { id: "S", name: "Dummy#1", url: "sim://aa", connector: "simulator", hidden: true };
  const h = harness([U1("A", 10), hidden]);
  const res = await h.apply([{ id: "A", ip: "192.168.40.3", expect: h.expect("A") }]);
  assert.equal(res.code, 200);
  assert.deepEqual(h.writes[0].printers[1], hidden);
});

test("each saved change is audited: the address and name with their values, the serial only as changed", async () => {
  const h = harness([U1("A", 10)]);
  await h.apply([{ id: "A", ip: "192.168.40.3", serial: "SN-NEW", name: "Shelf A", expect: h.expect("A") }]);
  assert.equal(h.audits.length, 1);
  const a = h.audits[0];
  assert.equal(a.event, "printer-identity-updated");
  assert.equal(a.printerId, "A");
  assert.deepEqual(a.detail, { source: "rediscover", changed: ["address", "serial", "name"],
    address: { from: "http://192.168.40.10", to: "http://192.168.40.3" }, name: { from: "U1 A", to: "Shelf A" } });
  assert.ok(!JSON.stringify(a).includes("SN-NEW"));
});

test("the read lists every printer, says which can be checked, and reads only those at their saved address", async () => {
  const asked = [];
  const getConnector = type => {
    const c = connectors.getConnector(type);
    if (!c.getInventory) return c;
    return { ...c, getInventory: async p => { asked.push(p.id); return p.id === "A" ? { online: true, serial: "SN-A", device_name: "U1 A" } : { online: false }; } };
  };
  const ff = { id: "F", name: "5M PRO", url: "http://192.168.20.198", ip: "192.168.20.198", connector: "flashforge-adventurer", serial: "SNMOM" };
  const h = harness([U1("A", 10), U1("B", 11), ff], { getConnector });
  const res = await h.read();
  assert.deepEqual(res.body.printers.map(p => [p.id, p.checkable]), [["A", true], ["B", true], ["F", false]]);
  assert.deepEqual(asked.sort(), ["A", "B"]);
  assert.deepEqual(res.body.live, { A: { online: true, serial: "SN-A", name: "U1 A" }, B: { online: false } });
});

test("the button is hidden until the server says it has these routes", () => {
  // public/ is served from disk, so a page can be newer than the running
  // server; the button must not appear before its routes exist.
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(html, /<button class="btn ghost" id="rediscover"[^>]*style="[^"]*display:none;/);
  assert.match(app, /\$\("rediscover"\)\.style\.display=c\.rediscover===true\?"flex":"none";/);
  const pub = serverSrc.slice(serverSrc.indexOf("function publicCfg("), serverSrc.indexOf("\n}", serverSrc.indexOf("function publicCfg(")));
  assert.match(pub, /\n\s*rediscover: true,/);
});

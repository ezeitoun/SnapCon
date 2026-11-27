// test/filamentColorRoute.test.js — POST /api/filament-color writes a slot's
// stored colour and (on the U1) its material to the printer itself.
//
// This route had NO test coverage at all before this file: not the role
// guard, not the printer-visibility check, not its input validation. Those
// are the parts that must not regress silently, so they are executed here
// rather than pattern-matched.
//
// server.js has no module.exports and starts a listener on require (the
// constraint test/printFileAsyncJob.test.js documents), so the route is
// extracted and run against a fake `app` that captures its handler.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const u1 = require("../connectors/snapmaker-u1-klipper");

function routeSrc() {
  const start = serverSrc.indexOf('app.post("/api/filament-color"');
  assert.ok(start > 0, "the route must exist");
  const end = serverSrc.indexOf("\n});", start);
  assert.ok(end > start, "the route must be terminated");
  return serverSrc.slice(start, end + 4);
}

const PRINTER = { id: "p1", name: "U1 Pink", url: "http://192.168.40.193", connector: "snapmaker-u1-klipper-ws" };

// Builds the route's world. `over` replaces any piece of it.
function harness(over = {}) {
  const calls = [];
  const connector = Object.assign({
    setFilamentColor: async (p, ext, hex, opts) => { calls.push({ fn: "setFilamentColor", p, ext, hex, opts }); return hex; },
    findFilamentMaterial: u1.findFilamentMaterial,
  }, over.connector || {});

  const sandbox = {
    app: { post: (_p, _mw, fn) => { sandbox.__handler = fn; } },
    requireRegular: "requireRegular-middleware",
    PRINTERS: over.PRINTERS || { p1: PRINTER },
    printerVisibleTo: over.printerVisibleTo || (() => true),
    getConnector: () => connector,
    actorFromReq: () => ({ actor: "tester" }),
    auditLog: { log: e => calls.push({ fn: "audit", e }) },
  };
  vm.runInNewContext(routeSrc(), sandbox);
  assert.equal(typeof sandbox.__handler, "function", "handler must be captured");

  async function call(body, user) {
    const res = { code: 200, body: null,
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; } };
    await sandbox.__handler({ body, user: user || { name: "tester" } }, res);
    return res;
  }
  return { call, calls, connector, src: routeSrc() };
}

const writes = h => h.calls.filter(c => c.fn === "setFilamentColor");
const audits = h => h.calls.filter(c => c.fn === "audit");

// ---- Authorization ----

test("the route is behind the regular-user role guard", () => {
  // Asserted on source because the middleware chain is express's to enforce,
  // not something the handler itself can be observed doing.
  assert.match(routeSrc(), /app\.post\("\/api\/filament-color",\s*requireRegular/);
});

test("a printer the caller cannot see is refused, and never written to", async () => {
  const h = harness({ printerVisibleTo: () => false });
  const res = await h.call({ printer: "p1", extruder: 0, hex: "#112233" });
  assert.equal(res.code, 403);
  assert.equal(writes(h).length, 0);
});

test("an unknown printer is refused", async () => {
  const h = harness();
  const res = await h.call({ printer: "nope", extruder: 0, hex: "#112233" });
  assert.equal(res.code, 400);
  assert.equal(writes(h).length, 0);
});

// ---- Input validation ----

test("a non-numeric or negative extruder is refused", async () => {
  for (const extruder of ["0", -1, null, undefined, {}]) {
    const h = harness();
    const res = await h.call({ printer: "p1", extruder, hex: "#112233" });
    assert.equal(res.code, 400, `extruder ${JSON.stringify(extruder)} must be refused`);
    assert.equal(writes(h).length, 0);
  }
});

test("a malformed colour is refused", async () => {
  for (const hex of ["112233", "#1122", "#GGGGGG", "", null, "#112233; rm -rf"]) {
    const h = harness();
    const res = await h.call({ printer: "p1", extruder: 0, hex });
    assert.equal(res.code, 400, `hex ${JSON.stringify(hex)} must be refused`);
    assert.equal(writes(h).length, 0);
  }
});

test("a connector that cannot set colour at all is refused", async () => {
  const h = harness({ connector: { setFilamentColor: undefined } });
  const res = await h.call({ printer: "p1", extruder: 0, hex: "#112233" });
  assert.equal(res.code, 400);
});

// ---- Material ----

test("a colour-only request still works and sends no material", async () => {
  const h = harness();
  const res = await h.call({ printer: "p1", extruder: 0, hex: "#112233" });
  assert.equal(res.code, 200);
  assert.equal(writes(h).length, 1);
  const opts = writes(h)[0].opts || {};
  assert.ok(!opts.material, "no material may be invented for a colour-only request");
});

test("a material outside the connector's table is refused before the printer is touched", async () => {
  const h = harness();
  const res = await h.call({
    printer: "p1", extruder: 0, hex: "#112233",
    material: { vendor: "Acme", type: "Unobtainium", subType: "" },
  });
  assert.equal(res.code, 400, "an unknown material is a bad request, not a printer error");
  assert.equal(writes(h).length, 0);
});

test("the connector receives its OWN table entry, never the request's strings", async () => {
  // These values are interpolated into a gcode line by the connector and the
  // firmware validates none of them, so the request body must not be able to
  // reach that line — only an object identical-by-identity to a table entry.
  const h = harness();
  const res = await h.call({
    printer: "p1", extruder: 1, hex: "#112233",
    material: { vendor: "Snapmaker", type: "PLA", subType: "Silk", extra: "ignored" },
  });
  assert.equal(res.code, 200);
  const sent = writes(h)[0].opts.material;
  assert.ok(u1.filamentMaterials.includes(sent), "must be the table's own object");
  assert.equal(sent.extra, undefined, "request-supplied fields must not survive");
});

test("a request with material on a connector that cannot set materials is refused", async () => {
  const h = harness({ connector: { findFilamentMaterial: undefined } });
  const res = await h.call({
    printer: "p1", extruder: 0, hex: "#112233",
    material: { vendor: "Generic", type: "PLA", subType: "" },
  });
  assert.equal(res.code, 400);
  assert.equal(writes(h).length, 0);
});

test("a rejected material is not smuggled through as a junk value", async () => {
  for (const material of ["PLA", 42, [], { vendor: "Generic" }]) {
    const h = harness();
    const res = await h.call({ printer: "p1", extruder: 0, hex: "#112233", material });
    assert.equal(res.code, 400, `material ${JSON.stringify(material)} must be refused`);
    assert.equal(writes(h).length, 0);
  }
});

// ---- Result and audit ----

test("the audit row records what was actually written, material included", async () => {
  const h = harness();
  await h.call({
    printer: "p1", extruder: 2, hex: "#112233",
    material: { vendor: "Generic", type: "PETG", subType: "" },
  });
  const row = audits(h)[0];
  assert.ok(row, "a write must be audited");
  assert.equal(row.e.event, "filament-color-set");
  assert.equal(row.e.detail.extruder, 2);
  assert.deepEqual(row.e.detail.material, { vendor: "Generic", type: "PETG", subType: "" });
});

test("a connector failure is reported as an upstream error, and is not audited", async () => {
  const h = harness({ connector: { setFilamentColor: async () => { throw new Error("Printer is printing"); } } });
  const res = await h.call({ printer: "p1", extruder: 0, hex: "#112233" });
  assert.equal(res.code, 502);
  assert.match(res.body.error, /printing/);
  assert.equal(audits(h).length, 0, "a failed write must not leave an audit row claiming it happened");
});

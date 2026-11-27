// tools/refactor/test/identity.test.js — V3 (moved-code identity) on small
// synthetic base/head sources: an exact move passes; any undeclared change,
// an undeclared rewrite, a rewrite of a local of the same name, a duplicate,
// or changed middleware fails.
const test = require("node:test");
const assert = require("node:assert/strict");
const { compareMoved } = require("../lib/identity");

const BASE = `let CFG, PRINTERS;
const seen = new Map();
function check(p, h) {
  const key = p.id + "|" + h.name;
  if (CFG.limit > 2) seen.set(key, true);
  return PRINTERS[0];
}
app.get("/api/x", requireAuth, async (req, res) => {
  const p = PRINTERS[0];
  res.json({ id: p.id, logs: !!CFG.logsFolder });
});
`;
const MOVED = `"use strict";
const seen = new Map();
function registerXRoutes(app, { requireAuth, getConfig, getPrinters }) {
  app.get("/api/x", requireAuth, async (req, res) => {
    const p = getPrinters()[0];
    res.json({ id: p.id, logs: !!getConfig().logsFolder });
  });
}
function check(p, h) {
  const key = p.id + "|" + h.name;
  if (getConfig().limit > 2) seen.set(key, true);
  return getPrinters()[0];
}
`;
const RW = [{ from: "CFG", to: "getConfig()" }, { from: "PRINTERS", to: "getPrinters()" }];

test("an exact move with the declared getter rewrites passes (function, const, route handler; indentation ignored)", () => {
  for (const symbol of ["check", "seen", "GET /api/x"]) {
    const r = compareMoved({ baseSrc: BASE, headSources: { "server.js": "// moved\n", "routes/x.js": MOVED }, symbol, rewrites: RW });
    assert.equal(r.status, "PASS", symbol + ": " + JSON.stringify(r));
    assert.equal(r.headFile, "routes/x.js");
  }
});

test("a changed literal, operator or added line fails", () => {
  for (const [from, to] of [["> 2", ">= 2"], ['"|"', '":"'], ["return getPrinters()[0];", "seen.clear();\n  return getPrinters()[0];"]]) {
    const r = compareMoved({ baseSrc: BASE, headSources: { "routes/x.js": MOVED.replace(from, to) }, symbol: "check", rewrites: RW });
    assert.equal(r.status, "FAIL", from);
  }
});

test("an undeclared rewrite fails; a declared rewrite never touches a local of the same name", () => {
  assert.equal(compareMoved({ baseSrc: BASE, headSources: { "routes/x.js": MOVED }, symbol: "check", rewrites: [RW[0]] }).status, "FAIL", "PRINTERS rewrite not declared");
  const base = "let CFG;\nfunction f(CFG) { return CFG.a; }\n";
  assert.equal(compareMoved({ baseSrc: base, headSources: { "m.js": "function f(CFG) { return CFG.a; }\n" }, symbol: "f", rewrites: RW }).status, "PASS", "parameter CFG untouched");
  assert.equal(compareMoved({ baseSrc: base, headSources: { "m.js": "function f(CFG) { return getConfig().a; }\n" }, symbol: "f", rewrites: RW }).status, "FAIL");
});

test("a moved symbol defined twice, missing, or a route with changed middleware fails; assignments cannot be rewritten", () => {
  assert.match(compareMoved({ baseSrc: BASE, headSources: { "server.js": BASE, "routes/x.js": MOVED }, symbol: "seen", rewrites: RW }).why, /more than once/);
  assert.match(compareMoved({ baseSrc: BASE, headSources: { "server.js": "" }, symbol: "check", rewrites: RW }).why, /not found in head/);
  const r = compareMoved({ baseSrc: BASE, headSources: { "routes/x.js": MOVED.replace('app.get("/api/x", requireAuth,', 'app.get("/api/x",') }, symbol: "GET /api/x", rewrites: RW });
  assert.equal(r.status, "FAIL");
  assert.match(compareMoved({ baseSrc: "let CFG;\nfunction g() { CFG = 1; }\n", headSources: { "m.js": "function g() { setConfig(1); }\n" }, symbol: "g", rewrites: RW }).why, /assignment to CFG/);
  assert.match(compareMoved({ baseSrc: BASE, headSources: { "m.js": "function check( {" }, symbol: "check", rewrites: RW }).why, /could not analyse/);
});

test("rewrites land exactly in declarations and multi-statement text (not only function expressions)", () => {
  const { applyRewrites } = require("../lib/identity");
  assert.equal(applyRewrites("const n = CFG.days * 86400;", RW), "const n = getConfig().days * 86400;");
  assert.equal(applyRewrites("let a = 1;\nfunction f() { return PRINTERS[a] && CFG.x; }\nconst b = PRINTERS;", RW),
    "let a = 1;\nfunction f() { return getPrinters()[a] && getConfig().x; }\nconst b = getPrinters();");
  assert.equal(applyRewrites("async (req, res) => { const p = PRINTERS[0]; }", RW), "async (req, res) => { const p = getPrinters()[0]; }");
});

test("a helper moved inside a register function is found and compared; a nested duplicate fails", () => {
  const base = "let CFG;\nfunction helper(p) { return CFG.x + p; }\n";
  const head = "function registerX(app, { getConfig }) {\n  function helper(p) { return getConfig().x + p; }\n  app.get(\"/x\", h);\n}\n";
  assert.equal(compareMoved({ baseSrc: base, headSources: { "routes/x.js": head }, symbol: "helper", rewrites: RW }).status, "PASS");
  assert.equal(compareMoved({ baseSrc: base, headSources: { "routes/x.js": head.replace("+ p", "- p") }, symbol: "helper", rewrites: RW }).status, "FAIL");
  const dup = head + "function other() { function helper(p) { return 1; } }\n";
  assert.match(compareMoved({ baseSrc: base, headSources: { "routes/x.js": dup }, symbol: "helper", rewrites: RW }).why, /more than once/);
});

// ---------- declared destinations: a same-named declaration elsewhere ----------
const B2 = `function discoverAt(base) {\n  return listTypes().length + base;\n}\n`;
const M2 = `function registerD(app, { listTypes }) {\n  function discoverAt(base) {\n    return listTypes().length + base;\n  }\n}\n`;
const CONN = `async function discoverAt(base) {\n  return fetchIt(base);\n}\n`;
const DEST = ["routes/d.js", "server.js"];
test("destinations: a same-named declaration in a file that is not a destination is listed and ignored; the moved text is still compared exactly", () => {
  const head = { "server.js": "// moved\n", "routes/d.js": M2, "connectors/a.js": CONN, "connectors/b.js": CONN };
  assert.deepEqual(compareMoved({ baseSrc: B2, headSources: head, symbol: "discoverAt", rewrites: [], destinations: DEST }),
    { symbol: "discoverAt", status: "PASS", headFile: "routes/d.js", sameNameElsewhere: ["connectors/a.js", "connectors/b.js"] });
  const changed = { ...head, "routes/d.js": M2.replace("+ base", "- base") };
  assert.equal(compareMoved({ baseSrc: B2, headSources: changed, symbol: "discoverAt", rewrites: [], destinations: DEST }).status, "FAIL", "a changed move still fails");
  assert.match(compareMoved({ baseSrc: B2, headSources: head, symbol: "discoverAt", rewrites: [] }).why, /defined more than once in head/, "without destinations every file is a candidate, as before");
});
test("destinations: a copy left in the source file, a duplicate across two destinations, and a symbol found only elsewhere all fail", () => {
  const left = { "server.js": B2, "routes/d.js": M2 };
  assert.match(compareMoved({ baseSrc: B2, headSources: left, symbol: "discoverAt", rewrites: [], destinations: DEST }).why, /defined more than once in head \(server\.js, routes\/d\.js\)/);
  const two = { "server.js": "// moved\n", "routes/d.js": M2, "routes/e.js": M2 };
  assert.match(compareMoved({ baseSrc: B2, headSources: two, symbol: "discoverAt", rewrites: [], destinations: ["routes/d.js", "routes/e.js", "server.js"] }).why, /defined more than once in head/);
  const elsewhere = { "server.js": "// moved\n", "routes/d.js": "// nothing\n", "connectors/a.js": B2 };
  const r = compareMoved({ baseSrc: B2, headSources: elsewhere, symbol: "discoverAt", rewrites: [], destinations: DEST });
  assert.equal(r.status, "FAIL");
  assert.match(r.why, /not found in head \(a declaration of this name exists only outside the declared destinations: connectors\/a\.js\)/);
});

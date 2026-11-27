// tools/refactor/test/mapper.test.js — the server map's scope analysis on
// small synthetic sources: declarations are not references, shadowed names
// are not top-level references, `catch {` parses, reassignment and mutation
// are told apart, and "exclusive helper" stops at shared functions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, topLevel, refsOf, routesOf } = require("../mapper/map-server");

function refsOfFn(src, name) {
  const root = parse(src); const top = topLevel(root);
  let out = null;
  root.get("program").get("body").each(sp => { if (sp.node.type === "FunctionDeclaration" && sp.node.id.name === name) out = refsOf(sp, top); });
  return out;
}

test("a declaration is not a reference; a use is", () => {
  const r = refsOfFn("const A = 1; let B; function f() { return A + B; } const C = 2;", "f");
  assert.deepEqual(r.reads, ["A", "B"]);
});

test("a local binding shadowing a top-level name is not a top-level reference", () => {
  const r = refsOfFn("const CFG = {}; function f(CFG) { return CFG.x; } function g() { const PRINTERS = []; return PRINTERS; } let PRINTERS;", "f");
  assert.deepEqual(r.reads, []);
  assert.deepEqual(refsOfFn("const CFG = {}; let PRINTERS; function g() { const PRINTERS = []; return PRINTERS; }", "g").reads, []);
});

test("optional catch binding parses; reassignment and mutation are told apart", () => {
  const r = refsOfFn("let CFG; const seen = new Map(); const list = []; function f() { try { x(); } catch { CFG = load(); } seen.set(1, 2); list.push(3); return seen.get(1); }", "f");
  assert.deepEqual(r.reassigns, ["CFG"]);
  assert.deepEqual(r.mutates, ["list", "seen"]);
});

test("property names and object keys are not references", () => {
  const r = refsOfFn("const name = 1; function f(o) { return { name: o.name }; }", "f");
  assert.deepEqual(r.reads, []);
});

test("routes are found with method, path and middleware", () => {
  const rs = routesOf(parse('const app = x(); app.get("/api/health", requireAuth, async (req, res) => {}); app.post("/api/maintenance", requireRegular, (q, s) => {});'));
  assert.deepEqual(rs.map(r => [r.method, r.path, r.middleware.join(","), r.async]), [["GET", "/api/health", "requireAuth", true], ["POST", "/api/maintenance", "requireRegular", false]]);
});

test("frontend: API paths from string and template literals (ESTree Literal), linked to routes", () => {
  const { apiPathOf, matchRoute } = require("../mapper/map-frontend");
  const j = require("jscodeshift").withParser("babel");
  const lits = []; j('fetch("/api/health?printer=" + i); fetch(`/api/queue/${id}/items`); x("/not-api");').find(j.Node)
    .filter(p => p.node.type === "Literal" || p.node.type === "StringLiteral" || p.node.type === "TemplateLiteral").forEach(p => lits.push(apiPathOf(p.node)));
  assert.deepEqual(lits.filter(Boolean), ["/api/health", "/api/queue/*/items"]);
  const routes = [{ method: "GET", path: "/api/health" }, { method: "POST", path: "/api/queue/:printerId/items" }, { method: "GET", path: "/api/queue/:printerId" }];
  assert.deepEqual(matchRoute("/api/queue/*/items", routes).map(r => r.path), ["/api/queue/:printerId/items"]);
  assert.deepEqual(matchRoute("/api/health", routes).map(r => r.path), ["/api/health"]);
});

// tools/refactor/mapper/map-frontend.js — read-only map of the browser
// scripts (public/*.js, plain <script> files sharing one global scope, which
// dependency-cruiser cannot see): load order, top-level names, cross-file
// global use, module state, API calls linked to server routes, DOM ids,
// listeners and timers, largest functions. Never modifies source.
"use strict";
const fs = require("fs");
const path = require("path");
const guard = require("../lib/guard");
const tools = require("../lib/tools");
const j = require("jscodeshift").withParser("babel");
const { parse, topLevel } = require("./map-server");

// The parser yields ESTree "Literal" nodes; accept Babel's "StringLiteral" too.
const isStr = n => !!n && (n.type === "StringLiteral" || n.type === "Literal") && typeof n.value === "string";

function scriptsOf(html) {
  return [...html.matchAll(/<script\s+src="\/?([^"]+\.js)"\s*>/g)].map(m => m[1]);
}

// API path in a string or template literal: "/api/x/${id}?q" -> "/api/x/*"
function apiPathOf(node) {
  let s = null;
  if ((node.type === "StringLiteral" || node.type === "Literal") && typeof node.value === "string") s = node.value;
  else if (node.type === "TemplateLiteral") s = node.quasis.map(q => q.value.cooked).join("\u0000");
  if (!s || !s.startsWith("/api/")) return null;
  return s.split("?")[0].replace(/\u0000[^/]*/g, "*").replace(/\/+$/, "");
}

function routeRegex(p) {
  return new RegExp("^" + p.split("/").map(seg => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "$");
}
function matchRoute(clientPath, routes) {
  // A "*" segment from a template matches any one segment (or a run of them at the end).
  const segs = clientPath.split("/");
  return routes.filter(r => {
    if (typeof r.path !== "string" || !r.path.startsWith("/api/")) return false;
    const rs = r.path.split("/");
    if (segs[segs.length - 1] === "*" ? rs.length < segs.length - 1 : rs.length !== segs.length) return false;
    return segs.every((s, i) => s === "*" || (rs[i] !== undefined && (rs[i] === s || rs[i].startsWith(":") || (s.includes("*") && routeRegex(s.replace(/\*/g, ":x")).test(rs[i])))));
  });
}

function methodNear(p) {
  // Look for { method: "POST" } in the enclosing call's arguments.
  let q = p;
  for (let i = 0; i < 6 && q; i++, q = q.parent) {
    if (q.node.type === "CallExpression") {
      for (const a of q.node.arguments) {
        if (a.type !== "ObjectExpression") continue;
        for (const pr of a.properties) if (pr.key && (pr.key.name === "method" || pr.key.value === "method") && isStr(pr.value)) return pr.value.value.toUpperCase();
      }
      const callee = q.node.callee;
      const name = callee.type === "Identifier" ? callee.name : callee.property && callee.property.name;
      if (/post/i.test(name || "")) return "POST";
      return "GET";
    }
  }
  return "GET";
}

const { appPaths } = require("../lib/appPaths");
function jsFilesUnder(root, rel) {
  const p = path.join(root, rel);
  if (fs.statSync(p).isFile()) return [rel];
  return fs.readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? jsFilesUnder(root, path.join(rel, e.name)) : (e.name.endsWith(".js") ? [path.join(rel, e.name)] : []));
}
// Every app.METHOD("/path", …) call in the app's own files, wherever it sits.
function allRoutes(ctx) {
  const HTTP = new Set(["get", "post", "put", "delete", "patch", "all"]);
  const out = [];
  for (const rel of appPaths(ctx.worktree, { browserShared: false }).flatMap(x => jsFilesUnder(ctx.worktree, x))) {
    const src = fs.readFileSync(path.join(ctx.worktree, rel), "utf8");
    if (!/\bapp\.(get|post|put|delete|patch|all)\(/.test(src)) continue;
    parse(src).find(j.CallExpression).forEach(p => {
      const c = p.node.callee, a0 = p.node.arguments[0];
      if (c.type !== "MemberExpression" || c.object.type !== "Identifier" || c.object.name !== "app" || !c.property || !HTTP.has(c.property.name)) return;
      if (!isStr(a0)) return;
      out.push({ method: c.property.name.toUpperCase(), path: a0.value, file: rel, line: p.node.loc && p.node.loc.start.line });
    });
  }
  return out;
}

function main() {
  const ctx = guard.check();
  const pub = path.join(ctx.worktree, "public");
  const order = scriptsOf(fs.readFileSync(path.join(pub, "index.html"), "utf8"));
  const files = {};
  const globalsBy = new Map();     // name -> file that declares it at top level
  for (const f of order) {
    const src = fs.readFileSync(path.join(pub, f), "utf8");
    const root = parse(src);
    const top = topLevel(root);
    for (const n of top.keys()) if (!globalsBy.has(n)) globalsBy.set(n, f);
    files[f] = { src, root, top, lines: src.split("\n").length };
  }

  const out = { loadOrder: order, files: {}, crossFile: [], api: [], unmatchedApi: [], routesWithoutClient: [] };
  for (const f of order) {
    const { root, top, lines } = files[f];
    // Names this file uses but does not declare anywhere in its own scopes.
    const used = new Map();
    root.find(j.Identifier).forEach(p => {
      const n = p.node.name, par = p.parent && p.parent.node;
      if (par && (par.type === "MemberExpression" || par.type === "OptionalMemberExpression") && par.property === p.node && !par.computed) return;
      if (par && (par.type === "ObjectProperty" || par.type === "ObjectMethod") && par.key === p.node && !par.computed) return;
      if (!globalsBy.has(n) || globalsBy.get(n) === f) return;
      let scope = null; try { scope = p.scope && p.scope.lookup(n); } catch { /* ignore */ }
      if (scope) return;              // declared locally somewhere in this file
      used.set(n, (used.get(n) || 0) + 1);
    });
    for (const [n, c] of used) out.crossFile.push({ file: f, uses: n, declaredIn: globalsBy.get(n), count: c });

    // Module state: top-level let/var and Map/Set/array/object consts; who reassigns.
    const state = [...top].filter(([, d]) => d.kind === "let" || d.kind === "var" || /^new (Map|Set)/.test(d.init) || d.init === "ArrayExpression" || d.init === "ObjectExpression").map(([n, d]) => ({ name: n, kind: d.kind, init: d.init, line: d.line }));
    const reassignCount = new Map();
    root.find(j.AssignmentExpression).forEach(p => { if (p.node.left.type === "Identifier" && top.has(p.node.left.name)) reassignCount.set(p.node.left.name, (reassignCount.get(p.node.left.name) || 0) + 1); });
    for (const s of state) s.assignments = reassignCount.get(s.name) || 0;

    // API calls.
    root.find(j.Node).filter(p => isStr(p.node) || p.node.type === "TemplateLiteral").forEach(p => {
      const ap = apiPathOf(p.node); if (!ap) return;
      if (p.parent && p.parent.node.type === "TemplateLiteral") return;
      if (!p.node.loc) return;
      // "/api/queue/" + id: a prefix, not a whole path.
      const par = p.parent && p.parent.node;
      const prefix = !!(par && par.type === "BinaryExpression" && par.operator === "+" && par.left === p.node) || /\*$/.test(ap);
      out.api.push({ file: f, line: p.node.loc.start.line, path: ap, prefix, method: methodNear(p) });
    });

    // DOM ids, listeners, timers.
    const ids = new Set();
    root.find(j.CallExpression).forEach(p => {
      const c = p.node.callee, a0 = p.node.arguments[0];
      const name = c.type === "Identifier" ? c.name : c.property && c.property.name;
      if ((name === "$" || name === "getElementById") && a0 && isStr(a0)) ids.add(a0.value);
      if (name === "querySelector" && a0 && isStr(a0) && /^#[\w-]+$/.test(a0.value)) ids.add(a0.value.slice(1));
    });
    const count = (pred) => root.find(j.CallExpression).filter(p => pred(p.node.callee)).size();
    const callee = n => c => (c.type === "Identifier" && c.name === n) || (c.type === "MemberExpression" && c.property.name === n);
    const fns = [];
    root.find(j.Function).forEach(p => {
      const n = p.node; if (!n.loc) return;
      const len = n.loc.end.line - n.loc.start.line + 1;
      if (len < 150) return;
      let name = n.id && n.id.name;
      if (!name && p.parent.node.type === "VariableDeclarator") name = p.parent.node.id.name;
      fns.push({ name: name || "(anonymous)", line: n.loc.start.line, lines: len });
    });
    out.files[f] = { lines, topLevelNames: top.size, functions: [...top.values()].filter(d => d.kind === "function" || d.init === "function").length,
      moduleState: state.length, stateBindings: state, domIds: ids.size, listeners: count(callee("addEventListener")),
      setInterval: count(callee("setInterval")), setTimeout: count(callee("setTimeout")),
      largestFunctions: fns.sort((a, b) => b.lines - a.lines).slice(0, 12) };
  }

  // Link API calls to routes registered anywhere in the app (server.js and
  // route modules such as library/routes.js), not only at server.js top level.
  const routes = allRoutes(ctx);
  const hit = new Set();
  for (const a of out.api) {
    const cands = a.prefix ? routes.filter(r => typeof r.path === "string" && (r.path === a.path || r.path.startsWith(a.path.replace(/\*$/, "").replace(/\/$/, "") + "/"))) : matchRoute(a.path, routes);
    const m = cands.filter(r => r.method === a.method || r.method === "ALL");
    const any = m.length ? m : cands;
    a.routes = any.map(r => r.method + " " + r.path);
    for (const r of any) hit.add(r.method + " " + r.path);
    if (!any.length) out.unmatchedApi.push(a);
  }
  out.routeCount = routes.length;
  out.routeFiles = [...new Set(routes.map(r => r.file))];
  out.routesWithoutClient = routes.filter(r => typeof r.path === "string" && r.path.startsWith("/api/") && !hit.has(r.method + " " + r.path)).map(r => r.method + " " + r.path + " (" + r.file + ")");
  const p = tools.writeOut(ctx, "assessment/frontend-map.json", out);
  console.log(`frontend: ${order.length} scripts, ${out.crossFile.length} cross-file global uses, ${out.api.length} API call sites (${out.unmatchedApi.length} unmatched), ${out.routesWithoutClient.length} server routes with no browser call -> ${p}`);
}

if (require.main === module) main();
module.exports = { apiPathOf, matchRoute, scriptsOf, isStr };

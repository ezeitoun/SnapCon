// tools/refactor/mapper/map-server.js — read-only map of server.js for the
// Architecture Mapper: top-level declarations, which top-level names each
// route and function reads, reassigns or mutates (scope-resolved with
// jscodeshift's parser — never transforms), load-time side effects, and route
// areas with their exclusive and shared helpers. Writes JSON to
// tools/refactor/out/assessment/. Never modifies source.
"use strict";
const fs = require("fs");
const path = require("path");
const guard = require("../lib/guard");
const tools = require("../lib/tools");
const j = require("jscodeshift").withParser("babel");

const MUTATORS = new Set(["set", "delete", "clear", "push", "pop", "shift", "unshift", "splice", "add", "sort", "reverse", "fill"]);
const HTTP = new Set(["get", "post", "put", "delete", "patch", "all", "use"]);

// Parse for analysis only. ast-types' scope analysis cannot handle optional
// catch bindings (`catch {`), which SnapCon uses; give each one a unique
// placeholder binding in memory. The source is never written back.
const NO_CATCH_BINDING = "__mapper_no_catch_binding__";
function parse(src) {
  const root = j(src);
  root.find(j.CatchClause).forEach(p => { if (!p.node.param) p.node.param = j.identifier(NO_CATCH_BINDING); });
  return root;
}

function lineOf(n) { return n.loc ? n.loc.start.line : null; }
function endOf(n) { return n.loc ? n.loc.end.line : null; }

// Top-level names of a program, with what kind of binding each is.
function topLevel(root) {
  const decl = new Map();
  for (const st of root.get().node.program.body) {
    if (st.type === "FunctionDeclaration" && st.id) decl.set(st.id.name, { kind: "function", async: !!st.async, line: lineOf(st), end: endOf(st) });
    else if (st.type === "ClassDeclaration" && st.id) decl.set(st.id.name, { kind: "class", line: lineOf(st), end: endOf(st) });
    else if (st.type === "VariableDeclaration") {
      for (const d of st.declarations) {
        const names = [];
        if (d.id.type === "Identifier") names.push(d.id.name);
        else if (d.id.type === "ObjectPattern") for (const p of d.id.properties) { if (p.value && p.value.type === "Identifier") names.push(p.value.name); else if (p.argument) names.push(p.argument.name); }
        else if (d.id.type === "ArrayPattern") for (const e of d.id.elements) if (e && e.type === "Identifier") names.push(e.name);
        const init = d.init;
        let initKind = init ? init.type : "none";
        if (init && init.type === "NewExpression" && init.callee.type === "Identifier") initKind = "new " + init.callee.name;
        if (init && init.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === "require") initKind = "require";
        if (init && init.type === "MemberExpression" && init.object.type === "CallExpression" && init.object.callee.name === "require") initKind = "require";
        if (init && /Function/.test(init.type)) initKind = "function";
        for (const n of names) decl.set(n, { kind: st.kind, init: initKind, line: lineOf(st), end: endOf(st), requireOf: initKind === "require" ? requireTarget(init) : undefined });
      }
    }
  }
  return decl;
}
function requireTarget(init) {
  const c = init.type === "MemberExpression" ? init.object : init;
  return c.arguments && c.arguments[0] && c.arguments[0].value;
}

// True when the identifier declares a binding (variable/function/class id,
// parameter, or a name inside a destructuring declaration) rather than using one.
function isBindingPosition(p) {
  let child = p, parent = p.parent;
  while (parent && ["ObjectPattern", "ArrayPattern", "RestElement", "AssignmentPattern", "ObjectProperty", "Property"].includes(parent.node.type)) {
    if ((parent.node.type === "ObjectProperty" || parent.node.type === "Property") && parent.node.value !== child.node) return false;
    if (parent.node.type === "AssignmentPattern" && parent.node.left !== child.node) return false;
    child = parent; parent = parent.parent;
  }
  if (!parent) return false;
  const n = parent.node;
  if (n.type === "VariableDeclarator" && n.id === child.node) return true;
  if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ClassDeclaration" || n.type === "ClassExpression") && n.id === child.node) return true;
  if (/Function/.test(n.type) && n.params && n.params.includes(child.node)) return true;
  if (n.type === "CatchClause" && n.param === child.node) return true;
  return false;
}

// Every reference inside `nodePath` that resolves to a top-level binding.
function refsOf(nodePath, top) {
  const reads = new Set(), reassigns = new Set(), mutates = new Set();
  j(nodePath).find(j.Identifier).forEach(p => {
    const name = p.node.name;
    if (!top.has(name)) return;
    const parent = p.parent && p.parent.node;
    // Skip property keys and non-computed member properties.
    if (parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === p.node && !parent.computed) return;
    if (parent && (parent.type === "ObjectProperty" || parent.type === "Property") && parent.key === p.node && !parent.computed && parent.value !== p.node) return;
    if (isBindingPosition(p)) return;        // a declaration, not a reference
    const scope = p.scope && p.scope.lookup(name);
    if (!scope || !scope.isGlobal) return;   // shadowed by a local binding
    reads.add(name);
    if (parent && parent.type === "AssignmentExpression" && parent.left === p.node) reassigns.add(name);
    if (parent && parent.type === "UpdateExpression") reassigns.add(name);
    if (parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.object === p.node) {
      const gp = p.parent.parent && p.parent.parent.node;
      const prop = parent.property && (parent.property.name || parent.property.value);
      if (gp && gp.type === "CallExpression" && gp.callee === parent && MUTATORS.has(prop)) mutates.add(name);
      if (gp && gp.type === "AssignmentExpression" && gp.left === parent) mutates.add(name);
    }
  });
  return { reads: [...reads].sort(), reassigns: [...reassigns].sort(), mutates: [...mutates].sort() };
}

function routesOf(root) {
  const out = [];
  for (const sp of root.get("program").get("body").map(x => x)) {
    const st = sp.node;
    if (st.type !== "ExpressionStatement" || st.expression.type !== "CallExpression") continue;
    const c = st.expression.callee;
    if (c.type !== "MemberExpression" || c.object.type !== "Identifier" || c.object.name !== "app" || !HTTP.has(c.property.name)) continue;
    const a0 = st.expression.arguments[0];
    const p = a0 && (a0.type === "StringLiteral" || a0.type === "Literal") ? a0.value : (a0 && a0.type === "TemplateLiteral" ? "`" + a0.quasis.map(q => q.value.raw).join("${}") + "`" : null);
    const handlers = st.expression.arguments.slice(1);
    out.push({ method: c.property.name.toUpperCase(), path: p, line: lineOf(st), end: endOf(st),
      middleware: handlers.filter(h => h.type === "Identifier" || h.type === "CallExpression").map(h => h.type === "Identifier" ? h.name : (h.callee.name || "call")),
      async: handlers.some(h => /Function/.test(h.type) && h.async), nodePath: sp });
  }
  return out;
}

// Statements that run at load time beyond declarations and route registration.
function loadTimeEffects(root, routes) {
  const routeLines = new Set(routes.map(r => r.line));
  const out = [];
  for (const st of root.get().node.program.body) {
    if (st.type === "ExpressionStatement" && !routeLines.has(lineOf(st))) out.push({ line: lineOf(st), code: j(st).toSource().split("\n")[0].slice(0, 120) });
    if (st.type === "IfStatement" || st.type === "TryStatement" || st.type === "ForOfStatement" || st.type === "ForStatement" || st.type === "BlockStatement") out.push({ line: lineOf(st), code: j(st).toSource().split("\n")[0].slice(0, 120) });
  }
  return out;
}

function areaOf(p) {
  if (!p || typeof p !== "string") return "(dynamic)";
  const m = /^\/api\/([^/?:]+)/.exec(p);
  return m ? m[1].replace(/-(status|mode|check|offline)$/, "") : p.split("/")[1] || "/";
}

function main() {
  const ctx = guard.check();
  const file = path.join(ctx.worktree, "server.js");
  const src = fs.readFileSync(file, "utf8");
  const root = parse(src);
  const top = topLevel(root);
  const routes = routesOf(root);

  // Per top-level function / function-valued const: what it references.
  const fnRefs = new Map();
  root.get("program").get("body").each(sp => {
    const st = sp.node;
    if (st.type === "FunctionDeclaration" && st.id) fnRefs.set(st.id.name, refsOf(sp, top));
    else if (st.type === "VariableDeclaration") {
      sp.get("declarations").each(dp => {
        const d = dp.node;
        if (d.id.type === "Identifier" && d.init && /Function/.test(d.init.type)) fnRefs.set(d.id.name, refsOf(dp, top));
      });
    }
  });
  for (const r of routes) r.refs = refsOf(r.nodePath, top);

  // Who refers to each top-level name (routes as "METHOD path", functions by name).
  const referrers = new Map();
  const note = (name, who) => { if (!referrers.has(name)) referrers.set(name, new Set()); referrers.get(name).add(who); };
  for (const [fn, r] of fnRefs) for (const n of r.reads) if (n !== fn) note(n, "fn:" + fn);
  for (const r of routes) for (const n of r.refs.reads) note(n, "route:" + r.method + " " + r.path);
  // Load-time statements also refer to names.
  root.get("program").get("body").each(sp => {
    const st = sp.node;
    const isRoute = routes.some(r => r.line === lineOf(st));
    if (isRoute || st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") return;
    if (st.type === "VariableDeclaration" && st.declarations.every(d => d.init && /Function/.test(d.init.type))) return;
    for (const n of refsOf(sp, top).reads) note(n, "load:" + lineOf(st));
  });

  // Module state: lets, and consts holding Maps/Sets/arrays/objects.
  const state = [];
  for (const [name, d] of top) {
    const isState = d.kind === "let" || d.kind === "var" || /^new (Map|Set|WeakMap|WeakSet)$/.test(d.init) || d.init === "ArrayExpression" || d.init === "ObjectExpression";
    if (!isState) continue;
    const reassignedBy = [], mutatedBy = [];
    for (const [fn, r] of fnRefs) { if (r.reassigns.includes(name)) reassignedBy.push(fn); if (r.mutates.includes(name)) mutatedBy.push(fn); }
    for (const r of routes) { const who = r.method + " " + r.path; if (r.refs.reassigns.includes(name)) reassignedBy.push(who); if (r.refs.mutates.includes(name)) mutatedBy.push(who); }
    state.push({ name, kind: d.kind, init: d.init, line: d.line, readers: referrers.has(name) ? referrers.get(name).size : 0, reassignedBy, mutatedBy });
  }

  // Route areas: routes grouped by /api/<area>, the helpers they reach
  // (transitively through top-level functions), and which of those are used
  // only inside the area.
  const areas = new Map();
  for (const r of routes) { const a = areaOf(r.path); if (!areas.has(a)) areas.set(a, []); areas.get(a).push(r); }
  const closure = (names) => {
    const seen = new Set(), stack = [...names];
    while (stack.length) { const n = stack.pop(); if (seen.has(n)) continue; seen.add(n); const fr = fnRefs.get(n); if (fr) for (const m of fr.reads) if (!seen.has(m)) stack.push(m); }
    return seen;
  };
  const areaReport = [];
  for (const [a, rs] of areas) {
    const reached = closure(rs.flatMap(r => r.refs.reads));
    // Exclusive = every referrer is one of the area's routes or another
    // exclusive name; computed to a fixpoint, so a helper only reached through
    // a shared function (probeCached → finishProbe → …) is not exclusive.
    const routeIds = new Set(rs.map(r => "route:" + r.method + " " + r.path));
    let excl = new Set([...reached].filter(n => top.get(n) && top.get(n).init !== "require"));
    for (let changed = true; changed;) {
      changed = false;
      for (const n of [...excl]) {
        const who = [...(referrers.get(n) || [])];
        const ok = who.length > 0 && who.every(w => routeIds.has(w) || (w.startsWith("fn:") && excl.has(w.slice(3))));
        if (!ok) { excl.delete(n); changed = true; }
      }
    }
    const exclusive = [...excl];
    // Direct dependencies of the area's code (routes + exclusive helpers) that stay outside it.
    const direct = new Set([...rs.flatMap(r => r.refs.reads), ...exclusive.flatMap(n => (fnRefs.get(n) || { reads: [] }).reads)]);
    const shared = [...direct].filter(n => !excl.has(n));
    const exLines = exclusive.reduce((s, n) => s + ((top.get(n).end || 0) - (top.get(n).line || 0) + 1), 0);
    const rLines = rs.reduce((s, r) => s + (r.end - r.line + 1), 0);
    const stateTouched = state.filter(s => direct.has(s.name));
    areaReport.push({ area: a, routes: rs.map(r => ({ method: r.method, path: r.path, line: r.line, lines: r.end - r.line + 1, async: r.async, middleware: r.middleware })),
      routeLines: rLines, exclusiveHelpers: exclusive.sort(), exclusiveLines: exLines, sharedDeps: shared.sort(),
      stateRead: stateTouched.map(s => s.name), stateReassigned: [...new Set(rs.flatMap(r => r.refs.reassigns))], stateMutated: [...new Set([...rs.flatMap(r => r.refs.mutates), ...exclusive.flatMap(n => (fnRefs.get(n) || { mutates: [] }).mutates)])] });
  }

  const out = {
    file: "server.js", lines: src.split("\n").length,
    topLevel: [...top].map(([name, d]) => ({ name, ...d })),
    requires: [...top].filter(([, d]) => d.init === "require").map(([name, d]) => ({ name, from: d.requireOf, line: d.line })),
    routes: routes.map(r => ({ method: r.method, path: r.path, line: r.line, lines: r.end - r.line + 1, async: r.async, middleware: r.middleware, area: areaOf(r.path) })),
    state, loadTime: loadTimeEffects(root, routes), areas: areaReport,
    functions: [...fnRefs].map(([name, r]) => ({ name, line: top.get(name).line, lines: top.get(name).end - top.get(name).line + 1, ...r, referrers: [...(referrers.get(name) || [])] })),
  };
  const p = tools.writeOut(ctx, "assessment/server-map.json", out);
  console.log(`server.js: ${out.lines} lines, ${out.topLevel.length} top-level names, ${routes.length} routes in ${areas.size} areas, ${state.length} module-state bindings, ${out.loadTime.length} load-time statements -> ${p}`);
}

if (require.main === module) main();
module.exports = { parse, topLevel, refsOf, routesOf, areaOf };

#!/usr/bin/env node
// tools/refactor/codemods/extract-snapshot.js — the Snapshot extraction as a
// mechanical, repeatable transformation (tools/refactor/manifests/snapshot.json).
//   node tools/refactor/codemods/extract-snapshot.js --target <dir>
// <dir> must be a validation scratch repository, or this approved worktree
// only once the owner has authorised the extraction (--execute required).
// Exact text moves; the only rewrites are the declared CFG -> getConfig() and
// PRINTERS -> getPrinters() (scope-aware, lib/identity.js applyRewrites).
// One contiguous slice of server.js moves: the "Server-side throttle" comment,
// the two Maps, getSnapshotThrottled and GET /api/snapshot. getSnapshot and
// checkSnapshot above it, and the routes after it, stay where they are.
// Every anchor must occur exactly once or nothing is written.
"use strict";
const fs = require("fs");
const path = require("path");
const guard = require("../lib/guard");
const { checkRepo } = require("../harness/run");
const { applyRewrites } = require("../lib/identity");
const j = require("jscodeshift").withParser("babel");
const { parse } = require("../mapper/map-server");

const REWRITES = [{ from: "CFG", to: "getConfig()" }, { from: "PRINTERS", to: "getPrinters()" }];
const DEPS = "requireAuth, getConfig, getPrinters, printerVisibleTo, getSnapshot";
const MODULE_SCOPE = ["snapshotCache", "snapshotInflight"];
const INSIDE = ["getSnapshotThrottled"];
// Every name the moved code reads without declaring it, at the base: the two
// reassigned bindings (the declared rewrites), the injected names, and three
// language globals. Anything else means a dependency nobody declared.
const FREE_AT_BASE = ["CFG", "Date", "Map", "PRINTERS", "app", "getSnapshot", "parseInt", "printerVisibleTo", "requireAuth"];
// …and in the finished module: the globals, and `module` for the export.
const FREE_IN_MODULE = ["Date", "Map", "module", "parseInt"];

const once = (s, a, what) => { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error(`anchor not found exactly once (${what}): ${a.slice(0, 70)}`); return i; };
const replaceOnce = (s, a, b, what) => { const i = once(s, a, what); return s.slice(0, i) + b + s.slice(i + a.length); };
const indent = (text, n) => text.split("\n").map(l => (l.length ? " ".repeat(n) + l : l)).join("\n");
const lineOf = (s, i) => s.slice(0, i).split("\n").length;
const count = (s, a) => s.split(a).length - 1;
const names = text => parse(text).get().node.program.body.map(st => (st.type === "FunctionDeclaration" ? st.id.name : st.type === "VariableDeclaration" ? st.declarations[0].id.name : st.type));

// Names a piece of code reads or writes without declaring them (sorted).
// Property names (a.b, { b: … }) are not references.
function freeNames(text) {
  const free = new Set();
  parse(text).find(j.Identifier).forEach(p => {
    const name = p.node.name, par = p.parent && p.parent.node;
    if (par && (par.type === "MemberExpression" || par.type === "OptionalMemberExpression") && par.property === p.node && !par.computed) return;
    if (par && (par.type === "ObjectProperty" || par.type === "Property") && par.key === p.node && !par.computed && par.value !== p.node) return;
    if (!p.scope.lookup(name)) free.add(name);
  });
  return [...free].sort();
}

function transform(files) {
  const server = files["server.js"];
  const S = once(server, "// Server-side throttle for the fleet Camera View's automatic polling: that", "block start");
  const F = once(server, "async function getSnapshotThrottled(p, idx) {", "getSnapshotThrottled");
  const R = once(server, 'app.get("/api/snapshot", requireAuth, async (req, res) => {', "route start");
  const E = server.indexOf("\n});\n", R) + 4;          // end of the route: "});"
  // What stays, on both sides of the slice.
  const G = once(server, "async function getSnapshot(p) {", "getSnapshot (stays)");
  const C = once(server, "function checkSnapshot(p, shot) {", "checkSnapshot (stays)");
  const N = once(server, "// ---- Live camera: relay one printer's video to a browser ----", "the next block (stays)");
  const N2 = once(server, 'app.get("/api/camera-stream", requireAuth, async (req, res) => {', "camera-stream (stays)");
  if (!(G < C && C < S && S < F && F < R && R < E && E < N && N < N2)) throw new Error("block boundaries out of order");
  if (server.slice(E, N) !== "\n\n") throw new Error("unexpected text between the route and the next block");
  if (!server.slice(C, S).endsWith("\n}\n\n")) throw new Error("unexpected text between checkSnapshot and the moved block");

  const moduleLevel = server.slice(S, F);              // the comment block and the two Maps (ends "\n")
  const inner = server.slice(F, R);                    // getSnapshotThrottled and the blank line after it
  const route = server.slice(R, E);                    // app.get(…) … });
  if (JSON.stringify(names(moduleLevel)) !== JSON.stringify(MODULE_SCOPE)) throw new Error("unexpected module-scope statements: " + JSON.stringify(names(moduleLevel)));
  if (JSON.stringify(names(inner)) !== JSON.stringify(INSIDE)) throw new Error("unexpected statements before the route: " + JSON.stringify(names(inner)));
  if (JSON.stringify(names(route)) !== JSON.stringify(["ExpressionStatement"])) throw new Error("the route slice is not exactly one route");
  const moved = server.slice(S, E);
  for (const n of ["FOLDER", "USERS"]) if (new RegExp("\\b" + n + "\\b").test(moved)) throw new Error("the moved code reads " + n + " — a rewrite nobody declared would be needed");
  const freeBase = freeNames(moved);
  if (JSON.stringify(freeBase) !== JSON.stringify(FREE_AT_BASE)) throw new Error("the moved code reaches names other than the declared ones: " + JSON.stringify(freeBase));
  // The two Maps are created from nothing server.js owns: no rewrite, no injected name at module scope.
  if (JSON.stringify(freeNames(moduleLevel)) !== JSON.stringify(["Map"])) throw new Error("the module-scope part reaches more than Map: " + JSON.stringify(freeNames(moduleLevel)));
  if (applyRewrites(moduleLevel, REWRITES) !== moduleLevel) throw new Error("a rewrite would change the module-scope part");
  // Nothing else in server.js may use what moves.
  const rest = server.slice(0, S) + server.slice(E);
  for (const n of [...MODULE_SCOPE, ...INSIDE]) if (new RegExp("\\b" + n + "\\b").test(rest)) throw new Error("server.js uses " + n + " outside the moved block");
  if (rest.includes("routes/snapshot")) throw new Error("server.js already mentions routes/snapshot");

  const innerNew = applyRewrites(inner, REWRITES), routeNew = applyRewrites(route, REWRITES);
  const rewrites = { CFG: count(innerNew + routeNew, "getConfig()"), PRINTERS: count(innerNew + routeNew, "getPrinters()") };
  if (count(inner + route, "getConfig()") || count(inner + route, "getPrinters()")) throw new Error("the moved code already calls getConfig()/getPrinters()");

  const snapshot = [
    "// routes/snapshot.js — GET /api/snapshot, its throttle and the cache behind it,",
    "// moved from server.js (docs/refactoring-policy.md;",
    "// tools/refactor/manifests/snapshot.json).",
    "// No \"use strict\": server.js runs in sloppy mode and the moved code keeps it.",
    "// server.js requires this module and calls registerSnapshotRoutes() at the",
    "// route's original position, so start-up order is unchanged. The two Maps",
    "// (snapshotCache, snapshotInflight) stay at module scope: created once when",
    "// the module is required, kept for the process lifetime, not reset by config",
    "// reloads. The throttle and the route live inside registerSnapshotRoutes,",
    "// where the injected dependencies are parameters; CFG and PRINTERS (reassigned",
    "// by loadConfig) are read through getConfig() / getPrinters(). getSnapshot and",
    "// checkSnapshot stay in server.js (notifications use them too) and arrive here",
    "// as the injected getSnapshot.",
    "",
    moduleLevel.replace(/\n+$/, ""),
    "",
    `function registerSnapshotRoutes(app, { ${DEPS} }) {`,
    indent(innerNew.replace(/\n+$/, ""), 2),
    "",
    indent(routeNew, 2),
    "}",
    "",
    "module.exports = { registerSnapshotRoutes };",
    "",
  ].join("\n");
  const freeModule = freeNames(snapshot);
  if (JSON.stringify(freeModule) !== JSON.stringify(FREE_IN_MODULE)) throw new Error("routes/snapshot.js would reach names it was not given: " + JSON.stringify(freeModule));

  const registration = [
    "// ---- Camera snapshot route: GET /api/snapshot, its throttle and its cache",
    "// live in routes/snapshot.js. Required and registered here, at the route's",
    "// original position, so start-up order is unchanged",
    "// (docs/refactoring-policy.md). getSnapshot and checkSnapshot above stay",
    "// here: notifications use them too. ----",
    'const { registerSnapshotRoutes } = require("./routes/snapshot");',
    "registerSnapshotRoutes(app, { requireAuth, getConfig: () => CFG, getPrinters: () => PRINTERS, printerVisibleTo, getSnapshot });",
  ].join("\n");
  const newServer = server.slice(0, S) + registration + server.slice(E);
  if (newServer.slice(0, S) !== server.slice(0, S) || !newServer.endsWith(server.slice(E))) throw new Error("text outside the moved block changed");
  for (const n of [...MODULE_SCOPE, ...INSIDE]) if (new RegExp("\\b" + n + "\\b").test(newServer)) throw new Error("server.js still mentions " + n);

  const reconcile = {
    sourceLines: moved.split("\n").length,
    firstLine: lineOf(server, S),
    lastLine: lineOf(server, E),
    moduleScope: names(moduleLevel), insideRegister: names(inner), route: "GET /api/snapshot",
    rewrites,
    serverLines: { before: server.split("\n").length, after: newServer.split("\n").length },
  };

  // Test loaders only — every assertion line stays byte-identical.
  // snapshotCheck slices the route and getSnapshotThrottled out of the source
  // text by their column-0 endings ("\n});", "\n}"). The module's text joins
  // the source with the register function's two-space indentation removed, so
  // both slices end exactly where they did.
  const checkTest = replaceOnce(files["test/snapshotCheck.test.js"], 'const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");',
    'const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8") + "\\n" + fs.readFileSync(path.join(__dirname, "..", "routes", "snapshot.js"), "utf8").replace(/^  /gm, "");', "snapshotCheck: source");

  const crealityTest = replaceOnce(files["test/connectors/creality-webrtc-camera.test.js"], 'const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");',
    'const serverSrc = ["server.js", "routes/snapshot.js"].map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\\n");', "creality-webrtc-camera: source");

  let helper = files["test/helpers/snapshotCode.js"];
  helper = replaceOnce(helper, `// TODAY it runs server.js's own source: the contiguous block from the
// "Server-side throttle" comment to the end of the GET /api/snapshot route
// (getSnapshot and checkSnapshot above it are not part of this block and are
// not loaded — getSnapshot is a fake here). When the code moves to a module,
// only loadSource() below changes (docs/refactoring-policy.md §3.7); the
// tests' assertions stay identical.`, `// It runs routes/snapshot.js's own source in a vm context and calls
// registerSnapshotRoutes(app, deps) with the injected dependencies (the code
// moved there from server.js; getSnapshot and checkSnapshot stayed behind —
// getSnapshot is a fake here). docs/refactoring-policy.md §3.7 allows only
// loadSource() below to change, the tests' assertions stay identical.`, "helper: header");
  helper = replaceOnce(helper, `const { routeEnd } = require("./routeEnd");\n`, ``, "helper: unused import");
  helper = replaceOnce(helper, `const SERVER = path.join(__dirname, "..", "..", "server.js");`, `const MODULE = path.join(__dirname, "..", "..", "routes", "snapshot.js");`, "helper: path");
  helper = replaceOnce(helper, `function loadSource(sandbox) {
  const src = fs.readFileSync(SERVER, "utf8");
  const start = src.indexOf("// Server-side throttle for the fleet Camera View's automatic polling");
  const at = src.indexOf('app.get("/api/snapshot"', start);
  if (start < 0 || at < start) throw new Error("Snapshot code not found in server.js");
  vm.runInContext(src.slice(start, routeEnd(src, at) + 4), sandbox, { filename: "server.js (Snapshot)" });
  return {
    setConfig: cfg => { sandbox.CFG = cfg; },
    setPrinters: list => { sandbox.PRINTERS = list; },
  };
}`, `function loadSource(sandbox) {
  // The module's own source runs in the sandbox. It requires nothing; its
  // dependencies arrive as parameters of registerSnapshotRoutes, the
  // configuration and the printer list through getters — nothing is reachable
  // as a global any more.
  const live = { CFG: sandbox.CFG, PRINTERS: sandbox.PRINTERS };
  const deps = { requireAuth: sandbox.requireAuth, getConfig: () => live.CFG, getPrinters: () => live.PRINTERS,
    printerVisibleTo: sandbox.printerVisibleTo, getSnapshot: sandbox.getSnapshot };
  const app = sandbox.app;
  for (const k of ["app", "requireAuth", "printerVisibleTo", "getSnapshot", "CFG", "PRINTERS"]) delete sandbox[k];
  sandbox.module = { exports: {} };
  sandbox.require = name => { throw new Error("routes/snapshot.js required an unexpected module: " + name); };
  vm.runInContext(fs.readFileSync(MODULE, "utf8"), sandbox, { filename: MODULE });
  const exported = Object.keys(sandbox.module.exports);
  if (JSON.stringify(exported) !== '["registerSnapshotRoutes"]') throw new Error("routes/snapshot.js must export registerSnapshotRoutes only, not " + JSON.stringify(exported));
  const returned = sandbox.module.exports.registerSnapshotRoutes(app, deps);
  if (returned !== undefined) throw new Error("registerSnapshotRoutes must return nothing");
  return {
    setConfig: cfg => { live.CFG = cfg; },
    setPrinters: list => { live.PRINTERS = list; },
  };
}`, "helper: loadSource");

  return { __reconcile: reconcile, "server.js": newServer, "routes/snapshot.js": snapshot, "test/snapshotCheck.test.js": checkTest,
    "test/connectors/creality-webrtc-camera.test.js": crealityTest, "test/helpers/snapshotCode.js": helper };
}

function main() {
  const ctx = guard.check();
  const i = process.argv.indexOf("--target");
  const target = checkRepo(ctx, i > 0 ? process.argv[i + 1] : ctx.worktree);
  if (target === ctx.worktree && !process.argv.includes("--execute")) throw new Error("refusing to change this worktree without --execute (owner authorisation for the extraction)");
  const inputs = ["server.js", "test/snapshotCheck.test.js", "test/connectors/creality-webrtc-camera.test.js", "test/helpers/snapshotCode.js"];
  const files = Object.fromEntries(inputs.map(n => [n, fs.readFileSync(path.join(target, n), "utf8")]));
  if (fs.existsSync(path.join(target, "routes", "snapshot.js"))) throw new Error("routes/snapshot.js already exists");
  const out = transform(files);                        // throws before writing anything
  const rec = out.__reconcile; delete out.__reconcile;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifests", "snapshot.json"), "utf8"));
  const moved = [...rec.moduleScope, ...rec.insideRegister, rec.route].sort();
  if (JSON.stringify(moved) !== JSON.stringify([...manifest.moved].sort())) throw new Error("moved items differ from the manifest: " + JSON.stringify(moved));
  if (JSON.stringify(REWRITES) !== JSON.stringify(manifest.rewrites)) throw new Error("the rewrites differ from the manifest's: " + JSON.stringify(REWRITES));
  const { moduleScope, insideRegister, route, rewrites, ...lines } = rec;
  if (JSON.stringify(lines) !== JSON.stringify(manifest.reconciliation.lines)) throw new Error("source range differs from the manifest: " + JSON.stringify(lines));
  if (JSON.stringify(rewrites) !== JSON.stringify(manifest.reconciliation.rewriteOccurrences)) throw new Error("rewrite occurrences differ from the manifest: " + JSON.stringify(rewrites));
  const produced = Object.keys(out).sort(), declared = [...manifest.allowedFiles, ...manifest.newFiles].sort();
  if (JSON.stringify(produced) !== JSON.stringify(declared)) throw new Error("files written differ from the manifest: " + JSON.stringify(produced));
  console.log("reconciled with the manifest: " + JSON.stringify(rec));
  fs.mkdirSync(path.join(target, "routes"), { recursive: true });
  for (const [n, text] of Object.entries(out)) fs.writeFileSync(path.join(target, n), text);
  console.log("written: " + Object.keys(out).join(", "));
}

module.exports = { transform };
if (require.main === module) main();

#!/usr/bin/env node
// tools/refactor/codemods/extract-discover.js — the Discover extraction as a
// mechanical, repeatable transformation (tools/refactor/manifests/discover.json).
//   node tools/refactor/codemods/extract-discover.js --target <dir>
// <dir> must be a validation scratch repository, or this approved worktree
// only once the owner has authorised the extraction (--execute required).
// Exact text moves and no rewrites: the moved code reads none of the bindings
// server.js reassigns. Two slices of server.js move — the "Auto-discovery"
// block up to GET /api/probe-printer, and GET /api/discover with its comment;
// the two routes between them stay where they are, untouched.
// Every anchor must occur exactly once or nothing is written.
"use strict";
const fs = require("fs");
const path = require("path");
const guard = require("../lib/guard");
const { checkRepo } = require("../harness/run");
const { parse } = require("../mapper/map-server");

const DEPS = "requireAdmin, getConnector, listConnectorTypes";
const MODULE_SCOPE = ["ipToInt", "intToIp", "maskToPrefixLen", "MIN_SCAN_PREFIX", "parseSubnetSpec", "SKIP_INTERFACE_RE", "SKIP_ADDRESS_RE",
  "defaultRouteAddress", "scanSubnets", "localSubnets", "DISCOVER_PORTS"];
const INSIDE = ["discoverAt", "discoverIp"];
const INTERNAL = ["ipToInt", "intToIp", "maskToPrefixLen", "parseSubnetSpec", "defaultRouteAddress", "scanSubnets", "localSubnets",
  "MIN_SCAN_PREFIX", "SKIP_INTERFACE_RE", "SKIP_ADDRESS_RE", "DISCOVER_PORTS"];

const once = (s, a, what) => { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error(`anchor not found exactly once (${what}): ${a.slice(0, 70)}`); return i; };
const replaceOnce = (s, a, b, what) => { const i = once(s, a, what); return s.slice(0, i) + b + s.slice(i + a.length); };
const indent = (text, n) => text.split("\n").map(l => (l.length ? " ".repeat(n) + l : l)).join("\n");
const lineOf = (s, i) => s.slice(0, i).split("\n").length;
const names = text => parse(text).get().node.program.body.map(st => (st.type === "FunctionDeclaration" ? st.id.name : st.type === "VariableDeclaration" ? st.declarations[0].id.name : st.type));

const DGRAM = `// Used only to ask the OS which adapter carries the default route (see
// defaultRouteAddress) — no packets are ever sent.
const dgram = require("dgram");
`;

function transform(files) {
  const server = files["server.js"];
  // Slice (a): the "Auto-discovery" header … discoverIp. Ends where GET /api/probe-printer begins.
  const A = once(server, "// ---- Auto-discovery: scan the local subnet(s) for Moonraker printers ----", "slice a start");
  const INNER = once(server, "// Tries every connector that supports discovery (discoverAt is optional —", "discoverAt comment");
  const P = once(server, 'app.get("/api/probe-printer", requireAdmin, async (req, res) => {', "probe-printer (stays)");
  // Slice (b): the streaming comment and the route.
  const B = once(server, "// A sweep of 254 addresses takes long enough that a motionless \"Scanning…\" box", "slice b start");
  const R = once(server, 'app.get("/api/discover", requireAdmin, async (req, res) => {', "route start");
  const E = server.indexOf("\n});\n", R) + 4;          // end of the route: "});"
  const D = once(server, DGRAM, "dgram require");
  if (!(D < A && A < INNER && INNER < P && P < B && B < R && R < E)) throw new Error("block boundaries out of order");
  const between = server.slice(P, B);                  // probe-printer and test-connection: must stay byte-identical
  if (!between.includes('app.post("/api/test-connection", requireAdmin, async (req, res) => {')) throw new Error("test-connection not found between the two slices");

  const moduleLevel = server.slice(A, INNER);          // header comment … DISCOVER_PORTS
  const inner = server.slice(INNER, P);                // discoverAt, discoverIp (ends "}\n")
  const route = server.slice(B, E);                    // streaming comment + app.get(…) … });
  if (JSON.stringify(names(moduleLevel)) !== JSON.stringify(MODULE_SCOPE)) throw new Error("unexpected module-scope statements: " + JSON.stringify(names(moduleLevel)));
  if (JSON.stringify(names(inner)) !== JSON.stringify(INSIDE)) throw new Error("unexpected statements before probe-printer: " + JSON.stringify(names(inner)));
  if (JSON.stringify(names(route)) !== JSON.stringify(["ExpressionStatement"])) throw new Error("slice b is not exactly one route");
  for (const n of ["CFG", "PRINTERS", "FOLDER", "USERS"]) if (new RegExp("\\b" + n + "\\b").test(moduleLevel + inner + route)) throw new Error("the moved code reads " + n + " — a rewrite would be needed");

  const discover = [
    "// routes/discover.js — GET /api/discover and its helpers, moved from server.js",
    "// (docs/refactoring-policy.md; tools/refactor/manifests/discover.json).",
    "// No \"use strict\": server.js runs in sloppy mode and the moved code keeps it.",
    "// server.js requires this module and calls registerDiscoverRoutes() at the",
    "// route's original position, so the order of the routes is unchanged. The",
    "// constants and the functions that need nothing from server.js stay at module",
    "// scope, text unchanged; discoverAt, discoverIp and the route live inside",
    "// registerDiscoverRoutes, where requireAdmin and the connector registry are",
    "// parameters. The module owns no mutable state.",
    "const os = require(\"os\");",
    DGRAM.replace(/\n$/, ""),
    "",
    moduleLevel.replace(/\n+$/, ""),
    "",
    `function registerDiscoverRoutes(app, { ${DEPS} }) {`,
    indent(inner.replace(/\n+$/, ""), 2),
    "",
    indent(route, 2),
    "}",
    "",
    "// _internal: the test seam (the connectors' convention), used by",
    "// test/helpers/discoverCode.js. server.js uses registerDiscoverRoutes only.",
    "module.exports = { registerDiscoverRoutes,",
    `  _internal: { ${INTERNAL.slice(0, 7).join(", ")},`,
    `    ${INTERNAL.slice(7).join(", ")} } };`,
    "",
  ].join("\n");

  const registration = [
    "// ---- Auto-discovery: GET /api/discover and its helpers live in",
    "// routes/discover.js. Required and registered here, at the route's original",
    "// position, so the order of the routes is unchanged (docs/refactoring-policy.md). ----",
    'const { registerDiscoverRoutes } = require("./routes/discover");',
    `registerDiscoverRoutes(app, { ${DEPS} });`,
  ].join("\n");
  // Applied back to front so the earlier indexes stay valid.
  let newServer = server.slice(0, B) + registration + server.slice(E);
  newServer = newServer.slice(0, A) + newServer.slice(P);
  newServer = newServer.slice(0, D) + newServer.slice(D + DGRAM.length);
  if (!newServer.includes(between)) throw new Error("probe-printer / test-connection text changed");
  if (/\bdgram\b/.test(newServer)) throw new Error("server.js still mentions dgram");

  const reconcile = {
    sliceA: { firstLine: lineOf(server, A), lastLine: lineOf(server, P) - 1 },
    sliceB: { firstLine: lineOf(server, B), lastLine: lineOf(server, E) },
    dgramLines: { firstLine: lineOf(server, D), lastLine: lineOf(server, D + DGRAM.length) - 1 },
    keptBetween: { firstLine: lineOf(server, P), lastLine: lineOf(server, B) - 1 },
    moduleScope: names(moduleLevel), insideRegister: names(inner), route: "GET /api/discover",
    serverLines: { before: server.split("\n").length, after: newServer.split("\n").length },
  };

  // Test loaders only — every assertion line stays byte-identical.
  let subnets = files["test/discoverySubnets.test.js"];
  subnets = replaceOnce(subnets, 'const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");',
    'const serverSrc = fs.readFileSync(path.join(ROOT, "routes", "discover.js"), "utf8");', "discoverySubnets: source");
  subnets = replaceOnce(subnets, '  const route = serverSrc.slice(at, serverSrc.indexOf("\\n});", at));',
    '  const route = serverSrc.slice(at, serverSrc.indexOf("\\n  });", at));', "discoverySubnets: route end");

  // connectorCoreMethods generates one test per optional connector method the
  // scanned source calls; without routes/discover.js, discoverAt's test would
  // silently stop being generated.
  const coreTest = replaceOnce(files["test/connectorCoreMethods.test.js"], 'const serverSrc = ["server.js", "routes/health.js"].map(',
    'const serverSrc = ["server.js", "routes/health.js", "routes/discover.js"].map(', "connectorCoreMethods: source");

  let helper = files["test/helpers/discoverCode.js"];
  helper = replaceOnce(helper, `// TODAY it runs server.js's own source: the block from the "Auto-discovery"
// header up to GET /api/probe-printer, and the GET /api/discover route (the
// two routes between them are not part of Discover and are not loaded). When
// the code moves to a module, only loadSource() below changes
// (docs/refactoring-policy.md §3.7); the tests' assertions stay identical.`, `// It runs routes/discover.js's own source in a vm context and calls
// registerDiscoverRoutes(app, deps) with the injected dependencies (the code
// moved there from server.js; docs/refactoring-policy.md §3.7 allows only
// loadSource() below to change, the tests' assertions stay identical).`, "helper: header");
  helper = replaceOnce(helper, `const { routeEnd } = require("./routeEnd");\n`, ``, "helper: unused import");
  helper = replaceOnce(helper, `const SERVER = path.join(__dirname, "..", "..", "server.js");`, `const MODULE = path.join(__dirname, "..", "..", "routes", "discover.js");`, "helper: path");
  helper = replaceOnce(helper, `function loadSource(sandbox) {
  const src = fs.readFileSync(SERVER, "utf8");
  const start = src.indexOf("// ---- Auto-discovery: scan the local subnet(s) for Moonraker printers ----");
  const stop = src.indexOf('app.get("/api/probe-printer"', start);
  const at = src.indexOf('app.get("/api/discover"', stop);
  if (start < 0 || stop < start || at < stop) throw new Error("Discover code not found in server.js");
  vm.runInContext(src.slice(start, stop) + "\\n" + src.slice(at, routeEnd(src, at) + 4), sandbox, { filename: "server.js (Discover)" });
  return Object.fromEntries(INTERNAL.map(n => [n, vm.runInContext(n, sandbox)]));
}`, `function loadSource(sandbox) {
  // The module's own source runs in the sandbox. Its two requires (os, dgram)
  // resolve to the fakes; its dependencies arrive as parameters of
  // registerDiscoverRoutes — nothing is reachable as a global any more.
  const fakes = { os: sandbox.os, dgram: sandbox.dgram };
  const deps = { requireAdmin: sandbox.requireAdmin, getConnector: sandbox.getConnector, listConnectorTypes: sandbox.listConnectorTypes };
  const app = sandbox.app;
  for (const k of ["os", "dgram", "app", "requireAdmin", "getConnector", "listConnectorTypes"]) delete sandbox[k];
  sandbox.module = { exports: {} };
  sandbox.require = name => { if (!(name in fakes)) throw new Error("routes/discover.js required an unexpected module: " + name); return fakes[name]; };
  vm.runInContext(fs.readFileSync(MODULE, "utf8"), sandbox, { filename: MODULE });
  const { registerDiscoverRoutes, _internal } = sandbox.module.exports;
  const returned = registerDiscoverRoutes(app, deps);
  if (returned !== undefined) throw new Error("registerDiscoverRoutes must return nothing");
  for (const n of INTERNAL) if (!(n in _internal)) throw new Error("_internal is missing " + n);
  return _internal;
}`, "helper: loadSource");

  return { __reconcile: reconcile, "server.js": newServer, "routes/discover.js": discover, "test/discoverySubnets.test.js": subnets,
    "test/connectorCoreMethods.test.js": coreTest, "test/helpers/discoverCode.js": helper };
}

function main() {
  const ctx = guard.check();
  const i = process.argv.indexOf("--target");
  const target = checkRepo(ctx, i > 0 ? process.argv[i + 1] : ctx.worktree);
  if (target === ctx.worktree && !process.argv.includes("--execute")) throw new Error("refusing to change this worktree without --execute (owner authorisation for the extraction)");
  const inputs = ["server.js", "test/discoverySubnets.test.js", "test/connectorCoreMethods.test.js", "test/helpers/discoverCode.js"];
  const files = Object.fromEntries(inputs.map(n => [n, fs.readFileSync(path.join(target, n), "utf8")]));
  if (fs.existsSync(path.join(target, "routes", "discover.js"))) throw new Error("routes/discover.js already exists");
  const out = transform(files);                        // throws before writing anything
  const rec = out.__reconcile; delete out.__reconcile;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifests", "discover.json"), "utf8"));
  const moved = [...rec.moduleScope, ...rec.insideRegister, rec.route].sort();
  if (JSON.stringify(moved) !== JSON.stringify([...manifest.moved].sort())) throw new Error("moved items differ from the manifest: " + JSON.stringify(moved));
  const { moduleScope, insideRegister, route, ...lines } = rec;
  if (JSON.stringify(lines) !== JSON.stringify(manifest.reconciliation.lines)) throw new Error("source ranges differ from the manifest: " + JSON.stringify(lines));
  const produced = Object.keys(out).sort(), declared = [...manifest.allowedFiles, ...manifest.newFiles].sort();
  if (JSON.stringify(produced) !== JSON.stringify(declared)) throw new Error("files written differ from the manifest: " + JSON.stringify(produced));
  console.log("reconciled with the manifest: " + JSON.stringify(rec));
  fs.mkdirSync(path.join(target, "routes"), { recursive: true });
  for (const [n, text] of Object.entries(out)) fs.writeFileSync(path.join(target, n), text);
  console.log("written: " + Object.keys(out).join(", "));
}

module.exports = { transform };
if (require.main === module) main();

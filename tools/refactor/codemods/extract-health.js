#!/usr/bin/env node
// tools/refactor/codemods/extract-health.js — the Health extraction as a
// mechanical, repeatable transformation (tools/refactor/manifests/health.json).
//   node tools/refactor/codemods/extract-health.js --target <dir>
// <dir> must be a validation scratch repository, or this approved worktree
// only once the owner has authorised the extraction (--execute required).
// Exact text moves; the only rewrites are the declared CFG -> getConfig() and
// PRINTERS -> getPrinters() (scope-aware, lib/identity.js applyRewrites).
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
const DEPS = "requireAuth, getConfig, getPrinters, getConnector, printerVisibleTo, probeCached, computeMaintenanceAttention, connHttp";

const once = (s, a, what) => { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error(`anchor not found exactly once (${what}): ${a.slice(0, 70)}`); return i; };
const replaceOnce = (s, a, b, what) => { const i = once(s, a, what); return s.slice(0, i) + b + s.slice(i + a.length); };
const indent = (text, n) => text.split("\n").map(l => (l.length ? " ".repeat(n) + l : l)).join("\n");

function transform(files) {
  const server = files["server.js"];
  const S = once(server, "// ---- Health diagnostics: single-printer, on-demand only (the Health page", "block start");
  const R = once(server, 'app.get("/api/health", requireAuth, async (req, res) => {', "route start");
  const E = server.indexOf("\n});\n", R) + 4;          // end of the route: "});"
  if (!(S < R && R < E)) throw new Error("block boundaries out of order");
  const helpers = server.slice(S, R);                  // header comment … HEALTH_TIMED_OUT
  const route = server.slice(R, E);                    // app.get(…) … });

  // Split the module-level part statement by statement. Each chunk runs from
  // the end of the previous statement's line to the end of its own line, so
  // a statement keeps its leading comments and any same-line comment.
  // Constants and the two Maps stay at module scope (created once, at require
  // time); function declarations move inside registerHealthRoutes, where the
  // injected dependencies are parameters — no module-level dependency slots.
  const body = parse(helpers).get().node.program.body;
  const lineEnd = i => { const n = helpers.indexOf("\n", i); return n < 0 ? helpers.length : n; };
  const moduleChunks = [], innerChunks = [];
  let from = 0;
  for (const st of body) {
    const to = lineEnd(st.end);
    const chunk = helpers.slice(from, to);
    (st.type === "FunctionDeclaration" ? innerChunks : moduleChunks).push({ text: chunk, name: st.id ? st.id.name : st.declarations[0].id.name, type: st.type });
    from = to;
  }
  if (helpers.slice(from).trim()) throw new Error("unexpected trailing text after the last moved statement");
  const fnNames = innerChunks.map(c => c.name);
  const trimLead = t => t.replace(/^\n+/, "");
  const health = [
    "// routes/health.js — GET /api/health and its helpers, moved from server.js",
    "// (docs/refactoring-policy.md; tools/refactor/manifests/health.json).",
    "// No \"use strict\": server.js runs in sloppy mode and the moved code keeps it.",
    "// server.js requires this module and calls registerHealthRoutes() at the",
    "// route's original position, so start-up order is unchanged. The constants",
    "// and the two Maps (fanMismatchSeen, heaterStableSince) stay at module scope:",
    "// created once when the module is required, kept for the process lifetime,",
    "// not reset by config reloads. The helpers live inside registerHealthRoutes,",
    "// where the injected dependencies are parameters; CFG and PRINTERS",
    "// (reassigned by loadConfig) are read through getConfig() / getPrinters().",
    "",
    trimLead(moduleChunks.map(c => applyRewrites(c.text, REWRITES)).join("")),
    "",
    `function registerHealthRoutes(app, { ${DEPS} }) {`,
    indent(trimLead(innerChunks.map(c => applyRewrites(c.text, REWRITES)).join("")), 2),
    "",
    indent(applyRewrites(route, REWRITES), 2),
    "",
    "  // Returned for test/helpers/healthCode.js, which exercises the helpers",
    "  // directly; server.js ignores the return value.",
    `  return { ${fnNames.join(", ")} };`,
    "}",
    "",
    "module.exports = { registerHealthRoutes };",
    "",
  ].join("\n");

  // Reconciliation with the manifest: the exact range and the moved items.
  const reconcile = {
    sourceLines: server.slice(S, E).split("\n").length,
    firstLine: server.slice(0, S).split("\n").length,
    lastLine: server.slice(0, E).split("\n").length,
    moduleScope: moduleChunks.map(c => c.name),
    insideRegister: fnNames,
    route: "GET /api/health",
    rewrites: { CFG: (helpers + route).match(/\bCFG\b/g).length, PRINTERS: (helpers + route).match(/\bPRINTERS\b/g).length },
  };

  const registration = [
    "// ---- Health diagnostics: GET /api/health and its helpers live in",
    "// routes/health.js. Required and registered here, at the route's original",
    "// position, so start-up order is unchanged (docs/refactoring-policy.md). ----",
    'const { registerHealthRoutes } = require("./routes/health");',
    "registerHealthRoutes(app, { requireAuth, getConfig: () => CFG, getPrinters: () => PRINTERS, getConnector, printerVisibleTo, probeCached, computeMaintenanceAttention, connHttp });",
  ].join("\n");
  const newServer = server.slice(0, S) + registration + server.slice(E);

  const dockerfile = replaceOnce(files["Dockerfile"], "COPY netfs ./netfs\n", "COPY netfs ./netfs\nCOPY routes ./routes\n", "Dockerfile");

  // Test loaders only — every assertion line stays byte-identical.
  let routeTest = files["test/healthRoute.test.js"];
  routeTest = replaceOnce(routeTest, 'const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");',
    'const serverSrc = ["server.js", "routes/health.js"].map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\\n");', "healthRoute: source");
  routeTest = replaceOnce(routeTest, '  const src = serverSrc.slice(start, routeEnd(serverSrc, at) + 4).replace("const HEALTH_DEADLINE_MS = 25 * 1000;", `const HEALTH_DEADLINE_MS = ${DEADLINE_MS};`);',
    '  const src = serverSrc.slice(start, serverSrc.indexOf("function registerHealthRoutes", start)).replace("const HEALTH_DEADLINE_MS = 25 * 1000;", `const HEALTH_DEADLINE_MS = ${DEADLINE_MS};`) + serverSrc.slice(at, serverSrc.indexOf("\\n  });\\n", at) + 6).replace(/^  /gm, "");', "healthRoute: slice");
  routeTest = replaceOnce(routeTest, "    PRINTERS: [P], printerVisibleTo: () => true, getConnector: () => conn, CFG: {},",
    "    getPrinters: () => [P], printerVisibleTo: () => true, getConnector: () => conn, getConfig: () => ({}),", "healthRoute: sandbox");

  const maintTest = replaceOnce(files["test/health-maintenance.test.js"], 'const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");',
    'const src = ["server.js", "routes/health.js"].map(f => fs.readFileSync(path.join(__dirname, "..", f), "utf8")).join("\\n");', "health-maintenance: source");

  // connectorCoreMethods generates one test per optional connector method that
  // the scanned source calls; without routes/health.js, getHealth's test would
  // silently stop being generated.
  const coreTest = replaceOnce(files["test/connectorCoreMethods.test.js"], 'const serverSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");',
    'const serverSrc = ["server.js", "routes/health.js"].map(f => require("fs").readFileSync(require("path").join(__dirname, "..", f), "utf8")).join("\\n");', "connectorCoreMethods: source");

  let helper = files["test/helpers/healthCode.js"];
  helper = replaceOnce(helper, `// TODAY it runs server.js's own source: the contiguous block from
// \`const DISK_CRITICAL_PCT\` to the end of the route, in a vm context. The
// refactoring policy (docs/refactoring-policy.md §3.7) allows only this
// loader to change when the code moves into a module; the tests' assertions
// must stay identical.`, `// It runs routes/health.js's own source in a vm context and calls
// registerHealthRoutes(app, deps) with the injected dependencies (the code
// moved there from server.js; docs/refactoring-policy.md §3.7 allows only
// this loader to change, the tests' assertions stay identical).`, "helper: header");
  helper = replaceOnce(helper, `const SERVER = path.join(__dirname, "..", "..", "server.js");
const START = "const DISK_CRITICAL_PCT = 0.05;";
const ROUTE = 'app.get("/api/health", requireAuth';`, `const MODULE = path.join(__dirname, "..", "..", "routes", "health.js");`, "helper: paths");
  helper = replaceOnce(helper, `  const src = fs.readFileSync(SERVER, "utf8");
  const start = src.indexOf(START), at = src.indexOf(ROUTE, start);
  if (start < 0 || at < start) throw new Error("Health code not found in server.js");
  const code = src.slice(start, routeEnd(src, at) + 4);`, `  const code = fs.readFileSync(MODULE, "utf8");`, "helper: code");
  helper = replaceOnce(helper, `    app: { get: (p, ...handlers) => routes.push({ method: "GET", path: p, handlers }) },
    requireAuth: over.requireAuth || ((req, res, next) => next()),
    PRINTERS: over.printers || [],
    CFG: over.config || {},`, `    module: { exports: {} },
    app: { get: (p, ...handlers) => routes.push({ method: "GET", path: p, handlers }) },
    requireAuth: over.requireAuth || ((req, res, next) => next()),
    PRINTERS: over.printers || [],
    CFG: over.config || {},`, "helper: sandbox");
  helper = replaceOnce(helper, `;this.__health = { annotateHeaterStates, annotateGcodeUnusedCount, computeHealthAttention, checkFanMismatch,
  heaterStableSince,`, `;const __helpers = registerHealthRoutes(app, { requireAuth: this.requireAuth, getConfig: () => this.CFG, getPrinters: () => this.PRINTERS,
  getConnector: this.getConnector, printerVisibleTo: this.printerVisibleTo, probeCached: this.probeCached,
  computeMaintenanceAttention: this.computeMaintenanceAttention, connHttp: this.connHttp });
this.__health = { ...__helpers,
  heaterStableSince,`, "helper: register");
  helper = replaceOnce(helper, `const { routeEnd } = require("./routeEnd");\n`, ``, "helper: unused import");

  return { __reconcile: reconcile, "server.js": newServer, "routes/health.js": health, "Dockerfile": dockerfile, "test/healthRoute.test.js": routeTest,
    "test/health-maintenance.test.js": maintTest, "test/connectorCoreMethods.test.js": coreTest, "test/helpers/healthCode.js": helper };
}

function main() {
  const ctx = guard.check();
  const i = process.argv.indexOf("--target");
  const target = checkRepo(ctx, i > 0 ? process.argv[i + 1] : ctx.worktree);
  if (target === ctx.worktree && !process.argv.includes("--execute")) throw new Error("refusing to change this worktree without --execute (owner authorisation for Phase 3)");
  const names = ["server.js", "Dockerfile", "test/healthRoute.test.js", "test/health-maintenance.test.js", "test/connectorCoreMethods.test.js", "test/helpers/healthCode.js"];
  const files = Object.fromEntries(names.map(n => [n, fs.readFileSync(path.join(target, n), "utf8")]));
  if (fs.existsSync(path.join(target, "routes", "health.js"))) throw new Error("routes/health.js already exists");
  const out = transform(files);                        // throws before writing anything
  const rec = out.__reconcile; delete out.__reconcile;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifests", "health.json"), "utf8"));
  const moved = [...rec.moduleScope, ...rec.insideRegister, rec.route].sort();
  if (JSON.stringify(moved) !== JSON.stringify([...manifest.moved].sort())) throw new Error("moved items differ from the manifest: " + JSON.stringify(moved));
  if (rec.sourceLines !== manifest.reconciliation.sourceLines || rec.firstLine !== manifest.reconciliation.firstLine || rec.lastLine !== manifest.reconciliation.lastLine) throw new Error("source range differs from the manifest: " + JSON.stringify(rec));
  if (JSON.stringify(rec.rewrites) !== JSON.stringify(manifest.reconciliation.rewriteOccurrences)) throw new Error("rewrite occurrences differ from the manifest: " + JSON.stringify(rec.rewrites));
  console.log("reconciled with the manifest: " + JSON.stringify(rec));
  fs.mkdirSync(path.join(target, "routes"), { recursive: true });
  for (const [n, text] of Object.entries(out)) fs.writeFileSync(path.join(target, n), text);
  console.log("written: " + Object.keys(out).join(", "));
}

module.exports = { transform };
if (require.main === module) main();

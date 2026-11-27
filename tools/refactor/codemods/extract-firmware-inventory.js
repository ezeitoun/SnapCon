#!/usr/bin/env node
// tools/refactor/codemods/extract-firmware-inventory.js — the firmware
// inventory extraction as a mechanical, repeatable transformation
// (tools/refactor/manifests/firmware-inventory.json).
//   node tools/refactor/codemods/extract-firmware-inventory.js --target <dir>
// <dir> must be a validation scratch repository, or this approved worktree
// only once the owner has authorised the extraction (--execute required).
// One contiguous block of server.js moves: the "Firmware inventory" header
// comment, firmwareTabEligible, FW_PROBE_TIMEOUT_MS, probeFirmware and GET
// /api/firmware. Exact text moves; the only rewrite is the declared
// PRINTERS -> getPrinters() (scope-aware, lib/identity.js applyRewrites).
// Firmware DEPLOYMENT is excluded: every /api/firmware-* route and its state
// stay in server.js, and the codemod refuses if the moved text reads any of it.
// Every anchor must occur exactly once or nothing is written.
"use strict";
const fs = require("fs");
const path = require("path");
const guard = require("../lib/guard");
const { checkRepo } = require("../harness/run");
const { applyRewrites } = require("../lib/identity");
const { parse } = require("../mapper/map-server");

const REWRITES = [{ from: "PRINTERS", to: "getPrinters()" }];
const DEPS = "requireAuth, getPrinters, printerVisibleTo, getConnector, getCapabilities, probeCached";
const MODULE_SCOPE = ["FW_PROBE_TIMEOUT_MS"];
const INSIDE = ["firmwareTabEligible", "probeFirmware"];
// The deployment routes: each must be in server.js exactly once before and after.
const DEPLOY_ROUTES = ['app.get("/api/firmware-files", requireAdmin,', 'app.get("/api/firmware-inspect", requireAdmin,', 'app.post("/api/firmware-deploy", requireAdmin,',
  'app.post("/api/firmware-options", requireAdmin,', 'app.post("/api/firmware-stop", requireAdmin,', 'app.get("/api/firmware-status", requireAdmin,',
  'app.get("/api/firmware-deploy-status", requireAdmin,'];
// The Health registration that follows the moved block: byte-identical before and after.
const HEALTH_AFTER = `

// ---- Health diagnostics: GET /api/health and its helpers live in
// routes/health.js. Required and registered here, at the route's original
// position, so start-up order is unchanged (docs/refactoring-policy.md). ----
const { registerHealthRoutes } = require("./routes/health");
registerHealthRoutes(app, { requireAuth, getConfig: () => CFG, getPrinters: () => PRINTERS, getConnector, printerVisibleTo, probeCached, computeMaintenanceAttention, connHttp });
`;

const once = (s, a, what) => { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error(`anchor not found exactly once (${what}): ${a.slice(0, 70)}`); return i; };
const replaceOnce = (s, a, b, what) => { const i = once(s, a, what); return s.slice(0, i) + b + s.slice(i + a.length); };
const replaceExactly = (s, a, b, n, what) => { const parts = s.split(a); if (parts.length !== n + 1) throw new Error(`anchor not found exactly ${n} times (${what}): ${a.slice(0, 70)}`); return parts.join(b); };
const indent = (text, n) => text.split("\n").map(l => (l.length ? " ".repeat(n) + l : l)).join("\n");
const lineOf = (s, i) => s.slice(0, i).split("\n").length;
const count = (s, re) => (s.match(re) || []).length;
const names = text => parse(text).get().node.program.body.map(st => (st.type === "FunctionDeclaration" ? st.id.name : st.type === "VariableDeclaration" ? st.declarations[0].id.name : st.type));
const sameNames = (text, expected, what) => { const got = names(text); if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`unexpected statements (${what}): ${JSON.stringify(got)}`); };

function transform(files) {
  const server = files["server.js"];
  // The block, in source order: header comment · firmwareTabEligible · the
  // timeout constant · probeFirmware · the route. Each part starts at the
  // first line of its own comment.
  const S = once(server, "// ---- Firmware inventory (same Moonraker APIs fluidd reads) ----", "block start");
  const EL = once(server, "// Which printers the Firmware tab lists at all. firmwareDeploy is the", "firmwareTabEligible comment");
  const C = once(server, "// One unreachable printer must cost one row, not the whole inventory", "FW_PROBE_TIMEOUT_MS comment");
  const PF = once(server, "// Always resolves to a row. Never throws, never outruns its timeout.", "probeFirmware comment");
  const R = once(server, 'app.get("/api/firmware", requireAuth, async (req, res) => {', "route start");
  const E = server.indexOf("\n});\n", R) + 4;          // end of the route: "});"
  if (!(S < EL && EL < C && C < PF && PF < R && R < E)) throw new Error("block boundaries out of order");
  if (server.slice(E, E + HEALTH_AFTER.length) !== HEALTH_AFTER) throw new Error("the Health registration does not directly follow the moved block");
  once(server, HEALTH_AFTER, "Health registration");
  for (const a of DEPLOY_ROUTES) { const i = once(server, a, "deployment route (stays)"); if (i >= S && i < E) throw new Error("a deployment route is inside the moved block: " + a); }

  const header = server.slice(S, EL);                  // the section comment and its blank line
  const eligible = server.slice(EL, C);                // comment + firmwareTabEligible
  const constant = server.slice(C, PF);                // comment + FW_PROBE_TIMEOUT_MS
  const probe = server.slice(PF, R);                   // comment + probeFirmware
  const route = server.slice(R, E);                    // app.get(…) … });
  sameNames(header, [], "header comment");
  sameNames(eligible, ["firmwareTabEligible"], "before the constant");
  sameNames(constant, MODULE_SCOPE, "the constant");
  sameNames(probe, ["probeFirmware"], "before the route");
  sameNames(route, ["ExpressionStatement"], "the route");
  const moved = server.slice(S, E);
  // Refused, not rewritten: anything the declared rewrite does not cover, and
  // every piece of firmware-deployment state.
  for (const n of ["CFG", "FOLDER", "USERS"]) if (new RegExp("\\b" + n + "\\b").test(moved)) throw new Error("the moved code reads " + n + " — an undeclared rewrite would be needed");
  const fw = moved.match(/\bFW_(?!PROBE_TIMEOUT_MS\b)\w+|\bfw(?:BusyWith|Draining)\b/);
  if (fw) throw new Error("the moved code reads firmware-deployment state: " + fw[0]);
  if (/\bFW_STATE\b|\bFW_QUEUE\b|\bFW_RUNNING\b|\bFW_STOP_REQUESTED\b/.test(moved)) throw new Error("the moved code reads firmware-deployment state");
  if (/\bPRINTERS\b/.test(header + constant)) throw new Error("PRINTERS outside the parts that are rewritten");
  if (/\brequire\s*\(/.test(moved)) throw new Error("the moved code requires a module");

  const rw = text => applyRewrites(text, REWRITES);
  const innerText = rw(eligible) + rw(probe), routeText = rw(route);
  const rewritten = count(innerText + routeText, /\bgetPrinters\(\)/g);
  if (/\bPRINTERS\b/.test(innerText + routeText)) throw new Error("a PRINTERS reference was not rewritten (a comment or a local of that name?)");

  const moduleText = [
    "// routes/firmwareInventory.js — the read-only firmware inventory: the",
    "// /api/firmware GET route and its helpers, moved from server.js",
    "// (docs/refactoring-policy.md; tools/refactor/manifests/firmware-inventory.json).",
    "// No \"use strict\": server.js runs in sloppy mode and the moved code keeps it.",
    "// server.js requires this module and calls registerFirmwareInventoryRoutes()",
    "// at the route's original position, so start-up order is unchanged. The",
    "// timeout constant stays at module scope, text unchanged; the two helpers and",
    "// the route live inside registerFirmwareInventoryRoutes, where the injected",
    "// dependencies are parameters, and PRINTERS (reassigned by loadConfig) is read",
    "// through getPrinters() at every use. The module owns no mutable state.",
    "// Firmware DEPLOYMENT (the /api/firmware-* routes and their state) is not",
    "// here: it stays in server.js.",
    "",
    header.replace(/\n+$/, ""),
    "",
    constant.replace(/\n+$/, ""),
    "",
    `function registerFirmwareInventoryRoutes(app, { ${DEPS} }) {`,
    indent(innerText.replace(/\n+$/, ""), 2),
    "",
    indent(routeText, 2),
    "}",
    "",
    "module.exports = { registerFirmwareInventoryRoutes };",
    "",
  ].join("\n");

  const registration = [
    "// ---- Firmware inventory: GET /api/firmware and its helpers live in",
    "// routes/firmwareInventory.js. Required and registered here, at the route's",
    "// original position, so start-up order is unchanged",
    "// (docs/refactoring-policy.md). Firmware deployment stays in this file. ----",
    'const { registerFirmwareInventoryRoutes } = require("./routes/firmwareInventory");',
    "registerFirmwareInventoryRoutes(app, { requireAuth, getPrinters: () => PRINTERS, printerVisibleTo, getConnector, getCapabilities, probeCached });",
  ].join("\n");
  const newServer = server.slice(0, S) + registration + server.slice(E);
  // Everything outside the block is byte-identical; the Health registration
  // still directly follows; the deployment routes are all still there, once.
  if (!newServer.startsWith(server.slice(0, S)) || !newServer.endsWith(server.slice(E))) throw new Error("text outside the moved block changed");
  if (newServer.slice(S + registration.length, S + registration.length + HEALTH_AFTER.length) !== HEALTH_AFTER) throw new Error("the Health registration no longer directly follows");
  once(newServer, HEALTH_AFTER, "Health registration (after)");
  for (const a of DEPLOY_ROUTES) once(newServer, a, "deployment route (after)");
  for (const n of [...MODULE_SCOPE, ...INSIDE]) if (new RegExp("\\b" + n + "\\b").test(newServer)) throw new Error("server.js still mentions " + n);
  if (newServer.includes('app.get("/api/firmware",')) throw new Error("server.js still registers GET /api/firmware");
  sameNames(moduleText, [...MODULE_SCOPE, "registerFirmwareInventoryRoutes", "ExpressionStatement"], "the new module's top level");

  const reconcile = {
    firstLine: lineOf(server, S), lastLine: lineOf(server, E), sourceLines: moved.split("\n").length,
    parts: { header: lineOf(server, S), firmwareTabEligible: lineOf(server, EL), FW_PROBE_TIMEOUT_MS: lineOf(server, C), probeFirmware: lineOf(server, PF), route: lineOf(server, R) },
    moduleScope: names(constant), insideRegister: [...names(eligible), ...names(probe)], route: "GET /api/firmware",
    rewriteOccurrences: { PRINTERS: count(moved, /\bPRINTERS\b/g), rewritten },
    serverLines: { before: server.split("\n").length, after: newServer.split("\n").length },
  };

  // Test loaders only — every assertion line stays byte-identical.
  let inv = files["test/firmwareInventory.test.js"];
  inv = replaceOnce(inv, 'const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");',
    'const serverSrc = fs.readFileSync(path.join(ROOT, "routes", "firmwareInventory.js"), "utf8");', "firmwareInventory: source");
  inv = replaceOnce(inv, '  return serverSrc.slice(at, serverSrc.indexOf("\\n}", at) + 2);',
    '  return serverSrc.slice(at, serverSrc.indexOf("\\n  }", at) + 4);', "firmwareInventory: function end");
  inv = replaceExactly(inv, '  const route = serverSrc.slice(start, serverSrc.indexOf("\\napp.", start + 10));',
    '  const route = serverSrc.slice(start, serverSrc.indexOf("\\n  });", start + 10));', 2, "firmwareInventory: route end");

  // The rest of firmwareDeploy.test.js reads deployment code that stays in
  // server.js, so its serverSrc stays; only this one slice reads the route.
  const deploy = replaceOnce(files["test/firmwareDeploy.test.js"], `  const route = serverSrc.slice(serverSrc.indexOf('app.get("/api/firmware", requireAuth'),
                                serverSrc.indexOf("// ---- Health diagnostics"));`, `  const inventorySrc = fs.readFileSync(path.join(__dirname, "..", "routes", "firmwareInventory.js"), "utf8"), routeAt = inventorySrc.indexOf('app.get("/api/firmware", requireAuth');
  const route = inventorySrc.slice(routeAt, inventorySrc.indexOf("\\n  });\\n", routeAt));`, "firmwareDeploy: route slice");

  // connectorCoreMethods generates one test per optional connector method the
  // scanned source calls and checks the method is tested before it is called;
  // probeFirmware's getFirmwareInfo call and its guard move, so the new module
  // joins the scanned sources.
  const coreTest = replaceOnce(files["test/connectorCoreMethods.test.js"], 'const serverSrc = ["server.js", "routes/health.js", "routes/discover.js"].map(',
    'const serverSrc = ["server.js", "routes/health.js", "routes/discover.js", "routes/firmwareInventory.js"].map(', "connectorCoreMethods: source");

  let helper = files["test/helpers/firmwareInventoryCode.js"];
  helper = replaceOnce(helper, `// TODAY it runs server.js's own source: the block from the "Firmware
// inventory" header to the end of the GET /api/firmware route, in a vm
// context where everything the code reaches is a global supplied here. When
// the code moves to a module, only loadSource() below changes
// (docs/refactoring-policy.md §3.7); the tests' assertions stay identical.`, `// It runs routes/firmwareInventory.js's own source in a vm context and calls
// registerFirmwareInventoryRoutes(app, deps) with the injected dependencies
// (the code moved there from server.js; docs/refactoring-policy.md §3.7 allows
// only loadSource() below to change, the tests' assertions stay identical).`, "helper: header");
  helper = replaceOnce(helper, `const { routeEnd } = require("./routeEnd");\n`, ``, "helper: unused import");
  helper = replaceOnce(helper, `const SERVER = path.join(__dirname, "..", "..", "server.js");`, `const MODULE = path.join(__dirname, "..", "..", "routes", "firmwareInventory.js");`, "helper: path");
  helper = replaceOnce(helper, `function loadSource(sandbox, fakes, world) {
  const src = fs.readFileSync(SERVER, "utf8");
  const start = src.indexOf("// ---- Firmware inventory (same Moonraker APIs fluidd reads) ----");
  const at = src.indexOf('app.get("/api/firmware", requireAuth', start);
  if (start < 0 || at < start) throw new Error("Firmware inventory code not found in server.js");
  // In server.js the dependencies are module-level bindings: here, globals of
  // the sandbox. PRINTERS is read through to world.printers at every use, so a
  // replaced array is seen exactly as a reassigned PRINTERS is.
  Object.assign(sandbox, fakes);
  Object.defineProperty(sandbox, "PRINTERS", { get: () => world.printers, enumerable: true });
  vm.runInContext(src.slice(start, routeEnd(src, at) + 4), sandbox, { filename: "server.js (Firmware inventory)" });
}`, `function loadSource(sandbox, fakes, world) {
  // The module's own source runs in the sandbox. It requires nothing; its
  // dependencies arrive as parameters of registerFirmwareInventoryRoutes —
  // nothing is reachable as a global any more — and the printer list through
  // getPrinters(), read from world.printers at every call, so a replaced
  // array is seen exactly as a reassigned PRINTERS is.
  sandbox.module = { exports: {} };
  sandbox.require = name => { throw new Error("routes/firmwareInventory.js required an unexpected module: " + name); };
  vm.runInContext(fs.readFileSync(MODULE, "utf8"), sandbox, { filename: MODULE });
  const exported = sandbox.module.exports;
  if (Object.keys(exported).join() !== "registerFirmwareInventoryRoutes") throw new Error("unexpected exports: " + Object.keys(exported).join());
  const { app, ...deps } = fakes;
  const returned = exported.registerFirmwareInventoryRoutes(app, { ...deps, getPrinters: () => world.printers });
  if (returned !== undefined) throw new Error("registerFirmwareInventoryRoutes must return nothing");
}`, "helper: loadSource");

  return { __reconcile: reconcile, "server.js": newServer, "routes/firmwareInventory.js": moduleText, "test/firmwareInventory.test.js": inv,
    "test/firmwareDeploy.test.js": deploy, "test/connectorCoreMethods.test.js": coreTest, "test/helpers/firmwareInventoryCode.js": helper };
}

function main() {
  const ctx = guard.check();
  const i = process.argv.indexOf("--target");
  const target = checkRepo(ctx, i > 0 ? process.argv[i + 1] : ctx.worktree);
  if (target === ctx.worktree && !process.argv.includes("--execute")) throw new Error("refusing to change this worktree without --execute (owner authorisation for the extraction)");
  const inputs = ["server.js", "test/firmwareInventory.test.js", "test/firmwareDeploy.test.js", "test/connectorCoreMethods.test.js", "test/helpers/firmwareInventoryCode.js"];
  const files = Object.fromEntries(inputs.map(n => [n, fs.readFileSync(path.join(target, n), "utf8")]));
  if (fs.existsSync(path.join(target, "routes", "firmwareInventory.js"))) throw new Error("routes/firmwareInventory.js already exists");
  const out = transform(files);                        // throws before writing anything
  const rec = out.__reconcile; delete out.__reconcile;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifests", "firmware-inventory.json"), "utf8"));
  const moved = [...rec.moduleScope, ...rec.insideRegister, rec.route].sort();
  if (JSON.stringify(moved) !== JSON.stringify([...manifest.moved].sort())) throw new Error("moved items differ from the manifest: " + JSON.stringify(moved));
  const { moduleScope, insideRegister, route, ...lines } = rec;
  if (JSON.stringify(lines) !== JSON.stringify(manifest.reconciliation.lines)) throw new Error("source ranges differ from the manifest: " + JSON.stringify(lines));
  if (JSON.stringify(REWRITES) !== JSON.stringify(manifest.rewrites)) throw new Error("rewrites differ from the manifest: " + JSON.stringify(REWRITES));
  const produced = Object.keys(out).sort(), declared = [...manifest.allowedFiles, ...manifest.newFiles].sort();
  if (JSON.stringify(produced) !== JSON.stringify(declared)) throw new Error("files written differ from the manifest: " + JSON.stringify(produced));
  console.log("reconciled with the manifest: " + JSON.stringify(rec));
  fs.mkdirSync(path.join(target, "routes"), { recursive: true });
  for (const [n, text] of Object.entries(out)) fs.writeFileSync(path.join(target, n), text);
  console.log("written: " + Object.keys(out).join(", "));
}

module.exports = { transform };
if (require.main === module) main();

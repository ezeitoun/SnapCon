// tools/refactor/mapper/assess.js — combines the server and frontend maps
// with test coupling into ranked extraction candidates and a DRAFT manifest
// for the top-ranked allowed candidate. Read-only on source; writes only to
// tools/refactor/out/assessment/.
//   node tools/refactor/mapper/assess.js [--draft-manifest <area>]
"use strict";
const fs = require("fs");
const path = require("path");
const guard = require("../lib/guard");
const tools = require("../lib/tools");

// Areas the policy keeps out of early work (send, queue, transfers, file
// delete, printer commands, Remote Access, firmware, uploads).
const EXCLUDED = /^(print|printfile|send|upload|queue|queue-management|queue-store|transfers|deferred|staged-file|files|notify-load|firmware|firmware-.*|remote-access|estop|pause|resume|cancel|eject|bed|heat|command|gcode|unload|head-map|map|rediscover|users|login|logout|auth|session|config|otp-test|print-cancel|exclude|plate|printer-control-recheck|restart|update|probe-printer|printctl)$/;
// Read-only contact with printers or the network (informational, not an exclusion).
const TALKS = /\b(probeCached|probeForDisplay|getConnector|connHttp\.|fetch\(|dgram|discover|Snapshot)/;
const PRINTER_COMMANDS = /\.(uploadFile|startPrintFile|pause|resume|cancel|estop|eject|bedTemp|sendGcode|runGcode|unloadFilament|applyHeadMapping|setColor|deleteFile)\(/;
const WRITES = /\b(writeFile|writeFileSync|writeFileExclusive|rename|renameSync|unlink|unlinkSync|rmSync|moveNoReplace|mkdir|mkdirSync|saveConfig|writeConfig)\b/;

function main() {
  const ctx = guard.check();
  const A = p => JSON.parse(fs.readFileSync(path.join(ctx.outDir, "assessment", p), "utf8"));
  const server = A("server-map.json"), front = A("frontend-map.json");
  const serverSrc = fs.readFileSync(path.join(ctx.worktree, "server.js"), "utf8").split("\n");

  // Test coupling: which tests read server.js / app.js as text, and which
  // names and route paths each mentions.
  const testDir = path.join(ctx.worktree, "test");
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith(".test.js") ? [path.join(d, e.name)] : []));
  const tests = walk(testDir).map(f => {
    const src = fs.readFileSync(f, "utf8");
    return { file: path.relative(ctx.worktree, f), src,
      readsServer: /readFileSync\([^)]*server\.js/.test(src), readsApp: /readFileSync\([^)]*app\.js/.test(src),
      requiresServer: /require\([^)]*['"`]\.\.?\/(\.\.\/)*server(\.js)?['"`]\)/.test(src) };
  });
  const mentions = (t, name) => new RegExp("\\b" + name.replace(/[$]/g, "\\$") + "\\b").test(t.src);

  const candidates = server.areas.map(a => {
    const code = a.routes.map(r => serverSrc.slice(r.line - 1, r.line - 1 + r.lines).join("\n")).join("\n")
      + server.functions.filter(f => a.exclusiveHelpers.includes(f.name)).map(f => serverSrc.slice(f.line - 1, f.line - 1 + f.lines).join("\n")).join("\n");
    const names = a.exclusiveHelpers.filter(n => n.length >= 6);
    const paths = a.routes.map(r => r.path).filter(p => typeof p === "string");
    const behaviourTests = tests.filter(t => paths.some(p => t.src.includes(p)) || names.some(n => mentions(t, n)));
    const sourcePins = behaviourTests.filter(t => t.readsServer);
    const sharedState = server.state.filter(s => a.stateRead.includes(s.name) && !a.exclusiveHelpers.includes(s.name)).map(s => s.name);
    const mutatesShared = a.stateMutated.filter(n => !a.exclusiveHelpers.includes(n));
    const writesRoute = a.routes.some(r => r.method !== "GET");
    const printer = PRINTER_COMMANDS.test(code), writes = WRITES.test(code);
    const excluded = EXCLUDED.test(a.area) || printer;
    const size = a.routeLines + a.exclusiveLines;
    const clients = front.api.filter(x => x.routes && x.routes.some(rr => a.routes.some(r => rr === r.method + " " + r.path))).map(x => x.file + ":" + x.line);
    // Risk: reassigning shared state > mutating shared state > writes > printer commands; plus coupling.
    const coverage = behaviourTests.length;
    // Regression risk includes how little is tested: no covering test +3, one +1.5.
    const risk = a.stateReassigned.length * 5 + mutatesShared.length * 3 + (writesRoute ? 2 : 0) + (writes ? 3 : 0) + (printer ? 10 : 0)
      + Math.min(a.sharedDeps.length, 20) / 4 + (coverage === 0 ? 3 : coverage === 1 ? 1.5 : 0);
    return { area: a.area, routes: a.routes.map(r => r.method + " " + r.path), size, routeLines: a.routeLines, exclusiveHelpers: a.exclusiveHelpers,
      exclusiveLines: a.exclusiveLines, sharedDeps: a.sharedDeps, sharedStateRead: sharedState, stateReassigned: a.stateReassigned,
      sharedStateMutated: mutatesShared, ownState: a.stateMutated.filter(n => a.exclusiveHelpers.includes(n)),
      writesRoute, fileWrites: writes, printerCommands: printer, talksToPrintersReadOnly: !printer && TALKS.test(code), excluded, excludedWhy: excluded ? (printer ? "printer commands" : "policy-excluded area") : null,
      behaviourTests: behaviourTests.map(t => t.file), sourcePinnedTests: sourcePins.map(t => t.file), browserCallers: clients,
      risk: Math.round(risk * 10) / 10, coverage,
      riskLevel: risk >= 10 ? "H" : risk >= 4 ? "M" : "L" };
  });
  // Rank allowed candidates: low risk first, then more covering tests, then larger benefit.
  const allowed = candidates.filter(c => !c.excluded && c.size >= 20).sort((x, y) => x.risk - y.risk || y.coverage - x.coverage || y.size - x.size);
  const out = { generatedAt: new Date().toISOString(), tools: tools.versions(),
    testCoupling: { total: tests.length, readServerText: tests.filter(t => t.readsServer).length, readAppText: tests.filter(t => t.readsApp).length, requireServer: tests.filter(t => t.requiresServer).length },
    ranked: allowed, excluded: candidates.filter(c => c.excluded).map(c => ({ area: c.area, why: c.excludedWhy, size: c.size })), small: candidates.filter(c => !c.excluded && c.size < 20).map(c => c.area) };
  tools.writeOut(ctx, "assessment/candidates.json", out);

  const draft = process.argv.includes("--draft-manifest") ? process.argv[process.argv.indexOf("--draft-manifest") + 1] : null;
  if (draft) {
    const c = candidates.find(x => x.area === draft);
    if (!c) { console.error("no such area: " + draft); process.exit(2); }
    const a = server.areas.find(x => x.area === draft);
    const manifest = { status: "DRAFT — produced by the Architecture Mapper; not approved", boundary: draft, base: require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: ctx.worktree, encoding: "utf8" }).trim(),
      newFiles: [`routes/${draft}.js`], registration: `register${draft[0].toUpperCase() + draft.slice(1)}Routes(app, deps) at the original route position`,
      moved: [...a.exclusiveHelpers, ...a.routes.map(r => r.method + " " + r.path)],
      movedLines: { routes: a.routes.map(r => [r.line, r.line + r.lines - 1]), helpers: server.functions.filter(f => a.exclusiveHelpers.includes(f.name)).map(f => [f.name, f.line, f.line + f.lines - 1]) },
      rewrites: a.sharedDeps.filter(n => ["CFG", "PRINTERS", "FOLDER"].includes(n)).map(n => ({ from: n, to: { CFG: "getConfig()", PRINTERS: "getPrinters()", FOLDER: "getFolder()" }[n], reason: "reassigned by loadConfig(); must be read through a getter" })),
      injected: a.sharedDeps.filter(n => !["CFG", "PRINTERS", "FOLDER", "app"].includes(n)).map(n => {
        const t = server.topLevel.find(x => x.name === n);
        return { name: n, how: t && t.init === "require" ? `require("${t.requireOf}") directly in the new module (module import, no shared state)` : "injected through deps" };
      }).concat(a.sharedDeps.filter(n => ["CFG", "PRINTERS", "FOLDER"].includes(n)).map(n => ({ name: { CFG: "getConfig", PRINTERS: "getPrinters", FOLDER: "getFolder" }[n], how: "injected getter" }))),
      moduleState: c.ownState.map(n => { const s = server.state.find(x => x.name === n); return { name: n, init: s.init, today: `server.js:${s.line}, created during server.js top-level execution (after loadConfig, before listen)`, lifetime: "process", mutatedBy: s.mutatedBy, resetBy: "nothing (survives config reloads)", requirement: "module level of the new file, created once at require time, never inside the register function" }; }),
      contracts: [...a.routes.map(r => `http:${r.method} ${r.path}`), ...c.ownState.map(n => "state:" + n), "log:[health]", "deadline:HEALTH_DEADLINE_MS=25000", "middleware:" + [...new Set(a.routes.flatMap(r => r.middleware))].join(",")],
      browserCallers: c.browserCallers,
      testsReadingSourceText: c.sourcePinnedTests, otherCoveringTests: c.behaviourTests.filter(t => !c.sourcePinnedTests.includes(t)),
      declaredPinChanges: [], openQuestions: [] };
    tools.writeOut(ctx, `assessment/manifest-${draft}.draft.json`, manifest);
  }
  console.log(`${allowed.length} allowed candidates ranked, ${out.excluded.length} excluded, ${out.small.length} small; test coupling: ${JSON.stringify(out.testCoupling)}`);
}

if (require.main === module) main();

// test/monitor-only-gates.test.js — a printer whose connector declares
// capabilities.control === false (Bambu Lab) is WATCHED, never commanded.
//
// That rule has three enforcement points and all of them are checked here:
//   1. connectors/monitorOnly.js — the one predicate, `=== false` so no
//      existing connector (none declares the flag) is affected;
//   2. server.js — every route that changes what a printer does refuses before
//      any side effect, and queue dispatch / auto-balance / bulk send skip
//      such printers;
//   3. public/app.js — no control is rendered for them in the card, list view,
//      bulk toolbar, bulk heat or send modal.
// server.js has no module.exports and app.js is browser-global, so, as in
// test/fleet-estop-gate.test.js, pure pieces are run in a node:vm sandbox and
// the wiring is asserted on the source.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { isMonitorOnly, monitorOnlyMessage, monitorOnlyError, MONITOR_ONLY_CODE } = require("../connectors/monitorOnly");
const { CONNECTOR_TYPES, getConnector, getCapabilities } = require("../connectors");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function extractFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " must exist");
  const end = src.indexOf("\n}", start);
  return src.slice(start, end + 2);
}

// ---- 1. the predicate ----

test("isMonitorOnly is true only for an explicit control:false", () => {
  assert.equal(isMonitorOnly({ control: false }), true);
  assert.equal(isMonitorOnly({}), false, "absent flag = a normal, controllable connector");
  assert.equal(isMonitorOnly({ control: true }), false);
  assert.equal(isMonitorOnly(null), false);
  assert.equal(isMonitorOnly(undefined), false);
});

test("the refusal names the printer and says where control lives", () => {
  assert.match(monitorOnlyMessage("Farm H2D 3"), /^Farm H2D 3 .*monitoring only/);
  const e = monitorOnlyError("X");
  assert.equal(e.code, MONITOR_ONLY_CODE);
  assert.equal(e.status, 409);
});

test("no pre-existing connector became monitor-only by accident", () => {
  const monitorOnly = CONNECTOR_TYPES.filter(t => isMonitorOnly(getCapabilities(t, {})));
  assert.deepEqual(monitorOnly, ["bambulab-h2"]);
});

test("every monitor-only connector's control exports refuse rather than act", async () => {
  for (const type of CONNECTOR_TYPES.filter(t => isMonitorOnly(getCapabilities(t, {})))) {
    const c = getConnector(type);
    for (const fn of ["uploadFile", "startPrintFile", "pause", "resume", "cancel", "eject", "estop", "bedTemp"]) {
      assert.equal(typeof c[fn], "function", type + " must still export " + fn + " (so a stray call fails clearly)");
      await assert.rejects(c[fn]({ name: "p" }), e => e.code === MONITOR_ONLY_CODE, type + "." + fn);
    }
    for (const fn of ["applyHeadMapping", "unloadFilament", "setFilamentColor", "excludeObject"]) {
      assert.equal(c[fn], undefined, type + " must not export " + fn);
    }
  }
});

// ---- 2. server.js ----

function routeBody(method, route) {
  const start = serverSrc.indexOf(`app.${method}("${route}"`);
  assert.ok(start >= 0, route + " must exist");
  const end = serverSrc.indexOf("\napp.", start + 10);
  return serverSrc.slice(start, end === -1 ? undefined : end);
}

const GUARDED_ROUTES = [
  "/api/print", "/api/printfile", "/api/printctl", "/api/exclude",
  "/api/unload", "/api/filament-color", "/api/bedtemp",
  "/api/queue/:printerId/items", "/api/notify-load"
];

for (const route of GUARDED_ROUTES) {
  test(`server: ${route} refuses a monitor-only printer before touching it`, () => {
    const body = routeBody("post", route);
    const guard = body.indexOf("refuseMonitorOnly(p, res)");
    assert.ok(guard > 0, route + " must call refuseMonitorOnly(p, res)");
    for (const effect of ["getConnector(", "pendingLoad.set(", "queueStore.applyIntent(", "auditLog.log(", "JOBS.set("]) {
      const at = body.indexOf(effect);
      if (at !== -1) assert.ok(guard < at, route + ": the guard must come before " + effect);
    }
  });
}

test("server: /api/notify-load guards BOTH arms (remote upload and local CLI)", () => {
  const body = routeBody("post", "/api/notify-load");
  assert.equal((body.match(/refuseMonitorOnly\(p, res\)/g) || []).length, 2);
});

test("server: a monitor-only printer cannot be put into a Printer Pool (but can be taken out)", () => {
  const body = routeBody("post", "/api/printer-pool");
  assert.match(body, /if \(printerPoolId && refuseMonitorOnly\(p, res\)\) return;/);
});

test("server: queue dispatch, auto-balance and bulk send skip monitor-only printers", () => {
  const dispatch = extractFn(serverSrc, "attemptQueueDispatch");
  const skip = dispatch.indexOf("if (printerIsMonitorOnly(p)) return;");
  assert.ok(skip > 0, "attemptQueueDispatch must skip monitor-only printers");
  assert.ok(skip < dispatch.indexOf("claimNextForDispatch"), "...before claiming a job");
  assert.match(serverSrc, /PRINTERS\.filter\(p => p\.printerPoolId === pool\.id && !printerIsMonitorOnly\(p\)\)/);
  assert.match(routeBody("post", "/api/queue/send"), /!printerIsMonitorOnly\(p\)/);
});

test("server: the guard answers 409 with a stable code the client can translate", () => {
  const fn = extractFn(serverSrc, "refuseMonitorOnly");
  assert.match(fn, /res\.status\(409\)\.json\(\{ error: monitorOnlyMessage\(p\.name\), code: MONITOR_ONLY_CODE \}\)/);
});

// ---- 3. public/app.js ----

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(extractFn(appSrc, "monitorOnly"), sandbox);
vm.runInContext(extractFn(appSrc, "bulkheatDisableReason"), sandbox);

test("client monitorOnly(): same === false rule as the server", () => {
  const f = sandbox.monitorOnly;
  assert.equal(f({ capabilities: { control: false } }), true);
  assert.equal(f({ capabilities: {} }), false);
  assert.equal(f({ capabilities: { control: true } }), false);
  assert.equal(f({}), false);
  assert.equal(f(null), false);
});

test("client: bulk heat lists a monitor-only printer as not selectable, with a reason", () => {
  const r = sandbox.bulkheatDisableReason({ online: true, state: "standby", capabilities: { control: false } });
  assert.equal(r, "monitor_only");
  assert.match(appSrc, /monitor_only: "printer\.monitor_only_label"/, "the reason has a label");
  assert.equal(sandbox.bulkheatDisableReason({ online: true, state: "standby", capabilities: {} }), null);
});

test("client: the card footer shows the monitor-only note instead of any control", () => {
  const build = extractFn(appSrc, "buildCardHtml");
  assert.match(build, /<div class="foot\$\{busy\?'':' foot-idle'\}">\s*\$\{monitorOnly\(p\)\s*\? monitorOnlyNoteHtml\(\)\s*: busy/);
});

test("client: the list-view actions cell shows the note instead of any control", () => {
  const list = extractFn(appSrc, "renderFleetListRows");
  assert.match(list, /const actionsCell=monitorOnly\(p\)\s*\? monitorOnlyNoteHtml\(true\)\s*: busy/);
});

test("client: no Eject pill and no clickable bed-temperature cell on a monitor-only card", () => {
  const build = extractFn(appSrc, "buildCardHtml");
  assert.match(build, /canEject\(p\)&&!monitorOnly\(p\)\?`<button[^`]*data-eject=/);
  const setbed = build.indexOf('data-setbed="${p.id}"');
  const gate = build.lastIndexOf("monitorOnly(p)", setbed);
  assert.ok(gate > 0 && setbed - gate < 200, "the bed cell's click hook must sit in the non-monitor-only branch");
});

test("client: bulk Pause/Resume/Cancel never count a monitor-only printer as eligible", () => {
  const defs = appSrc.slice(appSrc.indexOf("const BULK_ACT_DEFS=["), appSrc.indexOf("];", appSrc.indexOf("const BULK_ACT_DEFS=[")));
  assert.equal((defs.match(/!monitorOnly\(p\)/g) || []).length, 3);
  assert.match(extractFn(appSrc, "bulkCtl"), /if\(!p\|\|monitorOnly\(p\)\) return false;/);
});

test("client: the Send modal never lists a monitor-only printer", () => {
  assert.match(extractFn(appSrc, "renderSendList"), /urlFilterFleet\(FLEET\)\.filter\(p=>!monitorOnly\(p\)\)/);
});

test("client: a refused pool assignment is translated and the picker reset", () => {
  assert.match(appSrc, /monitor_only:"settings\.printers\.pool_error_monitor_only"/);
  assert.match(appSrc, /if\(d\.code==="monitor_only"\) printerPoolEl\.value="";/);
});

for (const loc of ["en", "es"]) {
  test(`${loc}.json carries every monitor-only string`, () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", loc + ".json"), "utf8"));
    for (const k of ["printer.monitor_only_label", "printer.monitor_only_title", "settings.printers.monitor_only_hint", "settings.printers.pool_error_monitor_only"]) {
      const v = k.split(".").reduce((o, part) => o && o[part], j);
      assert.ok(typeof v === "string" && v.trim(), loc + " missing " + k);
    }
  });
}

// ---- thumbnails:false (same === false convention, separate flag) ----

test("client: a connector with thumbnails:false gets no <img> — card, camera view and list view", () => {
  vm.runInContext(extractFn(appSrc, "noThumbs"), sandbox);
  assert.equal(sandbox.noThumbs({ capabilities: { thumbnails: false } }), true);
  assert.equal(sandbox.noThumbs({ capabilities: {} }), false, "absent flag keeps thumbnails");
  const build = extractFn(appSrc, "buildCardHtml");
  assert.match(build, /const thumbCell=stem&&!noThumbs\(p\)/);
  assert.equal((build.match(/stem&&!noThumbs\(p\)\?/g) || []).length, 2, "camera view: both the enlarge hook and the <img>");
  assert.match(extractFn(appSrc, "renderFleetListRows"), /const fileCell=stem&&noThumbs\(p\)\s*\? `<div class="list-file-cell"><span class="list-file-name">/);
});

// ---- review follow-ups ----

test("server: enabling Queue Management does not pull monitor-only printers into a pool", () => {
  const body = routeBody("post", "/api/queue-management/enable");
  const skip = body.indexOf("if (printerIsMonitorOnly(p)) continue;");
  assert.ok(skip > 0 && skip < body.indexOf("PRINTER_POOL_DEFAULT_MANUAL_ID"), "skip before auto-assigning the Unassigned pool");
});

test("server: Clear on a monitor-only printer's leftover queue never calls the connector's cancel", () => {
  assert.match(routeBody("post", "/api/queue/:printerId/clear"), /const wasPrinting = \(qs\.queueState === "dispatching" \|\| qs\.queueState === "printing"\) && !printerIsMonitorOnly\(p\);/);
});

test("printer-reported remaining time is used by notifications and the sort-by-time order too", () => {
  assert.match(extractFn(serverSrc, "eventMessage"), /typeof st\.remaining === "number"/);
  assert.match(extractFn(appSrc, "sortedFleet"), /if\(typeof p\.remaining === 'number' && isFinite\(p\.remaining\)\) return p\.remaining;/);
});

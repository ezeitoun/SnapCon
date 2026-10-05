// test/topbar.test.js — the top bar's three pure decisions:
//   topbarVisibility()   which cells show, from role, Settings/first run, the
//                        /orca/<name> deep link and Queue Management;
//   topbarActiveCells()  which cell looks active for each page, menu and the
//                        file list (the design mockup left a cell active after
//                        another page took over);
//   fleetStatusSummary() the fleet-wide status pills and "next done";
//   brandTarget()        where a click on the brand ("back to printers") goes;
//   updateDisplay()      whether the bar announces an update;
//   pillClick()          what a status pill (fleet filter) click does.
//
// Each is loaded from public/app.js into a sandbox.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function fnSource(name) {
  const m = appSrc.match(new RegExp("function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}"));
  assert.ok(m, "missing in public/app.js: function " + name + "()");
  return m[0];
}
const sandbox = vm.createContext({});
vm.runInContext(["topbarVisibility", "topbarActiveCells", "camBucket", "printRemaining", "fleetStatusSummary", "brandTarget", "updateDisplay", "pillClick"].map(fnSource).join("\n"), sandbox);
const call = (name, arg) => JSON.parse(JSON.stringify(vm.runInContext(name, sandbox)(arg)));

const shown = vis => Object.keys(vis).filter(k => vis[k]).sort();
const base = { settingsOpen: false, deepLink: false, admin: true, canAct: true, queueEnabled: true, signedIn: true };

// ---- visibility ----

test("an admin on the fleet sees every cell", () => {
  assert.deepEqual(shown(call("topbarVisibility", base)),
    ["clock", "files", "gear", "health", "heat", "library", "queue", "search", "sort", "theme", "user", "view"]);
});

test("Settings (and first run, which is Settings opened for you) hides the fleet controls but keeps the way back", () => {
  assert.deepEqual(shown(call("topbarVisibility", { ...base, settingsOpen: true })),
    ["clock", "gear", "theme", "user"]);
});

test("the /orca/<name> deep link hides search, files, sort, view, theme, Settings and the clock — for an admin too", () => {
  // The bug this replaces: init() hid gear and filesBtn, then applyRoleUI()
  // showed them again for admins / canAct() users.
  assert.deepEqual(shown(call("topbarVisibility", { ...base, deepLink: true })),
    ["health", "heat", "library", "queue", "user"]);
});

test("first run on a deep link still shows Settings' cell, so setup can be left", () => {
  assert.equal(call("topbarVisibility", { ...base, deepLink: true, settingsOpen: true }).gear, true);
});

test("role and feature gating", () => {
  const viewer = call("topbarVisibility", { ...base, admin: false, canAct: false });
  assert.equal(viewer.gear, false, "Settings is admin only");
  assert.equal(viewer.files, false, "the file list needs canAct()");
  assert.equal(call("topbarVisibility", { ...base, queueEnabled: false }).queue, false);
  assert.equal(call("topbarVisibility", { ...base, signedIn: false }).user, false, "no user cells without a signed-in user");
});

// ---- active cell ----

const page = { settingsOpen: false, healthOpen: false, queueOpen: false, libraryOpen: false, filesOpen: false, popup: null, heatOpen: false };
const active = s => call("topbarActiveCells", { ...page, ...s }).sort();

test("exactly one page cell is active, and View stands for the fleet", () => {
  assert.deepEqual(active({}), ["view"]);
  assert.deepEqual(active({ healthOpen: true }), ["health"]);
  assert.deepEqual(active({ queueOpen: true }), ["queue"]);
  assert.deepEqual(active({ libraryOpen: true }), ["library"]);
  assert.deepEqual(active({ settingsOpen: true }), ["gear"]);
});

test("a cell loses the active state when another page takes over", () => {
  // Fleet -> Health -> Library -> Settings -> back to Fleet, one state at a
  // time, as the open/close functions leave it.
  const steps = [
    [{}, ["view"]],
    [{ healthOpen: true }, ["health"]],
    [{ libraryOpen: true }, ["library"]],
    [{ queueOpen: true }, ["queue"]],
    [{ settingsOpen: true }, ["gear"]],
    [{}, ["view"]],
  ];
  for (const [state, want] of steps) assert.deepEqual(active(state), want, JSON.stringify(state));
});

test("Files adds to the page cell, and an open menu's cell is active while it's open", () => {
  assert.deepEqual(active({ filesOpen: true }), ["files", "view"]);
  assert.deepEqual(active({ filesOpen: true, healthOpen: true }), ["files", "health"]);
  assert.deepEqual(active({ popup: "sort" }), ["sort", "view"]);
  assert.deepEqual(active({ popup: "view" }), ["view"], "the View menu on the fleet doesn't add a second cell");
  assert.deepEqual(active({ queueOpen: true, popup: "view" }), ["queue", "view"]);
  assert.deepEqual(active({ popup: null }), ["view"], "closing the menu drops its cell");
});

test("while the Heat dialog is open, Heat is the only highlighted cell", () => {
  // Reported: opening Heat from Health left Health highlighted.
  assert.deepEqual(active({ heatOpen: true }), ["heat"]);
  assert.deepEqual(active({ heatOpen: true, healthOpen: true, filesOpen: true }), ["heat"]);
  assert.deepEqual(active({ heatOpen: false, healthOpen: true }), ["health"], "the page's highlight returns when it closes");
});

// ---- fleet status ----

const printer = o => ({ online: true, state: "idle", ...o });

test("counts the same buckets as the status tabs, paused included in printing", () => {
  const sum = call("fleetStatusSummary", [
    printer({ state: "printing", progress: 0.5, elapsed: 600 }),
    printer({ state: "paused", progress: 0.2, elapsed: 100 }),
    printer({ state: "printing", errorCode: "E1" }),          // an error wins over printing
    printer({ state: "complete" }),
    printer({ state: "idle" }),
    printer({ online: false, state: "printing" }),             // offline wins over everything
  ]);
  assert.deepEqual({ ...sum, nextDone: undefined }, { printing: 2, attention: 1, idle: 2, offline: 1, nextDone: undefined });
});

test("next done is the soonest estimate the time-remaining sort can make", () => {
  const sum = call("fleetStatusSummary", [
    printer({ state: "printing", progress: 0.5, elapsed: 1800 }),   // 1800 s left
    printer({ state: "printing", progress: 0.9, elapsed: 7848 }),   // 872 s left
    printer({ state: "paused", progress: 0.99, elapsed: 9999 }),    // paused: no estimate
    printer({ state: "printing", progress: 0, elapsed: 50 }),        // no progress yet
    printer({ state: "printing", progress: 0.5 }),                   // no elapsed time
  ]);
  assert.ok(Math.abs(sum.nextDone - 872) < 1e-6, String(sum.nextDone));
});

test("nothing printing: no next done", () => {
  assert.equal(call("fleetStatusSummary", [printer({}), printer({ online: false })]).nextDone, null);
  assert.equal(call("fleetStatusSummary", []).nextDone, null);
});

// ---- the brand: "back to printers" ----

const where = { deepLink: false, settingsOpen: false, healthOpen: false, libraryOpen: false, queueOpen: false, viewMode: "regular", lastFleetView: "regular" };
const brand = s => call("brandTarget", { ...where, ...s });

test("from a page, the brand goes back to the fleet in the current view", () => {
  assert.deepEqual(brand({ healthOpen: true, viewMode: "camera" }), { action: "fleet", view: "camera", closeSettings: false });
  assert.deepEqual(brand({ libraryOpen: true, viewMode: "list" }), { action: "fleet", view: "list", closeSettings: false });
  assert.deepEqual(brand({ settingsOpen: true, viewMode: "compact" }), { action: "fleet", view: "compact", closeSettings: true },
    "Settings closes the way its own Back does");
});

test("from Print farm, the brand returns to the last fleet view, or Full", () => {
  assert.deepEqual(brand({ queueOpen: true, viewMode: "printfarm", lastFleetView: "list" }), { action: "fleet", view: "list", closeSettings: false });
  assert.deepEqual(brand({ queueOpen: true, viewMode: "printfarm", lastFleetView: "printfarm" }).view, "regular",
    "launched straight into Print farm: there is no earlier fleet view");
  assert.deepEqual(brand({ queueOpen: true, viewMode: "printfarm", lastFleetView: undefined }).view, "regular");
});

test("already on the fleet, the brand only scrolls it to the top", () => {
  for (const viewMode of ["regular", "compact", "camera", "list"]) assert.deepEqual(brand({ viewMode }), { action: "scrollTop" });
});

test("on the single-printer link the brand does nothing, whatever is open", () => {
  assert.deepEqual(brand({ deepLink: true }), { action: "none" });
  assert.deepEqual(brand({ deepLink: true, healthOpen: true, queueOpen: true, viewMode: "printfarm" }), { action: "none" });
});

// ---- update available ----

const upd = { enabled: true, current: "0.8.0", latest: "0.9.0", updateAvailable: true, lastError: null };

test("the update dot and version text show only for an admin, with a newer release and no warning", () => {
  const d = vm.runInContext("updateDisplay", sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(d(upd, { admin: true, mismatch: false }))), { show: true, latest: "0.9.0", current: "0.8.0" });
  assert.equal(d(upd, { admin: false, mismatch: false }).show, false, "non-admins see nothing");
  assert.equal(d(upd, { admin: true, mismatch: true }).show, false, "the page/server version mismatch wins");
  assert.equal(d({ ...upd, enabled: false }, { admin: true, mismatch: false }).show, false, "the check is off");
  assert.equal(d({ ...upd, lastError: "unreachable" }, { admin: true, mismatch: false }).show, false, "the last check failed");
  assert.equal(d({ ...upd, updateAvailable: false }, { admin: true, mismatch: false }).show, false, "up to date");
  assert.equal(d(null, { admin: true, mismatch: false }).show, false, "no status yet");
  assert.equal(d(upd, { admin: true, mismatch: false, deepLink: true }).show, false,
    "nothing on the single-printer link: no dot, suffix, tooltip, announcement or sheet row");
});

test("checkVersion() re-applies the whole update UI once it knows the version, with the mismatch already set", async () => {
  // Reported race: a login-time status fetch could show the dot/tooltip/sheet
  // row before the version check; checkVersion() then only redrew the version
  // line. It must redraw everything, after marking the mismatch.
  const m = appSrc.match(/async function checkVersion\(\)\{[\s\S]*?\n\}/);
  assert.ok(m, "missing in public/app.js: async function checkVersion()");
  const seen = [];
  const badge = { className: "vbadge" };
  const ctx = vm.createContext({
    $: () => badge,
    getJSON: async () => ({ version: "0.8.1" }), // server differs from the page
    renderUpdateUI: () => seen.push({ cls: badge.className, checked: vm.runInContext("VERSION_CHECKED", ctx) }),
    renderVbadge: () => {},
  });
  vm.runInContext('var VERSION="0.8.0"; var VBADGE_BASE=""; var VERSION_CHECKED=false;\n' + m[0], ctx);
  await vm.runInContext("checkVersion()", ctx);
  assert.equal(seen.length, 1, "renderUpdateUI() runs once the version is known");
  assert.equal(seen[0].cls, "vbadge bad", "with the mismatch already marked");
  assert.equal(seen[0].checked, true);
});

// ---- status pills as fleet filters ----

const onFleet = { ...where, camTab: "all" };
const pill = s => call("pillClick", { ...onFleet, ...s });

test("a pill sets the fleet filter to its bucket, and the active pill toggles back to all", () => {
  for (const bucket of ["printing", "attention", "idle", "offline"])
    assert.deepEqual(pill({ bucket }), { action: "filter", tab: bucket, toFleet: null });
  assert.deepEqual(pill({ bucket: "offline", camTab: "offline" }), { action: "filter", tab: "all", toFleet: null }, "toggle off");
  assert.deepEqual(pill({ bucket: "idle", camTab: "offline" }), { action: "filter", tab: "idle", toFleet: null }, "switch buckets");
});

test("from another page or Print farm, a pill first returns to the fleet like the brand does", () => {
  assert.deepEqual(pill({ bucket: "offline", healthOpen: true, viewMode: "camera" }),
    { action: "filter", tab: "offline", toFleet: { action: "fleet", view: "camera", closeSettings: false } });
  assert.deepEqual(pill({ bucket: "printing", settingsOpen: true }).toFleet, { action: "fleet", view: "regular", closeSettings: true });
  assert.deepEqual(pill({ bucket: "idle", libraryOpen: true, viewMode: "list" }).toFleet.view, "list");
  assert.deepEqual(pill({ bucket: "idle", queueOpen: true, viewMode: "printfarm", lastFleetView: "compact" }).toFleet,
    { action: "fleet", view: "compact", closeSettings: false }, "Print farm → the last fleet view");
});

test("on the single-printer link a pill does nothing", () => {
  assert.deepEqual(pill({ bucket: "offline", deepLink: true }), { action: "none" });
  assert.deepEqual(pill({ bucket: "offline", deepLink: true, healthOpen: true }), { action: "none" });
});

// ---- the cell maps name real elements ----

test("every element id the top bar's maps refer to exists in index.html", () => {
  // TB_CELLS / TB_ACTIVE_CELLS / TB_POPUPS address cells by id string; a typo
  // would silently leave a cell (or its menu-sheet stand-in) unmanaged.
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const maps = vm.createContext({});
  for (const name of ["TB_CELLS", "TB_ACTIVE_CELLS", "TB_POPUPS"]) {
    const m = appSrc.match(new RegExp("const " + name + " = (\\{[\\s\\S]*?\\n?\\});"));
    assert.ok(m, "missing in public/app.js: const " + name);
    vm.runInContext("var " + name + " = " + m[1] + ";", maps);
  }
  const referenced = [
    ...Object.values(vm.runInContext("TB_CELLS", maps)).flat(),
    ...Object.values(vm.runInContext("TB_ACTIVE_CELLS", maps)),
    ...Object.values(vm.runInContext("TB_POPUPS", maps)).flatMap(p => [p.btn, p.panel]),
  ];
  assert.ok(referenced.length > 20);
  for (const id of referenced) assert.ok(ids.has(id), `index.html has no element with id="${id}"`);
});

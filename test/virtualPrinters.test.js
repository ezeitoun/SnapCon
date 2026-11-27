// test/virtualPrinters.test.js — Settings › General › Enable virtual printers.
//
// Virtual printers (the Simulator, the Virtual U1) are shown and run only
// while the switch is on. While it is off they are left out of PRINTERS —
// the list every route, probe, pool and queue dispatch reads — but stay in
// config.json, and a Settings save must keep them although the browser never
// saw them: the browser posts its whole printer list, so a save that only
// wrote back what it was sent would delete them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const connectors = require("../connectors");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

function extractFn(name) {
  const at = serverSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}

// activePrinters and hiddenPrinters from server.js, run against the real
// connector registry.
function harness(cfg) {
  const ctx = vm.createContext({ isVirtualType: connectors.isVirtualType, CFG: cfg, PRINTERS: [] });
  vm.runInContext(extractFn("activePrinters") + "\n" + extractFn("hiddenPrinters"), ctx);
  ctx.PRINTERS = vm.runInContext("activePrinters", ctx)(cfg);
  return { PRINTERS: ctx.PRINTERS, hiddenPrinters: saved => vm.runInContext("hiddenPrinters", ctx)(saved) };
}

const U1 = { id: "u1", name: "U1 Yellow", connector: "snapmaker-u1-klipper-ws", url: "http://192.168.40.203" };
const SIM = { id: "sim1", name: "Dummy#1", connector: "simulator", url: "sim://aa" };
const SIM2 = { id: "sim2", name: "Dummy#2", connector: "simulator", url: "sim://bb" };
const ODD = { id: "odd", name: "Old type", connector: "no-such-connector", url: "http://192.168.40.9" };

// ---- which connectors are virtual ----

test("the Simulator is virtual; real printers and unknown types are not", () => {
  assert.equal(connectors.isVirtualType("simulator"), true);
  assert.equal(connectors.isVirtualType("snapmaker-u1-klipper-ws"), false);
  assert.equal(connectors.isVirtualType("bambu-lab"), false);
  // An unknown type runs as the default connector, a real printer.
  assert.equal(connectors.isVirtualType("no-such-connector"), false);
  assert.equal(connectors.isVirtualType(undefined), false);
});

test("the connector list tells the browser which types are virtual", () => {
  const types = connectors.listConnectorTypes();
  assert.equal(types.find(c => c.type === "simulator").virtual, true);
  assert.equal(types.find(c => c.type === "snapmaker-u1-klipper-ws").virtual, false);
});

// ---- PRINTERS ----

test("off (the default): virtual printers are left out of PRINTERS", () => {
  const cfg = { printers: [U1, SIM, ODD, SIM2] };
  assert.deepEqual(harness(cfg).PRINTERS.map(p => p.id), ["u1", "odd"]);
  assert.equal(cfg.printers.length, 4, "config.json's list is not touched");
});

test("on: every printer runs, in config order", () => {
  const cfg = { virtualPrintersEnabled: true, printers: [U1, SIM, ODD, SIM2] };
  assert.deepEqual(harness(cfg).PRINTERS.map(p => p.id), ["u1", "sim1", "odd", "sim2"]);
});

test("PRINTERS holds the same printer objects, so an edit to one reaches config.json", () => {
  const cfg = { printers: [{ ...U1 }, { ...SIM }] };
  const { PRINTERS } = harness(cfg);
  PRINTERS[0].tags = ["front"];
  assert.deepEqual(cfg.printers[0].tags, ["front"]);
});

test("no printers at all is fine", () => {
  assert.equal(harness({}).PRINTERS.length, 0);
  assert.equal(harness({ printers: null }).PRINTERS.length, 0);
});

test("every place that sets PRINTERS goes through activePrinters", () => {
  assert.doesNotMatch(serverSrc, /PRINTERS = Array\.isArray\(CFG\.printers\)/);
  const sets = serverSrc.match(/^\s*PRINTERS = .*$/gm) || [];
  assert.ok(sets.length >= 4, "loadConfig and the three startup migrations");
  for (const line of sets) assert.match(line, /PRINTERS = activePrinters\(CFG\);/);
});

// ---- saving keeps the hidden ones ----

test("a save keeps the virtual printers the browser never saw", () => {
  const cfg = { printers: [U1, SIM, ODD, SIM2] };
  const h = harness(cfg);
  // What the browser posts: the rows it shows, i.e. PRINTERS.
  const saved = h.PRINTERS.map(p => ({ ...p }));
  const out = saved.concat(h.hiddenPrinters(saved));
  assert.deepEqual(out.map(p => p.id), ["u1", "odd", "sim1", "sim2"]);
  assert.equal(out[2], SIM, "kept exactly as stored");
});

test("a save that removes a visible printer still keeps the hidden ones", () => {
  const h = harness({ printers: [U1, SIM, ODD] });
  const saved = [{ ...ODD }];
  assert.deepEqual(saved.concat(h.hiddenPrinters(saved)).map(p => p.id), ["odd", "sim1"]);
});

test("with virtual printers on, nothing is hidden, so a removed one stays removed", () => {
  const h = harness({ virtualPrintersEnabled: true, printers: [U1, SIM, SIM2] });
  const saved = [{ ...U1 }, { ...SIM2 }];
  assert.deepEqual(saved.concat(h.hiddenPrinters(saved)).map(p => p.id), ["u1", "sim2"]);
});

test("a hidden printer is never written twice", () => {
  const h = harness({ printers: [U1, SIM] });
  const saved = [{ ...U1 }, { ...SIM }]; // cannot happen from the page; still no duplicate
  assert.deepEqual(saved.concat(h.hiddenPrinters(saved)).map(p => p.id), ["u1", "sim1"]);
});

test("POST /api/config appends the hidden printers to the saved list", () => {
  const at = serverSrc.indexOf('app.post("/api/config"');
  const save = serverSrc.slice(at, at + 3000);
  assert.ok(save.includes(".then(saved => saved.concat(hiddenPrinters(saved)))"));
});

test("the setting is stored only when on, and an older page that omits it keeps it", () => {
  const at = serverSrc.indexOf('app.post("/api/config"');
  const save = serverSrc.slice(at, serverSrc.indexOf("\n});", at));
  assert.ok(save.includes('virtualPrintersEnabled: (typeof b.virtualPrintersEnabled === "boolean" ? b.virtualPrintersEnabled : CFG.virtualPrintersEnabled === true) || undefined,'));
  assert.ok(serverSrc.includes("virtualPrintersEnabled: CFG.virtualPrintersEnabled === true,"), "publicCfg sends it");
});

// ---- other paths ----

test("virtual types are not offered while the switch is off", () => {
  assert.ok(serverSrc.includes('app.get("/api/connectors", requireAuth, (req, res) => res.json(listConnectorTypes().filter(c => !c.virtual || CFG.virtualPrintersEnabled === true)));'));
});

test("deleting a group clears it from hidden printers too", () => {
  const at = serverSrc.indexOf('app.delete("/api/groups/:id"');
  const route = serverSrc.slice(at, serverSrc.indexOf("\n});", at));
  assert.ok(route.includes("removeGroupReferences(id, CFG.printers || [], USERS);"));
  assert.ok(route.includes("const printerBackups = (CFG.printers || []).map(p => p.allowedGroups);"));
  assert.ok(route.includes("(CFG.printers || []).forEach((p, i) => { p.allowedGroups = printerBackups[i]; });"), "restored over the same list it was backed up from");
});

// ---- the switch ----

test("the switch is a real labelled switch in Settings › General", () => {
  assert.match(htmlSrc, /<label class="switch-row" for="setVirtualPrinters"><input type="checkbox" role="switch" id="setVirtualPrinters" class="switch-input">/);
  const panel = htmlSrc.slice(htmlSrc.indexOf('id="tab-general"'), htmlSrc.indexOf('id="settingsVirtualPrinters"'));
  assert.ok(!panel.includes('class="set-panel"'), "inside the General panel, not another tab");
});

test("the switch is part of the General tab's dirty state and its save", () => {
  const values = appSrc.slice(appSrc.indexOf("function generalTabValues(){"), appSrc.indexOf("function setGeneralTabValues("));
  assert.ok(values.includes('virtualPrintersEnabled:$("setVirtualPrinters").checked'));
  assert.ok(appSrc.includes('$("setVirtualPrinters").checked=v.virtualPrintersEnabled;'));
  assert.ok(appSrc.includes('virtualPrintersEnabled:$("setVirtualPrinters").checked, overwriteDifferentFiles'), "sent with the save");
  assert.ok(appSrc.includes("VIRTUAL_PRINTERS_ON=c.virtualPrintersEnabled===true;"), "off unless the server says on");
});

test("after a save that flips it, the Type lists and the printer rows are rebuilt", () => {
  const at = appSrc.indexOf("if(VIRTUAL_PRINTERS_ON!==(c.virtualPrintersEnabled===true)){");
  assert.ok(at > 0);
  const block = appSrc.slice(at, appSrc.indexOf("\n    }", at));
  assert.ok(block.includes("await loadConnectorTypes();"));
  assert.ok(block.includes("PRINTERS_CFG=c.printers||[];"));
  assert.ok(block.includes("renderPrinterRowsFromConfig();"));
  assert.ok(at < appSrc.indexOf("baselinePrintersDirty(); // current row values"), "before the dirty baseline is taken");
});

// ---- the Virtual U1's printer record ----

const address = require("../connectors/address");
function serverFn(signature) {
  const at = serverSrc.indexOf(signature);
  assert.ok(at > 0, signature + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}
async function buildVirtualRecord(submitted) {
  const ctx = vm.createContext({
    CONNECTOR_TYPES: connectors.CONNECTOR_TYPES,
    DEFAULT_CONNECTOR_TYPE: connectors.DEFAULT_TYPE,
    BRAND_EDITABLE_CONNECTOR: "klipper-moonraker",
    CFG: { groups: [] },
    getAddress: connectors.getAddress,
    getConnector: connectors.getConnector,
    isValidHost: address.isValidHost, normalizePort: address.normalizePort,
    parseAddressUrl: address.parseAddressUrl, composeAddressUrl: address.composeAddressUrl,
    sanitizeBrand: b => String(b || ""),
    newPrinterId: () => "generated-id",
    detectCrealityWebrtcCamera: async () => {},
  });
  vm.runInContext(serverFn("function resolvePrinterAddress(p) {") + "\n" + serverFn("async function buildPrinterRecord(p, existing)"), ctx);
  return vm.runInContext("buildPrinterRecord", ctx)(submitted, null);
}

test("a Virtual U1 is always on this machine: only its port is taken from the browser", async () => {
  const o = await buildVirtualRecord({ name: "VU1 #1", connector: "virtual-u1", ip: "192.168.40.203", port: "7126" });
  assert.equal(o.url, "http://127.0.0.1:7126");
  assert.equal(o.ip, "127.0.0.1");
  assert.equal(o.port, 7126);
  assert.equal(o.brand, "SnapMaker");
});

test("its Firmware and Timing are stored only as values the connector offers", async () => {
  const ok = await buildVirtualRecord({ name: "VU1", connector: "virtual-u1", port: "7125", virtualFirmware: "1.6.0", virtualTiming: "real" });
  assert.equal(ok.virtualFirmware, "1.6.0");
  assert.equal(ok.virtualTiming, "real");
  const bad = await buildVirtualRecord({ name: "VU1", connector: "virtual-u1", port: "7125", virtualFirmware: "../../etc", virtualTiming: "slow" });
  assert.equal(bad.virtualFirmware, undefined);
  assert.equal(bad.virtualTiming, undefined);
});

test("other connectors never store them", async () => {
  const o = await buildVirtualRecord({ name: "U1", connector: "snapmaker-u1-klipper-ws", ip: "192.168.40.203", virtualFirmware: "1.6.0", virtualTiming: "real" });
  assert.equal(o.virtualFirmware, undefined);
  assert.equal(o.virtualTiming, undefined);
  assert.equal(o.url, "http://192.168.40.203", "a real U1's address is untouched");
});

test("the fleet row says which printers are virtual, and the card shows it", () => {
  assert.equal((serverSrc.match(/brand: p\.brand \|\| "SnapMaker", virtual: isVirtualType\(p\.connector\),/g) || []).length, 2, "both fleet row shapes");
  const fn = appSrc.slice(appSrc.indexOf("function brandHtml(p){"), appSrc.indexOf("\n}", appSrc.indexOf("function brandHtml(p){")));
  assert.ok(fn.includes('(p&&p.virtual)?t("fleet.card.virtual")'));
});

test("the Settings row offers the connector's own Firmware and Timing, and saves them", () => {
  assert.ok(appSrc.includes('const vo=(CONNECTOR_TYPES.find(c=>c.type===connectorEl.value)||{}).virtualOptions;'));
  assert.match(appSrc, /<label class="fl" for="pvfirmware-\$\{uid\}"/);
  assert.match(appSrc, /<label class="fl" for="pvtiming-\$\{uid\}"/);
  const gather = appSrc.slice(appSrc.indexOf("function gatherPrinters(){"), appSrc.indexOf("function gatherPrinters(){") + 4000);
  assert.ok(gather.includes('virtualFirmware:r.querySelector(".pvfirmware").value||undefined,'));
  assert.ok(gather.includes('virtualTiming:r.querySelector(".pvtiming").value||undefined,'));
  const diff = appSrc.slice(appSrc.indexOf("function serializeRowForDiff(row){"), appSrc.indexOf("function serializeRowForDiff(row){") + 2500);
  assert.ok(diff.includes("virtualFirmware:") && diff.includes("virtualTiming:"), "part of the dirty state");
  assert.ok(appSrc.includes("virtualFirmware:p.virtualFirmware,virtualTiming:p.virtualTiming,"), "rows rebuilt from config keep them");
});

test("a new Virtual U1 row is offered a port no other Virtual U1 row uses", () => {
  const ctx = vm.createContext({});
  const at = appSrc.indexOf("function nextFreeFixedHostPort(row,type,defaultPort){");
  vm.runInContext(appSrc.slice(at, appSrc.indexOf("\n}", at) + 2), ctx);
  const rowOf = (type, port) => ({ querySelector: s => (s === ".pconnector" ? { value: type } : { value: String(port) }) });
  const rows = [rowOf("virtual-u1", 7125), rowOf("virtual-u1", 7126), rowOf("snapmaker-u1-klipper-ws", 7127)];
  ctx.document = { querySelectorAll: () => rows };
  const next = (row) => vm.runInContext("nextFreeFixedHostPort", ctx)(row, "virtual-u1", 7125);
  assert.equal(next({}), 7127, "7125 and 7126 are taken; a real U1's port does not count");
  assert.equal(next(rows[0]), 7125, "a row's own port is not taken from it");
  rows.length = 0;
  assert.equal(next({}), 7125, "the first gets the default");
});

// ---- the Simulator is shown as "Test printer" ----

test("the Simulator type is named Test printer, and stays type \"simulator\"", () => {
  const t = connectors.listConnectorTypes().find(c => c.type === "simulator");
  assert.equal(t.label, "Test printer");
  assert.equal(t.brand, "Test printer");
});

test("a Simulator saved under the old brand is renamed once at startup, hidden ones included; nothing else changes", () => {
  const written = [];
  const cfg = { printers: [
    { ...SIM, brand: "Simulator" },
    { ...SIM2, brand: "Simulator" },
    { ...U1, brand: "SnapMaker" },
    { id: "k", name: "Klipper", connector: "klipper-moonraker", url: "http://192.168.40.7", brand: "Simulator" }
  ] };
  const ctx = vm.createContext({ CFG: cfg, CONFIG_LOAD_FAILED: false, CONFIG_PATH: "config.json", getConnector: connectors.getConnector,
    fs: { writeFileSync: (f, text) => written.push(JSON.parse(text)) } });
  vm.runInContext(extractFn("renameSimulatorBrand") + "\nrenameSimulatorBrand();", ctx);
  assert.deepEqual(cfg.printers.map(p => p.brand), ["Test printer", "Test printer", "SnapMaker", "Simulator"],
    "a Klipper printer's own brand text is the user's, even if it reads Simulator");
  assert.equal(written.length, 1);
  vm.runInContext("renameSimulatorBrand();", ctx);
  assert.equal(written.length, 1, "nothing to write the second time");
  assert.match(serverSrc, /\nrenameSimulatorBrand\(\);\n/, "runs at startup");
});

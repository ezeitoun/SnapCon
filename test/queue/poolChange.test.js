// test/queue/poolChange.test.js — a printer's pool and "Queue Management on"
// live in two places (config.json and the queue store). These tests run the
// real QueueStore on a temporary folder and make either save fail, to show
// that a change is refused before anything is touched when the store cannot
// save, that every store answer is checked, and that a half-done change is
// undone — or, when it cannot be undone, reported as incomplete.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createQueueStore } = require("../../queue/QueueStore");
const { changePrinterPool, enableQueueManagement } = require("../../queue/poolChange");

const quiet = t => { const o = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; t.after(() => Object.assign(console, o)); };
const err = code => Object.assign(new Error(code + ": simulated"), { code });
// A store whose saves fail while failing() is true (the temporary file cannot be written).
function setup(t, files = {}) {
  quiet(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-pool-"));
  fs.mkdirSync(path.join(base, "data"));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(base, "data", n), c);
  const ctl = { storeFails: false, configFails: false, saves: 0, storeWrites: 0 };
  const fsImpl = { ...fs, openSync(p, ...r) { if (path.basename(p) === "queue-data.json.tmp") { if (ctl.storeFails) throw err("EIO"); ctl.storeWrites++; } return fs.openSync(p, ...r); } };
  const queueStore = createQueueStore({ baseDir: base, degradedRetryMs: 3600000, fsImpl });
  queueStore.load();
  const saveConfig = () => { if (ctl.configFails) throw err("ENOSPC"); ctl.saves++; };
  const onDisk = id => { try { return (JSON.parse(fs.readFileSync(path.join(base, "data", "queue-data.json"), "utf8"))[id] || {}).queueState || "unmanaged"; } catch { return "no-file"; } };
  const listing = () => fs.readdirSync(path.join(base, "data")).sort();
  return { base, ctl, queueStore, saveConfig, onDisk, listing, state: id => queueStore.getPrinterState(id).queueState };
}
const printer = (id, printerPoolId) => ({ id, name: id, printerPoolId });

test("pool change: assigning and removing update the queue store first, then the settings, and both agree", t => {
  const s = setup(t), p = printer("p1");
  assert.deepEqual(changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_a", saveConfig: s.saveConfig }), { ok: true });
  assert.deepEqual([p.printerPoolId, s.state("p1"), s.onDisk("p1"), s.ctl.saves], ["pp_a", "idle", "idle", 1]);
  assert.deepEqual(changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: null, saveConfig: s.saveConfig }), { ok: true });
  assert.deepEqual([p.printerPoolId, s.state("p1"), s.onDisk("p1"), s.ctl.saves], [undefined, "unmanaged", "unmanaged", 2]);
});

for (const [what, files, prepare] of [
  ["recovery is required (both queue files bad)", { "queue-data.json": "{ bad", "queue-data.json.bak": "" }, () => {}],
  ["a queue file could not be read", { "queue-data.json": "{}" }, s => {}],
  ["the store is degraded after a failed save", {}, s => { s.ctl.storeFails = true; s.queueStore.applyObserved("p9", st => st); s.ctl.storeFails = false; }],
  ["an admin stopped the store", {}, s => s.queueStore.stopAll()],
]) {
  test(`pool change and enabling are refused before anything is touched when ${what}`, t => {
    const unreadable = what.includes("could not be read");
    let s;
    if (unreadable) {
      quiet(t);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-pool-"));
      fs.mkdirSync(path.join(base, "data")); fs.writeFileSync(path.join(base, "data", "queue-data.json"), "{}");
      const fsImpl = { ...fs, readFileSync(p, ...r) { if (path.basename(p) === "queue-data.json") throw err("EIO"); return fs.readFileSync(p, ...r); } };
      const queueStore = createQueueStore({ baseDir: base, degradedRetryMs: 3600000, fsImpl });
      queueStore.load();
      const ctl = { saves: 0 };
      s = { queueStore, ctl, saveConfig: () => { ctl.saves++; }, listing: () => fs.readdirSync(path.join(base, "data")).sort(), state: id => queueStore.getPrinterState(id).queueState, base };
    } else { s = setup(t, files); prepare(s); }
    const before = s.listing().map(n => n + ":" + fs.readFileSync(path.join(s.base, "data", n)).toString("hex"));
    const status = JSON.stringify(s.queueStore.getGlobalStatus());
    const p = printer("p1"), others = [printer("p2"), printer("p3", "pp_x")];
    let enabled = false;

    const r = changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_a", saveConfig: s.saveConfig });
    assert.deepEqual([r.ok, r.status, r.code, r.reason], [false, 503, "queue_store_unavailable", "store-unavailable"], "refused before the store is asked to change anything");
    const e = enableQueueManagement({ queueStore: s.queueStore, printers: [p, ...others], defaultPoolId: "pp_default", setEnabled: on => { enabled = on; }, saveConfig: s.saveConfig });
    assert.deepEqual([e.ok, e.status, e.code, e.reason], [false, 503, "queue_store_unavailable", "store-unavailable"]);
    // Also with no printer left to manage, where the queue store would not be asked at all.
    const none = enableQueueManagement({ queueStore: s.queueStore, printers: [], defaultPoolId: "pp_default", setEnabled: on => { enabled = on; }, saveConfig: s.saveConfig });
    assert.deepEqual([none.ok, none.code, enabled], [false, "queue_store_unavailable", false]);

    assert.deepEqual([p.printerPoolId, others[0].printerPoolId, others[1].printerPoolId, enabled, s.ctl.saves], [undefined, undefined, "pp_x", false, 0], "settings untouched and never saved");
    assert.equal(s.state("p1"), "unmanaged");
    assert.deepEqual(s.listing().map(n => n + ":" + fs.readFileSync(path.join(s.base, "data", n)).toString("hex")), before, "no queue file was written, moved or created");
    assert.equal(JSON.stringify(s.queueStore.getGlobalStatus()), status);
  });
}

test("pool change: the queue store's own refusal is checked — a save that fails changes neither the settings nor the queue", t => {
  const s = setup(t), p = printer("p1");
  s.ctl.storeFails = true;                      // healthy when asked, fails when it saves
  const r = changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_a", saveConfig: s.saveConfig });
  assert.deepEqual([r.ok, r.status, r.code, r.reason], [false, 503, "queue_store_unavailable", "persist-failed"]);
  assert.deepEqual([p.printerPoolId, s.state("p1"), s.ctl.saves], [undefined, "unmanaged", 0]);
});

test("pool change: settings cannot be saved — the settings in memory and the queue store are put back, in both directions", t => {
  const s = setup(t), p = printer("p1");
  s.ctl.configFails = true;
  let r = changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_a", saveConfig: s.saveConfig });
  assert.deepEqual([r.ok, r.status, r.code], [false, 500, "config_save_failed"]);
  assert.deepEqual([p.printerPoolId, s.state("p1"), s.onDisk("p1")], [undefined, "unmanaged", "unmanaged"]);

  s.ctl.configFails = false;
  assert.equal(changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_a", saveConfig: s.saveConfig }).ok, true);
  s.ctl.configFails = true;
  r = changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: null, saveConfig: s.saveConfig });
  assert.equal(r.code, "config_save_failed");
  assert.deepEqual([p.printerPoolId, s.state("p1"), s.onDisk("p1")], ["pp_a", "idle", "idle"]);
  r = changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_b", saveConfig: s.saveConfig });   // pool to pool
  assert.deepEqual([r.code, p.printerPoolId, s.state("p1")], ["config_save_failed", "pp_a", "idle"]);
});

test("pool change: settings cannot be saved AND the queue store cannot be put back — reported as incomplete, never as done or as unchanged", t => {
  const s = setup(t), p = printer("p1");
  const saveConfig = () => { s.ctl.storeFails = true; throw err("ENOSPC"); };   // the disk fills between the two saves
  const r = changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_a", saveConfig });
  assert.deepEqual([r.ok, r.status, r.code, r.undoReason], [false, 500, "pool_change_incomplete", "persist-failed"]);
  assert.equal(p.printerPoolId, undefined, "the settings in memory match the settings on disk");
  assert.equal(s.state("p1"), "idle", "the queue store still has the change — which is what the answer says");
  assert.equal(s.queueStore.getGlobalStatus().storeDegraded, true);
  // Setting it again once the disk works brings the two back together.
  s.ctl.storeFails = false;
  assert.equal(s.queueStore.retrySave().ok, true);
  assert.equal(changePrinterPool({ queueStore: s.queueStore, printer: p, printerPoolId: "pp_a", saveConfig: s.saveConfig }).ok, true);
  assert.deepEqual([p.printerPoolId, s.state("p1"), s.onDisk("p1")], ["pp_a", "idle", "idle"]);
});

const fleet = () => [printer("p1"), printer("p2", "pp_x"), printer("p3")];
function enable(s, printers, flags, saveConfig = s.saveConfig) {
  return enableQueueManagement({ queueStore: s.queueStore, printers, defaultPoolId: "pp_default", setEnabled: on => { flags.enabled = on; }, saveConfig });
}

test("enabling: every unmanaged printer becomes managed in one queue save, printers without a pool get the default one, then the settings are saved", t => {
  const s = setup(t), printers = fleet(), flags = { enabled: false };
  s.queueStore.assignPool("p2");                // already managed
  const writes = s.ctl.storeWrites;
  const r = enable(s, printers, flags);
  assert.deepEqual([r.ok, r.managed], [true, 2]);
  assert.equal(s.ctl.storeWrites - writes, 1, "one queue save for all of them");
  assert.deepEqual(printers.map(p => p.printerPoolId), ["pp_default", "pp_x", "pp_default"]);
  assert.deepEqual(["p1", "p2", "p3"].map(s.onDisk), ["idle", "idle", "idle"]);
  assert.deepEqual([flags.enabled, s.ctl.saves], [true, 1]);
});

test("enabling: the queue save fails — nothing is switched on, no printer is half-managed, the settings are not saved", t => {
  const s = setup(t), printers = fleet(), flags = { enabled: false };
  s.ctl.storeFails = true;
  const r = enable(s, printers, flags);
  assert.deepEqual([r.ok, r.status, r.code, r.reason], [false, 503, "queue_store_unavailable", "persist-failed"]);
  assert.deepEqual(printers.map(p => p.printerPoolId), [undefined, "pp_x", undefined]);
  assert.deepEqual(["p1", "p2", "p3"].map(s.state), ["unmanaged", "unmanaged", "unmanaged"]);
  assert.deepEqual([flags.enabled, s.ctl.saves], [false, 0]);
});

test("enabling: the settings cannot be saved — switched back off, pools taken back, and only the printers this call managed are unmanaged again", t => {
  const s = setup(t), printers = fleet(), flags = { enabled: false };
  s.queueStore.assignPool("p2");
  s.ctl.configFails = true;
  const r = enable(s, printers, flags);
  assert.deepEqual([r.ok, r.status, r.code], [false, 500, "config_save_failed"]);
  assert.deepEqual(printers.map(p => p.printerPoolId), [undefined, "pp_x", undefined]);
  assert.deepEqual(["p1", "p2", "p3"].map(s.onDisk), ["unmanaged", "idle", "unmanaged"], "p2 was managed before and stays so");
  assert.equal(flags.enabled, false);
});

test("enabling: the settings cannot be saved AND the queue store cannot be put back — reported as incomplete", t => {
  const s = setup(t), printers = fleet(), flags = { enabled: false };
  const r = enable(s, printers, flags, () => { s.ctl.storeFails = true; throw err("ENOSPC"); });
  assert.deepEqual([r.ok, r.status, r.code, r.undoReason], [false, 500, "queue_enable_incomplete", "persist-failed"]);
  assert.equal(flags.enabled, false);
  assert.deepEqual(printers.map(p => p.printerPoolId), [undefined, "pp_x", undefined]);
  assert.deepEqual(["p1", "p3"].map(s.state), ["idle", "idle"], "what the answer says: the queue has them as managed");
  s.ctl.storeFails = false;
  assert.equal(s.queueStore.retrySave().ok, true);
  assert.equal(enable(s, printers, flags).ok, true, "switching it on again completes it");
  assert.deepEqual([flags.enabled, ...printers.map(p => p.printerPoolId)], [true, "pp_default", "pp_x", "pp_default"]);
});

test("the two routes in server.js go through these functions and act on their answer", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const route = name => { const at = src.indexOf(`app.post("${name}"`); assert.ok(at > 0, name); return src.slice(at, src.indexOf("\n});", at)); };
  const pool = route("/api/printer-pool"), on = route("/api/queue-management/enable");
  assert.match(pool, /changePrinterPool\(/);
  assert.match(on, /enableQueueManagement\(/);
  for (const r of [pool, on]) {
    assert.doesNotMatch(r, /queueStore\.(assignPool|unassignPool)\(/, "no unchecked store call left in the route");
    assert.match(r, /if \(!r\.ok\) \{[\s\S]*?return res\.status\(r\.status\)\.json\(\{ error: r\.error, code: r\.code \}\);/, "a refusal is answered with its status and code");
    assert.ok(r.search(/if \(!r\.ok\)/) < r.search(/event: "(printer-pool-changed|queue-management-enabled)"/), "and before the success is audited");
  }
});

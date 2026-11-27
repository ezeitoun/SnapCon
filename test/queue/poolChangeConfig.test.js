// test/queue/poolChangeConfig.test.js — what the pool / Queue Management
// changes (queue/poolChange.js) do with each way the settings save can fail,
// using the real replaceConfigFile() on a real config.json and the real
// QueueStore, with single filesystem calls made to fail:
//   - config.json could not be read at start-up  -> refused, nothing written;
//   - the save failed and config.json is unchanged -> everything put back;
//   - the save replaced config.json but could not confirm it durable -> the
//     change STANDS everywhere and is reported as not confirmed;
//   - config.json cannot be renamed over (a mount point) -> the save fails,
//     the file is never written where it is, everything is put back, and the
//     answer says why; if the queue cannot be put back, THAT is said — there
//     is no promise that a failed save always leaves both records as before.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createQueueStore } = require("../../queue/QueueStore");
const { changePrinterPool, enableQueueManagement, disableQueueManagement } = require("../../queue/poolChange");
const { replaceConfigFile } = require("../../configLoader");

const quiet = t => { const o = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; t.after(() => Object.assign(console, o)); };
const err = code => Object.assign(new Error(code + ": simulated"), { code });

// A config.json, a queue store, and a switchboard of faults. cfg is the
// settings object "in memory"; save() writes it the way server.js does.
function setup(t) {
  quiet(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-poolcfg-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "data"));
  const cfgPath = path.join(base, "config.json");
  const cfg = { queueManagement: { enabled: false }, printers: [{ id: "p1", name: "p1" }, { id: "p2", name: "p2" }], pad: "x".repeat(300) };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const ctl = { mountPoint: null, tmpWriteFails: false, dirFlushFails: false, storeFails: false, cfgOpens: [] };   // mountPoint: the code the rename fails with
  const fdName = new Map();
  const fsImpl = { ...fs,
    openSync(p, ...r) { const n = path.basename(p); if (n === "queue-data.json.tmp" && ctl.storeFails) throw err("EIO"); if (n === "config.json") ctl.cfgOpens.push(String(r[0])); const fd = fs.openSync(p, ...r); fdName.set(fd, n); return fd; },
    writeSync(fd, buf, off, len, ...r) {
      const n = fdName.get(fd);
      if (n === "config.json.tmp" && ctl.tmpWriteFails) throw err("ENOSPC");
      return fs.writeSync(fd, buf, off, len, ...r);
    },
    fsyncSync(fd) { if (fdName.get(fd) === path.basename(base) && ctl.dirFlushFails) throw err("EIO"); return fs.fsyncSync(fd); },
    closeSync(fd) { fdName.delete(fd); return fs.closeSync(fd); },
    renameSync(a, b) { if (path.basename(a) === "config.json.tmp" && ctl.mountPoint) throw err(ctl.mountPoint); return fs.renameSync(a, b); },
  };
  const queueStore = createQueueStore({ baseDir: base, degradedRetryMs: 3600000, fsImpl });
  queueStore.load();
  const save = () => replaceConfigFile(cfgPath, JSON.stringify(cfg, null, 2), { fsImpl });
  const disk = () => fs.readFileSync(cfgPath, "utf8");
  const diskCfg = () => JSON.parse(disk());
  const state = id => queueStore.getPrinterState(id).queueState;
  return { base, cfg, ctl, queueStore, save, disk, diskCfg, state };
}
const pool = (s, printerPoolId, extra) => changePrinterPool({ queueStore: s.queueStore, printer: s.cfg.printers[0], printerPoolId, saveConfig: s.save, ...extra });
const enable = (s, extra) => enableQueueManagement({ queueStore: s.queueStore, printers: s.cfg.printers, defaultPoolId: "pp_default", setEnabled: on => { s.cfg.queueManagement.enabled = on; }, saveConfig: s.save, ...extra });
const disable = (s, extra) => disableQueueManagement({ isEnabled: () => s.cfg.queueManagement.enabled, setEnabled: on => { s.cfg.queueManagement.enabled = on; }, saveConfig: s.save, ...extra });

test("config.json could not be read at start-up: pool change, enabling and disabling are refused with 409 before anything is touched or written", t => {
  const s = setup(t);
  s.cfg.queueManagement.enabled = true;          // in memory only; the file on disk says off
  const before = s.disk(), files = fs.readdirSync(path.join(s.base, "data"));
  for (const r of [pool(s, "pp_a", { configLoadFailed: true }), enable(s, { configLoadFailed: true }), disable(s, { configLoadFailed: true })]) {
    assert.deepEqual([r.ok, r.status, r.code], [false, 409, "config_unreadable"]);
  }
  assert.equal(s.disk(), before, "config.json was not written from the defaults in memory");
  assert.deepEqual(fs.readdirSync(path.join(s.base, "data")), files, "no queue file either");
  assert.deepEqual([s.cfg.printers[0].printerPoolId, s.cfg.queueManagement.enabled, s.state("p1")], [undefined, true, "unmanaged"]);
});

test("the settings save fails with config.json unchanged on disk (the disk fills while the new file is written): memory and the queue are put back, and the file is what it was", t => {
  const s = setup(t), before = s.disk();
  s.ctl.tmpWriteFails = true;
  let r = pool(s, "pp_a");
  assert.deepEqual([r.ok, r.status, r.code], [false, 500, "config_save_failed"]);
  assert.deepEqual([s.cfg.printers[0].printerPoolId, s.state("p1")], [undefined, "unmanaged"]);
  r = enable(s);
  assert.deepEqual([r.code, s.cfg.queueManagement.enabled, s.state("p1"), s.state("p2")], ["config_save_failed", false, "unmanaged", "unmanaged"]);
  s.cfg.queueManagement.enabled = true;
  r = disable(s);
  assert.deepEqual([r.ok, r.status, r.code, s.cfg.queueManagement.enabled], [false, 500, "config_save_failed", true]);
  assert.equal(s.disk(), before);
});

test("the save replaced config.json but the folder flush failed: the change stands in memory, in the queue and on disk, and is reported as not confirmed — not undone, not called a failure to change", t => {
  const s = setup(t);
  s.ctl.dirFlushFails = true;
  let r = pool(s, "pp_a");
  assert.deepEqual([r.ok, r.status, r.code, r.applied], [false, 500, "config_save_not_durable", true]);
  assert.deepEqual([s.cfg.printers[0].printerPoolId, s.diskCfg().printers[0].printerPoolId, s.state("p1")], ["pp_a", "pp_a", "idle"], "all three agree");
  assert.doesNotMatch(r.error, /not changed|was not/i);

  r = enable(s);
  assert.deepEqual([r.code, r.applied, s.cfg.queueManagement.enabled, s.diskCfg().queueManagement.enabled, s.state("p2")], ["config_save_not_durable", true, true, true, "idle"]);
  r = disable(s);
  assert.deepEqual([r.code, r.applied, s.cfg.queueManagement.enabled, s.diskCfg().queueManagement.enabled], ["config_save_not_durable", true, false, false]);
});

for (const code of ["EBUSY", "EXDEV"]) {
  test(`config.json is a mount point and cannot be renamed over (${code}): pool change, enabling and disabling all fail, memory and the queue are put back, and the file is never opened for writing`, t => {
    for (const [what, act, check] of [
      ["pool", s => pool(s, "pp_a"), s => assert.deepEqual([s.cfg.printers[0].printerPoolId, s.state("p1")], [undefined, "unmanaged"])],
      ["enable", s => enable(s), s => assert.deepEqual([s.cfg.queueManagement.enabled, s.cfg.printers[1].printerPoolId, s.state("p1"), s.state("p2")], [false, undefined, "unmanaged", "unmanaged"])],
      ["disable", s => { s.cfg.queueManagement.enabled = true; return disable(s); }, s => assert.equal(s.cfg.queueManagement.enabled, true)],
    ]) {
      const s = setup(t), before = fs.readFileSync(path.join(s.base, "config.json"));
      s.ctl.mountPoint = code;
      const r = act(s);
      assert.deepEqual([r.ok, r.status, r.code, r.applied], [false, 500, "config_save_failed", undefined], what);
      check(s);
      assert.deepEqual(fs.readFileSync(path.join(s.base, "config.json")), before, what + ": the same bytes on disk");
      assert.deepEqual(s.ctl.cfgOpens, [], what + ": config.json itself was never opened");
      assert.deepEqual(fs.readdirSync(s.base).sort(), ["config.json", "data"], what + ": no temporary file left");
      assert.match(r.error, /cannot be replaced where it is/, what + ": says why, so that it is not taken for a passing disk problem");
      assert.match(r.error, new RegExp("\\(" + code + "\\)"), what);
      assert.equal(/[\\/]/.test(r.error), false, what + ": no server path");
      assert.equal("configFileDamaged" in r, false, what + ": nothing here can damage the file any more");
    }
  });
}

test("an ordinary failed save does not carry the mount-point explanation", t => {
  const s = setup(t);
  s.ctl.tmpWriteFails = true;
  assert.doesNotMatch(pool(s, "pp_a").error, /replaced where it is/);
});

test("config.json cannot be renamed over AND the queue cannot be put back: reported as incomplete (the queue has the change, the settings do not) — never as 'as it was'", t => {
  const s = setup(t), before = s.disk();
  s.ctl.mountPoint = "EBUSY";
  const realSave = s.save;
  s.save = () => { try { realSave(); } finally { s.ctl.storeFails = true; } };   // the queue's disk fails too, from here
  let r = pool(s, "pp_a");
  assert.deepEqual([r.ok, r.status, r.code], [false, 500, "pool_change_incomplete"]);
  assert.match(r.error, /only partly saved/);
  assert.match(r.error, /cannot be replaced where it is \(EBUSY\)/, "and why repeating it will not help");
  assert.doesNotMatch(r.error, /will not work until/);
  assert.deepEqual([s.cfg.printers[0].printerPoolId, s.state("p1")], [undefined, "idle"], "memory was put back; the queue still has the change, as the answer says");
  assert.equal(s.disk(), before);

  const s2 = setup(t);
  s2.ctl.mountPoint = "EXDEV";
  const realSave2 = s2.save;
  s2.save = () => { try { realSave2(); } finally { s2.ctl.storeFails = true; } };
  r = enable(s2);
  assert.deepEqual([r.code, s2.cfg.queueManagement.enabled, s2.state("p1")], ["queue_enable_incomplete", false, "idle"]);
  assert.match(r.error, /cannot be replaced where it is \(EXDEV\)/);
  assert.deepEqual(s2.ctl.cfgOpens, []);
});

test("the three routes in server.js pass the start-up read failure to these functions and save through replaceConfigFile, not a plain write", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const route = name => { const a = src.indexOf(`app.post("${name}"`); assert.ok(a > 0, name); return src.slice(a, src.indexOf("\napp.", a + 10)); };
  for (const [name, fn] of [["/api/queue-management/enable", "enableQueueManagement"], ["/api/queue-management/disable", "disableQueueManagement"], ["/api/printer-pool", "changePrinterPool"]]) {
    const body = route(name);
    assert.match(body, new RegExp(fn + "\\(\\{"), name);
    assert.match(body, /configLoadFailed: CONFIG_LOAD_FAILED/, name);
    assert.match(body, /saveConfig: saveConfigReplacing/, name);
    assert.doesNotMatch(body, /fs\.writeFileSync\(CONFIG_PATH/, name + ": no plain write left");
    assert.match(body, /res\.status\(r\.status\)/, name);
  }
  assert.match(src, /const saveConfigReplacing = \(\) => replaceConfigFile\(CONFIG_PATH, JSON\.stringify\(CFG, null, 2\)\);/);
});

// test/library/folderRescan.test.js — Rescan from the Library page, on real
// scans of a temporary folder: overlapping requests (two clicks, two tabs)
// run one scan; a new subfolder shows in the tree after it, a deleted one
// leaves it; a failed location says why in words that never carry its
// folder; and the Regular role may rescan (library.rescan) without ever
// seeing the folder, View may not.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const auth = require("../../auth");
const { createLibraryService, GCODE_ROOT } = require("../../library/LibraryService");
const { registerLibraryRoutes } = require("../../library/routes");
const { createNetFs } = require("../../netfs/NetFs");
const { gcodeFile } = require("./helpers/gcode");

const quiet = { log() {}, warn() {}, error() {} };
const put = (dir, rel, data) => { const p = path.join(dir, ...rel.split("/")); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const G = name => gcodeFile({ printerModel: "Snapmaker U1", settingsId: "U1 (0.4mm)", objects: [[name + ".stl", 1]] });

async function make(t, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-frs-"));
  const gcode = path.join(base, "gcode");
  fs.mkdirSync(gcode);
  for (const [rel, name] of Object.entries(files)) put(gcode, rel, G(name));
  const nf = createNetFs({ log: quiet, opTimeoutMs: 5000, probeEveryMs: 60000 });
  const lib = createLibraryService({ baseDir: base, getGcodeFolder: () => gcode, log: quiet, netfs: nf, scanBudget: 1024 * 1024 * 1024, workerOptions: { log: quiet } });
  t.after(async () => { await lib.stop(); await nf.stop(); });
  lib.start();
  await settle(lib);
  return { lib, gcode, base };
}
const runs = lib => lib._store.db.prepare("SELECT count(*) AS n FROM scan_runs WHERE root_id = ?").get(GCODE_ROOT).n;
async function settle(lib) {
  for (let i = 0; i < 400; i++) {
    const s = lib.scanState(GCODE_ROOT);
    if (!s.scanning && !s.queued && !s.checking && runs(lib) > 0) { await lib._idle(); if (!lib.scanState(GCODE_ROOT).queued) return; }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("the scan did not settle");
}
const top = lib => lib.folders({ root: GCODE_ROOT }, { role: "admin", implicit: true }).roots[0].children.map(c => c.name);

test("two overlapping rescans run one scan; a new subfolder appears after it and a deleted one goes", async t => {
  const { lib, gcode } = await make(t, { "Cinderwin 3D/Bat.gcode": "Bat", "KKReation/Fox.gcode": "Fox" });
  assert.deepEqual(top(lib), ["Cinderwin 3D", "KKReation"]);
  put(gcode, "STLFlix/Dragons/Wyvern.gcode", G("Wyvern"));
  fs.rmSync(path.join(gcode, "KKReation"), { recursive: true });
  const before = runs(lib);
  await Promise.all([lib.rescan(GCODE_ROOT), lib.rescan(GCODE_ROOT)]);
  await settle(lib);
  assert.equal(runs(lib) - before, 1, "the second request joined the first");
  assert.deepEqual(top(lib), ["Cinderwin 3D", "STLFlix"]);
  assert.ok(lib.scanState(GCODE_ROOT).lastScanAt > 0);
});

test("a location that can't be read: the scan state says why in plain words, never its folder", async t => {
  const { lib, gcode, base } = await make(t, { "A/a.gcode": "A" });
  const dir = path.join(base, "elsewhere"); fs.mkdirSync(dir);
  const added = await lib.addRoot({ path: dir, name: "U1 Files" });
  fs.rmSync(dir, { recursive: true });
  const v = await lib.rescan(added.id);
  assert.equal(v.status, "error");
  const s = lib.scanState(added.id);
  assert.equal(s.error, "folder not found");
  assert.ok(!JSON.stringify(s).includes(dir) && !JSON.stringify(s).includes(base), "no folder in the answer");
  assert.ok(top(lib).includes("A"), "the other location's list is untouched");
  void gcode;
});

test("routes: Regular may rescan and gets no folder back; View may not; everyone who can view gets the folders", async t => {
  const { lib } = await make(t, { "A/a.gcode": "A" });
  const USERS = { view: { id: "u-v", role: "view", groupIds: [] }, regular: { id: "u-r", role: "regular", groupIds: [] }, admin: { id: "u-a", role: "admin", groupIds: [] } };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = USERS[req.headers["x-as"]] || null; next(); });
  registerLibraryRoutes(app, { library: lib, requireAuth: auth.requireAuth, actorFromReq: () => ({}) });
  const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => new Promise(r => { srv.closeAllConnections(); srv.close(r); }));
  const call = async (as, method, p) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method, headers: { "x-as": as } }); return { status: res.status, body: await res.json() }; };
  const reg = await call("regular", "POST", "/api/library/roots/gcode/rescan");
  assert.equal(reg.status, 200);
  assert.equal(reg.body.path, undefined);
  assert.equal(reg.body.id, "gcode");
  const adm = await call("admin", "POST", "/api/library/roots/gcode/rescan");
  assert.equal(typeof adm.body.path, "string", "Settings (managers) still gets the full view");
  assert.equal((await call("view", "POST", "/api/library/roots/gcode/rescan")).status, 403);
  const f = await call("view", "GET", "/api/library/folders?location=gcode");
  assert.equal(f.status, 200);
  assert.deepEqual(f.body.roots[0].children.map(c => c.name), ["A"]);
  const ov = await call("regular", "GET", "/api/library/overview");
  assert.equal(ov.body.can.rescan, true);
  assert.equal((await call("view", "GET", "/api/library/overview")).body.can.rescan, false);
  assert.equal(ov.body.roots[0].path, undefined);
  await settle(lib);
});

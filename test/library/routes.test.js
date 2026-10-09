// test/library/routes.test.js — who may do what over HTTP (§11), with the real
// routes, the real service and a real database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const auth = require("../../auth");
const { createLibraryService } = require("../../library/LibraryService");
const { registerLibraryRoutes } = require("../../library/routes");

const quiet = { log() {}, warn() {}, error() {} };
const USERS = {
  view: { id: "u-v", role: "view", groupIds: [] },
  regular: { id: "u-r", role: "regular", groupIds: [] },
  admin: { id: "u-a", role: "admin", groupIds: [] },
  implicit: { role: "admin", implicit: true },
};

// Every server is closed when its test ends, pass or fail, so a failure never
// leaves the process running.
async function server(t, { broken = false, audit } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-rt-"));
  fs.mkdirSync(path.join(base, "gcode"));
  if (broken) fs.mkdirSync(path.join(base, "library-data", "library.db"), { recursive: true });
  const library = createLibraryService({ baseDir: base, getGcodeFolder: () => path.join(base, "gcode"), log: quiet, workerOptions: { log: quiet }, ...(audit ? { audit } : {}) });
  library.start();
  const app = express();
  app.use(express.json());
  // Stands in for auth.makeAuthMiddleware: the test says who is calling.
  app.use((req, res, next) => { req.user = req.headers["x-as"] ? USERS[req.headers["x-as"]] : null; next(); });
  registerLibraryRoutes(app, { library, requireAuth: auth.requireAuth, actorFromReq: () => ({ userId: null, userLabel: null }) });
  const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const call = async (as, method, p, body) => {
    const res = await fetch(url + p, { method, headers: { "content-type": "application/json", ...(as ? { "x-as": as } : {}) }, body: body && method !== "GET" ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => { srv.closeAllConnections(); await new Promise(r => srv.close(r)); await library.stop(); };
  t.after(close);
  return { call, base, url, library };
}

test("signed-out callers get 401 everywhere", async t => {
  const s = await server(t);
  for (const [m, p] of [["GET", "/api/library/status"], ["GET", "/api/library/roots"], ["POST", "/api/library/roots"], ["POST", "/api/library/backup"]]) {
    assert.equal((await s.call(null, m, p, {})).status, 401, `${m} ${p}`);
  }
});

test("view and regular users can list locations but not see their folders or change them", async t => {
  const s = await server(t);
  for (const who of ["view", "regular"]) {
    const list = await s.call(who, "GET", "/api/library/roots");
    assert.equal(list.status, 200);
    assert.ok(list.body.roots.length >= 1);
    assert.equal(list.body.roots[0].path, undefined, "a folder can be an internal UNC path");
    assert.equal((await s.call(who, "POST", "/api/library/roots", { path: s.base })).status, 403);
    assert.equal((await s.call(who, "DELETE", "/api/library/roots/gcode")).status, 403);
    // Rescan (library.rescan): Regular may, View may not; neither sees the folder.
    const rs = await s.call(who, "POST", "/api/library/roots/gcode/rescan");
    assert.equal(rs.status, who === "regular" ? 200 : 403);
    if (who === "regular") assert.equal(rs.body.path, undefined, "a folder can be an internal UNC path");
    assert.equal((await s.call(who, "POST", "/api/library/backup")).status, 403);
    const st = await s.call(who, "GET", "/api/library/status");
    assert.equal(st.status, 200);
    assert.equal(st.body.recovery, undefined, "recovery details are for those who manage backups");
  }
});

test("admins, and the implicit admin when users are off, manage locations and backups", async t => {
  const s = await server(t);
  for (const who of ["admin", "implicit"]) {
    const dir = path.join(s.base, "models-" + who); fs.mkdirSync(dir);
    const add = await s.call(who, "POST", "/api/library/roots", { path: dir });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.equal(add.body.status, "ok");
    const list = await s.call(who, "GET", "/api/library/roots");
    assert.ok(list.body.roots.every(r => typeof r.path === "string"));
    assert.equal((await s.call(who, "PATCH", "/api/library/roots/" + add.body.id, { name: "Downloads" })).body.name, "Downloads");
    assert.equal((await s.call(who, "POST", "/api/library/roots/" + add.body.id + "/rescan")).status, 200);
    assert.equal((await s.call(who, "DELETE", "/api/library/roots/" + add.body.id)).status, 200);
  }
  const b = await s.call("admin", "POST", "/api/library/backup");
  assert.equal(b.status, 200);
  assert.ok(b.body.file);
});

test("validation errors come back with a status and a code the UI can translate", async t => {
  const s = await server(t);
  assert.deepEqual((await s.call("admin", "POST", "/api/library/roots", { path: "" })).body.code, "path_required");
  const o = await s.call("admin", "POST", "/api/library/roots", { path: path.join(s.base, "gcode") });
  assert.equal(o.status, 409);
  assert.equal(o.body.code, "overlap");
  assert.equal((await s.call("admin", "DELETE", "/api/library/roots/gcode")).body.code, "gcode_fixed");
  assert.equal((await s.call("admin", "DELETE", "/api/library/roots/loc_nope")).status, 404);
});

test("an unavailable Library answers 503 with a reason, and its status says why", async t => {
  const s = await server(t, { broken: true });
  const r = await s.call("admin", "GET", "/api/library/roots");
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "library_unavailable");
  const st = await s.call("view", "GET", "/api/library/status");
  assert.equal(st.body.available, false);
  assert.match(st.body.reason, /cannot open/);
});

test("M2: the raw diagnostic view and scan statistics are admin-only; thumbnails need library.view", async t => {
  const s = await server(t);
  fs.writeFileSync(path.join(s.base, "gcode", "a.gcode"), require("./helpers/gcode").gcodeFile({ printerModel: "Snapmaker U1" }));
  assert.equal((await s.call("admin", "POST", "/api/library/roots/gcode/rescan")).status, 200);
  let raw;
  for (let i = 0; i < 200; i++) {
    raw = await s.call("admin", "GET", "/api/library/diagnostics/raw");
    if (raw.body.files && raw.body.files.length && raw.body.files[0].thumb) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(raw.status, 200);
  assert.equal(raw.body.files[0].printer.family, "snapmaker-u1");
  for (const who of ["view", "regular"]) {
    assert.equal((await s.call(who, "GET", "/api/library/diagnostics/raw")).status, 403, who);
    assert.equal((await s.call(who, "GET", "/api/library/diagnostics/scans")).status, 403, who);
    assert.equal((await s.call(who, "POST", "/api/library/rebuild")).status, 403, who);
  }
  assert.equal((await s.call("admin", "GET", "/api/library/diagnostics/scans")).status, 200);
  const key = raw.body.files[0].thumb;
  const img = await fetch(s.url + "/api/library/thumbs/" + key, { headers: { "x-as": "view" } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await fetch(s.url + "/api/library/thumbs/..%2F..%2Flibrary.db", { headers: { "x-as": "view" } })).status, 404, "only a well-formed key is looked up");
  assert.equal((await s.call("view", "GET", "/api/library/thumbs/e" + "0".repeat(31))).status, 404);
  assert.equal((await s.call(null, "GET", "/api/library/thumbs/" + key)).status, 401);
});

test("M4: grouping diagnostics are admin-only, versioned, and export without run timestamps", async t => {
  const { gcodeFile } = require("./helpers/gcode");
  const s = await server(t);
  fs.writeFileSync(path.join(s.base, "gcode", "Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 1]] }));
  fs.writeFileSync(path.join(s.base, "gcode", "4x Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 4]], bodyBytes: 3000 }));
  assert.equal((await s.call("admin", "POST", "/api/library/roots/gcode/rescan")).status, 200);
  let d;
  for (let i = 0; i < 400; i++) {
    await s.library._idle();
    d = await s.call("admin", "GET", "/api/library/diagnostics/grouping");
    if (d.body.generatedAt && d.body.summary.multiFileModels === 1) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(d.status, 200);
  assert.equal(d.body.ruleVersion, require("../../library/grouping").RULE_VERSION);
  const m = d.body.models.find(x => x.files.length === 2);
  assert.ok(m, "the two Beardies are one Model");
  assert.ok(m.files.every(f => f.why.method && f.why.evidence.length), "each file says why it is there");
  for (const who of ["view", "regular"]) assert.equal((await s.call(who, "GET", "/api/library/diagnostics/grouping")).status, 403, who);
  const res = await fetch(s.url + "/api/library/diagnostics/grouping?export=1", { headers: { "x-as": "admin" } });
  assert.match(res.headers.get("content-disposition") || "", /attachment/);
  const ex = await res.json();
  assert.equal(ex.kind, "snapcon-library-grouping");
  assert.equal(ex.generatedAt, undefined);
  assert.equal(ex.lastRun, undefined);
});

test("a location's error is withheld from those who don't manage locations: it can name the share", async t => {
  const s = await server(t);
  // Let the start-up check and scan finish first: a successful one clears the error.
  assert.equal((await s.call("admin", "POST", "/api/library/roots/gcode/rescan")).status, 200);
  await s.library._idle();
  s.library._store.db.prepare("UPDATE roots SET last_error = ? WHERE id = 'gcode'").run("The storage at \\\\nas-box\\models is unreachable");
  for (const who of ["view", "regular"]) {
    const r = await s.call(who, "GET", "/api/library/roots");
    assert.equal(r.body.roots[0].path, undefined, who);
    assert.equal(r.body.roots[0].lastError, undefined, who);
    assert.ok(!JSON.stringify(r.body).includes("nas-box"), who + ": no part of the share leaks");
  }
  assert.match((await s.call("admin", "GET", "/api/library/roots")).body.roots[0].lastError, /nas-box/, "admins still see why");
});

test("M5: every role with library.view browses the Library; no answer carries a location's folder, not even in an error", async t => {
  const { gcodeFile } = require("./helpers/gcode");
  const s = await server(t);
  fs.writeFileSync(path.join(s.base, "gcode", "Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 1]] }));
  fs.writeFileSync(path.join(s.base, "gcode", "4x Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 4]], bodyBytes: 3000 }));
  assert.equal((await s.call("admin", "POST", "/api/library/roots/gcode/rescan")).status, 200);
  let list;
  for (let i = 0; i < 400; i++) {
    await s.library._idle();
    list = await s.call("view", "GET", "/api/library/models");
    if (list.status === 200 && list.body.total === 1 && list.body.models[0].files === 2) break;
    await new Promise(r => setTimeout(r, 25));
  }
  // A network error names the share: it is a path too.
  s.library._store.db.prepare("UPDATE roots SET last_error = ? WHERE id = 'gcode'").run("The storage at " + s.base + " is unreachable");
  const uuid = list.body.models[0].uuid;
  const base = s.base.replace(/\\/g, "\\\\");
  for (const who of ["view", "regular", "admin", "implicit"]) {
    for (const p of ["/api/library/overview", "/api/library/facets", "/api/library/models?q=beardie", "/api/library/models/" + uuid, "/api/library/attention"]) {
      const r = await s.call(who, "GET", p);
      assert.equal(r.status, 200, who + " " + p);
      const txt = JSON.stringify(r.body);
      assert.ok(!txt.includes(s.base) && !txt.includes(base), `${who} ${p} must not carry the location's folder`);
    }
  }
  for (const who of ["view", "regular"]) {
    const roots = await s.call(who, "GET", "/api/library/roots");
    assert.equal(roots.body.roots[0].path, undefined);
    assert.equal(roots.body.roots[0].lastError, undefined, who + ": an error message can name the share");
  }
  assert.match((await s.call("admin", "GET", "/api/library/roots")).body.roots[0].lastError, /unreachable/, "admins still see why");
  assert.equal((await s.call(null, "GET", "/api/library/models")).status, 401);
  const detail = await s.call("view", "GET", "/api/library/models/" + uuid);
  assert.equal(detail.body.printables.length, 2);
  assert.ok(detail.body.printables.every(v => v.send.ok && v.file.rootName && !("rootPath" in v.file)));
  assert.equal((await s.call("view", "GET", "/api/library/models/00000000-0000-0000-0000-000000000000")).status, 404);
});

test("M5: the Library has no editing endpoints (merge, split, rename, hide and review are M6)", async t => {
  const s = await server(t);
  const u = "00000000-0000-0000-0000-000000000001";
  for (const [m, p] of [["PATCH", "/api/library/models/" + u], ["DELETE", "/api/library/models/" + u], ["POST", "/api/library/models/" + u + "/merge"],
    ["POST", "/api/library/decisions"], ["POST", "/api/library/review/1"], ["PUT", "/api/library/models/" + u + "/cover"]]) {
    for (const who of ["view", "admin"]) {
      const r = await fetch(s.url + p, { method: m, headers: { "content-type": "application/json", "x-as": who }, body: "{}" });
      assert.equal(r.status, 404, `${who} ${m} ${p}`);
    }
  }
});

// ---- M6: every change, checked by the server ----
async function m6Library(t) {
  const { gcodeFile } = require("./helpers/gcode");
  const events = [];
  const s = await server(t, { audit: (event, actor, detail) => events.push({ event, actor, detail }) });
  fs.writeFileSync(path.join(s.base, "gcode", "Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 1]] }));
  fs.writeFileSync(path.join(s.base, "gcode", "4x Beardie.gcode"), gcodeFile({ objects: [["Beardie.stl", 4]], bodyBytes: 3000 }));
  fs.writeFileSync(path.join(s.base, "gcode", "Gecko.gcode"), gcodeFile({ objects: [["Gecko.stl", 1]], bodyBytes: 4000 }));
  assert.equal((await s.call("admin", "POST", "/api/library/roots/gcode/rescan")).status, 200);
  let list;
  for (let i = 0; i < 400; i++) {
    await s.library._idle();
    list = await s.call("admin", "GET", "/api/library/models");
    if (list.status === 200 && list.body.total === 2) break;
    await new Promise(r => setTimeout(r, 25));
  }
  const beardie = list.body.models.find(m => m.files === 2).uuid, gecko = list.body.models.find(m => m.files === 1).uuid;
  const detail = await s.call("admin", "GET", "/api/library/models/" + beardie);
  const fourX = detail.body.printables.find(v => /4x/.test(v.file.name)).file.contentKey;
  return { s, events, beardie, gecko, fourX };
}

test("M6: no change to the Library without its capability — checked by the server for every action, and for undo", async t => {
  const { s, events, beardie, gecko, fourX } = await m6Library(t);
  const attempts = [
    { kind: "rename", model: beardie, name: "x" }, { kind: "cover", model: beardie, auto: true },
    { kind: "hide", model: beardie }, { kind: "unhide", model: beardie }, { kind: "hide_file", model: beardie, files: [fourX] },
    { kind: "merge", from: gecko, into: beardie }, { kind: "split", model: beardie, files: [fourX] }, { kind: "move", model: beardie, files: [fourX], to: gecko },
    { kind: "approve", review: 1, survivor: beardie }, { kind: "reject", review: 1 }, { kind: "dismiss", review: 1 },
    { kind: "set_printer", model: beardie, file: fourX, family: "flashforge-ad5x" },
  ];
  for (const a of attempts) {
    assert.equal((await s.call(null, "POST", "/api/library/actions", a)).status, 401, "signed out: " + a.kind);
    const v = await s.call("view", "POST", "/api/library/actions", a);
    assert.equal(v.status, 403, "view: " + a.kind);
    assert.equal(v.body.code, "forbidden");
  }
  assert.equal(events.length, 0, "nothing was done, nothing audited");
  const renamed = await s.call("regular", "POST", "/api/library/actions", { kind: "rename", model: beardie, name: "Bearded dragon" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal((await s.call("view", "GET", "/api/library/models/" + beardie)).body.name, "Bearded dragon");
  assert.equal((await s.call("view", "POST", "/api/library/actions/" + renamed.body.actionId + "/undo")).status, 403, "undo needs the same capability");
  const undone = await s.call("admin", "POST", "/api/library/actions/" + renamed.body.actionId + "/undo");
  assert.equal(undone.status, 200);
  assert.equal((await s.call("admin", "POST", "/api/library/actions/" + renamed.body.actionId + "/undo")).body.code, "already_undone");
  assert.deepEqual(events.map(e => e.event), ["model-rename", "model-change-undone"]);
  assert.equal(events[0].detail.after, "Bearded dragon");
  assert.ok(!JSON.stringify(events).includes(s.base), "the audit trail carries names, never folder paths");
});

test("M6: a stale action answers 409 with a reason; the Model page shows the history and what can still be undone", async t => {
  const { s, beardie, gecko, fourX } = await m6Library(t);
  const moved = await s.call("regular", "POST", "/api/library/actions", { kind: "move", model: beardie, files: [fourX], to: gecko });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const again = await s.call("regular", "POST", "/api/library/actions", { kind: "move", model: beardie, files: [fourX], to: gecko });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "stale_file");
  const merged = await s.call("regular", "POST", "/api/library/actions", { kind: "merge", from: gecko, into: beardie });
  assert.equal(merged.status, 200);
  const late = await s.call("regular", "POST", "/api/library/actions", { kind: "rename", model: gecko, name: "y" });
  assert.equal(late.status, 409);
  assert.deepEqual([late.body.code, late.body.mergedInto], ["model_merged", beardie], "and where it went");
  const page = await s.call("view", "GET", "/api/library/models/" + beardie);
  assert.deepEqual(page.body.history.map(h => [h.kind, h.undoable]), [["merge", true], ["move", false]]);
  assert.equal((await s.call("view", "GET", "/api/library/models/" + gecko)).body.mergedInto, beardie);
  assert.equal((await s.call("admin", "POST", "/api/library/actions", { kind: "nope" })).status, 400);
});

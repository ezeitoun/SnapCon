// test/uploadCrossTab.test.js — an upload's strip in every tab (TODO §24).
// The server reports a printer's running /api/print upload on its fleet row
// (activeUploadFor); every tab folds that into its strips
// (reconcileFleetUploads) without ever overriding an upload it started
// itself, without letting a late answer bring back a finished one, and
// without rebuilding a card for a progress tick. Covers cancelling from
// another tab, View-only users, and a page reloaded mid-upload.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const extract = (src, name) => { const at = src.indexOf("function " + name + "("); assert.ok(at >= 0, name); return src.slice(at, src.indexOf("\n}\n", at) + 3); };

// ---- server: the fleet row's upload ----

const srv = vm.createContext({});
vm.runInContext("const JOBS = new Map(); this.JOBS = JOBS;\n" + extract(serverSrc, "activeUploadFor"), srv);
const JOBS = srv.JOBS;
const upFor = id => JSON.parse(JSON.stringify(vm.runInContext("activeUploadFor", srv)(id) || null));

test("server: a printer's row reports its /api/print upload only while the bytes are going out", () => {
  JOBS.clear();
  JOBS.set("j1", { phase: "upload", done: false, printerId: "p_a", file: "Benchy.gcode", sent: 10, total: 100, ts: 1, cancelUpload: () => {} });
  assert.deepEqual(upFor("p_a"), { jobId: "j1", file: "Benchy.gcode", sent: 10, total: 100, cancellable: true });
  assert.equal(upFor("p_b"), null, "another printer's upload is not this one's");
  JOBS.get("j1").cancelUpload = null;
  assert.equal(upFor("p_a").cancellable, false, "the last bytes are written: nothing left to cancel");
  for (const phase of ["mapping", "starting", "error"]) { JOBS.get("j1").phase = phase; assert.equal(upFor("p_a"), null, phase); }
  JOBS.get("j1").phase = "upload"; JOBS.get("j1").done = true;
  assert.equal(upFor("p_a"), null, "done");
  JOBS.set("jStart", { phase: "starting", done: false, ts: 5 });   // /api/printfile jobs carry no printerId
  assert.equal(upFor(undefined), null);
});

test("server: two overlapping uploads to one printer — the newest is reported", () => {
  JOBS.clear();
  JOBS.set("old", { phase: "upload", done: false, printerId: "p_a", file: "A.gcode", sent: 1, total: 9, ts: 100 });
  JOBS.set("new", { phase: "upload", done: false, printerId: "p_a", file: "B.gcode", sent: 1, total: 9, ts: 200 });
  assert.equal(upFor("p_a").jobId, "new");
});

test("server: the row carries it only for a printer this user may see; cancelling checks role and printer", () => {
  const fleet = serverSrc.slice(serverSrc.indexOf('app.get("/api/fleet"'), serverSrc.indexOf('app.get("/api/fleet"') + 6000);
  const vis = fleet.indexOf("if (!printerVisibleTo(req.user, p)) return null;"), add = fleet.indexOf("const up = activeUploadFor(p.id);\n    if (up) row.upload = up;");
  assert.ok(vis > 0 && add > vis, "added after the visibility filter, to the row being returned");
  const cancel = serverSrc.slice(serverSrc.indexOf('app.post("/api/print-cancel"'), serverSrc.indexOf("\n});", serverSrc.indexOf('app.post("/api/print-cancel"')));
  assert.match(cancel, /requireRegular/, "View-only users are refused (403) whatever a page shows");
  assert.match(cancel, /printerVisibleTo\(req\.user, p\)/, "and only for a printer the user may see");
});

// ---- browser: folding the fleet's uploads into the strips ----

const ctx = vm.createContext({
  Map, Set, String, Math, Number, JSON,
  t: (k, p) => k + (p ? "(" + Object.entries(p).map(([a, b]) => a + "=" + b).join(",") + ")" : ""),
  esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  stripExt: n => String(n || "").replace(/\.[^./\\]+$/, ""),
  UPLOAD_CANCEL: new Map(), SEND_FILL: new Map(),
  ROLE_ACTS: true,
});
const uploadsAt = appSrc.indexOf("const JOB_ENDED_KEEP_MS");
vm.runInContext("const UPLOADS = new Map(); this.UPLOADS = UPLOADS;\nfunction canAct(){ return this.ROLE_ACTS; }\n" +
  appSrc.slice(uploadsAt, appSrc.indexOf("\n", uploadsAt)) + "\n" +
  ["reconcileFleetUploads", "uploadMB", "uploadDetailText", "uploadStripHtml", "sendInFlight", "fillBackground", "sendBtnAttrs"].map(n => extract(appSrc, n)).join("\n"), ctx);
const reconcile = (rows, uploads, ended, now = 1000) => { const r = vm.runInContext("reconcileFleetUploads", ctx)(rows, uploads, ended, now); return { rebuild: [...r.rebuild], paint: [...r.paint] }; };
const row = (id, upload) => ({ id, ...(upload ? { upload } : {}) });
const UP = (o = {}) => ({ jobId: "j1", file: "Benchy.gcode", sent: 10 * 1048576, total: 40 * 1048576, cancellable: true, ...o });

test("another tab's upload appears (one rebuild), then its progress is painted, not rebuilt", () => {
  const ups = new Map(), ended = new Map();
  assert.deepEqual(reconcile([row(2, UP())], ups, ended), { rebuild: ["2"], paint: [] });
  assert.equal(ups.get("2").origin, "fleet");
  assert.equal(ups.get("2").pct, 25);
  assert.deepEqual(reconcile([row(2, UP({ sent: 20 * 1048576 }))], ups, ended), { rebuild: [], paint: ["2"] });
  assert.equal(ups.get("2").pct, 50);
});

test("an upload this tab started is never overridden by the fleet data", () => {
  const ups = new Map([["2", { state: "uploading", origin: "local", jobId: "j1", name: "Benchy.gcode", pct: 70, sent: 7, total: 10 }]]), ended = new Map();
  assert.deepEqual(reconcile([row(2, UP({ sent: 1, total: 10 }))], ups, ended), { rebuild: [], paint: [] });
  assert.equal(ups.get("2").pct, 70, "its own 400 ms poll owns the progress");
  assert.deepEqual(reconcile([row(2)], ups, ended), { rebuild: [], paint: [] });
  assert.ok(ups.has("2"), "and its end (or its failed strip) is its own too");
  ups.get("2").state = "failed";
  reconcile([row(2, UP({ jobId: "j9" }))], ups, ended);
  assert.equal(ups.get("2").state, "failed", "a failed strip with Retry stays in the tab that started it");
});

test("a finished upload is not brought back by a late fleet answer, in the tab that started it or another", () => {
  const ups = new Map(), ended = new Map([["j1", 900]]);   // this tab's job just ended (pollJob)
  assert.deepEqual(reconcile([row(2, UP())], ups, ended), { rebuild: [], paint: [] });
  assert.ok(!ups.has("2"));
  // In another tab: the row stops reporting it — gone, and remembered as ended.
  const ups2 = new Map(), ended2 = new Map();
  reconcile([row(2, UP())], ups2, ended2);
  assert.deepEqual(reconcile([row(2)], ups2, ended2), { rebuild: ["2"], paint: [] });
  assert.ok(!ups2.has("2") && ended2.has("j1"));
  assert.deepEqual(reconcile([row(2, UP())], ups2, ended2), { rebuild: [], paint: [] }, "an older answer arriving late changes nothing");
  // Ended jobs are forgotten after a while.
  reconcile([], ups2, ended2, 1000 + 16 * 60 * 1000);
  assert.ok(!ended2.has("j1"));
});

test("progress never goes backwards; becoming cancellable rebuilds (the button changes); a printer that left the answer loses its strip", () => {
  const ups = new Map(), ended = new Map();
  reconcile([row(2, UP({ sent: 30, total: 100, cancellable: false }))], ups, ended);
  assert.deepEqual(reconcile([row(2, UP({ sent: 20, total: 100, cancellable: false }))], ups, ended), { rebuild: [], paint: [] });
  assert.equal(ups.get("2").sent, 30);
  assert.deepEqual(reconcile([row(2, UP({ sent: 40, total: 100, cancellable: true }))], ups, ended), { rebuild: ["2"], paint: [] });
  assert.deepEqual(reconcile([row(3)], ups, ended), { rebuild: ["2"], paint: [] });
  assert.ok(!ups.has("2"));
});

test("a page reloaded mid-upload picks it up from the fleet data, with Cancel upload on its job (cancelling from any tab)", () => {
  ctx.UPLOADS.clear(); ctx.ROLE_ACTS = true;
  reconcile([row(2, UP())], ctx.UPLOADS, new Map());
  const html = vm.runInContext("uploadStripHtml", ctx)({ id: 2, state: "standby" });
  assert.match(html, /fleet\.upload\.uploading\(file=Benchy\)/);
  assert.match(html, /data-live="upload-detail">fleet\.upload\.detail\(pct=25,sent=10,total=40\)</);
  assert.match(html, /<button type="button" class="upload-strip-btn danger" data-cancel-upload="j1" data-printer="2">/, "the job id the server's cancel needs, enabled");
  // The click goes through the same handler and route as the starting tab's.
  assert.match(appSrc, /const cancelBtn=e\.target\.closest\("button\[data-cancel-upload\]"\);/);
  assert.match(extract(appSrc, "cancelUpload"), /postJSON\("\/api\/print-cancel",\{job:jobId\}\)/);
});

test("View-only users see Cancel upload disabled, with the reason", () => {
  ctx.UPLOADS.clear(); ctx.ROLE_ACTS = false;
  reconcile([row(2, UP())], ctx.UPLOADS, new Map());
  const html = vm.runInContext("uploadStripHtml", ctx)({ id: 2, state: "standby" });
  assert.match(html, /data-cancel-upload="j1" data-printer="2" disabled title="fleet\.upload\.cancel_view_only_title"/);
  ctx.ROLE_ACTS = true;
});

test("Upload and Print are disabled in every tab while the printer's upload runs, and back once it ends", () => {
  ctx.UPLOADS.clear();
  const sendBtnAttrs = vm.runInContext("sendBtnAttrs", ctx), ended = new Map();
  reconcile([row(2, UP())], ctx.UPLOADS, ended);
  assert.equal(sendBtnAttrs({ id: 2 }, false, true, { card: true }), "disabled");
  reconcile([row(2)], ctx.UPLOADS, ended);
  assert.equal(sendBtnAttrs({ id: 2 }, false, true, { card: true }), "", "the printer's own state decides again");
});

test("wiring: folded in before the fleet render, painted after it, no new poll; this tab's ended jobs are remembered", () => {
  const load = extract(appSrc, "loadFleet");
  const fold = load.indexOf("const ups=reconcileFleetUploads(FLEET, UPLOADS, UPLOAD_ENDED, Date.now());");
  const render = load.indexOf("renderFleet({ incremental: true });"), paint = load.indexOf("for(const id of ups.paint) paintUploadProgress(id);");
  assert.ok(fold > 0 && fold < render && render < paint);
  assert.doesNotMatch(extract(appSrc, "paintUploadProgress"), /renderFleet/);
  const poll = extract(appSrc, "pollJob");
  assert.match(poll.slice(poll.lastIndexOf("} finally {")), /UPLOAD_ENDED\.set\(jobId, Date\.now\(\)\);/);
  assert.match(appSrc, /setUploadState\(printer, \{ state:"uploading", origin:"local", jobId:d\.jobId,/);
});

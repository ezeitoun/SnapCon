// test/deferredSends.test.js — sends waiting for a busy printer (docs/TODO.md
// §37 P3), through server.js's own code (test/helpers/deferredHarness.js).
//
// Before: one per printer in memory (pendingLoad), replaced silently by the
// next, lost on a restart, keyed by the printer's place in the list; the
// upload was not a job (no progress, no Cancel); nothing stopped two
// transfers to one printer overlapping; pushed bytes were deleted at startup.
const test = require("node:test");
const { routeEnd } = require("./helpers/routeEnd");
const assert = require("node:assert/strict");
const fs = require("fs");
const { deferredHarness, until, sha } = require("./helpers/deferredHarness");

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const restart = (t, h, extra = {}) => deferredHarness(t, { baseDir: h.base, storage: h.storage, ...extra });

// ---- accepted only once it is saved; order; duplicates ----

test("a send is saved before it is acknowledged: a restart right after finds it, in order", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const a = await h.sendLater("pA", "A.gcode", "a");
  const b = await h.sendLater("pA", "B.gcode", "b");
  const h2 = restart(t, h);
  assert.deepEqual(h2.store.list({ printerId: "pA" }).map(r => [r.name, r.state]), [["A.gcode", "queued"], ["B.gcode", "queued"]]);
  assert.ok(a.seq < b.seq);
  assert.equal(a.source.sha256, sha(Buffer.from("a")), "the content it was asked for, by hash");
});

test("pushed bytes are kept durably under the send's id before it is acknowledged, and survive a restart", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "Push.gcode", null, { buffer: Buffer.from("G1 X9\n") });
  assert.equal(fs.readFileSync(h.store.bytesPath(r.id), "utf8"), "G1 X9\n");
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.ok(fs.existsSync(h2.store.bytesPath(r.id)), "not deleted at startup, unlike the old .notify-tmp");
  await h2.pump();
  assert.equal(h2.uploads[0].bytes.toString(), "G1 X9\n");
  assert.equal(fs.existsSync(h2.store.bytesPath(r.id)), false, "removed once it reached the printer and checked out");
});

test("a disk that is full, or a file over the cap, refuses the push before anything is queued", async t => {
  const h = deferredHarness(t, { cfg: { deferredSends: { maxFileMB: 1 } } });
  await assert.rejects(h.sendLater("pA", "Big.gcode", null, { buffer: Buffer.alloc(1024 * 1024 + 1) }), e => e.status === 413);
  h.free = 10;
  await assert.rejects(h.sendLater("pA", "Small.gcode", null, { buffer: Buffer.alloc(10) }), e => e.status === 507);
  assert.equal(h.store.list().length, 0);
  assert.deepEqual(fs.readdirSync(h.store.paths.FILES).filter(n => n !== ".incoming"), []);
});

test("first in, first out per printer: one at a time, in order; another printer does not wait", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  await h.sendLater("pA", "A1.gcode", "1"); await h.sendLater("pA", "A2.gcode", "2"); await h.sendLater("pB", "B1.gcode", "3");
  const g = gate(); h.uploadGate = g.p;                     // hold the uploads open
  h.idle = true;
  await h.env.pumpDeferred();
  await until(() => h.uploads.length === 2, "the first two");
  assert.deepEqual(h.uploads.map(u => u.printer + ":" + u.name).sort(), ["pA:A1.gcode", "pB:B1.gcode"], "the oldest of each printer");
  await h.env.pumpDeferred();
  assert.equal(h.uploads.length, 2, "A2 does not start while A1 is going out");
  h.uploadGate = null; g.open();
  await until(() => h.jobs().every(j => j.done), "the first two to end");
  await h.pump();
  assert.deepEqual(h.uploads.filter(u => u.printer === "pA").map(u => u.name), ["A1.gcode", "A2.gcode"]);
});

test("a second open send of the same name to the same printer is refused, never replacing the first", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  await h.sendLater("pA", "A.gcode", "1");
  await assert.rejects(h.sendLater("pA", "A.gcode", "2"), e => e.status === 409 && e.code === "deferred_duplicate");
  assert.ok(await h.sendLater("pB", "A.gcode", "3"), "another printer may have one");
  assert.equal(h.store.list({ printerId: "pA" }).length, 1);
});

// ---- the per-printer transfer lock ----

test("the lock: no send starts while a start, a manual send or a queue dispatch is running on that printer", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  await h.sendLater("pA", "A.gcode", "1");
  h.idle = true;
  const r = h.store.list()[0];
  for (const busy of [() => h.env.STARTING.set("pA", true), () => h.env.JOBS.set("m", { printerId: "pA", done: false, file: "Manual.gcode" }), () => h.env.JOBS.set("q", { printerId: "pA", done: false, queueItemId: "qi" })]) {
    busy();
    await h.env.pumpDeferred();
    // Checked on the record, not the upload count: an upload starts only after
    // the source is hashed, so a count read now would pass a broken lock.
    assert.equal(h.state(r.id), "queued", "not claimed");
    assert.equal(h.jobs().filter(j => j.deferredId).length, 0, "no send job");
    h.env.STARTING.clear(); h.env.JOBS.clear();
  }
  await h.pump();
  assert.equal(h.uploads.length, 1);
});

test("the lock is held through the upload and its read-back: the printer reads busy until the check is done", async t => {
  const h = deferredHarness(t);
  await h.sendLater("pA", "A.gcode", "1");
  const g = gate();
  h.verify = async () => { await g.p; return { result: "verified", basis: "content", evidence: "x" }; };
  const run = h.env.pumpDeferred();
  await until(() => h.verifyCalls === 1, "the read-back");
  assert.equal(h.env.transferBusy(h.p("pA")), true);
  g.open(); await run; await until(() => h.jobs().every(j => j.done), "done");
  assert.equal(h.env.transferBusy(h.p("pA")), false);
});

test("two passes of the sender at once start one upload, not two", async t => {
  const h = deferredHarness(t);
  await h.sendLater("pA", "A.gcode", "1");
  await Promise.all([h.env.pumpDeferred(), h.env.pumpDeferred(), h.env.pumpDeferred()]);
  await until(() => h.jobs().every(j => j.done), "done");
  assert.equal(h.uploads.length, 1);
});

test("the queue waits for a printer's queued sends, but not for one that needs attention", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  assert.equal(h.env.deferredWaiting("pA"), true);
  h.store.transition(r.id, ["queued"], { state: "attention", reason: "x" });
  assert.equal(h.env.deferredWaiting("pA"), false);
});

// ---- source identity ----

test("a source changed or gone after the send was asked for fails it; nothing is sent", async t => {
  for (const change of [f => fs.writeFileSync(f, "different"), f => fs.rmSync(f)]) {
    const h = deferredHarness(t);
    h.idle = false;
    const r = await h.sendLater("pA", "A.gcode", "original");
    change(r.source.path);
    h.idle = true;
    await h.pump();
    assert.equal(h.state(r.id), "failed");
    assert.match(h.store.get(r.id).code, /DEFERRED_SOURCE_(CHANGED|MISSING)/);
    assert.equal(h.uploads.length, 0);
  }
});

test("same size and time but other content is still caught: the check is by hash", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "aaaa");
  const st = fs.statSync(r.source.path);
  fs.writeFileSync(r.source.path, "bbbb");
  fs.utimesSync(r.source.path, st.atime, st.mtime);
  h.idle = true;
  await h.pump();
  assert.equal(h.store.get(r.id).code, "DEFERRED_SOURCE_CHANGED");
  assert.equal(h.uploads.length, 0);
});

// ---- outcomes, and never a print ----

test("a send that reached the printer and checked out becomes the Loaded file, with its check; nothing is started", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  assert.equal(h.state(r.id), undefined, "finished and removed");
  assert.deepEqual([h.env.queuedFile.get("pA").name, h.env.queuedFile.get("pA").verification], ["A.gcode", "verified"]);
  assert.equal(h.started, undefined, "never a print start");
  assert.ok(h.audits.some(a => a.event === "file-uploaded" && a.detail.deferred));
});

test("a transfer with no answer is Unknown and needs attention; a failed one is Failed; neither is sent again by itself", async t => {
  for (const [err, state] of [[Object.assign(new Error("no answer"), { code: "UPLOAD_UNCONFIRMED", outcome: "unknown", reason: "timeout" }), "attention"], [Object.assign(new Error("reset"), { code: "ECONNRESET", outcome: "failed" }), "failed"]]) {
    const h = deferredHarness(t);
    const r = await h.sendLater("pA", "A.gcode", "1");
    h.uploadFail = err;
    await h.pump();
    assert.equal(h.state(r.id), state);
    await h.pump();
    assert.equal(h.uploads.length, 1, "not retried");
  }
});

// ---- Cancel ----

test("Cancel of a queued send: cancelled, never sent, its bytes go; a second Cancel changes nothing", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "P.gcode", null, { buffer: Buffer.from("x") });
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 200);
  assert.equal(h.state(r.id), "cancelled");
  assert.equal(fs.existsSync(h.store.bytesPath(r.id)), false);
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 409);
  h.idle = true; await h.pump();
  assert.equal(h.uploads.length, 0);
  assert.equal((await h.call("POST", "/api/deferred/:id/dismiss", { id: r.id })).code, 200);
  assert.equal(h.store.get(r.id), null);
});

test("Cancel and the sender's claim cannot both win: either nothing is sent, or the running upload is cut", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  const g = gate(); h.uploadGate = g.p;                     // the upload is held open
  h.env.pumpDeferred();
  await until(() => h.uploads.length === 1, "the upload");
  assert.equal(h.state(r.id), "uploading");
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 200, "cuts the running upload");
  g.open();
  await until(() => h.jobs().every(j => j.done), "the end");
  assert.equal(h.state(r.id), "cancelled");
  assert.equal(h.env.queuedFile.get("pA"), undefined);
});

// ---- a restart in the middle (owner safeguards 1, 2, 6, 7, 8) ----

async function interruptedAt(t, setup) {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "the whole file");
  h.store.transition(r.id, ["queued"], { state: "uploading", attempt: { id: "att", startedAt: 1 } });   // SnapCon stopped here
  if (setup) setup(h, r);
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  return { h: h2, r };
}

test("an attempt still 'uploading' at startup is interrupted: reconciled by reading the printer, never resent", async t => {
  const { h, r } = await interruptedAt(t);
  assert.equal(h.state(r.id), "interrupted");
  await h.pump();
  assert.equal(h.uploads.length, 0, "the sender does not touch it");
});

test("interrupted, and the printer holds the whole file: completed, Loaded, without another upload", async t => {
  const { h, r } = await interruptedAt(t, (h0, r0) => h0.storage.set("pA/A.gcode", Buffer.from("the whole file")));
  await h.env.reconcileDeferred();
  assert.equal(h.state(r.id), undefined);
  assert.equal(h.env.queuedFile.get("pA").name, "A.gcode");
  assert.equal(h.uploads.length, 0);
});

test("interrupted, and the printer has nothing, part of it, or only its name: needs a person (decision D, decision 1); nothing sent, overwritten or deleted", async t => {
  const cases = [
    [null, "interrupted-not-on-printer"],
    [Buffer.from("the whole"), "interrupted-different-on-printer"],
    ["name-only", "interrupted-listed-by-name"],
  ];
  for (const [held, reason] of cases) {
    const { h, r } = await interruptedAt(t, (h0) => { if (Buffer.isBuffer(held)) h0.storage.set("pA/A.gcode", held); });
    if (held === "name-only") h.verify = { result: "acknowledged", basis: "name", evidence: "x" };
    await h.env.reconcileDeferred();
    assert.equal(h.state(r.id), "attention", reason);
    assert.equal(h.store.get(r.id).reason, reason);
    assert.equal(h.uploads.length, 0);
    if (Buffer.isBuffer(held)) assert.equal(h.storage.get("pA/A.gcode").toString(), held.toString(), "the printer's copy left as it is");
  }
});

test("interrupted, and the printer cannot be asked or is offline: left interrupted, never dropped", async t => {
  const { h, r } = await interruptedAt(t);
  h.online = false;
  await h.env.reconcileDeferred();
  assert.equal(h.verifyCalls, 0);
  h.online = true;
  h.verify = { result: "unverifiable", evidence: "no list" };
  await h.env.reconcileDeferred();
  assert.equal(h.state(r.id), "interrupted");
});

test("reconciliation is repeatable: a second startup, or a second pass, changes nothing twice", async t => {
  const { h, r } = await interruptedAt(t);
  h.env.deferredStartup();
  assert.equal(h.state(r.id), "interrupted");
  await h.env.reconcileDeferred();
  const once = JSON.stringify(h.store.get(r.id));
  h.env.deferredCheckedAt.clear();
  await h.env.reconcileDeferred();
  assert.equal(JSON.stringify({ ...h.store.get(r.id), updatedAt: 0 }), JSON.stringify({ ...JSON.parse(once), updatedAt: 0 }));
});

test("a Cancel while a reconciliation reads the printer wins: the read's answer is discarded", async t => {
  const { h, r } = await interruptedAt(t, (h0) => h0.storage.set("pA/A.gcode", Buffer.from("the whole file")));
  const g = gate();
  h.verify = async () => { await g.p; return { result: "verified", basis: "content", evidence: "x" }; };
  const pass = h.env.reconcileDeferred();
  await until(() => h.verifyCalls === 1, "the read");
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 200);
  g.open(); await pass;
  assert.equal(h.state(r.id), "cancelled");
  assert.equal(h.env.queuedFile.get("pA"), undefined, "not made Loaded after the cancel");
});

test("completed but the Loaded entry not yet written when SnapCon stopped: finished at startup, no upload, nothing lost", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.store.transition(r.id, ["queued"], { state: "uploading", attempt: { id: "a", startedAt: 1 } });
  h.store.transition(r.id, ["uploading"], { state: "completed", completion: { verification: "verified", verifiedAt: 5, size: 1 } });
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(r.id), undefined);
  assert.deepEqual([h2.env.queuedFile.get("pA").name, h2.env.queuedFile.get("pA").verification], ["A.gcode", "verified"]);
  assert.equal(h2.uploads.length, 0);
  h2.env.deferredStartup();
  assert.equal(h2.uploads.length, 0, "a second startup changes nothing");
});

test("a stale backup brings nothing back as something to send (owner safeguard 3)", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.sendLater("pA", "B.gcode", "2");                 // the backup holds the state with A queued
  fs.writeFileSync(h.store.paths.PRIMARY, "{ corrupt");
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(r.id), "attention");
  assert.equal(h2.store.get(r.id).reason, "restored-from-backup");
  h2.idle = true;
  await h2.pump();
  assert.equal(h2.uploads.length, 0);
  assert.ok(h2.audits.some(a => a.event === "deferred-sends-restored"));
});

test("stored bytes are kept while a send's outcome is unresolved", async t => {
  const h3 = deferredHarness(t);
  h3.idle = false;
  const p = await h3.sendLater("pA", "P.gcode", null, { buffer: Buffer.from("bytes") });
  h3.store.transition(p.id, ["queued"], { state: "uploading", attempt: { id: "a", startedAt: 1 } });
  const h4 = restart(t, h3);
  h4.env.deferredStartup();
  await h4.env.reconcileDeferred();                        // absent → needs attention
  assert.equal(h4.state(p.id), "attention");
  assert.ok(fs.existsSync(h4.store.bytesPath(p.id)), "kept: the person may send it again");
});

// ---- the person's actions ----

test("Send again is the only way back: it authorises one more transfer, in its place in line; a second click changes nothing", async t => {
  const { h, r } = await interruptedAt(t);
  await h.env.reconcileDeferred();
  assert.equal(h.state(r.id), "attention");
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).code, 200);
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).code, 409);
  await h.pump();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.env.queuedFile.get("pA").name, "A.gcode");
});

test("Check again reads the printer once, at most once a minute, and completes a send the printer turns out to hold", async t => {
  const { h, r } = await interruptedAt(t);
  await h.env.reconcileDeferred();
  h.storage.set("pA/A.gcode", Buffer.from("the whole file"));   // it was there after all (a lagging list)
  h.env.deferredCheckedAt.clear();
  const c = await h.call("POST", "/api/deferred/:id/check", { id: r.id });
  assert.equal(c.body.state, "completed");
  assert.equal(h.uploads.length, 0);
});

test("a removed printer's sends are kept, not sent elsewhere, only an admin may cancel them, and they go on if the same printer id returns", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  const removed = h.printers.splice(0, 1)[0];
  h.idle = true;
  await h.pump();
  assert.equal(h.uploads.length, 0, "not redirected");
  assert.equal(h.state(r.id), "queued", "kept");
  const orphans = await h.call("GET", "/api/deferred/orphans");
  assert.deepEqual(orphans.body.sends.map(x => [x.name, x.printerId, x.printerName]), [["A.gcode", "pA", "U1 A"]]);
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id }, {}, { id: "u2", role: "regular" })).code, 403);
  h.printers.push(removed);                                // restored with the same id
  await h.pump();
  assert.deepEqual(h.uploads.map(u => u.printer), ["pA"]);
});

test("the actions keep to the printer's visibility", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  const hidden = { id: "u2", role: "regular", hidden: ["pA"] };
  for (const a of ["cancel", "dismiss", "send-again", "check"]) assert.equal((await h.call("POST", `/api/deferred/:id/${a}`, { id: r.id }, {}, hidden)).code, 403, a);
  assert.equal(h.state(r.id), "queued");
});

test("a store that could not save stops new sends until it can again", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  await h.sendLater("pA", "A.gcode", "1");
  const r = h.store.list()[0];
  h.store.status = () => ({ degraded: true });
  h.store.retrySave = () => ({ ok: false });
  h.idle = true;
  await h.env.pumpDeferred();
  await new Promise(x => setTimeout(x, 30));
  assert.equal(h.state(r.id), "queued", "not claimed");
  assert.equal(h.uploads.length, 0);
});

test("no path in the deferred-send code starts a print", () => {
  const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  const a = src.indexOf("// ---- Sends waiting for a busy printer (§37 P3) ----");
  const b = src.indexOf("const normPrinterName");
  const section = src.slice(a, src.indexOf("setInterval(() => {\n  pumpDeferred()", a)) + src.slice(src.indexOf("// ---- A person's actions on a deferred send (§37 P3) ----"), b);
  assert.doesNotMatch(section, /startPrintFile|runPrintFileJob|withStartSequence/);
});

// ---- the slicer/CLI hook (/api/notify-load) ----
function withNotifyRoute(h) {
  const vm = require("node:vm");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  Object.assign(h.env, {
    rawGcodeBody: (req, res, next) => next(), isLoopback: () => true, NOTIFY_TOKEN: "tok", timingSafeTokenEqual: (a, b) => a === b,
    fileTypeRefusal: () => null, getCapabilities: () => ({}),
    refuseOversizePush: (req, res, next) => next(),   // tested on its own below
  });
  vm.runInContext(src.slice(src.indexOf("const normPrinterName"), src.indexOf("\n}\n", src.indexOf("function findPrinterIndex(")) + 3), h.env);
  const at = src.indexOf('app.post("/api/notify-load"');
  vm.runInContext(src.slice(at, routeEnd(src, at, true) + 5), h.env);
}

test("a slicer push waits durably and answers as before (mode), now with its transferId", async t => {
  const h = deferredHarness(t);
  withNotifyRoute(h);
  h.idle = false;
  const busy = await h.call("POST", "/api/notify-load", {}, Buffer.from("G1 X1\n"), { id: "u1", role: "regular" }, { query: { printer: "U1 A", filename: "Part.gcode" } });
  assert.equal(busy.code, 200, JSON.stringify(busy.body));
  assert.deepEqual([busy.body.ok, busy.body.mode, busy.body.printer], [true, "pending", "U1 A"], "the reply P4 relies on is unchanged");
  const rec = h.store.get(busy.body.transferId);
  assert.equal(rec.state, "queued");
  assert.equal(fs.readFileSync(h.store.bytesPath(rec.id), "utf8"), "G1 X1\n", "kept before the answer");
  const dup = await h.call("POST", "/api/notify-load", {}, Buffer.from("G1 X2\n"), { id: "u1", role: "regular" }, { query: { printer: "U1 A", filename: "Part.gcode" } });
  assert.equal(dup.code, 409, "a second push of that name is refused, not replacing the first");
  h.free = 0;
  const full = await h.call("POST", "/api/notify-load", {}, Buffer.from("x"), { id: "u1", role: "regular" }, { query: { printer: "U1 B", filename: "Other.gcode" } });
  assert.equal(full.code, 507, "a full disk refuses before answering ok");
  assert.equal(h.store.list({ printerId: "pB" }).length, 0);
});

test("a same-machine CLI call waits durably with the file's hash; idle, it says it goes now", async t => {
  const h = deferredHarness(t);
  withNotifyRoute(h);
  const f = h.file("Cli.gcode", "G1 Y1\n");
  const r = await h.call("POST", "/api/notify-load", {}, { file: f, printer: "U1 B" }, null, { headers: { "x-snapcon-local-token": "tok" } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, "queued");
  await until(() => h.jobs().length && h.jobs().every(j => j.done), "the send");
  assert.deepEqual(h.uploads.map(u => [u.printer, u.name]), [["pB", "Cli.gcode"]]);
});

// ---- from the P3 reviews (2026-10-28) ----
test("an ending the disk would not save is kept and saved on the next pass: the file becomes Loaded then, and is not sent again", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  const realTransition = h.store.transition;
  let refuse = true;
  h.store.transition = (id, from, patch) => (refuse && patch.state === "completed") ? { ok: false, reason: "persist" } : realTransition(id, from, patch);
  await h.pump();
  assert.equal(h.state(r.id), "uploading", "not saved yet");
  assert.equal(h.env.queuedFile.get("pA"), undefined);
  refuse = false;
  await h.env.pumpDeferred();
  assert.equal(h.state(r.id), undefined, "saved, finished and removed");
  assert.equal(h.env.queuedFile.get("pA").name, "A.gcode");
  assert.equal(h.uploads.length, 1, "never sent twice");
});

test("a completion finished at startup does not replace a Loaded file staged after it", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "Old.gcode", "1");
  h.store.transition(r.id, ["queued"], { state: "uploading", attempt: { id: "a", startedAt: 1 } });
  h.store.transition(r.id, ["uploading"], { state: "completed", completion: { verification: "verified", verifiedAt: 1, size: 1, at: 1000 } });
  const h2 = restart(t, h);
  h2.env.queuedFile.set("pA", { name: "Newer.gcode", status: "ready", ts: Date.now(), size: 5, sizeOf: "file" });
  h2.env.deferredStartup();
  assert.equal(h2.env.queuedFile.get("pA").name, "Newer.gcode");
  assert.equal(h2.state(r.id), undefined, "the record is finished all the same");
});

test("Cancel works until the first byte goes, including while the printer's running job is checked", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  const g = gate();
  h.env.assertNotActiveJobFile = async () => { await g.p; };
  h.env.pumpDeferred();
  await until(() => h.state(r.id) === "uploading", "the claim");
  await new Promise(x => setTimeout(x, 10));
  const c = await h.call("POST", "/api/deferred/:id/cancel", { id: r.id });
  assert.equal(c.code, 200, JSON.stringify(c.body));
  g.open();
  await until(() => h.jobs().every(j => j.done), "the end");
  assert.equal(h.state(r.id), "cancelled");
  assert.equal(h.uploads.length, 0, "nothing sent");
});

test("Send again is refused for a send whose source changed: a new version is a new send", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "v1");
  fs.writeFileSync(r.source.path, "v2");
  h.idle = true;
  await h.pump();
  assert.equal(h.store.get(r.id).code, "DEFERRED_SOURCE_CHANGED");
  const again = await h.call("POST", "/api/deferred/:id/send-again", { id: r.id });
  assert.equal(again.code, 409);
  assert.match(again.body.error, /Send the file again from SnapCon/);
});

test("an oversized push is refused from its declared size, before its body is read", () => {
  const vm = require("node:vm");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  const at = src.indexOf("function refuseOversizePush(");
  const ctx = { CFG: { deferredSends: { maxFileMB: 1 } }, Number, Math, DEFERRED_LIMITS: { maxFileBytes: 512 * 1048576 } };
  vm.createContext(ctx);
  vm.runInContext(src.slice(src.indexOf("const DEFERRED_LIMIT_KEYS"), src.indexOf("\n", src.indexOf("const DEFERRED_LIMIT_KEYS"))) + "\n" +
    src.slice(src.indexOf("function deferredLimitsFromConfig("), src.indexOf("\n}\n", src.indexOf("function deferredLimitsFromConfig(")) + 3) +
    "function warnOnce(){}\n" + src.slice(at, src.indexOf("\n}\n", at) + 3), ctx);
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  ctx.refuseOversizePush({ headers: { "content-length": String(2 * 1048576) }, is: () => true }, res, () => { passed = true; });
  assert.equal(res.code, 413); assert.equal(passed, false);
  ctx.refuseOversizePush({ headers: { "content-length": "100" }, is: () => true }, res, () => { passed = true; });
  assert.equal(passed, true);
  assert.match(src, /app\.post\("\/api\/notify-load", refuseOversizePush, rawGcodeBody,/);
});

test("a send starting and an attempt found interrupted are audited", async t => {
  const h = deferredHarness(t);
  await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  assert.ok(h.audits.some(a => a.event === "deferred-send-started"));
  const { h: h2 } = await interruptedAt(t);
  assert.ok(h2.audits.some(a => a.event === "deferred-send-interrupted"));
});

// ---- from the P3 test review (2026-10-28) ----
test("the source is re-hashed, not taken from a cache keyed on size and time", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  // A whole-millisecond time, so putting it back after the rewrite gives the
  // exact same size and mtime a cache would key on.
  const f = h.file("A.gcode", "aaaa");
  const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  fs.utimesSync(f, when, when);
  const r = await h.env.acceptDeferredSend(h.p("pA"), { name: "A.gcode", kind: "folder", file: f, actor: null });
  fs.writeFileSync(f, "bbbb"); fs.utimesSync(f, when, when);
  assert.equal(fs.statSync(f).mtimeMs, h.hashCache.get(f).mtimeMs, "same size and time as when it was hashed");
  assert.ok(h.hashCache.has(r.source.path), "a cached hash exists for the old content");
  h.idle = true;
  await h.pump();
  assert.equal(h.store.get(r.id).code, "DEFERRED_SOURCE_CHANGED");
});

test("a send whose record cannot be saved is not acknowledged: the error reaches the caller and the stored bytes go", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  h.store.add = () => { throw Object.assign(new Error("The send could not be saved: disk"), { code: "DEFERRED_SAVE_FAILED", status: 503 }); };
  await assert.rejects(h.sendLater("pA", "P.gcode", null, { buffer: Buffer.from("x") }), e => e.status === 503);
  assert.deepEqual(fs.readdirSync(h.store.paths.FILES).filter(n => n !== ".incoming"), [], "no file kept for a send that does not exist");
  const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  // /api/print's defer path answers only after acceptDeferredSend resolved; a failure is the response.
  assert.match(src, /try \{ rec = await acceptDeferredSend\(p, \{[^\n]*\}\); \}\n\s+catch \(e\) \{ return res\.status\(e\.status \|\| 500\)\.json\(\{ error: e\.message[^\n]*\n\s+return res\.json\(\{ ok: true, mode: "pending", printer: p\.name, transferId: tidOf\(rec\) \}\);/);
});

test("Send again only from attention or failed, never past another open send of that name or missing bytes", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const a = await h.sendLater("pA", "A.gcode", "1");
  h.store.transition(a.id, ["queued"], { state: "interrupted" });
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: a.id })).code, 409, "interrupted: reconciled first");
  h.store.transition(a.id, ["interrupted"], { state: "cancelled" });
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: a.id })).code, 409, "cancelled");
  h.store.transition(a.id, ["cancelled"], { state: "failed", error: "x" });
  const b = await h.sendLater("pA", "A.gcode", "2");          // a new open send of the same name
  assert.equal(h.state(b.id), "queued");
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: a.id })).code, 409, "would duplicate an open send");
  const p = await h.sendLater("pB", "P.gcode", null, { buffer: Buffer.from("x") });
  h.store.transition(p.id, ["queued"], { state: "failed", error: "x" });
  fs.rmSync(h.store.bytesPath(p.id));
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: p.id })).code, 409, "its stored bytes are gone");
});

test("a send that takes the printer while the sender waits on the idle probe leaves the deferred send queued", async t => {
  const h2 = deferredHarness(t);
  h2.idle = false;
  const r2 = await h2.sendLater("pA", "A.gcode", "1");
  h2.env.isPrinterIdle = async () => { h2.env.JOBS.set("m", { printerId: "pA", done: false, file: "Manual.gcode" }); return true; };
  await h2.env.pumpDeferred();
  assert.equal(h2.state(r2.id), "queued");
  assert.equal(h2.jobs().filter(j => j.deferredId).length, 0);
});

test("a Cancel while the sender waits on the idle probe wins: nothing is claimed or sent", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  const g = gate();
  h.env.isPrinterIdle = async () => { await g.p; return true; };
  const pass = h.env.pumpDeferred();
  await new Promise(x => setTimeout(x, 5));
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 200);
  g.open(); await pass;
  assert.equal(h.state(r.id), "cancelled");
  assert.equal(h.jobs().filter(j => j.deferredId).length, 0);
  assert.equal(h.uploads.length, 0);
});

test("a pushed file's bytes survive an unknown or failed upload, so Send again can send them", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "P.gcode", null, { buffer: Buffer.from("push") });
  h.uploadFail = Object.assign(new Error("reset"), { code: "ECONNRESET", outcome: "failed" });
  await h.pump();
  assert.equal(h.state(r.id), "failed");
  assert.ok(fs.existsSync(h.store.bytesPath(r.id)));
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).code, 200);
  await h.pump();
  assert.equal(h.uploads.length, 2);
  assert.equal(h.uploads[1].bytes.toString(), "push");
});

test("a Cancel that cannot be saved changes nothing: 503, and the stored bytes are kept", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "P.gcode", null, { buffer: Buffer.from("x") });
  const real = h.store.transition;
  h.store.transition = (id, from, patch) => patch.state === "cancelled" ? { ok: false, reason: "persist" } : real(id, from, patch);
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 503);
  assert.equal(h.state(r.id), "queued");
  assert.ok(fs.existsSync(h.store.bytesPath(r.id)));
});

test("the folder a send's file is in is down: it waits, it is not sent, and it is not failed", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.idle = true;
  h.env.netfs.availability = () => ({ status: "offline" });
  await h.env.pumpDeferred();
  assert.equal(h.state(r.id), "queued", "not claimed while the folder is known to be down");
  // Down without the breaker knowing yet: the hash fails as unreachable.
  h.env.netfs.availability = () => ({ status: "online" });
  const realHash = h.env.queueStore.computeFileHash;
  h.env.queueStore.computeFileHash = async () => { throw Object.assign(new Error("share down"), { code: "NAS_UNREACHABLE" }); };
  await h.pump();
  assert.equal(h.state(r.id), "queued", "back in line, not failed");
  assert.equal(h.uploads.length, 0);
  h.env.queueStore.computeFileHash = realHash;
  h.store.transition(r.id, ["queued"], { notBefore: Date.now() - 1 });   // its retry time has come
  await h.pump();
  assert.equal(h.uploads.length, 1, "sent once the folder answers");
});

test("Check again: at most once a minute, and not while the printer is receiving a file", async t => {
  const { h, r } = await interruptedAt(t);
  h.env.deferredCheckedAt.clear();
  assert.equal((await h.call("POST", "/api/deferred/:id/check", { id: r.id })).code, 200);
  assert.equal((await h.call("POST", "/api/deferred/:id/check", { id: r.id })).code, 429);
  h.env.deferredCheckedAt.clear();
  h.env.JOBS.set("m", { printerId: "pA", done: false, file: "Manual.gcode" });
  assert.equal((await h.call("POST", "/api/deferred/:id/check", { id: r.id })).code, 409);
});

test("the action routes need a Regular user; the removed-printer list and the recovery acknowledgement need an admin", () => {
  const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  for (const a of ["cancel", "dismiss", "send-again", "check"]) assert.match(src, new RegExp(`app\\.post\\("/api/deferred/:id/${a}", requireRegular,`), a);
  assert.match(src, /app\.get\("\/api\/deferred\/orphans", requireAdmin,/);
  assert.match(src, /app\.post\("\/api\/deferred\/acknowledge-recovery", requireAdmin,/);
});

// ---- owner safeguards, 2026-10-28 (final review) ----
test("a source folder that does not answer is not retried in a tight loop: once, then after its retry time", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.idle = true;
  let tries = 0;
  h.env.queueStore.computeFileHash = async () => { tries++; throw Object.assign(new Error("share down"), { code: "NAS_UNREACHABLE" }); };
  await h.pump();
  for (let i = 0; i < 5; i++) await h.pump();
  assert.equal(tries, 1, "asked once, not every pass");
  assert.equal(h.store.get(r.id).waitingFor, "source");
  assert.ok(h.store.get(r.id).notBefore > Date.now());
  assert.ok(h.audits.some(a => a.event === "deferred-send-source-unreachable"));
  h.store.transition(r.id, ["queued"], { notBefore: Date.now() - 1 });
  await h.pump();
  assert.equal(tries, 2, "asked again once its time has come");
  assert.equal(h.state(r.id), "queued", "still waiting, never failed");
});

test("a send waiting for its folder does not hold up the next send to that printer, nor its print queue", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const a = await h.sendLater("pA", "A.gcode", "1");
  await h.sendLater("pA", "B.gcode", "2");
  h.store.transition(a.id, ["queued"], { waitingFor: "source", notBefore: Date.now() + 60000 });
  assert.equal(h.env.deferredWaiting("pA"), true, "B can go: the queue waits for it");
  h.idle = true;
  await h.pump();
  assert.deepEqual(h.uploads.map(u => u.name), ["B.gcode"]);
  assert.equal(h.state(a.id), "queued", "A still waits");
  assert.equal(h.env.deferredWaiting("pA"), false, "only A, which cannot go now, is left: the queue is not held");
});

test("a folder that comes back with other content: the send fails as changed, never sent with the new content", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "original");
  h.idle = true;
  const realHash = h.env.queueStore.computeFileHash;
  h.env.queueStore.computeFileHash = async () => { throw Object.assign(new Error("share down"), { code: "NAS_UNREACHABLE" }); };
  await h.pump();
  fs.writeFileSync(r.source.path, "edited meanwhile");
  h.env.queueStore.computeFileHash = realHash;
  h.store.transition(r.id, ["queued"], { notBefore: Date.now() - 1 });
  await h.pump();
  assert.equal(h.state(r.id), "failed");
  assert.equal(h.store.get(r.id).code, "DEFERRED_SOURCE_CHANGED", "told apart from the folder being down");
  assert.equal(h.uploads.length, 0);
});

test("acknowledging a recovery hold reactivates nothing and deletes nothing; files set aside go only by the admin's explicit, audited delete", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.sendLater("pB", "B.gcode", "2");                  // the backup now holds A
  await h.store.storeBytes("dsend_lost", Buffer.from("bytes of a send the list lost"));
  fs.writeFileSync(h.store.paths.PRIMARY, "{ corrupt");
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(r.id), "attention");
  const ack = await h2.call("POST", "/api/deferred/acknowledge-recovery", {}, {}, { id: "admin", role: "admin" });
  assert.equal(ack.code, 200);
  assert.equal(h2.state(r.id), "attention", "not reactivated");
  assert.ok(fs.existsSync(h2.store.bytesPath("dsend_lost")), "not deleted by the acknowledgement");
  const h3 = restart(t, h2);
  h3.env.deferredStartup();
  assert.ok(fs.existsSync(require("path").join(h3.store.paths.ORPHANED, "dsend_lost")), "set aside at the next start, not deleted");
  assert.ok(h3.audits.some(a => a.event === "deferred-files-set-aside" && a.detail.files.includes("dsend_lost")));
  const list = await h3.call("GET", "/api/deferred/orphans", {}, {}, { id: "admin", role: "admin" });
  assert.equal(list.body.orphanedFiles.count, 1);
  const del = await h3.call("POST", "/api/deferred/orphaned-files/delete", {}, {}, { id: "admin", role: "admin" });
  assert.equal(del.body.deleted, 1);
  assert.ok(h3.audits.some(a => a.event === "deferred-files-deleted" && a.detail.files.includes("dsend_lost")));
  assert.equal(h3.store.listOrphaned().length, 0);
});

test("the explicit delete of set-aside files is an admin's action", () => {
  const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /app\.post\("\/api\/deferred\/orphaned-files\/delete", requireAdmin,/);
  assert.doesNotMatch(src.slice(src.indexOf("function deferredStartup("), src.indexOf("\n}\n", src.indexOf("function deferredStartup("))), /deleteOrphaned/, "never at startup");
});

// ---- §37 A4 (owner, 2026-10-29) ----
test("A4: a waiting send whose file is edited in place (same size) during its upload is Unknown, never Loaded", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const sent = Buffer.from("A".repeat(3000));
  const r = await h.sendLater("pA", "A.gcode", sent.toString());
  // A sampled read-back (start, middle, end), as the Moonraker connector does.
  h.verify = (p, name, localPath) => {
    const now = fs.readFileSync(localPath);
    return [0, 1450, 2900].every(at => now.subarray(at, at + 100).equals(sent.subarray(at, at + 100))) ? { result: "verified", basis: "content", evidence: "x" } : { result: "mismatch", basis: "content", evidence: "x" };
  };
  const g = gate(); h.uploadGate = g.p; h.idle = true;
  await h.env.pumpDeferred();
  await until(() => h.uploads.length === 1, "the upload");
  const fd = fs.openSync(r.source.path, "r+"); fs.writeSync(fd, Buffer.from("BBBB"), 0, 4, 1000); fs.closeSync(fd);
  g.open();
  await until(() => h.jobs().every(j => j.done), "done");
  assert.equal(h.state(r.id), "attention");
  assert.equal(h.store.get(r.id).errorReason, "local-changed");
  assert.equal(h.env.queuedFile.get("pA"), undefined, "not Loaded");
  assert.equal(h.results.get(r.id).state, "unknown");
});

test("A4: a waiting send whose file is being written while SnapCon hashes it is not sent", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1234");
  const real = h.env.queueStore.computeFileHash;
  h.env.queueStore.computeFileHash = async (p, o) => { const out = await real(p, o); const st = fs.statSync(p); fs.utimesSync(p, st.atime, new Date(st.mtimeMs + 5000)); return out; };
  h.idle = true;
  await h.pump();
  assert.equal(h.state(r.id), "failed");
  assert.equal(h.store.get(r.id).code, "DEFERRED_SOURCE_CHANGED");
  assert.equal(h.uploads.length, 0);
});

test("A4: an untouched waiting send still goes through and is Loaded", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "the file");
  await h.pump();
  assert.equal(h.state(r.id), undefined);
  assert.equal(h.env.queuedFile.get("pA").name, "A.gcode");
});

test("A4: reconciling an interrupted send against a file that changes during the read-back proves nothing: left as it was", async t => {
  const { h, r } = await interruptedAt(t, (h0, r0) => h0.storage.set("pA/A.gcode", Buffer.from("the whole file")));
  h.verify = (p, name, localPath) => {
    if (localPath) { const fd = fs.openSync(localPath, "r+"); fs.writeSync(fd, Buffer.from("T"), 0, 1, 0); fs.closeSync(fd); }
    return { result: "verified", basis: "content", evidence: "x" };
  };
  await h.env.reconcileDeferred();
  assert.equal(h.state(r.id), "interrupted", "not completed on a comparison with a moving file");
  assert.equal(h.env.queuedFile.get("pA"), undefined);
  assert.equal(h.uploads.length, 0);
});

// ---- A4 backend review B1: a changed file never completes by size ----
async function editedDuringSend(t) {
  const h = deferredHarness(t);
  const sent = Buffer.from("A".repeat(3000));
  const r = await h.sendLater("pA", "A.gcode", sent.toString());
  h.verify = (p, name, localPath, o = {}) => {
    const held = h.storage.get(p.id + "/" + name);
    if (!held) return { result: "absent", evidence: "x" };
    if (!localPath) return held.length === o.localSize ? { result: "acknowledged", basis: "size", evidence: "size" } : { result: "mismatch", basis: "size", evidence: "x" };
    const now = fs.readFileSync(localPath);
    return [0, 1450, 2900].every(at => now.subarray(at, at + 100).equals(held.subarray(at, at + 100))) ? { result: "verified", basis: "content", evidence: "x" } : { result: "mismatch", basis: "content", evidence: "x" };
  };
  const g = gate(); h.uploadGate = g.p;
  await h.env.pumpDeferred();
  await until(() => h.uploads.length === 1, "the upload");
  const fd = fs.openSync(r.source.path, "r+"); fs.writeSync(fd, Buffer.from("BBBB"), 0, 4, 1000); fs.closeSync(fd);
  g.open();
  await until(() => h.jobs().every(j => j.done), "done");
  assert.equal(h.store.get(r.id).errorReason, "local-changed");
  return { h, r };
}

test("A4: Check again on a send whose file changed during its send does not complete it by size", async t => {
  const { h, r } = await editedDuringSend(t);
  h.env.deferredCheckedAt.clear();
  const out = await h.call("POST", "/api/deferred/:id/check", { id: r.id });
  assert.notEqual(out.body.state, "completed");
  assert.equal(h.state(r.id), "attention");
  assert.equal(h.store.get(r.id).reason, "source-changed");
  assert.equal(h.env.queuedFile.get("pA"), undefined, "never Loaded");
  assert.equal(h.results.get(r.id).state, "unknown", "the result stays unknown");
});

test("A4: the same file gone afterwards still does not complete by size alone", async t => {
  const { h, r } = await editedDuringSend(t);
  fs.rmSync(r.source.path);
  h.env.deferredCheckedAt.clear();
  await h.call("POST", "/api/deferred/:id/check", { id: r.id });
  assert.equal(h.state(r.id), "attention");
  assert.equal(h.env.queuedFile.get("pA"), undefined);
});

test("A4: a restart's reconciliation of an interrupted send whose file changed meanwhile needs a person, never completes by size", async t => {
  const { h, r } = await interruptedAt(t, (h0, r0) => {
    h0.storage.set("pA/A.gcode", Buffer.from("the whole file"));
    fs.writeFileSync(r0.source.path, "the whole fiXe");            // same size, other content
  });
  await h.env.reconcileDeferred();
  assert.equal(h.state(r.id), "attention");
  assert.equal(h.store.get(r.id).reason, "source-changed");
  assert.equal(h.env.queuedFile.get("pA"), undefined);
  assert.equal(h.uploads.length, 0);
});

test("A4: a slicer's temporary file removed after an ordinary interrupted send is still reconciled by size, as in P3", async t => {
  const { h, r } = await interruptedAt(t, (h0, r0) => { h0.storage.set("pA/A.gcode", Buffer.from("the whole file")); fs.rmSync(r0.source.path); });
  await h.env.reconcileDeferred();
  assert.equal(h.state(r.id), undefined);
  assert.equal(h.env.queuedFile.get("pA").name, "A.gcode");
});

// From the A4 test review.
test("A4: reconciling, a source that cannot be re-checked after the read-back proves nothing: left as it was", async t => {
  const { h, r } = await interruptedAt(t, (h0, r0) => h0.storage.set("pA/A.gcode", Buffer.from("the whole file")));
  h.verify = (p, name, localPath) => { if (localPath) fs.rmSync(localPath); return { result: "verified", basis: "content", evidence: "x" }; };
  await h.env.reconcileDeferred();
  assert.equal(h.state(r.id), "interrupted");
  assert.equal(h.env.queuedFile.get("pA"), undefined);
});

// ---- replacing a file the printer already has (owner, 2026-10-29) ----
test("replacing off: a waiting send whose name the printer already has is not sent over it — it fails, nothing sent", async t => {
  const h = deferredHarness(t, { cfg: { overwriteDifferentFiles: false } });
  h.storage.set("pA/A.gcode", Buffer.from("the printer's own A"));
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  assert.equal(h.state(r.id), "failed");
  assert.equal(h.store.get(r.id).code, "PRINTER_HAS_FILE");
  assert.equal(h.uploads.length, 0);
  assert.equal(h.storage.get("pA/A.gcode").toString(), "the printer's own A", "the printer's file untouched");
  const b = await h.sendLater("pA", "B.gcode", "2");                  // a name the printer does not have
  await h.pump();
  assert.equal(h.state(b.id), undefined);
  assert.equal(h.uploads.length, 1);
});

test("replacing on (the default): a waiting send replaces the printer's file of that name, as every send does", async t => {
  const h = deferredHarness(t);
  h.storage.set("pA/A.gcode", Buffer.from("old"));
  const r = await h.sendLater("pA", "A.gcode", "new");
  await h.pump();
  assert.equal(h.state(r.id), undefined);
  assert.equal(h.storage.get("pA/A.gcode").toString(), "new");
});

// From the skip-removal test review.
test("replacing off, Cancel while the printer is asked whether it has the name: nothing is sent", async t => {
  const h = deferredHarness(t, { cfg: { overwriteDifferentFiles: false } });
  const r = await h.sendLater("pA", "A.gcode", "1");
  const g = gate();
  let asked = false;
  h.verify = async () => { asked = true; await g.p; return { result: "absent", evidence: "x" }; };
  h.env.pumpDeferred();
  await until(() => asked, "the guard's question");
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 200);
  g.open();
  await until(() => h.jobs().every(j => j.done), "the end");
  assert.equal(h.state(r.id), "cancelled");
  assert.equal(h.uploads.length, 0);
});

test("replacing off, and the printer cannot say whether it has the name: the waiting send waits and asks again, never sent or failed meanwhile", async t => {
  const h = deferredHarness(t, { cfg: { overwriteDifferentFiles: false } });
  h.verify = { result: "unverifiable", evidence: "the printer's file list could not be read" };
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  assert.equal(h.state(r.id), "queued");
  assert.equal(h.store.get(r.id).waitingFor, "printer");
  assert.ok(h.store.get(r.id).notBefore > Date.now(), "not asked again in a tight loop");
  assert.equal(h.uploads.length, 0);
  assert.ok(h.audits.some(a => a.event === "deferred-send-printer-unchecked"));
  h.verify = null;                                                   // the list answers: A is not there
  h.store.transition(r.id, ["queued"], { notBefore: Date.now() - 1 });
  await h.pump();
  assert.equal(h.state(r.id), undefined);
  assert.equal(h.uploads.length, 1);
});

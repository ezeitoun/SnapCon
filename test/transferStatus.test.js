// test/transferStatus.test.js — each transfer's outcome, kept and answered
// across restarts (docs/TODO.md §37 P4), through server.js's own code
// (test/helpers/deferredHarness.js) with a real TransferResults store.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { deferredHarness, until } = require("./helpers/deferredHarness");

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const restart = (t, h, extra = {}) => deferredHarness(t, { baseDir: h.base, storage: h.storage, ...extra });
const quiet = t => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; t.after(() => { console.log = l; console.error = e; }); };
// An fs on which writes of the results file fail while armed (a full disk).
function resultsDisk() {
  const d = { full: false };
  d.fsImpl = new Proxy(fs, { get(target, prop) {
    const v = target[prop];
    if (typeof v !== "function") return v;
    return (...a) => {
      if (d.full && ["openSync", "renameSync", "copyFileSync"].includes(prop) && String(a[0]).includes("transfer-results") && (prop !== "openSync" || a[1] === "w")) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return v.apply(target, a);
    };
  } });
  return d;
}
const status = (h, id, user, extra) => h.call("GET", "/api/transfers/:id", { id }, {}, user === undefined ? { id: "u1", role: "regular" } : user, extra);

// ---- what the endpoint answers ----

test("a delivered send's result is saved before its send goes, and answers with how it was checked", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  assert.equal(h.state(r.id), undefined, "the send is gone");
  const s = await status(h, r.id);
  assert.equal(s.code, 200);
  assert.deepEqual([s.body.state, s.body.final, s.body.basis, s.body.printer], ["verified", true, "content", "U1 A"]);
  assert.equal(r.transferId, r.id, "the first attempt's id is the send's own");
  // A size-only read-back is acknowledged, and says so.
  h.verify = () => ({ result: "acknowledged", basis: "size", evidence: "x" });
  const b = await h.sendLater("pA", "B.gcode", "2");
  await h.pump();
  assert.deepEqual([(await status(h, b.id)).body.state, (await status(h, b.id)).body.basis], ["acknowledged", "size"]);
});

test("under way: queued (and why it waits), uploading with its phase and progress, interrupted — none final", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "0123456789");
  assert.deepEqual([(await status(h, r.id)).body.state, (await status(h, r.id)).body.final], ["queued", false]);
  h.store.transition(r.id, ["queued"], { waitingFor: "source", notBefore: Date.now() + 60000 });
  assert.equal((await status(h, r.id)).body.waitingFor, "source");
  h.store.transition(r.id, ["queued"], { waitingFor: null, notBefore: null });
  const g = gate(); h.uploadGate = g.p; h.idle = true;
  await h.env.pumpDeferred();
  await until(() => h.uploads.length === 1, "the upload");
  const up = (await status(h, r.id)).body;
  assert.deepEqual([up.state, up.final, up.phase, up.total], ["uploading", false, "sending", 10]);
  g.open(); await until(() => h.jobs().every(j => j.done), "done");
  const i = deferredHarness(t);
  const r2 = await i.sendLater("pA", "B.gcode", "x");
  i.store.transition(r2.id, ["queued"], { state: "uploading" });
  const i2 = restart(t, i); i2.env.deferredStartup();
  assert.deepEqual([(await status(i2, r2.id)).body.state, (await status(i2, r2.id)).body.final], ["interrupted", false]);
});

test("failed, cancelled and unknown are final, with their code, outcome and reason", async t => {
  const h = deferredHarness(t);
  const f = await h.sendLater("pA", "F.gcode", "1");
  h.uploadFail = Object.assign(new Error("reset"), { code: "ECONNRESET", outcome: "failed" });
  await h.pump();
  assert.deepEqual([(await status(h, f.id)).body.state, (await status(h, f.id)).body.code], ["failed", "ECONNRESET"]);
  h.idle = false;
  const c = await h.sendLater("pB", "C.gcode", "1");
  await h.call("POST", "/api/deferred/:id/cancel", { id: c.id });
  assert.deepEqual([(await status(h, c.id)).body.state, (await status(h, c.id)).body.outcome], ["cancelled", "not-sent"]);
  h.idle = true;
  const u = await h.sendLater("pA", "U.gcode", "1");
  h.uploadFail = Object.assign(new Error("timeout after the last byte"), { code: "ETIMEDOUT", outcome: "unknown" });
  await h.pump();
  const us = (await status(h, u.id)).body;
  assert.deepEqual([us.state, us.final, us.reason], ["unknown", true, "unknown-after-upload"]);
});

// ---- who may ask ----

test("an id never reveals another user's printer: hidden, unknown and malformed ids get the same answer", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "Secret.gcode", "1");
  await h.pump();
  const hidden = await status(h, r.id, { id: "u2", role: "regular", hidden: ["pA"] });
  const none = await status(h, "dsend_doesnotexist", { id: "u2", role: "regular" });
  const bad = await status(h, "../../etc", { id: "u2", role: "regular" });
  assert.equal(hidden.code, 404);
  assert.deepEqual(hidden.body, none.body, "byte for byte the unknown answer");
  assert.deepEqual(bad.body, none.body);
  assert.doesNotMatch(JSON.stringify(hidden.body), /Secret|U1 A|pA/);
  assert.equal((await status(h, r.id, null)).code, 404, "not signed in");
});

test("the same-machine command line may ask with its local token, and only from this machine", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  const local = { headers: { "x-snapcon-local-token": "tok" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal((await status(h, r.id, null, local)).body.state, "verified");
  assert.equal((await status(h, r.id, null, { ...local, socket: { remoteAddress: "192.168.20.50" } })).code, 404, "the token over the network");
  assert.equal((await status(h, r.id, null, { ...local, headers: { "x-snapcon-local-token": "wrong" } })).code, 404);
});

test("a removed printer's transfer: admins only", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  h.env.PRINTERS.splice(0, 1);
  assert.equal((await status(h, r.id)).code, 404);
  assert.equal((await status(h, r.id, { id: "a", role: "admin" })).body.state, "verified");
});

test("the endpoint only reads: asking changes no send, result or file", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  const before = [fs.readFileSync(h.store.paths.PRIMARY, "utf8"), fs.existsSync(h.results.paths.PRIMARY)];
  for (let i = 0; i < 3; i++) await status(h, r.id);
  assert.deepEqual([fs.readFileSync(h.store.paths.PRIMARY, "utf8"), fs.existsSync(h.results.paths.PRIMARY)], before);
  assert.equal(h.uploads.length, 0);
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /app\.get\("\/api\/transfers\/:id", \(req, res\) => \{/, "a GET, and nothing else");
  assert.doesNotMatch(src, /app\.(post|put|delete)\("\/api\/transfers/);
});

// ---- attempts: one id each ----

test("Send again is a new transfer: the earlier id keeps its own result and never gets the retry's", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = Object.assign(new Error("reset"), { code: "ECONNRESET", outcome: "failed" });
  await h.pump();
  const again = await h.call("POST", "/api/deferred/:id/send-again", { id: r.id });
  assert.equal(again.code, 200);
  const second = again.body.transferId;
  assert.ok(second && second !== r.id);
  await h.pump();
  assert.deepEqual([(await status(h, r.id)).body.state, (await status(h, second)).body.state], ["failed", "verified"]);
  assert.equal((await status(h, second)).body.parentTransferId, r.id, "linked to the attempt before");
  assert.ok(h.audits.some(a => a.event === "deferred-send-again" && a.detail.transferId === second && a.detail.parentTransferId === r.id));
});

test("Send again whose earlier result cannot be saved changes nothing", async t => {
  quiet(t);
  const disk = resultsDisk();
  const h = deferredHarness(t, { resultsOpts: { fsImpl: disk.fsImpl, retry: { delays: [] } } });
  const r = await h.sendLater("pA", "A.gcode", "1");
  disk.full = true;
  h.uploadFail = Object.assign(new Error("reset"), { code: "ECONNRESET", outcome: "failed" });
  await h.pump();
  assert.equal(h.state(r.id), "failed");
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).code, 503);
  assert.equal(h.store.get(r.id).transferId, r.id, "still the same attempt");
  disk.full = false;
  assert.equal((await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).code, 200);
  assert.equal(h.results.get(r.id).state, "failed", "saved before it moved on");
});

test("a restart reconciling an interrupted attempt keeps its transfer id", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "the whole file");
  h.store.transition(r.id, ["queued"], { state: "uploading" });
  h.storage.set("pA/A.gcode", Buffer.from("the whole file"));
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  await h2.env.reconcileDeferred();
  assert.equal((await status(h2, r.id)).body.state, "verified");
  assert.equal(h2.uploads.length, 0);
});

// ---- durable completion (owner, P4 item 2) ----

test("a result that cannot be saved keeps the send (its only durable completion), and is saved on a later pass — no second upload", async t => {
  quiet(t);
  const disk = resultsDisk();
  const h = deferredHarness(t, { resultsOpts: { fsImpl: disk.fsImpl, retry: { delays: [] } } });
  const r = await h.sendLater("pA", "A.gcode", "1");
  disk.full = true;
  await h.pump();
  assert.equal(h.state(r.id), "completed", "kept: the results could not take it");
  assert.equal(h.env.queuedFile.get("pA").name, "A.gcode", "Loaded all the same");
  const s = (await status(h, r.id)).body;
  assert.deepEqual([s.state, s.unsaved], ["verified", true], "answered from the send meanwhile");
  await h.env.pumpDeferred();
  assert.equal(h.state(r.id), "completed", "still kept while the disk is full");
  disk.full = false;
  const ts = h.env.queuedFile.get("pA").ts;
  h.env.syncDeferredResults({ force: true });                  // its retry time has come
  assert.equal(h.state(r.id), undefined, "removed once its result is saved");
  assert.equal(h.results.get(r.id).state, "verified");
  assert.equal(h.uploads.length, 1);
  assert.equal(h.env.queuedFile.get("pA").ts, ts, "the Loaded entry was written once");
});

test("a crash before the result is saved: the restart saves it from the send, Loads, and removes it — no upload, no start", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.store.transition(r.id, ["queued"], { state: "completed", completion: { verification: "verified", basis: "content", verifiedAt: Date.now(), size: 1, at: Date.now() } });
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.results.get(r.id).state, "verified");
  assert.equal(h2.state(r.id), undefined);
  assert.equal(h2.env.queuedFile.get("pA").name, "A.gcode");
  assert.deepEqual([h2.uploads.length, h2.started || 0], [0, 0]);
});

test("a crash after the result is saved but before the send is removed: nothing is written twice", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  const done = h.store.transition(r.id, ["queued"], { state: "completed", completion: { verification: "verified", basis: "content", verifiedAt: Date.now(), size: 1, at: Date.now() } });
  h.results.record({ id: r.id, printerId: "pA", state: "verified", basis: "content", at: done.record.completion.at });
  const before = fs.readFileSync(h.results.paths.PRIMARY, "utf8");
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(r.id), undefined);
  assert.equal(fs.readFileSync(h2.results.paths.PRIMARY, "utf8"), before, "the saved result untouched");
  assert.equal(h2.uploads.length, 0);
});

test("a full disk at startup: completed sends stay until their results can be saved", async t => {
  quiet(t);
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.store.transition(r.id, ["queued"], { state: "completed", completion: { verification: "acknowledged", basis: "size", verifiedAt: Date.now(), size: 1, at: Date.now() } });
  const disk = resultsDisk(); disk.full = true;
  const h2 = restart(t, h, { resultsOpts: { fsImpl: disk.fsImpl, retry: { delays: [] } } });
  h2.env.deferredStartup();
  assert.equal(h2.state(r.id), "completed");
  assert.equal((await status(h2, r.id)).body.state, "acknowledged");
  disk.full = false;
  h2.env.syncDeferredResults({ force: true });                 // its retry time has come
  assert.equal(h2.state(r.id), undefined);
  assert.equal(h2.results.get(r.id).state, "acknowledged");
});

test("Dismiss saves the result first; if it cannot, the send stays", async t => {
  quiet(t);
  const disk = resultsDisk();
  const h = deferredHarness(t, { resultsOpts: { fsImpl: disk.fsImpl, retry: { delays: [] } } });
  const r = await h.sendLater("pA", "A.gcode", "1");
  disk.full = true;
  h.uploadFail = Object.assign(new Error("reset"), { code: "ECONNRESET", outcome: "failed" });
  await h.pump();
  assert.equal((await h.call("POST", "/api/deferred/:id/dismiss", { id: r.id })).code, 503);
  assert.equal(h.state(r.id), "failed");
  disk.full = false;
  assert.equal((await h.call("POST", "/api/deferred/:id/dismiss", { id: r.id })).code, 200);
  assert.equal((await status(h, r.id)).body.state, "failed", "the outcome outlives the send");
});

// ---- reconciling unknown; stale updates ----

test("unknown becomes delivered only when Check again reads the printer back and proves it — explicit and audited", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "the file");
  h.uploadFail = Object.assign(new Error("no answer"), { code: "ETIMEDOUT", outcome: "unknown" });
  await h.pump();
  assert.equal((await status(h, r.id)).body.state, "unknown");
  h.storage.set("pA/A.gcode", Buffer.from("the file"));
  h.env.deferredCheckedAt.clear();
  assert.equal((await h.call("POST", "/api/deferred/:id/check", { id: r.id })).body.state, "completed");
  const s = (await status(h, r.id)).body;
  assert.deepEqual([s.state, s.reconciledFrom && s.reconciledFrom.state], ["verified", "unknown"]);
  const a = h.audits.find(x => x.event === "transfer-result-reconciled");
  assert.ok(a);
  assert.deepEqual([a.detail.transferId, a.detail.from, a.detail.to], [r.id, "unknown", "verified"]);
});

test("a late or repeated ending never overwrites a final result", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  // A stale callback with an older state of the same attempt.
  const late = h.results.record({ id: r.id, printerId: "pA", state: "failed", code: "LATE", at: Date.now() });
  assert.ok(late.kept);
  assert.equal((await status(h, r.id)).body.state, "verified");
});

// ---- backup recovery ----

test("a send list restored from its backup writes no result, and one already finished is shown as such and never sent again", async t => {
  quiet(t);
  const h = deferredHarness(t);
  h.idle = false;
  const a = await h.sendLater("pA", "A.gcode", "1");
  const b = await h.sendLater("pB", "B.gcode", "2");          // the backup holds A only
  // A finished (delivered) after the backup was written.
  h.results.record({ id: a.id, printerId: "pA", state: "verified", basis: "content", at: Date.now() });
  void b;
  fs.writeFileSync(h.store.paths.PRIMARY, "{ corrupt");
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(a.id), "attention");
  assert.equal((await status(h2, a.id)).body.state, "verified", "its saved result, not the restored state");
  const row = h2.env.deferredRow(h2.store.get(a.id));
  assert.equal(row.finished, "verified");
  assert.equal((await h2.call("POST", "/api/deferred/:id/send-again", { id: a.id })).code, 409);
  assert.equal(h2.uploads.length, 0);
  assert.equal((await h2.call("POST", "/api/deferred/:id/dismiss", { id: a.id })).code, 200);
  // One with no saved result: unknown, and nothing written for it.
  const h3 = deferredHarness(t);
  h3.idle = false;
  const c = await h3.sendLater("pA", "C.gcode", "1");
  await h3.sendLater("pB", "D.gcode", "2");
  fs.writeFileSync(h3.store.paths.PRIMARY, "{ corrupt");
  const h4 = restart(t, h3);
  h4.env.deferredStartup();
  assert.equal(h4.results.get(c.id), null, "backup recovery made no result");
  assert.deepEqual([(await status(h4, c.id)).body.state, (await status(h4, c.id)).body.reason], ["unknown", "restored-from-backup"]);
});

// ---- retention ----

test("results outlive a restart; expire after their time; but never while their send is unresolved", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  const u = await h.sendLater("pB", "U.gcode", "1");
  h.uploadFail = Object.assign(new Error("no answer"), { code: "ETIMEDOUT", outcome: "unknown" });
  await h.pump();
  let clock = Date.now() + 25 * 3600 * 1000;
  const h2 = restart(t, h, { resultsOpts: { now: () => clock } });
  h2.env.deferredStartup();
  assert.equal((await status(h2, r.id)).code, 404, "expired");
  assert.equal((await status(h2, u.id)).body.state, "unknown", "its send still needs a person: kept");
  clock = Date.now();
  const h3 = restart(t, h);
  h3.env.deferredStartup();
  assert.equal((await status(h3, u.id)).body.state, "unknown");
});

test("retention comes from config.json, held to its limits", t => {
  const h = deferredHarness(t);
  const f = h.env.transferResultLimitsFromConfig;
  assert.deepEqual({ ...f({}) }, { retentionHours: 24, maxCount: 1000 });
  assert.deepEqual({ ...f({ transferResults: { retentionHours: 72, maxCount: 5000 } }) }, { retentionHours: 72, maxCount: 5000 });
  assert.deepEqual({ ...f({ transferResults: { retentionHours: 0, maxCount: 10 } }) }, { retentionHours: 1, maxCount: 100 });
  assert.deepEqual({ ...f({ transferResults: { retentionHours: 99999, maxCount: 1e9 } }) }, { retentionHours: 720, maxCount: 10000 });
  assert.deepEqual({ ...f({ transferResults: { retentionHours: "x", maxCount: true } }) }, { retentionHours: 24, maxCount: 1000 });
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /transferResults: CFG\.transferResults \|\| undefined,/, "kept through a Settings save");
});

// ---- the command line process never loads the server's stores ----

test("a --load call never loads (and so never tidies) the running server's send list or results", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const cliEnd = src.indexOf("\n}\n", src.indexOf("const CLI_LOAD_ARG"));
  assert.ok(cliEnd > 0);
  for (const call of ["deferredStore.load()", "transferResults.load()", "queueStore.load()"]) {
    assert.equal(src.split(call).length, 2, call + " once");
    assert.ok(src.indexOf(call) > cliEnd, call + " after the command-line block returns");
  }
});

test("cancelling a send whose outcome is unknown leaves its result unknown: the saved result is the answer", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = Object.assign(new Error("no answer"), { code: "ETIMEDOUT", outcome: "unknown" });
  await h.pump();
  assert.equal((await h.call("POST", "/api/deferred/:id/cancel", { id: r.id })).code, 200);
  assert.equal(h.state(r.id), "cancelled");
  assert.equal(h.results.get(r.id).state, "unknown", "not overwritten");
  assert.equal((await status(h, r.id)).body.state, "unknown", "the endpoint answers the saved result, not the send's later state");
});

test("a source that is gone fails without its path reaching the saved result or the status (P4 security review)", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "Gone.gcode", "1");
  fs.rmSync(r.source.path);
  h.idle = true;
  await h.pump();
  const body = (await status(h, r.id)).body;
  assert.deepEqual([body.state, body.code], ["failed", "DEFERRED_SOURCE_MISSING"]);
  assert.match(body.message, /\(ENOENT\)/);
  const raw = fs.readFileSync(h.results.paths.PRIMARY, "utf8");
  assert.ok(!raw.includes(h.srcDir) && !raw.includes(h.base), "no path on disk");
  assert.ok(!JSON.stringify(body).includes(h.base), "none in the answer");
});

// ---- from the P4 backend review ----
test("a completed send waiting for its result does not block the next send of that name, and a restart does not Load it again (B1)", async t => {
  quiet(t);
  const disk = resultsDisk();
  const h = deferredHarness(t, { resultsOpts: { fsImpl: disk.fsImpl, retry: { delays: [] } } });
  const a = await h.sendLater("pA", "A.gcode", "1");
  disk.full = true;
  await h.pump();
  assert.equal(h.state(a.id), "completed");
  assert.equal(h.store.get(a.id).loadedApplied, true, "saved as Loaded");
  const b = await h.sendLater("pA", "A.gcode", "2");          // the slicer pushes the same name again
  assert.equal(h.state(b.id), "queued", "accepted, not refused as a duplicate");
  // A restart with the results still unsaved: the Loaded entry is not written again.
  h.env.queuedFile.set("pA", { name: "Other.gcode", status: "ready", ts: 1 });
  const h2 = restart(t, h, { resultsOpts: { fsImpl: disk.fsImpl, retry: { delays: [] } } });
  h2.env.queuedFile.set("pA", { name: "Other.gcode", status: "ready", ts: 1 });
  h2.env.deferredStartup();
  assert.equal(h2.env.queuedFile.get("pA").name, "Other.gcode", "not Loaded a second time");
  assert.equal(h2.state(a.id), "completed", "still kept for its result");
});

test("a read-back basis no one expected is left out, never fatal (R1)", async t => {
  const h = deferredHarness(t);
  h.verify = () => ({ result: "verified", basis: "hash", evidence: "x" });
  const r = await h.sendLater("pA", "A.gcode", "1");
  await h.pump();
  assert.equal(h.state(r.id), undefined);
  const s = (await status(h, r.id)).body;
  assert.deepEqual([s.state, s.basis], ["verified", undefined]);
  // A record that would not save cannot stop the pass or startup either.
  h.idle = false;
  const x = await h.sendLater("pA", "X.gcode", "1");
  h.store.transition(x.id, ["queued"], { state: "completed", completion: { verification: "verified", basis: "content", at: Date.now() } });
  const real = h.results.record;
  h.results.record = () => { throw new Error("bad entry"); };
  assert.doesNotThrow(() => h.env.syncDeferredResults({ force: true }));
  h.results.record = real;
});

test("a disk that refuses every write is tried once per minute, not for every result every pass (R2)", async t => {
  quiet(t);
  const h = deferredHarness(t);
  h.idle = false;
  for (const n of ["A", "B", "C"]) {
    const r = await h.sendLater("pA", n + ".gcode", n);
    h.store.transition(r.id, ["queued"], { state: "failed", error: "x" });
  }
  let tries = 0;
  h.results.record = () => { tries++; return { ok: false, reason: "persist", error: new Error("EACCES") }; };
  h.env.syncDeferredResults({ force: true });
  assert.equal(tries, 1, "the first failure ends the pass");
  h.env.syncDeferredResults();
  h.env.syncDeferredResults();
  assert.equal(tries, 1, "and the next passes wait out the minute");
});

test("while the send list cannot be read, no result expires (R3)", t => {
  const h = deferredHarness(t);
  let clock = Date.now();
  h.results.record({ id: "dsend_old", printerId: "pA", state: "unknown", at: clock });
  fs.writeFileSync(h.store.paths.PRIMARY, JSON.stringify({ format: 99, records: [] }));   // from a newer SnapCon: read-only
  clock += 48 * 3600 * 1000;
  const h2 = restart(t, h, { resultsOpts: { now: () => clock } });
  assert.equal(h2.store.status().readOnly, true);
  assert.ok(h2.results.get("dsend_old"), "kept: nothing is known to be resolved");
});

// ---- from the P4 test review ----
const fail = () => Object.assign(new Error("reset"), { code: "ECONNRESET", outcome: "failed" });

test("while a retry is under way, the earlier id still answers its own final result; a third attempt links to the second", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = fail(); await h.pump();
  h.idle = false;
  const second = (await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).body.transferId;
  const s1 = (await status(h, r.id)).body, s2 = (await status(h, second)).body;
  assert.deepEqual([s1.state, s1.final], ["failed", true]);
  assert.deepEqual([s2.state, s2.final, s2.parentTransferId], ["queued", false, r.id]);
  h.idle = true; h.uploadFail = fail(); await h.pump();
  const third = (await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).body.transferId;
  assert.equal((await status(h, third)).body.parentTransferId, second);
});

test("a retried attempt that ended unknown is protected from expiry while its send waits", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = fail(); await h.pump();
  const second = (await h.call("POST", "/api/deferred/:id/send-again", { id: r.id })).body.transferId;
  h.uploadFail = Object.assign(new Error("no answer"), { code: "ETIMEDOUT", outcome: "unknown" }); await h.pump();
  const clock = Date.now() + 25 * 3600 * 1000;
  const h2 = restart(t, h, { resultsOpts: { now: () => clock } });
  assert.equal((await status(h2, second)).body.state, "unknown");
  assert.equal(h2.results.get(second).state, "unknown");
});

test("a send whose transferId is malformed is set aside, never crashing startup", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.store.transition(r.id, ["queued"], { state: "failed", code: "X" });
  const j = JSON.parse(fs.readFileSync(h.store.paths.PRIMARY, "utf8"));
  j.records[0].transferId = "../../x";
  fs.writeFileSync(h.store.paths.PRIMARY, JSON.stringify(j));
  const h2 = restart(t, h);
  assert.equal(h2.store.get(r.id), null, "set aside, as any record it cannot understand");
  assert.doesNotThrow(() => h2.env.deferredStartup());
});

test("crash after the result is saved, before Loaded: the restart Loads it", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  const done = h.store.transition(r.id, ["queued"], { state: "completed", completion: { verification: "verified", basis: "content", verifiedAt: Date.now(), size: 1, at: Date.now() } });
  h.results.record({ id: r.id, printerId: "pA", state: "verified", basis: "content", at: done.record.completion.at });
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(r.id), undefined);
  assert.equal(h2.env.queuedFile.get("pA") && h2.env.queuedFile.get("pA").name, "A.gcode");
});

test("an unknown (attention) send cannot be dismissed", async t => {
  const h = deferredHarness(t);
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = Object.assign(new Error("no answer"), { code: "ETIMEDOUT", outcome: "unknown" }); await h.pump();
  assert.equal((await h.call("POST", "/api/deferred/:id/dismiss", { id: r.id })).code, 409);
  assert.equal(h.state(r.id), "attention");
});

test("startup: send list loaded, then result limits from config, then results, then reconciliation", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const at = s => { const i = src.lastIndexOf(s); assert.ok(i > 0, s); return i; };
  const order = ["\ndeferredStore.load();", "\ntransferResults.setLimits(transferResultLimitsFromConfig(CFG));", "\ntransferResults.load();", "\ndeferredStartup();"].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("asking about a completed send whose result is not saved yet writes nothing", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.store.transition(r.id, ["queued"], { state: "completed", completion: { verification: "verified", basis: "content", verifiedAt: Date.now(), size: 1, at: Date.now() } });
  const before = fs.readFileSync(h.store.paths.PRIMARY, "utf8");
  const s = (await status(h, r.id)).body;
  assert.deepEqual([s.state, s.unsaved], ["verified", true]);
  assert.equal(h.results.get(r.id), null);
  assert.equal(fs.readFileSync(h.store.paths.PRIMARY, "utf8"), before);
  assert.equal(h.env.queuedFile.size, 0);
});

test("a completed send whose reconcile is not saved yet answers its newer outcome, not the older unknown", async t => {
  const h = deferredHarness(t);
  h.idle = false;
  const r = await h.sendLater("pA", "A.gcode", "1");
  h.results.record({ id: r.id, printerId: "pA", state: "unknown", reason: "unknown-after-upload", at: Date.now() - 1000 });
  h.store.transition(r.id, ["queued"], { state: "completed", completion: { verification: "verified", basis: "content", verifiedAt: Date.now(), size: 1, at: Date.now() } });
  const s = (await status(h, r.id)).body;
  assert.deepEqual([s.state, s.unsaved], ["verified", true]);
});

// ---- stale backups and later attempts (owner, 2026-10-29) ----
// Puts the send list back to an earlier saved copy, as a backup restore after
// a corrupt list would.
function restoreStale(h, snapshot) {
  fs.writeFileSync(h.store.paths.BAK, snapshot);
  fs.writeFileSync(h.store.paths.PRIMARY, "{ corrupt");
}

test("A fails → B retries A → B succeeds → a stale backup brings A back: A cannot be sent again, only dismissed", async t => {
  quiet(t);
  const h = deferredHarness(t);
  const a = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = fail();
  await h.pump();
  assert.equal(h.state(a.id), "failed");
  const stale = fs.readFileSync(h.store.paths.PRIMARY, "utf8");          // the list as it was with A failed
  const b = (await h.call("POST", "/api/deferred/:id/send-again", { id: a.id })).body.transferId;
  await h.pump();
  assert.equal((await status(h, b)).body.state, "verified", "B delivered");
  assert.equal(h.state(a.id), undefined);
  restoreStale(h, stale);
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(a.id), "failed", "A is back, as the backup had it");
  const row = h2.env.deferredRow(h2.store.get(a.id));
  assert.deepEqual([row.finished, row.finishedLater], ["verified", true]);
  const again = await h2.call("POST", "/api/deferred/:id/send-again", { id: a.id });
  assert.equal(again.code, 409);
  assert.match(again.body.error, /later attempt already delivered/);
  await h2.pump();
  assert.equal(h2.uploads.length, 0, "nothing sent");
  assert.equal((await status(h2, a.id)).body.state, "failed", "A's own result unchanged");
  assert.equal((await h2.call("POST", "/api/deferred/:id/dismiss", { id: a.id })).code, 200);
});

test("the same when a backup brings back A while it was still waiting: B's delivery makes it Dismiss-only", async t => {
  quiet(t);
  const h = deferredHarness(t);
  const a = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = fail();
  await h.pump();
  const b = (await h.call("POST", "/api/deferred/:id/send-again", { id: a.id })).body.transferId;
  // A third save so the backup holds the queued retry's predecessor state: A failed, then queued again as B.
  const staleQueued = fs.readFileSync(h.store.paths.PRIMARY, "utf8").replace(new RegExp(b, "g"), a.id).replace(/"parentTransferId": "[^"]*",?/, "");
  await h.pump();
  restoreStale(h, staleQueued);
  const h2 = restart(t, h);
  h2.env.deferredStartup();
  assert.equal(h2.state(a.id), "attention");
  assert.equal(h2.env.deferredRow(h2.store.get(a.id)).finishedLater, true);
  assert.equal((await h2.call("POST", "/api/deferred/:id/send-again", { id: a.id })).code, 409);
  assert.equal(h2.uploads.length, 0);
});

test("a restored attempt already known to be Failed or Cancelled is Dismiss-only", async t => {
  quiet(t);
  for (const ending of ["failed", "cancelled"]) {
    const h = deferredHarness(t);
    h.idle = false;
    const a = await h.sendLater("pA", "A.gcode", "1");
    if (ending === "failed") { h.idle = true; h.uploadFail = fail(); await h.pump(); }
    else await h.call("POST", "/api/deferred/:id/cancel", { id: a.id });
    await h.sendLater("pB", "B.gcode", "2");                   // the backup now holds A as it ended
    assert.equal(h.results.get(a.id).state, ending);
    fs.writeFileSync(h.store.paths.PRIMARY, "{ corrupt");
    const h2 = restart(t, h);
    h2.env.deferredStartup();
    assert.equal(h2.state(a.id), ending);
    assert.ok(h2.store.get(a.id).restoredFromBackup, "marked as restored");
    assert.equal(h2.env.deferredRow(h2.store.get(a.id)).finished, ending);
    assert.equal((await h2.call("POST", "/api/deferred/:id/send-again", { id: a.id })).code, 409, ending);
    assert.equal((await h2.call("POST", "/api/deferred/:id/dismiss", { id: a.id })).code, 200, ending);
    assert.equal(h2.uploads.length, 0);
  }
});

test("a failed send that was never restored keeps Send again, as in P3", async t => {
  const h = deferredHarness(t);
  const a = await h.sendLater("pA", "A.gcode", "1");
  h.uploadFail = fail();
  await h.pump();
  assert.equal(h.env.deferredRow(h.store.get(a.id)).finished, undefined);
  const h2 = restart(t, h);                                    // an ordinary restart, no restore
  h2.env.deferredStartup();
  assert.equal(h2.env.deferredRow(h2.store.get(a.id)).finished, undefined);
  assert.equal((await h2.call("POST", "/api/deferred/:id/send-again", { id: a.id })).code, 200);
});

// test/queueResolveRoute.test.js — POST /api/queue/:printerId/resolve
// (docs/TODO.md §34 items 5 and 6).
//
// Before: for "resume" the route probed the printer and sent it Resume FIRST,
// and only then asked the queue whether Resume was allowed. A Resume the queue
// refused (no attention, a reason without Resume, a store that can't save)
// still resumed the printer; only the reply failed. Now role, printer access,
// the store, the queue state and the action are all checked before any
// command reaches the printer.
//
// Clear and the bed-clear confirmation are tested here too (docs/TODO.md §36):
// Clear takes its turn in the same chain, and both name the job the page
// showed.
//
// The route is taken from server.js and run with the real role middleware
// (auth.js), the real QueueEngine and QueueStore, and a connector that records
// every command it is sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const auth = require("../auth");
const QueueEngine = require("../queue/QueueEngine");
const { createQueueStore } = require("../queue/QueueStore");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
// The decision chain, Clear, bed-clear, both decision routes, and nothing else.
const routeSrc = (() => {
  const at = serverSrc.indexOf("const QUEUE_DECISIONS = new Map();");
  const accept = serverSrc.indexOf('app.post("/api/queue/:printerId/accept-file-change"');
  assert.ok(at > 0 && accept > at);
  return serverSrc.slice(at, serverSrc.indexOf("\n});\n", accept) + 5);
})();

const item = (id, extra) => ({ id, status: "queued", alreadyUploaded: false, file: { name: id + ".gcode", sub: "", sizeBytes: 1, sha256: "h" }, map: {}, prefs: {},
  createdAt: 1, dispatchedAt: null, finishedAt: null, queuedBy: null, retryOfItemId: null, dispatchSnapshot: null, ...extra });

// Let pending promise callbacks run until `cond` holds.
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setImmediate(r));
  assert.ok(cond(), "timed out waiting");
}

function harness(t, { printerState = "paused", storeStatus = null, resumeFails = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-resolve-route-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const realStore = createQueueStore({ baseDir: base, fileIO: { stat: async () => ({ size: 1, mtimeMs: 1 }), hashFile: async () => ({ sizeBytes: 1, sha256: "h" }) } });
  realStore.assignPool("pr1");
  realStore.assignPool("pr2");
  // h.hold: printer calls and file hashes wait until h.release(), so two
  // requests really overlap.
  const h = { commands: [], audits: [], dispatches: [], store: realStore, hold: false, waiting: [] };
  const gate = async () => { if (h.hold) await new Promise(r => h.waiting.push(r)); };
  h.release = () => { h.hold = false; h.waiting.splice(0).forEach(r => r()); };
  const queueStore = {
    ...realStore,
    computeFileHash: async () => { h.commands.push("hash"); await gate(); return { sizeBytes: 2, sha256: "h2" }; },
    ...(storeStatus ? { getGlobalStatus: () => ({ ...realStore.getGlobalStatus(), ...storeStatus }) } : {}),
  };
  const printers = { pr1: { id: "pr1", name: "U1 Navy", connector: "fake" }, pr2: { id: "pr2", name: "U1 Teal", connector: "fake" } };
  const connector = {
    probe: async p => { h.commands.push("probe " + p.id); await gate(); return { online: true, state: printerState }; },
    resume: async p => { h.commands.push("resume " + p.id); await gate(); if (resumeFails) throw new Error("no answer"); },
    cancel: async p => { h.commands.push("cancel " + p.id); await gate(); if (h.onCancel) h.onCancel(); },
  };
  const handlers = {};
  const ctx = vm.createContext({
    app: { post: (route, ...fns) => { handlers[route.split("/").pop()] = fns; } },
    requireRegular: auth.requireRegular,
    printerById: id => printers[id] || null,
    printerVisibleTo: (user, p) => !user.hidden,
    getConnector: () => connector,
    queueStore, QueueEngine, Map, Promise,
    auditLog: { log: e => h.audits.push(JSON.parse(JSON.stringify(e))) },
    actorFromReq: req => ({ userId: req.user.id || null }),
    attemptQueueDispatch: async id => { h.dispatches.push(id); },
    queueDispatchJob: () => h.dispatchJob || null,
    redactQueueStateForResponse: s => s,
    resolveFileRef: async () => ({ fp: "/gcode/i1.gcode" }),
    fileExists: async () => true,
    replyFileRefError: () => false,
    console,
  });
  vm.runInContext(routeSrc, ctx);
  h.set = (patch, id = "pr1") => realStore.applyIntent(id, s => ({ ...s, ...patch }));
  h.state = (id = "pr1") => realStore.getPrinterState(id);
  // One request, as the page sends it: the item is the one shown, i.e. the
  // one waiting when the request is made, unless the test says otherwise.
  // Returns the reply when the route has answered (requireRegular calls next()
  // without awaiting it, so awaiting the chain would return too early).
  h.send = (route, body, { user = { id: "u1", role: "regular" }, printerId = "pr1" } = {}) => {
    const cur = realStore.getPrinterState(printerId).currentItem;
    const b = { ...body };
    if (!("itemId" in b)) b.itemId = cur ? cur.id : null;
    let replied;
    const done = new Promise(r => { replied = r; });
    const res = { code: 200, headersSent: false, status(c) { this.code = c; return this; }, json(o) { this.body = JSON.parse(JSON.stringify(o)); this.headersSent = true; replied(); return this; } };
    const req = { params: { printerId }, body: b, user };
    let i = 0;
    const next = () => { const fn = handlers[route][i++]; if (fn) return fn(req, res, next); };
    next();
    return done.then(() => res);
  };
  h.call = (action, user, printerId, extra = {}) => h.send("resolve", { action, ...extra }, { ...(user !== undefined ? { user } : {}), ...(printerId ? { printerId } : {}) });
  h.accept = (extra = {}) => h.send("accept-file-change", extra);
  h.clear = (extra = {}) => h.send("clear", extra);
  h.bedClear = (extra = {}) => h.send("confirm-bed-clear", extra);
  return h;
}

const unknownOutcome = { queueState: "queue_attention_required", attentionReason: "recovery-unknown-outcome",
  attentionDetail: { code: "printer-idle", message: "went idle", resumable: false },
  currentItem: item("i1", { status: "printing", dispatchedAt: 5 }), queue: [item("i2")] };
const printFailed = { queueState: "queue_attention_required", attentionReason: "print-failed",
  attentionDetail: { code: "print-failed", message: "x", resumable: true }, currentItem: item("i1", { status: "failed" }), queue: [] };

// ---- who may ask ----

test("a view-only user is refused before anything happens", async t => {
  const h = harness(t); h.set(printFailed);
  const res = await h.call("resume", { id: "v", role: "view" });
  assert.equal(res.code, 403);
  assert.deepEqual(h.commands, []);
  assert.equal(h.state().queueState, "queue_attention_required");
});

test("no session (sign-in on, nobody signed in) is refused", async t => {
  const h = harness(t); h.set(printFailed);
  const res = await h.call("resume", null);
  assert.equal(res.code, 401);
  assert.deepEqual(h.commands, []);
});

test("a printer the user can't see is refused, and an unknown printer too", async t => {
  const h = harness(t); h.set(printFailed);
  assert.equal((await h.call("resume", { id: "u", role: "regular", hidden: true })).code, 403);
  assert.equal((await h.call("resume", undefined, "nope")).code, 400);
  assert.deepEqual(h.commands, []);
});

// ---- the bug: nothing reaches the printer before the queue agrees ----

test("Resume on an unknown outcome is refused, and the printer is never asked (the reported bug)", async t => {
  const h = harness(t); h.set(unknownOutcome);
  const res = await h.call("resume");
  assert.equal(res.code, 400);
  assert.equal(res.body.code, "invalid_action");
  assert.deepEqual(h.commands, [], "no probe, no resume");
  assert.equal(h.state().attentionReason, "recovery-unknown-outcome", "the queue is unchanged");
});

test("Resume when the queue isn't waiting for a decision is refused, and the printer is never asked", async t => {
  const h = harness(t); h.set({ queueState: "printing", currentItem: item("i1", { status: "printing" }) });
  const res = await h.call("resume");
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "not_in_attention");
  assert.deepEqual(h.commands, []);
});

test("an action that doesn't exist, or none at all, is refused without touching the printer", async t => {
  const h = harness(t); h.set(printFailed);
  for (const action of ["format-disk", "", undefined, 42]) {
    const res = await h.call(action);
    assert.equal(res.code, 400, String(action));
  }
  assert.deepEqual(h.commands, []);
});

test("a queue store that can't save refuses before the printer is asked", async t => {
  for (const flag of ["storeDegraded", "storeStoppedByAdmin", "queueStoreRecoveryRequired"]) {
    const h = harness(t, { storeStatus: { [flag]: true } }); h.set(printFailed);
    const res = await h.call("resume");
    assert.equal(res.code, 503, flag);
    assert.deepEqual(h.commands, [], flag);
  }
});

// ---- Resume where it is valid ----

test("Resume on a failed print still works: the printer is checked, resumed, and the queue goes back to printing", async t => {
  const h = harness(t); h.set(printFailed);
  const res = await h.call("resume");
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(h.commands, ["probe pr1", "resume pr1"]);
  assert.equal(h.state().queueState, "printing");
});

test("Resume on a failed print the printer isn't paused on is refused, and no resume is sent", async t => {
  const h = harness(t, { printerState: "standby" }); h.set(printFailed);
  const res = await h.call("resume");
  assert.equal(res.code, 409);
  assert.deepEqual(h.commands, ["probe pr1"]);
  assert.equal(h.state().queueState, "queue_attention_required");
});

// ---- Mark as completed ----

test("Mark as completed: recorded with completedBy user, waits for bed-clear, sends nothing to the printer, starts nothing", async t => {
  const h = harness(t); h.set(unknownOutcome);
  const res = await h.call("mark-completed");
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.dispatches, [], "the next item waits for the bed-clear confirmation");
  const st = h.state();
  assert.equal(st.queueState, "awaiting_bed_clear");
  assert.equal(st.currentItem.status, "completed");
  assert.equal(st.currentItem.completedBy, "user");
  assert.deepEqual(st.recentHistory.map(i => [i.id, i.status, i.completedBy]), [["i1", "completed", "user"]]);
  assert.deepEqual(st.queue.map(i => i.id), ["i2"]);
  assert.deepEqual(h.audits.map(a => [a.event, a.detail]), [["queue-attention-resolved", { action: "mark-completed", file: "i1.gcode", completedBy: "user" }]],
    "audited as a resolution, never as print-completed (the Library imports those as printer-reported)");
});

test("Mark as completed is refused for any other reason", async t => {
  const h = harness(t); h.set(printFailed);
  const res = await h.call("mark-completed");
  assert.equal(res.code, 400);
  assert.equal(h.state().attentionReason, "print-failed");
});

test("Mark as completed needs the same role as any other decision", async t => {
  const h = harness(t); h.set(unknownOutcome);
  assert.equal((await h.call("mark-completed", { id: "v", role: "view" })).code, 403);
  assert.equal(h.state().attentionReason, "recovery-unknown-outcome");
});

test("the route is registered behind requireRegular", () => {
  assert.match(serverSrc, /app\.post\("\/api\/queue\/:printerId\/resolve", requireRegular, async \(req, res\) => \{/);
});

// ---- two decisions at once (the race) ----
// While a decision waits on the printer, a second one for the same printer
// waits its turn and is checked again against the queue the first one left.

test("two Resumes at once: one is applied, the printer is resumed once, the other is refused", async t => {
  const h = harness(t); h.set(printFailed);
  h.hold = true;
  const a = h.call("resume"), b = h.call("resume");
  await until(() => h.commands.length === 1);
  assert.deepEqual(h.commands, ["probe pr1"], "the second waits instead of probing alongside");
  h.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.code, rb.code], [200, 409]);
  assert.equal(rb.body.code, "not_in_attention");
  assert.deepEqual(h.commands, ["probe pr1", "resume pr1"], "exactly one probe and one resume");
  assert.equal(h.state().queueState, "printing");
  assert.equal(h.audits.length, 1);
});

test("Resume and Skip at once: the first wins; the other neither changes the item nor reaches the printer", async t => {
  // Resume first: it is waiting on the printer when Skip arrives.
  let h = harness(t); h.set(printFailed);
  h.hold = true;
  const resume = h.call("resume");
  await until(() => h.commands.length === 1);
  const skip = h.call("skip");
  h.release();
  let [r1, r2] = await Promise.all([resume, skip]);
  assert.deepEqual([r1.code, r2.code], [200, 409]);
  assert.equal(h.state().queueState, "printing");
  assert.deepEqual(h.state().recentHistory, [], "the item wasn't skipped");
  assert.deepEqual(h.commands, ["probe pr1", "resume pr1"]);
  // Skip first: Resume then finds nothing to decide and sends nothing.
  h = harness(t); h.set(printFailed);
  [r1, r2] = await Promise.all([h.call("skip"), h.call("resume")]);
  assert.deepEqual([r1.code, r2.code], [200, 409]);
  assert.equal(h.state().currentItem.status, "skipped");
  assert.deepEqual(h.commands, [], "no probe, no resume");
});

test("Retry and Skip at once: one decision, one history entry, no duplicate retry", async t => {
  const h = harness(t); h.set(unknownOutcome);
  const [r1, r2] = await Promise.all([h.call("retry"), h.call("skip")]);
  assert.deepEqual([r1.code, r2.code], [200, 409]);
  const st = h.state();
  assert.equal(st.queue.filter(i => i.retryOfItemId === "i1").length, 1, "retried once");
  assert.deepEqual(st.recentHistory, [], "and not also skipped");
  assert.equal(h.audits.length, 1);
});

test("two Mark as completed at once: recorded once", async t => {
  const h = harness(t); h.set(unknownOutcome);
  const [r1, r2] = await Promise.all([h.call("mark-completed"), h.call("mark-completed")]);
  assert.deepEqual([r1.code, r2.code], [200, 409]);
  assert.equal(h.state().recentHistory.length, 1);
  assert.equal(h.audits.length, 1);
});

test("a decision about an item the queue has moved past is refused, even if the queue is waiting again", async t => {
  const h = harness(t); h.set(printFailed);
  // A page that showed i1 sends Retry after i1 was skipped, and the next
  // item has since failed too.
  h.set({ currentItem: item("i2", { status: "failed" }) });
  const res = await h.call("retry", undefined, undefined, { itemId: "i1" });
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "stale_decision");
  assert.equal(h.state().currentItem.id, "i2");
  assert.deepEqual(h.state().queue, [], "i2 was not retried by a decision about i1");
  const resume = await h.call("resume", undefined, undefined, { itemId: "i1" });
  assert.equal(resume.code, 409);
  assert.deepEqual(h.commands, [], "and nothing reached the printer");
});

test("a decision that doesn't name the item waiting is refused (an old page)", async t => {
  const h = harness(t); h.set(printFailed);
  const res = await h.call("resume", undefined, undefined, { itemId: null });
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "stale_decision");
  assert.deepEqual(h.commands, []);
});

test("different printers don't wait on each other", async t => {
  const h = harness(t); h.set(printFailed); h.set(unknownOutcome, "pr2");
  h.hold = true;
  const slow = h.call("resume");
  await until(() => h.commands.length === 1);
  const other = await h.call("mark-completed", undefined, "pr2");
  assert.equal(other.code, 200, "pr2 decided while pr1 still waits on its printer");
  h.release();
  assert.equal((await slow).code, 200);
});

test("a decision that failed at the printer releases the chain: the next one runs", async t => {
  const h = harness(t, { resumeFails: true }); h.set(printFailed);
  const failed = await h.call("resume");
  assert.equal(failed.code, 502);
  assert.equal(h.state().queueState, "queue_attention_required", "a failed resume changes nothing");
  const skip = await h.call("skip");
  assert.equal(skip.code, 200);
});

test("accept-file-change and Skip at once: one applies, the other is refused", async t => {
  const h = harness(t);
  h.set({ queueState: "queue_attention_required", attentionReason: "file-changed", attentionDetail: { code: "file-changed", message: "x" }, currentItem: item("i1"), queue: [] });
  h.hold = true;
  const accept = h.accept();
  await until(() => h.commands.length === 1);
  assert.deepEqual(h.commands, ["hash"]);
  const skip = h.call("skip");
  h.release();
  const [ra, rs] = await Promise.all([accept, skip]);
  assert.deepEqual([ra.code, rs.code], [200, 409]);
  assert.deepEqual(h.state().recentHistory, [], "the accepted item wasn't also skipped");
});

test("accept-file-change about an item the queue has moved past is refused before hashing", async t => {
  const h = harness(t);
  h.set({ queueState: "queue_attention_required", attentionReason: "file-changed", attentionDetail: { code: "file-changed", message: "x" }, currentItem: item("i2"), queue: [] });
  const res = await h.accept({ itemId: "i1" });
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "stale_decision");
  assert.deepEqual(h.commands, []);
  assert.equal(h.state().attentionReason, "file-changed");
});

test("the page sends the item with every decision", () => {
  assert.match(appSrc, /postJSON\("\/api\/queue\/"\+b\.dataset\.printer\+"\/accept-file-change",\{itemId\}\)/);
  assert.match(appSrc, /postJSON\("\/api\/queue\/"\+b\.dataset\.printer\+"\/resolve",\{action,itemId\}\)/);
});

// ---- the page ----


test("the page's action table matches the engine's (file-changed adds its own page-only accept)", () => {
  const at = appSrc.indexOf("const QUEUE_ATTENTION_RESOLUTIONS=");
  const page = vm.runInNewContext("(" + appSrc.slice(appSrc.indexOf("{", at), appSrc.indexOf("};", at) + 1) + ")");
  const engine = JSON.parse(JSON.stringify(QueueEngine.RESOLUTIONS_BY_REASON));
  assert.deepEqual(JSON.parse(JSON.stringify(page)), { ...engine, "file-changed": ["accept-file-change", ...engine["file-changed"]] });
  assert.ok(!page["recovery-unknown-outcome"].includes("resume"));
});

test("Mark as completed asks first, naming the file; other decisions don't", () => {
  assert.match(appSrc, /data-action="\$\{esc\(action\)\}" data-item="\$\{esc\(itemId\)\}"\$\{action==="mark-completed"\?` data-file="\$\{esc\(file\)\}"`:""\}/);
  assert.match(appSrc, /if\(action==="mark-completed"&&!confirm\(t\("queue\.mark_completed_confirm",\{file:b\.dataset\.file\|\|t\("queue\.mark_completed_this_print"\)\}\)\)\) return;/);
  assert.match(appSrc, /"mark-completed":"queue\.action_mark_completed"/);
});

// ---- Clear and the bed-clear confirmation (docs/TODO.md §36) ----

const printing = { queueState: "printing", currentItem: item("i1", { status: "printing", dispatchedAt: 5 }), queue: [item("i2")] };
const awaitingBed = { queueState: "awaiting_bed_clear", currentItem: item("i1", { status: "completed", finishedAt: 9 }),
  recentHistory: [item("i1", { status: "completed", finishedAt: 9 })], queue: [item("i2")] };
const historyOf = h => h.state().recentHistory.map(i => [i.id, i.status]);

test("Clear while Resume still waits on the printer: Clear runs after it and cancels the print Resume started (F1)", async t => {
  const h = harness(t); h.set({ ...printFailed, recentHistory: [item("i1", { status: "failed" })], queue: [item("i2")] });
  h.hold = true;
  const resume = h.call("resume");
  await until(() => h.commands.length === 1);
  const clear = h.clear();
  h.release();
  const [rr, rc] = await Promise.all([resume, clear]);
  assert.deepEqual([rr.code, rc.code], [200, 200], JSON.stringify([rr.body, rc.body]));
  assert.deepEqual(h.commands, ["probe pr1", "resume pr1", "cancel pr1"], "the printer isn't left printing for an empty queue");
  const st = h.state();
  assert.equal(st.queueState, "idle");
  assert.equal(st.currentItem, null);
  assert.deepEqual(historyOf(h), [["i1", "failed"], ["i1", "cancelled"], ["i2", "removed"]], "failed, then resumed and cancelled: each recorded once");
  assert.deepEqual(h.audits.map(a => [a.event, a.detail.cancelledCurrent]), [["queue-attention-resolved", undefined], ["queue-cleared", true]]);
});

test("Clear waits while Resume is at the printer: it neither cancels nor empties the queue meanwhile", async t => {
  // Before the fix Clear read "needs attention" here, sent no cancel and
  // emptied the queue, and the Resume then resumed the printer anyway.
  const h = harness(t); h.set(printFailed);
  h.hold = true;
  const resume = h.call("resume");
  await until(() => h.commands.length === 1);
  const clear = h.clear();
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(h.commands, ["probe pr1"], "Clear waits; it neither cancels nor clears yet");
  assert.equal(h.state().queueState, "queue_attention_required");
  h.release();
  await Promise.all([resume, clear]);
});

test("two Clears at once while printing: one cancel, one clear, one history entry each (F2)", async t => {
  const h = harness(t); h.set(printing);
  h.hold = true;
  const a = h.clear(), b = h.clear();
  await until(() => h.commands.length === 1);
  h.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.code, rb.code], [200, 409]);
  assert.equal(rb.body.code, "stale_decision", "the second named a job that is gone");
  assert.deepEqual(h.commands, ["cancel pr1"]);
  assert.deepEqual(historyOf(h), [["i1", "cancelled"], ["i2", "removed"]]);
  assert.equal(h.audits.length, 1);
});

test("Clear while printing cancels the print, then clears", async t => {
  const h = harness(t); h.set(printing);
  const res = await h.clear();
  assert.equal(res.code, 200);
  assert.deepEqual(h.commands, ["cancel pr1"]);
  assert.deepEqual(historyOf(h), [["i1", "cancelled"], ["i2", "removed"]]);
  assert.deepEqual(h.dispatches, [], "Clear starts nothing");
});

test("Clear while a decision is needed sends nothing to the printer; a failed print keeps its one entry", async t => {
  const h = harness(t); h.set({ ...printFailed, recentHistory: [item("i1", { status: "failed" })], queue: [item("i2")] });
  const res = await h.clear();
  assert.equal(res.code, 200);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(historyOf(h), [["i1", "failed"], ["i2", "removed"]], "not also recorded as cancelled");
  // Nobody knows how an unknown outcome ended, and Clear sent no cancel: it is
  // recorded once, as unknown, not as a cancel that never happened.
  const h2 = harness(t); h2.set(unknownOutcome);
  assert.equal((await h2.clear()).code, 200);
  assert.deepEqual(h2.commands, []);
  assert.deepEqual(historyOf(h2), [["i1", "unknown"], ["i2", "removed"]]);
});

test("Clear while waiting for bed-clear: nothing sent, nothing started, the completion stays recorded once (F3)", async t => {
  const h = harness(t); h.set(awaitingBed);
  const res = await h.clear();
  assert.equal(res.code, 200);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.dispatches, []);
  assert.deepEqual(historyOf(h), [["i1", "completed"], ["i2", "removed"]], "Parts today still counts it");
});

test("Clear while the printer reports the print stopping: one entry, cancelled by the user, not failed", async t => {
  // The cancel is under way when the printer's own update says the print
  // stopped, which the queue records as failed. That stop is Clear's cancel.
  const h = harness(t); h.set(printing);
  h.onCancel = () => h.store.applyObserved("pr1", QueueEngine.onProbeFailedOrCancelled, false, { code: "cancelled", message: "cancelled" });
  const res = await h.clear();
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(h.commands, ["cancel pr1"]);
  assert.deepEqual(historyOf(h), [["i1", "cancelled"], ["i2", "removed"]]);
  assert.equal(h.state().recentHistory[0].cancelledBy, "user");
  assert.equal(h.state().queueState, "idle");
});

test("Clear while the printer reports the print completed: the printer's completion stands", async t => {
  const h = harness(t); h.set(printing);
  h.onCancel = () => h.store.applyObserved("pr1", QueueEngine.onProbeComplete);
  assert.equal((await h.clear()).code, 200);
  assert.deepEqual(historyOf(h), [["i1", "completed"], ["i2", "removed"]], "not overwritten with failed or cancelled");
  assert.equal(h.state().recentHistory[0].cancelledBy, undefined);
});

test("Clear while the printer goes idle unseen: recorded as cancelled once, since Clear did send the cancel", async t => {
  const h = harness(t); h.set(printing);
  h.onCancel = () => h.store.applyObserved("pr1", QueueEngine.onPrinterIdleWhilePrinting, "i1");
  assert.equal((await h.clear()).code, 200);
  assert.deepEqual(historyOf(h), [["i1", "cancelled"], ["i2", "removed"]]);
});

test("Clear on a print that failed, was resumed, and fails again during the cancel: the earlier failure stays, the cancel replaces only the new one", async t => {
  const h = harness(t); h.set({ ...printing, recentHistory: [item("i1", { status: "failed" })] });
  h.onCancel = () => h.store.applyObserved("pr1", QueueEngine.onProbeFailedOrCancelled, false, { code: "cancelled" });
  assert.equal((await h.clear()).code, 200);
  assert.deepEqual(historyOf(h), [["i1", "failed"], ["i1", "cancelled"], ["i2", "removed"]]);
});

test("Clear from a page showing an idle queue never cancels a print, whoever started it", async t => {
  // A print started outside the queue: the queue is idle with jobs waiting.
  const h = harness(t); h.set({ queueState: "idle", currentItem: null, queue: [item("i2")] });
  const res = await h.clear({ itemId: null });
  assert.equal(res.code, 200);
  assert.deepEqual(h.commands, [], "the manual print isn't the queue's to cancel");
  assert.deepEqual(historyOf(h), [["i2", "removed"]]);
  // The queue started its next job after the page showed it idle: refused.
  const h2 = harness(t); h2.set({ queueState: "printing", currentItem: item("i2", { status: "printing" }), queue: [] });
  const res2 = await h2.clear({ itemId: null });
  assert.equal(res2.code, 409);
  assert.equal(res2.body.code, "stale_decision");
  assert.deepEqual(h2.commands, []);
  // A queue that says printing but has no current job (no job of its own):
  // nothing to cancel either.
  const h3 = harness(t); h3.set({ queueState: "printing", currentItem: null, queue: [] });
  assert.equal((await h3.clear({ itemId: null })).code, 200);
  assert.deepEqual(h3.commands, []);
});

test("Clear whose job was replaced while the print was being cancelled clears nothing", async t => {
  const h = harness(t); h.set(printing);
  // The print finished and the next one was claimed before Clear could apply.
  h.onCancel = () => h.set({ queueState: "dispatching", currentItem: item("i2", { status: "dispatching" }), queue: [] });
  const res = await h.clear();
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "queue_moved_during_clear", "says the print was cancelled and nothing else was");
  assert.equal(h.state().currentItem.id, "i2", "i2 isn't cleared by a Clear about i1");
  assert.deepEqual(h.audits, []);
});

test("a stale Clear is refused before any cancel: a page that showed one print can't cancel another with the same file name", async t => {
  const h = harness(t);
  // The page showed i1 ("part.gcode"); the queue has since moved on to i7,
  // another job for the same file.
  h.set({ ...printing, currentItem: item("i7", { status: "printing", file: { name: "part.gcode", sub: "", sizeBytes: 1, sha256: "h" } }) });
  const res = await h.clear({ itemId: "i1" });
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "stale_decision");
  assert.deepEqual(h.commands, [], "no cancel");
  assert.equal(h.state().queueState, "printing");
  assert.deepEqual(h.state().queue.map(i => i.id), ["i2"], "nothing removed");
  // A page that showed an idle queue can't cancel a print that has started since.
  const old = await h.clear({ itemId: null });
  assert.equal(old.code, 409);
  assert.deepEqual(h.commands, []);
});

test("Clear while a dispatch is still uploading stops the upload without a cancel; once the start was sent, it cancels", async t => {
  const dispatching = { queueState: "dispatching", currentItem: item("i1", { status: "dispatching" }), queue: [] };
  let h = harness(t); h.set(dispatching);
  let stopped = 0;
  h.dispatchJob = { phase: "uploading", cancelUpload: () => stopped++ };
  assert.equal((await h.clear()).code, 200);
  assert.deepEqual(h.commands, []);
  assert.equal(stopped, 1);
  h = harness(t); h.set(dispatching);
  h.dispatchJob = { phase: "starting", cancelUpload: null };
  assert.equal((await h.clear()).code, 200);
  assert.deepEqual(h.commands, ["cancel pr1"]);
});

test("a cancel the printer refuses changes nothing and frees the chain", async t => {
  const h = harness(t); h.set(printing);
  h.onCancel = () => { throw new Error("no answer"); };
  const res = await h.clear();
  assert.equal(res.code, 502);
  assert.equal(h.state().queueState, "printing", "the queue still tracks the print");
  h.onCancel = null;
  assert.equal((await h.clear()).code, 200);
});

test("a queue store that can't save refuses Clear before the printer is asked", async t => {
  const h = harness(t, { storeStatus: { storeDegraded: true } }); h.set(printing);
  const res = await h.clear();
  assert.equal(res.code, 503);
  assert.deepEqual(h.commands, []);
});

test("Clear needs the same role and printer access as a decision", async t => {
  const h = harness(t); h.set(printing);
  assert.equal((await h.send("clear", {}, { user: { id: "v", role: "view" } })).code, 403);
  assert.equal((await h.send("clear", {}, { user: { id: "u", role: "regular", hidden: true } })).code, 403);
  assert.deepEqual(h.commands, []);
});

test("bed-clear confirmation for the job shown: the queue moves on and dispatches the next one", async t => {
  const h = harness(t); h.set(awaitingBed);
  const res = await h.bedClear();
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(h.state().queueState, "idle");
  assert.deepEqual(h.dispatches, ["pr1"]);
  assert.deepEqual(h.commands, []);
  assert.equal(h.audits[0].event, "manual-bed-clear-confirmed");
});

test("a stale bed-clear confirmation is refused before anything starts, even for a job with the same file name (F4)", async t => {
  const h = harness(t);
  // The page showed i1's bed; i1 was confirmed elsewhere, i7 (same file)
  // printed and now waits for its own bed to be cleared.
  const done = item("i7", { status: "completed", file: { name: "i1.gcode", sub: "", sizeBytes: 1, sha256: "h" } });
  h.set({ ...awaitingBed, currentItem: done, recentHistory: [done] });
  const res = await h.bedClear({ itemId: "i1" });
  assert.equal(res.code, 409);
  assert.equal(res.body.code, "stale_decision");
  assert.equal(h.state().queueState, "awaiting_bed_clear", "i7's bed is still waiting for its own confirmation");
  assert.deepEqual(h.dispatches, [], "nothing started on top of i7");
  assert.deepEqual(h.audits, []);
  assert.equal((await h.bedClear({ itemId: null })).code, 409, "an old page naming no job is refused too");
});

test("two bed-clear confirmations: one dispatch", async t => {
  const h = harness(t); h.set(awaitingBed);
  const [a, b] = await Promise.all([h.bedClear({ itemId: "i1" }), h.bedClear({ itemId: "i1" })]);
  assert.deepEqual([a.code, b.code], [200, 409]);
  assert.deepEqual(h.dispatches, ["pr1"]);
});

test("bed-clear confirmed, then a Clear from the same page: the Clear is stale and starts or cancels nothing", async t => {
  const h = harness(t); h.set(awaitingBed);
  assert.equal((await h.bedClear({ itemId: "i1" })).code, 200);
  // The dispatch that confirmation asked for has claimed i2 by now.
  h.set({ queueState: "dispatching", currentItem: item("i2", { status: "dispatching" }), queue: [] });
  const res = await h.clear({ itemId: "i1" });
  assert.equal(res.code, 409);
  assert.deepEqual(h.commands, []);
  assert.equal(h.state().currentItem.id, "i2");
});

test("the page names the job with Clear and the bed-clear confirmation, and shows a refusal", () => {
  assert.match(appSrc, /queue-confirm-bedclear" data-printer="\$\{esc\(p\.id\)\}" data-item="\$\{esc\(\(qs&&qs\.currentItem&&qs\.currentItem\.id\)\|\|""\)\}"/);
  assert.match(appSrc, /queue-clear" data-printer="\$\{esc\(p\.id\)\}" data-item="\$\{esc\(\(qs&&qs\.currentItem&&qs\.currentItem\.id\)\|\|""\)\}"/);
  assert.match(appSrc, /postJSON\("\/api\/queue\/"\+b\.dataset\.printer\+"\/"\+action,\{itemId:b\.dataset\.item\|\|null\}\)/);
  assert.match(appSrc, /aboutItem\(b,"clear"\)/);
  assert.match(appSrc, /aboutItem\(b,"confirm-bed-clear"\)/);
});

test("every refusal Clear and bed-clear give has a translated message in English and Spanish", () => {
  const at = appSrc.indexOf("const QUEUE_ERROR_KEYS=");
  const keys = vm.runInNewContext("(" + appSrc.slice(appSrc.indexOf("{", at), appSrc.indexOf("};", at) + 1) + ")");
  const routes = serverSrc.slice(serverSrc.indexOf('app.post("/api/queue/:printerId/clear"'), serverSrc.indexOf("// Resolving queue_attention_required"));
  const codes = [...new Set([...routes.matchAll(/code: "([a-z_]+)"/g)].map(m => m[1]))];
  assert.ok(codes.includes("stale_decision") && codes.includes("queue_moved_during_clear"), codes.join());
  const special = ["queue_save_failed", "cancel_failed"];   // handled in queueErrorText with their detail
  for (const l of ["en", "es"]) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", l + ".json"), "utf8"));
    const get = k => k.split(".").reduce((o, p) => o && o[p], d);
    for (const c of codes) {
      if (special.includes(c)) continue;
      assert.ok(keys[c], "no key for " + c);
      assert.equal(typeof get(keys[c]), "string", l + ": " + keys[c]);
    }
    assert.match(get("queue.error_cancel_failed_detail"), /\{detail\}/, l);
  }
  assert.match(appSrc, /if\(d&&d\.code==="cancel_failed"\) return t\("queue\.error_cancel_failed_detail",\{detail:d\.detail\|\|""\}\);/);
});

test("Clear and bed-clear stay behind requireRegular", () => {
  assert.match(serverSrc, /app\.post\("\/api\/queue\/:printerId\/clear", requireRegular, async \(req, res\) => \{/);
  assert.match(serverSrc, /app\.post\("\/api\/queue\/:printerId\/confirm-bed-clear", requireRegular, \(req, res\) => \{/);
});

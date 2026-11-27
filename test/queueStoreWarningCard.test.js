// test/queueStoreWarningCard.test.js — the Settings card that carries the
// queue store's Reset / Resume controls (renderQueueStoreWarning in
// public/app.js), and the Queue Management switch's handling of a refusal.
//
// The server refuses to switch Queue Management on while the queue store is
// recovery-required or stopped. The card used to be hidden whenever Queue
// Management was off, so in that state there was no control left to clear
// the condition with. The function is taken from app.js and run against a
// minimal stand-in for the two elements it writes to.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const os = require("os");
const { createQueueStore } = require("../queue/QueueStore");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const fnSrc = (() => { const at = appSrc.indexOf("function renderQueueStoreWarning(){"); assert.ok(at > 0); return appSrc.slice(at, appSrc.indexOf("\n}\n", at) + 3); })();

function render(enabled, status) {
  const els = { queueStoreWarningCard: { style: { display: "none" } }, queueStoreWarning: { innerHTML: "" } };
  const clicks = {}, posted = [];
  const button = id => ({ addEventListener(ev, fn) { if (ev === "click") clicks[id] = fn; } });
  const ctx = vm.createContext({
    QUEUE_MANAGEMENT_ENABLED: enabled,
    QUEUE_STORE_STATUS: { storeDegraded: false, storeStoppedByAdmin: false, queueStoreRecoveryRequired: false, ...status },
    $: id => els[id] || (els.queueStoreWarning.innerHTML.includes(`id="${id}"`) ? button(id) : null),
    t: k => k, esc: s => String(s).replace(/</g, "&lt;"), queueStoreAction(url) { posted.push(url); },
  });
  vm.runInContext(fnSrc + "\nrenderQueueStoreWarning();", ctx);
  // click(id): what the button with that id asks the server for.
  return { shown: els.queueStoreWarningCard.style.display !== "none", html: els.queueStoreWarning.innerHTML, click: id => { posted.length = 0; clicks[id](); return posted.slice(); } };
}

test("recovery-required shows the Reset control whether Queue Management is on or off", () => {
  for (const enabled of [true, false]) {
    const r = render(enabled, { queueStoreRecoveryRequired: true });
    assert.equal(r.shown, true, "enabled=" + enabled);
    assert.match(r.html, /id="queueAckResetBtn"/);
    assert.match(r.html, /id="queueResetConfirm"/);
  }
});

test("stopped-by-admin shows the Resume control whether Queue Management is on or off", () => {
  for (const enabled of [true, false]) {
    const r = render(enabled, { storeStoppedByAdmin: true });
    assert.equal(r.shown, true, "enabled=" + enabled);
    assert.match(r.html, /id="queueResumeAllBtn"/);
  }
});

test("nothing wrong: hidden, on or off", () => {
  assert.equal(render(true, {}).shown, false);
  assert.equal(render(false, {}).shown, false);
});

test("a failing save is shown with its Retry control whether Queue Management is on or off (the server refuses to switch it on in that state)", () => {
  for (const enabled of [true, false]) {
    const r = render(enabled, { storeDegraded: true });
    assert.equal(r.shown, true, "enabled=" + enabled);
    assert.match(r.html, /queue\.store_degraded_line/);
    assert.match(r.html, /id="queueRetrySaveBtn"/);
    assert.match(r.html, /id="queueStopAllBtn"/, "enabled=" + enabled);
  }
});

// "Stopped" is a state of the queue store, not of automation: it refuses
// manual queue changes too (QueueStore.js blockedReason), with Queue
// Management on or off. So wherever this card offers Stop all with it on, it
// offers it with it off. What the button does NOT do is not claimed anywhere:
// it stops no print that is already running and no direct upload.
test("Stop all queues is offered on the needs-attention card whether Queue Management is on or off; once stopped, Resume takes its place", () => {
  for (const enabled of [true, false]) {
    let r = render(enabled, { storeDegraded: true });
    assert.match(r.html, /id="queueStopAllBtn"/, "enabled=" + enabled);
    assert.doesNotMatch(r.html, /id="queueResumeAllBtn"/);
    assert.deepEqual(r.click("queueStopAllBtn"), ["/api/queue-store/stop-all"], "enabled=" + enabled);
    assert.deepEqual(r.click("queueRetrySaveBtn"), ["/api/queue-store/retry-save"]);
    r = render(enabled, { storeDegraded: true, storeStoppedByAdmin: true });
    assert.deepEqual(r.click("queueResumeAllBtn"), ["/api/queue-store/resume-all"], "enabled=" + enabled);
    assert.match(r.html, /id="queueResumeAllBtn"/, "enabled=" + enabled);
    assert.match(r.html, /id="queueRetrySaveBtn"/);
    assert.doesNotMatch(r.html, /id="queueStopAllBtn"/, "never both");
    r = render(enabled, { storeStoppedByAdmin: true });
    assert.match(r.html, /id="queueResumeAllBtn"/);
    assert.doesNotMatch(r.html, /id="queueStopAllBtn"|id="queueRetrySaveBtn"/);
    // The recovery and unreadable cards carry neither control, as before.
    for (const st of [{ queueStoreRecoveryRequired: true }, { queueStoreRecoveryRequired: true, storeDegraded: true, saveBlocked: "unreadable", saveBlockedDetail: "x" }])
      assert.doesNotMatch(render(enabled, st).html, /id="queueStopAllBtn"/);
  }
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8")).queue;
  assert.doesNotMatch(en.stop_all_queues_button + " " + en.store_stopped_by_admin_line, /print(s|ing)? (is|are|was|were) (stopped|cancel)|cancel/i, "no claim about running prints");
});

test("a queue file that could not be read: the card says so and says what to do, and offers no Reset control (the server would refuse it)", () => {
  for (const enabled of [true, false]) {
    const r = render(enabled, { queueStoreRecoveryRequired: true, storeDegraded: true, saveBlocked: "unreadable", saveBlockedDetail: "queue-data.json could not be read (EACCES) <b>" });
    assert.equal(r.shown, true);
    assert.match(r.html, /queue\.unreadable_title/);
    assert.match(r.html, /queue\.unreadable_body/);
    assert.match(r.html, /queue-data\.json could not be read \(EACCES\) &lt;b>/, "the server's detail, escaped");
    assert.doesNotMatch(r.html, /queueAckResetBtn|queueResetConfirm|queue\.recovery_/);
  }
  // Any other reason recovery is required still offers the Reset.
  assert.match(render(false, { queueStoreRecoveryRequired: true, saveBlocked: null }).html, /id="queueAckResetBtn"/);
});

// ---- What the recovery card says, for each way recovery comes to be required ----
// The statuses below come from the REAL queue store on real temporary
// folders, so the card is tested against what the server actually reports.
const quiet = t => { const o = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; t.after(() => Object.assign(console, o)); };
const VALID = JSON.stringify({ p1: { queueState: "idle", queue: [] } }, null, 2);
function storeWith(t, files, fsImpl) {
  quiet(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-card-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "data"));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(base, "data", n), c);
  const store = createQueueStore({ baseDir: base, degradedRetryMs: 3600000, ...(fsImpl ? { fsImpl } : {}) });
  store.load();
  return store;
}
const REASONS = ["queue.recovery_reason_carried_over", "queue.recovery_reason_no_valid_file", "queue.recovery_reason_general"];
function assertRecoveryCard(html, reason, what) {
  for (const k of REASONS) assert.equal(html.includes(k), k === reason, what + ": " + k);
  assert.match(html, /queue\.recovery_title/, what);
  assert.match(html, /queue\.recovery_explain/, what);
  assert.match(html, /queue\.recovery_reset_warning/, what + ": the destructive warning is always there");
  assert.match(html, /id="queueAckResetBtn"/, what);
  assert.match(html, /class="btn ghost danger" id="queueAckResetBtn"/, what + ": danger role");
  assert.doesNotMatch(html, /queue\.recovery_required_body|queue\.recovery_required_title/, what + ": the old 'both files were unreadable' text is gone");
}

test("recovery carried over by the marker (no queue file was ever looked at as damaged): the card says an earlier recovery or reset was not completed — not that files were unreadable", t => {
  for (const [what, files] of [
    ["marker alone", { "queue-data.json.recovery-required": "{}" }],
    ["marker beside valid queue files (a rollback's, or restored by hand)", { "queue-data.json.recovery-required": "{}", "queue-data.json": VALID, "queue-data.json.bak": VALID }],
    ["marker listing a kept file", { "queue-data.json.recovery-required": JSON.stringify({ files: ["queue-data.json.corrupt-1"] }), "queue-data.json.corrupt-1": "\0\0" }],
  ]) {
    const st = storeWith(t, files).getGlobalStatus();
    assert.deepEqual([st.queueStoreRecoveryRequired, st.recoveryCarriedOver, st.saveBlocked], [true, true, null], what);
    for (const enabled of [true, false]) assertRecoveryCard(render(enabled, st).html, "queue.recovery_reason_carried_over", what);
  }
});

test("no valid queue file at start-up (corrupt primary and backup, or a corrupt primary alone): the card says that, and that the files were kept", t => {
  for (const [what, files] of [
    ["both corrupt", { "queue-data.json": "\0\0\0", "queue-data.json.bak": "{not json" }],
    ["corrupt primary, no backup", { "queue-data.json": "[]" }],
  ]) {
    const st = storeWith(t, files).getGlobalStatus();
    assert.deepEqual([st.queueStoreRecoveryRequired, st.recoveryCarriedOver, st.corruptFilePaths.length > 0], [true, false, true], what);
    assertRecoveryCard(render(false, st).html, "queue.recovery_reason_no_valid_file", what);
  }
});

test("a reset that began and did not finish: the card does not claim damaged or unreadable files, and still warns that a reset is destructive", t => {
  // An ordinary reset of a healthy store, whose second step fails.
  const failing = { ...fs, renameSync(a, b) { if (/before-reset-/.test(path.basename(b))) throw Object.assign(new Error("EIO: simulated"), { code: "EIO" }); return fs.renameSync(a, b); } };
  const store = storeWith(t, { "queue-data.json": VALID, "queue-data.json.bak": VALID }, failing);
  assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, false);
  const r = store.acknowledgeReset("RESET");
  assert.deepEqual([r.ok, r.code], [false, "queue_reset_incomplete"]);
  const st = store.getGlobalStatus();
  assert.deepEqual([st.queueStoreRecoveryRequired, st.recoveryCarriedOver, st.corruptFilePaths.length], [true, false, 0]);
  assertRecoveryCard(render(false, st).html, "queue.recovery_reason_general", "incomplete reset");
});

test("the block reason the server reports is shown, escaped, on the needs-attention card and on the recovery card", t => {
  // Real: a corrupt primary beside a good backup, and the recovery save cannot be written.
  const failing = { ...fs, openSync(p, ...r) { if (path.basename(p) === "queue-data.json.tmp") throw Object.assign(new Error("EROFS: simulated"), { code: "EROFS" }); return fs.openSync(p, ...r); } };
  const st = storeWith(t, { "queue-data.json": "\0\0\0", "queue-data.json.bak": VALID }, failing).getGlobalStatus();
  assert.deepEqual([st.storeDegraded, st.queueStoreRecoveryRequired, st.saveBlocked], [true, false, "corrupt-primary-in-place"]);
  const html = render(false, st).html;
  assert.match(html, /queue\.needs_attention_title/);
  assert.ok(html.includes(st.saveBlockedDetail), "the server's reason: " + st.saveBlockedDetail);
  assert.equal(/[\\/]/.test(st.saveBlockedDetail), false, "no server path in it");
  // Escaped wherever it is shown; absent when there is none.
  for (const base of [{ storeDegraded: true }, { queueStoreRecoveryRequired: true, storeDegraded: true }]) {
    const h = render(true, { ...base, saveBlocked: "leftover-tmp-in-place", saveBlockedDetail: "an unfinished save <img src=x> could not be moved aside (EACCES)" }).html;
    assert.match(h, /an unfinished save &lt;img src=x> could not be moved aside \(EACCES\)/);
    assert.doesNotMatch(h, /<img/);
    assert.doesNotMatch(render(true, base).html, /settings-help warn" style="margin-top:8px"><\/div>/, "no empty line when there is no reason");
  }
});

test("an unreadable queue file keeps its own card (no Reset), also when recovery was carried over", t => {
  if (process.getuid && process.getuid() === 0) return t.skip("root ignores file permissions");
  const unreadable = { ...fs, readFileSync(p, ...r) { if (path.basename(String(p)) === "queue-data.json") throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }); return fs.readFileSync(p, ...r); } };
  for (const files of [{ "queue-data.json": VALID }, { "queue-data.json.recovery-required": "{}", "queue-data.json": VALID }]) {
    const st = storeWith(t, files, unreadable).getGlobalStatus();
    assert.equal(st.saveBlocked, "unreadable");
    const html = render(false, st).html;
    assert.match(html, /queue\.unreadable_title/);
    assert.doesNotMatch(html, /queueAckResetBtn|queue\.recovery_/);
  }
});

test("the card's texts exist in both bundled languages, say what they must and no more, and the bundled version was raised so installs receive them", () => {
  const KEYS = ["unreadable_title", "unreadable_body", "recovery_title", "recovery_reason_carried_over", "recovery_reason_no_valid_file", "recovery_reason_general", "recovery_explain", "recovery_reset_warning"];
  const all = {};
  for (const lang of ["en", "es"]) {
    const loc = all[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", lang + ".json"), "utf8"));
    for (const k of KEYS) assert.ok(loc.queue[k] && loc.queue[k].length > 10, lang + " queue." + k);
    assert.ok(loc._meta.version >= 117, lang);
    // The replaced texts are not shipped any more (a reworded key would never reach an installed language file).
    for (const k of ["recovery_required_title", "recovery_required_body"]) assert.equal(k in loc.queue, false, lang + " queue." + k);
  }
  assert.equal(all.en._meta.version, all.es._meta.version);
  const q = all.en.queue;
  assert.match(q.recovery_reset_warning, /empty/i);
  assert.match(q.recovery_reset_warning, /can't be undone|cannot be undone/i);
  assert.match(q.recovery_reset_warning, /not a required step/i, "a reset is a decision, never a routine step");
  // The general texts do not assert a cause that is only sometimes true.
  for (const k of ["recovery_title", "recovery_reason_general", "recovery_reason_carried_over", "recovery_explain", "recovery_reset_warning"])
    assert.doesNotMatch(q[k], /unreadable|damaged|corrupt|both/i, "en queue." + k);
  // The one start-up reason that does name a cause names only what is true of it: no VALID file — not "unreadable", not "both".
  assert.doesNotMatch(q.recovery_reason_no_valid_file, /unreadable|damaged|both|backup/i);
  assert.match(q.recovery_reason_no_valid_file, /valid/i);
  assert.match(all.es.queue.recovery_reset_warning, /no se puede deshacer/i);
  assert.match(all.es.queue.recovery_reset_warning, /no un paso obligatorio/i);
  // The unreadable card: memory may hold the backup's queue, and a leftover temporary file may have been set aside.
  assert.doesNotMatch(q.unreadable_body, /not loaded|has not loaded|moved/i);
  assert.match(q.unreadable_body, /older copy|backup/i);
});

// The switch's change handler, taken from app.js and run: what the switch
// shows afterwards must be what the SERVER says, whatever was asked for.
const handlerSrc = (() => {
  const at = appSrc.indexOf('$("setQueueEnabled").addEventListener("change", ');
  assert.ok(at > 0);
  const from = appSrc.indexOf("async function(){", at);
  return appSrc.slice(from, appSrc.indexOf("\n  });", from));
})();
async function toggle({ wantOn, answer, serverEnabledAfter, postThrows }) {
  const alerts = [], posted = [];
  const ctx = vm.createContext({
    QUEUE_MANAGEMENT_ENABLED: !wantOn,
    checkAuthFailure: r => r,
    postJSON: async url => { posted.push(url); if (postThrows) throw new Error("network"); return { ok: answer.status < 400, status: answer.status, json: async () => answer.body }; },
    queueErrorText: (d, fallback) => fallback,
    alert: m => alerts.push(m),
  });
  ctx.loadQueueManagementUI = async () => { ctx.QUEUE_MANAGEMENT_ENABLED = serverEnabledAfter; };
  const sw = { checked: wantOn };
  await vm.runInContext("(" + handlerSrc + "})", ctx).call(sw);
  return { checked: sw.checked, alerts, posted };
}

test("the Queue Management switch: a refusal is shown and the switch goes back; a change the server made but could not confirm is shown AND the switch stays where the server is; a lost request puts it back", async () => {
  let r = await toggle({ wantOn: true, answer: { status: 200, body: { ok: true } }, serverEnabledAfter: true });
  assert.deepEqual([r.checked, r.alerts, r.posted], [true, [], ["/api/queue-management/enable"]]);

  r = await toggle({ wantOn: true, answer: { status: 503, body: { error: "The queue can't save changes right now", code: "queue_store_unavailable" } }, serverEnabledAfter: false });
  assert.deepEqual([r.checked, r.alerts], [false, ["The queue can't save changes right now"]]);

  r = await toggle({ wantOn: true, answer: { status: 500, body: { error: "switched on, not confirmed", code: "config_save_not_durable" } }, serverEnabledAfter: true });
  assert.deepEqual([r.checked, r.alerts], [true, ["switched on, not confirmed"]], "the switch shows the server's state, not the opposite of what was asked");

  r = await toggle({ wantOn: false, answer: { status: 500, body: { error: "still on", code: "config_save_failed" } }, serverEnabledAfter: true });
  assert.deepEqual([r.checked, r.alerts, r.posted], [true, ["still on"], ["/api/queue-management/disable"]]);

  r = await toggle({ wantOn: true, postThrows: true });
  assert.deepEqual([r.checked, r.alerts], [false, ["network"]]);
});

test("the retry action shows the server's text for a failed retry", () => {
  const at = appSrc.indexOf("async function queueStoreAction(url){");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}\n", at));
  assert.match(fn, /if\(!r\.ok\|\|d\.error\|\|d\.ok===false\) throw new Error\(queueErrorText\(d,typeof d\.error==="string"\?d\.error:\("HTTP "\+r\.status\)\)\)/, "never an object turned into text");
});

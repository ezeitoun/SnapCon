// test/deferredSendsPage.test.js — what a card shows for the sends waiting for
// its printer (docs/TODO.md §37 P3), from public/app.js's own functions, with
// t() returning the key and its parameters.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function extractFn(name) {
  const a = appSrc.indexOf("async function " + name + "(");
  const at = a >= 0 ? a : appSrc.indexOf("function " + name + "(");
  assert.ok(at >= 0, name);
  return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
}
const block = start => { const at = appSrc.indexOf(start); assert.ok(at >= 0, start); return appSrc.slice(at, appSrc.indexOf("\n};", at) + 3); };
function page({ canAct = true, confirmAnswer = true } = {}) {
  const asked = [], posted = [], status = [];
  const ctx = {
    Map, String, Math, Number, Object, Date, encodeURIComponent,
    t: (k, p) => k + (p ? "(" + Object.entries(p).map(([a, b]) => a + "=" + b).join(",") + ")" : ""),
    // The page's own esc().
    esc: s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    canAct: () => canAct, isAdmin: () => true,
    confirm: q => { asked.push(q); return confirmAnswer; },
    postJSON: async (url, body) => { posted.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, state: "queued" }) }; },
    setCardStatus: (id, cls, txt) => status.push([cls, txt]), loadFleet: () => {}, loadDeferredNotice: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext([block("const PENDING_ATTENTION_KEYS={"), ...["pendingSince", "pendingSendRowHtml", "pendingSendsHtml", "deferredAction"].map(extractFn)].join("\n"), ctx);
  ctx.deferredNoticeSay = (cls, txt) => status.push(["notice:" + cls, txt]);
  return { ctx, asked, posted, status, call: (n, ...a) => vm.runInContext(n, ctx)(...a) };
}
const P = { id: 3, name: "U1 Navy" };
const send = o => ({ id: "dsend_1", name: "Part.gcode", state: "queued", createdAt: Date.now(), ...o });

test("each state reads as itself, with only the actions it allows; one being sent is the upload strip's, not a row", () => {
  const h = page();
  const row = s => h.call("pendingSendsHtml", { ...P, pendingSends: [send(s)] });
  const actions = html => [...html.matchAll(/data-deferred-action="([^"]+)"/g)].map(m => m[1]);
  assert.match(row({}), /fleet\.pending\.queued\(name=Part\.gcode,since=/);
  assert.deepEqual(actions(row({})), ["cancel"]);
  assert.deepEqual(actions(row({ state: "interrupted" })), ["cancel"], "while it is reconciled: no Send again yet");
  for (const [reason, key] of [["unknown-after-upload", "attention_unknown"], ["interrupted-not-on-printer", "attention_not_on_printer"], ["interrupted-different-on-printer", "attention_different"],
    ["interrupted-listed-by-name", "attention_listed_by_name"], ["restored-from-backup", "attention_restored"], ["something-new", "attention_generic"]]) {
    const html = row({ state: "attention", reason });
    assert.match(html, new RegExp("fleet\\.pending\\." + key + "\\(name=Part\\.gcode\\)"), reason);
    assert.deepEqual(actions(html), ["send-again", "check", "cancel"], reason);
  }
  assert.deepEqual(actions(row({ state: "failed", error: "x" })), ["send-again", "dismiss"]);
  assert.deepEqual(actions(row({ state: "failed", error: "x", code: "DEFERRED_SOURCE_CHANGED" })), ["dismiss"], "a changed source would fail again every time");
  assert.deepEqual(actions(row({ state: "cancelled" })), ["dismiss"]);
  assert.match(row({ state: "uploading" }), /fleet\.pending\.sending/, "getting ready: no strip yet, so the row says so");
  assert.equal(h.call("pendingSendsHtml", { ...P, upload: { jobId: "j" }, pendingSends: [send({ state: "uploading" })] }), "", "going out: the upload strip shows it");
  assert.equal(row({ state: "completed" }), "");
  assert.equal(h.call("pendingSendsHtml", P), "");
});

test("in order, file names kept whole with their extension, and a view-only user sees why the buttons are off", () => {
  const h = page({ canAct: false });
  const html = h.call("pendingSendsHtml", { ...P, pendingSends: [send({ id: "a", name: "First <v2>.gcode" }), send({ id: "b", name: "Second.3mf" })] });
  assert.ok(html.indexOf("First &lt;v2&gt;.gcode") < html.indexOf("Second.3mf"));
  assert.match(html, /title="First &lt;v2&gt;\.gcode"/);
  assert.match(html, /disabled title="fleet\.queued\.staged_view_only_title"/);
});

test("Send again and Cancel name what they affect and ask first; declining sends nothing", async () => {
  const no = page({ confirmAnswer: false });
  await no.call("deferredAction", "send-again", "dsend_1", "Part.gcode", "U1 Navy", 3, { disabled: false, isConnected: true });
  await no.call("deferredAction", "cancel", "dsend_1", "Part.gcode", "U1 Navy", 3, { disabled: false, isConnected: true });
  assert.deepEqual(no.asked, ["fleet.pending.send_again_confirm(name=Part.gcode,printer=U1 Navy)", "fleet.pending.cancel_confirm(name=Part.gcode,printer=U1 Navy)"]);
  assert.deepEqual(no.posted, []);
  const yes = page();
  await yes.call("deferredAction", "send-again", "dsend 1", "Part.gcode", "U1 Navy", 3, { disabled: false, isConnected: true });
  assert.deepEqual(yes.posted, ["/api/deferred/dsend%201/send-again"]);
  await yes.call("deferredAction", "check", "dsend_1", "Part.gcode", "U1 Navy", 3, { disabled: false, isConnected: true });
  assert.equal(yes.asked.length, 1, "Check again does not ask: it only reads the printer");
});

test("the card redraws when its waiting sends change, and the old single 'queued' banner gives way to the list", () => {
  assert.match(extractFn("cardSignature"), /pendingSends:p\.pendingSends\|\|null/);
  assert.match(extractFn("queuedFileBannerHtml"), /if\(qf\.status==='queued'\) return p\.pendingSends&&p\.pendingSends\.length \? '' :/);
});

test("the printer accepted it but the read-back did not confirm it reads differently from no answer at all", () => {
  const h = page();
  const row = s => h.call("pendingSendsHtml", { ...P, pendingSends: [send(s)] });
  for (const errorReason of ["not-on-printer", "verify-unreadable"]) {
    assert.match(row({ state: "attention", reason: "unknown-after-upload", errorReason }), /fleet\.pending\.attention_unchecked/, errorReason);
  }
  // The file on this computer, not the printer's copy (§37 A4).
  assert.match(row({ state: "attention", reason: "unknown-after-upload", errorReason: "local-changed" }), /fleet\.pending\.attention_local_changed/);
  assert.match(row({ state: "attention", reason: "unknown-after-upload", errorReason: "local-unreadable" }), /fleet\.pending\.attention_local_unreadable/);
  assert.match(row({ state: "attention", reason: "source-changed" }), /fleet\.pending\.attention_local_changed/);
  assert.match(row({ state: "attention", reason: "unknown-after-upload", errorReason: "timeout" }), /fleet\.pending\.attention_unknown/);
});

test("a cancelled send says whether it reached the printer", () => {
  const h = page();
  const row = o => h.call("pendingSendsHtml", { ...P, pendingSends: [send({ state: "cancelled", ...o })] });
  assert.match(row({ outcome: "not-sent" }), /cancelled_not_sent/);
  assert.match(row({ outcome: "sent" }), /cancelled_sent/);
  assert.match(row({ outcome: "unknown" }), /cancelled_unknown/);
});

test("a removed printer's send can only be cancelled or dismissed, says so, and its errors are shown", async () => {
  const h = page();
  const html = h.call("pendingSendRowHtml", { id: null, name: "Old U1" }, send({ state: "attention", reason: "unknown-after-upload" }), { removed: true });
  assert.deepEqual([...html.matchAll(/data-deferred-action="([^"]+)"/g)].map(m => m[1]), ["cancel"]);
  assert.match(html, /fleet\.pending\.removed_printer\(printer=Old U1\)/);
  assert.match(h.call("pendingSendRowHtml", { id: null, name: "Old U1" }, send({ state: "queued" }), { removed: true }), /fleet\.pending\.queued_removed/);
  h.ctx.postJSON = async () => ({ ok: false, status: 503, json: async () => ({ error: "Could not be saved." }) });
  await h.call("deferredAction", "dismiss", "dsend_1", "Part.gcode", "Old U1", null, { disabled: false, isConnected: true });
  assert.deepEqual(h.status.pop(), ["notice:pstatus err", "Could not be saved."]);
});

test("a send waiting for its folder says so", () => {
  const h = page();
  assert.match(h.call("pendingSendsHtml", { ...P, pendingSends: [send({ waitingFor: "source" })] }), /fleet\.pending\.queued_source/);
});

test("a send restored from a backup whose transfer already finished says so, and can only be dismissed (§37 P4)", () => {
  const h = page();
  const html = h.call("pendingSendsHtml", { ...P, pendingSends: [send({ state: "attention", reason: "restored-from-backup", finished: "verified" })] });
  assert.match(html, /fleet\.pending\.already_finished\(name=Part\.gcode,result=fleet\.pending\.result_verified\)/);
  assert.deepEqual([...html.matchAll(/data-deferred-action="([^"]+)"/g)].map(m => m[1]), ["dismiss"]);
});

test("a restored send a later attempt already delivered says so, and can only be dismissed", () => {
  const h = page();
  for (const state of ["failed", "cancelled", "attention"]) {
    const html = h.call("pendingSendsHtml", { ...P, pendingSends: [send({ state, finished: "verified", finishedLater: true })] });
    assert.match(html, /fleet\.pending\.already_delivered_later\(name=Part\.gcode,result=fleet\.pending\.result_verified\)/, state);
    assert.deepEqual([...html.matchAll(/data-deferred-action="([^"]+)"/g)].map(m => m[1]), ["dismiss"], state);
  }
});

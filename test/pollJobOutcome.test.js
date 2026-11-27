// test/pollJobOutcome.test.js — what the page shows while a transfer is
// confirming, when it ends unknown, when it was cancelled while confirming,
// when SnapCon cannot be reached and when the job is no longer known
// (docs/TODO.md §37 P1).
//
// Before: the page knew only "uploading", done or error: an unknown upload was
// a red failure, a job the server no longer knew was "No such job" in red, a
// SnapCon that could not be reached was polled silently forever, and the bar
// reached 100% before the printer had said anything.
//
// pollJob and what it calls are taken from public/app.js and run against a
// scripted /api/print-status, a fake clock, and the real English and Spanish
// strings.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const locale = l => JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", l + ".json"), "utf8"));
function extractFn(name) {
  const a = appSrc.indexOf("async function " + name + "(");
  const at = a >= 0 ? a : appSrc.indexOf("function " + name + "(");
  assert.ok(at >= 0, name + " must exist in public/app.js");
  return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
}
const oneLine = start => { const at = appSrc.indexOf(start); assert.ok(at >= 0, start); return appSrc.slice(at, appSrc.indexOf("\n", at)); };
const block = start => { const at = appSrc.indexOf(start); assert.ok(at >= 0, start); return appSrc.slice(at, appSrc.indexOf("\n};", at) + 3); };

// answers: a list of /api/print-status answers, or functions of the call
// number; "down" throws like a fetch to a SnapCon that is not there.
function harness(answers, { lang = "en", printer = "U1 Navy" } = {}) {
  const strings = locale(lang);
  const get = k => k.split(".").reduce((o, p) => o && o[p], strings);
  const fill = (s, params) => String(s).replace(/\{(\w+)\}/g, (_, k) => (params && k in params ? params[k] : "{" + k + "}"));
  let clock = 1000000, n = 0;
  const h = { card: [], rows: [], fills: [] };
  const ctx = {
    t: (k, params) => { const v = get(k); assert.equal(typeof v, "string", "missing string " + k); return fill(v, params); },
    tn: (k, c, params) => fill(get(k + (c === 1 ? "_one" : "_other")), params),
    Date: { now: () => clock }, Math, Object, String, Number, Promise, Map, Set,
    setTimeout: (fn, ms) => { clock += ms || 0; Promise.resolve().then(fn); return 0; },
    FLEET: [{ id: 3, name: printer, state: "standby" }],
    STATUS_OVERRIDE: new Map(), UPLOADS: new Map(), UPLOAD_ENDED: new Map(), UPLOAD_CANCEL: new Map(),
    renderFleet: () => {}, document: { querySelector: () => null },
    getJSON: async () => {
      const a = answers[Math.min(n, answers.length - 1)]; n++;
      const d = typeof a === "function" ? a(n, clock) : a;
      if (d === "down") throw new TypeError("Failed to fetch");
      return d;
    },
  };
  vm.createContext(ctx);
  vm.runInContext([block("const UPLOAD_FAILURE_REASONS = {"), oneLine("const UPLOAD_UNCONFIRMED_REASONS = "),
    ...["uploadPct", "uploadFailureReason", "makePhaseOverride", "setUploadCancel", "setUploadState", "patchUploadProgress", "paintUploadProgress",
      "setRowUI", "setRowCancel", "mappingPhaseText", "mappingPhaseBadge", "sendSummaryText", "queueAttentionDetailText", "uploadedText", "pollJob"].map(extractFn)].join("\n"), ctx);
  const row = { statusEl: { className: "", textContent: "" }, fillEl: { className: "", style: { width: "" } }, noRowCancel: true };
  h.ctx = ctx;
  h.row = row;
  h.clock = () => clock;
  h.run = async ({ start = true } = {}) => {
    ctx.UPLOADS.set("3", { state: "uploading", origin: "local", jobId: "j1", name: "part.gcode", pct: 0, sent: 0, total: 0 });
    const statusLog = [];
    const result = await ctx.pollJob("j1", (cls, txt) => { statusLog.push({ cls, txt }); h.card.push({ cls, txt }); }, start, 0, pct => h.fills.push(pct),
      { ...row, onJob: d => { h.rows.push({ phase: d.phase, cls: row.statusEl.className, txt: row.statusEl.textContent, width: row.fillEl.style.width }); } }, {}, 3);
    return { result, strip: ctx.UPLOADS.get("3"), status: statusLog[statusLog.length - 1], row: { cls: row.statusEl.className, txt: row.statusEl.textContent, width: row.fillEl.style.width } };
  };
  return h;
}
const st = o => ({ phase: "upload", sent: 50, total: 100, done: false, error: null, cancellable: true, cancelled: false, outcome: null, startCancelled: false, ...o });
const confirming = o => st({ phase: "confirming", sent: 100, total: 100, confirmingMs: 1000, ...o });

test("while sending, the bar never reaches 100%; confirming is held at 99% and says it waits for the printer", async () => {
  const seen = [];
  const h = harness([st({ sent: 100, total: 100 }), confirming(), st({ phase: "done", done: true, cancellable: false, outcome: "sent", result: { printer: "U1 Navy" } })]);
  const orig = h.ctx.setRowUI;
  h.ctx.setRowUI = (ui, pct, cls, txt) => { seen.push({ pct, cls, txt }); orig(ui, pct, cls, txt); };
  const r = await h.run({ start: false });
  assert.equal(r.result, true);
  assert.deepEqual(seen[0], { pct: 99, cls: "work", txt: "Uploading 99%" }, "all bytes handed over is still 99%");
  assert.deepEqual(seen[1], { pct: 99, cls: "work", txt: "Confirming…" });
  assert.ok(h.fills.every(p => p === null || p <= 99), "the button never shows a finished transfer before the answer");
});

test("unknown: neither sent nor failed — amber, the reason, not started, check the printer; the strip has Dismiss only", async () => {
  const h = harness([confirming(), st({ phase: "error", done: true, cancellable: false, error: "x", errorCode: "UPLOAD_UNCONFIRMED", failedPhase: "upload", outcome: "unknown", errorReason: "timeout", errorSeconds: 120 })]);
  const r = await h.run({ start: true });
  assert.equal(r.result, "unconfirmed");
  assert.deepEqual(r.row, { cls: "send-status-txt warn", txt: "Not confirmed", width: "99%" });
  assert.equal(r.strip.state, "unconfirmed", "the card's strip carries it, as for a failed upload");
  assert.equal(r.strip.reason, "Everything was sent, but the printer didn’t confirm it within 120 s. The print wasn’t started. Check U1 Navy before sending it again.");
  assert.notEqual(r.status && r.status.cls, "pstatus ok");
});

test("unknown, in Spanish", async () => {
  const h = harness([st({ phase: "error", done: true, cancellable: false, error: "x", errorCode: "UPLOAD_UNCONFIRMED", failedPhase: "upload", outcome: "unknown", errorReason: "connection-lost" })], { lang: "es" });
  const r = await h.run({ start: false });
  assert.equal(r.result, "unconfirmed");
  assert.equal(r.strip.reason, "Se envió todo, pero se perdió la conexión antes de que la impresora lo confirmara. Comprueba U1 Navy antes de volver a enviarlo.");
  assert.equal(r.row.txt, "Sin confirmar");
});

test("cancelled while confirming: says at once that the print start was cancelled and that the answer is awaited; then what the printer said", async () => {
  const h = harness([confirming(), confirming({ startCancelled: true, cancellable: false, cancelled: false }),
    st({ phase: "error", done: true, cancellable: false, error: "Cancelled.", errorCode: "UPLOAD_CANCELLED", failedPhase: "upload", cancelled: true, outcome: "sent", startCancelled: true })]);
  const seen = [];
  const orig = h.ctx.setRowUI;
  h.ctx.setRowUI = (ui, pct, cls, txt) => { seen.push({ pct, cls, txt }); orig(ui, pct, cls, txt); };
  const r = await h.run({ start: true });
  assert.deepEqual(seen[1], { pct: 99, cls: "", txt: "Print start cancelled. Waiting for U1 Navy to say whether it received the file." },
    "shown on the first answer after the cancel, neutral, while the printer's answer is awaited");
  assert.equal(r.result, false, "a cancel is never counted as sent");
  assert.equal(r.status.cls, "pstatus", "neutral: not green, not red");
  assert.equal(r.status.txt, "Print start cancelled. U1 Navy confirmed it received the file; it wasn’t started.");
  assert.equal(r.strip, undefined);
});

test("cancelled while confirming and no answer: unknown, in Spanish", async () => {
  const h = harness([confirming({ startCancelled: true, cancellable: false }),
    st({ phase: "error", done: true, cancellable: false, error: "x", errorCode: "UPLOAD_UNCONFIRMED", failedPhase: "upload", cancelled: true, outcome: "unknown", startCancelled: true, errorReason: "timeout", errorSeconds: 120 })], { lang: "es" });
  const r = await h.run({ start: true });
  assert.equal(r.result, "unconfirmed");
  assert.equal(r.strip.state, "unconfirmed");
  assert.equal(r.strip.reason, "Inicio de impresión cancelado. SnapCon no pudo saber si U1 Navy recibió el archivo.");
});

test("a job SnapCon no longer knows is not a failure: it says it can't tell, and whether SnapCon restarted", async () => {
  const gone = (startedAt) => ({ error: "No such job", code: "job_unknown", serverStartedAt: startedAt });
  {
    const h = harness([st(), gone(0)]);
    const r = await h.run();
    assert.equal(r.result, "unconfirmed");
    assert.equal(r.strip.state, "unconfirmed");
    assert.equal(r.strip.reason, "SnapCon lost track of this job, so it can’t tell how it ended. Check the printer.");
  }
  {
    const h = harness([st(), (n, now) => gone(now + 1)], { lang: "es" });
    const r = await h.run();
    assert.equal(r.strip.reason, "SnapCon se reinició mientras este trabajo estaba en curso y no puede saber cómo terminó. Comprueba la impresora.");
  }
});

test("a job missing once is asked again before anything is said (the result is recovered when the server has it)", async () => {
  const h = harness([st(), { error: "No such job", code: "job_unknown", serverStartedAt: 0 }, st({ phase: "done", done: true, outcome: "sent", cancellable: false, result: { printer: "U1 Navy" } })]);
  const r = await h.run({ start: false });
  assert.equal(r.result, true);
});

test("SnapCon out of reach: said after 10 s, never a failure, and the real result is picked up when it answers again", async () => {
  let downUntil = null;
  const h = harness([st(), (n, now) => { if (downUntil == null) downUntil = now + 20000; return now < downUntil ? "down" : st({ phase: "done", done: true, outcome: "sent", cancellable: false, result: { printer: "U1 Navy" } }); }]);
  const r = await h.run({ start: false });
  assert.ok(h.card.some(c => c.cls === "pstatus warn" && c.txt === "Can’t reach SnapCon. The transfer carries on there; this page will catch up."), JSON.stringify(h.card));
  assert.equal(r.result, true);
  assert.equal(r.status.cls, "pstatus ok");
});

test("a failed transfer stays a failure; the 5M / 5M Pro screen message is mentioned when SnapCon cut the upload off", async () => {
  const h = harness([st({ phase: "error", done: true, cancellable: false, error: "x", errorCode: "UPLOAD_STALLED", failedPhase: "upload", outcome: "failed", errorSeconds: 60, printerPrompt: true })]);
  const r = await h.run({ start: true });
  assert.equal(r.result, false);
  assert.equal(r.strip.state, "failed");
  assert.equal(r.strip.reason, "The printer stopped accepting data for 60 s. The printer may show “failed to download model” on its screen. Dismiss it there.");
  assert.equal(r.row.txt, r.strip.reason, "the Send row says the same, not the server's English");
});

test("a failed transfer's row is in the reader's language", async () => {
  const h = harness([st({ phase: "error", done: true, cancellable: false, error: "The printer stopped accepting data for 10 s", errorCode: "UPLOAD_STALLED", failedPhase: "upload", outcome: "failed", errorSeconds: 10 })], { lang: "es" });
  const r = await h.run({ start: false });
  assert.deepEqual(r.row, { cls: "send-status-txt err", txt: "La impresora dejó de aceptar datos durante 10 s", width: "100%" });
});

test("the Send summary counts not confirmed apart: never sent, never failed, no Done", () => {
  const en = harness([]), es = harness([], { lang: "es" });
  assert.equal(en.ctx.sendSummaryText([true, "unconfirmed"]), "1 sent, 1 not confirmed.");
  assert.equal(en.ctx.sendSummaryText(["unconfirmed", "unconfirmed", false]), "Finished with errors — 2 not confirmed, 1 failed.");
  assert.equal(en.ctx.sendSummaryText([true, "waiting", "unconfirmed"]), "1 sent, 1 waiting to be sent, 1 not confirmed.");
  assert.equal(es.ctx.sendSummaryText([true, "unconfirmed", "unconfirmed"]), "1 enviado, 2 sin confirmar.");
});

test("queue attention for a transfer, in English and Spanish, from its code and parts; anything else keeps the server's message", () => {
  const en = harness([]), es = harness([], { lang: "es" });
  const unc = { code: "upload-unconfirmed", message: "server text", file: "Beardie.gcode", reason: "timeout", seconds: 120, uploadOutcome: "unknown" };
  assert.equal(en.ctx.queueAttentionDetailText(unc), "Everything was sent, but the printer didn’t confirm it within 120 s. Beardie.gcode wasn’t started, and SnapCon can’t tell whether the printer has it.");
  assert.equal(es.ctx.queueAttentionDetailText(unc), "Se envió todo, pero la impresora no lo confirmó en 120 s. Beardie.gcode no se inició y SnapCon no puede saber si la impresora lo tiene.");
  assert.equal(en.ctx.queueAttentionDetailText({ code: "upload-stalled", file: "B.gcode", seconds: 60 }), "The printer stopped accepting data for 60 s: B.gcode wasn’t sent completely.");
  assert.equal(es.ctx.queueAttentionDetailText({ code: "upload-connect-timeout", file: "B.gcode", seconds: 10 }), "No se pudo conectar con la impresora en 10 s: B.gcode no se envió.");
  assert.equal(en.ctx.queueAttentionDetailText({ code: "upload-cancelled", uploadOutcome: "sent", file: "B.gcode", by: "Eran Z" }), "Cancelled by Eran Z after B.gcode reached the printer, which confirmed it. It wasn’t started.");
  assert.equal(es.ctx.queueAttentionDetailText({ code: "upload-cancelled", uploadOutcome: "unknown", file: "B.gcode" }), "Cancelado mientras la impresora confirmaba B.gcode. SnapCon no pudo saber si recibió el archivo. No se inició.");
  assert.equal(en.ctx.queueAttentionDetailText({ code: "upload-cancelled", message: "Upload cancelled by X before it finished: B.gcode" }), "Upload cancelled by X before it finished: B.gcode");
  assert.equal(en.ctx.queueAttentionDetailText({ code: "dispatch-error", message: "raw" }), "raw");
  assert.equal(en.ctx.queueAttentionDetailText(null), "");
});

test("every caller treats only true as success: an unconfirmed result never closes a dialog or claims a print", () => {
  assert.match(appSrc, /if\(ok===true\) st\("pstatus ok", t\("fleet\.queued\.printing_status"/);
  assert.match(appSrc, /if\(ok===true\) setTimeout\(\(\)=>\{ closePrinterFiles\(\); loadFleet\(\); \},900\);/);
  assert.match(appSrc, /if\(ok===true && QP_PRINTER===printer\) closeQuickPrintModal\(\);/);
  assert.match(appSrc, /if\(ok!==true && mine\(\)\)\{/);
});

test("without a strip (a staged-file start), the card's own line says it, in amber", async () => {
  const h = harness([{ error: "No such job", code: "job_unknown", serverStartedAt: 0 }]);
  h.ctx.UPLOADS.clear();
  const statusLog = [];
  const result = await h.ctx.pollJob("j9", (cls, txt) => statusLog.push({ cls, txt }), true, 0, null, null, {}, 3);
  assert.equal(result, "unconfirmed");
  assert.deepEqual(statusLog[statusLog.length - 1], { cls: "pstatus warn", txt: "SnapCon lost track of this job, so it can’t tell how it ended. Check the printer." });
});

// ---- §37 P2: the printer's copy read back ----
const verifying = o => st({ phase: "verifying", sent: 100, total: 100, cancellable: false, outcome: "sent", ...o });
const ended = o => st({ phase: "done", done: true, cancellable: false, outcome: "sent", ...o });

test("P2: while the printer's copy is checked the page says so; an upload then reads by what was found", async () => {
  for (const [verification, want] of [["verified", "Verified on U1 Navy (size and sampled content)"], ["acknowledged", "Sent — U1 Navy lists it"], [null, "Uploaded"]]) {
    const h = harness([verifying(), ended({ result: { printer: "U1 Navy", verification } })]);
    let seen;
    const orig = h.ctx.setUploadState;
    h.ctx.setUploadState = (id, e) => { if (e && e.verifying) seen = e; orig(id, e); };
    const r = await h.run({ start: false });
    assert.equal(r.result, true);
    assert.ok(seen && seen.state === "uploading" && seen.cancellable === false, "the strip says it is checking, with nothing to cancel");
    assert.ok(!h.card.some(c => /Checking the file/.test(c.txt)), "with a strip, the card's own line is left alone, as while confirming");
    assert.ok(h.rows.some(x => x.phase === "verifying"));
    assert.equal(r.status.txt, want, verification);
    assert.equal(r.row.txt, want);
  }
});

test("P2: accepted but not on the printer is not confirmed, saying why, in English and Spanish; Unknown is never a success", async () => {
  for (const [lang, absent, unchecked] of [["en", /isn’t in the printer’s file list/, /couldn’t check the printer’s copy/], ["es", /no aparece en su lista de archivos/, /no pudo comprobar la copia/]]) {
    for (const [reason, re] of [["not-on-printer", absent], ["verify-unreadable", unchecked]]) {
      const h = harness([verifying(), ended({ phase: "error", error: "x", outcome: "unknown", errorCode: "UPLOAD_UNCONFIRMED", errorReason: reason, failedPhase: "verifying" })], { lang });
      const r = await h.run({ start: true });
      assert.equal(r.result, "unconfirmed", lang + " " + reason);
      assert.ok(!h.card.some(c => /Checking the file|Comprobando el archivo/.test(c.txt)), "no 'checking' line is left behind");
      assert.equal(r.strip.state, "unconfirmed");
      assert.match(r.strip.reason, re, lang + " " + reason);
    }
  }
});

test("P2: other content under the name is a failure on the strip, in plain words", async () => {
  const h = harness([verifying(), ended({ phase: "error", error: "U1 Navy accepted part.gcode, but…", outcome: "failed", errorCode: "UPLOAD_MISMATCH", failedPhase: "verifying" })]);
  const r = await h.run({ start: true });
  assert.equal(r.result, false);
  assert.equal(r.strip.state, "failed");
  assert.equal(r.strip.reason, "The printer holds a different file under this name");
  assert.equal(r.strip.mismatch, true, "titled as a mismatch, not as an upload that stopped");
});

test("P2: the queue's attention says so for a mismatch and for a file the printer does not list", () => {
  const h = harness([]);
  assert.equal(h.ctx.queueAttentionDetailText({ code: "upload-mismatch", file: "Beardie.gcode", message: "x" }), "The printer holds a different file under the name Beardie.gcode, so it wasn’t started.");
  assert.match(h.ctx.queueAttentionDetailText({ code: "upload-unconfirmed", file: "Beardie.gcode", reason: "not-on-printer", message: "x" }), /isn’t in the printer’s file list\. Beardie\.gcode wasn’t started/);
});

test("P2: without a strip (another path), the card's own line says the copy is being checked", async () => {
  const h = harness([verifying(), ended({ result: { printer: "U1 Navy", verification: "verified" } })]);
  const orig = h.ctx.pollJob;
  h.ctx.UPLOADS.clear();
  const result = await orig("j1", (cls, txt) => h.card.push({ cls, txt }), false, 0, () => {}, null, {}, 3);
  assert.equal(result, true);
  assert.ok(h.card.some(c => c.txt === "Checking the file on U1 Navy…"));
});

test("P2: an item uploaded earlier and gone, and a local file changed while sent, each say so", async () => {
  for (const [reason, re] of [["gone-from-printer", /uploaded earlier, but it’s no longer in the printer’s file list/], ["local-changed", /changed on this computer while it was being sent/]]) {
    const h = harness([verifying(), ended({ phase: "error", error: "x", outcome: "unknown", errorCode: "UPLOAD_UNCONFIRMED", errorReason: reason, failedPhase: "verifying" })]);
    const r = await h.run({ start: true });
    assert.equal(r.result, "unconfirmed");
    assert.match(r.strip.reason, re, reason);
  }
});

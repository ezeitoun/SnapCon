// test/sendWaitingResult.test.js — a file SnapCon accepted but has not sent
// is "waiting", never "sent" (docs/TODO.md §37 P0-1).
//
// Before: /api/print answers {ok:true, mode:"queued"} (no job id) when an
// Upload to a busy pooled printer becomes a queue item. pushTo accepted only
// "pending", so it threw "HTTP 200": the card showed an error, the Send row
// went red and the summary said "Finished with errors", although the queue
// item had been created. And a "pending" file (held until the printer is free)
// was shown green and counted as succeeded, though nothing had been sent.
//
// pushTo and the summary are taken from public/app.js and run with the real
// English and Spanish strings.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const locale = l => JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", l + ".json"), "utf8"));

function extractFn(name, prefix = "function ") {
  const start = appSrc.indexOf(prefix + name + "(");
  assert.ok(start >= 0, name + " must exist in public/app.js");
  return appSrc.slice(start, appSrc.indexOf("\n}", start) + 2);
}

function harness(reply, { lang = "en", status = 200 } = {}) {
  const strings = locale(lang);
  const get = k => k.split(".").reduce((o, p) => o && o[p], strings);
  const fill = (s, params) => String(s).replace(/\{(\w+)\}/g, (_, k) => (params && k in params ? params[k] : "{" + k + "}"));
  const h = { card: [], posted: [] };
  const ctx = {
    t: (k, params) => { const v = get(k); assert.equal(typeof v, "string", "missing string " + k); return fill(v, params); },
    tn: (k, n, params) => { const v = get(k + (n === 1 ? "_one" : "_other")); assert.equal(typeof v, "string", "missing string " + k); return fill(v, params); },
    SELECTED: "part.gcode", MAPSEL: {}, ALLOW_MAPPING: false, SEND_SOURCE: null, MAP: null,
    neededColorsOrSlot: () => [],
    setCardStatus: (printer, cls, txt) => h.card.push({ cls, txt }),
    setSendFill: () => {}, setUploadState: () => {}, loadFleet: () => {},
    checkAuthFailure: r => r,
    postJSON: async (url, body) => { h.posted.push(body); return { ok: status < 300, status, json: async () => reply }; },
    pollJob: async () => true,
    Math, Object, String, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext("var PUSHES=0;", ctx);
  for (const name of ["setRowUI", "sendSummaryText"]) vm.runInContext(extractFn(name), ctx);
  vm.runInContext(extractFn("pushTo", "async function "), ctx);
  const row = () => ({ statusEl: { className: "", textContent: "" }, fillEl: { className: "", style: { width: "" } } });
  h.push = async () => { const r = row(); const result = await ctx.pushTo("pr1", false, r); return { result, row: r }; };
  h.summary = results => ctx.sendSummaryText(results);
  return h;
}

test("an Upload that became a queue item is waiting, not an error and not sent", async () => {
  const h = harness({ ok: true, mode: "queued", printer: "U1 Navy" });
  const { result, row } = await h.push();
  assert.equal(result, "waiting");
  const last = h.card[h.card.length - 1];
  assert.equal(last.cls, "pstatus", "neutral: neither ok (green) nor err");
  assert.equal(last.txt, "Added to U1 Navy's queue — it will be sent when the queue dispatches it");
  assert.equal(row.statusEl.className, "send-status-txt", "the row is neutral too");
  assert.equal(row.statusEl.textContent, "In queue");
  assert.equal(row.fillEl.style.width, "0%", "and not drawn as a finished transfer");
  assert.equal(row.fillEl.className, "send-row-fill");
});

test("a file held until the printer is free is waiting, shown neutral rather than green", async () => {
  const h = harness({ ok: true, mode: "pending", printer: "U1 Navy" });
  const { result, row } = await h.push();
  assert.equal(result, "waiting");
  const last = h.card[h.card.length - 1];
  assert.equal(last.cls, "pstatus");
  assert.equal(last.txt, "Queued — will upload once idle");
  assert.equal(row.statusEl.className, "send-status-txt");
  assert.equal(row.statusEl.textContent, "Queued");
});

test("an upload that reported success is sent; one that failed is failed", async () => {
  assert.equal((await harness({ jobId: "j1" }).push()).result, true);
  const bad = harness({ error: "Printer refused" }, { status: 409 });
  const { result, row } = await bad.push();
  assert.equal(result, false);
  assert.equal(row.statusEl.className, "send-status-txt err");
  // A reply that is neither a job nor an accepted-not-sent mode is still an error.
  assert.equal((await harness({ ok: true, mode: "something-else" }).push()).result, false);
});

test("the summary counts sent, waiting and failed apart; waiting is never sent", () => {
  const h = harness({});
  assert.equal(h.summary([true, true, true, "waiting", "waiting", false]), "Finished with errors — 3 sent, 2 waiting to be sent, 1 failed.");
  assert.equal(h.summary([true, true]), "Done — 2 sent.", "Done only when every file was sent");
  assert.equal(h.summary([true, "waiting"]), "1 sent, 1 waiting to be sent.", "no Done while one is still waiting");
  assert.equal(h.summary(["waiting", "waiting"]), "2 waiting to be sent.", "nothing sent: no Done and no \"0 sent\"");
  assert.equal(h.summary([false, "waiting"]), "Finished with errors — 1 waiting to be sent, 1 failed.");
  assert.equal(h.summary([false, false]), "Finished with errors — 2 failed.");
  for (const r of [[true, "waiting"], ["waiting"], [true, true, "waiting"]]) assert.doesNotMatch(h.summary(r), /Done/);
});

test("the summary in Spanish, with singular and plural", () => {
  const h = harness({}, { lang: "es" });
  assert.equal(h.summary([true, "waiting", false]), "Terminado con errores — 1 enviado, 1 en espera de envío, 1 con error.");
  assert.equal(h.summary([true, true, "waiting"]), "2 enviados, 1 en espera de envío.");
  assert.equal(h.summary(["waiting"]), "1 en espera de envío.");
  assert.equal(h.summary([true, true]), "Listo — 2 enviados.");
});

test("a mixed batch through pushTo: the dialog's result comes from what each printer reported", async () => {
  const results = [];
  for (const reply of [{ jobId: "j1" }, { ok: true, mode: "queued", printer: "A" }, { ok: true, mode: "pending", printer: "B" }]) {
    results.push((await harness(reply).push()).result);
  }
  results.push((await harness({ error: "x" }, { status: 502 }).push()).result);
  assert.equal(harness({}).summary(results), "Finished with errors — 1 sent, 2 waiting to be sent, 1 failed.");
});

test("the Send dialog's footer uses the three-way summary", () => {
  const fn = appSrc.slice(appSrc.indexOf("async function doSendUpload("), appSrc.indexOf("\n}", appSrc.indexOf("async function doSendUpload(")));
  assert.match(fn, /\$\('sendFooterStatus'\)\.textContent=sendSummaryText\(results\);/);
});

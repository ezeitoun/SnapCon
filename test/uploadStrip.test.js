// test/uploadStrip.test.js — the card's upload strip and the Print options
// dialog's upload block, which replace the "Cancel upload" text links.
//
// While a send from this tab uploads, the card shows a slim strip in the
// banner position ("Uploading: …" / "Uploading next: …" on a printing
// printer) with the percentage and MB, a framed Cancel upload button and a 3px
// bar; a failed upload turns it red with Retry and Dismiss; success or a
// cancel removes it. Upload and Print are disabled meanwhile, with a reason.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function extractFn(name) {
  const a = appSrc.indexOf("async function " + name + "(");
  const at = a >= 0 ? a : appSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in public/app.js");
  return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
}
const line = start => { const at = appSrc.indexOf(start); assert.ok(at >= 0, start); return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2); };

const sandbox = {
  Map, String, Math, Number,
  // The key and its parameters, quote-free so the strip's HTML escaping leaves it readable.
  t: (k, p) => k + (p ? "(" + Object.entries(p).map(([a, b]) => a + "=" + b).join(",") + ")" : ""),
  esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  stripExt: n => String(n || "").replace(/\.[^./\\]+$/, ""),
  UPLOAD_CANCEL: new Map(), SEND_FILL: new Map(),
  canAct: () => true,   // a Regular or Admin user (View-only: test/uploadCrossTab.test.js)
};
vm.createContext(sandbox);
vm.runInContext("const UPLOADS = new Map();\nthis.UPLOADS = UPLOADS;\n" + line("const UPLOAD_FAILURE_REASONS = {") + "\n" +
  ["uploadMB", "uploadDetailText", "uploadFailureReason", "uploadStripHtml", "sendInFlight", "fillBackground", "sendBtnAttrs"].map(extractFn).join("\n"), sandbox);
const call = (n, ...a) => vm.runInContext(n, sandbox)(...a);
const reset = () => { sandbox.UPLOADS.clear(); sandbox.UPLOAD_CANCEL.clear(); sandbox.SEND_FILL.clear(); };
test.beforeEach(reset);

// ---- the detail line ----

test("detail line: percentage and MB, the total rounded the same way", () => {
  assert.equal(call("uploadDetailText", 34, 15.6 * 1048576, 46 * 1048576), "fleet.upload.detail(pct=34,sent=15.6,total=46)");
  assert.equal(call("uploadDetailText", 9, 0.3 * 1048576, 0.5 * 1048576), "fleet.upload.detail(pct=9,sent=0.3,total=0.5)");
});

test("detail line: unknown total says what has been sent; nothing sent yet says it is starting", () => {
  assert.equal(call("uploadDetailText", 0, 2 * 1048576, 0), "fleet.upload.detail_sent(sent=2)");
  assert.equal(call("uploadDetailText", 0, 0, 0), "fleet.upload.starting");
});

// ---- failure reasons ----

test("failure reasons in plain words, from the job's error code; the raw message otherwise", () => {
  const r = (c, m) => call("uploadFailureReason", c, m);
  assert.equal(r("ECONNRESET", "socket hang up"), "fleet.upload.reason_lost_connection");
  assert.equal(r(null, "socket hang up"), "fleet.upload.reason_lost_connection");
  assert.equal(r("ETIMEDOUT"), "fleet.upload.reason_timeout");
  assert.equal(r("EHOSTUNREACH"), "fleet.upload.reason_unreachable");
  assert.equal(r("UPLOAD_REJECTED", "Upload 413: too large"), "fleet.upload.reason_rejected");
  assert.equal(r("NAS_UNREACHABLE"), "fleet.upload.reason_file_unreadable");
  assert.equal(r("EWHATEVER", "Something odd"), "Something odd");
  assert.equal(r(null, ""), "fleet.upload.reason_unknown");
});

// ---- the strip per state ----

const PRINTING = { id: 4, state: "printing" }, IDLE = { id: 4, state: "standby" };
const uploading = (extra = {}) => sandbox.UPLOADS.set("4", { state: "uploading", name: "Benchy.gcode", pct: 34, sent: 15.6 * 1048576, total: 46 * 1048576, ...extra });

test("uploading on a printing printer: 'Uploading next', the detail, a framed Cancel upload, the bar", () => {
  uploading(); sandbox.UPLOAD_CANCEL.set("4", "j1");
  const html = call("uploadStripHtml", PRINTING);
  assert.match(html, /^<div class="upload-strip">/);
  assert.match(html, /<div class="upload-strip-title" title="Benchy\.gcode"><span class="upload-strip-name">fleet\.upload\.uploading_next\(file=Benchy\)<\/span>/, "extension stripped, full name in the title");
  assert.match(html, /data-live="upload-detail">fleet\.upload\.detail\(pct=34,sent=15\.6,total=46\)</);
  assert.match(html, /<button type="button" class="upload-strip-btn danger" data-cancel-upload="j1" data-printer="4">fleet\.print\.cancel_upload<\/button>/);
  assert.match(html, /<div class="upload-strip-fill" data-live="upload-bar" style="width:34%"><\/div>/);
  assert.doesNotMatch(html, /pstatus-cancel/, "no text link");
});

test("uploading on an idle printer: 'Uploading'; Cancel upload disabled, with a reason, until the server says it can be cancelled", () => {
  uploading();
  const html = call("uploadStripHtml", IDLE);
  assert.match(html, /fleet\.upload\.uploading\(file=Benchy\)/);
  assert.match(html, /data-cancel-upload="" data-printer="4" disabled title="fleet\.upload\.cancel_not_yet_title"/);
});

test("failed: the percentage it reached, the reason, Retry and Dismiss, no Cancel upload", () => {
  uploading({ state: "failed", pct: 62, reason: "Lost connection to the printer" });
  const html = call("uploadStripHtml", IDLE);
  assert.match(html, /^<div class="upload-strip failed">/);
  assert.match(html, /fleet\.upload\.failed_title\(pct=62,file=Benchy\)/);
  assert.match(html, /<div class="upload-strip-detail">Lost connection to the printer<\/div>/);
  assert.match(html, /data-upload-retry="4">settings\.firmware\.st_retry<\/button>/);
  assert.match(html, /data-upload-dismiss="4">library\.dismiss_btn<\/button>/);
  assert.doesNotMatch(html, /data-cancel-upload/);
  assert.match(html, /style="width:62%"/, "the bar stays where it stopped");
});

test("no upload (never started, finished or cancelled): no strip", () => {
  assert.equal(call("uploadStripHtml", IDLE), "");
});

// ---- the card's buttons ----

test("idle and uploading: Upload and Print disabled; the title says why", () => {
  uploading();
  assert.equal(call("sendBtnAttrs", IDLE, false, true, { card: true }), "disabled");
  assert.equal(call("sendBtnAttrs", IDLE, true, true, { card: true }), "disabled");
  reset();
  assert.equal(call("sendBtnAttrs", IDLE, false, true, { card: true }), "", "enabled again once it's over");
  sandbox.SEND_FILL.set("4", { start: true, pct: 100 });
  assert.equal(call("sendBtnAttrs", IDLE, false, true, { card: true }), "disabled", "still busy while the print starts");
  assert.match(appSrc, /data-start="0" title="\$\{sendInFlight\(p\)\?esc\(t\("fleet\.upload\.waiting_title"\)\):maintMode\?/);
  assert.match(appSrc, /data-start="1" title="\$\{sendInFlight\(p\)\?esc\(t\("fleet\.upload\.waiting_title"\)\):maintMode\?/);
});

test("printing and uploading: the button row is unchanged (it never has Upload/Print), and the badge stays Printing", () => {
  const build = appSrc.slice(appSrc.indexOf("function buildCardHtml("), appSrc.indexOf("\n}", appSrc.indexOf("function buildCardHtml(")));
  const busyBranch = build.slice(build.indexOf("${busy"), build.indexOf(": `<button class=\"btn-chip\" ${sendBtnAttrs("));
  assert.doesNotMatch(busyBranch, /sendInFlight|upload/i, "Pause / Cancel / Plate / E-Stop as before");
  const poll = extractFn("pollJob");
  assert.match(poll, /if\(d\.phase==="upload" && !printingNow\) setOverride\("upload"/);
});

test("the strip sits in the banner position, in both card layouts", () => {
  assert.match(appSrc, /\$\{p\.queuedFile\?queuedFileBannerHtml\(p,\{readyToo:mode==="offline"\}\):''\}\n      \$\{uploadStripHtml\(p\)\}/);
});

// ---- pollJob: progress in place, end states ----

test("progress is patched in place; state changes rebuild; cancel is quiet; an upload failure goes to the strip", () => {
  const poll = extractFn("pollJob");
  assert.match(poll, /if\(d\.phase==="upload"\) patchUploadProgress\(printerId, d\);/);
  assert.match(poll, /if\(d\.cancelled\)\{\n\s+\/\/ Cancelled by the user: the strip just goes away, no message\.\n\s+setUploadState\(printerId, null\);/);
  assert.match(poll, /else if\(strip && d\.failedPhase==="upload"\)\{[\s\S]*?state:"failed", reason:uploadFailureReason\(d\.errorCode, d\.error\)/);
  assert.match(poll, /if\(strip && strip\.state==="uploading" && d\.phase!=="upload"\) setUploadState\(printerId, null\);/, "finished: gone, the card shows Loaded / printing");
  assert.doesNotMatch(extractFn("patchUploadProgress"), /renderFleet/, "a progress tick never rebuilds");
  assert.match(appSrc, /uploadStrip:UPLOADS\.has\(String\(p\.id\)\) \? uploadStripKey\(UPLOADS\.get\(String\(p\.id\)\)\) : null/);
});

// ---- the Print options dialog's footer ----

function footerWorld() {
  const el = () => ({ style: {}, disabled: false, textContent: "", title: "" });
  const els = { qpCancel: el(), qpCancelUpload: el(), qpPrint: el() };
  const ctx = vm.createContext({ $: id => els[id], t: k => k, syncQuickPrintButton: () => { els.qpPrint.disabled = false; } });
  vm.runInContext("let QP_UPLOAD_JOB=null;\n" + extractFn("qpFooter"), ctx);
  return { els, footer: s => vm.runInContext("qpFooter", ctx)(s) };
}

test("dialog footer: uploading → one Cancel upload and a disabled Uploading…; done → Cancel and Start print", () => {
  const w = footerWorld();
  w.footer("uploading");
  assert.equal(w.els.qpCancel.style.display, "none");
  assert.equal(w.els.qpCancelUpload.style.display, "");
  assert.equal(w.els.qpPrint.textContent, "fleet.print.status_uploading");
  assert.equal(w.els.qpPrint.disabled, true);
  w.footer("starting");
  assert.equal(w.els.qpCancelUpload.style.display, "none");
  assert.equal(w.els.qpCancel.style.display, "");
  assert.equal(w.els.qpPrint.textContent, "fleet.queued.starting_print_status");
  assert.equal(w.els.qpPrint.disabled, true);
  w.footer("idle");
  assert.equal(w.els.qpCancel.style.display, "");
  assert.equal(w.els.qpCancelUpload.style.display, "none");
  assert.equal(w.els.qpPrint.textContent, "fleet.modal.quickprint.start_print_button");
  assert.equal(w.els.qpPrint.disabled, false);
});

test("dialog: Cancel upload stops the upload and closes; ✕ and Esc only close (the card's strip takes over)", () => {
  assert.match(appSrc, /\$\("qpCancelUpload"\)\.addEventListener\("click", \(\)=>\{[\s\S]*?if\(job!=null\) cancelUpload\(job, printer\);\n    closeQuickPrintModal\(\);/);
  assert.match(appSrc, /wireModal\("quickPrintModal", closeQuickPrintModal, \["qpX","qpCancel"\]\);/);
  assert.doesNotMatch(extractFn("closeQuickPrintModal"), /cancelUpload/);
});

test("however the job ends (done, error, a thrown poll), a strip still showing 'uploading' is removed; a failed one stays", () => {
  const poll = extractFn("pollJob");
  const fin = poll.slice(poll.lastIndexOf("} finally {"));
  assert.match(fin, /const left=printerId!=null \? UPLOADS\.get\(String\(printerId\)\) : null;\n    if\(left && left\.state==="uploading"\) setUploadState\(printerId, null\);/);
});

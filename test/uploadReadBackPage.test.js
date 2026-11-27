// test/uploadReadBackPage.test.js — how the page shows the read-back after an
// upload (docs/TODO.md §37 P2), beyond pollJob's own tests: another tab's
// strip while the printer's copy is checked, the compact card, a content
// mismatch, and a deferred file whose check did not confirm it.
//
// The functions are taken from public/app.js; t() returns the key and its
// parameters, so each assertion names the string that would be shown.
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

function page() {
  const queried = [];
  const ctx = {
    Map, String, Math, Number, Object,
    t: (k, p) => k + (p ? "(" + Object.entries(p).map(([a, b]) => a + "=" + b).join(",") + ")" : ""),
    esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    canAct: () => true,
    UPLOADS: new Map(), UPLOAD_CANCEL: new Map(),
    document: { querySelector: sel => { queried.push(sel); return null; } },
  };
  vm.createContext(ctx);
  vm.runInContext(["uploadPct", "uploadMB", "uploadDetailText", "uploadStripHtml", "compactUploadStripHtml", "paintUploadProgress", "queuedFileBannerHtml", "stagedBannerActions"].map(extractFn).join("\n"), ctx);
  return { ctx, queried, call: (n, ...a) => vm.runInContext(n, ctx)(...a) };
}

test("another tab's strip while the printer's copy is checked is not repainted as a byte count", () => {
  const h = page();
  h.ctx.UPLOADS.set("3", { state: "uploading", origin: "fleet", jobId: "j1", name: "part.gcode", pct: 99, sent: 46, total: 46, verifying: true });
  h.call("paintUploadProgress", 3);
  assert.deepEqual(h.queried, [], "its detail line stays 'checking its copy'");
  h.ctx.UPLOADS.set("3", { state: "uploading", origin: "fleet", jobId: "j1", name: "part.gcode", pct: 50, sent: 23, total: 46 });
  h.call("paintUploadProgress", 3);
  assert.equal(h.queried.length, 1, "an upload still sending is painted as before");
});

test("the compact card's cancel says why it is off while the printer's copy is checked", () => {
  const h = page();
  h.ctx.UPLOADS.set("3", { state: "uploading", origin: "local", jobId: "j1", name: "part.gcode", pct: 99, verifying: true });
  const html = h.call("compactUploadStripHtml", { id: 3 });
  assert.match(html, /title="fleet\.upload\.verifying_cancel_title" disabled/);
});

test("a content mismatch is titled as one, not as a transfer that stopped at 99%", () => {
  const h = page();
  h.ctx.UPLOADS.set("3", { state: "failed", origin: "local", jobId: "j1", name: "part.gcode", pct: 99, reason: "The printer holds a different file under this name", mismatch: true });
  const html = h.call("uploadStripHtml", { id: 3, state: "standby" });
  assert.match(html, /fleet\.upload\.mismatch_title\(file=part\.gcode\)/);
  assert.doesNotMatch(html, /failed_title/);
  h.ctx.UPLOADS.set("3", { state: "failed", origin: "local", jobId: "j1", name: "part.gcode", pct: 40, reason: "x" });
  assert.match(h.call("uploadStripHtml", { id: 3, state: "standby" }), /fleet\.upload\.failed_title\(pct=40,file=part\.gcode\)/, "a transfer that stopped keeps its title");
});

test("a deferred file the printer accepted but the check did not confirm says so; one it never confirmed keeps the P1 banner", () => {
  const h = page();
  for (const reason of ["not-on-printer", "verify-unreadable"]) {
    const html = h.call("queuedFileBannerHtml", { queuedFile: { name: "part.gcode", status: "error", outcome: "unknown", reason } });
    assert.match(html, /fleet\.queued\.stage_unchecked_banner\(name=part\.gcode\)/, reason);
  }
  assert.match(h.call("queuedFileBannerHtml", { queuedFile: { name: "part.gcode", status: "error", outcome: "unknown", reason: "timeout" } }), /fleet\.queued\.stage_unconfirmed_banner/);
  assert.match(h.call("queuedFileBannerHtml", { queuedFile: { name: "part.gcode", status: "error", outcome: "unknown" } }), /fleet\.queued\.stage_unconfirmed_banner/);
});

test("a deferred file that changed on this computer while it was sent gets the 'accepted, not confirmed' banner", () => {
  const h = page();
  assert.match(h.call("queuedFileBannerHtml", { queuedFile: { name: "part.gcode", status: "error", outcome: "unknown", reason: "local-changed" } }), /stage_unchecked_banner/);
});

// ---- §37 P5: what the card says about a Loaded file checked on the printer ----
test("P5: gone, changed and unable to verify each have their own banner and buttons; never a re-send", () => {
  const h = page();
  const missing = h.call("queuedFileBannerHtml", { id: 3, queuedFile: { name: "part.gcode", status: "missing" } });
  assert.match(missing, /queued-banner err/);
  assert.match(missing, /fleet\.queued\.staged_missing_banner\(name=part\.gcode\)/);
  assert.match(missing, /data-staged-dismiss="3" data-staged-name="part\.gcode"/);
  assert.doesNotMatch(missing, /data-staged-check|data-upload-retry/);
  const changed = h.call("queuedFileBannerHtml", { id: 3, queuedFile: { name: "part.gcode", status: "changed" } });
  assert.match(changed, /queued-banner warn/);
  assert.match(changed, /fleet\.queued\.staged_changed_banner/);
  const unv = h.call("queuedFileBannerHtml", { id: 3, queuedFile: { name: "part.gcode", status: "ready", check: { state: "unverifiable", at: 1 } } });
  assert.match(unv, /fleet\.queued\.staged_unverifiable_banner/);
  assert.match(unv, /data-staged-check="3"/);
  assert.match(unv, /data-staged-dismiss="3"/);
  // On an offline card it is the warning, not the plain "ready" banner.
  assert.match(h.call("queuedFileBannerHtml", { id: 3, queuedFile: { name: "part.gcode", status: "ready", check: { state: "unverifiable", at: 1 } } }, { readyToo: true }), /staged_unverifiable_banner/);
  // Present (or not yet checked): the Loaded badge says it; no banner on a normal card.
  assert.equal(h.call("queuedFileBannerHtml", { id: 3, queuedFile: { name: "part.gcode", status: "ready", check: { state: "present", at: 1, basis: "size" } } }), "");
});

test("P5: a view-only user sees why Dismiss and Check again are off", () => {
  const h = page();
  h.ctx.canAct = () => false;
  const html = h.call("queuedFileBannerHtml", { id: 3, queuedFile: { name: "part.gcode", status: "ready", check: { state: "unverifiable", at: 1 } } });
  assert.equal((html.match(/disabled title="fleet\.queued\.staged_view_only_title"/g) || []).length, 2);
});

test("P5: a file gone or changed is not Loaded: no badge, no Eject/Print as a staged file", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // The badge and the staged-file actions key on status "ready" only; the
  // server reports gone/changed as their own statuses (stagedRowStatus).
  assert.match(src, /if\(p\.queuedFile&&p\.queuedFile\.status==='ready'\) return \{ statusColor:"var\(--signal\)", statusTxt:t\("printer_status\.loaded"\) \};/);
  assert.match(src, /if\(start&&qf&&qf\.status==='ready'\)\{/);
});

test("P5: Check again says it is checking, and a refusal gives the button back", async () => {
  const h = page();
  const status = [];
  vm.runInContext(extractFn("stagedFileAction"), h.ctx);
  Object.assign(h.ctx, {
    setCardStatus: (id, cls, txt) => status.push([cls, txt]), loadFleet: () => {},
    postJSON: async () => ({ ok: false, status: 429, json: async () => ({ error: "Checked a moment ago. Try again in a minute." }) }),
  });
  const btn = { disabled: false, isConnected: true };
  await h.call("stagedFileAction", "check", 3, "", btn);
  assert.deepEqual(status[0], ["pstatus work", "printer.note_checking"]);
  assert.deepEqual(status[1], ["pstatus err", "Checked a moment ago. Try again in a minute."]);
  assert.equal(btn.disabled, false);
  h.ctx.postJSON = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, check: { state: "present" } }) });
  const ok = { disabled: false, isConnected: true };
  await h.call("stagedFileAction", "check", 3, "", ok);
  assert.deepEqual(status[status.length - 1], ["pstatus ok", "fleet.queued.staged_check_present"]);
  assert.equal(ok.disabled, true, "left to the card rebuild the new answer brings");
});

test("P5: banners with buttons wrap their sentence; Quick Print's queued start shows the card's reason", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  // §37 P3 added overflow-wrap so a long name without spaces wraps too.
  assert.match(css, /\.queued-banner:has\(\.queued-banner-actions\) \.queued-banner-text\{white-space:normal; overflow:visible; overflow-wrap:anywhere;\}/);
  assert.match(appSrc, /if\(!ok\)\{ \$\("qpStatus"\)\.className="pstatus err"; \$\("qpStatus"\)\.textContent=\(cardStatusFor\(\{id:printer\}\)\|\|\{\}\)\.txt \|\| t\("fleet\.modal\.quickprint\.status_start_failed"\); \}/);
});

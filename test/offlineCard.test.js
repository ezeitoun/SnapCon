// test/offlineCard.test.js — the offline and firmware (updating/rebooting)
// printer cards.
//
// An offline card used to be the normal card faded to 0.55, still carrying an
// enabled Preheat button for a printer nothing can reach. It is now full
// contrast, with the header (its web-interface link kept), a staged file if
// there is one, and one line: when SnapCon last reached the printer. Updating/rebooting
// cards keep their badge and lose the buttons too. Which card a printer gets
// is decided by the same rule as the status badge, so the two can't drift.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
function extractFn(name) {
  const at = appSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in public/app.js");
  return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
}

const sandbox = {
  STATUS_OVERRIDE: new Map(), Date, Number, String, URL, Math,
  canAct: () => true,
  // t() stand-in: the key plus its parameters, so tests see what was chosen.
  t: (k, params) => k + (params ? " " + JSON.stringify(params) : ""),
  esc: s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
};
vm.createContext(sandbox);
vm.runInContext(["printerShowsOffline", "cardMode", "offlineSeenText", "printerHost", "preheatAttrs", "fmtDuration", "stripExt", "queuedFileBannerHtml", "statusColorText"].map(extractFn).join("\n"), sandbox);
const call = (name, ...a) => vm.runInContext(name, sandbox)(...a);

// ---- which card ----

test("online is the normal card; unreachable is offline; updating/rebooting get the firmware card", () => {
  assert.equal(call("cardMode", { id: 1, online: true, state: "standby" }), null);
  assert.equal(call("cardMode", { id: 1, online: false, state: "standby" }), "offline");
  assert.equal(call("cardMode", { id: 1, online: false, state: "updating" }), "firmware");
  assert.equal(call("cardMode", { id: 1, online: false, state: "rebooting" }), "firmware");
  assert.equal(call("cardMode", { id: 1, online: true, state: "updating" }), "firmware", "mid-flash, whatever the probe said");
});

test("the card and the status badge use one rule: Offline exactly when the card is the offline card", () => {
  for (const p of [
    { id: 1, online: true, state: "printing" }, { id: 1, online: false, state: "standby" },
    { id: 1, online: false, state: "updating" }, { id: 1, online: false, state: "rebooting" },
  ]) {
    const badgeOffline = call("statusColorText", p).statusTxt === "printer_status.offline";
    assert.equal(badgeOffline, call("cardMode", p) === "offline", JSON.stringify(p));
  }
});

test("a client-side phase override (a send in progress) keeps the normal card, as it keeps the badge", () => {
  sandbox.STATUS_OVERRIDE.set("1", { statusColor: "x", statusTxt: "Uploading" });
  try { assert.equal(call("cardMode", { id: 1, online: false, state: "standby" }), null); }
  finally { sandbox.STATUS_OVERRIDE.clear(); }
});

// ---- the "last seen" text ----

const at = (h, m) => new Date(2026, 9, 5, h, m, 0).getTime();   // local time, like the card

test("seen today: the time, and how long ago through fmtDuration", () => {
  const out = call("offlineSeenText", new Date(at(14, 2)).toISOString(), at(16, 5));
  assert.match(out, /^fleet\.card\.offline_seen_today /);
  const params = JSON.parse(out.slice(out.indexOf(" ") + 1));
  assert.equal(params.ago, "2h 03m");
  assert.equal(params.time, new Date(at(14, 2)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const recent = JSON.parse(call("offlineSeenText", new Date(at(16, 0)).toISOString(), at(16, 4) + 5000).split(" ").slice(1).join(" "));
  assert.equal(recent.ago, "4m 05s", "under an hour fmtDuration keeps the seconds");
});

test("seen on an earlier day: the date and time, no \"ago\"", () => {
  const seen = new Date(2026, 9, 3, 14, 2).getTime();
  const out = call("offlineSeenText", new Date(seen).toISOString(), at(9, 0));
  assert.match(out, /^fleet\.card\.offline_seen_earlier /);
  const params = JSON.parse(out.slice(out.indexOf(" ") + 1));
  assert.equal(params.date, new Date(seen).toLocaleDateString([], { month: "short", day: "numeric" }));
  assert.equal("ago" in params, false);
});

test("never reached since SnapCon started (null, or anything unparsable)", () => {
  assert.equal(call("offlineSeenText", null, at(9, 0)), "fleet.card.offline_never_seen");
  assert.equal(call("offlineSeenText", "garbage", at(9, 0)), "fleet.card.offline_never_seen");
});

// ---- the staged file on an offline card ----

test("a ready staged file shows on the offline card only, extension stripped, full name in the title", () => {
  const p = { queuedFile: { name: "Beardie <v2>.gcode", status: "ready" } };
  assert.equal(call("queuedFileBannerHtml", p), "", "the normal card says it with its Loaded badge instead");
  const html = call("queuedFileBannerHtml", p, { readyToo: true });
  assert.match(html, /^<div class="queued-banner ready" title="Beardie &lt;v2&gt;\.gcode"><span class="queued-banner-text">fleet\.queued\.ready_banner \{"name":"Beardie <v2>"\}<\/span><\/div>$/);
});

// ---- the card's structure ----

const build = appSrc.slice(appSrc.indexOf("function buildCardHtml("), appSrc.indexOf("\n}", appSrc.indexOf("function buildCardHtml(")));

test("the card's class comes from cardMode(), and Camera view keeps its own placeholder", () => {
  assert.match(build, /const mode=VIEW_MODE==='camera' \? null : cardMode\(p\);/);
  assert.match(build, /card\.className="pcard"\+\(mode==="offline"\?" offline":mode==="firmware"\?" fw-busy":""\);/);
});

test("offline and firmware cards have no button row; the offline card has no prism line, and has the info row", () => {
  assert.match(build, /\$\{mode\?'':`<div class="foot\$\{busy\?'':' foot-idle'\}">/);
  assert.match(build, /\$\{mode==="offline"\?'':`<div class="prism-line/);
  assert.match(build, /\$\{mode==="offline"\?`<div class="offline-info">\$\{WIFI_OFF_ICON\}<span class="offline-info-seen" data-live="seen">/);
  assert.match(build, /queuedFileBannerHtml\(p,\{readyToo:mode==="offline"\}\)/);
});

test("offline and updating/rebooting cards keep only the web-interface link; normal cards keep every pill", () => {
  // Shown from the connector's webUi capability, which offline printers keep
  // (a fixed capability, or FlashForge's last detected profile).
  assert.match(build, /const webUiPill=p\.capabilities\?\.webUi\?`<a class="pill-btn pill-btn-sm" href="\$\{esc\(p\.url\|\|'#'\)\}"/);
  assert.match(build, /<div class="card-right">\$\{mode\?\(webUiPill\?`<div class="card-pills">\$\{webUiPill\}<\/div>`:''\):p\.online\?`<div class="card-pills">/);
  assert.doesNotMatch(build, /offline-info-addr/, "no address on the card any more");
});

test("the link's tooltip carries the host, so the address the card no longer shows is still reachable", () => {
  assert.match(build, /t\("printer\.action_web_interface_title",\{host:printerHost\(p\.url\)\}\)/);
  assert.equal(call("printerHost", "http://192.168.1.47"), "192.168.1.47");
  assert.equal(call("printerHost", "http://192.168.4.212:8898"), "192.168.4.212:8898");
  assert.equal(call("printerHost", "not a url"), "not a url");
  assert.equal(call("printerHost", undefined), "");
});

test("Preheat is disabled, with the reason, on a printer that is offline or mid-flash (Camera and list views keep their buttons)", () => {
  assert.equal(call("preheatAttrs", { id: 3, online: true, state: "standby" }), ' data-preheat="3" title="printer.action_preheat"');
  assert.equal(call("preheatAttrs", { id: 3, online: false, state: "standby" }),
    'disabled data-preheat="3" title="printer.action_preheat_unavailable_title {&quot;status&quot;:&quot;printer_status.offline&quot;}"');
  assert.match(call("preheatAttrs", { id: 3, online: true, state: "updating" }), /^disabled .*printer_status\.updating/);
  assert.match(call("preheatAttrs", { id: 3, online: false, state: "rebooting" }), /^disabled .*printer_status\.rebooting/);
  // Both places that render Preheat use it.
  assert.equal((appSrc.match(/\$\{preheatAttrs\(p\)\}>/g) || []).length, 2);
  assert.doesNotMatch(appSrc, /\$\{canAct\(\)\?"":"disabled"\} data-preheat=/);
});

test("Camera view's placeholder names the printer's real status (Updating, not Offline)", () => {
  assert.match(build, /\? `<div class="cam-shot-placeholder"><span>\$\{esc\(statusTxt\)\}<\/span><\/div>`/);
});

test("the faded 0.55 card is gone from the card grid; the list view keeps its own fade", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.doesNotMatch(css, /\.pcard\.offline\{opacity/);
  assert.match(css, /\.list-row\.offline\{opacity:0\.55;\}/);
});

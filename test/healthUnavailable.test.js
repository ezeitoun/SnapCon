// test/healthUnavailable.test.js — the Health page says why a printer's
// health can't be shown (docs/TODO.md §50), from the answer's reasonCode,
// instead of always "Health data not available for this connector.".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));

function load() {
  const sandbox = {
    esc: s => String(s).replace(/[&<>"']/g, c => "&#" + c.charCodeAt(0) + ";"),
    t: k => { const [ns, key] = k.split("."); return en[ns][key] ?? k; },
  };
  vm.createContext(sandbox);
  const a = appSrc.indexOf("const HEALTH_UNAVAILABLE={");
  const b = appSrc.indexOf("\n}", appSrc.indexOf("function healthUnavailableHtml(")) + 2;
  assert.ok(a > 0 && b > a);
  vm.runInContext(appSrc.slice(a, b) + "\nthis.f = healthUnavailableHtml;", sandbox);
  return sandbox.f;
}
const html = load();
const heading = h => h.match(/<p>([^<]*)<\/p>/)[1].replace(/&#39;/g, "'");
const reason = h => (h.match(/<p class="settings-help">([^<]*)<\/p>/) || [])[1];

test("each reason gets its own heading; the redundant English reason is left out", () => {
  const cases = [
    [{ skipped: true, online: false, reason: "Could not reach AD5X Red: fetch failed", reasonCode: "offline" }, en.health.unavailable_offline, "Could not reach AD5X Red: fetch failed"],
    [{ skipped: true, online: true, reason: "Health is not available on this printer's stock firmware", reasonCode: "unsupported_firmware" }, en.health.unavailable_firmware, undefined],
    [{ skipped: true, reason: "Could not read this printer's health.", reasonCode: "connector_error" }, en.health.unavailable_error, undefined],
    [{ skipped: true, reason: "The printer took too long to report its health.", reasonCode: "timeout" }, en.health.unavailable_timeout, undefined],
    [{ skipped: true, reason: "Could not reach SnapCon: network down", reasonCode: "client_unreachable" }, en.health.unavailable_unreachable, "Could not reach SnapCon: network down"],
  ];
  for (const [d, h, r] of cases) {
    const out = html(d, "AD5X Red");
    assert.equal(heading(out), h, d.reasonCode);
    assert.equal(reason(out), r, d.reasonCode + " reason line");
    assert.match(out, /<h3>AD5X Red<\/h3>/);
  }
});

test("U1/Klipper offline (online:false, no reasonCode) reads as offline, with its detail", () => {
  const out = html({ online: false, skipped: true, reason: "Could not reach U1 Navy: timeout" }, "U1 Navy");
  assert.equal(heading(out), en.health.unavailable_offline);
  assert.equal(reason(out), "Could not reach U1 Navy: timeout");
});

test("anything unrecognised keeps the original heading and its reason (unchanged)", () => {
  const out = html({ id: "p", name: "Sim", online: true, skipped: true, reason: "not supported" }, "Sim");
  assert.equal(heading(out), en.health.unsupported);
  assert.equal(reason(out), "not supported");
  assert.equal(heading(html({ skipped: true, reasonCode: "something_new" }, "X")), en.health.unsupported);
});

test("names and reasons are escaped", () => {
  const out = html({ skipped: true, online: false, reason: "<img src=x>" }, "<b>x</b>");
  assert.doesNotMatch(out, /<img|<b>x/);
});

test("the client-side failure is marked client_unreachable; the strings exist in en and es; locale version bumped", () => {
  assert.match(appSrc, /health=\{ skipped:true, reasonCode:"client_unreachable", reason:t\("health\.could_not_reach"/);
  for (const k of ["unavailable_offline", "unavailable_firmware", "unavailable_error", "unavailable_timeout", "unavailable_unreachable"]) {
    assert.ok(en.health[k] && es.health[k], k);
    assert.doesNotMatch(en.health[k], /^[A-Z ]+$/, "sentence case");
  }
  assert.ok(en._meta.version >= 114 && es._meta.version >= 114, "locale version bumped for the new strings");
  assert.match(appSrc, /body\.innerHTML=healthUnavailableHtml\(d, name\);/);
});

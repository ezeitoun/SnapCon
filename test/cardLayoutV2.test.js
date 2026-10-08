// test/cardLayoutV2.test.js — the new printing-card layout (Full view, behind
// Settings > View > Printer card layout, or ?cards=v2 for one page load).
//
// Built beside the classic layout so it can be switched off without a revert:
// with the switch on Classic, buildCardHtml() must produce exactly what it
// did before (checked against the previous build in the browser; here, that
// no classic branch is reached differently).
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
const line = start => { const at = appSrc.indexOf(start); assert.ok(at >= 0, start); return appSrc.slice(at, appSrc.indexOf("\n", at)); };

// ---- Est. done ----

const tz = vm.createContext({ Date, Number, Math, String });
vm.runInContext(["etaText", "remainingSeconds", "fmtRemaining", "fmtDuration"].map(extractFn).join("\n"), tz);
const eta = (sec, now, state) => vm.runInContext("etaText", tz)(sec, now, state);
const at = (d, h, m) => new Date(2026, 9, d, h, m, 0).getTime();   // local time, like the card

test("Est. done: the local time today, the short weekday when it's another day", () => {
  const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  assert.equal(eta(2 * 3600, at(7, 12, 0), "printing"), hhmm(at(7, 14, 0)));
  const tomorrow = at(8, 9, 15);
  assert.equal(eta((tomorrow - at(7, 20, 0)) / 1000, at(7, 20, 0), "printing"),
    new Date(tomorrow).toLocaleDateString([], { weekday: "short" }) + " " + hhmm(tomorrow));
});

test("Est. done: a dash while paused, and when the remaining time is unknown", () => {
  assert.equal(eta(3600, at(7, 12, 0), "paused"), "—");
  assert.equal(eta(null, at(7, 12, 0), "printing"), "—");
  assert.equal(eta(NaN, at(7, 12, 0), "printing"), "—");
});

test("fmtRemaining() is unchanged now that the remaining seconds are a shared helper", () => {
  const f = (e, p) => vm.runInContext("fmtRemaining", tz)(e, p);
  assert.equal(f(3600, 0.5), "1h 00m");
  assert.equal(f(600, 0.25), "30m 00s");
  assert.equal(f(0, 0.5), "—");
  assert.equal(f(100, 0), "—");
  assert.equal(f(100, 1.2), "0s", "never negative");
  assert.equal(vm.runInContext("remainingSeconds", tz)(3600, 0.5), 3600);
});

// ---- the switch ----

function switchWorld(setting, url, view) {
  const ctx = vm.createContext({ CARD_LAYOUT: setting, VIEW_MODE: view });
  vm.runInContext(`const CARD_LAYOUT_URL = ${JSON.stringify(url)};\n` + extractFn("cardLayoutV2"), ctx);
  return vm.runInContext("cardLayoutV2", ctx)();
}

test("the v2 block is used only with the switch on and in Full view", () => {
  assert.equal(switchWorld("classic", null, "regular"), false);
  assert.equal(switchWorld("v2", null, "regular"), true);
  for (const view of ["compact", "camera", "list", "printfarm"]) assert.equal(switchWorld("v2", null, view), false, view);
});

test("?cards= overrides the setting for that page load, both ways", () => {
  assert.equal(switchWorld("classic", "v2", "regular"), true);
  assert.equal(switchWorld("v2", "classic", "regular"), false);
  assert.match(line("const CARD_LAYOUT_URL = "), /get\("cards"\); return v==="v2"\|\|v==="classic" \? v : null;/);
});

// ---- the card ----

const build = appSrc.slice(appSrc.indexOf("function buildCardHtml("), appSrc.indexOf("\n}", appSrc.indexOf("function buildCardHtml(")));

test("buildCardHtml(): v2 only for a card without an error; otherwise the classic branches, as before", () => {
  // Online, no error, and the normal card (not the offline or firmware card).
  assert.match(build, /const v2=cardLayoutV2\(\) && !mode && p\.online && !\(p\.errorCode\|\|p\.message\);\n    if\(v2\) card\.classList\.add\("card-v2"\);/);
  assert.match(build, /\$\{p\.online&&!\(p\.errorCode\|\|p\.message\)\?\(v2\?buildCardStatsV2\(p\):\(\(\)=>\{/);
  assert.match(build, /\$\{p\.online&&!v2\?\(\(\)=>\{/, "the classic progress section, skipped only for v2");
});

function v2World(p) {
  const ctx = vm.createContext({
    Date, Math, Number, String, Object, JSON,
    esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    t: k => "«" + k + "»", canAct: () => true,
    heatBarInfo: (a, tg) => ({ targetTxt: tg ? tg + "°" : "—", pct: 50, bg: "" }), heatBarFillStyle: () => "width:50%",
    cardFileStem: p => p.filename ? p.filename.replace(/\.gcode$/, "") : null,
    thumbImgHtml: (p, stem, cls) => `<img class="${cls}">`,
    fmtFinishedTime: ts => ts ? "15:30" : "—",
  });
  vm.runInContext(["buildCardStatsV2", "layerDisplay", "cardV2FilamentText", "cardV2EndText", "etaText", "remainingSeconds", "fmtRemaining", "fmtDuration"].map(extractFn).join("\n"), ctx);
  return vm.runInContext("buildCardStatsV2", ctx)(p);
}
const PRINTING = { id: 3, online: true, state: "printing", progress: 0.42, elapsed: 3600, filename: "Bracket.gcode",
  hotend: { temp: 215, target: 215 }, bed: { temp: 45, target: 45 }, layer: { current: 139, total: 325 }, filamentUsed: 121500 };

test("the v2 block keeps every live hook the classic one has, plus filament and Est. done", () => {
  const html = v2World(PRINTING);
  for (const hook of ["hotend-val", "hotend-target", "hotend-bar", "bed-val", "bed-target", "bed-bar",
    "layer-current", "layer-target", "filament-val", "pct", "bar", "remaining", "elapsed", "eta"]) {
    assert.ok(html.includes(`data-live="${hook}"`), "missing hook: " + hook);
  }
  assert.match(html, /<span data-live="filament-val">121\.5 m<\/span>/);
  assert.match(html, /data-setbed="3"/, "the Bed cell keeps click-to-set");
  assert.match(html, /<div class="v2-thumb" data-thumb="3" tabindex="0" role="button"/);
  assert.match(html, /«fleet\.progress\.eta_label»/);
});

test("the v2 block per state: paused shows a dash for Est. done; complete shows Done, Total time and Finished", () => {
  const paused = v2World({ ...PRINTING, state: "paused" });
  assert.match(paused, /prog-pct amber/);
  assert.match(paused, /data-live="eta">—</);
  const done = v2World({ ...PRINTING, state: "complete", progress: 1, completedAt: 1 });
  assert.match(done, /«fleet\.progress\.done»/);
  assert.doesNotMatch(done, /data-live="remaining"/);
  assert.match(done, /«fleet\.progress\.total_time_label»/);
  assert.match(done, /«fleet\.progress\.finished_label»<\/div><div class="v2-under-val" data-live="eta">15:30</);
  assert.match(done, /prog-pct green/);
  const idle = v2World({ ...PRINTING, state: "standby", progress: 0, elapsed: 0, filename: null, layer: null, filamentUsed: null });
  assert.match(idle, /<div class="v2-thumb"><\/div>/, "no file: the empty box");
  assert.match(idle, /<span data-live="filament-val">—<\/span>/);
});

test("the live updater patches the v2 hooks through the same helpers the block uses", () => {
  const fn = extractFn("updateFleetCardLiveValues");
  assert.match(fn, /setText\('\[data-live="filament-val"\]', cardV2FilamentText\(p\)\);/);
  assert.match(fn, /setText\('\[data-live="eta"\]', cardV2EndText\(p, Date\.now\(\)\)\);/);
});

test("all v2 styles are scoped under .pcard.card-v2", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  const v2Rules = css.split("\n").filter(l => /\.v2-|card-v2/.test(l) && /\{/.test(l));
  assert.ok(v2Rules.length > 10);
  for (const r of v2Rules) assert.match(r.trim(), /^\.pcard\.card-v2 /, r.trim());
});

// ---- the v2 thumbnail fills its box with the part ----

function thumbWorld({ W, H, box = 98, opaque }) {
  // A fake canvas whose alpha is opaque only inside `opaque` (fractions of the image).
  const canvas = () => { let w = 0, h = 0; return { set width(v) { w = v; }, get width() { return w; }, set height(v) { h = v; }, get height() { return h; },
    getContext: () => ({ drawImage() {}, getImageData: (x, y, ww, hh) => { const d = new Uint8ClampedArray(ww * hh * 4);
      for (let j = 0; j < hh; j++) for (let i = 0; i < ww; i++) { const fx = (i + 0.5) / ww, fy = (j + 0.5) / hh; if (opaque && fx >= opaque.x0 && fx <= opaque.x1 && fy >= opaque.y0 && fy <= opaque.y1) d[(j * ww + i) * 4 + 3] = 255; }
      return { data: d }; } }) }; };
  const ctx = vm.createContext({ Math, Number, Set, encodeURIComponent, THUMB_TOKENS: {}, Date,
    esc: s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"), document: { createElement: canvas } });
  vm.runInContext("const THUMB_MISSING = new Set();\n" + ["thumbToken", "thumbImgHtml", "thumbFitToPart", "thumbPartBox"].map(extractFn).join("\n"), ctx);
  const img = { naturalWidth: W, naturalHeight: H, clientWidth: box, style: {} };
  return { ctx, img, fit: () => { vm.runInContext("thumbFitToPart", ctx)(img); return img.style.transform || null; } };
}
const scaleOf = tr => tr ? +/scale\(([\d.]+)\)/.exec(tr)[1] : 1;

test("the classic thumbnail markup is unchanged; only the v2 card asks for the fit", () => {
  const w = thumbWorld({ W: 300, H: 300 });
  const html = vm.runInContext("thumbImgHtml", w.ctx)({ id: 4, state: "printing" }, "Benchy", "stats-thumb");
  assert.match(html, /^<img class="stats-thumb" src="\/api\/thumbnail\?printer=4&file=Benchy&t=\d+" data-thumb-url="[^"]+" alt="" onerror="thumbRetry\(this\)">$/);
  const v2 = vm.runInContext("thumbImgHtml", w.ctx)({ id: 4, state: "printing" }, "Benchy", "v2-thumb-img", { fitPart: true });
  assert.match(v2, / alt="" onload="thumbFitToPart\(this\)" onerror="thumbRetry\(this\)">$/);
  assert.match(appSrc, /thumbImgHtml\(p,stem,"v2-thumb-img",\{fitPart:true\}\)/);
  assert.equal((appSrc.match(/fitPart:true/g) || []).length, 1, "only the v2 card");
});

test("a part in the middle of a transparent square is scaled up to fill the box, and centred", () => {
  // Measured on the fleet: a 300x300 thumbnail whose part covers 54% x 61%.
  const tr = thumbWorld({ W: 300, H: 300, opaque: { x0: 0.23, y0: 0.24, x1: 0.77, y1: 0.85 } }).fit();
  const s = scaleOf(tr);
  assert.ok(s > 1.4 && s < 1.6, "scale " + s);
  assert.match(tr, /^translate\(-?[\d.]+px, -?[\d.]+px\) scale\([\d.]+\)$/);
  assert.ok(+/translate\(-?[\d.]+px, (-?[\d.]+)px\)/.exec(tr)[1] < 0, "moved up: the part sits low in the image");
});

test("never more than 1.8x, never shrunk, and left alone when there's nothing to trim", () => {
  assert.equal(scaleOf(thumbWorld({ W: 300, H: 300, opaque: { x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 } }).fit()), 1.8, "a tiny part: capped");
  assert.equal(thumbWorld({ W: 300, H: 300, opaque: { x0: 0, y0: 0, x1: 1, y1: 1 } }).fit(), null, "fully opaque");
  assert.equal(thumbWorld({ W: 300, H: 300, opaque: null }).fit(), null, "empty");
  assert.equal(thumbWorld({ W: 300, H: 300, opaque: { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 } }).fit(), null, "already fills it");
  assert.equal(thumbWorld({ W: 0, H: 0 }).fit(), null, "not loaded yet");
});

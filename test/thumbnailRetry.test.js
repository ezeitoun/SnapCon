// test/thumbnailRetry.test.js — a card's job thumbnail that fails to load.
//
// Seen live: AD5X Blue's card asked for a thumbnail of a staged file that is
// not on the printer, got 404, and retried it four times — and every card
// rebuild started a fresh image with four more retries, so the console filled
// with 404s indefinitely. A 404 is the server's final answer ("no preview for
// this file"): it is now asked once, remembered for that job's thumbnail URL,
// and a rebuilt card shows the placeholder instead of fetching it again.
// Anything else (a slow or busy printer) still retries with backoff.
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

function world(status) {
  const timers = [], fetched = [];
  const sandbox = {
    Date, parseInt, encodeURIComponent, Set,
    esc: s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
    THUMB_TOKENS: {},
    fetch: url => { fetched.push(url); return status === "network" ? Promise.reject(new Error("down")) : Promise.resolve({ status }); },
    setTimeout: (fn, ms) => { timers.push(ms); },
    document: { createElement: tag => ({ tag, className: "", textContent: "" }) },
  };
  vm.createContext(sandbox);
  vm.runInContext("const THUMB_MISSING = new Set();\n" + ["thumbToken", "thumbImgHtml", "thumbRetry", "thumbRetryLater", "thumbGiveUp"].map(extractFn).join("\n") +
    "\nthis.THUMB_MISSING = THUMB_MISSING;", sandbox);
  const img = url => ({ dataset: { thumbUrl: url }, src: "http://snapcon" + url, isConnected: true, replacedWith: null, replaceWith(n) { this.replacedWith = n; } });
  return { sandbox, timers, fetched, img, call: (n, ...a) => vm.runInContext(n, sandbox)(...a) };
}
const P = { id: 20, state: "complete" };
const flush = () => new Promise(r => setImmediate(r));

test("a 404 is final: asked once, remembered, and the image becomes the placeholder", async () => {
  const w = world(404);
  const html = w.call("thumbImgHtml", P, "Beardie.gcode", "stats-thumb");
  const url = /data-thumb-url="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&");
  const im = w.img(url);
  w.call("thumbRetry", im);
  await flush();
  assert.deepEqual(w.fetched, [url], "one status check");
  assert.equal(w.timers.length, 0, "no retries scheduled");
  assert.equal(im.replacedWith.className, "stats-thumb-empty");
  assert.equal(w.sandbox.THUMB_MISSING.has(url), true);
  // The card rebuilt for the same job: no <img>, so no request at all.
  assert.equal(w.call("thumbImgHtml", P, "Beardie.gcode", "stats-thumb"), '<span class="stats-thumb-empty">—</span>');
});

test("a new job (a new token in the URL) asks again", async () => {
  const w = world(404);
  const first = /data-thumb-url="([^"]+)"/.exec(w.call("thumbImgHtml", P, "a.gcode", "stats-thumb"))[1].replace(/&amp;/g, "&");
  w.call("thumbRetry", w.img(first)); await flush();
  assert.match(w.call("thumbImgHtml", P, "b.gcode", "stats-thumb"), /^<img /, "a different file is a new job");
});

test("anything else keeps the backoff: four retries, then the placeholder", async () => {
  for (const status of [502, "network"]) {
    const w = world(status);
    const url = /data-thumb-url="([^"]+)"/.exec(w.call("thumbImgHtml", P, "x.gcode", "stats-thumb"))[1].replace(/&amp;/g, "&");
    const im = w.img(url);
    w.call("thumbRetry", im); await flush();
    for (let i = 0; i < 4; i++) w.call("thumbRetry", im);
    assert.deepEqual(w.timers, [1500, 3000, 4500, 6000], String(status));
    assert.equal(im.replacedWith && im.replacedWith.className, "stats-thumb-empty");
    assert.equal(w.sandbox.THUMB_MISSING.size, 0, "not remembered as missing");
  }
});

test("giving up replaces only the image, so the list view keeps the file name beside it", () => {
  assert.match(extractFn("thumbGiveUp"), /img\.replaceWith\(span\)/);
  assert.doesNotMatch(extractFn("thumbGiveUp"), /parentNode\.innerHTML/);
});

test("all three thumbnails (card, camera card, list row) go through thumbImgHtml", () => {
  assert.equal((appSrc.match(/\$\{thumbImgHtml\(p,stem,"(stats-thumb|list-thumb)"\)\}/g) || []).length, 3);
  // No card template builds the <img> itself any more.
  assert.doesNotMatch(appSrc, /<img class="(stats|list)-thumb" src="\/api\/thumbnail/);
});

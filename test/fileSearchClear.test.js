// test/fileSearchClear.test.js — leaving a search in the file browser.
//
// Reported: once text was typed in "Search files…", the only way back to the
// folder view was to delete the text by hand. The box now has an X, and Esc
// does the same: the box is emptied and the folder that was showing comes back.
//
// The search wiring is run from public/app.js's own source against stand-in
// elements, so the handlers under test are the real ones.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");

function wiring() {
  const from = appSrc.indexOf("let SEARCH_DEBOUNCE=null;");
  const to = appSrc.indexOf('$("fleetSearch").addEventListener("input", renderFleet);', from);
  assert.ok(from > 0 && to > from, "the file search wiring is where this test expects it");
  return appSrc.slice(from, to);
}

function element() {
  const handlers = {};
  return {
    value: "", focused: 0,
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    fire(ev, e = {}) { (handlers[ev] || []).forEach(fn => fn(e)); return e; },
    focus() { this.focused++; },
  };
}

// The page around the search box: the box, the X, a folder list that counts
// how often it is drawn, and a server whose answers the test hands out.
function page() {
  const els = { filter: element(), filterClear: element() };
  const timers = new Map(); let nextTimer = 1;
  const requests = [];
  const sandbox = {
    $: id => { assert.ok(els[id], "unexpected element: " + id); return els[id]; },
    encodeURIComponent,
    setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: id => { timers.delete(id); },
    getJSON: url => new Promise(resolve => requests.push({ url, answer: files => resolve({ files }) })),
    renders: 0,
  };
  vm.createContext(sandbox);
  vm.runInContext('var SEARCH_RESULTS=null, CURRENT_SUB="U1"; function renderList(){ renders++; }\n' + wiring(), sandbox);
  const settle = () => new Promise(r => setImmediate(r));
  return {
    box: els.filter, x: els.filterClear, requests,
    results: () => vm.runInContext("SEARCH_RESULTS", sandbox),
    renders: () => sandbox.renders,
    type(text) { els.filter.value = text; els.filter.fire("input"); },
    runTimers() { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); },
    async search(text, files) {
      this.type(text); this.runTimers();
      requests[requests.length - 1].answer(files);
      await settle();
    },
    settle,
  };
}
const esc = () => { const e = { key: "Escape", prevented: 0, preventDefault() { this.prevented++; } }; return e; };
const FOUND = [{ name: "benchy.gcode", sub: "U1", mtime: 1, size: 1 }];

test("Esc in the search box empties it and shows the folder again", async () => {
  const p = page();
  await p.search("benchy", FOUND);
  assert.deepEqual(p.results(), FOUND, "a search is showing");
  const drawn = p.renders();
  const e = p.box.fire("keydown", esc());
  assert.equal(p.box.value, "");
  assert.equal(p.results(), null, "back to the folder view");
  assert.equal(p.renders(), drawn + 1, "the list is drawn again");
  assert.equal(e.prevented, 1, "the key was used here");
});

test("Esc in an empty search box is left for whatever else listens for it", () => {
  const p = page();
  const e = p.box.fire("keydown", esc());
  assert.equal(e.prevented, 0);
  assert.equal(p.renders(), 0);
});

test("other keys in the search box change nothing", async () => {
  const p = page();
  await p.search("benchy", FOUND);
  const drawn = p.renders();
  p.box.fire("keydown", { key: "Enter", preventDefault() { assert.fail("Enter must not be taken"); } });
  assert.equal(p.box.value, "benchy");
  assert.deepEqual(p.results(), FOUND);
  assert.equal(p.renders(), drawn);
});

test("the X empties the box, shows the folder again and leaves the cursor in the box", async () => {
  const p = page();
  await p.search("benchy", FOUND);
  p.x.fire("click");
  assert.equal(p.box.value, "");
  assert.equal(p.results(), null);
  assert.equal(p.box.focused, 1, "ready for the next search");
});

test("a search that was typed but not yet sent is dropped when the box is cleared", () => {
  const p = page();
  p.type("ben");
  p.box.fire("keydown", esc());
  p.runTimers();
  assert.equal(p.requests.length, 0, "nothing is asked of the server after the clear");
  assert.equal(p.results(), null);
});

test("an answer that arrives after the box was cleared does not bring the results back", async () => {
  const p = page();
  p.type("benchy"); p.runTimers();
  assert.equal(p.requests.length, 1);
  p.x.fire("click");
  p.requests[0].answer(FOUND);
  await p.settle();
  assert.equal(p.results(), null, "still the folder view");
});

test("the X sits in the search box, is a real button with a name, and shows only while the box holds text", () => {
  const box = /<div class="filter">([^]*?)<\/div>/.exec(html);
  assert.ok(box, "the search box");
  const input = /<input id="filter"[^>]*>/.exec(box[1]);
  const button = /<button[^>]*id="filterClear"[^>]*>/.exec(box[1]);
  assert.ok(input && button, "the box holds the field and the X");
  assert.ok(box[1].indexOf(button[0]) > box[1].indexOf(input[0]), "the X comes after the field");
  assert.match(button[0], /type="button"/);
  assert.match(button[0], /class="filter-clear"/);
  const key = /data-i18n-aria-label="([^"]+)"/.exec(button[0]);
  assert.ok(key, "its name is translated");
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  const text = key[1].split(".").reduce((o, k) => o && o[k], en);
  assert.equal(typeof text, "string", `"${key[1]}" is a text SnapCon ships`);
  assert.match(button[0], new RegExp('aria-label="' + text + '"'), "and the page carries the same words before translations load");
  // Shown or hidden by the field's own state, so it cannot disagree with it.
  assert.match(input[0], /placeholder="[^"]+"/, "an empty field shows its placeholder");
  assert.match(css, /\.filter input:placeholder-shown ~ \.filter-clear\{display:none;\}/);
});

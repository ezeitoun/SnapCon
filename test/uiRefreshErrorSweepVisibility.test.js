// test/uiRefreshErrorSweepVisibility.test.js — the Error light runs only on
// unacknowledged Error cards that are on screen, at most ERROR_SWEEP_MAX at a
// time, top of the page first (owner, 2026-11-06, after the Part 6
// measurements: 20 sweeping cards halved the frame rate). Off-screen and
// over-the-cap cards keep the static outline; visibility never acknowledges;
// one observer for the page, released when cards go; reduced motion makes no
// light at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function fakeCard(order) {
  const classes = new Set(); const kids = [];
  return {
    order, classes, kids, isConnected: true,
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
    querySelector: () => kids.find(k => k.className === "err-sweep") || null,
    prepend: el => { kids.unshift(el); el.remove = () => kids.splice(kids.indexOf(el), 1); },
    // DOCUMENT_POSITION_FOLLOWING (4) when the other card comes later.
    compareDocumentPosition: other => (other.order > order ? 4 : 2),
  };
}
function page({ io = true, reduce = false, refresh = true } = {}) {
  const store = {}; const observers = [];
  class FakeIO {
    constructor(cb) { this.cb = cb; this.watched = new Set(); observers.push(this); }
    observe(el) { this.watched.add(el); this.observeCalls = (this.observeCalls || 0) + 1; }
    unobserve(el) { this.watched.delete(el); }
    fire(el, isIntersecting) { this.cb([{ target: el, isIntersecting }]); }
  }
  const sandbox = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { createElement: () => ({ className: "", setAttribute() {} }) },
    printerShowsOffline: () => false, uiRefresh: () => sandbox.refreshOn, refreshOn: refresh,
    matchMedia: () => ({ matches: reduce, addEventListener() {} }),
    FLEET: [], CARD_CACHE: new Map(),
  };
  if (io) sandbox.IntersectionObserver = FakeIO;
  vm.createContext(sandbox);
  const a = appSrc.indexOf('const ERROR_ACKS_KEY="snapcon-error-acks";');
  const b = appSrc.indexOf("\n}", appSrc.indexOf("function acknowledgePrinterError(")) + 2;
  vm.runInContext(appSrc.slice(a, b) + "\nthis.api={ syncErrorSweep, acknowledgePrinterError, pruneErrorSweeps, ERROR_SWEEP_MAX, cards: ERROR_SWEEP_CARDS };", sandbox);
  const api = sandbox.api;
  const show = (p, card) => { if (!sandbox.FLEET.includes(p)) sandbox.FLEET.push(p); sandbox.CARD_CACHE.set(p.id, { el: card }); api.syncErrorSweep(card, p); return card; };
  return { api, show, observers, store, sandbox };
}
const err = (id, msg = "Heater extruder not heating") => ({ id, state: "error", errorCode: "KLIPPER", message: msg });
const lit = c => c.kids.some(k => k.className === "err-sweep");

test("an active card gets the light only while on screen; off screen it keeps the outline", () => {
  const pg = page();
  const card = pg.show(err(1), fakeCard(1));
  assert.ok(card.classes.has("is-error-active"), "outline and glow class at once");
  assert.equal(lit(card), false, "not known to be on screen yet: no light");
  const io = pg.observers[0];
  io.fire(card, true); assert.equal(lit(card), true);
  io.fire(card, false); assert.equal(lit(card), false);
  assert.ok(card.classes.has("is-error-active"), "still marked while off screen");
});

test("at most ERROR_SWEEP_MAX lights, top of the page first; a freed slot goes to the next card", () => {
  const pg = page();
  assert.equal(pg.api.ERROR_SWEEP_MAX, 4);
  const cards = [0, 1, 2, 3, 4, 5].map(i => pg.show(err(i), fakeCard(i)));
  const io = pg.observers[0];
  for (const c of [...cards].reverse()) io.fire(c, true);   // arrival order must not matter
  assert.deepEqual(cards.map(lit), [true, true, true, true, false, false]);
  pg.api.acknowledgePrinterError(1);
  assert.deepEqual(cards.map(lit), [true, false, true, true, true, false], "card 1 acknowledged: card 4 takes its slot");
  io.fire(cards[0], false);
  assert.deepEqual(cards.map(lit), [false, false, true, true, true, true]);
});

test("scrolling never acknowledges; an acknowledged card stays dark until a new occurrence", () => {
  const pg = page();
  const card = pg.show(err(7), fakeCard(7)); const io = pg.observers[0];
  io.fire(card, true); io.fire(card, false); io.fire(card, true);
  assert.equal(pg.store["snapcon-error-acks"], undefined, "visibility alone stored nothing");
  assert.ok(card.classes.has("is-error-active"));
  pg.api.acknowledgePrinterError(7);
  assert.equal(io.watched.has(card), false, "no longer observed once acknowledged");
  io.fire(card, true); pg.show(err(7), card);
  assert.equal(lit(card), false); assert.ok(card.classes.has("is-error-ack"));
  pg.show(err(7, "Heater bed not heating"), card);   // a new error
  assert.ok(card.classes.has("is-error-active")); assert.ok(io.watched.has(card), "observed again");
  io.fire(card, true); assert.equal(lit(card), true);
});

test("one observer for the page; each card observed once however often it is re-rendered", () => {
  const pg = page();
  const a = fakeCard(1), b = fakeCard(2);
  for (let i = 0; i < 5; i++) { pg.show(err(1), a); pg.show(err(2), b); }
  assert.equal(pg.observers.length, 1);
  assert.equal(pg.observers[0].observeCalls, 2);
});

test("removed or rebuilt cards and the switch turned off release the observer and the light", () => {
  const pg = page();
  const a = pg.show(err(1), fakeCard(1)), b = pg.show(err(2), fakeCard(2)); const io = pg.observers[0];
  io.fire(a, true); io.fire(b, true);
  a.isConnected = false; pg.api.pruneErrorSweeps();   // a was removed (or replaced by a rebuilt card)
  assert.equal(io.watched.has(a), false); assert.equal(lit(a), false); assert.equal(pg.api.cards.has(a), false);
  assert.equal(lit(b), true);
  pg.sandbox.refreshOn = false; pg.api.pruneErrorSweeps();
  assert.equal(io.watched.size, 0); assert.equal(lit(b), false); assert.equal(pg.api.cards.size, 0);
});

test("reduced motion: no light element at all, the outline stays", () => {
  const pg = page({ reduce: true });
  const card = pg.show(err(1), fakeCard(1)); pg.observers[0].fire(card, true);
  assert.equal(lit(card), false); assert.ok(card.classes.has("is-error-active"));
});

test("without IntersectionObserver every active card counts as on screen (still capped)", () => {
  const pg = page({ io: false });
  const cards = [0, 1, 2, 3, 4].map(i => pg.show(err(i), fakeCard(i)));
  assert.deepEqual(cards.map(lit), [true, true, true, true, false]);
});

test("the end of every renderFleet() prunes", () => {
  const rf = appSrc.slice(appSrc.indexOf("function renderFleet("), appSrc.indexOf("\n}", appSrc.indexOf("function renderFleet(")));
  assert.match(rf, /restoreFleetFocus\(focusKey, focused\);\n\s+pruneErrorSweeps\(\);/);
});

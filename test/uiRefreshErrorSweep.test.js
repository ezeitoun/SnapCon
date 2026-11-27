// test/uiRefreshErrorSweep.test.js — Part 4 of the design refresh: printer
// cards in Error (docs/ui-refresh-changes.md). Owner decisions, 2026-11-05:
// only state "error" is marked; unacknowledged errors sweep, acknowledged ones
// keep a static outline; a new code or message, or leaving Error and coming
// back, re-arms it; only an explicit choice acknowledges (a card click, or
// choosing that printer on the Health page — not its automatic pick); at most
// one acknowledgement per printer in localStorage; reduced motion shows the
// outline without the light.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "refresh.css"), "utf8");

function fakeCard() {
  const classes = new Set(); const kids = [];
  return {
    classes, kids,
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
    querySelector: () => kids.find(k => k.className === "err-sweep") || null,
    prepend: el => { kids.unshift(el); el.remove = () => kids.splice(kids.indexOf(el), 1); },
  };
}
function page({ stored = null, raw = null, refresh = true, offline = () => false } = {}) {
  const store = raw != null ? { "snapcon-error-acks": raw } : stored == null ? {} : { "snapcon-error-acks": JSON.stringify(stored) };
  const sandbox = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { createElement: () => ({ className: "", setAttribute() {} }) },
    printerShowsOffline: offline, uiRefresh: () => refresh,
    FLEET: [], CARD_CACHE: new Map(),
  };
  vm.createContext(sandbox);
  const a = appSrc.indexOf('const ERROR_ACKS_KEY="snapcon-error-acks";');
  const b = appSrc.indexOf("\n}", appSrc.indexOf("function acknowledgePrinterError(")) + 2;
  assert.ok(a > 0 && b > a);
  vm.runInContext(appSrc.slice(a, b) + "\nthis.api={ errorSweepState, syncErrorSweep, acknowledgePrinterError };", sandbox);
  const api = sandbox.api;
  const show = (p, card = fakeCard()) => { sandbox.FLEET = [p]; sandbox.CARD_CACHE.set(p.id, { el: card }); api.syncErrorSweep(card, p); return card; };
  const acks = () => JSON.parse(store["snapcon-error-acks"] || "{}");
  return { api, show, acks, store };
}
const err = (msg = "Heater extruder not heating at expected rate", code = "KLIPPER_ERROR", id = 3) => ({ id, state: "error", errorCode: code, message: msg });
const sweeping = c => c.classes.has("is-error-active") && c.kids.some(k => k.className === "err-sweep");
const acked = c => c.classes.has("is-error-ack") && !c.kids.length;

test("an unacknowledged error sweeps; acknowledging stops the light and keeps the outline", () => {
  const pg = page();
  const card = pg.show(err());
  assert.ok(sweeping(card));
  pg.api.acknowledgePrinterError(3);
  assert.ok(acked(card), "acknowledged at once, without waiting for the next poll");
  pg.show(err(), card);
  assert.ok(acked(card), "stays acknowledged on later polls");
});

test("a new code or message re-arms it", () => {
  const pg = page();
  const card = pg.show(err());
  pg.api.acknowledgePrinterError(3);
  pg.show(err("Heater bed not heating at expected rate"), card);
  assert.ok(sweeping(card), "different message");
  pg.api.acknowledgePrinterError(3);
  pg.show(err("Heater bed not heating at expected rate", "KLIPPER_SHUTDOWN"), card);
  assert.ok(sweeping(card), "different code");
});

test("leaving Error and coming back re-arms it, even with the same message", () => {
  const pg = page();
  const card = pg.show(err());
  pg.api.acknowledgePrinterError(3);
  pg.show({ id: 3, state: "standby", errorCode: "", message: "" }, card);
  assert.deepEqual([card.classes.size, card.kids.length], [0, 0], "nothing on a printer that is not in Error");
  pg.show(err(), card);
  assert.ok(sweeping(card));
});

test("persistence: an acknowledgement survives a reload; at most one per printer; dropped when the printer leaves Error", () => {
  const pg = page();
  pg.show(err("A", "X", 1)); pg.show(err("B", "Y", 2));
  pg.api.acknowledgePrinterError(1); pg.api.acknowledgePrinterError(2);
  pg.show(err("A2", "X", 1)); pg.api.acknowledgePrinterError(1);   // a second error on printer 1 replaces its record
  assert.deepEqual(Object.keys(pg.acks()).sort(), ["1", "2"]);
  // A reload: the same error on printer 2 is still acknowledged; printer 1's new error is not.
  const again = page({ stored: pg.acks() });
  assert.ok(acked(again.show(err("B", "Y", 2))));
  assert.ok(acked(again.show(err("A2", "X", 1))));
  assert.ok(sweeping(again.show(err("A3", "X", 1))), "the stored key is the old message: a new one sweeps");
  // Leaving Error removes the record, so storage never grows past the printers in Error.
  again.show({ id: 2, state: "printing" });
  // Printer 2 left Error: its record is gone. Printer 1 is still in Error: its one record stays (the
  // older message, so it does not match) until it is acknowledged again or leaves Error.
  assert.deepEqual(Object.keys(again.acks()), ["1"]);
  // Unreadable or wrong-shaped storage starts empty, without throwing.
  for (const raw of ["{not json", "[1,2]", "null", "42"]) assert.ok(sweeping(page({ raw }).show(err())), raw);
});

test("only the Error state is marked: not printing, paused, maintenance or offline with an error code", () => {
  for (const state of ["printing", "paused", "maintenance", "complete", "cancelled", "standby"]) {
    const c = page().show({ id: 5, state, errorCode: "E0123", message: "Nozzle clog suspected" });
    assert.deepEqual([c.classes.size, c.kids.length], [0, 0], state);
  }
  const off = page({ offline: () => true }).show(err());
  assert.deepEqual([off.classes.size, off.kids.length], [0, 0], "an offline printer last seen in Error");
});

test("nothing is acknowledged while the refresh is off", () => {
  const pg = page({ refresh: false });
  const card = pg.show(err());
  pg.api.acknowledgePrinterError(3);
  assert.deepEqual(pg.acks(), {});
});

test("hooks: every card render, any card click, and only explicit Health choices", () => {
  assert.match(appSrc, /if\(uiRefresh\(\)\) syncErrorSweep\(el, p\);/);
  const rec = appSrc.slice(appSrc.indexOf("function reconcileFleetCards("), appSrc.indexOf("function renderFleet("));
  assert.ok(rec.includes("syncErrorSweep(el, p)"), "in reconcileFleetCards, for reused and rebuilt cards alike");
  assert.match(appSrc, /\$\("fleet"\)\.addEventListener\("click", e=>\{\n\s+\/\/ UI-REFRESH Part 4[^\n]*\n\s+\{ const c=e\.target\.closest && e\.target\.closest\("\.pcard\[data-pid\]"\); if\(c\) acknowledgePrinterError\(c\.dataset\.pid\); \}/);
  const open = appSrc.slice(appSrc.indexOf("function openHealthPage(printerId){"), appSrc.indexOf("function selectHealthPrinter("));
  assert.match(open, /if\(id!=null\) acknowledgePrinterError\(id\);\n\s+if\(id==null\)\{/, "before the automatic pick, only for a named printer");
  const select = appSrc.slice(appSrc.indexOf("function selectHealthPrinter("), appSrc.indexOf("\n}", appSrc.indexOf("function selectHealthPrinter(")));
  assert.doesNotMatch(select, /acknowledgePrinterError/, "selecting by itself (the automatic pick goes through it) never acknowledges");
  assert.match(appSrc, /selectHealthPrinter\(id\); acknowledgePrinterError\(id\); \}\);   \/\/ UI-REFRESH Part 4/, "the Health page's printer chips");
  assert.match(appSrc, /else \{ selectHealthPrinter\(id\); if\(id!=null\) acknowledgePrinterError\(id\); \}/, "back and forward to /health/<id>");
});

test("the CSS: an inner ring that ignores the pointer, turned by transform, sized from the card, hidden for reduced motion", () => {
  const part4 = css.slice(css.indexOf("UI-REFRESH Part 4"));
  assert.match(part4, /\.pcard > \.err-sweep\{[^}]*pointer-events:none/);
  assert.match(part4, /\.pcard > \.err-sweep\{[^}]*mask-composite:exclude/);
  assert.match(part4, /@keyframes snc-error-sweep\{ to\{ transform:rotate\(1turn\); \} \}/);
  assert.doesNotMatch(part4, /vmax|vmin/, "never a viewport-sized layer per card");
  assert.match(part4, /@media \(prefers-reduced-motion: reduce\)\{\s*html\.ui-refresh \.pcard > \.err-sweep\{ display:none; \}/);
  // The static outline is on the card in both states, independent of motion.
  assert.match(part4, /html\.ui-refresh \.pcard\.is-error-active,\s*html\.ui-refresh \.pcard\.is-error-ack\{[^}]*box-shadow:0 0 0 1px color-mix\(in srgb,var\(--bad\) 30%,transparent\)/);
  // Owner, 2026-11-06: 3px, full brightness, 2.5s; a static glow on unacknowledged cards only.
  assert.match(part4, /\.pcard > \.err-sweep\{[^}]*padding:3px/);
  assert.match(part4, /conic-gradient\(transparent 0deg, var\(--bad\) 60deg, transparent 150deg\)/);
  assert.match(part4, /animation:snc-error-sweep 2\.5s linear infinite/);
  assert.match(part4, /html\.ui-refresh \.pcard\.is-error-active\{\s*box-shadow:0 0 0 1px color-mix\(in srgb,var\(--bad\) 30%,transparent\), 0 0 24px -8px var\(--bad\);\s*\}/);
  assert.doesNotMatch(part4, /is-error-ack\{[^}]*24px/, "an acknowledged card has no glow");
  assert.doesNotMatch(part4, /@keyframes[^}]*box-shadow/, "the glow is never animated");
  // The card itself never clips: the Compact menu and tag tints stay.
  assert.doesNotMatch(part4, /\.pcard\.is-error-[a-z]+[^{]*\{[^}]*overflow:hidden/);
});

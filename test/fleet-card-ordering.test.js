// test/fleet-card-ordering.test.js — reconcileFleetCards()'s DOM ordering.
//
// The reconciler used to finish every card with an unconditional
// wrap.appendChild(el). For a card that was already in the right place that
// is still a remove + insert as far as the DOM is concerned, and removing a
// focused element resets focus to <body> — so keyboard focus fell off a card
// on every poll even when the card itself was successfully reused. It also
// meant a full pass of DOM moves on every render regardless of whether
// anything had actually moved.
//
// It now walks a cursor and only touches cards that are genuinely out of
// place. That is a correctness-critical change (fleet order is user-visible
// and drag-reorderable), so rather than assert on source text this file
// extracts the real function and runs it against a minimal fake DOM that
// implements exactly the four operations the algorithm uses — including
// insertBefore()'s throw when the reference node is not a child, which is the
// specific hazard the cursor guard exists to prevent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function extractFn(name) {
  const start = appSrc.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " must exist in public/app.js");
  const end = appSrc.indexOf("\n}", start);
  return appSrc.slice(start, end + 2);
}

// ---- minimal DOM: only what the algorithm actually calls ----
function makeWrap(counts) {
  const children = [];
  const wrap = {
    children,
    get firstChild() { return children[0] || null; },
    insertBefore(el, ref) {
      counts.inserts++;
      if (ref !== null && ref !== undefined && children.indexOf(ref) < 0) {
        throw new Error("NotFoundError: the reference node is not a child of this node");
      }
      const cur = children.indexOf(el);
      if (cur >= 0) children.splice(cur, 1);
      const at = (ref === null || ref === undefined) ? children.length : children.indexOf(ref);
      children.splice(at, 0, el);
      return el;
    },
    appendChild(el) { counts.appends++; return wrap.insertBefore(el, null); },
    ids() { return children.map(c => c.id); }
  };
  return wrap;
}
function makeEl(id, wrap, counts) {
  return {
    id,
    get nextSibling() { const i = wrap.children.indexOf(this); return i >= 0 ? (wrap.children[i + 1] || null) : null; },
    remove() { counts.removes++; const i = wrap.children.indexOf(this); if (i >= 0) wrap.children.splice(i, 1); },
    querySelector() { return null; }
  };
}

// Build a sandbox running the REAL reconcileFleetCards.
function harness() {
  const counts = { inserts: 0, appends: 0, removes: 0, builds: 0, liveUpdates: 0, closes: [] };
  const wrap = makeWrap(counts);
  const sandbox = {
    CARD_CACHE: new Map(),
    VIEW_MODE: "regular",
    CAM_STAGGER: false,
    neededColors: () => [],
    // Test-controlled signature: `sig` on the fixture decides structural change.
    cardSignature: p => JSON.stringify({ sig: p.sig }),
    buildCardHtml: p => { counts.builds++; return makeEl(p.id, wrap, counts); },
    updateFleetCardLiveValues: () => { counts.liveUpdates++; },
    closeCamRtc: id => { counts.closes.push(id); },
    // A removed card releases every camera transport it might have been using;
    // the relayed one (Bambu) is closed alongside WebRTC.
    closeCamStream: () => {},
    mountCamShot: () => {}, mountCamRtc: () => {}, mountCamStream: () => {},
    Set, Map, JSON
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn("reconcileFleetCards"), sandbox);
  const run = (fleet, incremental = true) => {
    counts.inserts = 0; counts.appends = 0; counts.removes = 0; counts.builds = 0; counts.liveUpdates = 0; counts.closes = [];
    sandbox.reconcileFleetCards(fleet, wrap, 6000, false, incremental);
    return { order: wrap.ids(), ...counts, closes: [...counts.closes] };
  };
  return { run, wrap, sandbox, counts };
}
const P = (id, sig = "v1") => ({ id, sig });

// ---------------------------------------------------------------------------

test("first render inserts every card in fleet order", () => {
  const h = harness();
  const r = h.run([P(1), P(2), P(3)], false);
  assert.deepEqual(r.order, [1, 2, 3]);
  assert.equal(r.builds, 3);
});

test("an unchanged fleet performs ZERO DOM mutations — the whole point of the change", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  const r = h.run([P(1), P(2), P(3)]);
  assert.deepEqual(r.order, [1, 2, 3]);
  assert.equal(r.inserts, 0, "no insertBefore");
  assert.equal(r.appends, 0, "no appendChild");
  assert.equal(r.removes, 0, "no remove");
  assert.equal(r.builds, 0, "no rebuild");
  assert.equal(r.liveUpdates, 3, "every reused card still gets its live values");
});

test("a live-only change still mutates nothing but still patches the cards", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  // same sig (structural), different live values — the sig is what this
  // reconciler sees, so an unchanged sig is exactly the live-only case.
  const r = h.run([P(1), P(2), P(3)]);
  assert.equal(r.inserts + r.appends + r.removes, 0);
  assert.equal(r.liveUpdates, 3);
});

test("a reordered fleet produces the correct order with the minimum moves", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  const r = h.run([P(3), P(1), P(2)]);
  assert.deepEqual(r.order, [3, 1, 2]);
  assert.equal(r.inserts, 1, "moving one card to the front is one operation");
  assert.equal(r.builds, 0, "reordering must not rebuild anything");
});

test("a full reversal still lands in the right order", () => {
  const h = harness();
  h.run([P(1), P(2), P(3), P(4)], false);
  const r = h.run([P(4), P(3), P(2), P(1)]);
  assert.deepEqual(r.order, [4, 3, 2, 1]);
});

test("a printer added at the end appends", () => {
  const h = harness();
  h.run([P(1), P(2)], false);
  const r = h.run([P(1), P(2), P(3)]);
  assert.deepEqual(r.order, [1, 2, 3]);
  assert.equal(r.builds, 1);
});

test("a printer added in the middle lands in the middle", () => {
  const h = harness();
  h.run([P(1), P(3)], false);
  const r = h.run([P(1), P(2), P(3)]);
  assert.deepEqual(r.order, [1, 2, 3]);
  assert.equal(r.builds, 1);
  assert.equal(r.inserts, 1, "only the new card is inserted; 1 and 3 are untouched");
});

test("a printer added at the front lands at the front", () => {
  const h = harness();
  h.run([P(2), P(3)], false);
  const r = h.run([P(1), P(2), P(3)]);
  assert.deepEqual(r.order, [1, 2, 3]);
});

test("a removed printer is dropped and the rest keep their order and their nodes", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  const before = h.wrap.children.slice();
  const r = h.run([P(1), P(3)]);
  assert.deepEqual(r.order, [1, 3]);
  assert.equal(h.sandbox.CARD_CACHE.has(2), false, "the removed printer leaves the cache");
  assert.equal(h.wrap.children[0], before[0], "surviving nodes are the same objects");
  assert.equal(h.wrap.children[1], before[2]);
  assert.equal(r.closes.includes(2), true, "its camera session is closed");
});

test("a filtered-out middle printer is removed and the survivors need one move", () => {
  // Exercises the case where a stale node sits between two kept ones while
  // the cursor is walking — the survivor has to step over it.
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  const r = h.run([P(1), P(3)]);
  assert.deepEqual(r.order, [1, 3]);
  assert.equal(r.builds, 0, "filtering must not rebuild the survivors");
});

test("filtering down to nothing and back restores the full order", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  assert.deepEqual(h.run([]).order, []);
  const r = h.run([P(1), P(2), P(3)]);
  assert.deepEqual(r.order, [1, 2, 3]);
  assert.equal(r.builds, 3, "cards dropped from the cache are rebuilt on return");
});

test("a structural change rebuilds that card IN PLACE without disturbing its neighbours", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  const before = h.wrap.children.slice();
  const r = h.run([P(1), P(2, "v2"), P(3)]);
  assert.deepEqual(r.order, [1, 2, 3]);
  assert.equal(r.builds, 1, "only the changed card rebuilds");
  assert.equal(h.wrap.children[0], before[0], "neighbour node untouched");
  assert.equal(h.wrap.children[2], before[2], "neighbour node untouched");
  assert.notEqual(h.wrap.children[1], before[1], "the changed card is a new node");
  assert.deepEqual(r.closes, [2], "only the rebuilt card's camera session is torn down");
});

test("rebuilding the LAST card does not throw — the cursor steps off a node about to be detached", () => {
  // Without the `if(cursor===cached.el) cursor=cursor.nextSibling` guard the
  // cursor would still point at the node just removed, and insertBefore()
  // against a detached reference throws NotFoundError.
  const h = harness();
  h.run([P(1), P(2)], false);
  const r = h.run([P(1), P(2, "v2")]);
  assert.deepEqual(r.order, [1, 2]);
});

test("rebuilding EVERY card at once keeps the order", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  const r = h.run([P(1, "v2"), P(2, "v2"), P(3, "v2")]);
  assert.deepEqual(r.order, [1, 2, 3]);
  assert.equal(r.builds, 3);
});

test("a rebuild combined with a reorder still lands correctly", () => {
  const h = harness();
  h.run([P(1), P(2), P(3)], false);
  const r = h.run([P(3, "v2"), P(1), P(2)]);
  assert.deepEqual(r.order, [3, 1, 2]);
});

test("add, remove, reorder and rebuild in one pass", () => {
  const h = harness();
  h.run([P(1), P(2), P(3), P(4)], false);
  const r = h.run([P(4), P(2, "v2"), P(5)]);   // 1 and 3 gone, 5 new, 2 rebuilt, order changed
  assert.deepEqual(r.order, [4, 2, 5]);
  assert.equal(h.sandbox.CARD_CACHE.has(1), false);
  assert.equal(h.sandbox.CARD_CACHE.has(3), false);
});

test("a non-incremental pass still rebuilds everything in order (the caller clears the wrap first)", () => {
  const h = harness();
  h.run([P(1), P(2)], false);
  const r = h.run([P(1), P(2)], false);
  assert.deepEqual(r.order, [1, 2]);
  assert.equal(r.builds, 2, "incremental:false must never reuse a node");
});

test("foreign nodes in the wrap do not corrupt card order", () => {
  // A leftover skeleton card, or the "unreachable" message loadFleet() writes
  // when the first poll fails, is not owned by this reconciler. Cards must
  // still come out in fleet order around it.
  const h = harness();
  const counts = { inserts: 0, appends: 0, removes: 0 };
  const foreign = makeEl("foreign", h.wrap, counts);
  h.wrap.children.push(foreign);
  const r = h.run([P(1), P(2), P(3)], false);
  assert.deepEqual(r.order.filter(x => x !== "foreign"), [1, 2, 3]);
  assert.equal(h.wrap.children.includes(foreign), true, "not this function's node to remove");
});

test("the reconciler no longer contains an unconditional appendChild", () => {
  const fn = extractFn("reconcileFleetCards");
  assert.equal(/wrap\.appendChild\(el\);/.test(fn), false, "the unconditional append is what dropped focus");
  assert.match(fn, /if\(el===cursor\) cursor=cursor\.nextSibling;/);
  assert.match(fn, /else wrap\.insertBefore\(el, cursor\);/);
  assert.match(fn, /if\(cursor===cached\.el\) cursor=cursor\.nextSibling;/);
  // The guard must come before the detach, or insertBefore throws.
  const guard = fn.indexOf("if(cursor===cached.el)");
  const detach = fn.indexOf("cached.el.remove()");
  assert.ok(guard > 0 && guard < detach, "cursor must step off the node before it is detached");
});

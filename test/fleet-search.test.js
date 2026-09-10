// test/fleet-search.test.js — the fleet search box's match predicate.
//
// Two real bugs, both found live on a 20+ printer farm:
//
// 1. Searching "blue" returned U1 Navy, Brown, Red and Orange but NOT U1 Blue.
//    A query that happens to name a colour family took an EXCLUSIVE branch
//    (`if (isColor) return matchesColorFamily(...)`) and returned before the
//    name/brand/status text match could run — so printers were matched purely
//    on loaded filament, and the one actually named Blue was hidden because its
//    spools were cream and yellow. Searching "U1 Blue" worked, since that
//    string is not a colour-family key and fell through to the text match.
//    Colour now ADDS to the text match instead of replacing it.
//
// 2. matchesColorFamily has explicit handling for white/black/grey/gray, but
//    none of those are keys in COLOR_FAMILIES and the gate was
//    `q in COLOR_FAMILIES` — so that code was unreachable and searching
//    "white" only ever did a text match.
//
// Plus the "@" multi-colour filter: "@red,blue,white" answers "which printers
// can print this 3-colour file", so each named colour must be satisfied by a
// DISTINCT loaded head — one red spool must not satisfy "@red,red".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// The colour helpers and the predicate are one contiguous region: hexToHsl,
// COLOR_FAMILIES, matchesColorFamily, then the search functions.
function extractRegion(startMarker, endMarker) {
  const start = appSrc.indexOf(startMarker);
  assert.ok(start > 0, "missing in public/app.js: " + startMarker);
  const endAt = appSrc.indexOf(endMarker, start);
  assert.ok(endAt > start, "missing in public/app.js: " + endMarker);
  return appSrc.slice(start, endAt);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(extractRegion("function hexToHsl(", "function needsDarkText("), sandbox);

const q = (p, query) => vm.runInContext("matchesFleetQuery", sandbox)(p, query);

const head = hex => ({ loaded: true, hex, material: "PLA" });
// The real fleet at the time of the bug report.
const BLUE   = { name: "U1 Blue",   brand: "Snapmaker", online: true, state: "standby",
                 heads: [head("#FEE5A5"), head("#F8F81C"), head("#FFFFFF"), head("#000000")] };
const NAVY   = { name: "U1 Navy",   brand: "Snapmaker", online: true, state: "standby",
                 heads: [head("#E65100"), head("#39FF14"), head("#BCC2C8"), head("#000000")] };
const ORANGE = { name: "U1 Orange", brand: "Snapmaker", online: true, state: "standby",
                 heads: [head("#080A0D"), head("#FFFFFF"), head("#1E88E5")] };

test('searching a colour name still finds a printer NAMED that colour', () => {
  assert.equal(q(BLUE, "blue"), true,
    'U1 Blue must appear when searching "blue" even though none of its spools are blue');
});

test('searching a colour name still finds printers LOADED with that colour', () => {
  assert.equal(q(ORANGE, "blue"), true, "U1 Orange has a #1E88E5 spool");
});

test('a colour query does not match an unrelated printer', () => {
  assert.equal(q(NAVY, "magenta"), false);
});

test("name matching keeps working for non-colour queries", () => {
  assert.equal(q(BLUE, "u1 blue"), true);
  assert.equal(q(BLUE, "snapmaker"), true);
  assert.equal(q(BLUE, "u1 navy"), false);
});

test('achromatic families are reachable: "white" matches a white spool', () => {
  assert.equal(q(ORANGE, "white"), true, "#FFFFFF is loaded — this branch existed but was unreachable");
  assert.equal(q(BLUE, "black"), true, "#000000 is loaded");
});

test('"@" filter: every named colour must be present', () => {
  assert.equal(q(BLUE, "@white,black"), true, "U1 Blue has both white and black");
  assert.equal(q(BLUE, "@white,red"), false, "no red spool, so the set is not satisfied");
});

test('"@" filter: each colour needs its OWN head, so duplicates need duplicate spools', () => {
  const oneWhite = { name: "X", brand: "B", online: true, state: "standby",
                     heads: [head("#FFFFFF"), head("#000000")] };
  assert.equal(q(oneWhite, "@white"), true);
  assert.equal(q(oneWhite, "@white,white"), false,
    "one white spool cannot satisfy a two-white file");
});

test('"@" filter: assignment must not fail through a greedy first choice', () => {
  // #1E88E5 is blue (hue 208); #8A2BE2 is violet (hue 271) but ALSO nothing
  // else. A naive matcher is not stressed here, but a correct one must still
  // place both -- and this documents the real hue boundaries.
  const p = { name: "X", brand: "B", online: true, state: "standby",
              heads: [head("#1E88E5"), head("#8A2BE2")] };
  assert.equal(q(p, "@blue,violet"), true);
});

test('"@" filter: an unrecognised colour name matches nothing rather than widening', () => {
  assert.equal(q(BLUE, "@white,notacolour"), false);
});

test("percentage queries still work and are unaffected", () => {
  const printing = { name: "P", brand: "B", online: true, state: "printing", progress: 0.5, heads: [] };
  assert.equal(q(printing, ">40%"), true);
  assert.equal(q(printing, ">60%"), false);
  assert.equal(q({ ...printing, online: false }, ">40%"), false, "offline has no progress to compare");
});

test("status text remains searchable", () => {
  const printing = { name: "P", brand: "B", online: true, state: "printing", progress: 0.5, heads: [] };
  assert.equal(q(printing, "printing"), true);
  assert.equal(q({ ...printing, online: false }, "offline"), true);
});

// Found while writing the tests above: achromatic colours report hue 0, and the
// red family spans [0,15] -- so before the saturation/lightness guard in
// matchesColorFamily, every white and black spool matched a search for "red".
// On a farm where most printers carry a white or black spool that made "red"
// match almost everything.
test("a white or black spool must not match a hue family like red", () => {
  const p = { name: "X", brand: "B", online: true, state: "standby",
              heads: [head("#FFFFFF"), head("#000000")] };
  assert.equal(q(p, "red"), false, "hue 0 on an unsaturated colour is not red");
  assert.equal(q(p, "white"), true, "but the achromatic families still work");
  assert.equal(q(p, "black"), true);
});

test("a genuinely red spool still matches red", () => {
  const p = { name: "X", brand: "B", online: true, state: "standby", heads: [head("#E01B24")] };
  assert.equal(q(p, "red"), true);
});

// test/libraryClosesFiles.test.js — opening the Library closes the file
// manager (owner, 2026-11-27).
//
// The Library is a full page; the file manager stayed open beside it. It is
// now closed when the Library opens, the same way its own button closes it
// (FILES_OPEN off, then applyFilesOpen(), which also drops the selection).
// It is not reopened when the Library is left.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "library.js"), "utf8");
function extractFn(name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, "public/library.js has " + name + "()");
  return src.slice(at, src.indexOf("\n  }\n", at) + 4);
}
function page({ filesOpen, libraryOpen = false }) {
  const calls = [];
  const el = { classList: { add() {}, remove() {} }, setAttribute() {}, title: "" };
  const ctx = vm.createContext({
    $: () => el, t: k => k, L: { open: libraryOpen }, calls,
    hideFleet: () => calls.push("hideFleet"), route: p => calls.push("route " + p),
    closeQueueDashboard() {}, closeHealthPage() {}, syncTopbarActive() {}, window: {},
  });
  // FILES_OPEN is a top-level `let` of app.js, shared by the page's scripts.
  vm.runInContext(`let FILES_OPEN=${filesOpen}; function applyFilesOpen(){ calls.push("applyFilesOpen " + FILES_OPEN); }\n` + extractFn("openPage"), ctx);
  return { open: p => vm.runInContext(`openPage(${JSON.stringify(p)}, true)`, ctx), calls, filesOpen: () => vm.runInContext("FILES_OPEN", ctx) };
}

test("opening the Library with the file manager open closes it, as its own button would", () => {
  const p = page({ filesOpen: true });
  p.open("/library");
  assert.equal(p.filesOpen(), false);
  assert.deepEqual(p.calls.filter(c => c.startsWith("applyFilesOpen")), ["applyFilesOpen false"]);
  assert.ok(p.calls.includes("route /library"), "and the Library opens");
});

test("with the file manager already closed nothing is applied again", () => {
  const p = page({ filesOpen: false });
  p.open("/library");
  assert.deepEqual(p.calls.filter(c => c.startsWith("applyFilesOpen")), []);
  assert.ok(p.calls.includes("route /library"));
});

test("moving inside the Library does not touch the file manager", () => {
  // The Library is already open; the operator opened the file manager from
  // the top bar meanwhile and then follows a link to a Model.
  const p = page({ filesOpen: true, libraryOpen: true });
  p.open("/library/attention");
  assert.equal(p.filesOpen(), true);
  assert.deepEqual(p.calls.filter(c => c.startsWith("applyFilesOpen")), []);
});

// test/sendModalUploadFill.test.js — the Send modal's Upload button fills as
// the transfer runs, the same way the card's own Upload button always has.
//
// The card button fills because pushTo() finds it by printer id
// (button[data-id][data-start]) and hands it to pollJob. The modal's buttons
// carry no such attributes — they belong to no single printer — so they were
// never filled, while each printer ROW in the modal filled instead. One click
// there can upload to several printers at once, so the button shows the
// transfer as a whole.
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
  return appSrc.slice(start, appSrc.indexOf("\n}", start) + 2);
}

const sandbox = { Math };
vm.createContext(sandbox);
vm.runInContext(extractFn("aggregateFillPct"), sandbox);
const aggregate = (m) => vm.runInContext("aggregateFillPct", sandbox)(m);

test("one printer's progress is the button's progress", () => {
  assert.equal(aggregate(new Map([["p1", 42]])), 42);
});

test("several printers average into one honest number", () => {
  // Not the furthest ahead: a button that reached 100% while a second printer
  // was still at 10% would claim the upload had finished.
  assert.equal(aggregate(new Map([["p1", 100], ["p2", 0]])), 50);
  assert.equal(aggregate(new Map([["p1", 100], ["p2", 50], ["p3", 0]])), 50);
});

test("a printer that has not started yet still counts", () => {
  assert.equal(aggregate(new Map([["p1", 80], ["p2", 0]])), 40);
});

test("nothing in flight leaves the button empty rather than full", () => {
  assert.equal(aggregate(new Map()), 0);
});

test("the modal passes its own button so the fill has something to paint", () => {
  const fn = appSrc.slice(appSrc.indexOf("async function doSendUpload("),
                          appSrc.indexOf("\n}", appSrc.indexOf("async function doSendUpload(")));
  assert.match(fn, /doUploadPrint|doUpload/, "the clicked button is identified");
  assert.match(fn, /aggregateFillPct|onProgress/, "and progress reaches it");
});

test("the card's own Upload button keeps filling exactly as before", () => {
  // The mechanism the card relies on: found by printer id, handed to pollJob.
  const fn = appSrc.slice(appSrc.indexOf("async function pushTo("),
                          appSrc.indexOf("\n}", appSrc.indexOf("async function pushTo(")));
  assert.match(fn, /button\[data-id="\$\{printer\}"\]\[data-start="\$\{start\?'1':'0'\}"\]/);
  assert.match(fn, /pollJob\(/);
});

test("the button is left clean when the upload ends", () => {
  // A button still showing a half-finished gradient after a failure reads as
  // an upload that is still running.
  const fn = appSrc.slice(appSrc.indexOf("async function doSendUpload("),
                          appSrc.indexOf("\n}", appSrc.indexOf("async function doSendUpload(")));
  assert.match(fn, /style\.background=''/);
});

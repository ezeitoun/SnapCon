// test/cardSendFill.test.js — a card's Upload / Print button is the progress
// bar while a send runs, and keeps showing it when the card is rebuilt.
//
// The bug: pushTo() captured the button and pollJob() filled it, but the
// "Uploading" status badge forces a card rebuild that replaces the button, so
// every fill landed on a detached node and the user never saw progress. The
// rebuilt button also came back enabled mid-upload. The fill now lives in
// SEND_FILL and the card's own HTML is built from it (sendBtnAttrs), like the
// Health page's sync buttons.
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

let renders = 0;
const onScreen = [];   // what document.querySelectorAll finds: the card's CURRENT buttons
const sandbox = {
  Map, String,
  renderFleet: () => { renders++; },
  document: { querySelectorAll: () => onScreen },
};
vm.createContext(sandbox);
vm.runInContext("const SEND_FILL = new Map();\n" + ["fillBackground", "sendBtnAttrs", "setSendFill"].map(extractFn).join("\n"), sandbox);
const run = src => vm.runInContext(src, sandbox);
const attrs = (start, enabled) => run(`sendBtnAttrs({ id: 4 }, ${start}, ${enabled})`);

test.beforeEach(() => { run("SEND_FILL.clear()"); renders = 0; onScreen.length = 0; });

test("no send: the button's own enabled rule applies, unchanged", () => {
  assert.equal(attrs(false, true), "");
  assert.equal(attrs(false, false), "disabled");
});

test("a rebuilt card shows the send's progress on the right button, and keeps it disabled", () => {
  run("setSendFill(4, false, 0)");
  run("setSendFill(4, false, 37)");
  const html = attrs(false, true);
  assert.match(html, /^disabled style="background:linear-gradient\(to right, rgba\(167,139,250,0\.55\) 37%, rgba\(167,139,250,0\.13\) 37%\)"$/);
  assert.equal(attrs(true, true), "", "the Print button is not the one filling");
  assert.equal(run('sendBtnAttrs({ id: 5 }, false, true)'), "", "nor another printer's");
});

test("starting and ending a send re-render the card; a new percentage is painted on the button on screen", () => {
  run("setSendFill(4, true, 0)");
  assert.equal(renders, 1, "start: the card rebuilds disabled and filled");
  const btn = { style: {} };
  onScreen.push(btn);
  run("setSendFill(4, true, 55)");
  assert.equal(renders, 1, "no rebuild per progress tick");
  assert.match(btn.style.background, /55%/, "the current button, found at paint time, not a captured one");
  run("setSendFill(4, true, null)");
  assert.equal(renders, 2, "end: the card rebuilds with its normal button");
  assert.equal(attrs(true, true), "");
  run("setSendFill(4, true, null)");
  assert.equal(renders, 2, "ending twice is harmless");
});

test("the card and the list row render the Upload and Print buttons through sendBtnAttrs", () => {
  // The list row: exactly as before (its button still fills).
  assert.equal((appSrc.match(/\$\{sendBtnAttrs\(p,false,canSend&&canAct\(\)\)\} data-id="\$\{p\.id\}" data-start="0"/g) || []).length, 1);
  assert.equal((appSrc.match(/\$\{sendBtnAttrs\(p,true,p\.online&&!busy&&!maintMode&&canAct\(\)\)\} data-id="\$\{p\.id\}" data-start="1"/g) || []).length, 1);
  // The card: no fill (its upload strip shows progress); both disabled while a send runs.
  assert.equal((appSrc.match(/\$\{sendBtnAttrs\(p,false,canSend&&canAct\(\),\{card:true\}\)\} data-id="\$\{p\.id\}" data-start="0"/g) || []).length, 1);
  assert.equal((appSrc.match(/\$\{sendBtnAttrs\(p,true,p\.online&&!busy&&!maintMode&&canAct\(\),\{card:true\}\)\} data-id="\$\{p\.id\}" data-start="1"/g) || []).length, 1);
});

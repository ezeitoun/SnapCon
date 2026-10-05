// test/cardStatusPersistence.test.js — a print/upload result written on a
// fleet card must survive the re-render that finishing the action causes.
//
// The bug, reported live: a file was sent to an AD5X, the card showed the
// upload, then went back to Idle with no message. The connector had in fact
// refused to start the print with a long explanatory error — the user never
// saw a word of it.
//
// Why it vanished:
//   1. pollJob writes the error into the card's .pstatus element.
//   2. its `finally { clearOverride() }` removes the phase badge, which calls
//      renderFleet({incremental:true}).
//   3. cardSignature() INCLUDES statusOverride (deliberately, app.js ~5442),
//      so removing it always changes the signature.
//   4. reconcileFleetCards only preserves .pstatus on a REUSED node
//      ("The reused node keeps ... its .pstatus text", app.js ~5719); a
//      changed signature rebuilds the card, and buildCardHtml emits an empty
//      .pstatus.
// So the act of finishing the operation destroyed the message describing how
// it finished — and pushTo's own loadFleet() would have wiped it again.
//
// The fix mirrors STATUS_OVERRIDE, which already exists for exactly this
// class of problem: client-only state a card rebuild must not lose.
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
function extractConst(decl) {
  const at = appSrc.indexOf(decl);
  assert.ok(at > 0, decl + " must exist in public/app.js");
  return appSrc.slice(at, appSrc.indexOf("\n", at) + 1);
}

let renders = 0;
const sandbox = {
  esc: s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  renderFleet: () => { renders++; },
  t: k => k,
  Map,
};
vm.createContext(sandbox);
vm.runInContext(extractConst("const CARD_STATUS"), sandbox);
vm.runInContext(extractConst("const UPLOAD_CANCEL"), sandbox);
for (const fn of ["setCardStatus", "cardStatusFor", "cardStatusHtml"]) {
  vm.runInContext(extractFn(fn), sandbox);
}
const call = (n, ...a) => vm.runInContext(n, sandbox)(...a);
const reset = () => { vm.runInContext("CARD_STATUS.clear(); UPLOAD_CANCEL.clear()", sandbox); renders = 0; };

test.beforeEach(reset);

test("a card with no message renders the same empty status line as before", () => {
  const html = call("cardStatusHtml", { id: 7 });
  assert.match(html, /id="pst-7"/);
  assert.match(html, /class="pstatus"/);
  assert.match(html, /><\/div>$/, "no text");
});

test("a stored message is rendered into the card that gets rebuilt", () => {
  // This is the whole point: buildCardHtml must be able to put the message
  // back, because the card it was written on no longer exists.
  call("setCardStatus", 7, "pstatus err", "Starting a print over Moonraker is not yet verified");
  const html = call("cardStatusHtml", { id: 7 });
  assert.match(html, /class="pstatus err"/);
  assert.match(html, /not yet verified/);
});

test("the message is per printer and does not leak to another card", () => {
  call("setCardStatus", 7, "pstatus err", "boom");
  assert.doesNotMatch(call("cardStatusHtml", { id: 8 }), /boom/);
});

test("an empty message clears the line", () => {
  call("setCardStatus", 7, "pstatus err", "boom");
  call("setCardStatus", 7, "pstatus", "");
  assert.equal(call("cardStatusFor", { id: 7 }), null);
  assert.doesNotMatch(call("cardStatusHtml", { id: 7 }), /boom/);
});

test("connector error text is escaped on its way into the card", () => {
  // A printer-returned string reaching the DOM is a trust boundary
  // (CLAUDE.md section 8) — and these messages come straight from a connector.
  call("setCardStatus", 7, "pstatus err", '<img src=x onerror="alert(1)">');
  const html = call("cardStatusHtml", { id: 7 });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("the class is escaped too — it is interpolated into an attribute", () => {
  // Defence in depth: the class is SnapCon's own literal today, but it lands
  // inside class="…", so the quote has to be neutralised. The property that
  // matters is that no new attribute can be opened — the escaped text
  // remaining in the value is inert.
  call("setCardStatus", 7, 'pstatus" onmouseover="alert(1)', "x");
  const html = call("cardStatusHtml", { id: 7 });
  assert.doesNotMatch(html, /"\s+onmouseover\s*=/, "must not break out of the class attribute");
  assert.match(html, /&quot;/, "the quote is escaped rather than dropped");
});

test("setting a message repaints the fleet", () => {
  call("setCardStatus", 7, "pstatus err", "boom");
  assert.ok(renders >= 1, "a new message must reach the screen without waiting for a poll");
});

// ---- the wiring that makes it survive ----

test("cardSignature includes the card status, or the message would not repaint", () => {
  const src = appSrc.slice(appSrc.indexOf("function cardSignature("));
  const body = src.slice(0, src.indexOf("\n}") + 2);
  assert.match(body, /cardStatus/i,
    "a changed message must change the signature, exactly as statusOverride does");
});

test("an upload that can be cancelled puts a Cancel upload button in that card's status line only", () => {
  vm.runInContext('UPLOAD_CANCEL.set("7", "j123")', sandbox);
  const html = call("cardStatusHtml", { id: 7 });
  assert.match(html, /<button type="button" class="pstatus-cancel" data-cancel-upload="j123" data-printer="7">fleet\.print\.cancel_upload<\/button><\/div>$/);
  assert.doesNotMatch(call("cardStatusHtml", { id: 8 }), /pstatus-cancel/);
});

test("buildCardHtml renders the stored message rather than a hardcoded empty div", () => {
  assert.doesNotMatch(appSrc, /<div class="pstatus" id="pst-\$\{p\.id\}"><\/div>/,
    "the always-empty status line is what discarded the message on every rebuild");
  assert.match(appSrc, /\$\{cardStatusHtml\(p\)\}/, "the card must render the stored status");
});

test("pollJob clears the phase badge BEFORE writing its final message", () => {
  // Ordering matters even with the map: clearOverride() re-renders
  // synchronously, so a write that happens first is written to a card that is
  // about to be replaced.
  const src = appSrc.slice(appSrc.indexOf("async function pollJob("));
  const body = src.slice(0, src.indexOf("\n  } finally"));
  const errBranch = body.slice(body.indexOf("if(d.error)"), body.indexOf("return false;"));
  assert.ok(errBranch.indexOf("clearOverride()") >= 0, "the error branch must clear the override");
  assert.ok(
    errBranch.indexOf("clearOverride()") < errBranch.indexOf("setStatus"),
    "clearOverride() must come before the message is written"
  );
});

test("the card call sites report through setCardStatus, not a captured element", () => {
  // pushTo and printQueuedFile both targeted $("pst-"+printer) — an element
  // destroyed by the very re-render their own completion triggers.
  const pushTo = appSrc.slice(appSrc.indexOf("async function pushTo("));
  assert.match(pushTo.slice(0, pushTo.indexOf("\n}")), /setCardStatus/);
  const queued = appSrc.slice(appSrc.indexOf("async function printQueuedFile("));
  assert.match(queued.slice(0, queued.indexOf("\n}")), /setCardStatus/);
});

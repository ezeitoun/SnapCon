// test/firmwareStatusRender.test.js — the status slot must be able to change
// its NUMBERS without changing its ELEMENTS.
//
// The Firmware tab polls once a second during a transfer. The first version of
// this code cached on the rendered markup and rebuilt the slot whenever that
// markup differed — which, during a transfer, is every single tick, because the
// byte count is part of it. So .prog-fill was destroyed and recreated once a
// second, restarting its CSS animation from zero each time: the bar visibly
// stuttered instead of running, and the reboot sweep jumped back to the left
// mid-travel. The comment above the guard claimed it prevented exactly that.
//
// The fix splits three concerns — what a status SAYS, what fraction it is at,
// and which MARKUP it needs — so a tick can patch text and width in place. The
// property that matters is testable without a DOM: within a phase, the shape
// must stay constant while the words move.
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
  assert.ok(end > start, name + " must have a top-level closing brace");
  return appSrc.slice(start, end + 2);
}

// t() echoes its key plus the params that matter, so an assertion can tell two
// renderings apart without depending on English wording.
const sandbox = {
  t: (k, p) => k + (p ? ":" + JSON.stringify(p) : ""),
  fmtFileSize: b => String(b) + "B",
  fmtDuration: s => Math.round(s) + "s",
  fmtTime: ms => "at" + ms,
  FW_REBOOT_EXPECTED_MS: 120 * 1000,
  FW_REBOOT_ERROR_MS: 5 * 60 * 1000,
};
vm.createContext(sandbox);
["firmwareStatusText", "firmwareStatusPct", "firmwareStatusShape"].forEach(n =>
  vm.runInContext(extractFn(n), sandbox));
const { firmwareStatusText: text, firmwareStatusPct: pct, firmwareStatusShape: shape } = sandbox;

// ---------------------------------------------------------------------------

test("an upload keeps one shape while its numbers move", () => {
  // This is the exact case that thrashed: same phase, different bytes, once a
  // second for several minutes.
  const a = { phase: "upload", sent: 1_000, total: 250_000_000 };
  const b = { phase: "upload", sent: 200_000_000, total: 250_000_000 };
  assert.equal(shape(a), shape(b), "same shape → the elements are reused");
  assert.notEqual(text(a), text(b), "different words → they get patched in");
  assert.notEqual(pct(a), pct(b), "and the fill width moves");
  assert.ok(pct(b) > pct(a));
});

test("a reboot keeps one shape while its countdown runs down", () => {
  const now = Date.now();
  const early = { phase: "rebooting", flashStartedAt: now - 5_000 };
  const later = { phase: "rebooting", flashStartedAt: now - 60_000 };
  assert.equal(shape(early), shape(later));
  assert.notEqual(text(early), text(later), "the countdown is patched, not rebuilt");
});

test("only the upload claims a real fraction", () => {
  // Everything else with a bar is indeterminate and sits full width rather than
  // inventing a percentage nothing reports.
  assert.equal(pct({ phase: "upload", sent: 25, total: 100 }), 25);
  assert.equal(pct({ phase: "verify" }), 100);
  assert.equal(pct({ phase: "flash" }), 100);
  assert.equal(pct({ phase: "rebooting" }), 100);
  // A transfer whose total is not known yet reads as 0, never as NaN.
  assert.equal(pct({ phase: "upload", sent: 5, total: 0 }), 0);
});

test("the two states that change shape without changing phase are caught", () => {
  const now = Date.now();
  // A reboot that overruns stops being a wait and becomes an error, which is a
  // different set of elements — so it MUST break the shape and force a rebuild.
  assert.equal(shape({ phase: "rebooting", flashStartedAt: now - 10_000 }), "rebooting");
  assert.equal(shape({ phase: "rebooting", flashStartedAt: now - 6 * 60_000 }), "rebooting-lost");
  // An unverified flash carries an extra line.
  assert.equal(shape({ phase: "updated" }), "updated");
  assert.equal(shape({ phase: "updated", verify: "none" }), "updated-unverified");
  // A failure with a reason carries one too.
  assert.equal(shape({ phase: "failed" }), "failed");
  assert.equal(shape({ phase: "failed", error: "nope" }), "failed-reason");
});

test("a queue position changes the words but never the shape", () => {
  const q = { phase: "queued" };
  assert.equal(shape(q), "queued");
  assert.notEqual(text(q, 1), text(q, 4));
  // With no position known it still says something.
  assert.match(text(q, 0), /st_queued/);
});

test("the renderer keys on shape, and patches values separately", () => {
  const fn = appSrc.slice(appSrc.indexOf("function renderFirmwareRowStatus("),
                          appSrc.indexOf("async function retryFirmwarePrinter("));
  assert.match(fn, /const shape=firmwareStatusShape\(x\);/);
  assert.match(fn, /if\(slot\.dataset\.shape!==shape\)\{/);
  // The old key must not come back: it rebuilt on every tick by construction.
  assert.equal(/slot\.dataset\.render/.test(fn), false,
    "keying on the rendered markup rebuilds the bar once a second");
  assert.match(fn, /if\(x\) updateFirmwareStatusValues\(slot,x,queuePos\);/);
  // The per-tick path touches text and width, and nothing structural.
  const patch = appSrc.slice(appSrc.indexOf("function updateFirmwareStatusValues("),
                             appSrc.indexOf("// ------", appSrc.indexOf("function updateFirmwareStatusValues(")));
  assert.match(patch, /words\.textContent=txt/);
  assert.match(patch, /fill\.style\.width=w/);
  assert.equal(/innerHTML/.test(patch), false, "a tick must never replace markup");
});

test("a selected card is never dimmed", () => {
  // An up-to-date printer is still perfectly selectable — the server just skips
  // it — so a ticked card rendered at half opacity reads as disabled, which is
  // exactly backwards.
  const cells = appSrc.slice(appSrc.indexOf("function updateFirmwareRowCells("),
                             appSrc.indexOf("// The one status slot per row"));
  assert.match(cells, /el\.classList\.toggle\("dim",!chk\.checked&&!settled&&/);
  // ...and ticking one live must clear the dim immediately, not wait for the
  // next full render.
  const el = appSrc.slice(appSrc.indexOf("function firmwareRowEl("),
                          appSrc.indexOf("function updateFirmwareRowCells("));
  assert.match(el, /if\(e\.target\.checked\) el\.classList\.remove\("dim"\);/);
  assert.match(el, /else updateFirmwareRowCells\(el,r\);/);
});

test("hover is gated, and labels are sentence case", () => {
  const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  // On a touch device :hover sticks after a tap, so an ungated rule leaves one
  // card un-dimmed until something else is tapped.
  const i = css.indexOf(".fwcard.dim:hover");
  assert.ok(i > 0);
  const before = css.slice(Math.max(0, i - 400), i);
  assert.match(before, /@media \(hover:hover\) and \(pointer:fine\)\{/);

  // CLAUDE.md: labels use sentence case. The deploy button sits beside
  // "Refresh versions" and "Choose image", so Title Case on it alone was
  // visible in a single glance.
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  const fw = en.settings.firmware;
  ["deploy_n_one", "deploy_n_other", "get_button", "select_button", "footer_stop",
   "group_needs_update", "st_rebooting"].forEach(k => {
    const words = String(fw[k]).replace(/\{[^}]+\}/g, "").split(/\s+/).filter(Boolean).slice(1);
    const titled = words.filter(w => /^[A-Z][a-z]/.test(w));
    assert.deepEqual(titled, [], k + " is not sentence case: " + JSON.stringify(fw[k]));
  });
});

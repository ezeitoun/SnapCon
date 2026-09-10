// test/fleet-phase-badge.test.js — the job-phase badge pinned on a printer card
// while SnapCon's own upload/print flow runs.
//
// Klipper's own state stays "standby"/idle while SnapCon uploads a file and then
// runs the pre-print macros, so the card would read Idle through the whole
// operation. pollJob pins a client-side badge (STATUS_OVERRIDE) instead:
// Uploading -> Mapping heads / Leveling -> cleared once the print actually
// starts and the printer reports its own state.
//
// This is extracted from pollJob because adding the Uploading phase changed how
// ALL of these badges are tracked — it used to be a single boolean latch that
// could only ever fire once per job, which is fine for one badge and wrong for
// two. The mapping/leveling badge is the pre-existing behaviour that must not
// regress; Uploading is the new one.
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

// Minimal environment: the real Map the app uses, and a render counter standing
// in for renderFleet so re-render churn is observable.
function makeSandbox() {
  const sandbox = { STATUS_OVERRIDE: new Map(), renders: 0 };
  sandbox.renderFleet = () => { sandbox.renders++; };
  vm.createContext(sandbox);
  vm.runInContext(extractFn("makePhaseOverride"), sandbox);
  sandbox.make = (id) => vm.runInContext("makePhaseOverride", sandbox)(id);
  return sandbox;
}

const UPLOADING = { statusColor: "var(--busy)", statusTxt: "Uploading" };
const MAPPING = { statusColor: "var(--busy)", statusTxt: "Mapping heads" };

test("the uploading badge is pinned on the card while a file is being pushed", () => {
  const s = makeSandbox();
  const ov = s.make(7);
  assert.equal(ov.set("upload", UPLOADING), true);
  assert.deepEqual(s.STATUS_OVERRIDE.get("7"), UPLOADING);
  assert.equal(s.renders, 1, "the card is re-rendered once so the badge appears");
});

test("the badge FOLLOWS the job instead of sticking at the first phase", () => {
  // The regression this guards: the old single-boolean latch fired once, so a
  // job that uploaded and then mapped would keep showing "Uploading" through
  // the whole mapping/leveling pass.
  const s = makeSandbox();
  const ov = s.make(7);
  ov.set("upload", UPLOADING);
  assert.equal(ov.set("mapping", MAPPING), true, "a new phase must replace the old badge");
  assert.deepEqual(s.STATUS_OVERRIDE.get("7"), MAPPING);
  assert.equal(ov.phase, "mapping");
});

test("re-setting the same phase does nothing, so a 400ms poll does not churn the fleet", () => {
  const s = makeSandbox();
  const ov = s.make(7);
  ov.set("upload", UPLOADING);
  const after = s.renders;
  for (let i = 0; i < 20; i++) assert.equal(ov.set("upload", UPLOADING), false);
  assert.equal(s.renders, after, "no re-render for an unchanged badge");
});

test("clearing removes the badge and re-renders exactly once", () => {
  const s = makeSandbox();
  const ov = s.make(7);
  ov.set("upload", UPLOADING);
  const after = s.renders;
  assert.equal(ov.clear(), true);
  assert.equal(s.STATUS_OVERRIDE.has("7"), false, "the printer's real state takes over again");
  assert.equal(s.renders, after + 1);
  assert.equal(ov.phase, null);
});

test("clearing when nothing was ever set is a no-op, not a stray re-render", () => {
  const s = makeSandbox();
  const ov = s.make(7);
  assert.equal(ov.clear(), false);
  assert.equal(s.renders, 0);
});

test("clearing twice does not re-render or throw", () => {
  const s = makeSandbox();
  const ov = s.make(7);
  ov.set("upload", UPLOADING);
  ov.clear();
  const after = s.renders;
  assert.equal(ov.clear(), false);
  assert.equal(s.renders, after);
});

test("a job with no printer id never touches the shared override map", () => {
  // Some callers have no printer to pin a badge to; that must not write a
  // "null" key into a Map the whole fleet render reads.
  for (const id of [null, undefined]) {
    const s = makeSandbox();
    const ov = s.make(id);
    assert.equal(ov.set("upload", UPLOADING), false);
    assert.equal(s.STATUS_OVERRIDE.size, 0, "no key written for id " + String(id));
    assert.equal(s.renders, 0);
  }
});

test("two printers running jobs at once keep independent badges", () => {
  const s = makeSandbox();
  const a = s.make(1), b = s.make(2);
  a.set("upload", UPLOADING);
  b.set("mapping", MAPPING);
  assert.deepEqual(s.STATUS_OVERRIDE.get("1"), UPLOADING);
  assert.deepEqual(s.STATUS_OVERRIDE.get("2"), MAPPING);
  a.clear();
  assert.equal(s.STATUS_OVERRIDE.has("1"), false);
  assert.deepEqual(s.STATUS_OVERRIDE.get("2"), MAPPING, "clearing one must not clear the other");
});

test("a numeric printer id is keyed as a string, matching how the card looks it up", () => {
  // statusColorText does STATUS_OVERRIDE.get(String(p.id)) — a number key here
  // would store a badge nothing ever reads.
  const s = makeSandbox();
  s.make(7).set("upload", UPLOADING);
  assert.equal(s.STATUS_OVERRIDE.has("7"), true);
  assert.equal(s.STATUS_OVERRIDE.has(7), false);
});

test("printer id 0 is a real printer, not a falsy one to skip", () => {
  const s = makeSandbox();
  const ov = s.make(0);
  assert.equal(ov.set("upload", UPLOADING), true, "the first printer in the fleet has id 0");
  assert.equal(s.STATUS_OVERRIDE.has("0"), true);
});

// The Uploading badge has to actually exist as a translatable string, or the
// card renders an empty pill.
test("the uploading badge text is a real locale key, not a hardcoded string", () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  assert.ok(en.printer_status.uploading, "printer_status.uploading must exist in en.json");
  assert.match(appSrc, /statusTxt:\s*t\("printer_status\.uploading"\)/,
    "pollJob must use the locale key rather than literal text");
});

// test/firmwareTargetingAndRejects.test.js — four release-critical fixes to the
// firmware deploy path, tested by EXECUTING the decisions rather than reading
// server.js's source text.
//
// Each fix is deliberately expressed as a small pure function so it can be run
// here. The route still cannot be required (server.js starts a listener), but
// the decisions it makes no longer live only inside it.
//
//   1. Rejected printers must not vanish. Before this, POST /api/firmware-deploy
//      pushed to `rejected` WITHOUT an FW_STATE entry, and the browser used that
//      array only to clear a refresh flag — so selecting five printers with two
//      printing showed "Firmware update started" and those two silently
//      disappeared from both the response handling and the status table.
//
//   2. A destructive route must not target a printer by mutable array index.
//      server.js already knows PRINTERS[] can be reordered by a Settings save
//      within the same run (see saveQueuedFiles, which persists by p.id for
//      exactly this reason). Firmware deploy resolved PRINTERS[idx] at request
//      time, so a reorder between rendering the list and pressing Deploy could
//      flash a different printer than the one on screen.
//
//   3. compatibilityFor() existed but was never called outside its own tests,
//      so the "this file says U1, this printer says X" warning never reached
//      anyone. It is now consulted before the upload.
//
//   4. Nothing stopped the print queue dispatching a job onto a printer that is
//      mid-firmware-deploy. The pre-flash gate caught it and aborted the FLASH
//      (safe), but the deploy lost to the print and the operator saw a firmware
//      failure they did not cause.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function extractFrom(src, name, label) {
  let start = src.indexOf("function " + name + "(");
  assert.ok(start > 0, (label || name) + " must exist");
  // Keep an `async` prefix: slicing it off turns the body's awaits into a
  // syntax error inside the sandbox.
  if (src.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const end = src.indexOf("\n}", start);
  return src.slice(start, end + 2);
}

// ---------------------------------------------------------------------------
// 2. Stable-id targeting
// ---------------------------------------------------------------------------

function targetEnv(printers) {
  const env = vm.createContext({ PRINTERS: printers });
  vm.runInContext(extractFrom(serverSrc, "firmwareTargetFor"), env);
  return ref => vm.runInContext("firmwareTargetFor", env)(ref);
}

const FLEET = [
  { id: "p_aaa", name: "U1 Red" },
  { id: "p_bbb", name: "U1 Blue" },
  { id: "p_ccc", name: "U1 Green" },
];

test("targeting: a stable printer id resolves to that printer", () => {
  const target = targetEnv(FLEET.slice());
  assert.equal(target("p_bbb").name, "U1 Blue");
});

test("targeting: an id still resolves correctly after PRINTERS is reordered", () => {
  // THE regression. A Settings save can reorder PRINTERS[] within one run; the
  // browser's list was rendered against the old order.
  const fleet = FLEET.slice();
  const target = targetEnv(fleet);
  assert.equal(target("p_bbb").name, "U1 Blue");
  fleet.reverse();                                  // Settings save reorders
  assert.equal(target("p_bbb").name, "U1 Blue", "an id must not follow the array");
});

test("targeting: a numeric index would have followed the reorder — proving the hazard is real", () => {
  const fleet = FLEET.slice();
  const target = targetEnv(fleet);
  assert.equal(target(1).name, "U1 Blue");
  fleet.reverse();
  assert.equal(target(1).name, "U1 Blue",
    "legacy index clients are still accepted, and this is exactly why they are not preferred");
});

test("targeting: an unknown id resolves to nothing rather than to a neighbour", () => {
  const target = targetEnv(FLEET.slice());
  assert.equal(target("p_zzz"), null);
  assert.equal(target(99), null);
  assert.equal(target(-1), null);
  assert.equal(target(null), null);
  assert.equal(target(undefined), null);
});

test("targeting: a deleted printer resolves to nothing, never to whatever slid into its slot", () => {
  const fleet = FLEET.slice();
  const target = targetEnv(fleet);
  fleet.splice(0, 1);                               // U1 Red deleted
  assert.equal(target("p_aaa"), null, "the deploy must fail, not hit U1 Blue");
  assert.equal(target("p_bbb").name, "U1 Blue");
});

// ---------------------------------------------------------------------------
// 3. Compatibility actually gating
// ---------------------------------------------------------------------------

const { compatibilityFor } = require("../connectors/firmwareImage");

function compatEnv() {
  const env = vm.createContext({ firmwareImage: { compatibilityFor } });
  vm.runInContext(extractFrom(serverSrc, "firmwareCompatReject"), env);
  return (image, product) => vm.runInContext("firmwareCompatReject", env)(image, product);
}
const img = (product, extra = {}) =>
  ({ hardFail: [], warnings: [], filename: product ? { product } : null, ...extra });

test("compatibility: a filename that CONTRADICTS the printer's model rejects before upload", () => {
  const reject = compatEnv();
  const why = reject(img("A400"), "U1");
  assert.ok(why, "a positive contradiction must stop the deploy, not merely warn");
  assert.match(why, /A400/);
  assert.match(why, /U1/);
});

test("compatibility: a matching filename and model does not reject", () => {
  assert.equal(compatEnv()(img("U1"), "U1"), null);
});

test("compatibility: case differences are not a contradiction", () => {
  assert.equal(compatEnv()(img("u1"), "U1"), null);
});

test("compatibility: an unknown model is NOT treated as a contradiction", () => {
  // The image never states which model it is for, and the file name is
  // renameable. Absence of evidence stays a warning (it already rides in
  // image.warnings); only positive disagreement blocks.
  const reject = compatEnv();
  assert.equal(reject(img(null), "U1"), null, "no product in the file name");
  assert.equal(reject(img("U1"), null), null, "printer did not report a product");
  assert.equal(reject(img(null), null), null);
});

// ---------------------------------------------------------------------------
// 4. Queue must not dispatch onto a printer mid-deploy
// ---------------------------------------------------------------------------

function idleEnv({ fwPhase = null, online = true, state = "standby" } = {}) {
  const env = vm.createContext({
    STARTING: new Map(),
    DISPATCH_IDLE_STATES: new Set(["standby", "idle", "complete", "cancelled"]),
    FW_STATE: new Map(fwPhase ? [["p_aaa", { phase: fwPhase, flashStartedAt: Date.now() }]] : []),
    // FW_RUNNING points at the printer only while the drainer is actually on it.
    // A rebooting printer has already been handed back (firmwareCardState covers
    // that window via the grace timer), and a settled one is long finished.
    FW_QUEUE: [], FW_RUNNING: ["preparing","upload","verify","flash"].includes(fwPhase) ? "p_aaa" : null,
    FW_REBOOT_GRACE_MS: 15 * 60 * 1000,
    probeCached: async () => ({ online, state }),
    console,
  });
  vm.runInContext(extractFrom(serverSrc, "firmwareCardState"), env);
  vm.runInContext("const fwBusyWith = id => (FW_RUNNING === id || FW_QUEUE.some(e => e.id === id));", env);
  vm.runInContext(extractFrom(serverSrc, "firmwareUpdating").replace(/^function /, "function "), env);
  vm.runInContext(extractFrom(serverSrc, "isPrinterIdle"), env);
  return () => vm.runInContext("isPrinterIdle", env)({ id: "p_aaa", name: "U1 Red" });
}

test("dispatch: a printer with no firmware activity is dispatchable as before", async () => {
  assert.equal(await idleEnv()(), true);
});

for (const phase of ["preparing", "upload", "verify", "flash"]) {
  test(`dispatch: a printer mid-deploy (${phase}) is NOT idle, even though it probes idle`, async () => {
    // During upload and verify the printer really is online and standby — the
    // probe cannot answer this question, exactly like the start-sequence guard.
    assert.equal(await idleEnv({ fwPhase: phase })(), false,
      "a print dispatched here aborts the flash at the pre-flash gate and loses the deploy");
  });
}

test("dispatch: a printer rebooting after a flash is NOT idle", async () => {
  assert.equal(await idleEnv({ fwPhase: "rebooting", online: true })(), false);
});

test("dispatch: a settled firmware record does not block the printer forever", async () => {
  assert.equal(await idleEnv({ fwPhase: "updated" })(), true, "the deploy is over");
});

// ---------------------------------------------------------------------------
// 1. Rejected printers are visible
// ---------------------------------------------------------------------------

function uiEnv() {
  const env = vm.createContext({ t: (k, v) => k + (v ? ":" + JSON.stringify(v) : ""), esc: s => String(s) });
  vm.runInContext(extractFrom(appSrc, "firmwareStatusShape", "app.js firmwareStatusShape"), env);
  return env;
}

test("rejected: the status renderer knows the phase and carries its reason", () => {
  const env = uiEnv();
  const shape = x => vm.runInContext("firmwareStatusShape", env)(x);
  assert.equal(shape({ phase: "rejected", error: "U1 Red is printing" }), "rejected-reason",
    "a rejection with a reason needs its own shape so the reason is rendered");
  assert.equal(shape({ phase: "rejected" }), "rejected");
});

test("rejected: 'rejected' is a distinct phase, never folded into the others", () => {
  const env = uiEnv();
  const shape = x => vm.runInContext("firmwareStatusShape", env)(x);
  const distinct = new Set(["queued", "skipped", "failed", "cancelled", "updated"]
    .map(p => shape({ phase: p })));
  assert.ok(!distinct.has("rejected") && !distinct.has("rejected-reason"),
    "queued/skipped/rejected/failed/cancelled/updated must stay tellable apart");
});

// The post-deploy message must not imply every selected printer was accepted.
function summaryEnv() {
  const env = vm.createContext({ t: (k, v) => k + (v ? ":" + JSON.stringify(v) : ""), tn: (k, n, v) => k + ":" + n });
  vm.runInContext(extractFrom(appSrc, "firmwareDeploySummary", "app.js firmwareDeploySummary"), env);
  return d => vm.runInContext("firmwareDeploySummary", env)(d);
}

test("rejected: the summary reports a partial acceptance rather than a flat 'started'", () => {
  const summary = summaryEnv();
  const s = summary({ accepted: [{ name: "A" }, { name: "B" }], rejected: [{ name: "C", error: "printing" }], skipped: [] });
  assert.equal(s.tone, "warn", "some of what was asked for did not happen");
  assert.match(s.text, /2/, "the accepted count");
  assert.match(s.text, /1/, "the rejected count");
});

test("rejected: nothing accepted at all is an error, not a success", () => {
  const s = summaryEnv()({ accepted: [], rejected: [{ name: "C", error: "printing" }], skipped: [] });
  assert.equal(s.tone, "err", "claiming an update started when none did is the bug being fixed");
});

test("rejected: an all-accepted deploy still reads as a clean success", () => {
  const s = summaryEnv()({ accepted: [{ name: "A" }], rejected: [], skipped: [] });
  assert.equal(s.tone, "ok");
});

test("rejected: skipped printers are counted separately from rejected ones", () => {
  const s = summaryEnv()({ accepted: [{ name: "A" }], rejected: [], skipped: [{ name: "B" }] });
  assert.equal(s.tone, "ok", "already-current is not a failure");
  assert.match(s.text, /skipped/i);
});

// ---------------------------------------------------------------------------
// Wiring that only source text can show
// ---------------------------------------------------------------------------

test("the deploy route records a status entry for every rejected printer", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/firmware-deploy"'));
  const body = route.slice(0, route.indexOf("\n});"));
  // A single reject() helper now records every refusal, so counting
  // rejected.push sites no longer measures coverage — count the call sites.
  const calls = body.split("reject(p, idx").length - 1;
  assert.ok(calls >= 4, "expected several rejection paths, found " + calls);
  assert.ok(body.includes('phase: "rejected"'),
    "a rejected printer with no FW_STATE entry cannot appear in the status table");
});

test("the settled-record sweep includes rejected, so the table does not fill up forever", () => {
  assert.match(serverSrc, /\["updated", "failed", "skipped", "cancelled", "rejected"\]/);
});

// Verified empirically on 2026-09-10, and it is the reason the live-validation
// procedure has no "rename the file" step: the gate keys on a STRICT filename
// pattern, <product>_<version>_<14-digit-buildtime>_upgrade.bin. A plausible
// rename that breaks the pattern parses to no product at all and is ALLOWED, so
// a hand-renamed file on a real printer would have demonstrated correct
// behaviour looking like a failure.
//
// Stated plainly because it bounds what this check is worth: it reads the FILE
// NAME, never the payload. It catches a file named for another model, and it
// cannot catch the dangerous case — the wrong image named U1_something. That
// asymmetry is deliberate (connectors/firmwareImage.js proves the model cannot
// be read from the bytes) and must not be mistaken for compatibility checking.
test("compatibility: a name that does not fit the pattern states no product, and is allowed", () => {
  const { parseFilename } = require("../connectors/firmwareImage");
  const reject = compatEnv();
  for (const name of ["A400_test.bin", "A400_1.6.0.267_upgrade.bin", "firmware.bin"]) {
    const parsed = parseFilename(name);
    assert.equal(parsed, null, name + " must not parse");
    assert.equal(reject({ hardFail: [], warnings: [], filename: parsed }, "U1"), null,
      "no product claimed means no contradiction — absence of evidence is not evidence");
  }
});

test("compatibility: the contradiction needs the full pattern, product half differing", () => {
  const { parseFilename } = require("../connectors/firmwareImage");
  const reject = compatEnv();
  const bad = parseFilename("A400_1.6.0.267_20260815150420_upgrade.bin");
  assert.equal(bad.product, "A400");
  assert.ok(reject({ hardFail: [], warnings: [], filename: bad }, "U1"));
  const good = parseFilename("U1_1.6.0.267_20260815150420_upgrade.bin");
  assert.equal(reject({ hardFail: [], warnings: [], filename: good }, "U1"), null);
});

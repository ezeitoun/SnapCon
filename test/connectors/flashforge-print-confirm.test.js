// test/connectors/flashforge-print-confirm.test.js — regression tests for
// Send to Printers uploading a file and then silently not printing it.
//
// FlashForge's /printGcode answers {"code":0,"message":"Success"} even when it
// discards the command. Confirmed live on an Adventurer 5M Pro (firmware
// 3.1.5): a start issued 1ms after uploadFile() resolved was acknowledged and
// ignored (printer stayed "ready", never heated), while a byte-identical call
// 1857ms later printed normally. server.js's /api/print issues the start the
// moment the upload resolves, so that flow always landed in the window — and
// because the response claimed Success, SnapCon reported the job "done" and
// wrote a print-started audit entry for a print that never began.
// /api/printfile (the fleet card) never uploads first, which is exactly why
// printing from the card always worked.
//
// issuePrintAndConfirm() therefore verifies the command against the printer's
// own state and re-issues it if it didn't take. These tests drive it with the
// timing-override option so they exercise the real control flow without
// spending its real wall-clock budget.
const test = require("node:test");
const assert = require("node:assert/strict");
const ff = require("../../connectors/flashforge-utils");

const p = { name: "5M PRO", url: "http://127.0.0.1:1", serial: "SN1", verificationCode: "code" };
const FAST = { attempts: 3, windowMs: 60, pollMs: 10 };
const BODY = { fileName: "boat_pla_14m3s.gcode", levelingBeforePrint: false };

// /printGcode always reports Success — that is the whole bug. /detail reports
// whatever statusFor({starts, polls}) says the machine is really doing, so a
// test can model "ignored the first start" directly instead of by poll
// counting. Returning "__throw__" simulates a dropped status read.
function mockPrinter(statusFor) {
  const state = { starts: 0, polls: 0 };
  const handler = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/printGcode") {
      state.starts++;
      return { ok: true, status: 200, json: async () => ({ code: 0, message: "Success" }) };
    }
    state.polls++;
    const status = statusFor(state);
    if (status === "__throw__") throw new Error("socket hang up");
    return { ok: true, status: 200, json: async () => ({ code: 0, detail: { status } }) };
  };
  return { handler, state };
}

function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

test("a print the printer genuinely starts is confirmed on the first attempt, with no extra start commands", async () => {
  const m = mockPrinter(s => s.starts >= 1 ? "printing" : "ready");
  const res = await withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST));
  assert.equal(res.code, 0);
  assert.equal(m.state.starts, 1, "a working start must not be re-issued");
});

test("a start the printer ACKNOWLEDGES BUT DISCARDS is re-issued until it actually takes", async () => {
  // The live-observed bug: Success reported, printer stays "ready".
  const m = mockPrinter(s => s.starts >= 2 ? "printing" : "ready");
  const res = await withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST));
  assert.equal(res.code, 0);
  assert.equal(m.state.starts, 2, "exactly one re-issue was needed here");
});

test("a print that never starts THROWS instead of reporting the false success that broke Send to Printers", async () => {
  const m = mockPrinter(() => "ready");
  await assert.rejects(
    withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST)),
    /never started it/,
    "resolving here is what made server.js report phase=done and log print-started for a print that never happened"
  );
  assert.equal(m.state.starts, 3, "it must give up after the configured attempts, not retry forever");
});

// ---- The transient-state trap. The first version of this fix failed a print
// that was genuinely running, because the 5M Pro reports a blocked-looking
// state on its way INTO a print (caught live: the confirmation window saw it
// while the bed was heating toward 50C, and the job printed fine). Reporting
// a false failure for a running print is worse than the bug being fixed.

test("a printer passing THROUGH a blocked-looking state on its way into a print still succeeds", async () => {
  const m = mockPrinter(s => s.starts === 0 ? "ready" : (s.polls <= 3 ? "busy" : "printing"));
  const res = await withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST));
  assert.equal(res.code, 0);
  assert.equal(m.state.starts, 1, "a transient busy must not abort a print that is actually starting");
});

test("the same holds for a transient cancel/pause reading during startup", async () => {
  for (const transient of ["cancel", "paused"]) {
    const m = mockPrinter(s => s.starts === 0 ? "ready" : (s.polls <= 2 ? transient : "printing"));
    const res = await withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST));
    assert.equal(res.code, 0, `transient "${transient}" must not fail a starting print`);
  }
});

// ---- Genuinely human-blocked, detected before anything is sent.

test("a printer ALREADY behind an on-screen dialog fails fast, without issuing any print command", async () => {
  // The post-job "clear the plate" prompt leaves the printer busy/cancel and
  // refusing new jobs until an operator presses OK.
  for (const blocked of ["busy", "cancel", "paused"]) {
    const m = mockPrinter(() => blocked);
    await assert.rejects(
      withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST)),
      /screen is showing a dialog/,
      `pre-existing "${blocked}" must be reported as human-blocked`
    );
    assert.equal(m.state.starts, 0, "must not fire print commands at a printer waiting on a person");
  }
});

test("a transient /detail read failure is not mistaken for a discarded command", async () => {
  // A dropped status poll says nothing about whether the print began, so it
  // must not trigger another start on its own.
  const m = mockPrinter(s => s.starts === 0 ? "ready" : (s.polls <= 3 ? "__throw__" : "printing"));
  const res = await withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST));
  assert.equal(res.code, 0);
  assert.equal(m.state.starts, 1, "read failures must not cause a re-issue inside the first window");
});

test("a failed pre-flight read does not block the print from being attempted", async () => {
  const m = mockPrinter(s => s.polls === 1 ? "__throw__" : "printing");
  const res = await withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, FAST));
  assert.equal(res.code, 0);
  assert.equal(m.state.starts, 1);
});

test("the PRODUCTION default issues exactly ONE start and never re-sends it", async () => {
  // Re-issuing made the printer report "printing" while never actually
  // printing (heaters at temperature, progress/speed/fan all 0, layer pinned
  // at the total) — confirmed live on a 5M Pro. Re-sending a physical
  // state-changing command to an API that acknowledges commands it discards
  // is not safe, so no production path does it. This test guards the default
  // specifically, since every other test here overrides `attempts`.
  const m = mockPrinter(() => "ready");
  await assert.rejects(
    withMockFetch(m.handler, () => ff.issuePrintAndConfirm(p, BODY, { windowMs: 40, pollMs: 10 })),
    /never started it/
  );
  assert.equal(m.state.starts, 1, "the default must not re-issue a print start");
});

test("both FlashForge connectors route their print through the confirmation, not a bare ffPost", () => {
  // flashforge-ad5x.js builds a different body (material-station mappings) but
  // hits the identical endpoint, so a fix confined to the shared
  // startPrintFile would have silently missed it.
  const fs = require("fs");
  const path = require("path");
  const ad5x = fs.readFileSync(path.join(__dirname, "..", "..", "connectors", "flashforge-ad5x.js"), "utf8");
  const utils = fs.readFileSync(path.join(__dirname, "..", "..", "connectors", "flashforge-utils.js"), "utf8");
  assert.match(ad5x, /issuePrintAndConfirm\(p, body\)/);
  assert.doesNotMatch(ad5x, /ffPost\(p, "\/printGcode"/, "AD5X must not bypass the confirmation");
  assert.match(utils, /startPrintFile = \(p, filename\) => issuePrintAndConfirm\(/);
});

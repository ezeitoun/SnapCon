// test/connectors/controlCommandTimeout.test.js — ordinary print-control
// commands must not be bound by the 8s fast-command default.
//
// Moonraker's /printer/gcode/script BLOCKS until the script finishes, and
// CANCEL_PRINT runs the printer's whole end-of-print routine: park the
// toolhead, turn off heaters, retract. That routinely exceeds 8 seconds, so
// SnapCon gave up and reported "did not respond within 8000ms" for a cancel
// that had in fact worked. Reported live on a U1; measured on a SPARKX i7,
// where Moonraker accepted CANCEL_PRINT at 00:57:05 and Klipper executed it at
// 00:57:51 -- 46 seconds.
//
// creality-klipper already carried an explicit 60s bound for exactly this
// reason. The other Moonraker-based connectors never got the same treatment
// and kept the default, which is the bug these tests pin.
//
// estop is the deliberate exception everywhere and stays on the short default:
// in a real emergency the operator needs to know FAST that the command is not
// landing, so they can pull power, rather than have SnapCon wait a minute
// hoping it lands.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const u1 = require("../../connectors/snapmaker-u1-klipper");
const u1ws = require("../../connectors/snapmaker-u1-klipper-ws");
const moonraker = require("../../connectors/klipper-moonraker");
const adventurer = require("../../connectors/flashforge-adventurer");
const ad5x = require("../../connectors/flashforge-ad5x");
const creality = require("../../connectors/creality-klipper");

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Hangs every request until its AbortSignal fires, so the only thing that ever
// settles the promise is the timeout under test.
function hangingFetch() {
  return (url, opts) => new Promise((_res, reject) => {
    opts.signal.addEventListener("abort", () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
}

// Drives one call and reports whether it had settled by 8s and by 60s.
async function probeBound(t, invoke) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = global.fetch;
  global.fetch = hangingFetch();
  let settled = false;
  try {
    const pending = invoke();
    pending.then(() => { settled = true; }, () => { settled = true; });
    pending.catch(() => {});

    // Let the call actually reach its setTimeout before ticking. Connectors
    // that route by transport (FlashForge's byMode) await first, so ticking
    // immediately would fire before the timer under test exists and make an
    // 8s-bound command look unbounded.
    await flush();
    t.mock.timers.tick(8000);
    await flush();
    const atEightSeconds = settled;

    t.mock.timers.tick(52 * 1000 + 500); // past 60s in total
    await flush();
    return { atEightSeconds, atSixtySeconds: settled };
  } finally {
    global.fetch = realFetch;
  }
}

const P = { url: "http://127.0.0.1:1", name: "Test Printer" };
// FlashForge routes by transport; pin Moonraker mode so byMode takes the
// http.* branch these tests are about.
const FF = { url: "http://127.0.0.1:1", name: "FF Test", transport: "moonraker" };

// estopFailsFast: whether estop is the plain single http.estop call. Both
// FlashForge connectors are false, and deliberately so -- their estop is the
// one cross-transport RETRY in the codebase (native TCP and Moonraker HTTP are
// unrelated mechanisms, and a stale transport guess must never swallow an
// emergency stop), so it is bounded by two attempts rather than one short call.
// That predates this work and is not something to "fix" here.
const CONNECTORS = [
  ["snapmaker-u1-klipper", u1, P, true],
  ["snapmaker-u1-klipper-ws", u1ws, P, true],
  ["klipper-moonraker", moonraker, P, true],
  ["flashforge-adventurer (moonraker mode)", adventurer, FF, false],
  ["flashforge-ad5x (moonraker mode)", ad5x, FF, false],
  ["creality-klipper (already fixed — must stay fixed)", creality, P, true]
];

const ACTIONS = [
  ["cancel", (c, p) => c.cancel(p)],
  ["pause", (c, p) => c.pause(p)],
  ["resume", (c, p) => c.resume(p)],
  ["eject", (c, p) => c.eject(p)],
  ["bedTemp", (c, p) => c.bedTemp(p, 60)]
];

for (const [label, conn, printer, estopFailsFast] of CONNECTORS) {
  for (const [action, invoke] of ACTIONS) {
    test(`${label}: ${action} is not bound by the 8s default`, async (t) => {
      if (typeof conn[action] !== "function") { t.skip(action + " not supported"); return; }
      const r = await probeBound(t, () => invoke(conn, printer));
      assert.equal(r.atEightSeconds, false,
        `${action} must not report failure at 8s — the command is usually still running`);
      assert.equal(r.atSixtySeconds, true,
        `${action} must still be bounded, not open-ended`);
    });
  }

  if (estopFailsFast) {
    test(`${label}: estop still fails fast`, async (t) => {
      const r = await probeBound(t, () => conn.estop(printer));
      assert.equal(r.atEightSeconds, true,
        "E-Stop must report quickly if it cannot be delivered — the operator may need to pull power");
    });
  }
}

// The FlashForge estop retry is out of scope here, but must not be quietly
// given the longer control bound along with everything else.
test("FlashForge estop is left on its own retry path, not the control timeout", () => {
  for (const [name, src] of [
    ["flashforge-adventurer", fs.readFileSync(path.join(__dirname, "..", "..", "connectors", "flashforge-adventurer.js"), "utf8")],
    ["flashforge-ad5x", fs.readFileSync(path.join(__dirname, "..", "..", "connectors", "flashforge-ad5x.js"), "utf8")]
  ]) {
    const line = src.split(/\r?\n/).find(l => l.startsWith("exports.estop"));
    assert.ok(line, name + " must export estop");
    assert.doesNotMatch(line, /CONTROL_TIMEOUT_MS/,
      name + ": estop must not be given the longer control bound");
  }
});

// The commands must still be the same commands: a longer bound only changes how
// long SnapCon waits, never what it sends.
test("the gcode sent by each control command is unchanged", async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    sent.push(decodeURIComponent(String(url).split("script=")[1] || String(url)));
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    await u1.pause(P); await u1.resume(P); await u1.cancel(P); await u1.eject(P); await u1.bedTemp(P, 60);
  } finally { global.fetch = realFetch; }
  assert.deepEqual(sent, ["PAUSE", "RESUME", "CANCEL_PRINT", "SDCARD_RESET_FILE", "M140 S60"]);
});

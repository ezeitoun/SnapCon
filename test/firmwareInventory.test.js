// test/firmwareInventory.test.js — /api/firmware's per-printer probe.
//
// The bug this pins down, reported live on a 24-printer fleet: the Firmware
// tab sat on "Reading firmware from idle printers…" forever and never showed
// a list. Timing each printer individually found two that never answered —
// both FlashForge, both offline:
//
//   14 x U1                 0.1-0.4s
//   3 x Creality            0.4-0.5s
//   Bambu P2S               0s
//   5M PRO (flashforge)     never returned
//   AD5X ZMOD (flashforge)  never returned (>150s)
//
// Three things combined to make one unreachable printer hang the whole tab:
//
//  1. probeFirmware gated on the METHOD existing (`if (!c.getFirmwareInfo)`)
//     rather than the declared capability. FlashForge declares
//     firmwareInfo:false in native mode but still exports getFirmwareInfo as
//     defence in depth, so it was called anyway.
//  2. That export is moonrakerOnly(), which awaits currentMode() ->
//     mode.detect() against an unreachable printer. It never returns, and it
//     is wrapped in try/catch, so it never rejects either — it just hangs.
//  3. The route awaited Promise.all over every printer with no per-printer
//     bound, so one unsettled promise meant no response at all. Ever.
//
// Failure isolation over aggregate speed (CLAUDE.md section 6): one printer
// that stops answering must cost one row, not the whole inventory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "routes", "firmwareInventory.js"), "utf8");

function extractFn(name) {
  const start = serverSrc.indexOf("async function " + name + "(");
  const plain = serverSrc.indexOf("function " + name + "(");
  const at = start >= 0 ? start : plain;
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n  }", at) + 4);
}

// Builds a world for probeFirmware(): one printer, one connector, one probe
// result. `hang` makes getFirmwareInfo never settle, exactly like FlashForge's
// mode detection against an offline printer.
function harness({ caps = {}, connector = {}, probe = { online: true }, hang = false } = {}) {
  const calls = [];
  const conn = Object.assign({
    getFirmwareInfo: async (p, st) => {
      calls.push("getFirmwareInfo");
      if (hang) return new Promise(() => {});   // never settles, never rejects
      return { name: p.name, online: true, version: "1.6.0", skipped: false };
    },
  }, connector);

  const sandbox = {
    console: { log() {}, error() {} },
    getConnector: () => conn,
    getCapabilities: () => Object.assign({ firmwareInfo: true, firmwareDeploy: true }, caps),
    probeCached: async () => { calls.push("probeCached"); return probe; },
    setTimeout, clearTimeout, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn("probeFirmware"), sandbox);
  vm.runInContext(extractFn("firmwareTabEligible"), sandbox);
  return {
    calls,
    probeFirmware: (p, ms) => vm.runInContext("probeFirmware", sandbox)(p, ms),
    eligible: (p) => vm.runInContext("firmwareTabEligible", sandbox)(p),
  };
}

const P = { id: "p1", name: "AD5X ZMOD", connector: "flashforge-ad5x" };

// ---- The hang ----

test("a connector whose firmware read never settles yields a skipped row, not a hang", async () => {
  // THE regression. Before the fix this test never finishes.
  const h = harness({ hang: true });
  const row = await h.probeFirmware(P, 40);
  assert.equal(row.skipped, true);
  assert.equal(row.reasonCode, "timeout");
  assert.match(row.reason, /did not answer/i);
  assert.equal(row.name, P.name, "the row must still identify its printer");
});

test("the timeout does not fire for a printer that answers in time", async () => {
  const h = harness();
  const row = await h.probeFirmware(P, 2000);
  assert.equal(row.skipped, false);
  assert.equal(row.version, "1.6.0");
});

test("a connector that throws becomes a skipped row rather than failing the inventory", async () => {
  // Promise.all also rejects on the FIRST rejection, which would lose every
  // other printer's row along with it.
  const h = harness({ connector: { getFirmwareInfo: async () => { throw new Error("ECONNREFUSED"); } } });
  const row = await h.probeFirmware(P, 500);
  assert.equal(row.skipped, true);
  assert.match(row.reason, /ECONNREFUSED/);
});

// ---- The capability gate ----

test("a connector declaring firmwareInfo:false is never called, even if it exports the method", async () => {
  // Exactly the FlashForge-in-native case: the export exists, the capability
  // says no, and calling it anyway is what hung the tab.
  const h = harness({ caps: { firmwareInfo: false } });
  const row = await h.probeFirmware(P, 500);
  assert.equal(row.skipped, true);
  assert.equal(row.reasonCode, "not_supported");
  assert.equal(h.calls.includes("getFirmwareInfo"), false, "the connector must not be touched at all");
});

test("a connector with no getFirmwareInfo at all is still handled", async () => {
  const h = harness({ connector: { getFirmwareInfo: undefined } });
  const row = await h.probeFirmware(P, 500);
  assert.equal(row.skipped, true);
  assert.equal(row.reasonCode, "not_supported");
});

// ---- Offline ----

test("an offline printer is skipped without calling the connector, keeping its error detail", async () => {
  const h = harness({ probe: { online: false, error: "connect ETIMEDOUT 192.168.40.31:8898" } });
  const row = await h.probeFirmware(P, 500);
  assert.equal(row.skipped, true);
  assert.equal(row.reasonCode, "offline");
  assert.equal(row.online, false);
  // The UI renders status_offline_detail from this; dropping it would be a
  // regression against what the connectors themselves used to return.
  assert.match(row.detail, /ETIMEDOUT/);
  assert.equal(h.calls.includes("getFirmwareInfo"), false);
});

// ---- U1-only scope ----

test("only printers SnapCon can actually flash are listed", () => {
  // firmwareDeploy is the capability that means "SnapCon can flash this",
  // which is what the tab is for, and it is U1-only today. Gating on the
  // capability rather than on a connector name keeps the brand check out of
  // shared code (CLAUDE.md section 3).
  const h = harness();
  assert.equal(h.eligible({ connector: "snapmaker-u1-klipper-ws" }), true);

  const no = harness({ caps: { firmwareDeploy: false } });
  assert.equal(no.eligible({ connector: "creality-klipper" }), false);

  const absent = harness({ caps: { firmwareDeploy: undefined } });
  assert.equal(absent.eligible({ connector: "bambu-lab" }), false,
    "a connector that never declares it must not be included by accident");
});

// ---- The route wiring ----

test("streaming is opt-in — the plain call still answers with a JSON array", () => {
  // /api/firmware answered with a JSON array for its whole life, and app.js is
  // served with no cache-busting (<script src="/app.js">), so a browser
  // holding the previous copy still calls it that way after an upgrade.
  // Switching the response to NDJSON in place broke that client with
  // "JSON.parse: unexpected non-whitespace character after JSON data at line 2
  // column 1" until a hard reload — reported live. The stream is therefore
  // requested explicitly and the old contract is left intact.
  const start = serverSrc.indexOf('app.get("/api/firmware"');
  const route = serverSrc.slice(start, serverSrc.indexOf("\n  });", start + 10));
  assert.match(route, /req\.query\.stream/, "the stream must be asked for");
  assert.match(route, /res\.json\(rows\)/, "the default response is still a JSON array of rows");
});

test("the route streams NDJSON and never awaits the whole fleet at once", () => {
  const start = serverSrc.indexOf('app.get("/api/firmware"');
  assert.ok(start > 0);
  const route = serverSrc.slice(start, serverSrc.indexOf("\n  });", start + 10));
  assert.match(route, /application\/x-ndjson/, "rows stream as they arrive");
  // Batching a handful at a time is fine and is what /api/discover does; what
  // must not come back is one await spanning the ENTIRE fleet, where a single
  // printer that never settles means no response at all.
  assert.doesNotMatch(route, /Promise\.all\(\s*visible\.map/,
    "awaiting every printer in one go is what let one hang block the whole response");
  assert.match(route, /visible\.slice\(/, "printers are probed in bounded batches");
  assert.match(route, /firmwareTabEligible/, "the list is scoped to flashable printers");
  assert.match(route, /req\.on\("close"/, "a browser that navigates away stops the sweep");
});

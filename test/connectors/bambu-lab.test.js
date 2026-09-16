// test/connectors/bambu-lab.test.js — the Bambu Lab connector's decoding,
// checked against a report captured from a real P2S rather than a hand-written
// sample (test/fixtures/bambu-p2s-report.js; CLAUDE.md section 2).
//
// The idle fixture is the interesting one: the printer had finished a cloud job
// and still reports mc_percent 100, layer_num 750 and that job's name, with AMS
// tray 1 present but empty. Every "do not show stale data" rule below comes
// from that capture.
const test = require("node:test");
const assert = require("node:assert/strict");
const bambu = require("../../connectors/bambu-lab");
const { IDLE_REPORT } = require("../fixtures/bambu-p2s-report");

const P = { name: "P2S", id: "p1", url: "http://192.168.16.223", serial: "22E8AJ5C2001188", verificationCode: "abcd1234" };
const norm = (print, opts) => bambu._internal.normalizeBambuState(P, print, opts);

// ---- registration and capabilities ----

test("the connector is registered under its own type", () => {
  const { listConnectorTypes } = require("../../connectors");
  const entry = listConnectorTypes().find(c => c.type === "bambu-lab");
  assert.ok(entry, "Settings' connector picker reads this list");
  assert.equal(entry.brand, "Bambu Lab");
});

test("its address is the printer's IP with a fixed port", () => {
  // Both ports Bambu uses (8883 MQTT, 990 FTPS) are fixed by the firmware, so
  // the Settings row must not offer a Port field to get wrong.
  assert.equal(bambu.address.portEditable, false);
  assert.equal(bambu.address.required, true);
});

test("E-Stop and Eject are declared unsupported rather than silently missing", () => {
  // Bambu has no network emergency stop: `stop` is an ordinary cancel. The
  // buttons stay visible but disabled with a reason (the FlashForge precedent).
  assert.equal(bambu.capabilities.estop, false);
  assert.equal(bambu.capabilities.eject, false);
});

test("it accepts the two file types the printer can start", () => {
  // A sliced .3mf (project_file) and a plain .gcode (gcode_file) — two
  // different start commands, both offered. What it must NOT accept is the rest
  // of the library's extensions, which this firmware has no command for.
  assert.deepEqual(bambu.capabilities.fileTypes, ["3mf", "gcode"]);
  for (const ext of ["gco", "g", "gx"]) {
    assert.ok(!bambu.capabilities.fileTypes.includes(ext), ext + " has no start command on a Bambu");
  }
});

test("print options SnapCon has not verified on hardware stay off", () => {
  for (const k of ["autoLevel", "flowCalibration", "timelapse"]) {
    assert.equal(bambu.capabilities[k], false, k + " has not been verified on a Bambu printer");
  }
});

test("it declares that it has no use for a Moonraker API token", () => {
  // A Bambu printer authenticates with its serial and access code. Offering an
  // API token field would be a control that does nothing.
  assert.equal(bambu.capabilities.apiToken, false);
});

test("the Settings row hides the API token for a connector that declares none", () => {
  const fs = require("fs"), path = require("path");
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");
  const at = appSrc.indexOf("const syncPrintPrefVisibility=()=>{");
  assert.ok(at > 0);
  const fn = appSrc.slice(at, appSrc.indexOf("\n  };", at));
  // === false, never a truthiness check: every existing connector omits the
  // flag and a loose test would hide the token field across the whole fleet.
  assert.match(fn, /caps\.apiToken===false/);
  // Brand-specific BEHAVIOUR belongs in the connector (CLAUDE.md section 3).
  // Comments may name a brand as an example — only the code must not branch on
  // one, so the check runs against the code with comment lines removed.
  const code = fn.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /bambu/i, "the connector declares this; the row must not branch on a brand");
});

// ---- what the printer must be given before anything is attempted ----

for (const [missing, field, expect] of [
  ["serial", "serial", /serial/i],
  ["access code", "verificationCode", /access code/i]
]) {
  test(`probe explains a missing ${missing} instead of failing to connect`, async () => {
    const st = await bambu.probe({ ...P, [field]: "" });
    assert.equal(st.online, false);
    assert.match(st.error, expect);
    assert.match(st.error, /Settings/, "the message must say where to put it");
  });
}

test("the serial is upper-cased before it is used as a topic", () => {
  // MQTT topics are case-sensitive: a lower-case serial connects, subscribes
  // successfully and then receives nothing at all. Cost us a whole probe run.
  const cfg = bambu._internal.printerConfig({ ...P, serial: "22e8aj5c2001188" });
  assert.equal(cfg.serial, "22E8AJ5C2001188");
});

// ---- decoding the captured idle report ----

test("a finished print reads as complete", () => {
  const st = norm(IDLE_REPORT);
  assert.equal(st.online, true);
  assert.equal(st.state, "complete");
});

test("a cancelled print is not reported as an error", () => {
  // Bambu ends both a user cancel and a real failure in FAILED; 0x0300400C is
  // the printer's own "task was canceled" code.
  assert.equal(norm({ ...IDLE_REPORT, gcode_state: "FAILED", print_error: 0x0300400C }).state, "cancelled");
  assert.equal(norm({ ...IDLE_REPORT, gcode_state: "FAILED", print_error: 0 }).state, "cancelled");
  assert.equal(norm({ ...IDLE_REPORT, gcode_state: "FAILED", print_error: 0x03004003 }).state, "error");
});

test("a pause the printer took itself is surfaced with its code", () => {
  // The verified print test hit exactly this: PAUSE with 0x0500803C, the
  // printer waiting for someone to confirm a nozzle that does not match the
  // sliced file. It is a question, not a fault — the card must show it.
  const st = norm({ ...IDLE_REPORT, gcode_state: "PAUSE", print_error: 0x0500803C });
  assert.equal(st.state, "paused");
  assert.equal(st.errorCode, "0500-803C");
  assert.match(st.message, /nozzle/i, "our own wording, not a bare code");
});

test("an ordinary pause carries no error", () => {
  const st = norm({ ...IDLE_REPORT, gcode_state: "PAUSE", print_error: 0 });
  assert.equal(st.state, "paused");
  assert.equal(st.errorCode, "");
});

test("an unknown error code still shows the code itself", () => {
  const st = norm({ ...IDLE_REPORT, gcode_state: "FAILED", print_error: 0x07028011 });
  assert.equal(st.errorCode, "0702-8011");
  assert.match(st.message, /0702-8011/);
});

test("the previous job's progress is not shown on an idle printer", () => {
  // The captured report still says mc_percent 100 with the printer sitting
  // idle. Reported as a live 100% it would fire every completion notification
  // again on connect.
  const st = norm({ ...IDLE_REPORT, gcode_state: "IDLE" });
  assert.equal(st.state, "standby");
  assert.equal(st.progress, 0);
});

test("the previous job's layer count is not shown on an idle printer", () => {
  const st = norm({ ...IDLE_REPORT, gcode_state: "IDLE" });
  assert.equal(st.layer, null, "layer_num 750 belongs to a job that ended");
});

test("layer and progress are shown while a print is running", () => {
  const st = norm({ ...IDLE_REPORT, gcode_state: "RUNNING", mc_percent: 13, layer_num: 42, total_layer_num: 94 });
  assert.equal(st.state, "printing");
  assert.equal(st.progress, 0.13);
  assert.deepEqual(st.layer, { current: 42, total: 94 });
});

test("remaining time is reported as unavailable until its unit is verified", () => {
  // mc_remaining_time read 0 for the whole verified print, so nothing confirms
  // whether it counts minutes or seconds. An absent value is honest; a wrong
  // one would drive notifications and the queue (CLAUDE.md section 2).
  const st = norm({ ...IDLE_REPORT, gcode_state: "RUNNING", mc_remaining_time: 17 });
  assert.equal(st.remaining, null);
});

test("temperatures come from the fields the P2S actually reports", () => {
  const st = norm(IDLE_REPORT);
  assert.deepEqual(st.hotend, { temp: 21, target: 0 });
  assert.deepEqual(st.bed, { temp: 16, target: 0 });
});

test("a printer that reports no chamber temperature is not given one", () => {
  const st = norm(IDLE_REPORT);
  assert.ok(!("chamber" in st) || st.chamber == null,
    "device.ctc.info.temp is unconfirmed as a chamber reading");
});

// ---- AMS ----

test("the AMS is reported as A1-A4 plus the external spool", () => {
  const st = norm(IDLE_REPORT);
  assert.deepEqual(st.heads.map(h => h.label), ["A1", "A2", "A3", "A4", "Ext"],
    "the labels the printer's own screen uses");
});

test("a loaded tray carries its material and colour", () => {
  const a1 = norm(IDLE_REPORT).heads[0];
  assert.equal(a1.loaded, true);
  assert.equal(a1.material, "PLA");
  assert.equal(a1.sub, "PLA Basic");
  assert.equal(a1.hex, "#545454");
});

test("an empty tray is an empty slot, never a spool", () => {
  // Captured: tray 1 reports {id, state} and nothing else, and the printer's
  // own tray_exist_bits ("d") agrees it is empty. CLAUDE.md section 5: a spool
  // graphic claims filament is present.
  const a2 = norm(IDLE_REPORT).heads[1];
  assert.equal(a2.loaded, false);
  assert.equal(a2.hex, null);
  assert.equal(a2.material, null);
});

test("nothing is marked as the active slot when the printer has nothing loaded", () => {
  assert.equal(norm(IDLE_REPORT).activeExt, null, "tray_now is 255 and the extruder holds nothing");
});

test("the external spool is reported but is not offered for printing", () => {
  // Selecting it needs an ams_mapping/use_ams encoding we have not verified on
  // hardware, so it is display-only in this beta.
  const ext = norm(IDLE_REPORT).heads[4];
  assert.equal(ext.label, "Ext");
  assert.equal(ext.mappable, false);
  for (const tray of norm(IDLE_REPORT).heads.slice(0, 4)) assert.equal(tray.mappable, true);
});

// ---- the external spool lane is optional ----

test("the external spool lane can be switched off for a printer that has none", () => {
  // A farm that never loads the external holder gets a permanently empty lane
  // on every card otherwise. Off by configuration, not by guessing from the
  // report: an unused holder looks exactly like a missing one.
  const st = norm(IDLE_REPORT, { printer: { ...P, externalSpool: false } });
  assert.deepEqual(st.heads.map(h => h.label), ["A1", "A2", "A3", "A4"]);
});

test("the external spool lane is shown unless it was switched off", () => {
  for (const printer of [P, { ...P, externalSpool: true }, { ...P, externalSpool: undefined }]) {
    assert.equal(norm(IDLE_REPORT, { printer }).heads.length, 5);
  }
});

test("hiding the lane does not shift which slot is marked active", () => {
  // activeExt is an index into heads[]; dropping a lane from the end must not
  // make A4 point at A3.
  const running = { ...IDLE_REPORT, ams: { ...IDLE_REPORT.ams, tray_now: "3" },
    device: { ...IDLE_REPORT.device, extruder: { state: 0, info: [{ id: 0, snow: (0 << 8) | 3 }] } } };
  assert.equal(norm(running).heads[norm(running).activeExt].label, "A4");
  const hidden = norm(running, { printer: { ...P, externalSpool: false } });
  assert.equal(hidden.heads[hidden.activeExt].label, "A4");
});

test("the connector offers the external-spool switch so Settings knows to show it", () => {
  assert.equal(bambu.capabilities.externalSpoolOption, true);
});

// ---- controls the printer does not have ----

const fs = require("fs"), path = require("path");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "..", "public", "app.js"), "utf8");

test("Eject is offered only by connectors that can actually clear a job", () => {
  const at = appSrc.indexOf("function ejectUnsupported(p)");
  assert.ok(at > 0, "a capability helper, mirroring estopUnsupported");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
  assert.match(fn, /capabilities\.eject\s*===\s*false/,
    "=== false, like estop: connectors that can eject never declare the flag");
});

test("on a printer with no eject command, the button appears only for a file SnapCon staged", () => {
  // Verified live on a P2S: nothing clears a finished or cancelled job off the
  // machine — clean_print_error is accepted and changes nothing, print_clean is
  // refused outright. The state goes when the next print starts. So the only
  // thing Eject can still mean here is "drop the file SnapCon is holding for
  // this printer", and with nothing staged the button is not offered at all.
  // (It was shown disabled first; that read as a broken button.)
  const at = appSrc.indexOf("function canEject(p)");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
  assert.match(fn, /ejectUnsupported\(p\)/);
  assert.match(fn, /queuedFile/, "SnapCon's own staged file is what remains ejectable");
});

test("ejecting on such a printer clears SnapCon's staged file instead of failing", async () => {
  // The route clears the staged entry after the connector call, so the call
  // must not throw — otherwise the one case where Eject IS meaningful fails.
  await bambu.eject({ name: "P2S", id: "x" });
});

// ---- the external-spool switch, end to end ----

test("Settings shows the external-spool switch only for a connector that offers it", () => {
  const at = appSrc.indexOf("const syncPrintPrefVisibility=()=>{");
  const fn = appSrc.slice(at, appSrc.indexOf("\n  };", at));
  assert.match(fn, /caps\.externalSpoolOption/);
  const code = fn.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /bambu/i, "the connector declares this; the row must not branch on a brand");
});

test("the switch is read on save and counted as a change", () => {
  for (const [what, marker] of [["the save payload", "function gatherPrinters()"],
                                ["the dirty-state snapshot", "function serializeRowForDiff(row)"]]) {
    const at = appSrc.indexOf(marker);
    const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
    assert.match(fn, /externalSpool:/, what + " must carry the switch");
  }
});

test("a saved printer keeps the external spool unless it was switched off", async () => {
  // Mirrors forceDefaults: absent means "unset, use the default", and only an
  // explicit false is stored — so an existing config that predates this switch
  // behaves exactly as it always did.
  const vm = require("node:vm");
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const start = serverSrc.indexOf("async function buildPrinterRecord(p, existing)");
  const ctx = vm.createContext({
    CONNECTOR_TYPES: ["bambu-lab"], DEFAULT_CONNECTOR_TYPE: "bambu-lab",
    BRAND_EDITABLE_CONNECTOR: "klipper-moonraker", CFG: { groups: [] },
    resolvePrinterAddress: x => ({ url: String(x.url || "") }),
    getConnector: () => ({ brand: "Bambu Lab" }), sanitizeBrand: b => String(b || ""),
    newPrinterId: () => "id1", detectCrealityWebrtcCamera: async () => {}
  });
  vm.runInContext(serverSrc.slice(start, serverSrc.indexOf("\n}", start) + 2), ctx);
  const build = vm.runInContext("buildPrinterRecord", ctx);
  const base = { name: "P2S", url: "http://x", connector: "bambu-lab" };
  assert.equal((await build({ ...base, externalSpool: false }, undefined)).externalSpool, false);
  assert.equal((await build({ ...base, externalSpool: true }, undefined)).externalSpool, undefined,
    "the default is not written to config.json");
  assert.equal((await build({ ...base }, { externalSpool: false })).externalSpool, false,
    "a save that does not mention it must not silently turn the lane back on");
});

// ---- choosing which tray feeds each filament ----

test("the tray picker uses the printer's own lane names", () => {
  const at = appSrc.indexOf("const cmapNeed=neededColorsOrSlot();");
  assert.ok(at > 0, "the per-colour head picker must exist");
  const block = appSrc.slice(at, at + 2600);
  assert.match(block, /h\.label/, "A1-A4 rather than T1-T4 for a printer that names its own");
});

test("a slot that cannot feed a print is not offered as a choice", () => {
  // The external spool is shown on the card but cannot be mapped yet. Offering
  // it would let someone pick a tray the connector then refuses.
  const at = appSrc.indexOf("const cmapNeed=neededColorsOrSlot();");
  const block = appSrc.slice(at, at + 2600);
  assert.match(block, /mappable===false/);
  assert.match(block, /\.filter\(/, "the unmappable slots are filtered out of the choices");
});

// ---- the file browser ----

test("a file's row says whether it is a 3MF and whether it can be printed", () => {
  // Two files exported from the same slicer on the same day, both named .3mf:
  // one sliced, one not. Only the sliced one can print, and the name does not
  // say which is which.
  const at = appSrc.indexOf("function renderList()");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
  assert.match(fn, /fileKindBadge\(f\)/, "the row carries a type badge");
  const badge = appSrc.slice(appSrc.indexOf("function fileKindBadge("),
                             appSrc.indexOf("\n}", appSrc.indexOf("function fileKindBadge(")));
  assert.match(badge, /f\.sliced===false/,
    "and says when a 3MF cannot be printed — absent means another vendor's file, left alone");
});

test("the badge sits beside the name, which keeps its extension stripped", () => {
  // CLAUDE.md section 5 keeps the extension out of the visible name and the
  // whole name in a title. The badge is the called-out exception that tells
  // 3MF from gcode without putting the extension back.
  const at = appSrc.indexOf("function fileKindBadge(");
  assert.ok(at > 0, "a single helper, so both file lists agree");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
  assert.match(fn, /3MF/);
  assert.match(fn, /GCODE/);
  const list = appSrc.slice(appSrc.indexOf("function renderList()"), appSrc.indexOf("\n}", appSrc.indexOf("function renderList()")));
  assert.match(list, /stripExt\(f\.name\)/, "the visible name still loses its extension");
});

test("the lane header uses the label the connector supplies", () => {
  // Hard-coded T1..Tn would show the external spool as "T5" and the AMS trays
  // as T1..T4, neither of which matches what is written on the printer.
  const at = appSrc.indexOf("function afcLanesHtml(");
  const fn = appSrc.slice(at, appSrc.indexOf("\n}", at));
  assert.match(fn, /h&&h\.label/, "a connector-supplied label wins");
  assert.match(fn, /headLabel\(i\)/, "and every other connector keeps its numbering");
});

// ---- merging deltas ----

test("a delta naming one tray leaves the others alone", () => {
  const merged = bambu._internal.mergeReport(structuredClone(IDLE_REPORT),
    { ams: { ams: [{ id: "0", tray: [{ id: "2", tray_type: "ABS" }] }] } });
  const trays = merged.ams.ams[0].tray;
  assert.equal(trays.length, 4, "the other three must survive");
  assert.equal(trays[2].tray_type, "ABS");
  assert.equal(trays[0].tray_type, "PLA", "A1 was not mentioned and must not change");
});

test("a tray reported as nothing but its id means the spool was removed", () => {
  const merged = bambu._internal.mergeReport(structuredClone(IDLE_REPORT),
    { ams: { ams: [{ id: "0", tray: [{ id: "0" }] }] } });
  assert.equal(merged.ams.ams[0].tray[0].tray_type, undefined,
    "keeping the old material would show a spool that is gone");
});

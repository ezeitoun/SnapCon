// test/connectors/flashforge-capabilities.test.js — per-mode capability
// reporting and probe dispatch for both FlashForge connectors.
//
// These run against a real http server that can answer BOTH protocols, so the
// dispatch decision is exercised end to end rather than asserted against a
// stub. Which transport "exists" is controlled per test by turning each
// protocol's endpoints on or off — the same thing a firmware flash does to a
// real printer.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const path = require("path");
const mode = require("../../connectors/flashforge-mode");
const fm = require("../../connectors/flashforge-moonraker");
const ad5x = require("../../connectors/flashforge-ad5x");
const adv = require("../../connectors/flashforge-adventurer");

// A printer that can be stock, modded, both, or dead. Both transports resolve
// to the same origin because the test URL carries an explicit port, which both
// baseUrl() implementations preserve.
function fakePrinter(opts = {}) {
  const {
    native = false, moonraker = false,
    webcams = [], camImagePath = null, ifs = false, ffmInfo = null, printStartOverridden = false,
    ifsVars = null, portSensors = [false, false, false, false]
  } = opts;
  const seen = [];
  const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push(req.method + " " + u.pathname + u.search);
    if (u.pathname === "/printer/gcode/script") return json(res, { result: "ok" });
    if (u.pathname === "/printer/print/pause" || u.pathname === "/printer/print/resume"
      || u.pathname === "/printer/print/cancel" || u.pathname === "/printer/emergency_stop") return json(res, { result: "ok" });
    if (u.pathname === "/server/files/list") return json(res, { result: [] });
    if (u.pathname === "/machine/system_info" && false) { /* handled below */ }
    if (req.method === "POST" && u.pathname === "/detail") {
      if (!native) { res.statusCode = 404; return res.end(); }
      return json(res, { code: 0, detail: { status: "ready", printProgress: 0, platTemp: 20, platTargetTemp: 0, rightTemp: 21, rightTargetTemp: 0 } });
    }
    if (!moonraker) { res.statusCode = 404; return res.end(); }
    if (u.pathname === "/printer/info") return json(res, { result: { state: "ready", software_version: "?" } });
    if (u.pathname === "/server/webcams/list") return json(res, { result: { webcams } });
    // A camera is only advertised after the rebuilt candidate is VERIFIED to
    // return a real image, so a fixture claiming a webcam must actually serve
    // one — otherwise it is testing a printer with a broken camera.
    if (camImagePath && u.pathname === camImagePath) {
      res.setHeader("content-type", "image/jpeg");
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]));
    }
    if (u.pathname === "/printer/objects/list") {
      const objs = ["print_stats", "virtual_sdcard", "heater_bed", "extruder", "toolhead", "exclude_object"];
      // ZMOD replaces the built-in with a macro of the same name; Forge-X does not.
      if (printStartOverridden) objs.push("gcode_macro SDCARD_PRINT_FILE");
      if (ifs) objs.push("zmod_ifs_switch_sensor _ifs_port_sensor_1", "zmod_ifs_switch_sensor _ifs_port_sensor_2",
        "zmod_ifs_switch_sensor _ifs_port_sensor_3", "zmod_ifs_switch_sensor _ifs_port_sensor_4", "gcode_macro _IFS_VARS");
      return json(res, { result: { objects: objs } });
    }
    if (u.pathname === "/server/files/config/Adventurer5M.json") {
      return ffmInfo ? json(res, { FFMInfo: ffmInfo }) : json(res, { cameraInfo: {} });
    }
    if (u.pathname === "/machine/system_info") return json(res, { result: { system_info: { distribution: { name: "zmod 1.7.1", kernel_version: "5.10" } } } });
    if (u.pathname === "/printer/objects/query") {
      const status = {
        print_stats: { state: "standby", filename: "", print_duration: 0, filament_used: 0, info: {} },
        display_status: { progress: 0 }, virtual_sdcard: { progress: 0 },
        heater_bed: { temperature: 20, target: 0 }, extruder: { temperature: 21, target: 0 },
        fan: {}, gcode_move: { speed_factor: 1 }, toolhead: { extruder: "extruder" },
        exclude_object: { objects: [], excluded_objects: [], current_object: null }
      };
      if (ifs) {
        portSensors.forEach((v, i) => { status[`zmod_ifs_switch_sensor _ifs_port_sensor_${i + 1}`] = { filament_detected: v, enabled: true }; });
        status["gcode_macro _IFS_VARS"] = ifsVars || { tools: [1, 2, 3, 4], current_tool: -1 };
      }
      return json(res, { result: { eventtime: 1, status } });
    }
    res.statusCode = 404; res.end();
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () =>
    r({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() })));
}

const P = (s, over = {}) => ({ id: "prt_" + Math.random().toString(16).slice(2), name: "FF", url: s.url, ...over });

test.beforeEach(() => { mode._resetAll(); fm._resetCaches(); });

// ---- dispatch ----

test("a stock printer probes over the native API", async () => {
  const s = await fakePrinter({ native: true });
  try {
    const r = await adv.probe(P(s));
    assert.equal(r.online, true);
    assert.equal(r.state, "standby");  // STATE_MAP maps FlashForge "ready" -> standby
  } finally { s.close(); }
});

test("a modded printer probes over Moonraker", async () => {
  const s = await fakePrinter({ moonraker: true });
  try {
    const r = await adv.probe(P(s));
    assert.equal(r.online, true);
    assert.equal(r.state, "standby");
  } finally { s.close(); }
});

test("a printer answering neither transport reports the standard offline shape", async () => {
  const s = await fakePrinter({});
  try {
    const r = await adv.probe(P(s));
    assert.equal(r.online, false);
    assert.equal(r.name, "FF");
    assert.ok(typeof r.error === "string" && r.error.length);
    assert.equal(r.state, undefined, "offline must not invent a state");
  } finally { s.close(); }
});

test("an unreachable printer surfaces the transport's own error, not a generic one", async () => {
  // A FlashForge auth failure ("SN is different", "check code error") is the
  // only thing that tells a user their serial/checkCode is wrong. Detection
  // must not swallow it behind "could not reach".
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: 5, message: "SN is different" }));
  });
  const s = await new Promise(r => srv.listen(0, "127.0.0.1", () =>
    r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
  try {
    const r = await adv.probe(P(s));
    assert.equal(r.online, false);
    assert.equal(r.error, "SN is different");
  } finally { s.close(); }
});

// ---- capabilities per mode ----

test("Moonraker mode gains exclude-object, firmware info, health, file sync and a web UI", async () => {
  const s = await fakePrinter({ moonraker: true });
  try {
    const p = P(s);
    await adv.probe(p);
    const c = adv.getCapabilities(p);
    assert.equal(c.excludeObject, true);
    assert.equal(c.firmwareInfo, true);
    assert.equal(c.health, true);
    assert.equal(c.fileSync, true);
    assert.equal(c.webUi, true);
  } finally { s.close(); }
});

test("native capabilities are exactly today's static set", async () => {
  const s = await fakePrinter({ native: true });
  try {
    const p = P(s);
    await adv.probe(p);
    assert.deepEqual(adv.getCapabilities(p), adv.capabilities);
  } finally { s.close(); }
});

test("with nothing detected yet, getCapabilities returns the static native set without throwing", () => {
  assert.deepEqual(adv.getCapabilities({ id: "unknown", url: "http://x" }), adv.capabilities);
});

test("getCapabilities is synchronous — server.js builds fleet rows without awaiting", () => {
  const c = ad5x.getCapabilities({ id: "u", url: "http://x" });
  assert.ok(c && typeof c === "object" && typeof c.then !== "function");
});

// ---- gated capabilities stay off ----

test("unverified Moonraker capabilities ship off", async () => {
  const s = await fakePrinter({ moonraker: true, ifs: true, portSensors: [true, false, false, false] });
  try {
    const p = P(s);
    await ad5x.probe(p);
    const c = ad5x.getCapabilities(p);
    // Each of these needs a controlled hardware run before it can be trusted.
    assert.equal(c.setColor, false, "setColor is a hardware gate");
    assert.equal(c.unloadFilament, false, "unloadFilament is a hardware gate");
    assert.equal(c.autoLevel, false, "autoLevel is a hardware gate");
    // headMapping stays off until the print-start macro is verified: offering a
    // mapping picker that cannot be acted on is worse than offering nothing.
    assert.equal(c.headMapping, false, "headMapping is gated on print-start verification");
  } finally { s.close(); }
});

test("Moonraker start-print is not implemented, and fails loudly rather than guessing a macro", async () => {
  const s = await fakePrinter({ moonraker: true, ifs: true });
  try {
    const p = P(s);
    await ad5x.probe(p);
    await assert.rejects(() => ad5x.startPrintFile(p, "x.gcode"), /not (yet )?(verified|supported)/i);
  } finally { s.close(); }
});

// ---- camera derivation ----

test("an enabled camera on the printer's own host reports camera: true", async () => {
  const s = await fakePrinter({
    moonraker: true,
    webcams: [{ name: "video", enabled: true, snapshot_url: "/webcam/?action=snapshot" }],
    camImagePath: "/webcam/"
  });
  try {
    const p = P(s);
    await adv.probe(p);
    assert.equal(adv.getCapabilities(p).camera, true);
  } finally { s.close(); }
});

test("a disabled placeholder camera reports camera: false", async () => {
  // The disabled-placeholder shape seen on a real Forge-X printer.
  const s = await fakePrinter({ moonraker: true, webcams: [{ name: "Example", enabled: false, snapshot_url: "http://your_IP:8080/?action=snapshot" }] });
  try {
    const p = P(s);
    await adv.probe(p);
    assert.equal(adv.getCapabilities(p).camera, false);
    assert.equal(adv.getCapabilities(p).cameraSnapshot, false);
  } finally { s.close(); }
});

test("no webcam configured at all reports camera: false", async () => {
  const s = await fakePrinter({ moonraker: true, webcams: [] });
  try {
    const p = P(s);
    await adv.probe(p);
    assert.equal(adv.getCapabilities(p).camera, false);
  } finally { s.close(); }
});

// ---- AD5X IFS vs Adventurer ----

test("Adventurer reports no heads in either mode", async () => {
  const nat = await fakePrinter({ native: true });
  const moon = await fakePrinter({ moonraker: true });
  try {
    const pn = P(nat), pm = P(moon);
    assert.deepEqual((await adv.probe(pn)).heads, []);
    assert.deepEqual((await adv.probe(pm)).heads, []);
    // Read capabilities for the SAME printer object that was probed — a fresh
    // id would fall through to the static set and pass for the wrong reason.
    assert.equal(adv.getCapabilities(pm).filamentHeads, false);
    assert.equal(adv.getCapabilities(pn).filamentHeads, false);
  } finally { nat.close(); moon.close(); }
});

test("an AD5X with no IFS evidence degrades to no slots rather than a partial heads[]", async () => {
  const s = await fakePrinter({ moonraker: true, ifs: false });
  try {
    const p = P(s);
    const r = await ad5x.probe(p);
    assert.deepEqual(r.heads, []);
    assert.equal(r.activeExt, null);
    assert.equal(ad5x.getCapabilities(p).filamentHeads, false);
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// The `transport` override field: config persistence and Settings wiring.
//
// server.js can't be required without starting a listener and app.js is
// browser-global code with no Node harness, so both are asserted against source
// text — the established pattern in this suite (see printer-address.test.js).
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, "..", "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const enSrc = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));

test("server.js persists transport, and only the two valid values", () => {
  // An allowlist, not a passthrough: anything else must fall back to auto
  // rather than being stored and later dispatched on.
  assert.match(serverSrc, /p\.transport\s*===\s*"native"[\s\S]{0,60}p\.transport\s*===\s*"moonraker"[\s\S]{0,60}o\.transport\s*=\s*p\.transport/);
});

test("the Settings row offers auto / native / moonraker", () => {
  assert.match(appSrc, /class="field ptransport"/);
  for (const v of ["auto", "native", "moonraker"]) {
    assert.match(appSrc, new RegExp(`<option value="${v}"`), v + " option");
  }
});

test("the transport selector is shown only for FlashForge connectors", () => {
  // Every other connector speaks exactly one protocol; offering the choice
  // there would imply a switch that does nothing.
  assert.match(appSrc, /transport-wrap/);
  assert.match(appSrc, /isFlashForge/);
});

test("switching to a non-FlashForge connector clears the transport selection", () => {
  // The field is hidden for other connectors; leaving a stale "moonraker" in a
  // hidden control would persist a pin the user can no longer see or undo.
  assert.match(appSrc, /if\(!isFlashForge\) transportEl\.value="auto";/);
});

test("the row's saved payload carries transport, and sends auto as no pin at all", () => {
  assert.match(appSrc, /transport:[^\n]*\.ptransport/, "save payload must read .ptransport");
  // "auto" is the absence of a pin: storing it would put a value in config.json
  // that means the same as omitting the field, and the server allowlist would
  // drop it anyway.
  assert.match(appSrc, /transport:[^\n]*"native"[^\n]*"moonraker"[^\n]*undefined/);
});

test("transport strings are translated, not hardcoded in the markup", () => {
  for (const k of ["field_transport", "transport_option_auto", "transport_option_native", "transport_option_moonraker", "transport_hint"]) {
    assert.ok(enSrc.settings && enSrc.settings.printers && enSrc.settings.printers[k], "missing en key: " + k);
  }
});


// ---------------------------------------------------------------------------
// Control dispatch. Status is only half the connector — every control action
// has to reach the transport the printer is actually speaking. A modded printer
// has :8898 CLOSED, so a control call left pointing at the native API does not
// degrade gracefully, it fails outright.
// ---------------------------------------------------------------------------

test("control actions on a modded printer go over Moonraker, not the closed native API", async () => {
  const s = await fakePrinter({ moonraker: true });
  try {
    const p = P(s);
    await adv.probe(p);
    s.seen.length = 0;
    await adv.pause(p);
    await adv.resume(p);
    await adv.cancel(p);
    await adv.bedTemp(p, 60);
    const sent = s.seen.join(" | ");
    assert.ok(/printer\/(print\/(pause|resume|cancel)|gcode\/script)/.test(sent), "must use Moonraker endpoints, got: " + sent);
    assert.ok(!/POST \/control/.test(sent), "must not send native /control commands, got: " + sent);
  } finally { s.close(); }
});

test("control actions on a stock printer still go over the native API", async () => {
  const s = await fakePrinter({ native: true });
  try {
    const p = P(s);
    await adv.probe(p);
    s.seen.length = 0;
    await adv.pause(p).catch(() => {});
    assert.ok(s.seen.some(x => x.startsWith("POST /control")), "native path must be unchanged, got: " + s.seen.join(" | "));
  } finally { s.close(); }
});

test("file listing on a modded printer uses Moonraker", async () => {
  const s = await fakePrinter({ moonraker: true });
  try {
    const p = P(s);
    await adv.probe(p);
    s.seen.length = 0;
    await adv.listFiles(p).catch(() => {});
    assert.ok(s.seen.some(x => x.includes("/server/files/list")), "got: " + s.seen.join(" | "));
  } finally { s.close(); }
});

test("capabilities advertised in Moonraker mode have functions behind them", () => {
  // Advertising excludeObject / health / firmwareInfo / fileSync while
  // exporting no implementation makes the UI offer a control that the backend
  // then answers "not supported" to.
  for (const conn of [adv, ad5x]) {
    for (const fn of ["getPlate", "excludeObject", "getHealth", "getFirmwareInfo", "querySyncFiles", "downloadSyncFile", "deleteSyncFile"]) {
      assert.equal(typeof conn[fn], "function", conn.label + " must export " + fn);
    }
  }
});

test("E-Stop falls back to the other transport rather than being lost to a stale mode", async () => {
  // The one deliberate cross-transport retry: an emergency stop must not be
  // swallowed because the cached mode turned out to be wrong.
  const s = await fakePrinter({ moonraker: true });
  try {
    const p = P(s);
    await adv.probe(p);
    p.transport = "native";   // pin to the WRONG transport
    s.seen.length = 0;
    await adv.estop(p).catch(() => {});
    assert.ok(s.seen.some(x => x.includes("emergency_stop") || x.includes("gcode/script")),
      "estop must try the other transport, got: " + s.seen.join(" | "));
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// Print-start gating is keyed on EVIDENCE, not on model. ZMOD replaces
// SDCARD_PRINT_FILE (lesswaste.cfg: `rename_existing: BASE_SDCARD_PRINT_FILE`),
// which is what may open a touchscreen dialog. Forge-X does not, leaving
// Klipper's built-in virtual_sdcard command — the same one klipper-moonraker
// and creality-klipper already send in production.
//
// This matters because ZMOD also supports the FF5M: a 5M Pro on ZMOD uses the
// Adventurer connector, so gating by model would leave that machine ungated.
// ---------------------------------------------------------------------------

test("print-start is gated when the firmware overrides SDCARD_PRINT_FILE", async () => {
  const s = await fakePrinter({ moonraker: true, printStartOverridden: true });
  try {
    const p = P(s);
    await adv.probe(p);
    s.seen.length = 0;
    await assert.rejects(() => adv.startPrintFile(p, "cube.gcode"), /not yet verified/i);
    assert.ok(!s.seen.some(x => x.includes("gcode/script")), "must send no macro at all");
  } finally { s.close(); }
});

test("print-start works when the firmware leaves Klipper's built-in command alone", async () => {
  const s = await fakePrinter({ moonraker: true, printStartOverridden: false });
  try {
    const p = P(s);
    await adv.probe(p);
    s.seen.length = 0;
    await adv.startPrintFile(p, "cube.gcode");
    assert.ok(s.seen.some(x => x.includes("gcode/script") && x.includes("SDCARD_PRINT_FILE")),
      "got: " + s.seen.join(" | "));
  } finally { s.close(); }
});

test("the AD5X stays gated on ZMOD, which does override the command", async () => {
  const s = await fakePrinter({ moonraker: true, ifs: true, printStartOverridden: true });
  try {
    const p = P(s);
    await ad5x.probe(p);
    await assert.rejects(() => ad5x.startPrintFile(p, "cube.gcode"), /not yet verified/i);
  } finally { s.close(); }
});

// connectors/flashforge-adventurer.js — FlashForge Adventurer 5M / 5M Pro.
// Single nozzle, no material station. Built from community-documented API
// (github.com/Parallel-7/flashforge-api-docs) — NOT yet verified against
// real hardware; treat as a first pass to be checked against an actual 5M
// Pro before relying on it for unattended prints.
//
// Config this connector expects on the printer object: `url` (e.g.
// http://192.168.1.50:8898 — FlashForge's HTTP API port, NOT Moonraker's),
// `serial` and `verificationCode` (both read off the printer's touchscreen
// under Settings -> Network/About — same fields the Snapmaker pairing flow
// already uses, just holding a different brand's credentials here).
const ff = require("./flashforge-utils");
const http = require("./http-utils");
const fm = require("./flashforge-moonraker");
const mode = require("./flashforge-mode");

exports.label = "FlashForge (Adventurer 5M / 5M Pro)";
exports.brand = "FlashForge";
// Address contract: the stock API is fixed at 8898 and this connector applies
// it itself (see flashforge-utils baseUrl), so a stored URL stays host-only and
// existing configs are byte-identical. The port is editable now only because a
// firmware mod (ZMOD, Forge-X) takes 8898 down and serves Moonraker on 7125
// instead — the port field is the escape hatch when neither default fits.
// NO defaultPort, deliberately. Each transport applies its own port (see
// forTransport below). A default here is worse than useless: the Settings
// row pre-fills a new printer's port with it, which persisted ":8898" into
// the stored URL and made auto-detection probe 8898 for BOTH transports,
// reporting a healthy modded printer as offline. The port stays editable as
// the advanced override, and is authoritative under a pin.
exports.address = { scheme: "http", defaultPort: null, portEditable: true, required: true };
exports.capabilities = {
  camera: true, cameraSnapshot: true, filamentHeads: false, excludeObject: false, autoLevel: false,
  unloadFilament: false, firmwareInfo: false, inventory: false, discovery: false,
  // The 8898 JSON API has no browsable dashboard at all (confirmed live —
  // its root path 404s), unlike Klipper/Moonraker printers which commonly
  // proxy Fluidd/Mainsail or a vendor UI on the same host.
  webUi: false, setColor: false, singleToolhead: true,
  // Same bed platform family as AD5X, spec'd to 110°C.
  maxBedTemp: 110
};

// ---- transport mode ----
// A 5M/5M Pro runs either stock firmware (native API on 8898) or a mod — ZMOD,
// Forge-X — which takes 8898 down and serves Moonraker on 7125. The decision
// lives in flashforge-mode.js; this file only supplies the two liveness probes
// and interprets the answer.
// ---- transport endpoints ----
// Each transport talks to its own port. `resolveEndpoint` decides which, given
// the pin and whatever port is stored (see its comment for the full rule); this
// wraps the printer so BOTH detection and every later operation use the same
// resolved endpoint. Without that, a legacy printer stored as ":8898" would
// detect Moonraker on 7125 and then quietly send pause/cancel/camera back to
// 8898 — a split brain that reads as online but cannot be controlled.
//
// mode.* always receives the ORIGINAL printer: its cache is keyed on p.id and
// invalidates on p.url change, so handing it a rewritten url would drop the
// entry on every call.
const NATIVE_PORT = "8898", MOONRAKER_PORT = "7125";
const forTransport = (p, want) =>
  ({ ...p, url: fm.resolveEndpoint(p, { want, nativePort: NATIVE_PORT, moonrakerPort: MOONRAKER_PORT }) });
const asNative = p => forTransport(p, "native");
const asMoon = p => forTransport(p, "moonraker");

const modeProbes = p => ({
  native: () => ff.ffPost(asNative(p), "/detail", {}, 3500),
  moonraker: () => fm.ping(asMoon(p), 3500)
});

// What Moonraker mode can actually do on this model. Derived from what the
// transport genuinely supports, not from parity with native — several of these
// are things the stock API has no equivalent for at all.
function moonrakerCaps(extra) {
  return {
    ...exports.capabilities,
    camera: false, cameraSnapshot: false,   // overridden below only on real evidence
    excludeObject: true, firmwareInfo: true, health: true, fileSync: true, webUi: true,
    // Hardware gates — an unverified capability ships off.
    setColor: false, unloadFilament: false, autoLevel: false,
    ...extra
  };
}

// Runs once per detection, not per poll. Camera is decided from live evidence
// because the two mods differ: a ZMOD box advertises a working relative URL,
// while both Forge-X boxes on this fleet advertise either a disabled
// placeholder or a stale absolute URL pointing at another host entirely.
async function buildMoonrakerProfile(p) {
  // ZMOD replaces Klipper's built-in SDCARD_PRINT_FILE with a macro of the same
  // name (lesswaste.cfg: `rename_existing: BASE_SDCARD_PRINT_FILE`), and that
  // override is what may require a touchscreen confirmation. Forge-X leaves the
  // built-in alone. Detect which, rather than assuming by model — ZMOD also
  // supports the FF5M, so a 5M Pro can be on either.
  // Tri-state on purpose: true / false / null-for-unknown. A failed or empty
  // object list must NOT collapse to "not overridden" — that is the permissive
  // answer, and unknown hardware evidence has to fail closed. A live Moonraker
  // always reports objects, so an empty list means the read did not succeed.
  let printStartOverridden = null;
  try {
    const objects = await fm.listObjects(asMoon(p));
    if (objects.length) printStartOverridden = objects.includes("gcode_macro SDCARD_PRINT_FILE");
  } catch { printStartOverridden = null; }
  let cameraUrl = null;
  try { cameraUrl = await fm.resolveWebcam(asMoon(p)); } catch { cameraUrl = null; }
  return {
    transport: "moonraker",
    printStartOverridden,
    cameraUrl,
    capabilities: moonrakerCaps(cameraUrl ? { camera: true, cameraSnapshot: true } : {})
  };
}

async function probe(p) {
  let d = { mode: null };
  try { d = await mode.detect(p, modeProbes(p)); } catch { d = { mode: null }; }
  if (!d.mode) {
    // Prefer the native transport's message: FlashForge's API reports real,
    // user-actionable auth failures ("SN is different", "check code error"),
    // and replacing those with a generic "could not reach" would hide the one
    // thing that tells the user what to fix.
    return { name: p.name, online: false, error: d.nativeError || d.moonrakerError || "Could not reach " + p.name };
  }
  const m = d.mode;
  if (m === "native") {
    try {
      const d = await ff.ffDetail(asNative(p));
      mode.noteSuccess(p);
      if (!mode.getProfile(p)) mode.setProfile(p, { transport: "native", capabilities: exports.capabilities });
      return { ...ff.decodeCommonStatus(p, d), heads: [] };
    } catch (e) {
      mode.noteFailure(p);
      return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
    }
  }
  try {
    const { state } = await fm.probeCommon(asMoon(p));
    mode.noteSuccess(p);
    if (!mode.getProfile(p)) mode.setProfile(p, await buildMoonrakerProfile(p));
    return state;
  } catch (e) {
    mode.noteFailure(p);
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}
exports.probe = probe;

// Synchronous by contract — server.js builds every fleet row with it and cannot
// await. Reads the profile the probe above stored; before the first successful
// probe it reports the static native set, exactly as this connector did before
// dual transport existed. A Moonraker printer therefore shows native
// capabilities for one poll after a restart, then corrects itself.
function getCapabilities(p) {
  if (!p) return exports.capabilities;
  if (p.transport === "moonraker") {
    const pinned = mode.getProfile(p);
    return (pinned && pinned.capabilities) || moonrakerCaps({});
  }
  if (p.transport === "native") return exports.capabilities;
  const prof = mode.getProfile(p);
  return (prof && prof.capabilities) || exports.capabilities;
}
exports.getCapabilities = getCapabilities;

// ---- control dispatch ----
// Status is only half the job: a modded printer has :8898 CLOSED, so any
// control call left pointing at the native API fails outright rather than
// degrading. Each operation below therefore asks which transport is live and
// routes accordingly. The NATIVE branch of every pair is the exact expression
// this connector used before dual transport existed.
async function currentMode(p) {
  if (p.transport === "native" || p.transport === "moonraker") return p.transport;
  const prof = mode.getProfile(p);
  if (prof && prof.transport) return prof.transport;
  // A control action arriving before the first probe runs detection rather
  // than guessing; if nothing answers, native keeps today's behaviour.
  try { return (await mode.detect(p, modeProbes(p))).mode || "native"; }
  catch { return "native"; }
}

// Routes one operation to the transport actually in use.
const byMode = (nativeFn, moonFn) => async (p, ...args) =>
  (await currentMode(p)) === "moonraker" ? moonFn(asMoon(p), ...args) : nativeFn(asNative(p), ...args);

// Moonraker-only: these have no native :8898 equivalent, so the native branch
// says so plainly instead of failing obscurely. getCapabilities reports them
// false in native mode, so this is defence in depth, not the usual path.
const moonrakerOnly = (what, fn) => async (p, ...args) => {
  if ((await currentMode(p)) !== "moonraker") throw new Error(what + " is not available on this printer's stock firmware");
  return fn(asMoon(p), ...args);
};

exports.uploadFile = byMode(ff.uploadFile, http.uploadFile);
exports.pause = byMode(ff.pause, http.pause);
exports.resume = byMode(ff.resume, http.resume);
exports.cancel = byMode(ff.cancel, http.cancel);
exports.eject = byMode(ff.eject, http.eject);
// E-Stop is the ONE deliberate cross-transport retry. Native estop is a raw TCP
// sequence, Moonraker's is an HTTP call — unrelated mechanisms — and a stale or
// mistaken mode must never be what swallows an emergency stop. Bounded: two
// attempts, worst case ~2x one timeout, and only for this operation.
exports.estop = async p => {
  const first = (await currentMode(p)) === "moonraker" ? http.estop : ff.estop;
  const second = first === http.estop ? ff.estop : http.estop;
  const firstP = first === http.estop ? asMoon(p) : asNative(p);
  const secondP = second === http.estop ? asMoon(p) : asNative(p);
  try { return await first(firstP); }
  catch (e) { try { return await second(secondP); } catch { throw e; } }
};
exports.bedTemp = byMode(ff.bedTemp, http.bedTemp);

exports.listFiles = byMode(ff.listFiles, http.listFiles);
exports.getThumbnail = byMode(ff.getThumbnail, http.getThumbnail);
exports.getFileMetadata = byMode(ff.getFileMetadata, http.getFileMetadata);
// Native derives its stream URL from the printer's own host already
// (flashforge-utils getCameraSnapshot). The Moonraker branch goes through the
// verified, host-locked, redirect-bounded path in flashforge-moonraker.js.
// NOT byMode: this needs the profile, and byMode hands its moonFn a printer
// whose url has already been rewritten to the resolved endpoint. mode.* keys on
// p.id and invalidates on a p.url change, so looking the profile up with that
// rewritten printer would DELETE the cache entry on every snapshot. mode.* gets
// the original; only the transport call gets the rewritten one.
exports.getCameraSnapshot = async p => {
  if ((await currentMode(p)) !== "moonraker") return ff.getCameraSnapshot(asNative(p));
  const prof = mode.getProfile(p);
  const mp = asMoon(p);
  const url = (prof && prof.cameraUrl) || await fm.resolveWebcam(mp);
  if (!url) throw new Error("No camera detected for this printer");
  return fm.fetchSnapshot(mp, url);
};

// ---- Moonraker-only capabilities ----
// These are advertised by moonrakerCaps(), so they must exist. Without them the
// UI offers a control the backend then refuses as "not supported".
exports.getPlate = moonrakerOnly("Exclude-object", http.getPlate);
exports.excludeObject = moonrakerOnly("Exclude-object", http.excludeObject);
exports.getHealth = moonrakerOnly("Health", http.queryHealth);
exports.getFirmwareInfo = moonrakerOnly("Firmware info", http.queryFirmwareInfo);
exports.querySyncFiles = moonrakerOnly("File sync", http.queryRemoteFileList);
exports.downloadSyncFile = moonrakerOnly("File sync", http.downloadRemoteFile);
exports.deleteSyncFile = moonrakerOnly("File sync", http.deleteRemoteFile);
// HARDWARE GATE — docs/superpowers/specs/flashforge-dual-transport-design.md §8.
// Only when the firmware has REPLACED the built-in command: that override is
// the thing that may prompt on the touchscreen, and discovering it at runtime
// would mean a queue job hanging overnight. An untouched built-in is stock
// Klipper, which klipper-moonraker and creality-klipper already send.
// NOT byMode, for the same reason as getCameraSnapshot above: this reads the
// profile, and byMode would hand it a url-rewritten printer that invalidates
// the cache entry on lookup.
exports.startPrintFile = async (p, filename) => {
  if ((await currentMode(p)) !== "moonraker") return ff.startPrintFile(asNative(p), filename);
  // Only POSITIVE evidence that the firmware leaves the built-in command alone
  // permits a print start. An absent profile means "not looked at yet", not
  // "safe", so resolve it through the established profile-building path first.
  let prof = mode.getProfile(p);
  if (!prof || prof.printStartOverridden == null) {
    try { prof = await buildMoonrakerProfile(p); } catch { prof = null; }
  }
  if (!prof || prof.printStartOverridden == null) {
    throw new Error(
      "Could not determine how this printer's firmware starts a print, so SnapCon " +
      "will not send one. Check that the printer is reachable and try again, or " +
      "start this print from the printer or Fluidd."
    );
  }
  if (prof.printStartOverridden) {
    throw new Error(
      "Starting a print over Moonraker is not yet verified on this firmware. " +
      "It replaces Klipper's print-start command with its own, which may require confirmation " +
      "on the printer's touchscreen and would leave an unattended job waiting. " +
      "Start this print from the printer or Fluidd."
    );
  }
  return http.startPrintFile(asMoon(p), filename);
};
// Degrades to an empty palette on this printer (confirmed live) — plain
// single-material files have no gcodeListDetail to read from, only AD5X
// multi-material jobs do — but still needs to exist so the client's file
// picker doesn't error out asking for it.

// No getPlate/excludeObject (no exclude_object equivalent documented), no
// getFirmwareInfo (no documented endpoint distinct from /detail's
// firmwareVersion field — not worth a whole capability for one string yet),
// no getInventory, no discoverAt (FlashForge's discovery is UDP
// broadcast/multicast with a binary response format, not an HTTP fingerprint
// — doesn't fit the current discoverAt(baseUrl) interface shape; printers
// need to be added manually by IP + serial + checkCode for now).

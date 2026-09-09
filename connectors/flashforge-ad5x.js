// connectors/flashforge-ad5x.js — FlashForge AD5X, adds the 4-slot IFS
// (Intelligent Filament Station) on top of the same base API as the
// Adventurer 5M/5M Pro. Built from community-documented API
// (github.com/Parallel-7/flashforge-api-docs). unloadFilament (ms_cmd) is
// now confirmed against real hardware; startPrintFile's materialMappings
// shape (the useMatlStation branch) is still unverified — worth
// double-checking if a multi-material print doesn't map colors correctly.
//
// Same config fields as flashforge-adventurer.js (url incl. :8898, serial,
// verificationCode).
const ff = require("./flashforge-utils");
const http = require("./http-utils");
const fm = require("./flashforge-moonraker");
const mode = require("./flashforge-mode");
const { normHex } = require("../parser");

exports.label = "FlashForge AD5X";
exports.brand = "FlashForge";
// Address contract: same fixed 8898 API as the Adventurer, with the port field
// exposed only because a firmware mod (ZMOD) takes 8898 down and serves
// Moonraker on 7125 instead. Stored URLs stay host-only, so existing configs
// are byte-identical.
// NO defaultPort, deliberately. Each transport applies its own port (see
// forTransport below). A default here is worse than useless: the Settings
// row pre-fills a new printer's port with it, which persisted ":8898" into
// the stored URL and made auto-detection probe 8898 for BOTH transports,
// reporting a healthy modded printer as offline. The port stays editable as
// the advanced override, and is authoritative under a pin.
exports.address = { scheme: "http", defaultPort: null, portEditable: true, required: true };
exports.capabilities = {
  camera: true, cameraSnapshot: true, filamentHeads: true, excludeObject: false, autoLevel: false,
  unloadFilament: true, firmwareInfo: false, inventory: false, discovery: false,
  webUi: false, setColor: true,
  // See snapmaker-u1-klipper.js's capabilities comment: true here because
  // this connector's applyHeadMapping (the useMatlStation branch below)
  // really does send the picked slot mapping to the printer.
  headMapping: true,
  // AD5X's heated bed is spec'd to 110°C.
  maxBedTemp: 110,
  // "filamentHeads" only means "this printer has a per-color slot picker" —
  // it doesn't say whether those slots are genuinely independent physical
  // extruders (Snapmaker U1: each head can only ever hold one color at a
  // time, so two logical colors sharing a head is a real, unprintable
  // conflict) or, like the AD5X's IFS, four filament SLOTS that all feed the
  // SAME single physical nozzle through an automatic changer. Two colors
  // still can't share one IFS slot in a single print (a slot holds exactly
  // one spool), so the no-duplicate-assignment validation is still correct
  // here — this flag exists so the error message can say "slot" instead of
  // "head", since "head" reads as "this one-nozzle printer can't do this at
  // all" to an AD5X owner, which isn't what the error means.
  singleToolhead: true
};

// ---- transport mode ----
// An AD5X runs either stock firmware (native API on 8898) or ZMOD, which takes
// 8898 down and serves Moonraker on 7125. flashforge-mode.js owns the decision;
// this file supplies the two liveness probes and every AD5X-specific meaning.
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

// The four IFS slot sensors, as Klipper object names. Both this prefix and a
// bare `filament_switch_sensor` form appear in objects/list, but ONLY this one
// returns data — querying the intuitive name yields an empty status block and
// silently zero slots (confirmed live).
const IFS_PORT = n => `zmod_ifs_switch_sensor _ifs_port_sensor_${n}`;
const IFS_VARS = "gcode_macro _IFS_VARS";
const IFS_OBJECTS = [IFS_PORT(1), IFS_PORT(2), IFS_PORT(3), IFS_PORT(4), IFS_VARS];

function moonrakerCaps(extra) {
  return {
    ...exports.capabilities,
    camera: false, cameraSnapshot: false,
    excludeObject: true, firmwareInfo: true, health: true, fileSync: true, webUi: true,
    // Hardware gates — each ships off until individually verified.
    setColor: false, unloadFilament: false, autoLevel: false,
    // Gated on the print-start macro (see startPrintFile below). Offering a
    // mapping picker that cannot be acted on is worse than offering nothing.
    headMapping: false,
    filamentHeads: false,
    ...extra
  };
}

// Runs once per detection. IFS presence is read from the printer's live object
// list — never inferred from the model name, the connector type, or the
// presence of Adventurer5M.json (that file exists on 5M Pros too, without any
// FFMInfo block, so it proves nothing about a material station).
async function buildMoonrakerProfile(p) {
  let objects = [];
  try { objects = await fm.listObjects(asMoon(p)); } catch { objects = []; }
  const ifs = objects.includes(IFS_PORT(1));
  let cameraUrl = null;
  try { cameraUrl = await fm.resolveWebcam(asMoon(p)); } catch { cameraUrl = null; }
  return {
    transport: "moonraker", ifs, cameraUrl,
    capabilities: moonrakerCaps({
      ...(cameraUrl ? { camera: true, cameraSnapshot: true } : {}),
      ...(ifs ? { filamentHeads: true } : {})
    })
  };
}

// slot is 1-based, matching both the native API's slotId and ffmColorN.
function decodeMoonrakerHeads(status, ffm) {
  return [1, 2, 3, 4].map(slot => {
    const sensor = status[IFS_PORT(slot)] || {};
    // Presence gates colour, never the reverse: ffmColorN persists after a
    // spool is pulled, so a stored colour is not evidence of filament.
    if (!sensor.filament_detected) return { loaded: false, hex: null, material: null, sub: null, official: false };
    return {
      loaded: true,
      hex: normHex((ffm || {})["ffmColor" + slot]) || null,
      material: (ffm || {})["ffmType" + slot] || null,
      sub: null, official: false
    };
  });
}

async function probeMoonraker(p) {
  const prof = mode.getProfile(p) || await buildMoonrakerProfile(p);
  if (!mode.getProfile(p)) mode.setProfile(p, prof);
  // The IFS terms ride along on the one status query when there is an IFS to
  // read, and are omitted entirely when there isn't — no wasted request.
  const { status, state } = await fm.probeCommon(asMoon(p), prof.ifs ? IFS_OBJECTS : []);
  if (!prof.ifs) return { ...state, heads: [], activeExt: null };
  const cfg = await fm.readConfigJson(asMoon(p), "Adventurer5M.json");
  return {
    ...state,
    heads: decodeMoonrakerHeads(status, cfg && cfg.FFMInfo),
    // _IFS_VARS.current_tool is a TOOL index and tools[] maps tool->slot, so
    // the active slot is tools[current_tool]-1 — NOT current_tool. That mapping
    // is unverified against a real multi-colour print, so this reports null
    // rather than a plausible guess.
    activeExt: null
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
  if (m === "moonraker") {
    try {
      const r = await probeMoonraker(p);
      mode.noteSuccess(p);
      return r;
    } catch (e) {
      mode.noteFailure(p);
      return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
    }
  }
  return probeNative(p);
}
exports.probe = probe;

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

// ---- native path (unchanged behaviour) ----
async function probeNative(p) {
  try {
    const d = await ff.ffDetail(asNative(p));
    mode.noteSuccess(p);
    if (!mode.getProfile(p)) mode.setProfile(p, { transport: "native", capabilities: exports.capabilities });
    const base = ff.decodeCommonStatus(p, d);
    const ms = d.matlStationInfo;
    if (d.hasMatlStation && ms && Array.isArray(ms.slotInfos)) {
      const bySlot = new Map(ms.slotInfos.map(s => [s.slotId, s]));
      base.heads = Array.from({ length: ms.slotCnt || 4 }, (_, i) => {
        const s = bySlot.get(i + 1); // IFS slots are documented as 1-based
        if (!s || !s.hasFilament) return { loaded: false, hex: null, material: null, sub: null, official: false };
        // The printer echoes materialColor back exactly as it was written —
        // its own factory-set slots include the "#", but msConfig_cmd's rgb
        // field is sent WITHOUT one (the documented format), so any slot
        // colored through SnapCon comes back missing it. Left unnormalized,
        // that silently breaks <input type="color"> (resets to black) and
        // any CSS background using it — normalize once here so every
        // consumer downstream can assume a real "#RRGGBB" string.
        return { loaded: true, hex: normHex(s.materialColor), material: s.materialName || null, sub: null, official: false };
      });
      base.activeExt = (typeof ms.currentSlot === "number" && ms.currentSlot > 0) ? ms.currentSlot - 1 : null;
    } else {
      base.heads = [];
    }
    return base;
  } catch (e) {
    mode.noteFailure(p);
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

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
// Ordinary print-control commands get an explicit bound, not moonrakerPost's
// 8s fast-command default. /printer/gcode/script BLOCKS until the script
// finishes, and CANCEL_PRINT runs the printer's whole end-of-print routine --
// park the toolhead, cut heaters, retract -- which routinely runs past 8s. The
// command lands and completes; SnapCon just gave up waiting and reported
// "did not respond within 8000ms" for a cancel that had actually worked.
// Reported live on a U1; measured on a SPARKX i7 where Moonraker accepted
// CANCEL_PRINT at 00:57:05 and Klipper executed it at 00:57:51.
//
// estop is the deliberate exception and stays on the short default: in a real
// emergency the operator needs to know FAST that the command is not landing,
// so they can pull power, rather than have SnapCon wait a minute hoping.
// Same value and same reasoning as creality-klipper.js, kept local to each
// connector rather than hoisted into http-utils -- a shared-utility refactor
// is not something to bundle into a bug fix.
const CONTROL_TIMEOUT_MS = 60 * 1000;
// Only the Moonraker branch changes; the native :8898 calls are a different
// protocol with their own bounds and are untouched.
exports.pause = byMode(ff.pause, p => http.sendGcode(p, "PAUSE", CONTROL_TIMEOUT_MS));
exports.resume = byMode(ff.resume, p => http.sendGcode(p, "RESUME", CONTROL_TIMEOUT_MS));
exports.cancel = byMode(ff.cancel, p => http.sendGcode(p, "CANCEL_PRINT", CONTROL_TIMEOUT_MS));
exports.eject = byMode(ff.eject, p => http.sendGcode(p, "SDCARD_RESET_FILE", CONTROL_TIMEOUT_MS));
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
exports.bedTemp = byMode(ff.bedTemp, (p, t) => http.sendGcode(p, "M140 S" + Math.round(t), CONTROL_TIMEOUT_MS));

// FlashForge's /printGcode bundles material-station mapping directly into
// the same request that starts the print — there's no separate "set
// mapping" call the way Snapmaker's macros allow. SnapCon's interface calls
// applyHeadMapping() then startPrintFile() as two separate steps (server.js's
// /api/print and /api/printfile), so this stashes the mapping here and
// startPrintFile folds it into the one real API call. TTL'd short so an
// upload-without-starting job can never leak into a LATER, unrelated print.
const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingMapping = new Map(); // p.url -> { tools, map, ts }

// Tool/slot values are interpolated into G-code, so they are range-checked as
// integers rather than merely passed through assertSafeGcodeArg — for a value
// that must be an integer, a range check is strictly stronger than a
// character-class check (CLAUDE.md §8, defense in depth at the dangerous sink).
function intInRange(v, lo, hi, what) {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`Invalid ${what}: ${v}`);
  return n;
}

// ZMOD keeps mapping and print-start as two separate calls, which matches
// SnapCon's interface directly — so this path needs no pendingMapping stash and
// carries none of its TTL leak window. _IFS_COLORS_ASSIGN writes state without
// starting motion, so it is safe to ship while print-start stays gated below.
async function applyHeadMappingMoonraker(p, tools, map) {
  for (const t of tools) {
    const tool = intInRange(t, 0, 15, "tool");
    const slot = intInRange(map[t], 0, 3, "slot") + 1; // our indexes are 0-based; IFS ports are 1-based
    await fm.sendMacro(asMoon(p), `_IFS_COLORS_ASSIGN TOOL=${tool} PORT=${slot} DIALOG=0`);
  }
}

async function applyHeadMapping(p, tools, map) {
  // Route on the resolved transport, not on whether a profile happens to be
  // cached: a profile only exists after a successful probe, so keying on it
  // sent an explicitly pinned printer down the wrong branch until its first
  // poll landed. currentMode() honours the pin and detects when nothing is
  // known yet — the same path every other operation on this connector uses.
  if ((await currentMode(p)) === "moonraker") {
    return applyHeadMappingMoonraker(p, tools, map);
  }
  pendingMapping.set(p.url, { tools, map, ts: Date.now() });
}

// HARDWARE GATE — see docs/superpowers/specs/flashforge-dual-transport-design.md §8.
//
// ZMOD overrides SDCARD_PRINT_FILE, and its own _IFS_COLORS_PRINT calls
// BASE_SDCARD_PRINT_FILE instead — which implies the override opens a
// touchscreen confirmation dialog. If it does, an unattended queue start would
// hang waiting for a human, and the only way a runtime "try one, fall back to
// the other" strategy could detect that is by observing a print fail to start:
// a hung job on real hardware, possibly overnight.
//
// So this refuses instead of guessing. It is not a stub to be filled in
// casually — lifting it requires a controlled multi-colour print on real
// AD5X/ZMOD hardware, with the exact macro sent and the observed behaviour
// recorded in docs/superpowers/specs/flashforge-hardware-verification.md.
// getCapabilities reports headMapping:false in this mode for the same reason.
async function startPrintFileMoonraker(p) {
  throw new Error(
    "Starting a print over Moonraker is not yet verified on this firmware. " +
    "The ZMOD print-start macro may require confirmation on the printer's touchscreen, " +
    "which would leave an unattended job waiting. Start this print from the printer or Fluidd."
  );
}

async function startPrintFile(p, filename) {
  // Same reason as applyHeadMapping above. This one matters more: routing on a
  // missing profile meant a printer pinned to Moonraker silently attempted the
  // native :8898 API — which is closed on modded firmware — instead of
  // returning the hardware gate's explanation.
  if ((await currentMode(p)) === "moonraker") {
    return startPrintFileMoonraker(p, filename);
  }
  return startPrintFileNative(p, filename);
}

async function startPrintFileNative(p, filename) {
  const body = { fileName: filename, levelingBeforePrint: false };
  const pending = pendingMapping.get(p.url);
  pendingMapping.delete(p.url);
  if (pending && Date.now() - pending.ts < PENDING_TTL_MS && pending.tools.length) {
    body.useMatlStation = true;
    body.gcodeToolCnt = pending.tools.length;
    // toolId = our logical color index; slotId = the IFS slot (1-based).
    // materialName/toolMaterialColor come from the G-code's own tool data
    // (/gcodeList's gcodeToolDatas — what color THIS FILE expects for each
    // tool); slotMaterialColor comes from /detail (what's ACTUALLY loaded in
    // the target slot right now). Previously sent as blank strings, which the
    // documented example never shows — fetch the real values instead.
    const [gcodeList, detail] = await Promise.all([
      ff.ffPost(asNative(p), "/gcodeList", {}, 8000).catch(() => null),
      ff.ffDetail(asNative(p)).catch(() => null)
    ]);
    const fileDetail = gcodeList && Array.isArray(gcodeList.gcodeListDetail)
      ? gcodeList.gcodeListDetail.find(f => f.gcodeFileName === filename) : null;
    const toolData = (fileDetail && fileDetail.gcodeToolDatas) || [];
    const slotInfos = (detail && detail.matlStationInfo && detail.matlStationInfo.slotInfos) || [];
    body.materialMappings = pending.tools.map(t => {
      const slotId = pending.map[t] + 1;
      const gToolInfo = toolData.find(td => td.toolId === t) || {};
      const slotInfo = slotInfos.find(s => s.slotId === slotId) || {};
      return {
        toolId: t, slotId,
        materialName: gToolInfo.materialName || slotInfo.materialName || "PLA",
        toolMaterialColor: normHex(gToolInfo.materialColor) || "",
        slotMaterialColor: normHex(slotInfo.materialColor) || ""
      };
    });
  }
  // Goes through issuePrintAndConfirm, not a bare ffPost, for the same reason
  // the single-nozzle path does — /printGcode reports Success for commands it
  // silently discards after an upload (see that function's comment). This
  // connector builds a different body but hits the identical endpoint, so it
  // needs the identical confirmation.
  return ff.issuePrintAndConfirm(asNative(p), body);
}
exports.applyHeadMapping = applyHeadMapping;
exports.startPrintFile = startPrintFile;

// action: 0=load, 1=unload, 2=cancel; slot is 1-based (our extruder indexes are 0-based).
async function unloadFilament(p, extruders) {
  for (const e of extruders) {
    await ff.ffControl(asNative(p), "ms_cmd", { action: 1, slot: parseInt(e, 10) + 1 });
  }
}
exports.unloadFilament = unloadFilament;

// The touchscreen only has icons for a fixed palette of colors (github.com/
// Parallel-7/flashforge-api-docs wiki, "AD5X IFS Material Station" — Color
// Support). Sending an arbitrary hex via msConfig_cmd is accepted and reads
// back correctly through SnapCon (which just echoes whatever's stored) — but
// even sending an EXACT, correctly-#-prefixed palette match (confirmed live:
// re-wrote slot 1's already-correct "#F72224" Red through the API, same
// value, same slot) still turned the touchscreen icon black. So this is not
// a formatting/matching problem SnapCon can fix client-side — something
// about msConfig_cmd itself doesn't refresh whatever the touchscreen actually
// renders from, likely a separate internal color-ID the touchscreen's own
// selection UI sets that the API has no documented way to touch.
//
// Rather than pretend arbitrary/snapped colors are reliable, the picker only
// offers this fixed list — at least keeping SnapCon's own display, and the
// API's stored value, consistent and predictable, even though a printer
// reboot may still show black for the reasons above until re-picked on the
// touchscreen itself. Entries marked VERIFIED were read back directly off
// this printer after being set via ITS OWN touchscreen (ground truth, not
// just the docs); the rest are wiki-documented but not independently
// confirmed. The touchscreen has at least a couple of variants not listed
// here yet (a second yellow, a second brown) — add them as they're reported.
const COLOR_PALETTE = [
  { name: "White", hex: "#FFFFFF" },
  { name: "Yellow", hex: "#FEF043" }, // VERIFIED
  { name: "Light Green", hex: "#DCF478" },
  { name: "Green", hex: "#0ACC38" },
  { name: "Dark Green", hex: "#067749" },
  { name: "Teal", hex: "#0C6283" }, // VERIFIED (write succeeds; touchscreen refresh is unreliable — see note above)
  { name: "Cyan", hex: "#0DE2A0" },
  { name: "Light Blue", hex: "#75D9F3" },
  { name: "Blue", hex: "#45A8F9" },
  { name: "Dark Blue", hex: "#2750E0" },
  { name: "Purple", hex: "#46328E" },
  { name: "Violet", hex: "#A03CF7" },
  { name: "Magenta", hex: "#F330F9" },
  { name: "Pink", hex: "#D4B0DC" },
  { name: "Coral", hex: "#F95D73" },
  { name: "Red", hex: "#F72224" }, // VERIFIED
  { name: "Brown (dark)", hex: "#7C4B00" }, // VERIFIED
  { name: "Orange", hex: "#F98D33" },
  { name: "Cream", hex: "#FDEBD5" },
  { name: "Tan", hex: "#D3C4A3" },
  { name: "Dark Brown", hex: "#AF7836" },
  { name: "Gray", hex: "#898989" },
  { name: "Light Gray", hex: "#BCBCBC" },
  { name: "Black", hex: "#161616" }
];
exports.colorPalette = COLOR_PALETTE;
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function nearestPaletteColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = COLOR_PALETTE[0].hex, bestDist = Infinity;
  for (const { hex: c } of COLOR_PALETTE) {
    const [cr, cg, cb] = hexToRgb(c);
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

// Relabels a slot's color (and preserves its current material name — this
// call only changes color, so the existing label is looked up rather than
// guessed/blanked). No physical load/unload happens. Returns the color that
// actually got applied (after palette-snapping) so the caller can tell the
// user if it differs from what they picked.
async function setFilamentColor(p, extruderIndex, hex) {
  const d = await ff.ffDetail(asNative(p));
  const ms = d.matlStationInfo;
  const slot = extruderIndex + 1;
  const current = ms && Array.isArray(ms.slotInfos) ? ms.slotInfos.find(s => s.slotId === slot) : null;
  const mt = (current && current.materialName) || "PLA";
  const snapped = nearestPaletteColor(normHex(hex) || "#FFFFFF");
  await ff.ffControl(asNative(p), "msConfig_cmd", { slot, mt, rgb: snapped.replace(/^#/, "") });
  return snapped;
}
exports.setFilamentColor = setFilamentColor;

exports.listFiles = byMode(ff.listFiles, http.listFiles);
exports.getThumbnail = byMode(ff.getThumbnail, http.getThumbnail);
// Reads /gcodeList's gcodeListDetail for multi-material jobs — real palette
// + print-time data when useMatlStation was used, an empty palette otherwise.
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
// Advertised by moonrakerCaps(), so they must exist — otherwise the UI offers a
// control the backend then refuses as "not supported".
exports.getPlate = moonrakerOnly("Exclude-object", http.getPlate);
exports.excludeObject = moonrakerOnly("Exclude-object", http.excludeObject);
exports.getHealth = moonrakerOnly("Health", http.queryHealth);
exports.getFirmwareInfo = moonrakerOnly("Firmware info", http.queryFirmwareInfo);
exports.querySyncFiles = moonrakerOnly("File sync", http.queryRemoteFileList);
exports.downloadSyncFile = moonrakerOnly("File sync", http.downloadRemoteFile);
exports.deleteSyncFile = moonrakerOnly("File sync", http.deleteRemoteFile);

// No getPlate/excludeObject, getFirmwareInfo, getInventory, discoverAt — see
// flashforge-adventurer.js's matching comment; same gaps apply here.

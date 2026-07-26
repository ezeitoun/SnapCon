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
const { normHex } = require("../parser");

exports.label = "FlashForge AD5X";
exports.capabilities = {
  camera: true, filamentHeads: true, excludeObject: false, autoLevel: false,
  unloadFilament: true, firmwareInfo: false, inventory: false, discovery: false,
  webUi: false, setColor: true,
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

async function probe(p) {
  try {
    const d = await ff.ffDetail(p);
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
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}
exports.probe = probe;

exports.uploadFile = ff.uploadFile;
exports.pause = ff.pause;
exports.resume = ff.resume;
exports.cancel = ff.cancel;
exports.eject = ff.eject;
exports.estop = ff.estop;
exports.bedTemp = ff.bedTemp;

// FlashForge's /printGcode bundles material-station mapping directly into
// the same request that starts the print — there's no separate "set
// mapping" call the way Snapmaker's macros allow. SnapCon's interface calls
// applyHeadMapping() then startPrintFile() as two separate steps (server.js's
// /api/print and /api/printfile), so this stashes the mapping here and
// startPrintFile folds it into the one real API call. TTL'd short so an
// upload-without-starting job can never leak into a LATER, unrelated print.
const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingMapping = new Map(); // p.url -> { tools, map, ts }

async function applyHeadMapping(p, tools, map) {
  pendingMapping.set(p.url, { tools, map, ts: Date.now() });
}

async function startPrintFile(p, filename) {
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
      ff.ffPost(p, "/gcodeList", {}, 8000).catch(() => null),
      ff.ffDetail(p).catch(() => null)
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
  return ff.ffPost(p, "/printGcode", body, 8000);
}
exports.applyHeadMapping = applyHeadMapping;
exports.startPrintFile = startPrintFile;

// action: 0=load, 1=unload, 2=cancel; slot is 1-based (our extruder indexes are 0-based).
async function unloadFilament(p, extruders) {
  for (const e of extruders) {
    await ff.ffControl(p, "ms_cmd", { action: 1, slot: parseInt(e, 10) + 1 });
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
  const d = await ff.ffDetail(p);
  const ms = d.matlStationInfo;
  const slot = extruderIndex + 1;
  const current = ms && Array.isArray(ms.slotInfos) ? ms.slotInfos.find(s => s.slotId === slot) : null;
  const mt = (current && current.materialName) || "PLA";
  const snapped = nearestPaletteColor(normHex(hex) || "#FFFFFF");
  await ff.ffControl(p, "msConfig_cmd", { slot, mt, rgb: snapped.replace(/^#/, "") });
  return snapped;
}
exports.setFilamentColor = setFilamentColor;

exports.listFiles = ff.listFiles;
exports.getThumbnail = ff.getThumbnail;
// Reads /gcodeList's gcodeListDetail for multi-material jobs — real palette
// + print-time data when useMatlStation was used, an empty palette otherwise.
exports.getFileMetadata = ff.getFileMetadata;
exports.getCameraSnapshot = ff.getCameraSnapshot;

// No getPlate/excludeObject, getFirmwareInfo, getInventory, discoverAt — see
// flashforge-adventurer.js's matching comment; same gaps apply here.

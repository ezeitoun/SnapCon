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

exports.label = "FlashForge (Adventurer 5M / 5M Pro)";
exports.capabilities = {
  camera: true, filamentHeads: false, excludeObject: false, autoLevel: false,
  unloadFilament: false, firmwareInfo: false, inventory: false, discovery: false,
  // The 8898 JSON API has no browsable dashboard at all (confirmed live —
  // its root path 404s), unlike Klipper/Moonraker printers which commonly
  // proxy Fluidd/Mainsail or a vendor UI on the same host.
  webUi: false, setColor: false, singleToolhead: true
};

async function probe(p) {
  try {
    const d = await ff.ffDetail(p);
    return { ...ff.decodeCommonStatus(p, d), heads: [] };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}
exports.probe = probe;

exports.uploadFile = ff.uploadFile;
exports.startPrintFile = ff.startPrintFile;
exports.pause = ff.pause;
exports.resume = ff.resume;
exports.cancel = ff.cancel;
exports.eject = ff.eject;
exports.estop = ff.estop;
exports.bedTemp = ff.bedTemp;

exports.listFiles = ff.listFiles;
exports.getThumbnail = ff.getThumbnail;
// Degrades to an empty palette on this printer (confirmed live) — plain
// single-material files have no gcodeListDetail to read from, only AD5X
// multi-material jobs do — but still needs to exist so the client's file
// picker doesn't error out asking for it.
exports.getFileMetadata = ff.getFileMetadata;

exports.getCameraSnapshot = ff.getCameraSnapshot;

// No getPlate/excludeObject (no exclude_object equivalent documented), no
// getFirmwareInfo (no documented endpoint distinct from /detail's
// firmwareVersion field — not worth a whole capability for one string yet),
// no getInventory, no discoverAt (FlashForge's discovery is UDP
// broadcast/multicast with a binary response format, not an HTTP fingerprint
// — doesn't fit the current discoverAt(baseUrl) interface shape; printers
// need to be added manually by IP + serial + checkCode for now).

// connectors/dummy-simulator.js — a testing-only connector that simulates a
// full print lifecycle in memory, with no real hardware and no network I/O.
// Lets Queue Management (dispatch, live progress, completion, pause/resume,
// cancel/e-stop -> attention-required) be exercised by hand without a real
// printer. Selected purely by connector type — any printer name is fine.
//
// State lives in a plain in-memory Map, keyed by printer id — restarting the
// server resets every simulated printer back to blank/idle, same as if it
// had never printed. This is an accepted limitation for a test-only
// connector, not something worth the complexity of persisting.
const fs = require("fs");

const STATE = new Map();

function freshEntry() {
  return { phase: "idle", filename: null, progressAtPause: 0, effectiveStartedAt: 0, durationMs: 90000 };
}
function entryFor(printerId) {
  let e = STATE.get(printerId);
  if (!e) { e = freshEntry(); STATE.set(printerId, e); }
  return e;
}

// Pure: derives {progress, phase} from a plain state snapshot + a timestamp —
// no Map access, no internal Date.now() call — so tests can drive it with
// synthetic "now" values instead of sleeping for real seconds. probe() below
// is the only place this result is ever committed back into STATE.
function computeSimState(entry, nowMs) {
  if (entry.phase === "printing") {
    const progress = Math.min(1, Math.max(0, (nowMs - entry.effectiveStartedAt) / entry.durationMs));
    return { progress, phase: progress >= 1 ? "complete" : "printing" };
  }
  if (entry.phase === "paused") return { progress: entry.progressAtPause, phase: "paused" };
  if (entry.phase === "cancelled") return { progress: entry.progressAtPause, phase: "cancelled" };
  if (entry.phase === "error") return { progress: entry.progressAtPause, phase: "error" };
  if (entry.phase === "complete") return { progress: 1, phase: "complete" };
  return { progress: 0, phase: "idle" };
}

exports.label = "Simulator (testing)";
exports.brand = "Simulator";
exports.capabilities = {
  camera: false, filamentHeads: false, excludeObject: false, autoLevel: false,
  unloadFilament: false, firmwareInfo: false, inventory: false, discovery: false,
  webUi: false, setColor: false, singleToolhead: true, maxBedTemp: 120
};

const PHASE_TO_STATE = { idle: "standby", printing: "printing", paused: "paused", complete: "complete", cancelled: "cancelled", error: "error" };

// Ramp-up window for the synthesized temperature readout — cosmetic only,
// nothing in Queue Management reads bed/hotend values, but a flat "25°C
// while printing" would look broken next to real printers on the same
// dashboard.
const HEAT_RAMP_MS = 15000;

async function probe(p) {
  const entry = entryFor(p.id);
  const now = Date.now();
  const { progress, phase } = computeSimState(entry, now);
  if (phase !== entry.phase) entry.phase = phase; // commits the one transition probe() is allowed to make: crossing 100% -> complete
  const active = phase === "printing" || phase === "paused";
  const heatFrac = active ? Math.min(1, (now - entry.effectiveStartedAt) / HEAT_RAMP_MS) : 0;
  return {
    name: p.name, online: true,
    state: PHASE_TO_STATE[phase] || "unknown",
    message: "", errorCode: phase === "error" ? "SIM_ESTOP" : "",
    filename: entry.filename || "",
    progress,
    elapsed: active ? Math.round((now - entry.effectiveStartedAt) / 1000) : null,
    filamentUsed: null,
    bed: { temp: Math.round(25 + heatFrac * 35), target: active ? 60 : 0 },
    hotend: { temp: Math.round(25 + heatFrac * 185), target: active ? 210 : 0 },
    layer: entry.filename ? { current: Math.round(progress * 100), total: 100 } : null,
    speed: 100, fanPct: phase === "printing" ? 100 : 0, activeExt: 0, plate: null, heads: []
  };
}
exports.probe = probe;

// Records the filename only — matches real Klipper/Moonraker semantics
// (uploading a file doesn't start it; a separate SDCARD_PRINT_FILE-style
// call does). The actual lifecycle reset happens in startPrintFile below.
async function uploadFile(p, fp, name, job) {
  let size = 0;
  try { size = fs.statSync(fp).size; } catch {}
  if (job) { job.total = size; job.sent = size; }
  entryFor(p.id).filename = name;
}
exports.uploadFile = uploadFile;

// The one place a simulated printer's lifecycle is fully reinitialized —
// fresh progress/timer/filename every time, regardless of whatever phase
// (complete/cancelled/error) it was left in by a previous job.
async function startPrintFile(p, filename) {
  const durationSec = Number(p.simDurationSec) > 0 ? Number(p.simDurationSec) : 90;
  STATE.set(p.id, { phase: "printing", filename, progressAtPause: 0, effectiveStartedAt: Date.now(), durationMs: durationSec * 1000 });
}
exports.startPrintFile = startPrintFile;

async function pause(p) {
  const entry = entryFor(p.id);
  if (entry.phase !== "printing") return;
  entry.progressAtPause = computeSimState(entry, Date.now()).progress;
  entry.phase = "paused";
}
exports.pause = pause;

async function resume(p) {
  const entry = entryFor(p.id);
  if (entry.phase !== "paused") return;
  entry.effectiveStartedAt = Date.now() - entry.progressAtPause * entry.durationMs;
  entry.phase = "printing";
}
exports.resume = resume;

async function cancel(p) {
  const entry = entryFor(p.id);
  entry.progressAtPause = computeSimState(entry, Date.now()).progress;
  entry.phase = "cancelled";
}
exports.cancel = cancel;

async function estop(p) {
  const entry = entryFor(p.id);
  entry.progressAtPause = computeSimState(entry, Date.now()).progress;
  entry.phase = "error";
}
exports.estop = estop;

async function eject(p) {
  STATE.set(p.id, freshEntry());
}
exports.eject = eject;

// Bed temperature isn't a real controllable target on simulated hardware —
// accepted and ignored, same "no-op, never throws" contract as every other
// control function here.
async function bedTemp() {}
exports.bedTemp = bedTemp;

// Exported for tests only — the pure math core, plus enough of the stateful
// shell to seed/reset a printer's simulated state deterministically between
// test cases without waiting on the real clock.
exports._internal = { STATE, computeSimState, entryFor, freshEntry };

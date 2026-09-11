// connectors/monitorOnly.js — the one rule for connectors that WATCH a printer
// but never command it.
//
// A connector declares `capabilities.control === false` when SnapCon may read
// its printers' status but must not send them anything that changes what the
// machine does: no upload, no print start, no pause/resume/cancel, no e-stop,
// no heater targets, no queue dispatch. Bambu Lab is the first (see
// connectors/bambulab-h2.js for why it ships read-only).
//
// Tested for === false on purpose, exactly like the estop flag in
// public/app.js: every existing connector controls its printers and simply
// never declares the flag, so a truthiness check would lock the whole rest of
// the fleet.
//
// Pure — no I/O — so both server.js's route guards and the unit tests use the
// same predicate and the same wording.
function isMonitorOnly(capabilities) {
  return !!(capabilities && capabilities.control === false);
}

const MONITOR_ONLY_CODE = "monitor_only";

function monitorOnlyMessage(printerName) {
  const who = printerName ? String(printerName) : "This printer";
  return who + " is connected to SnapCon for monitoring only — SnapCon does not send it commands. " +
    "Control it from the printer's screen, Bambu Studio or Bambu Handy.";
}

// The error every control stub of a monitor-only connector throws, so a code
// path that reaches one anyway (a future route that forgets the guard, the
// compat wizard) fails with this explanation instead of a TypeError about a
// missing function. `status` follows the same convention getThumbnail errors
// already use in server.js (res.status(e.status || 502)).
function monitorOnlyError(printerName) {
  const e = new Error(monitorOnlyMessage(printerName));
  e.code = MONITOR_ONLY_CODE;
  e.status = 409;
  return e;
}

module.exports = { isMonitorOnly, monitorOnlyMessage, monitorOnlyError, MONITOR_ONLY_CODE };

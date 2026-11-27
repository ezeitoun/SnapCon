// test/helpers/uploadOutcomeHelpers.js — loads server.js's upload-outcome
// helpers (docs/TODO.md §37 P1, P2) into a vm context, for the harnesses that run
// /api/print, the queue dispatch or the deferred upload from server.js's own
// source. The context needs CFG (for uploadTimeoutsFromConfig).
const vm = require("node:vm");

function block(src, marker, end) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error("server.js has no " + marker);
  const stop = src.indexOf(end, at);
  return src.slice(at, stop + end.length);
}
function loadUploadOutcomeHelpers(env, serverSrc) {
  vm.runInContext("const SERVER_STARTED_AT = Date.now();", env);
  vm.runInContext(block(serverSrc, "const UPLOAD_TIMEOUT_LIMITS", "\n"), env);
  vm.runInContext(block(serverSrc, "const UPLOAD_TIMEOUT_WARNED", "\n"), env);
  for (const fn of ["function uploadTimeoutsFromConfig(", "function noteUploadFailure(", "function cancelledAfterSending(", "function queueDispatchError("]) {
    vm.runInContext(block(serverSrc, fn, "\n}\n"), env);
  }
  vm.runInContext(block(serverSrc, "const UPLOAD_UNCONFIRMED_WHY", "\n};\n"), env);
  // The read-back after an upload (docs/TODO.md §37 P2).
  vm.runInContext(block(serverSrc, "const START_OK_VERIFICATIONS", "\n"), env);
  // The source-identity re-check after a read-back (§37 A4).
  for (const line of ["const SOURCE_IDENTITY_KEYS", "const sameSource", "const sourceIdentityNow"]) vm.runInContext(block(serverSrc, line, "\n"), env);
  vm.runInContext(block(serverSrc, "const stagedVerification", "\n"), env);
  vm.runInContext(block(serverSrc, "async function verifyOnPrinter(", "\n}\n"), env);
  // The replace-a-file guard (owner, 2026-10-29); a harness's own stub is kept.
  if (typeof env.decideUpload !== "function") vm.runInContext(block(serverSrc, "async function decideUpload(", "\n}\n"), env);
  // The per-printer transfer lock (§37 P3). A harness that has its own
  // otherSendInFlight/queueDispatchJob keeps them; the real ones otherwise.
  if (!("STARTING" in env)) env.STARTING = new Map();
  if (typeof env.otherSendInFlight !== "function") vm.runInContext(block(serverSrc, "function otherSendInFlight(", "\n}\n"), env);
  if (typeof env.queueDispatchJob !== "function") vm.runInContext(block(serverSrc, "function queueDispatchJob(", "\n}\n"), env);
  if (!env.deferredStore) env.deferredStore = { list: () => [], openDuplicate: () => null, status: () => ({}) };
  vm.runInContext(block(serverSrc, "const transferBusy = ", "\n"), env);
  vm.runInContext(block(serverSrc, "function transferBusyRefusal(", "\n}\n"), env);
  // A harness that loads the whole deferred-send section gets this from it.
  if (!env.__deferredSection) {
    vm.runInContext(block(serverSrc, "const deferredEligible = ", "\n"), env);
    vm.runInContext(block(serverSrc, "const deferredWaiting = ", "\n"), env);
    vm.runInContext("this.deferredWaiting = deferredWaiting;", env);
  }
  vm.runInContext("this.transferBusy = transferBusy;", env);
}
module.exports = { loadUploadOutcomeHelpers };

// fleetProbe.js — printer status probing for the fleet: the offline cache,
// stable printer identity (docs/TODO.md §43) and the non-blocking display path
// (docs/TODO.md §48). server.js wires one instance; nothing else uses it.
//
// Two ways to ask for a printer's status:
//
//   fresh(p)    The authoritative path, for every decision and action (sends,
//               uploads, deletes, firmware, queue, idle checks, notifyTick).
//               Exactly the old probeCached() semantics: an OFFLINE result is
//               reused for retryMs (10 s), anything else is a new probe of its
//               own — never shared with another caller, never an older result.
//               A probe that throws throws to the caller, as before.
//
//   display(p)  For GET /api/fleet only (what the cards show). A printer whose
//               last result was OFFLINE is answered at once from that result,
//               and, once retryMs has passed, re-checked in the background —
//               the reply never waits for an unreachable printer. A printer
//               last seen ONLINE, or not seen yet, is always probed and awaited
//               (an online or printing state is never served from memory), with
//               concurrent display requests sharing one probe per printer.
//               When the switch is off (enabled() false) display(p) is fresh(p).
//
// Identity: results are kept per printer id (its persistent config id), not per
// URL, so two printers without a URL can no longer share one entry (§43). A
// result is recorded only if the printer still exists with the same probe-
// relevant configuration (signature) it had when its probe started, and only
// if no probe started later has already been recorded — so a removed,
// re-addressed, rediscovered or re-transported printer, or a slow old probe,
// can never overwrite newer state. A failed probe never moves "last seen".
"use strict";

// Fields that change what a card shows but never how a printer is reached or
// what its probe returns. Everything else (connector, url, ip, port, scheme,
// transport, serial, verificationCode, virtual* …) is part of the signature.
const DISPLAY_ONLY_FIELDS = new Set(["name", "tags", "allowedGroups", "purchaseDate", "pushNotify", "autoLevel", "flowCalibrate",
  "timelapse", "forceDefaults", "filamentMode", "location", "costKwh", "printerPoolId", "maintenanceMode",
  "cameraChecked", "cameraUrl", "cameraWebrtc", "cameraWebrtcChecked"]);

function signatureOf(p) {
  const out = {};
  for (const k of Object.keys(p || {}).sort()) {
    if (DISPLAY_ONLY_FIELDS.has(k)) continue;
    const v = p[k];
    if (typeof v === "function") continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}
// The persistent config id (ensurePrinterIds() gives every printer one). A
// printer without one is identified by its whole signature, never by URL alone.
function keyOf(p) {
  return (p && typeof p.id === "string" && p.id) ? "id:" + p.id : "sig:" + signatureOf(p);
}

function createFleetProbe(opts) {
  const {
    probe,                       // async p => connector status (the real call)
    currentPrinter,              // key => the printer object as configured now, or null
    onOnline = () => {},         // (p, atMs) => record "last seen" — only for real, current, online results
    enabled = () => true,        // the live switch (config fleetFastOffline)
    now = () => Date.now(),
    retryMs = 10 * 1000,         // unchanged OFFLINE_RETRY_MS: no backoff (owner, 2026-11-08)
    displayTimeoutMs = 30 * 1000,// outer bound on a display probe; connectors have their own, shorter ones
    backgroundMax = 4,           // background re-checks running at once, fleet-wide
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = t => clearTimeout(t),
  } = opts;

  const offline = new Map();     // key -> { sig, result, checkedAt, until, startedAt }
  const recordedStart = new Map(); // key -> start time of the newest probe recorded
  const inflight = new Map();    // key -> { sig, promise, background } (display path only)
  let background = 0;
  const counters = { probes: 0, freshProbes: 0, displayProbes: 0, backgroundProbes: 0, joined: 0, servedOffline: 0, skippedBusy: 0, discarded: 0, timeouts: 0, errors: 0 };

  // Store a probe's outcome — only if it is still about the printer as it is
  // configured now, and nothing newer has been stored for it.
  function record(key, sig, p, result, startedAt) {
    const cur = currentPrinter(key);
    if (!cur || signatureOf(cur) !== sig || startedAt < (recordedStart.get(key) || 0)) { counters.discarded++; return false; }
    recordedStart.set(key, startedAt);
    const t = now();
    if (result && result.online) { offline.delete(key); onOnline(cur, t); }
    else offline.set(key, { sig, result, checkedAt: t, until: t + retryMs, startedAt });
    return true;
  }

  // ---- authoritative ----
  async function fresh(p) {
    const key = keyOf(p), sig = signatureOf(p), hit = offline.get(key);
    if (hit && hit.sig === sig && now() < hit.until) return hit.result;
    const startedAt = now(); counters.probes++; counters.freshProbes++;
    const result = await probe(p);          // throws to the caller, as before
    record(key, sig, p, result, startedAt);
    return result;
  }

  // ---- display ----
  function startDisplayProbe(p, key, sig, isBackground) {
    const startedAt = now(); counters.probes++; counters.displayProbes++;
    if (isBackground) { background++; counters.backgroundProbes++; }
    let timer = null;
    let raw;                                // started now, synchronously, with its slot
    try { raw = Promise.resolve(probe(p)); } catch (e) { raw = Promise.reject(e); }
    raw.catch(() => {});                    // a late failure after a timeout is never unhandled
    const timeout = new Promise(resolve => { timer = setTimer(() => resolve(TIMEOUT), displayTimeoutMs); });
    const entry = { sig, background: isBackground, promise: null };
    entry.promise = Promise.race([raw, timeout]).then(
      r => {
        if (r === TIMEOUT) { counters.timeouts++; return { name: p.name, online: false, error: "timeout" }; }   // not recorded: unknown, not offline
        record(key, sig, p, r, startedAt);
        return r;
      },
      e => { counters.errors++; return { name: p.name, online: false, error: (e && e.message) || "probe failed" }; }  // not recorded, as fresh() never records a throw
    ).finally(() => {
      clearTimer(timer);
      if (inflight.get(key) === entry) inflight.delete(key);
      if (isBackground) background--;
    });
    inflight.set(key, entry);
    return entry.promise;
  }

  async function display(p) {
    if (!enabled()) return { result: await fresh(p), cached: false };
    const key = keyOf(p), sig = signatureOf(p);
    const last = offline.get(key);
    if (last && last.sig === sig) {
      // Last known: offline. Answer now; re-check in the background when due.
      if (now() >= last.until) {
        const running = inflight.get(key);
        if (running && running.sig === sig) counters.joined++;
        else if (background >= backgroundMax) counters.skippedBusy++;
        else startDisplayProbe(p, key, sig, true);
      }
      counters.servedOffline++;
      return { result: last.result, cached: true, checkedAt: last.checkedAt };
    }
    // Unknown, or last seen online: a real probe, shared by concurrent requests.
    const running = inflight.get(key);
    if (running && running.sig === sig) { counters.joined++; return { result: await running.promise, cached: false }; }
    return { result: await startDisplayProbe(p, key, sig, false), cached: false };
  }

  // Drop memory for printers that no longer exist (removed from config).
  function prune(liveKeys) {
    for (const k of [...offline.keys()]) if (!liveKeys.has(k)) offline.delete(k);
    for (const k of [...recordedStart.keys()]) if (!liveKeys.has(k)) recordedStart.delete(k);
  }

  return { fresh, display, prune, keyOf, signatureOf,
    stats: () => ({ ...counters, inflight: inflight.size, background, offlineEntries: offline.size }) };
}
const TIMEOUT = Symbol("timeout");

module.exports = { createFleetProbe, signatureOf, keyOf, DISPLAY_ONLY_FIELDS };

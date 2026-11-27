// routes/health.js — GET /api/health and its helpers, moved from server.js
// (docs/refactoring-policy.md; tools/refactor/manifests/health.json).
// No "use strict": server.js runs in sloppy mode and the moved code keeps it.
// server.js requires this module and calls registerHealthRoutes() at the
// route's original position, so start-up order is unchanged. The constants
// and the two Maps (fanMismatchSeen, heaterStableSince) stay at module scope:
// created once when the module is required, kept for the process lifetime,
// not reset by config reloads. The helpers live inside registerHealthRoutes,
// where the injected dependencies are parameters; CFG and PRINTERS
// (reassigned by loadConfig) are read through getConfig() / getPrinters().

// ---- Health diagnostics: single-printer, on-demand only (the Health page
// has no auto-polling — every request here is a real "give me fresh data
// right now", so this is deliberately uncached, same as /api/firmware
// above; no probeCached-style wrapper exists for anything but probe()
// itself). Sectioned response (system/mcus/heaters/storage/history/faults)
// — see connectors/http-utils.js's queryHealth for why each section is
// independently isolated against failure. ----
// Critical disk threshold: <5% free OR <2GB free, whichever triggers first
// — the only threshold defined for Phase 1 (a separate warning-level
// threshold is left for later rather than guessed now).
const DISK_CRITICAL_PCT = 0.05;
const DISK_CRITICAL_BYTES = 2 * 1024 * 1024 * 1024;
// The richer, per-printer half of the two-tier attention design (see
// computeMaintenanceAttention above for the cheap fleet-wide half this
// extends) — only ever computed against a health object that's already
// been fetched for this one printer, never triggered fleet-wide. MCU
// retransmit/invalid-byte counters are deliberately NOT a trigger here:
// they're cumulative-since-boot with no defensible threshold or "recent
// increase" detection built, so surfacing them as attention items would be
// exactly the false-confidence failure mode this design avoids — they stay
// diagnostics-only (still visible in health.mcus) until real trend-based
// alerting exists.
// "Commanded but not spinning" only becomes an attention signal once it's
// been observed on two checks in a row — Health has no continuous polling
// to time a startup-transient delay against, so persistence across separate
// manual checks is the only signal available. First observation just
// records itself and does not flag (covers a normal spin-up transient
// landing on the one check that happens to sample it); only a mismatch
// still present on a LATER check flags. A check that finds the fan fine
// clears the record immediately, so recovery resets the count right away.
const fanMismatchSeen = new Map(); // "printerId|fanName" -> true (mismatched last check)
const FAN_COMMANDED_THRESHOLD = 0.1; // speed above this = "meaningfully commanded on"
const FAN_STOPPED_RPM_THRESHOLD = 50; // rpm below this while commanded = "not spinning"
// Heater duty is only a trustworthy signal once a reading has held near
// target for a little while — a heater ramping up legitimately sits at
// ~100% duty, and a head cooling down from a previous job reports a real
// power number that has nothing to do with health (confirmed live:
// "extruder 118° / 65° target · power 0%" is just a cooling head, not a
// fault). Band and dwell below are starting points, same "unvalidated
// against real degraded hardware" caveat as every other threshold on this
// page: within 3°C of target counts as "at target," and it has to stay
// there for 30 real (wall-clock) seconds before duty is trusted enough to
// color-judge. A wall-clock dwell is the only way to time this at all given
// Health's manual-refresh-only cadence — tracked per printer+heater across
// refreshes in a session-lifetime Map (same pattern as fanMismatchSeen
// below). Any observation that drops back out of band clears the timer, so
// a heater has to re-earn the dwell after every overshoot/undershoot.
// Duty-threshold coloring itself (warn/crit %) stays client-side in app.js,
// matching how MCU/fan thresholds are applied — this function only decides
// which of idle/heating/cooling/settling/stable a reading is in, since only
// that classification needs cross-request memory.
const HEATER_TARGET_BAND_C = 3;
const HEATER_DWELL_MS = 30000;
const heaterStableSince = new Map(); // "printerId|heaterName" -> ms timestamp first seen in-band
// GET /api/health always answers (docs/TODO.md §50). Express 4 does not catch
// a rejected async handler, so a connector that threw used to leave this
// request open forever. Expected states (offline, not supported, stock
// firmware) come back from the connector as the usual 200 { skipped, reason };
// anything that fails is answered 502, and anything that takes longer than
// HEALTH_DEADLINE_MS is answered 504 — both in the same skipped shape the
// Health page already renders, with a reasonCode and a generic reason (the
// error itself goes to the log, once, never to the client). Work still running
// after the deadline is bounded by the connectors' own request timeouts; its
// late result or failure is ignored.
const HEALTH_DEADLINE_MS = 25 * 1000;
const HEALTH_TIMED_OUT = Symbol("health timed out");

function registerHealthRoutes(app, { requireAuth, getConfig, getPrinters, getConnector, printerVisibleTo, probeCached, computeMaintenanceAttention, connHttp }) {
  function checkFanMismatch(p, health) {
    const reasons = [];
    const fans = (health.fans && health.fans.available) ? health.fans.list : [];
    for (const f of fans) {
      const key = p.id + "|" + f.name;
      // rpm===null means no tachometer wired (confirmed real on this fleet) —
      // "not measurable", never treated as "stopped".
      const measurable = typeof f.rpm === "number";
      const commanded = typeof f.speed === "number" && f.speed > FAN_COMMANDED_THRESHOLD;
      const mismatched = measurable && commanded && f.rpm < FAN_STOPPED_RPM_THRESHOLD;
      if (mismatched) {
        if (fanMismatchSeen.get(key)) {
          // code/name/rpm are additive — title/detail stay as the existing
          // English prose for any consumer that isn't the (now code-aware)
          // client renderer; the client translates from code+params instead
          // of parsing this English sentence back apart.
          reasons.push({ severity: "warning", title: "Fan not spinning", detail: `${f.name} is commanded on but reporting ${Math.round(f.rpm)} RPM.`, suggestedComponent: "Fans", code: "fan-not-spinning", name: f.name, rpm: Math.round(f.rpm) });
        } else {
          fanMismatchSeen.set(key, true);
        }
      } else {
        fanMismatchSeen.delete(key);
      }
    }
    return reasons;
  }
  function annotateHeaterStates(p, health) {
    if (!health.heaters || !health.heaters.available) return;
    const now = Date.now();
    for (const h of health.heaters.list) {
      const key = p.id + "|" + h.name;
      if (!h.target) { h.state = "idle"; heaterStableSince.delete(key); continue; }
      const inBand = h.temperature != null && Math.abs(h.temperature - h.target) <= HEATER_TARGET_BAND_C;
      if (!inBand) {
        h.state = (h.temperature != null && h.temperature < h.target) ? "heating" : "cooling";
        heaterStableSince.delete(key);
        continue;
      }
      let since = heaterStableSince.get(key);
      if (!since) { since = now; heaterStableSince.set(key, since); }
      h.state = (now - since >= HEATER_DWELL_MS) ? "stable" : "settling";
    }
  }
  // "Unused" is defined entirely by the G-code sync retention setting — if
  // gcodeSyncRetentionDays isn't configured, there's no threshold to judge by,
  // so this stays undefined and the client simply doesn't show a count rather
  // than inventing a default window. Cross-references the gcodes file listing
  // (already fetched by the storage section) against print history filtered
  // to that same window — confirmed live that history's `filename` field is
  // the exact same string as the file listing's `path`, and that Moonraker's
  // own `since=` filtering keeps this cheap regardless of the printer's full
  // history depth. `fileNames` is deleted from the response afterward — the
  // client only ever needs the final count, not the raw list.
  async function annotateGcodeUnusedCount(p, health) {
    const gcodes = health.storage && health.storage.available && health.storage.categories && health.storage.categories.gcodes;
    if (!gcodes || !getConfig().gcodeSyncRetentionDays || !Array.isArray(gcodes.fileNames)) return;
    try {
      const base = connHttp.baseUrl(p);
      const sinceSec = Date.now() / 1000 - getConfig().gcodeSyncRetentionDays * 86400;
      const recent = await connHttp.queryRecentlyPrintedFiles(base, sinceSec);
      gcodes.unusedCount = gcodes.fileNames.filter(name => !recent.has(name)).length;
      gcodes.unusedThresholdDays = getConfig().gcodeSyncRetentionDays;
    } catch (e) {
      // Best-effort — leave unusedCount undefined, the client just won't show it.
    } finally {
      delete gcodes.fileNames;
    }
  }
  function computeHealthAttention(p, health) {
    const reasons = computeMaintenanceAttention(p);
    if (health.system && health.system.available && health.system.throttledState) {
      // {bits, flags:[...]} is the real Moonraker shape (confirmed via source/
      // docs research — it was never observed non-null live, since this
      // fleet's U1 hardware isn't the Raspberry Pi this check is built for).
      // A non-array flags falls through to the old generic behavior, so an
      // unexpected shape degrades safely rather than silently saying nothing.
      const flags = Array.isArray(health.system.throttledState.flags) ? health.system.throttledState.flags : [];
      if (flags.includes("Under-Voltage Detected")) {
        reasons.push({ severity: "critical", title: "Undervoltage", detail: "The printer's controller is reporting a power under-voltage condition right now.", suggestedComponent: "Power Supply", code: "undervoltage" });
      } else {
        reasons.push({ severity: "critical", title: "Throttled", detail: "The printer's controller is reporting a throttle condition (power or thermal) right now.", code: "throttled" });
      }
    }
    if (health.storage && health.storage.available) {
      const du = health.storage.diskUsage;
      if (du && (du.free < du.total * DISK_CRITICAL_PCT || du.free < DISK_CRITICAL_BYTES)) {
        reasons.push({ severity: "critical", title: "Low disk space", detail: "Uploads can fail confusingly once the disk fills — free up space soon.", code: "low-disk-space" });
      }
    }
    if (health.faults && health.faults.available && health.faults.list.length) {
      reasons.push({ severity: "warning", title: "Recent fault", detail: "The printer has reported at least one recent error — see the fault log.", code: "recent-fault" });
    }
    reasons.push(...checkFanMismatch(p, health));
    return reasons;
  }

  app.get("/api/health", requireAuth, async (req, res) => {
    const idx = parseInt(req.query.printer, 10);
    const p = getPrinters()[idx];
    if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
    const c = getConnector(p.connector);
    if (!c.getHealth) return res.json({ id: p.id, name: p.name, online: true, skipped: true, reason: "not supported" });
    const work = (async () => {
      const st = await probeCached(p);
      const h = await c.getHealth(p, st);
      if (!h.skipped) annotateHeaterStates(p, h);
      if (!h.skipped) await annotateGcodeUnusedCount(p, h);
      return { h, attentionReasons: h.skipped ? [] : computeHealthAttention(p, h) };
    })();
    work.catch(() => {});   // a failure after the deadline is expected and already answered
    let timer = null, done;
    try {
      done = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(HEALTH_TIMED_OUT), HEALTH_DEADLINE_MS); })]);
    } catch (e) {
      console.warn(`[health] ${p.name}: could not read health: ${(e && e.message) || e}`);
      return res.status(502).json({ id: p.id, name: p.name, skipped: true, reason: "Could not read this printer's health.", reasonCode: "connector_error" });
    } finally {
      clearTimeout(timer);
    }
    if (done === HEALTH_TIMED_OUT) {
      console.warn(`[health] ${p.name}: no answer within ${HEALTH_DEADLINE_MS / 1000} s`);
      return res.status(504).json({ id: p.id, name: p.name, skipped: true, reason: "The printer took too long to report its health.", reasonCode: "timeout" });
    }
    const { h: health, attentionReasons } = done;
    res.json({
      id: p.id, name: p.name, ...health,
      ...(attentionReasons.length ? { needsAttention: true, attentionReasons } : {}),
      // Lets the Storage card decide whether Sync logs/Sync camera can be
      // enabled at all, without a separate /api/config round-trip.
      syncFolders: { logs: !!getConfig().logsFolder, camera: !!getConfig().cameraFolder, gcodes: !!getConfig().gcodeSyncFolder },
      syncSupported: !!c.querySyncFiles
    });
  });

  // Returned for test/helpers/healthCode.js, which exercises the helpers
  // directly; server.js ignores the return value.
  return { checkFanMismatch, annotateHeaterStates, annotateGcodeUnusedCount, computeHealthAttention };
}

module.exports = { registerHealthRoutes };

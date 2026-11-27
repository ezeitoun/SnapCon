// routes/firmwareInventory.js — the read-only firmware inventory: the
// /api/firmware GET route and its helpers, moved from server.js
// (docs/refactoring-policy.md; tools/refactor/manifests/firmware-inventory.json).
// No "use strict": server.js runs in sloppy mode and the moved code keeps it.
// server.js requires this module and calls registerFirmwareInventoryRoutes()
// at the route's original position, so start-up order is unchanged. The
// timeout constant stays at module scope, text unchanged; the two helpers and
// the route live inside registerFirmwareInventoryRoutes, where the injected
// dependencies are parameters, and PRINTERS (reassigned by loadConfig) is read
// through getPrinters() at every use. The module owns no mutable state.
// Firmware DEPLOYMENT (the /api/firmware-* routes and their state) is not
// here: it stays in server.js.

// ---- Firmware inventory (same Moonraker APIs fluidd reads) ----
// Full firmware detail is only pulled from printers that aren't moving:
// standby / complete / cancelled. Busy or offline machines are listed as
// skipped with the reason. probeCached already has an up-to-date probe();
// no reason for the connector to probe a second time.

// One unreachable printer must cost one row, not the whole inventory
// (section 6). This is a real ceiling that was learned the hard way: an
// offline FlashForge ran mode detection that never returned AND never
// rejected, and the route's Promise.all meant the Firmware tab never rendered
// at all.
const FW_PROBE_TIMEOUT_MS = 20000;

function registerFirmwareInventoryRoutes(app, { requireAuth, getPrinters, printerVisibleTo, getConnector, getCapabilities, probeCached }) {
  // Which printers the Firmware tab lists at all. firmwareDeploy is the
  // capability meaning "SnapCon can actually flash this machine", which is what
  // the tab exists to do, and it is U1-only today. Gated on the capability
  // rather than a connector name so the brand check stays out of shared code
  // (section 3) and a future flashable connector needs no change here.
  function firmwareTabEligible(p) {
    return getCapabilities(p.connector, p).firmwareDeploy === true;
  }

  // Always resolves to a row. Never throws, never outruns its timeout.
  async function probeFirmware(p, timeoutMs) {
    const ms = typeof timeoutMs === "number" ? timeoutMs : FW_PROBE_TIMEOUT_MS;
    const c = getConnector(p.connector);
    // Gate on the DECLARED capability, not on the method existing. FlashForge
    // exports getFirmwareInfo while declaring firmwareInfo:false in its native
    // mode (deliberate defence in depth on its side) — calling it there runs
    // transport detection against the printer, which is precisely what hung.
    if (!getCapabilities(p.connector, p).firmwareInfo || !c.getFirmwareInfo) {
      return { name: p.name, online: true, skipped: true, reason: "not supported", reasonCode: "not_supported" };
    }

    let st;
    try { st = await probeCached(p); }
    catch (e) { return { name: p.name, online: false, skipped: true, reason: e.message || "offline", reasonCode: "offline", detail: e.message || "" }; }

    // Answered here rather than left to each connector, so an unreachable
    // printer costs no connector call at all. Shape matches what
    // http-utils.queryFirmwareInfo returns for the same case, detail included —
    // the UI renders status_offline_detail from it.
    if (st && st.online === false) {
      return { name: p.name, online: false, skipped: true, reason: st.error || "offline", reasonCode: "offline", detail: st.error || "" };
    }

    let timer;
    try {
      return await Promise.race([
        Promise.resolve(c.getFirmwareInfo(p, st)),
        new Promise(resolve => {
          timer = setTimeout(() => resolve({
            name: p.name, online: true, skipped: true,
            reason: "did not answer within " + Math.round(ms / 1000) + "s",
            reasonCode: "timeout",
          }), ms);
        }),
      ]);
    } catch (e) {
      return { name: p.name, online: true, skipped: true, reason: e.message || "read failed", reasonCode: "error", detail: e.message || "" };
    } finally {
      clearTimeout(timer);
    }
  }

  app.get("/api/firmware", requireAuth, async (req, res) => {
    // ?printer=<index> reads ONE printer, the same shape /api/fleet?printer=i
    // uses. The Firmware tab calls it after a deploy finishes so a single row
    // can be refreshed in place — re-reading the whole fleet would rebuild every
    // row and throw away the selection and the progress bars on screen.
    if (req.query.printer !== undefined) {
      const idx = parseInt(req.query.printer, 10);
      const p = getPrinters()[idx];
      if (!p || !printerVisibleTo(req.user, p)) return res.status(404).json({ error: "Unknown printer" });
      const one = await probeFirmware(p);
      return res.json({
        id: idx,
        // The STABLE identity, additive to the index the rest of the tab is keyed
        // on. Deploy sends this back so a Settings reorder between rendering this
        // list and pressing Deploy cannot retarget the flash — see
        // firmwareTargetFor().
        pid: p.id,
        connector: p.connector,
        uniformMcuVersions: getCapabilities(p.connector, p).uniformMcuVersions === true,
        ...one,
      });
    }
    const visible = getPrinters().map((p, i) => ({ p, i }))
      .filter(({ p }) => printerVisibleTo(req.user, p) && firmwareTabEligible(p));

    let aborted = false;
    req.on("close", () => { aborted = true; });

    // `connector` is the printer's real connector id, not something inferred
    // from its brand or model text — the Firmware tab filters on it, and a
    // brand string is user-editable on generic Klipper.
    //
    // `uniformMcuVersions` travels per row because it decides whether a board
    // reporting a different version is a fault worth flagging or just a
    // separate component. Sent even on skipped rows so the filter still works
    // on a printer whose version could not be read.
    const decorate = (p, i, r) => ({
      id: i,
      pid: p.id,
      connector: p.connector,
      uniformMcuVersions: getCapabilities(p.connector, p).uniformMcuVersions === true,
      ...r,
    });

    // Bounded concurrency: the whole fleet at once is a burst of connections to
    // every printer, and one slow machine no longer delays the rest regardless.
    // Identical work whichever way the answer is delivered.
    const gather = async (onBatch) => {
      const rows = [];
      const B = 6;
      for (let i = 0; i < visible.length && !aborted; i += B) {
        const done = await Promise.all(visible.slice(i, i + B)
          .map(({ p, i: idx }) => probeFirmware(p).then(r => decorate(p, idx, r))));
        done.forEach(r => rows.push(r));
        if (onBatch) onBatch(done, rows.length);
      }
      return rows;
    };

    // NDJSON is OPT-IN. This endpoint answered with a JSON array for its whole
    // life, and public/app.js is served with no cache-busting, so a browser
    // still holding the previous copy after an upgrade calls it expecting that
    // array. Switching the content type in place broke exactly that client with
    // a JSON.parse error on line 2 until a hard reload — reported live. The old
    // shape stays the default; only a client that asks gets the stream.
    if (!req.query.stream) {
      const rows = await gather(null);
      return res.json(rows);
    }

    // Streamed rather than answered once at the end: reading a fleet takes as
    // long as its slowest printer, and a single motionless "Reading firmware…"
    // for that whole time is indistinguishable from the hang this replaced.
    res.set("Content-Type", "application/x-ndjson");
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    const line = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

    line({ total: visible.length, read: 0 });
    const rows = await gather((done, read) => line({ total: visible.length, read, rows: done }));
    if (!aborted) line({ done: true, total: visible.length, rows });
    res.end();
  });
}

module.exports = { registerFirmwareInventoryRoutes };

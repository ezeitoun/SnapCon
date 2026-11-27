// routes/snapshot.js — GET /api/snapshot, its throttle and the cache behind it,
// moved from server.js (docs/refactoring-policy.md;
// tools/refactor/manifests/snapshot.json).
// No "use strict": server.js runs in sloppy mode and the moved code keeps it.
// server.js requires this module and calls registerSnapshotRoutes() at the
// route's original position, so start-up order is unchanged. The two Maps
// (snapshotCache, snapshotInflight) stay at module scope: created once when
// the module is required, kept for the process lifetime, not reset by config
// reloads. The throttle and the route live inside registerSnapshotRoutes,
// where the injected dependencies are parameters; CFG and PRINTERS (reassigned
// by loadConfig) are read through getConfig() / getPrinters(). getSnapshot and
// checkSnapshot stay in server.js (notifications use them too) and arrive here
// as the injected getSnapshot.

// Server-side throttle for the fleet Camera View's automatic polling: that
// grid re-requests every printer's snapshot on every metadata poll tick
// (the fast, user-configured fleet refresh interval — deliberately NOT
// slowed down for this, so temps/progress/status keep updating promptly),
// independent of how often the actual camera frame should change. Without
// this, that would hit real camera hardware (RPC + wait on Snapmaker, a
// fresh MJPEG connection on FlashForge) far more often than intended.
// Cache TTL follows CFG.cameraViewRefreshInterval (Settings tab) — the knob
// the user actually sees controls real request frequency, regardless of how
// often the client happens to ask. ?fresh=1 (the single-printer snapshot
// modal's open/Refresh — an explicit user action) always bypasses this and
// re-primes the cache with the new frame.
const snapshotCache = new Map(); // printer index -> { ts, contentType, buffer }
const snapshotInflight = new Map(); // printer index -> in-flight Promise, so concurrent requests within one TTL window share one real fetch

function registerSnapshotRoutes(app, { requireAuth, getConfig, getPrinters, printerVisibleTo, getSnapshot }) {
  async function getSnapshotThrottled(p, idx) {
    const ttlMs = (getConfig().cameraViewRefreshInterval || 6) * 1000;
    const cached = snapshotCache.get(idx);
    if (cached && Date.now() - cached.ts < ttlMs) return cached;
    if (snapshotInflight.has(idx)) return snapshotInflight.get(idx);
    const pending = (async () => {
      try {
        const { contentType, buffer } = await getSnapshot(p);
        const entry = { ts: Date.now(), contentType, buffer };
        snapshotCache.set(idx, entry);
        return entry;
      } finally {
        snapshotInflight.delete(idx);
      }
    })();
    snapshotInflight.set(idx, pending);
    return pending;
  }

  app.get("/api/snapshot", requireAuth, async (req, res) => {
    const idx = parseInt(req.query.printer, 10);
    const p   = getPrinters()[idx];
    if (!p || !printerVisibleTo(req.user, p)) return res.status(400).json({ error: "Unknown printer" });
    try {
      let contentType, buffer;
      if (req.query.fresh) {
        ({ contentType, buffer } = await getSnapshot(p));
        snapshotCache.set(idx, { ts: Date.now(), contentType, buffer });
      } else {
        ({ contentType, buffer } = await getSnapshotThrottled(p, idx));
      }
      res.set("Content-Type", contentType);
      res.set("Cache-Control", "no-store");
      res.send(buffer);
    } catch (e) {
      res.status(502).json({ error: "No camera frame: " + e.message });
    }
  });
}

module.exports = { registerSnapshotRoutes };

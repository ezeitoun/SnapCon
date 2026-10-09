// library/routes.js — the Library's HTTP routes. Thin: authentication comes
// from server.js's requireAuth, authorisation from Library capabilities
// (library/permissions.js), everything else from LibraryService.
"use strict";

function registerLibraryRoutes(app, { library, requireAuth, actorFromReq }) {
  // Capability check; the Library being unavailable is a 503, not a 403.
  const need = cap => (req, res, next) => {
    if (!library.available) return res.status(503).json({ error: "The Library is unavailable: " + (library.status().reason || "unknown"), code: "library_unavailable" });
    if (!library.can(req.user, cap)) return res.status(403).json({ error: "You don't have permission to do this.", code: "forbidden" });
    next();
  };
  const send = (res, fn) => Promise.resolve().then(fn).then(
    out => res.json(out),
    e => (e && e.status ? res.status(e.status).json({ error: e.message, code: e.code, ...(e.extra || {}) }) : res.status(500).json({ error: e.message, code: "internal" })),
  );

  // Available to anyone signed in, so the UI can say why the Library is off.
  // Recovery details and backup files only for those who manage backups.
  app.get("/api/library/status", requireAuth, (req, res) => {
    const s = library.status();
    const admin = library.available && library.can(req.user, "library.backup");
    res.json(admin ? s : { available: s.available, reason: s.available ? null : s.reason, schemaVersion: s.schemaVersion });
  });

  // A location's folder is only shown to those who manage locations: it can be
  // an internal UNC path.
  app.get("/api/library/roots", requireAuth, need("library.view"), (req, res) => {
    const withPaths = library.can(req.user, "library.sources.manage");
    // lastError too: a network error names the share ("The storage at
    // \\host\share is unreachable"), so it is a path as well.
    res.json({ roots: library.listRoots().map(r => (withPaths ? r : { ...r, path: undefined, lastError: undefined })) });
  });
  app.post("/api/library/roots", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.addRoot(req.body || {}, actorFromReq(req))));
  app.patch("/api/library/roots/:id", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.updateRoot(req.params.id, req.body || {}, actorFromReq(req))));
  app.delete("/api/library/roots/:id", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.removeRoot(req.params.id, actorFromReq(req))));
  // Rescan: Settings (managers) and the Library page (anyone with
  // library.rescan). Only a manager's answer carries the location's folder.
  app.post("/api/library/roots/:id/rescan", requireAuth, need("library.rescan"), (req, res) =>
    send(res, async () => {
      const v = await library.rescan(req.params.id);
      return library.can(req.user, "library.sources.manage") ? v : library.scanState(req.params.id);
    }));
  app.post("/api/library/backup", requireAuth, need("library.backup"), (req, res) =>
    send(res, () => library.backupNow("manual")));
  app.post("/api/library/rebuild", requireAuth, need("library.sources.manage"), (req, res) =>
    send(res, () => library.rebuildDerived()));

  // M2 checkpoint: the raw diagnostic view and the last scans' statistics.
  // Admin only (library.diagnostics): it shows every path in every location.
  app.get("/api/library/diagnostics/raw", requireAuth, need("library.diagnostics"), (req, res) =>
    send(res, () => library.diagnosticsRaw({
      root: req.query.root ? String(req.query.root) : null,
      q: req.query.q ? String(req.query.q) : null,
      limit: Math.max(1, Math.min(20000, parseInt(req.query.limit, 10) || 5000)),
    })));
  // M4: Models, suggestions, protected and ambiguous cases, Review Items.
  // ?export=1: the stable, versioned export (no run timestamps).
  app.get("/api/library/diagnostics/grouping", requireAuth, need("library.diagnostics"), (req, res) => {
    const exportView = req.query.export === "1";
    if (exportView) res.set("Content-Disposition", 'attachment; filename="library-grouping.json"');
    send(res, () => library.diagnosticsGrouping({ exportView }));
  });
  app.get("/api/library/diagnostics/scans", requireAuth, need("library.diagnostics"), (req, res) =>
    send(res, () => library.scanReport()));

  // M5: the Library. Everyone with library.view browses; nothing here edits
  // (M6), and no location's folder path is part of any answer.
  const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
  app.get("/api/library/overview", requireAuth, need("library.view"), (req, res) => send(res, () => library.overview(req.user)));
  app.get("/api/library/facets", requireAuth, need("library.view"), (req, res) => send(res, () => library.facets()));
  // The filters of the grid, shared by the models and their folder counts.
  // `folder` is relative to the location (`location`); `subfolders=0` keeps
  // to the folder's own files, `loose=1` to the location's top files.
  const filtersOf = q => ({
    q: str(q.q), family: str(q.printer, 80), root: str(q.location, 80), type: str(q.type, 20),
    material: str(q.material, 40), attention: q.attention === "1", hidden: q.hidden === "1",
    folder: typeof q.folder === "string" ? q.folder.slice(0, 1024) : null, subfolders: q.subfolders !== "0", loose: q.loose === "1",
  });
  app.get("/api/library/models", requireAuth, need("library.view"), (req, res) =>
    send(res, () => library.browse({
      ...filtersOf(req.query), sort: str(req.query.sort, 10) || "name",
      cursor: str(req.query.cursor, 400) || null, limit: Math.max(1, Math.min(120, parseInt(req.query.limit, 10) || 60)),
    }, req.user)));
  app.get("/api/library/folders", requireAuth, need("library.view"), (req, res) =>
    send(res, () => library.folders(filtersOf(req.query), req.user)));
  app.get("/api/library/models/:uuid", requireAuth, need("library.view"), (req, res) => send(res, () => library.model(req.params.uuid, req.user)));
  app.get("/api/library/attention", requireAuth, need("library.view"), (req, res) => send(res, () => library.attention(req.user)));

  // M6: every change to the Library goes through these two. Each action's own
  // capability (library.edit.grouping / .metadata / .cover, library.hide,
  // library.review) is checked by the service — never by the UI alone.
  app.post("/api/library/actions", requireAuth, need("library.view"), (req, res) =>
    send(res, () => library.act(req.user, actorFromReq(req), req.body && typeof req.body === "object" ? req.body : {})));
  app.post("/api/library/actions/:id/undo", requireAuth, need("library.view"), (req, res) =>
    send(res, () => library.undo(req.user, actorFromReq(req), req.params.id)));

  // Thumbnails are content-addressed, so a key never changes what it names.
  app.get("/api/library/thumbs/:key", requireAuth, need("library.view"), (req, res) => {
    const t = library.thumbFile(req.params.key);
    if (!t) return res.status(404).json({ error: "No such thumbnail", code: "not_found" });
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.type(t.mime).sendFile(t.file, err => { if (err && !res.headersSent) res.status(404).json({ error: "No such thumbnail", code: "not_found" }); });
  });
}

module.exports = { registerLibraryRoutes };

// library/libraryView.js — what the Library UI reads (docs/library-design.md
// §13.2, M5): Model cards with keyset paging, search and facets, the Model
// page, and Needs attention. Read-only, from the index alone: nothing here
// touches a file, so browsing never reads the NAS.
//
// Paths: a file is shown as its location's name plus its path inside that
// location (as /api/files shows the G-code folder to anyone signed in). A
// location's own folder is never part of these answers; the roots route
// shows it only to those who manage locations.
"use strict";
const PrinterIdentity = require("../public/printer-identity");

const labelOf = fam => (fam ? (PrinterIdentity.FAMILIES.find(f => f.key === fam) || {}).label || fam : null);
const json = s => { try { return JSON.parse(s || "null"); } catch { return null; } };
const loc = f => f.root_id + ":" + f.rel_path;
const PAGE_MAX = 120;
const stemOf = n => String(n || "").replace(/(\.gcode)?\.[^.]+$/, "");

// How strongly a Review Item asks for attention. "action": something the
// owner decided no longer applies, or a file is broken; "review": SnapCon is
// unsure and a person should look; "info": recorded so it can be explained,
// not a problem (a folder that disagrees, two copies, a generic name kept
// apart on purpose, an empty Model).
function levelOf(r) {
  switch (r.kind) {
    case "decision_unmatched": case "file_changed": case "unreadable_file": return "action";
    case "suggested_match": case "unknown_printer": case "missing_file": case "source_offline": case "source_may_match": return "review";
    case "ambiguous_grouping": return /^ambiguous:(generic|nested):/.test(r.subject_key) ? "info" : "review";
    // M7: a print whose name fits several Models asks a person; one with a
    // generic name ("Assembly") is only recorded, with the Models it could be.
    case "unlinked_print": return r.confidence === "none" ? "info" : "review";
    default: return "info";   // folder_disagrees, possible_duplicate, empty_model
  }
}
const LEVEL_RANK = { action: 0, review: 1, info: 2 };

// Which Models an open Review Item is about: by uuid, by the content it
// names, by the location it names, or by the files its Evidence lists.
// printerVisible(printerId): an item about a Print on a printer this person
// may not see is not theirs to see at all (§9 D6).
function attentionIndex(db, { printerVisible = () => true } = {}) {
  const reviews = db.prepare(`SELECT r.*, p.printer_id AS print_printer, p.printer_name AS print_printer_name, p.remote_name AS print_file,
      coalesce(p.started_at, p.ended_at) AS print_at
    FROM review_items r LEFT JOIN prints p ON p.id = r.print_id WHERE r.status = 'open' ORDER BY r.priority, r.kind, r.subject_key`).all()
    .filter(r => r.kind !== "unlinked_print" || (r.print_printer != null && printerVisible(r.print_printer)));
  const models = new Map(db.prepare("SELECT id, uuid, name FROM models WHERE merged_into IS NULL").all().map(m => [m.uuid, m]));
  const byKey = new Map(), byLoc = new Map();
  for (const f of db.prepare("SELECT root_id, rel_path, content_key, model_id FROM files WHERE entry_path = '' AND model_id IS NOT NULL").all()) {
    if (!byKey.has(f.content_key)) byKey.set(f.content_key, new Set());
    byKey.get(f.content_key).add(f.model_id);
    byLoc.set(loc(f), f.model_id);
  }
  const perModel = new Map();   // model id -> [review]
  const items = reviews.map(r => {
    const ids = new Set();
    for (const u of [r.model_uuid, r.other_model_uuid]) if (u && models.has(u)) ids.add(models.get(u).id);
    for (const k of [r.content_key, r.other_content_key]) for (const id of byKey.get(k) || []) ids.add(id);
    for (const l of [r.location, r.other_location]) if (l && byLoc.has(l)) ids.add(byLoc.get(l));
    const ev = json(r.evidence_json);
    if (ev && Array.isArray(ev.files)) for (const l of ev.files) if (byLoc.has(l)) ids.add(byLoc.get(l));
    if (r.kind === "unlinked_print" && ev && Array.isArray(ev.candidates)) for (const c of ev.candidates) if (models.has(c.uuid)) ids.add(models.get(c.uuid).id);
    const item = { ...r, level: levelOf(r), evidence: ev, modelIds: [...ids] };
    for (const id of ids) { if (!perModel.has(id)) perModel.set(id, []); perModel.get(id).push(item); }
    return item;
  });
  const idToModel = new Map([...models.values()].map(m => [m.id, m]));
  const ownerOfKey = new Map();
  for (const [k, ids] of byKey) if (ids.size === 1) ownerOfKey.set(k, idToModel.get([...ids][0]));
  return { items, perModel, idToModel, byUuid: models, ownerOfKey };
}

function rootsState(db) {
  return new Map(db.prepare("SELECT id, name, status, enabled, last_scan_at FROM roots").all().map(r => [r.id, { ...r, offline: !r.enabled || r.status === "offline" }]));
}
function availability(f, roots) {
  const r = roots.get(f.root_id);
  if (r && r.offline) return "offline";       // known file; its location is unreachable — never "missing"
  return f.state === "present" ? "ok" : f.state; // missing | unreadable
}

// ---- covers (§10 cover order) ----
// 1 the owner's choice; 2 an image in the Model; 3 a 3MF plate picture or
// thumbnail_3mf; 4 the largest G-code thumbnail; 6 none (the UI's
// placeholder). (5, a render, is Phase 2.)
function coversFor(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const idsJson = JSON.stringify(ids);
  const models = db.prepare("SELECT id, cover_content_key, cover_plate, cover_source FROM models WHERE id IN (SELECT value FROM json_each(?))").all(idsJson);
  const files = db.prepare(`SELECT f.model_id, f.id, f.role, f.entry_path, f.content_key, f.thumb_key, t.w, t.h, t.bytes FROM files f
    JOIN thumbs t ON t.key = f.thumb_key WHERE f.model_id IN (SELECT value FROM json_each(?)) AND f.state != 'missing'`).all(idsJson);
  const plates = db.prepare(`SELECT f.model_id, f.content_key, p.plate_no, p.thumb_key FROM plates p JOIN projects pr ON pr.id = p.project_id JOIN files f ON f.id = pr.file_id
    WHERE f.model_id IN (SELECT value FROM json_each(?)) AND p.thumb_key IS NOT NULL ORDER BY p.plate_no`).all(idsJson);
  const byModel = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.model_id)) m.set(r.model_id, []); m.get(r.model_id).push(r); } return m; };
  const F = byModel(files), P = byModel(plates);
  for (const m of models) {
    const fs_ = F.get(m.id) || [], ps = P.get(m.id) || [];
    let pick = null;
    if (m.cover_source === "user" && m.cover_content_key) {
      const p = m.cover_plate != null && ps.find(x => x.content_key === m.cover_content_key && x.plate_no === m.cover_plate);
      const f = fs_.find(x => x.content_key === m.cover_content_key);
      pick = p ? { thumb: p.thumb_key, source: "chosen" } : f ? { thumb: f.thumb_key, source: "chosen" } : null;
    }
    const image = fs_.filter(f => f.role === "image").sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0];
    if (!pick && image) pick = { thumb: image.thumb_key, source: "image" };
    if (!pick && ps.length) pick = { thumb: ps[0].thumb_key, source: "plate" };
    const proj = fs_.find(f => f.role === "project" && !f.entry_path);
    if (!pick && proj) pick = { thumb: proj.thumb_key, source: "project" };
    const g = fs_.filter(f => f.role === "sliced" && !f.entry_path).sort((a, b) => ((b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0)) || (b.bytes - a.bytes))[0];
    if (!pick && g) pick = { thumb: g.thumb_key, source: "gcode" };
    out.set(m.id, pick);
  }
  return out;
}

// ---- the grid ----

const SORTS = {
  name: { col: "lower(m.name)", dir: "ASC" },
  recent: { col: "m.created_at", dir: "DESC" },
  // Models that need attention (the attention filter's rule) first, then
  // the rest, each in name order. One text key ("0"/"1" + the name), so
  // keyset paging works as for the others; its list of ids is a bound
  // parameter (needsAttention), never text in the SQL.
  attention: { col: "(CASE WHEN m.id IN (SELECT value FROM json_each(?)) THEN '0' ELSE '1' END || lower(m.name))", dir: "ASC", needsIds: true },
};
const needsAttention = att => [...att.perModel.entries()].filter(([, rs]) => rs.some(r => r.level !== "info")).map(([id]) => id);
// A file's type as the card's tags and the Type filter show it (pure): G-code
// ready to print; a 3MF with sliced plates inside (the scan sets its role to
// "sliced" from its content, indexStore.js); a 3MF that needs slicing; a
// source model (STL, STEP…). Anything else — images, documents, archives —
// has none: a zip is never part of a Model (docs/TODO.md §26).
const GCODE_EXTS = ["gcode", "gco", "g", "gx", "bgcode"];
function fileTypeOf(ext, role) {
  ext = String(ext || "").toLowerCase();
  if (ext === "3mf") return role === "sliced" ? "3mf_sliced" : role === "project" ? "3mf" : null;
  if (role === "sliced" && GCODE_EXTS.includes(ext)) return "gcode";
  if (role === "source") return "source";
  return null;
}
const TYPE_ORDER = ["gcode", "3mf_sliced", "3mf", "source"];
// The Type filter: the same types, over a Model's own (not hidden) files.
const ownFile = "SELECT model_id FROM files WHERE entry_path = '' AND hidden = 0";
const TYPES = {
  gcode: `m.id IN (${ownFile} AND role = 'sliced' AND lower(ext) IN (${GCODE_EXTS.map(e => `'${e}'`).join(", ")}))`,
  "3mf_sliced": `m.id IN (${ownFile} AND lower(ext) = '3mf' AND role = 'sliced')`,
  "3mf": `m.id IN (${ownFile} AND lower(ext) = '3mf' AND role = 'project')`,
  source: `m.id IN (${ownFile} AND role = 'source')`,
};
// Words, each a prefix ("skel rex" finds "Skeleton T-Rex"), or joined
// ("t rex" finds "TinyTREX"): see searchTerms.js. FTS5 syntax typed by a
// person is never passed through.
const { ftsQuery } = require("./searchTerms");

// A folder of a location, as the Library page selects it: `folder` is the
// path relative to the location ("" its top), `subfolders` whether the
// folders below it count, and `loose` the top's own files only. Folders are
// read from the files that are present: a deleted folder's files stay in the
// index as missing for 30 days (MISSING_GRACE_MS), but the folder is gone.
// Compared with substr, not LIKE: LIKE ignores ASCII case and treats % and _
// as wildcards, and folder names may differ only in case.
function cleanFolder(folder) {
  if (folder == null) return null;
  return String(folder).split("/").filter(Boolean).join("/");
}
function folderCondition(root, folder, { subfolders = true, loose = false } = {}) {
  if (!root) return null;
  const present = "SELECT model_id FROM files WHERE root_id = ? AND entry_path = '' AND state = 'present'";
  const top = { sql: `m.id IN (${present} AND instr(rel_path, '/') = 0)`, args: [root] };
  if (loose) return top;
  const f = cleanFolder(folder);
  if (f == null) return null;
  if (f === "" && !subfolders) return top;
  if (f === "") return null;   // the whole location: the location filter alone, as before folders existed
  const prefix = f + "/";
  return subfolders
    ? { sql: `m.id IN (${present} AND substr(rel_path, 1, ?) = ?)`, args: [root, prefix.length, prefix] }
    : { sql: `m.id IN (${present} AND substr(rel_path, 1, ?) = ? AND instr(substr(rel_path, ?), '/') = 0)`, args: [root, prefix.length, prefix, prefix.length + 1] };
}

// The conditions every listing shares: the grid and the folder counts use
// the same ones, so a count always matches the grid it leads to.
function modelWhere(db, { q = "", family = "", root = "", type = "", material = "", attention = false, hidden = false, folder = null, subfolders = true, loose = false, printerVisible } = {}, att) {
  // A merged-away Model is never listed (its files are in the survivor); a
  // hidden one only when hidden Models are asked for (M6, recoverable).
  const where = ["m.merged_into IS NULL", hidden ? "m.hidden = 1" : "m.hidden = 0", "EXISTS (SELECT 1 FROM files f WHERE f.model_id = m.id AND f.entry_path = '')"];
  const args = [];
  const fq = ftsQuery(q);
  if (fq) { where.push("m.id IN (SELECT rowid FROM model_fts WHERE model_fts MATCH ?)"); args.push(fq); }
  if (family) { where.push("m.id IN (SELECT model_id FROM model_families WHERE printer_family = ?)"); args.push(family); }
  if (root) { where.push("m.id IN (SELECT model_id FROM files WHERE root_id = ? AND entry_path = '')"); args.push(root); }
  const fc = folderCondition(root, folder, { subfolders, loose });
  if (fc) { where.push(fc.sql); args.push(...fc.args); }
  if (type && TYPES[type]) where.push(TYPES[type]);
  if (material) {
    where.push(`m.id IN (SELECT f.model_id FROM files f JOIN variants v ON v.file_id = f.id, json_each(v.filaments_json) j
      WHERE upper(json_extract(j.value, '$.type')) = upper(?))`);
    args.push(material);
  }
  att = att || attentionIndex(db, { printerVisible });
  if (attention) {
    where.push("m.id IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(needsAttention(att)));
  }
  return { where, args, att };
}

function listModels(db, opts = {}) {
  const { sort = "name", cursor = null, limit = 60, root = "", folder = null, subfolders = true, loose = false } = opts;
  const { where, args, att } = modelWhere(db, opts);
  const s = SORTS[sort] || SORTS.name;
  const total = db.prepare(`SELECT count(*) AS n FROM models m WHERE ${where.join(" AND ")}`).get(...args).n;
  const page = Math.max(1, Math.min(PAGE_MAX, limit | 0 || 60));
  // The sort key's own parameters, bound each time it appears (SELECT, the
  // cursor comparison, ORDER BY), in that order.
  const sa = s.needsIds ? [JSON.stringify(needsAttention(att))] : [];
  const kw = [...where], ka = [...args];
  const cur = decodeCursor(cursor);
  if (cur) { kw.push(`(${s.col}, m.id) ${s.dir === "ASC" ? ">" : "<"} (?, ?)`); ka.push(...sa, cur[0], cur[1]); }
  const rows = db.prepare(`SELECT m.id, m.uuid, m.name, m.designer, m.created_at, ${s.col} AS sortv FROM models m WHERE ${kw.join(" AND ")}
    ORDER BY ${s.col} ${s.dir}, m.id ${s.dir} LIMIT ?`).all(...sa, ...ka, ...sa, page + 1);
  const more = rows.length > page;
  const pageRows = rows.slice(0, page);
  const last = pageRows[pageRows.length - 1];
  const models = cards(db, pageRows, att);
  // Below a selected folder, each card says where under it the Model's files are.
  const f = cleanFolder(folder);
  if (root && f != null && subfolders && !loose) {
    const where_ = folderPaths(db, pageRows.map(r => r.id), root, f);
    models.forEach((m, i) => { m.folder = where_.get(pageRows[i].id) || null; });
  }
  return { total, models, next: more && last ? encodeCursor([last.sortv, last.id]) : null };
}

// Where a Model's files sit below the selected folder: null when one of them
// is directly in it, one path when they share a subfolder, and every path
// when they are spread over several ("2 folders"). Present files only.
function folderPaths(db, ids, root, folder) {
  const out = new Map();
  if (!ids.length) return out;
  const prefix = folder ? folder + "/" : "";
  const dirs = new Map();
  for (const r of db.prepare(`SELECT model_id, rel_path FROM files WHERE root_id = ? AND entry_path = '' AND state = 'present'
      AND model_id IN (SELECT value FROM json_each(?)) AND substr(rel_path, 1, ?) = ?`).all(root, JSON.stringify(ids), prefix.length, prefix)) {
    const rel = r.rel_path.slice(prefix.length);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (!dirs.has(r.model_id)) dirs.set(r.model_id, new Set());
    dirs.get(r.model_id).add(dir);
  }
  for (const [id, set] of dirs) {
    if (set.has("")) continue;
    const paths = [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    out.set(id, paths.length === 1 ? { path: paths[0] } : { paths });
  }
  return out;
}

// The Folders panel (Library page): each location's folders, from its present
// files, with how many Models are in each (and below it) under the active
// filters — `count` — and with none — `total`, so a folder the filters empty
// stays listed, dimmed, instead of the tree jumping. A location's own row
// counts exactly what the grid shows for it; "loose" is its top's own files.
// Sorted by name, case-insensitive. One location, or all of them.
function folderTree(db, opts = {}) {
  const { root = "" } = opts;
  const { where, args, att } = modelWhere(db, { ...opts, root: "", folder: null });
  const matching = new Set(db.prepare(`SELECT m.id FROM models m WHERE ${where.join(" AND ")}`).all(...args).map(r => r.id));
  const base = modelWhere(db, { hidden: opts.hidden }, att);
  const visible = new Set(db.prepare(`SELECT m.id FROM models m WHERE ${base.where.join(" AND ")}`).all(...base.args).map(r => r.id));
  const roots = db.prepare("SELECT id, name, enabled FROM roots ORDER BY name COLLATE NOCASE").all().filter(r => r.enabled && (!root || r.id === root));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const out = [];
  for (const r of roots) {
    // The location's own row: the same condition as the Location filter.
    const inRoot = new Set(db.prepare("SELECT DISTINCT model_id FROM files WHERE root_id = ? AND entry_path = '' AND model_id IS NOT NULL").all(r.id).map(x => x.model_id));
    const nodes = new Map();   // folder path -> { name, path, count:Set, total:Set, children:Set }
    const loose = { count: new Set(), total: new Set() };
    const node = p => {
      if (!nodes.has(p)) nodes.set(p, { name: p.slice(p.lastIndexOf("/") + 1), path: p, count: new Set(), total: new Set(), children: new Set() });
      return nodes.get(p);
    };
    for (const f of db.prepare("SELECT model_id, rel_path FROM files WHERE root_id = ? AND entry_path = '' AND state = 'present' AND model_id IS NOT NULL").all(r.id)) {
      if (!visible.has(f.model_id)) continue;
      const hit = matching.has(f.model_id);
      let dir = f.rel_path.includes("/") ? f.rel_path.slice(0, f.rel_path.lastIndexOf("/")) : "";
      if (dir === "") { loose.total.add(f.model_id); if (hit) loose.count.add(f.model_id); continue; }
      let child = null;
      for (;;) {
        const n = node(dir);
        n.total.add(f.model_id); if (hit) n.count.add(f.model_id);
        if (child) n.children.add(child);
        const up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        if (!up) break;
        child = dir; dir = up;
      }
    }
    const build = p => {
      const n = nodes.get(p);
      return { name: n.name, path: n.path, count: n.count.size, total: n.total.size, children: [...n.children].map(build).sort(byName) };
    };
    const top = [...nodes.keys()].filter(p => !p.includes("/")).map(build).sort(byName);
    let count = 0, total = 0;
    for (const id of inRoot) { if (visible.has(id)) { total++; if (matching.has(id)) count++; } }
    out.push({ id: r.id, name: r.name, count, total, children: top, loose: loose.total.size && top.length ? { count: loose.count.size, total: loose.total.size } : null });
  }
  return { count: matching.size, total: visible.size, roots: out };
}
const encodeCursor = v => Buffer.from(JSON.stringify(v)).toString("base64url");
function decodeCursor(c) {
  if (!c) return null;
  try { const v = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8")); return Array.isArray(v) && v.length === 2 && Number.isInteger(v[1]) ? v : null; } catch { return null; }
}

function cards(db, rows, att) {
  const ids = rows.map(r => r.id);
  if (!ids.length) return [];
  const idsJson = JSON.stringify(ids);
  const roots = rootsState(db);
  const covers = coversFor(db, ids);
  att = att || attentionIndex(db);
  const counts = new Map(db.prepare(`SELECT f.model_id AS id, count(*) AS files,
      sum(f.role = 'sliced') AS sliced, sum(f.role = 'project') AS projects, sum(f.role = 'source') AS sources,
      sum(f.state = 'missing') AS missing, sum(f.state = 'unreadable') AS unreadable, group_concat(DISTINCT f.root_id) AS roots
    FROM files f WHERE f.entry_path = '' AND f.model_id IN (SELECT value FROM json_each(?)) GROUP BY f.model_id`).all(idsJson).map(r => [r.id, r]));
  const printed = new Map(db.prepare("SELECT model_id, print_count, print_count_confirmed, print_count_filename, last_printed_at FROM model_stats WHERE model_id IN (SELECT value FROM json_each(?))")
    .all(idsJson).map(r => [r.model_id, r]));
  // The card's tags: one per type among its own files, in TYPE_ORDER. A
  // source tag shows its file's extension (stl, step…): the largest source
  // file's, as source models have no thumbnail to pick one by.
  const types = new Map();
  for (const f of db.prepare(`SELECT model_id, ext, role, size FROM files WHERE entry_path = '' AND hidden = 0 AND model_id IN (SELECT value FROM json_each(?))
      ORDER BY size DESC, id`).all(idsJson)) {
    const type = fileTypeOf(f.ext, f.role);
    if (!type) continue;
    if (!types.has(f.model_id)) types.set(f.model_id, new Map());
    const t = types.get(f.model_id);
    if (!t.has(type)) t.set(type, type === "source" ? String(f.ext || "").toLowerCase() : type === "gcode" ? "gcode" : "3mf");
  }
  const variants = new Map(db.prepare(`SELECT f.model_id AS id, count(*) AS n FROM variants v JOIN files f ON f.id = v.file_id
    WHERE f.entry_path = '' AND f.model_id IN (SELECT value FROM json_each(?)) GROUP BY f.model_id`).all(idsJson).map(r => [r.id, r.n]));
  const fams = new Map();
  for (const r of db.prepare("SELECT model_id, printer_family, variant_count FROM model_families WHERE model_id IN (SELECT value FROM json_each(?)) ORDER BY variant_count DESC, printer_family").all(idsJson)) {
    if (!fams.has(r.model_id)) fams.set(r.model_id, []);
    fams.get(r.model_id).push({ key: r.printer_family, label: labelOf(r.printer_family), variants: r.variant_count });
  }
  const mats = new Map();
  for (const r of db.prepare(`SELECT DISTINCT f.model_id, upper(json_extract(j.value, '$.type')) AS t FROM files f JOIN variants v ON v.file_id = f.id, json_each(v.filaments_json) j
    WHERE f.model_id IN (SELECT value FROM json_each(?)) AND json_extract(j.value, '$.type') IS NOT NULL ORDER BY t`).all(idsJson)) {
    if (!mats.has(r.model_id)) mats.set(r.model_id, []);
    mats.get(r.model_id).push(r.t);
  }
  return rows.map(r => {
    const c = counts.get(r.id) || {};
    const rootIds = String(c.roots || "").split(",").filter(Boolean);
    const offlineRoots = rootIds.filter(id => roots.get(id) && roots.get(id).offline);
    const items = (att.perModel.get(r.id) || []);
    const worst = items.reduce((w, i) => (w == null || LEVEL_RANK[i.level] < LEVEL_RANK[w] ? i.level : w), null);
    return {
      uuid: r.uuid, name: r.name, designer: r.designer || null,
      cover: covers.get(r.id) || null,
      files: c.files || 0, variants: variants.get(r.id) || 0, projects: c.projects || 0, sources: c.sources || 0,
      families: fams.get(r.id) || [], materials: mats.get(r.id) || [],
      types: TYPE_ORDER.filter(k => types.has(r.id) && types.get(r.id).has(k)).map(k => ({ type: k, ext: types.get(r.id).get(k) })),
      locations: rootIds.map(id => ({ id, name: (roots.get(id) || {}).name || id })),
      offline: offlineRoots.length ? (offlineRoots.length === rootIds.length ? "all" : "some") : null,
      missing: c.missing || 0, unreadable: c.unreadable || 0,
      attention: items.length ? { count: items.filter(i => i.level !== "info").length, info: items.filter(i => i.level === "info").length, level: worst } : null,
      prints: printsOf(printed.get(r.id)),
    };
  });
}

// Print counts (§9 D10): everyone's, whichever printers ran them.
const printsOf = s => (s && s.print_count ? { count: s.print_count, confirmed: s.print_count_confirmed, filename: s.print_count_filename, lastAt: s.last_printed_at } : null);

// Facets for the filters, over the whole visible Library.
function facets(db) {
  const vis = "SELECT m.id FROM models m WHERE m.hidden = 0 AND m.merged_into IS NULL AND EXISTS (SELECT 1 FROM files f WHERE f.model_id = m.id AND f.entry_path = '')";
  const families = db.prepare(`SELECT printer_family AS key, count(DISTINCT model_id) AS n FROM model_families WHERE model_id IN (${vis}) GROUP BY printer_family ORDER BY n DESC, key`).all()
    .map(r => ({ key: r.key, label: labelOf(r.key), count: r.n }));
  const roots = db.prepare(`SELECT r.id, r.name, count(DISTINCT f.model_id) AS n FROM roots r JOIN files f ON f.root_id = r.id AND f.entry_path = '' WHERE f.model_id IN (${vis})
    GROUP BY r.id ORDER BY r.name COLLATE NOCASE`).all().map(r => ({ id: r.id, name: r.name, count: r.n }));
  const types = Object.entries(TYPES).map(([key, cond]) => ({ key, count: db.prepare(`SELECT count(*) AS n FROM models m WHERE m.id IN (${vis}) AND ${cond}`).get().n })).filter(t => t.count > 0);
  const materials = db.prepare(`SELECT upper(json_extract(j.value, '$.type')) AS mat, count(DISTINCT f.model_id) AS n FROM files f JOIN variants v ON v.file_id = f.id, json_each(v.filaments_json) j
    WHERE f.model_id IN (${vis}) AND json_extract(j.value, '$.type') IS NOT NULL GROUP BY mat ORDER BY n DESC, mat`).all().map(r => ({ key: r.mat, count: r.n }));
  const total = db.prepare(`SELECT count(*) AS n FROM (${vis})`).get().n;
  const hidden = db.prepare("SELECT count(*) AS n FROM models m WHERE m.hidden = 1 AND m.merged_into IS NULL AND EXISTS (SELECT 1 FROM files f WHERE f.model_id = m.id AND f.entry_path = '')").get().n;
  return { total, hidden, families, roots, types, materials };
}

// ---- the Model page ----

function printerOf(db, key, v) {
  const claims = db.prepare(`SELECT * FROM claims WHERE subject_type = 'variant' AND subject_key = ? AND relation = 'targets_printer'
    ORDER BY CASE state WHEN 'applied' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, CASE confidence WHEN 'exact' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`).all(key);
  const top = claims[0];
  const ev = top ? (json(top.evidence_json) || []).map(e => ({ signal: e.signal, value: e.value, source: e.source, strength: e.strength, family: e.family || null, familyLabel: labelOf(e.family) })) : [];
  // What the file itself says, kept even when a person chose otherwise (§4.1):
  // "File says X → set to Y" never hides the file's own Evidence.
  const fileSays = top ? { family: top.object_key, label: labelOf(top.object_key), state: top.state, confidence: top.confidence, method: top.method, evidence: ev } : null;
  if (v.printer_decision_id) {
    const d = db.prepare("SELECT id, created_by, created_at FROM decisions WHERE id = ?").get(v.printer_decision_id) || {};
    return { family: v.printer_family, label: labelOf(v.printer_family), state: "decision", confidence: null, evidence: ev, fileSays,
      decision: { id: d.id || null, by: d.created_by || null, at: d.created_at || null } };
  }
  if (!top) return { family: null, label: null, state: "unknown", confidence: null, evidence: [], fileSays: null };
  return { family: top.object_key, label: labelOf(top.object_key), state: top.state, confidence: top.confidence, method: top.method, evidence: ev, fileSays,
    others: claims.slice(1).filter(c => c.object_key !== top.object_key).map(c => ({ family: c.object_key, label: labelOf(c.object_key), state: c.state, confidence: c.confidence })) };
}

function membershipOf(db, f, modelUuid) {
  if (f.model_decision_id) {
    const d = db.prepare("SELECT id, relation, polarity, reason, created_at FROM decisions WHERE id = ?").get(f.model_decision_id);
    return { kind: "decision", decision: d ? { id: d.id, reason: d.reason, at: d.created_at } : null };
  }
  if (f.model_claim_key) {
    const c = db.prepare("SELECT method, confidence, groups, evidence_json FROM claims WHERE claim_key = ?").get(f.model_claim_key);
    if (c) {
      const ev = (json(c.evidence_json) || []).filter(e => e.strength !== "weak")
        .map(e => ({ signal: e.signal, value: e.value, group: e.group, strength: e.strength, with: e.with || null, compare: e.compare ? { a: e.compare.original_a, b: e.compare.original_b, normalized: e.compare.normalized_a } : null }));
      // One line per kind of Evidence, not per partner file.
      const seen = new Set(), uniq = [];
      for (const e of ev) { const k = e.signal + "|" + e.value; if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
      return { kind: "automatic", method: c.method, confidence: c.confidence, groups: String(c.groups || "").split(",").filter(Boolean), evidence: uniq.slice(0, 6) };
    }
  }
  return { kind: "single" };
}

function modelDetail(db, uuid, { printerVisible } = {}) {
  const m = db.prepare("SELECT * FROM models WHERE uuid = ?").get(uuid);
  if (!m) return null;
  // A merged Model answers with where it went, so an old link still lands.
  if (m.merged_into) return { uuid: m.uuid, name: m.name, mergedInto: m.merged_into };
  const roots = rootsState(db);
  const files = db.prepare(`SELECT f.*, ft.original AS title_original FROM files f LEFT JOIN file_titles ft ON ft.file_id = f.id
    WHERE f.model_id = ? ORDER BY f.entry_path != '', f.role, f.root_id, f.rel_path, f.entry_path`).all(m.id);
  const top = files.filter(f => !f.entry_path);
  const att = attentionIndex(db, { printerVisible });
  const where = f => ({ root: f.root_id, rootName: (roots.get(f.root_id) || {}).name || f.root_id, path: f.rel_path, name: f.name });
  const projectByFile = new Map(db.prepare(`SELECT * FROM projects WHERE file_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(top.map(f => f.id))).map(p => [p.file_id, p]));
  const platesByProject = new Map();
  for (const p of db.prepare(`SELECT * FROM plates WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY plate_no`).all(JSON.stringify([...projectByFile.values()].map(p => p.id)))) {
    if (!platesByProject.has(p.project_id)) platesByProject.set(p.project_id, []);
    platesByProject.get(p.project_id).push(p);
  }
  const variantsByFile = new Map();
  for (const v of db.prepare(`SELECT * FROM variants WHERE file_id IN (SELECT value FROM json_each(?)) ORDER BY plate_no`).all(JSON.stringify(top.map(f => f.id)))) {
    if (!variantsByFile.has(v.file_id)) variantsByFile.set(v.file_id, []);
    variantsByFile.get(v.file_id).push(v);
  }
  const fileView = f => ({ id: f.id, contentKey: f.content_key, ...where(f), role: f.role, size: f.size, availability: availability(f, roots), thumb: f.thumb_key || null, hidden: !!f.hidden,
    duplicates: top.filter(o => o.id !== f.id && o.content_key === f.content_key).map(o => where(o)), why: membershipOf(db, f, m.uuid) });

  // Printable Variants: one per plain G-code, one per sliced plate.
  const printables = [];
  for (const f of top) for (const v of f.hidden ? [] : variantsByFile.get(f.id) || []) {
    const key = v.plate_no == null ? f.content_key : f.content_key + "#" + v.plate_no;
    const fil = (json(v.filaments_json) || []).filter(x => x && x.used !== false && !(x.usedG === 0)).map(x => ({ type: x.type || null, color: x.hex || x.color || null, grams: x.g != null ? x.g : x.usedG != null ? x.usedG : null, vendor: x.vendor || null }));
    const pr = projectByFile.get(f.id);
    const plate = pr && v.plate_no != null ? (platesByProject.get(pr.id) || []).find(p => p.plate_no === v.plate_no) : null;
    const avail = availability(f, roots);
    printables.push({
      key, file: fileView(f), plate: v.plate_no, plateName: plate ? plate.name : null, thumb: (plate && plate.thumb_key) || f.thumb_key || null,
      printer: printerOf(db, key, v),
      profile: { printer: v.printer_settings_id || v.printer_model || null, print: v.print_settings_id || null },
      slicer: v.slicer || null, slicerVersion: v.slicer_version || null,
      filaments: fil, estSeconds: v.est_seconds, weightG: v.weight_g, copies: v.copies, colors: v.color_count, layerHeight: v.layer_height, nozzle: v.nozzle,
      // Print/Queue go through the existing Send and Queue dialogs, from any
      // location (§12). Print starts the plate chosen on a printer that can
      // choose one (the server checks); the queue starts plate 1 only.
      send: avail !== "ok" ? { ok: false, reason: avail }
        : { ok: true, root: f.root_id, path: f.rel_path, queue: v.plate_no == null || v.plate_no === 1 },
    });
  }
  const projects = top.filter(f => projectByFile.has(f.id) && !f.hidden).map(f => {
    const p = projectByFile.get(f.id);
    // The printer the project is set up for, from its own settings — what
    // the file says, not a Claim (an unsliced project has no Variant).
    let setUpFor = null;
    if (p.printer_model || p.printer_settings_id) {
      const id = PrinterIdentity.identifyFile({ printerModel: p.printer_model, printerSettingsId: p.printer_settings_id, printerModelId: p.printer_model_id });
      setUpFor = { family: id.family || null, label: id.label || p.printer_model || null, profile: p.printer_settings_id || null };
    }
    return { file: fileView(f), title: p.title, designer: p.designer, license: p.license, flavour: p.flavour, designModelId: p.design_model_id, setUpFor,
      plates: (platesByProject.get(p.id) || []).map(pl => ({ plate: pl.plate_no, name: pl.name, printable: !!pl.sliced, thumb: pl.thumb_key || null,
        objects: ((json(pl.objects_json) || {}).objects || []).slice(0, 12) })) };
  });
  const others = files.filter(f => !variantsByFile.has(f.id) && !projectByFile.has(f.id) && !f.hidden).map(f => ({ ...fileView(f), entry: f.entry_path || null,
    container: f.entry_path ? (top.find(t => t.id === f.container_id) || {}).name || null : null }));

  // Suggestions involving this Model, and why they are only suggestions.
  const suggestions = db.prepare("SELECT * FROM claims WHERE relation = 'same_model_as' AND state = 'suggested' AND (subject_key = ? OR object_key = ?)").all(m.uuid, m.uuid).map(c => {
    const otherUuid = c.subject_key === m.uuid ? c.object_key : c.subject_key;
    const o = db.prepare("SELECT uuid, name FROM models WHERE uuid = ?").get(otherUuid);
    const ev = json(c.evidence_json) || [];
    const missing = (ev.find(e => e.signal === "missing") || {}).value || null;
    const rv = db.prepare("SELECT id FROM review_items WHERE kind = 'suggested_match' AND status = 'open' AND ((model_uuid = ? AND other_model_uuid = ?) OR (model_uuid = ? AND other_model_uuid = ?))").get(m.uuid, otherUuid, otherUuid, m.uuid);
    return { review: rv ? rv.id : null, other: o ? { uuid: o.uuid, name: o.name, ...modelContext(db, o.uuid) } : null, method: c.method, groups: String(c.groups || "").split(",").filter(Boolean),
      evidence: ev.filter(e => e.signal !== "missing").map(e => ({ signal: e.signal, value: e.value, group: e.group, strength: e.strength, between: e.between || null })).slice(0, 6),
      missing };
  });
  const attention = (att.perModel.get(m.id) || []).map(i => reviewView(i, att));
  const families = db.prepare("SELECT printer_family, variant_count FROM model_families WHERE model_id = ? ORDER BY variant_count DESC").all(m.id).map(r => ({ key: r.printer_family, label: labelOf(r.printer_family), variants: r.variant_count }));
  const cover = coversFor(db, [m.id]).get(m.id) || null;
  // Pictures a person may choose as the cover (M6): every image, plate
  // picture and file thumbnail of this Model, by content key (+ plate).
  const pictures = [];
  for (const f of files) if (f.thumb_key && !f.hidden) pictures.push({ contentKey: f.content_key, plate: null, thumb: f.thumb_key, label: f.entry_path ? f.name : stemOf(f.name) });
  for (const p of projects) for (const pl of p.plates) if (pl.thumb) pictures.push({ contentKey: p.file.contentKey, plate: pl.plate, thumb: pl.thumb, label: (p.title || stemOf(p.file.name)) + " · " + pl.plate });
  const chosenMissing = m.cover_source === "user" && !(cover && cover.source === "chosen");
  const gallery = [];
  const seenThumb = new Set();
  const addG = (thumb, label) => { if (thumb && !seenThumb.has(thumb)) { seenThumb.add(thumb); gallery.push({ thumb, label }); } };
  if (cover) addG(cover.thumb, null);
  for (const f of others) if (f.role === "image") addG(f.thumb, f.name);
  for (const p of projects) for (const pl of p.plates) addG(pl.thumb, (p.title || p.file.name) + " · " + pl.plate);
  for (const v of printables) addG(v.thumb, v.file.name);
  return {
    uuid: m.uuid, name: m.name, nameSource: m.name_source, origin: m.origin, hidden: !!m.hidden,
    designer: m.designer, license: m.license, designModelId: m.design_model_id, sourceUrl: m.source_url, notes: m.notes,
    cover, coverSource: m.cover_source, coverMissing: chosenMissing, pictures: pictures.slice(0, 60), gallery: gallery.slice(0, 24), families,
    hiddenFiles: top.filter(f => f.hidden).map(f => fileView(f)),
    counts: { files: top.filter(f => !f.hidden).length, printables: printables.length, projects: projects.length, others: others.length, hidden: top.filter(f => f.hidden).length },
    printables, projects, others, suggestions, attention,
    prints: printsOf(db.prepare("SELECT * FROM model_stats WHERE model_id = ?").get(m.id)),
    locations: [...new Set(top.map(f => f.root_id))].map(id => ({ id, name: (roots.get(id) || {}).name || id, offline: !!(roots.get(id) || {}).offline })),
  };
}

// Enough to tell two same-named Models apart: cover, printers, locations, counts.
function modelContext(db, uuid) {
  const m = db.prepare("SELECT id FROM models WHERE uuid = ?").get(uuid);
  if (!m) return {};
  const c = cards(db, [{ id: m.id, uuid, name: "" }], { perModel: new Map() })[0];
  return { cover: c.cover, files: c.files, families: c.families.map(f => f.label), locations: c.locations.map(l => l.name) };
}

// ---- Needs attention ----

function reviewView(r, att) {
  const model = id => { const m = att.idToModel.get(id); return m ? { uuid: m.uuid, name: m.name } : null; };
  const ev = r.evidence || {};
  // Only what the UI needs to say it plainly; Diagnostics has the rest.
  const detail = {};
  switch (r.kind) {
    case "folder_disagrees": Object.assign(detail, { folder: ev.folder, folderFamilies: (ev.folderFamilies || []).map(labelOf), fileFamily: labelOf(ev.fileFamily) }); break;
    case "unknown_printer": Object.assign(detail, ev && ev.object_key ? { likely: labelOf(ev.object_key), confidence: ev.confidence, state: ev.state } : {}); break;
    case "ambiguous_grouping":
      if (/^ambiguous:generic:/.test(r.subject_key)) Object.assign(detail, { variant: "generic", terms: (ev.terms || []).map(t => String(t).replace(/^title:/, "")), files: (ev.files || []).length, reason: (ev.reason || [])[0] || null });
      else if (/^ambiguous:file:/.test(r.subject_key)) {
        const owner = att.ownerOfKey.get(r.content_key);
        Object.assign(detail, { variant: "file", contentKey: r.content_key, owner: owner ? { uuid: owner.uuid, name: owner.name } : null,
          candidates: (Array.isArray(ev) ? ev : []).map(x => ({ uuid: x.uuid || null, name: x.model })) });
      }
      else if (/^ambiguous:nested:/.test(r.subject_key)) Object.assign(detail, { variant: "nested", folder: ev.folder, subFolders: (ev.subFolders || []).length });
      else Object.assign(detail, { variant: "anchor", model: ev.model, files: (ev.files || []).length });
      break;
    case "suggested_match": {
      const a = att.byUuid.get(r.model_uuid), b = att.byUuid.get(r.other_model_uuid);
      Object.assign(detail, { missing: ev.missing || null, method: (r.summary || "").replace(/^.*\(([^)]*)\)$/, "$1"),
        a: a ? { uuid: a.uuid, name: a.name } : null, b: b ? { uuid: b.uuid, name: b.name } : null });
      break;
    }
    case "possible_duplicate": Object.assign(detail, { basis: ev.basis }); break;
    case "unlinked_print": Object.assign(detail, { file: ev.name || r.print_file, printer: r.print_printer_name || null, at: r.print_at || null, generic: !!ev.generic,
      candidates: (ev.candidates || []).map(c => { const m = att.byUuid.get(c.uuid); return { uuid: c.uuid, name: m ? m.name : c.name, live: !!m }; }) }); break;
    case "decision_unmatched": case "file_changed": Object.assign(detail, { relation: ev.relation, lastSeenAt: ev.lastSeenAt || r.location }); break;
    default: break;
  }
  return { id: r.id, kind: r.kind, level: r.level, subject: r.subject_key, location: r.location, otherLocation: r.other_location, confidence: r.confidence,
    models: r.modelIds.map(model).filter(Boolean).slice(0, 8), modelCount: r.modelIds.length, detail, createdAt: r.created_at, updatedAt: r.updated_at };
}

function attentionList(db, { printerVisible } = {}) {
  const att = attentionIndex(db, { printerVisible });
  const items = att.items.map(i => reviewView(i, att)).sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const counts = { action: 0, review: 0, info: 0 };
  for (const i of items) counts[i.level]++;
  return { counts, items };
}
function attentionCounts(db, { printerVisible = () => true } = {}) {
  const counts = { action: 0, review: 0, info: 0 };
  for (const r of db.prepare("SELECT r.kind, r.subject_key, r.confidence, p.printer_id FROM review_items r LEFT JOIN prints p ON p.id = r.print_id WHERE r.status = 'open'").all()) {
    if (r.kind === "unlinked_print" && !(r.printer_id != null && printerVisible(r.printer_id))) continue;
    counts[levelOf(r)]++;
  }
  return counts;
}

module.exports = { fileTypeOf, listModels, folderTree, folderCondition, cleanFolder, facets, modelDetail, attentionList, attentionCounts, levelOf, ftsQuery, modelContext };

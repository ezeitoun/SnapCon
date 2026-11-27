// library/grouping.js — Models from the index (docs/library-design.md §4.4,
// §4.5, §4.6 rule 4, §6.3, §7, §8). Runs in the Library worker over the
// whole index after scans; deterministic: the same index gives the same
// grouping whatever order files were scanned in.
//
//   nodes      content keys (identical files are one node)
//   candidates blocks on: normalised title, non-generic object-name set,
//              MakerWorld design id, lineage Claims, folders-mode model folder
//   evidence   per pair, by independence group (identity, internal-content,
//              filename, location); conflicts recorded
//   policy     §4.4: exact/identity (where the relation allows) or two
//              independent groups at medium+ → automatic; one group →
//              suggestion; weak/generic → recorded only
//   clusters   union-find over automatic edges in a fixed order, with the
//              owner's Decisions as hard constraints
//   Models     matched to clusters through model_anchors (largest unique
//              overlap, at least half); a new Model otherwise; Models are
//              authored rows and are never deleted
//   Review     the M4 kinds of §8, synchronised by stable subject keys:
//              dismissals and resolutions persist, cleared conditions close
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const PrinterIdentity = require("../public/printer-identity");
const { normalizeTitle, compareTitles, displayTitle, RULE_VERSION: TITLE_RULE_VERSION } = require("./titles");
const { genericObject, commonObjects } = require("./genericNames");
const { nameKey } = require("./folders");
const { searchForms } = require("./searchTerms");
const { refreshStats } = require("./prints");

// 1  §4.4/§7 as written: a folders-mode model folder is structural (auto alone)
// 2  after the first real-library run (§26): a folders-mode folder is medium
//    location Evidence — it corroborates one other independent group, never
//    groups alone (a real folders-mode location was organised by designer,
//    and "one folder = one model" merged different models); "common" object
//    names count UNRELATED title groups (rule 7), so a model's own colourway
//    titles no longer make its part names generic
const RULE_VERSION = 2;
const MODEL_ROLES = new Set(["sliced", "project", "source"]);
const GCODE_OBJECT_ORIGINS = new Set(["exclude_object", "printing_object", "m486"]);
const THREEMF_OBJECT_ORIGINS = new Set(["model_settings", "slice_info"]);
const BLOCK_MAX = 50;   // a candidate block larger than this is "common", not evidence
const RANK = { identity: 4, strong: 3, structural: 3, medium: 2, weak: 1, none: 0 };
const atLeastMedium = s => RANK[s] >= RANK.medium;
const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");
const claimKeyOf = (st, sk, rel, ot, ok) => sha1([st, sk, rel, ot, ok].join("|"));
const loc = f => f.root_id + ":" + f.rel_path;

// ---------------------------------------------------------------- load

function load(db) {
  const roots = new Map(db.prepare("SELECT id, name, grouping, status, enabled, full_hash, last_scan_at FROM roots").all().map(r => [r.id, r]));
  const files = db.prepare(`SELECT f.id, f.root_id, f.rel_path, f.name, f.ext, f.role, f.state, f.content_key, f.sha256, f.quick_fp, f.container_id, f.entry_path, f.size
    FROM files f ORDER BY f.root_id, f.rel_path, f.entry_path`).all();
  const projects = new Map(db.prepare("SELECT file_id, title, designer, license, design_model_id, design_profile_id FROM projects").all().map(p => [p.file_id, p]));
  const objects = new Map();
  for (const o of db.prepare("SELECT file_id, name_norm, raw_name, origin, generic FROM file_objects ORDER BY file_id, origin, name_norm").all()) {
    if (!objects.has(o.file_id)) objects.set(o.file_id, []);
    objects.get(o.file_id).push(o);
  }
  const folders = new Map(db.prepare("SELECT root_id, rel_path, class, evidence_json FROM folder_classes").all().map(f => [f.root_id + ":" + f.rel_path, f]));
  const lineage = db.prepare("SELECT relation, subject_key, object_key, method, confidence, state, evidence_json FROM claims WHERE relation IN ('sliced_from', 'source_of') ORDER BY claim_key").all();
  // Active Decisions: neither replaced by a later one nor withdrawn by an undo.
  const decisions = db.prepare("SELECT * FROM decisions WHERE superseded_by IS NULL AND withdrawn_at IS NULL ORDER BY id").all();
  const anchors = db.prepare("SELECT model_id, content_key FROM model_anchors ORDER BY model_id, content_key").all();
  const models = new Map(db.prepare("SELECT * FROM models ORDER BY id").all().map(m => [m.id, m]));
  const aliases = new Map(db.prepare("SELECT alias, content_key FROM content_aliases").all().map(a => [a.alias, a.content_key]));
  // Locations indexed since the last rebuild (scan_runs is derived): until
  // every enabled one has been, absence proves nothing.
  const indexed = new Set(db.prepare("SELECT DISTINCT root_id FROM scan_runs WHERE outcome = 'ok'").all().map(r => r.root_id));
  return { roots, files, projects, objects, folders, lineage, decisions, anchors, models, aliases, indexed };
}

// ---------------------------------------------------------------- run

function run(db, { now = Date.now(), reportPath = null, uuid = () => crypto.randomUUID() } = {}) {
  const t0 = Date.now();
  const D = load(db);
  const canonical = k => D.aliases.get(k) || k;   // a quick key that became a sha256

  // Designer names for title normalisation: designer-class folder names and
  // the designers 3MF projects name.
  const designers = new Set();
  for (const f of D.folders.values()) if (f.class === "designer") designers.add(f.rel_path.split("/").pop());
  for (const p of D.projects.values()) if (p.designer) designers.add(p.designer);
  const designerList = [...designers].sort();

  // ---- nodes ----
  const nodes = new Map();   // content key -> node
  const fileById = new Map(D.files.map(f => [f.id, f]));
  for (const f of D.files) {
    if (f.entry_path || !MODEL_ROLES.has(f.role)) continue;
    const ck = f.content_key;
    let n = nodes.get(ck);
    if (!n) { n = { key: ck, files: [], titles: [], objects: new Set(), objectRaw: new Map(), genericTerms: new Map(), designModelIds: new Set(), designerFolders: new Set(), modelFolders: new Set() }; nodes.set(ck, n); }
    n.files.push(f);
    const pr = D.projects.get(f.id);
    const title = normalizeTitle(pr && pr.title ? pr.title : f.name, { designers: designerList });
    title.source = pr && pr.title ? "3mf:project Title" : "file name";
    title.file = loc(f);
    n.titles.push(title);
    if (pr && pr.design_model_id) n.designModelIds.add(pr.design_model_id);
    for (const o of D.objects.get(f.id) || []) {
      if (!(GCODE_OBJECT_ORIGINS.has(o.origin) || THREEMF_OBJECT_ORIGINS.has(o.origin))) continue;
      const g = genericObject(o.name_norm);
      if (g) { n.genericTerms.set(g.term, g.reason); continue; }
      n.objects.add(o.name_norm);
      n.objectRaw.set(o.name_norm, o.raw_name);
    }
    // Folders above the file: designer folders (weak location context) and,
    // in a folders-mode location, the model folder.
    const parts = f.rel_path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const fc = D.folders.get(f.root_id + ":" + parts.slice(0, i).join("/"));
      if (fc && fc.class === "designer") n.designerFolders.add(nameKey(parts[i - 1]));
    }
    const root = D.roots.get(f.root_id);
    if (root && root.grouping === "folders" && parts.length > 1) n.modelFolders.add(f.root_id + ":" + parts[0]);
  }
  const keys = [...nodes.keys()].sort();
  for (const k of keys) { const n = nodes.get(k); n.titles.sort((a, b) => (a.file < b.file ? -1 : 1)); n.title = n.titles[0]; n.loc = loc(n.files[0]); }

  // Object names used under several unrelated titles identify nothing (§4.4
  // rule 7): computed from the index, and kept with the titles it saw.
  const usage = new Map();
  for (const n of nodes.values()) for (const o of n.objects) { if (!usage.has(o)) usage.set(o, new Set()); usage.get(o).add(n.title.normalized); }
  const common = commonObjects(usage);
  for (const n of nodes.values()) for (const o of [...n.objects]) if (common.has(o)) { n.objects.delete(o); n.genericTerms.set(o, common.get(o).reason); }
  for (const n of nodes.values()) n.objectKey = [...n.objects].sort().join("|");

  // ---- candidate blocks ----
  const pairs = new Map();   // "a|b" -> { a, b, via: Set }
  const addPair = (a, b, via) => { if (a === b) return; const [x, y] = a < b ? [a, b] : [b, a]; const k = x + "|" + y; if (!pairs.has(k)) pairs.set(k, { a: x, b: y, via: new Set() }); pairs.get(k).via.add(via); };
  const protectedBlocks = [];
  const block = (name, keyOf) => {
    const m = new Map();
    for (const k of keys) { for (const v of keyOf(nodes.get(k))) { if (!v) continue; if (!m.has(v)) m.set(v, []); m.get(v).push(k); } }
    for (const [v, ks] of [...m.entries()].sort()) {
      if (ks.length < 2) continue;
      if (ks.length > BLOCK_MAX) { protectedBlocks.push({ kind: name, value: v, nodes: ks.length, reason: `more than ${BLOCK_MAX} files share it: common, not evidence` }); continue; }
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) addPair(ks[i], ks[j], name);
    }
  };
  block("title", n => [...new Set(n.titles.map(t => t.normalized))]);
  block("objects", n => [n.objectKey]);
  block("design_model_id", n => [...n.designModelIds]);
  block("model_folder", n => [...n.modelFolders]);
  // Lineage Claims between files (M3).
  const lineageEdges = new Map();
  for (const c of D.lineage) {
    const a = canonical(c.subject_key), b = canonical(c.object_key);
    if (!nodes.has(a) || !nodes.has(b)) continue;
    addPair(a, b, "lineage");
    const k = a < b ? a + "|" + b : b + "|" + a;
    if (!lineageEdges.has(k)) lineageEdges.set(k, []);
    lineageEdges.get(k).push(c);
  }

  // Folders mode: which top-level folders are model folders (§7). A folder
  // classified as a designer, format or printer folder is not one; a folder
  // holding further non-format folders with files is nested: ambiguous.
  const modelFolderInfo = new Map();
  for (const n of nodes.values()) for (const mf of n.modelFolders) {
    if (modelFolderInfo.has(mf)) continue;
    const [rootId, top] = [mf.slice(0, mf.indexOf(":")), mf.slice(mf.indexOf(":") + 1)];
    const fc = D.folders.get(mf);
    const subFolders = [...D.folders.values()].filter(f => f.root_id === rootId && f.rel_path.startsWith(top + "/") && f.rel_path.split("/").length === 2 && f.class !== "format");
    const subWithFiles = subFolders.filter(sf => D.files.some(f => f.root_id === rootId && f.rel_path.startsWith(sf.rel_path + "/") && MODEL_ROLES.has(f.role)));
    let status = "model_folder", reason = "a top-level folder in a folders-mode location";
    if (fc && ["designer", "format", "printer_family_like"].includes(fc.class)) { status = "not_model_folder"; reason = `classified ${fc.class}`; }
    else if (subWithFiles.length) { status = "nested"; reason = `holds ${subWithFiles.length} further folder(s) with files: nested model folders are ambiguous`; }
    modelFolderInfo.set(mf, { folder: mf, status, reason, subFolders: subWithFiles.map(s => s.rel_path) });
  }

  // ---- evidence per pair ----
  const edges = [];
  for (const p of [...pairs.values()].sort((x, y) => (x.a + x.b < y.a + y.b ? -1 : 1))) {
    const A = nodes.get(p.a), B = nodes.get(p.b);
    const evidence = [], conflicts = [], ignored = [];
    // identity: MakerWorld design id (allowed alone, §4.4 member_of)
    const sharedDesign = [...A.designModelIds].filter(x => B.designModelIds.has(x));
    if (sharedDesign.length) evidence.push({ signal: "design_model_id", value: sharedDesign[0], source: "3mf:3D/3dmodel.model DesignModelId", group: "identity", strength: "identity", allowsAuto: true });
    else if (A.designModelIds.size && B.designModelIds.size) conflicts.push(`different MakerWorld designs (${[...A.designModelIds][0]} vs ${[...B.designModelIds][0]})`);
    // identity / internal-content: lineage Claims already written by M3
    for (const c of lineageEdges.get(p.a + "|" + p.b) || []) {
      const ev = JSON.parse(c.evidence_json || "[]")[0] || {};
      if (c.relation === "sliced_from" && c.method === "plate_md5") evidence.push({ signal: "plate_md5", value: ev.value, source: ev.source, group: "identity", strength: "identity", allowsAuto: true, excerpt: ev.excerpt });
      else if (c.relation === "source_of" && c.method === "source_file_meta" && c.state === "applied") evidence.push({ signal: "source_file", value: ev.value, source: ev.source, group: "identity", strength: "identity", allowsAuto: true, excerpt: ev.excerpt });
      else if (c.relation === "source_of" && c.method === "source_file_meta") ignored.push({ signal: "source_file", value: ev.value, why: "the referenced name matches several files: ambiguous" });
      // sliced_from by object names and source_of by object name are the same
      // object-name Evidence compared below: never counted twice.
    }
    // internal-content: the non-generic object-name sets
    if (A.objects.size && B.objects.size) {
      const inter = [...A.objects].filter(o => B.objects.has(o));
      if (A.objectKey === B.objectKey) evidence.push({ signal: "object_names", value: [...A.objects].sort().map(o => A.objectRaw.get(o) || o).join(" + ").slice(0, 200), source: "objects (EXCLUDE_OBJECT / printing object / 3MF model settings)", group: "internal-content", strength: "medium" });
      else if (inter.length) evidence.push({ signal: "object_names", value: inter.sort().join(" + ").slice(0, 200), source: "objects", group: "internal-content", strength: "weak", note: "some objects in common, not all" });
      else conflicts.push("their object names differ entirely");
    }
    const genericShared = [...A.genericTerms.keys()].filter(t => B.genericTerms.has(t));
    for (const t of genericShared) ignored.push({ signal: "object_name", value: t, why: "generic: " + A.genericTerms.get(t) });
    // filename: the titles
    const tc = compareTitles(A.title, B.title);
    if (tc.strength !== "none") evidence.push({ signal: "title", value: `${A.title.normalized} = ${B.title.normalized}`, source: A.title.source + " / " + B.title.source, group: "filename", strength: tc.strength, compare: tc.compare });
    else if (tc.compare.note) ignored.push({ signal: "title", value: `${A.title.normalized || "∅"} / ${B.title.normalized || "∅"}`, why: tc.compare.note });
    if (tc.compare.method === "exact" && tc.strength === "weak") ignored.push({ signal: "title", value: A.title.normalized, why: tc.compare.note });
    // location: a shared designer folder (weak: explains, never corroborates)
    const sharedDesigner = [...A.designerFolders].filter(d => B.designerFolders.has(d));
    if (sharedDesigner.length) evidence.push({ signal: "designer_folder", value: sharedDesigner[0], source: "folder classification", group: "location", strength: "weak" });
    // location: the same folders-mode model folder. Medium (rule v2): it
    // corroborates a second independent group, never groups on its own.
    const sharedFolder = [...A.modelFolders].filter(f => B.modelFolders.has(f)).sort()[0];
    if (sharedFolder) {
      const info = modelFolderInfo.get(sharedFolder);
      if (info.status === "model_folder") evidence.push({ signal: "model_folder", value: sharedFolder, source: "folders-mode location", group: "location", strength: "medium",
        note: "rule v2: a folders-mode folder corroborates, it does not group alone" });
      else ignored.push({ signal: "model_folder", value: sharedFolder, why: info.reason });
    }

    // ---- the policy (§4.4) ----
    const strongGroups = [...new Set(evidence.filter(e => atLeastMedium(e.strength) && e.strength !== "structural" && e.strength !== "identity").map(e => e.group))].sort();
    const identity = evidence.filter(e => e.allowsAuto);
    let cls, confidence, method, missing = null;
    if (identity.length && !(conflicts.length && !identity.some(e => e.group === "identity"))) {
      cls = "auto"; method = identity.map(e => e.signal).join("+");
      confidence = identity.some(e => e.signal === "plate_md5") ? "exact" : "high";
    } else if (conflicts.length) {
      cls = "record"; confidence = "low"; method = "conflict"; missing = "conflicting Evidence: " + conflicts.join("; ");
    } else if (strongGroups.length >= 2) {
      cls = "auto"; confidence = "high"; method = evidence.filter(e => atLeastMedium(e.strength)).map(e => e.signal).join("+");
    } else if (strongGroups.length === 1) {
      cls = "suggest"; confidence = "medium"; method = evidence.filter(e => atLeastMedium(e.strength)).map(e => e.signal).join("+");
      const have = strongGroups[0];
      missing = `only one independence group (${have}); automatic grouping needs a second at medium or stronger` +
        (have === "filename" ? " — e.g. the same non-generic object names" : have === "internal-content" ? " — e.g. the same title" : "");
    } else if (evidence.length) {
      cls = "record"; confidence = "low"; method = evidence.map(e => e.signal).join("+"); missing = "weak Evidence only: it explains, it never corroborates";
    } else { cls = "none"; confidence = null; method = null; missing = ignored.length ? "only generic or ignored Evidence" : "no Evidence"; }
    // groups: the independence groups that COUNT (medium or stronger, or
    // identity); weak Evidence stays in the list but is not a group.
    const counted = [...new Set(evidence.filter(e => atLeastMedium(e.strength) || e.allowsAuto).map(e => e.group))].sort();
    edges.push({ a: p.a, b: p.b, cls, confidence, method, groups: counted, evidence, conflicts, ignored, missing, via: [...p.via].sort() });
  }

  // ---- decisions as constraints ----
  const pinned = new Map(), rejected = new Map(), distinct = new Set();
  for (const d of D.decisions) {
    if (d.relation === "member_of" && d.subject_type === "file") {
      const k = canonical(d.subject_key), m = modelIdByUuid(D, d.object_key);
      if (m == null) continue;
      if (d.polarity === "affirm") pinned.set(k, { model: m, decision: d.id });
      else { if (!rejected.has(k)) rejected.set(k, new Map()); rejected.get(k).set(m, d.id); }
    }
    if (d.relation === "distinct_from") {
      const a = modelIdByUuid(D, d.subject_key), b = modelIdByUuid(D, d.object_key);
      if (a != null && b != null) { distinct.add(a + "|" + b); distinct.add(b + "|" + a); }
    }
  }
  const anchorOf = new Map();
  for (const a of D.anchors) { const k = canonical(a.content_key); if (!anchorOf.has(k)) anchorOf.set(k, new Set()); anchorOf.get(k).add(a.model_id); }

  // ---- union-find over automatic edges, in a fixed order ----
  const parent = new Map(keys.map(k => [k, k]));
  const members = new Map(keys.map(k => [k, [k]]));
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const modelsOf = ks => { const s = new Set(); for (const k of ks) { if (pinned.has(k)) s.add(pinned.get(k).model); for (const m of anchorOf.get(k) || []) s.add(m); } return s; };
  const pinsOf = ks => new Set(ks.filter(k => pinned.has(k)).map(k => pinned.get(k).model));
  const blocked = [];
  const order = { exact: 0, high: 1 };
  const autoEdges = edges.filter(e => e.cls === "auto").sort((x, y) => (order[x.confidence] - order[y.confidence]) || (x.a + x.b < y.a + y.b ? -1 : 1));
  for (const e of autoEdges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) continue;
    const A = members.get(ra), B = members.get(rb);
    const pa = pinsOf(A), pb = pinsOf(B);
    let why = null;
    if (pa.size && pb.size && [...pa].some(m => !pb.has(m))) why = "the two sides are confirmed in different Models (member_of Decisions)";
    const ma = modelsOf(A), mb = modelsOf(B);
    if (!why) for (const k of A) for (const m of mb) if (rejected.has(k) && rejected.get(k).has(m)) why = `a file was separated from that Model (member_of reject #${rejected.get(k).get(m)})`;
    if (!why) for (const k of B) for (const m of ma) if (rejected.has(k) && rejected.get(k).has(m)) why = `a file was separated from that Model (member_of reject #${rejected.get(k).get(m)})`;
    if (!why) for (const x of ma) for (const y of mb) if (x !== y && distinct.has(x + "|" + y)) why = "the two Models were kept apart (distinct_from Decision)";
    if (why) { blocked.push({ ...edgeView(e, nodes), blockedBy: why }); continue; }
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    members.set(keep, [...members.get(keep), ...members.get(drop)].sort());
    members.delete(drop);
  }
  let clusters = [...members.entries()].map(([root, ks]) => ({ root, keys: ks.sort() })).sort((x, y) => (x.keys[0] < y.keys[0] ? -1 : 1));

  // ---- clusters → Models (anchors, §4.6 rule 4) ----
  const reviews = [];
  const assignment = new Map();   // cluster index -> model id
  const taken = new Set();
  // Pinned first: a confirmed file takes its cluster to its Model. It JOINS
  // the Model; it does not take it from the files anchored there, so the
  // Model stays available to them below (several clusters, one Model).
  clusters.forEach((c, i) => { const pins = pinsOf(c.keys); if (pins.size === 1) assignment.set(i, [...pins][0]); });
  // Then the largest unique overlap with a Model's last-known members.
  const cand = [];
  clusters.forEach((c, i) => {
    if (assignment.has(i)) return;
    const counts = new Map();
    // A file separated from a Model is no claim on it.
    for (const k of c.keys) for (const m of anchorOf.get(k) || []) if (!(rejected.has(k) && rejected.get(k).has(m))) counts.set(m, (counts.get(m) || 0) + 1);
    // A merged-away Model never takes a cluster again: its files live on in the survivor.
    for (const [m, n] of counts) if (D.models.has(m) && !D.models.get(m).merged_into && n * 2 >= c.keys.length) cand.push({ i, m, n });
  });
  // Largest overlap first, then cluster, then the older Model. (The cluster
  // comparison must return 0 for the same cluster, or the Model tie-break
  // never runs and the order depends on the sort.)
  const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  cand.sort((x, y) => (y.n - x.n) || cmpKey(clusters[x.i].keys[0], clusters[y.i].keys[0]) || x.m - y.m);
  const wanted = new Map();
  for (const c of cand) {
    if (assignment.has(c.i)) continue;
    if (taken.has(c.m)) { if (!wanted.has(c.i)) wanted.set(c.i, c.m); continue; }
    assignment.set(c.i, c.m); taken.add(c.m);
  }
  for (const [i, m] of wanted) if (!assignment.has(i) || assignment.get(i) !== m) {
    reviews.push(review("ambiguous_grouping", "ambiguous:anchor:" + clusters[i].keys[0], { priority: 2, model_uuid: D.models.get(m) && D.models.get(m).uuid, summary: "Two groups of files both look like the same existing Model; one kept it, the other became a new Model",
      evidence: { model: D.models.get(m) && D.models.get(m).name, files: clusters[i].keys.map(k => nodes.get(k).loc) } }));
  }
  // A file separated from the Model its cluster now maps to leaves the cluster.
  const splitOut = [];
  clusters.forEach((c, i) => {
    const m = assignment.get(i);
    if (m == null) return;
    const out = c.keys.filter(k => rejected.has(k) && rejected.get(k).has(m));
    if (out.length) { c.keys = c.keys.filter(k => !out.includes(k)); for (const k of out) splitOut.push({ root: k, keys: [k] }); }
  });
  for (const s of splitOut) {
    clusters.push(s);
    const i = clusters.length - 1;
    const anc = [...(anchorOf.get(s.keys[0]) || [])].filter(m => !taken.has(m) && !(rejected.get(s.keys[0]) || new Map()).has(m)).sort((a, b) => a - b)[0];
    if (anc != null) { assignment.set(i, anc); taken.add(anc); }
  }
  // New Models for everything else.
  const created = [];
  clusters.forEach((c, i) => {
    if (!c.keys.length || assignment.has(i)) return;
    const name = modelName(c.keys.map(k => nodes.get(k)), D);
    const id = Number(db.prepare(`INSERT INTO models (uuid, origin, name, name_source, created_at, updated_at) VALUES (?, 'auto', ?, 'auto', ?, ?)`).run(uuid(), name, now, now).lastInsertRowid);
    D.models.set(id, db.prepare("SELECT * FROM models WHERE id = ?").get(id));
    assignment.set(i, id); created.push(id);
  });

  // ---- writes: claims, files, anchors, model facts ----
  db.prepare("DELETE FROM claims WHERE automatic = 1 AND relation IN ('member_of', 'same_model_as', 'duplicate_of')").run();
  const insClaim = db.prepare(`INSERT OR REPLACE INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence, state, automatic, groups, evidence_json, rule_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);
  const putClaim = c => { const key = claimKeyOf(c.subject_type, c.subject_key, c.relation, c.object_type, c.object_key); insClaim.run(key, c.subject_type, c.subject_key, c.relation, c.object_type, c.object_key, c.method, c.confidence, c.state, c.groups, JSON.stringify(c.evidence.slice(0, 12)), RULE_VERSION, now, now); return key; };
  const modelOfNode = new Map();
  const claimOfNode = new Map();
  const memberClaims = { byMethod: {}, byConfidence: {} };
  clusters.forEach((c, i) => {
    if (!c.keys.length) return;
    const m = assignment.get(i), uuidM = D.models.get(m).uuid;
    for (const k of c.keys) {
      modelOfNode.set(k, m);
      if (c.keys.length < 2) continue;
      // Why this file is in this Model: the automatic edges that tie it to
      // the other members.
      const mine = autoEdges.filter(e => (e.a === k || e.b === k) && c.keys.includes(e.a === k ? e.b : e.a));
      if (!mine.length) continue;
      const best = mine.slice().sort((x, y) => (order[x.confidence] - order[y.confidence]))[0];
      const ev = [];
      for (const e of mine.slice(0, 4)) for (const x of e.evidence) ev.push({ ...x, with: nodes.get(e.a === k ? e.b : e.a).loc });
      const key = putClaim({ subject_type: "file", subject_key: k, relation: "member_of", object_type: "model", object_key: uuidM, method: best.method, confidence: best.confidence, state: "applied",
        groups: [...new Set(mine.flatMap(e => e.groups))].sort().join(","), evidence: ev });
      claimOfNode.set(k, key);
      memberClaims.byMethod[best.method] = (memberClaims.byMethod[best.method] || 0) + 1;
      memberClaims.byConfidence[best.confidence] = (memberClaims.byConfidence[best.confidence] || 0) + 1;
    }
  });
  const setFile = db.prepare("UPDATE files SET model_id = ?, model_claim_key = ?, model_decision_id = ? WHERE id = ?");
  for (const f of D.files) {
    let m = null, ck = null, dec = null;
    const k = f.entry_path ? (fileById.get(f.container_id) || {}).content_key : f.content_key;
    if (k && modelOfNode.has(k) && (f.entry_path || MODEL_ROLES.has(f.role))) { m = modelOfNode.get(k); ck = f.entry_path ? null : claimOfNode.get(k) || null; dec = pinned.has(k) ? pinned.get(k).decision : null; }
    setFile.run(m, ck, dec, f.id);
  }
  // Anchors: an anchor moves only when its content is in the index and now
  // belongs to another Model. Content not in the index (a location still
  // unscanned after a rebuild, offline, or a file gone) keeps its anchor, so
  // a partial index never erases what the Model was.
  const insAnchor = db.prepare("INSERT OR REPLACE INTO model_anchors (model_id, content_key, last_seen) VALUES (?, ?, ?)");
  const delAnchor = db.prepare("DELETE FROM model_anchors WHERE model_id = ? AND content_key = ?");
  for (const a of D.anchors) { const k = canonical(a.content_key); if (modelOfNode.has(k) && modelOfNode.get(k) !== a.model_id) delAnchor.run(a.model_id, a.content_key); }
  const byModel = new Map();
  for (const [k, m] of modelOfNode) { if (!byModel.has(m)) byModel.set(m, []); byModel.get(m).push(k); }
  for (const [m, ks] of byModel) {
    for (const k of ks) insAnchor.run(m, k, now);
    // Automatic facts from the files: the name, and what 3MF projects state.
    const model = D.models.get(m);
    const ns = ks.map(k => nodes.get(k));
    const name = modelName(ns, D);
    const facts = projectFacts(ns, D);
    const sets = [], vals = [];
    if (model.name_source === "auto" && model.name !== name) { sets.push("name = ?"); vals.push(name); }
    for (const [col, v] of Object.entries(facts)) if (v && model[col] == null) { sets.push(col + " = ?"); vals.push(v); }
    if (sets.length) db.prepare(`UPDATE models SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now, m);
  }

  refreshQueryCaches(db);
  // Hidden Files (§4.5): a cache of the active `hidden` Decisions, rebuilt each
  // run so it survives a rebuild of the index.
  db.prepare("UPDATE files SET hidden = 0 WHERE hidden != 0").run();
  for (const d of D.decisions) if (d.relation === "hidden" && d.subject_type === "file" && d.polarity === "affirm") {
    db.prepare("UPDATE files SET hidden = 1 WHERE content_key = ? OR container_id IN (SELECT id FROM files WHERE content_key = ?)").run(canonical(d.subject_key), canonical(d.subject_key));
  }

  // Duplicates: locations with the same content (§4.4 duplicate_of: keyed by
  // location; only records, never hides or merges anything).
  const duplicates = [];
  for (const n of nodes.values()) {
    if (n.files.length < 2) continue;
    const locs = n.files.map(loc).sort();
    for (let i = 0; i < locs.length; i++) for (let j = i + 1; j < locs.length; j++) {
      // Exact only when every copy was verified by its own full hash; a key
      // restored from the identity cache is not yet proof.
      const exact = n.files.every(f => f.sha256 === n.key);
      putClaim({ subject_type: "location", subject_key: locs[i], relation: "duplicate_of", object_type: "location", object_key: locs[j], method: exact ? "sha256" : "quick_fp",
        confidence: exact ? "exact" : "high", state: "applied", groups: "identity",
        evidence: [{ signal: exact ? "sha256" : "quick_fp", value: exact ? n.files[0].sha256 : n.files[0].quick_fp, source: "index", group: "identity", strength: "identity",
          note: exact ? "byte-identical (full hash)" : "same size and head/middle/tail fingerprint; the full hash will confirm" }] });
      duplicates.push({ a: locs[i], b: locs[j], basis: exact ? "sha256" : "quick_fp", contentKey: n.key });
      reviews.push(review("possible_duplicate", `duplicate:${locs[i]}|${locs[j]}`, { content_key: n.key, location: locs[i], other_location: locs[j], confidence: exact ? "exact" : "high", priority: 3,
        summary: `Two copies of the same file: ${locs[i]} and ${locs[j]}`, evidence: { basis: exact ? "sha256" : "quick_fp", value: exact ? n.files[0].sha256 : n.files[0].quick_fp } }));
    }
  }

  // Suggestions between Models: a single medium edge; ties are ambiguity.
  const suggestions = [], ambiguousFiles = [];
  const byNode = new Map();
  for (const e of edges.filter(x => x.cls === "suggest")) {
    const ma = modelOfNode.get(e.a), mb = modelOfNode.get(e.b);
    if (ma == null || mb == null || ma === mb) continue;
    for (const [from, to] of [[e.a, mb], [e.b, ma]]) { if (!byNode.has(from)) byNode.set(from, new Map()); byNode.get(from).set(to, e); }
  }
  const suggested = new Map();
  for (const [k, targets] of [...byNode.entries()].sort()) {
    if (targets.size > 1) {
      ambiguousFiles.push({ file: nodes.get(k).loc, key: k, models: [...targets.keys()].map(m => D.models.get(m).name) });
      reviews.push(review("ambiguous_grouping", "ambiguous:file:" + k, { content_key: k, location: nodes.get(k).loc, priority: 2, confidence: "medium",
        summary: `${nodes.get(k).loc} looks equally like ${targets.size} Models; nothing was suggested`,
        evidence: [...targets.entries()].map(([m, e]) => ({ model: D.models.get(m).name, uuid: D.models.get(m).uuid, method: e.method, evidence: e.evidence })) }));
      continue;
    }
    const [m, e] = [...targets.entries()][0];
    const own = modelOfNode.get(k);
    const [x, y] = [D.models.get(own).uuid, D.models.get(m).uuid].sort();
    if (distinct.has(own + "|" + m)) continue;   // the owner said no: it does not come back
    if (!suggested.has(x + "|" + y)) suggested.set(x + "|" + y, { x, y, e });
  }
  for (const { x, y, e } of [...suggested.values()].sort((p, q) => (p.x + p.y < q.x + q.y ? -1 : 1))) {
    const key = putClaim({ subject_type: "model", subject_key: x, relation: "same_model_as", object_type: "model", object_key: y, method: e.method, confidence: "medium", state: "suggested",
      groups: e.groups.join(","), evidence: [...e.evidence.map(v => ({ ...v, between: [nodes.get(e.a).loc, nodes.get(e.b).loc] })), { signal: "missing", value: e.missing, group: "-", strength: "none" }] });
    const mx = [...D.models.values()].find(m => m.uuid === x), my = [...D.models.values()].find(m => m.uuid === y);
    suggestions.push({ claimKey: key, a: { uuid: x, name: mx.name }, b: { uuid: y, name: my.name }, files: [nodes.get(e.a).loc, nodes.get(e.b).loc], method: e.method, groups: e.groups, evidence: e.evidence, missing: e.missing, ignored: e.ignored });
    reviews.push(review("suggested_match", `suggested_match:${x}|${y}`, { claim_key: key, model_uuid: x, other_model_uuid: y, confidence: "medium", priority: 2,
      summary: `${mx.name} and ${my.name} may be the same model (${e.method})`, evidence: { evidence: e.evidence, missing: e.missing } }));
  }

  // Protected cases: names shared by files that were deliberately not merged.
  const protectedClusters = [];
  const termNodes = new Map();
  for (const n of nodes.values()) for (const [t, why] of n.genericTerms) { if (!termNodes.has(t)) termNodes.set(t, { why, keys: [] }); termNodes.get(t).keys.push(n.key); }
  for (const n of nodes.values()) if (n.title.genericScore >= 0.5 && n.title.normalized) { const t = "title:" + n.title.normalized; if (!termNodes.has(t)) termNodes.set(t, { why: "generic title: " + n.title.generic.map(g => g.term + " (" + g.reason + ")").join(", "), keys: [] }); termNodes.get(t).keys.push(n.key); }
  // Terms shared by exactly the same files are one case (27 numbered parts of
  // one model are one protected case, not 27).
  const bySet = new Map();
  for (const [t, { why, keys: ks }] of [...termNodes.entries()].sort()) {
    const sorted = [...new Set(ks)].sort();
    const models = new Set(sorted.map(k => modelOfNode.get(k)));
    if (sorted.length < 2 || models.size < 2) continue;
    const setKey = sorted.join(",");
    if (!bySet.has(setKey)) bySet.set(setKey, { terms: [], reasons: [], keys: sorted, models: models.size });
    bySet.get(setKey).terms.push(t); bySet.get(setKey).reasons.push(why);
  }
  for (const c of [...bySet.values()].sort((a, b) => (a.terms[0] < b.terms[0] ? -1 : 1))) {
    const label = c.terms.length > 1 ? `${c.terms[0]} (+${c.terms.length - 1} more)` : c.terms[0];
    protectedClusters.push({ term: label, terms: c.terms, reason: [...new Set(c.reasons)].join("; "), files: c.keys.map(k => nodes.get(k).loc), models: c.models });
    reviews.push(review("ambiguous_grouping", "ambiguous:generic:" + c.terms[0], { priority: 3, confidence: "low",
      summary: `${c.keys.length} files share the generic name "${label.replace(/^title:/, "")}" and were not merged on it`,
      evidence: { terms: c.terms, reason: [...new Set(c.reasons)], files: c.keys.map(k => nodes.get(k).loc) } }));
  }
  for (const info of [...modelFolderInfo.values()].filter(i => i.status === "nested").sort((a, b) => (a.folder < b.folder ? -1 : 1))) {
    reviews.push(review("ambiguous_grouping", "ambiguous:nested:" + info.folder, { location: info.folder, priority: 2, confidence: "low", summary: `${info.folder}: ${info.reason}`, evidence: info }));
  }

  // Source references that resolve to nothing in the index (weak; M3).
  const resolvedSources = new Set(D.lineage.filter(c => c.relation === "source_of").map(c => canonical(c.object_key)));
  const unresolvedSources = [];
  for (const f of D.files) for (const o of D.objects.get(f.id) || []) {
    if (o.origin !== "source_file") continue;
    if (!resolvedSources.has(f.content_key)) unresolvedSources.push({ file: loc(f), reference: o.raw_name, note: "names no indexed file: weak, path text only" });
  }
  for (const c of D.lineage.filter(c => c.relation === "source_of" && c.state === "suggested")) {
    const s = canonical(c.subject_key), o = canonical(c.object_key);
    reviews.push(review("source_may_match", `source:${s}|${o}`, { content_key: s, other_content_key: o, confidence: c.confidence, priority: 3,
      summary: `${(nodes.get(s) || {}).loc || s} may be the source of ${(nodes.get(o) || {}).loc || o} (${c.method})`, evidence: JSON.parse(c.evidence_json || "[]") }));
  }

  // Printers, folders, files, Decisions, Models.
  for (const r of printerReviews(db)) reviews.push(r);
  for (const f of D.files) {
    if (f.entry_path) continue;
    const root = D.roots.get(f.root_id);
    if (f.state === "missing" && root && root.status !== "offline") reviews.push(review("missing_file", "missing:" + loc(f), { content_key: f.content_key, location: loc(f), priority: 3, summary: `${loc(f)} is no longer there` }));
    if (f.state === "unreadable") reviews.push(review("unreadable_file", "unreadable:" + loc(f), { content_key: f.content_key, location: loc(f), priority: 3, summary: `${loc(f)} could not be read` }));
  }
  for (const r of D.roots.values()) if (r.status === "offline") reviews.push(review("source_offline", "offline:" + r.id, { location: r.id, priority: 1, summary: `${r.name} is unreachable` }));
  // Decisions whose file is gone (§8, R11). Only after a completed scan of
  // the location it was last seen in; never guessed. Content changed in
  // place is file_changed; moved AND changed while unseen is unmatched.
  const indexComplete = [...D.roots.values()].every(r => !r.enabled || r.status === "offline" || D.indexed.has(r.id));
  // Files known only by their quick fingerprint whose full hash is still to
  // come (no identity cache entry, or an ambiguous one): until it arrives,
  // absence of a verified key proves nothing (§4.5).
  const identityPending = D.files.some(f => !f.entry_path && f.state === "present" && !f.sha256 && f.content_key.startsWith("q:") &&
    (D.roots.get(f.root_id) || {}).full_hash === "idle" && (D.roots.get(f.root_id) || {}).enabled);
  const locsOf = new Map();
  const byLoc = new Map();
  for (const f of D.files) { if (f.entry_path || f.state !== "present") continue; if (!locsOf.has(f.content_key)) locsOf.set(f.content_key, []); locsOf.get(f.content_key).push(loc(f)); byLoc.set(loc(f), f); }
  const setHint = db.prepare("UPDATE decisions SET subject_hint = ? WHERE id = ?");
  for (const d of D.decisions) {
    if (!["file", "variant"].includes(d.subject_type)) continue;
    const k = canonical(String(d.subject_key).split("#")[0]);
    if (locsOf.has(k)) {
      // Moved (same content): the hint follows, so a later change is found.
      const ls = locsOf.get(k).sort();
      if (!ls.includes(d.subject_hint)) setHint.run(ls[0], d.id);
      continue;
    }
    const rootId = d.subject_hint ? d.subject_hint.slice(0, d.subject_hint.indexOf(":")) : null;
    const root = rootId && D.roots.get(rootId);
    // (A file can move between locations: every enabled location must be.)
    if (!indexComplete || (root && (root.status === "offline" || !D.indexed.has(rootId)))) continue;
    const now_ = d.subject_hint && byLoc.get(d.subject_hint);
    const ev = { decision: d.id, relation: d.relation, polarity: d.polarity, subject: d.subject_key, objectKey: d.object_key, lastSeenAt: d.subject_hint };
    // Identity not settled yet: a Decision on a verified key cannot be called
    // unmatched while files whose identity the full hash will decide remain,
    // nor the file at its location "changed" while that file is unverified.
    // Quick keys compare directly: different fingerprints, different content.
    const verifiedSubject = !k.startsWith("q:");
    if (now_ && now_.content_key !== k && !now_.sha256 && verifiedSubject) continue;
    if (!now_ && verifiedSubject && identityPending) continue;
    if (now_ && now_.content_key !== k) {
      reviews.push(review("file_changed", "changed:" + d.id, { content_key: now_.content_key, other_content_key: k, location: d.subject_hint, priority: 2,
        summary: `${d.subject_hint} changed since a ${d.relation} Decision was made about it; the Decision still names the old content`, evidence: { ...ev, newContentKey: now_.content_key } }));
    } else {
      reviews.push(review("decision_unmatched", "decision:" + d.id, { content_key: k, location: d.subject_hint, priority: 1,
        summary: `A ${d.relation} Decision no longer matches any file${d.subject_hint ? " (last seen at " + d.subject_hint + ")" : ""}: moved and changed while unseen?`, evidence: ev }));
    }
  }
  // A Model with no files, once every location has been indexed (during a
  // rebuild its files may simply not be scanned yet) and no file's identity
  // is still waiting for its full hash.
  const usedModels = new Set(modelOfNode.values());
  if (indexComplete && !identityPending) for (const m of D.models.values()) if (!m.hidden && !m.merged_into && !usedModels.has(m.id)) reviews.push(review("empty_model", "empty:" + m.uuid, { model_uuid: m.uuid, priority: 3, summary: `${m.name} has no files any more` }));

  const reviewStats = syncReviews(db, reviews, now);

  // The run's report, for Diagnostics.
  const multi = clusters.filter(c => c.keys.length > 1);
  const report = {
    ruleVersion: RULE_VERSION, titleRuleVersion: TITLE_RULE_VERSION, generatedAt: now, ms: Date.now() - t0,
    counts: {
      nodes: nodes.size, models: new Set(modelOfNode.values()).size, modelsCreatedThisRun: created.length,
      multiFileModels: multi.length, filesInMultiFileModels: multi.reduce((n, c) => n + c.keys.length, 0),
      singleFileModels: clusters.filter(c => c.keys.length === 1).length,
      notModelled: D.files.filter(f => !f.entry_path && !MODEL_ROLES.has(f.role)).length,
      memberOfClaims: memberClaims, suggestions: suggestions.length, ambiguousFiles: ambiguousFiles.length,
      protectedGeneric: protectedClusters.length, duplicates: duplicates.length, unresolvedSources: unresolvedSources.length,
      blockedByDecisions: blocked.length, recordedEdges: edges.filter(e => e.cls === "record").length, edges: edges.length,
    },
    reviews: reviewStats,
    suggestions, ambiguousFiles, protectedClusters, protectedBlocks, duplicates, unresolvedSources, blocked,
    modelFolders: [...modelFolderInfo.values()],
    recorded: edges.filter(e => e.cls === "record").map(e => edgeView(e, nodes)),
    titles: [...nodes.values()].map(n => ({ file: n.loc, ...n.title })),
  };
  // file_titles (derived, §5): one row per file, the title its node uses.
  db.prepare("DELETE FROM file_titles").run();
  const insTitle = db.prepare("INSERT OR REPLACE INTO file_titles (file_id, original, normalized, transformations_json, token_count, generic_score, rule_version) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const n of nodes.values()) for (const f of n.files) {
    const t = n.titles.find(x => x.file === loc(f)) || n.title;
    insTitle.run(f.id, t.original, t.normalized, JSON.stringify(t.transformations), t.tokenCount, t.genericScore, TITLE_RULE_VERSION);
  }
  if (reportPath) writeReport(reportPath, report);
  return { counts: report.counts, reviews: reviewStats, ms: report.ms, report };
}

// Atomically: Diagnostics never reads half a report. The worker calls this
// only after the grouping transaction committed.
function writeReport(reportPath, report) {
  const tmp = reportPath + ".partial";
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(report));
  fs.renameSync(tmp, reportPath);
}

// ---------------------------------------------------------------- helpers

// The Library's query caches (§4.6 rule 5, §14), rebuilt from what grouping
// just wrote: which printer families each Model has Variants for (the grid's
// printer filter and facets), and the search index. Derived; dropping them
// loses nothing, and neither is ever the source of printer identity.
function refreshQueryCaches(db) {
  db.prepare("DELETE FROM model_families").run();
  db.prepare(`INSERT INTO model_families (model_id, printer_family, variant_count)
    SELECT f.model_id, v.printer_family, count(*) FROM variants v JOIN files f ON f.id = v.file_id
    WHERE f.model_id IS NOT NULL AND f.entry_path = '' AND v.printer_family IS NOT NULL GROUP BY f.model_id, v.printer_family`).run();
  db.prepare("DELETE FROM model_fts").run();
  db.prepare(`INSERT INTO model_fts (rowid, name, designer, tags, collections, file_names, object_names, project_titles, notes)
    SELECT m.id, m.name,
      trim(coalesce(m.designer, '') || ' ' || coalesce((SELECT group_concat(DISTINCT p.designer) FROM projects p JOIN files f ON f.id = p.file_id WHERE f.model_id = m.id), '')),
      '', '',
      coalesce((SELECT group_concat(f.name, ' ') FROM files f WHERE f.model_id = m.id AND f.entry_path = ''), ''),
      coalesce((SELECT group_concat(DISTINCT o.raw_name) FROM file_objects o JOIN files f ON f.id = o.file_id
        WHERE f.model_id = m.id AND o.generic = 0 AND o.origin != 'source_file'), ''),
      coalesce((SELECT group_concat(DISTINCT p.title) FROM projects p JOIN files f ON f.id = p.file_id WHERE f.model_id = m.id), ''),
      coalesce(m.notes, '')
    FROM models m WHERE EXISTS (SELECT 1 FROM files f WHERE f.model_id = m.id)`).run();
  // Extra word forms (camelCase split, adjacent words joined) so "trex" finds
  // "TinyTREX" and "T-Rex". Search only: never Evidence, never a display name.
  const up = db.prepare("UPDATE model_fts SET search_terms = ? WHERE rowid = ?");
  for (const r of db.prepare("SELECT rowid, name, file_names, project_titles FROM model_fts").all()) {
    const stems = String(r.file_names || "").split(/\.(?:gcode|gco|g|bgcode|3mf|stl|obj|step|stp)\b/i);
    up.run(searchForms([r.name, r.project_titles, ...stems]), r.rowid);
  }
  // Print counts and each Print's current Model (M7): grouping may just have
  // moved the content they were linked by.
  refreshStats(db);
}

// A Model merged into another answers for the survivor (a chain is followed).
function modelIdByUuid(D, uuid) {
  for (let hop = 0; hop < 10 && uuid; hop++) {
    let found = null;
    for (const m of D.models.values()) if (m.uuid === uuid) { found = m; break; }
    if (!found) return null;
    if (!found.merged_into) return found.id;
    uuid = found.merged_into;
  }
  return null;
}

function edgeView(e, nodes) {
  return { a: nodes.get(e.a).loc, b: nodes.get(e.b).loc, cls: e.cls, confidence: e.confidence, method: e.method, groups: e.groups, evidence: e.evidence, conflicts: e.conflicts, ignored: e.ignored, missing: e.missing };
}

// A readable name: a 3MF project's Title if any member has one, else the
// most common normalised title, shown as its file wrote it ("TinyTREX", not
// "Tinytrex"): the original text minus exactly what normalisation removed.
// Presentation only — the name is never grouping Evidence.
function modelName(ns, D) {
  for (const n of ns) for (const f of n.files) { const p = D.projects.get(f.id); if (p && p.title) return p.title; }
  const counts = new Map();
  // A title left empty, or only generic ("the", "assembly"), names nothing.
  for (const n of ns) for (const t of n.titles) if (t.normalized && t.tokenCount > 0 && t.genericScore < 1) counts.set(t.normalized, (counts.get(t.normalized) || 0) + 1);
  const best = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0];
  if (best) {
    for (const n of ns) for (const t of n.titles) if (t.normalized === best[0]) { const d = displayTitle(t); if (d) return d; }
    return best[0].replace(/\b\w/g, c => c.toUpperCase());
  }
  // Only generic titles: the first one with its noise removed (counts, times,
  // tags) but its words kept ("The Plate 1", "Assembly"), else the file name.
  const d = displayTitle(ns[0].titles[0], { noiseOnly: true });
  return d && d.length >= 2 ? d : ns[0].files[0].name.replace(/\.[^.]+$/, "");
}

function projectFacts(ns, D) {
  const out = { designer: null, license: null, design_model_id: null };
  for (const n of ns) for (const f of n.files) { const p = D.projects.get(f.id); if (!p) continue; out.designer = out.designer || p.designer; out.license = out.license || p.license; out.design_model_id = out.design_model_id || p.design_model_id; }
  return out;
}

function review(kind, subject_key, fields = {}) { return { kind, subject_key, ...fields }; }

// unknown_printer and folder_disagrees, from the Variants and their Claims.
function printerReviews(db) {
  const out = [];
  const folders = new Map(db.prepare("SELECT root_id, rel_path, class, evidence_json FROM folder_classes WHERE class = 'printer_family_like'").all().map(f => [f.root_id + ":" + f.rel_path, JSON.parse(f.evidence_json || "[]")[0] || {}]));
  for (const v of db.prepare(`SELECT v.file_id, v.plate_no, v.printer_family, v.printer_decision_id, f.content_key, f.root_id, f.rel_path FROM variants v JOIN files f ON f.id = v.file_id WHERE f.state = 'present' ORDER BY f.root_id, f.rel_path, v.plate_no`).all()) {
    const key = v.plate_no == null ? v.content_key : v.content_key + "#" + v.plate_no;
    const where = v.root_id + ":" + v.rel_path + (v.plate_no != null ? " plate " + v.plate_no : "");
    const top = db.prepare("SELECT object_key, confidence, state FROM claims WHERE subject_type = 'variant' AND subject_key = ? AND relation = 'targets_printer' ORDER BY CASE state WHEN 'applied' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END").get(key);
    if (!v.printer_family) {
      out.push(review("unknown_printer", "printer:" + key, { content_key: v.content_key, location: v.root_id + ":" + v.rel_path, confidence: top ? top.confidence : null, priority: 2,
        summary: top ? `${where}: printer ${top.object_key} is only ${top.state} (${top.confidence})` : `${where}: no known printer in the file`, evidence: top || null }));
      continue;
    }
    const parts = v.rel_path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const fc = folders.get(v.root_id + ":" + parts.slice(0, i).join("/"));
      if (fc && Array.isArray(fc.families) && !fc.families.includes(v.printer_family)) {
        out.push(review("folder_disagrees", "folder:" + v.root_id + ":" + v.rel_path + (v.plate_no != null ? "#" + v.plate_no : ""), { content_key: v.content_key, location: v.root_id + ":" + v.rel_path, priority: 3,
          summary: `${where}: the folder "${parts[i - 1]}" says ${fc.families.join("/")}, the file's own Evidence says ${v.printer_family}`,
          evidence: { folder: parts.slice(0, i).join("/"), folderFamilies: fc.families, fileFamily: v.printer_family, note: "informational: a folder is never Evidence for the printer" } }));
        break;
      }
    }
  }
  return out;
}

// Review Items are authored rows (§4.6): kept by subject_key. A wanted item
// is opened (or refreshed); one no longer wanted is auto-closed with the
// reason; a dismissed or resolved one is left exactly as the owner left it.
const MANAGED = ["suggested_match", "ambiguous_grouping", "possible_duplicate", "source_may_match", "unknown_printer", "folder_disagrees",
  "missing_file", "source_offline", "unreadable_file", "file_changed", "decision_unmatched", "empty_model"];
function syncReviews(db, wanted, now) {
  const byKey = new Map();
  for (const r of wanted) if (!byKey.has(r.subject_key)) byKey.set(r.subject_key, r);
  const existing = new Map(db.prepare(`SELECT id, kind, subject_key, status FROM review_items WHERE kind IN (${MANAGED.map(() => "?").join(",")})`).all(...MANAGED).map(r => [r.subject_key, r]));
  const stats = { opened: 0, updated: 0, autoClosed: 0, reopened: 0, keptDismissed: 0, open: {} };
  for (const [k, r] of [...byKey.entries()].sort()) {
    const e = existing.get(k);
    const ev = r.evidence != null ? JSON.stringify(r.evidence).slice(0, 20000) : null;
    if (!e) {
      db.prepare(`INSERT INTO review_items (kind, subject_key, claim_key, model_uuid, other_model_uuid, content_key, other_content_key, location, other_location, confidence, summary, evidence_json, priority, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(r.kind, k, r.claim_key || null, r.model_uuid || null, r.other_model_uuid || null, r.content_key || null, r.other_content_key || null,
        r.location || null, r.other_location || null, r.confidence || null, r.summary || null, ev, r.priority || 2, now, now);
      stats.opened++;
    } else if (e.status === "dismissed" || e.status === "resolved") { stats.keptDismissed++; continue; }
    else {
      db.prepare(`UPDATE review_items SET kind = ?, claim_key = ?, model_uuid = ?, other_model_uuid = ?, content_key = ?, other_content_key = ?, location = ?, other_location = ?, confidence = ?, summary = ?, evidence_json = ?, priority = ?,
        status = 'open', resolution_note = CASE WHEN status = 'auto_closed' THEN NULL ELSE resolution_note END, updated_at = ? WHERE id = ?`)
        .run(r.kind, r.claim_key || null, r.model_uuid || null, r.other_model_uuid || null, r.content_key || null, r.other_content_key || null, r.location || null, r.other_location || null, r.confidence || null, r.summary || null, ev, r.priority || 2, now, e.id);
      if (e.status === "auto_closed") stats.reopened++; else stats.updated++;
    }
    stats.open[r.kind] = (stats.open[r.kind] || 0) + 1;
  }
  for (const [k, e] of existing) if (!byKey.has(k) && e.status === "open") {
    db.prepare("UPDATE review_items SET status = 'auto_closed', resolution_note = 'the condition cleared', resolved_at = ?, updated_at = ? WHERE id = ?").run(now, now, e.id);
    stats.autoClosed++;
  }
  return stats;
}

module.exports = { run, writeReport, RULE_VERSION, MANAGED };

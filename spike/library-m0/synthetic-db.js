// spike/library-m0/synthetic-db.js — M0: build a synthetic Library index of N
// files on the canonical v3.1 schema (spike/library-m0/schema.sql, copied from
// docs/library-design.md §5) and measure size and query cost.
//
//   node spike/library-m0/synthetic-db.js [files=100000] [outDir]
//
// Shapes are taken from the real library: G-code config-block profile ids,
// EXCLUDE_OBJECT names, MakerWorld 3MF metadata, evidence items capped as the
// spec says (excerpt <= 200 chars, <= 12 items). Nothing here is product code.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const N = parseInt(process.argv[2], 10) || 100000;
const OUT = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-m0-"));
const DB = path.join(OUT, `library-${N}.db`);
for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB + s, { force: true });

// Deterministic PRNG so runs are comparable.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const hex = n => crypto.createHash("sha256").update(String(n)).digest("hex");
const now = Date.now();

const db = new DatabaseSync(DB);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

const T = {};
const step = l => process.stderr.write(`[m0] ${l}
`);
const time = (label, fn) => { step(label); const t = process.hrtime.bigint(); const r = fn(); T[label] = Number(process.hrtime.bigint() - t) / 1e6; return r; };

const DESIGNERS = ["Cinderwing3D", "MatMireMakes", "MysticSaige", "SnapPrint 3D", "Tactical Kaoz", "Flexi Factory", "Stemfie3D", "TR10_"];
const WORDS = ["Beardie", "Ferret", "Gecko", "Dragon", "Axolotl", "Lupa", "Hippo", "Kitty", "Snail", "Rex", "Unicorn", "Crow", "Python", "Maltese", "Platypus", "Butterfly", "Rose", "Skeleton", "Tree", "Gnome"];
const FAMILIES = [["snapmaker-u1", "Snapmaker U1", "PixelPrints U1 (0.4mm)"], ["flashforge-ad5x", "Flashforge AD5X", "AD5X (PixelPrints, 0.4)"],
  ["creality-sparkx-i7", "SPARKX i7", "SPARKX i7 0.4 nozzle"], ["creality-ender3-v3-plus", "Creality Ender-3 V3 Plus", "Creality Ender-3 V3 Plus 0.4 nozzle"],
  ["bambu-p2s", "Bambu Lab P2S", "Bambu Lab P2S 0.4 nozzle"]];
const ROLES = [["sliced", 0.45], ["source", 0.30], ["project", 0.08], ["image", 0.12], ["document", 0.05]];
const roleOf = () => { const x = rnd(); let a = 0; for (const [r, p] of ROLES) { a += p; if (x < a) return r; } return "other"; };
const EXT = { sliced: "gcode", source: "stl", project: "3mf", image: "webp", document: "pdf", other: "txt" };

// ---- models: ~3.3 files per model ----
const MODELS = Math.round(N / 3.3);
const models = [];
time("insert_models", () => {
  const ins = db.prepare("INSERT INTO models (uuid, origin, name, designer, created_at, updated_at) VALUES (?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let m = 0; m < MODELS; m++) {
    const name = `${pick(WORDS)} ${pick(WORDS)} ${m}`;
    const designer = pick(DESIGNERS);
    const r = ins.run(crypto.randomUUID(), rnd() < 0.97 ? "auto" : "user", name, designer, now - m * 1000, now - m * 500);
    models.push({ id: Number(r.lastInsertRowid), name, designer, files: [] });
  }
  db.exec("COMMIT");
});

// ---- roots ----
db.exec(`INSERT INTO roots (id,name,path,grouping,created_at) VALUES
  ('gcode','G-code folder','\\\\198.51.100.7\\Storage\\Files','files',${now}),
  ('nas','NAS Models','\\\\198.51.100.7\\Models','folders',${now}),
  ('local','Local downloads','D:\\\\Models','folders',${now})`);

// ---- files and everything derived from them ----
const files = [];
time("insert_files_and_derived", () => {
  const insF = db.prepare(`INSERT INTO files (root_id, rel_path, name, ext, role, size, mtime_ms, quick_fp, sha256, md5, content_key,
    meta_version, meta_json, thumb_key, first_seen, last_seen, model_id, model_claim_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`);
  const insO = db.prepare("INSERT OR IGNORE INTO file_objects (file_id, name_norm, raw_name, copies, origin, generic, excerpt) VALUES (?,?,?,?,?,?,?)");
  const insT = db.prepare("INSERT INTO file_titles (file_id, original, normalized, transformations_json, token_count, generic_score, rule_version) VALUES (?,?,?,?,?,?,1)");
  const insP = db.prepare(`INSERT INTO projects (file_id, flavour, producer, producer_version, title, designer, license, origin, design_model_id,
    design_profile_id, profile_title, printer_model, printer_model_id, printer_settings_id, print_settings_id, filament_settings_json,
    layer_height, nozzle, plate_count, sliced_plate_count, config_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insPl = db.prepare("INSERT INTO plates (project_id, plate_no, name, sliced, objects_json, thumb_key, gcode_md5) VALUES (?,?,?,?,?,?,?)");
  const insV = db.prepare(`INSERT INTO variants (file_id, plate_no, printer_family, printer_claim_key, printer_model, printer_model_id,
    printer_settings_id, print_settings_id, compatible_printers, filament_settings_json, filaments_json, layer_height, nozzle, bed_json,
    slicer, slicer_version, config_block, config_hash, est_seconds, weight_g, copies, color_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insA = db.prepare("INSERT INTO model_anchors (model_id, content_key, last_seen) VALUES (?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    const model = models[i % MODELS];
    const role = roleOf();
    const ext = EXT[role];
    const fam = pick(FAMILIES);
    const base = model.name.split(" ").slice(0, 2).join(" ");
    const title = role === "sliced" ? `${rnd() < 0.3 ? Math.ceil(rnd() * 30) + "x " : ""}${base} (${Math.ceil(rnd() * 30)}h${Math.floor(rnd() * 60)}m)` : `${base.replace(/ /g, "_")}_v0${Math.ceil(rnd() * 9)}`;
    const name = `${title} ${i}.${ext}`;   // index keeps synthetic paths unique
    const root = role === "sliced" ? "gcode" : (rnd() < 0.8 ? "nas" : "local");
    const rel = root === "gcode" ? `${fam[1].split(" ").pop()}/${model.designer}/${name}` : `${model.designer}/${base}/${role === "image" ? "images/" : ""}${name}`;
    const qfp = hex("q" + i), sha = rnd() < 0.7 ? hex("s" + i) : null;
    const ck = sha || "q:" + qfp;
    let meta = null;
    if (role === "sliced") meta = JSON.stringify({ palette: [0, 1, 2, 3].map(k => ({ i: k, hex: "#" + hex(i + k).slice(0, 6), type: "PLA", vendor: "Generic", wt: (rnd() * 40).toFixed(2), used: true })),
      printerModel: fam[1], printerSettingsId: fam[2], printCompatiblePrinters: `"${fam[1]} 0.4 nozzle"`, generatedBy: "OrcaSlicer 2.4.2",
      meta: [`${Math.ceil(rnd() * 30)}h ${Math.floor(rnd() * 60)}m`, `${(rnd() * 200).toFixed(1)} g`] });
    else if (role === "project") meta = JSON.stringify({ application: "BambuStudio-02.06.00.51", title: model.name, designer: model.designer, license: "BY-NC-SA" });
    else meta = JSON.stringify({ w: 1024, h: 768 });
    const claimKey = hex("c-member-" + i).slice(0, 40);
    const r = insF.run(root, rel, name, ext, role, Math.floor(rnd() * 2.5e8), now - i * 1000, qfp, sha, sha ? hex("m" + i).slice(0, 32) : null, ck,
      meta, role === "image" || role === "sliced" ? hex("t" + i).slice(0, 24) : null, now - i, now, model.id, claimKey);
    const fid = Number(r.lastInsertRowid);
    const f = { id: fid, ck, role, model, fam, name, title, rel, root };
    files.push(f); model.files.push(f);
    insA.run(model.id, ck, now);
    insT.run(fid, title, title.toLowerCase().replace(/^\d+x /, "").replace(/ \(.*\)$/, ""),
      JSON.stringify([{ rule: "time_paren", removed: "(5h41m)" }, ...(title.match(/^\d+x /) ? [{ rule: "copy_count", removed: title.match(/^\d+x /)[0].trim() }] : [])]),
      base.split(" ").length, rnd() * 0.3);
    if (role === "sliced" || role === "project") {
      const nObj = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < nObj; k++) {
        const on = `MMM_${base.replace(/ /g, "_")}_Part${k}_v0${k}.stl`.toLowerCase();
        insO.run(fid, on, on, 1 + Math.floor(rnd() * 4), role === "sliced" ? "exclude_object" : "model_settings", 0,
          `EXCLUDE_OBJECT_DEFINE NAME=${on}_id_${k}_copy_0 CENTER=133.87,130.026 POLYGON=[[34.3,53.1],[35.8,50.1],[38.8,47.6]`.slice(0, 200));
      }
    } else if (role === "source") insO.run(fid, name.toLowerCase(), name, 1, "mesh_basename", 0, null);
    if (role === "project") {
      const sliced = rnd() < 0.4 ? 1 : 0, plates = 1 + Math.floor(rnd() * 3);
      const pr = insP.run(fid, pick(["bambu", "orca", "snapmaker_orca", "creality"]), "BambuStudio", "02.06.00.51", model.name, model.designer, "BY-NC-SA", "original",
        "US" + hex("d" + model.id).slice(0, 14), String(800000000 + i), "PLA supports profile", fam[1], fam[0] === "bambu-p2s" ? "N7" : null, fam[2],
        "0.20mm Standard", JSON.stringify(["Generic PLA", "Generic PETG"]), 0.2, 0.4, plates, sliced ? plates : 0, hex("cfg" + i).slice(0, 16));
      for (let p = 1; p <= plates; p++) {
        insPl.run(Number(pr.lastInsertRowid), p, `Plate ${p}`, sliced, JSON.stringify([{ id: 1, name: base }]), hex("pt" + i + p).slice(0, 24), sliced ? hex("pm" + i + p).slice(0, 32).toUpperCase() : null);
        if (sliced) f.variantPlates = (f.variantPlates || 0) + 1;
      }
    }
    const addVariant = plate => insV.run(fid, plate, fam[0], hex("c-tp-" + i + "-" + plate).slice(0, 40), fam[1], fam[0] === "bambu-p2s" ? "N7" : null, fam[2],
      "PixelPrints (0.20)", `"${fam[1]} 0.4 nozzle"`, JSON.stringify(["PLA (U1 Silk)", "New PLA"]),
      JSON.stringify([{ hex: "#E0C8A0", type: "PLA", g: 42.1 }, { hex: "#101010", type: "PLA", g: 3.2 }]), 0.2, 0.4, JSON.stringify({ area: "0x0,270x0,270x270,0x270", h: 270 }),
      "OrcaSlicer", "2.4.2", 1, hex("vc" + i).slice(0, 16), Math.floor(rnd() * 100000), rnd() * 300, 1 + Math.floor(rnd() * 8), 1 + Math.floor(rnd() * 4));
    if (role === "sliced") addVariant(null);
    for (let p = 1; p <= (f.variantPlates || 0); p++) addVariant(p);
  }
  db.exec("COMMIT");
});

// ---- claims with evidence (the part the owner asked to size) ----
const ev = (items) => JSON.stringify(items.slice(0, 12));
let claimCount = 0;
time("insert_claims", () => {
  const ins = db.prepare(`INSERT OR IGNORE INTO claims (claim_key, subject_type, subject_key, relation, object_type, object_key, method, confidence, state,
    automatic, groups, evidence_json, rule_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,1,?,?)`);
  const add = (...a) => { ins.run(...a, now, now); claimCount++; };
  db.exec("BEGIN");
  for (const f of files) {
    const obj = `MMM_${f.name.split(" ")[0]}_Body_v08R.stl`;
    // member_of for every file
    const strong = f.role === "sliced" && rnd() < 0.7;
    add(hex("c-member-" + f.id).slice(0, 40), "file", f.ck, "member_of", "model", "uuid-" + f.model.id, strong ? "object_names+title" : "folder",
      strong ? "high" : (rnd() < 0.85 ? "high" : "medium"), strong || rnd() < 0.85 ? "applied" : "suggested",
      strong ? "internal-content,filename" : "location",
      ev(strong ? [
        { signal: "source_object_name", value: obj, source: "gcode:EXCLUDE_OBJECT_DEFINE", excerpt: `EXCLUDE_OBJECT_DEFINE NAME=${obj}_id_1_copy_0 CENTER=110,110 POLYGON=[[22.7727,25.4179],[23.3159,23.3249]`.slice(0, 200), group: "internal-content", strength: "strong", matches: "content:" + f.ck.slice(0, 20) },
        { signal: "normalized_title", group: "filename", strength: "medium", compare: { original_a: f.title, original_b: f.model.name, normalized_a: f.title.toLowerCase().replace(/ \(.*\)$/, ""), normalized_b: f.model.name.toLowerCase(), transformations_a: [{ rule: "time_paren", removed: "(5h41m)" }], transformations_b: [], method: "exact_normalized", score: 1, result: "match" } },
        { signal: "designer", value: f.model.designer, source: "folder-token", group: "location", strength: "weak" }]
        : [{ signal: "model_folder", value: f.rel.split("/").slice(0, 2).join("/"), source: "folders-mode", group: "location", strength: "structural" }]));
    if (f.role === "sliced" || f.variantPlates) {
      add(hex("c-tp-" + f.id).slice(0, 40), "variant", f.ck + "#", "targets_printer", "printer_family", f.fam[0], "printer_model+settings", "high", "applied", "internal-content",
        ev([{ signal: "printer_model", value: f.fam[1], family: f.fam[0], strength: "strong" }, { signal: "printer_settings_id", value: f.fam[2], family: f.fam[0], strength: "medium" },
          { signal: "print_compatible_printers", value: `"${f.fam[1]} 0.4 nozzle"`, family: f.fam[0], strength: "medium" }, { signal: "default_print_profile", value: "0.20mm Standard @Flashforge AD5M Pro 0.4 Nozzle", strength: "weak" }]));
    }
    if (f.role === "sliced" && rnd() < 0.4) add(hex("c-src-" + f.id).slice(0, 40), "file", "q:src" + f.id, "source_of", "file", f.ck, "source_object_name", "medium", "suggested", "internal-content",
      ev([{ signal: "source_object_name", value: obj, source: "gcode:EXCLUDE_OBJECT_DEFINE", excerpt: `EXCLUDE_OBJECT_DEFINE NAME=${obj}_id_1_copy_0`, group: "internal-content", strength: "strong" }]));
    if (f.role === "project" && rnd() < 0.8) add(hex("c-so-" + f.id).slice(0, 40), "file", "q:mesh" + f.id, "source_of", "file", f.ck, "source_file_meta", "high", "applied", "identity",
      ev([{ signal: "source_file", value: obj, source: "3mf:Metadata/model_settings.config", group: "identity", strength: "identity" }]));
    if (rnd() < 0.02) add(hex("c-dup-" + f.id).slice(0, 40), "location", `${f.root}:${f.rel}`, "duplicate_of", "location", `nas:copy/${f.rel}`, "sha256", "exact", "applied", "identity",
      ev([{ signal: "sha256", value: f.ck.slice(0, 16), group: "identity", strength: "identity" }]));
  }
  for (let m = 0; m < MODELS * 0.1; m++) add(hex("c-same-" + m).slice(0, 40), "model", "uuid-" + m, "same_model_as", "model", "uuid-" + (m + 1), "normalized_title", "medium", "suggested", "filename",
    ev([{ signal: "normalized_title", group: "filename", strength: "medium", compare: { original_a: "Lupa, 3 Colors (16h31)", original_b: "4x Lupa (PLA_21h18m)", normalized_a: "lupa", normalized_b: "lupa", transformations_a: [{ rule: "trailing_paren", removed: "(16h31)" }, { rule: "colour_words", removed: "3 Colors" }], transformations_b: [{ rule: "copy_count", removed: "4x" }, { rule: "orca_tail", removed: "(PLA_21h18m)" }], method: "exact_normalized", score: 1, result: "match" } }]));
  db.exec("COMMIT");
});

// ---- authored: decisions, review items, prints, tags ----
time("insert_authored", () => {
  db.exec("BEGIN");
  const insD = db.prepare("INSERT INTO decisions (subject_type, subject_key, relation, polarity, object_type, object_key, subject_hint, from_claim_key, evidence_snapshot_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < Math.round(N * 0.02); i++) { const f = files[Math.floor(rnd() * files.length)]; insD.run("file", f.ck, "member_of", rnd() < 0.8 ? "affirm" : "reject", "model", "uuid-" + f.model.id, `${f.root}:${f.rel}`, hex("c-member-" + f.id).slice(0, 40), '[{"signal":"normalized_title","strength":"medium"}]', "u1", now); }
  const insR = db.prepare("INSERT INTO review_items (kind, subject_key, claim_key, model_uuid, content_key, confidence, summary, evidence_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < Math.round(N * 0.05); i++) { const f = files[i * 7 % files.length]; insR.run(pick(["suggested_match", "unknown_printer", "possible_duplicate", "no_cover", "ambiguous_grouping"]), "rk-" + i, hex("c-member-" + f.id).slice(0, 40), "uuid-" + f.model.id, f.ck, "medium", `${f.name} may belong to ${f.model.name}`, '[{"signal":"normalized_title","strength":"medium","value":"beardie"}]', now, now); }
  const insP = db.prepare(`INSERT INTO prints (content_key, plate_no, model_uuid_at_link, printer_id, printer_name, remote_name, source, link_method, link_confidence, link_evidence_json,
    link_rule_version, user_id, user_label, started_at, ended_at, outcome, elapsed_sec, filament_g) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`);
  const sliced = files.filter(f => f.role === "sliced");
  for (let i = 0; i < Math.round(N * 0.2); i++) { const f = sliced[Math.floor(rnd() * sliced.length)]; const byName = rnd() < 0.3;
    insP.run(f.ck, null, "uuid-" + f.model.id, "p" + (i % 26), "U1 Gold", f.name, byName ? "backfill" : "library", byName ? "filename" : "snapcon_variant", byName ? "medium" : "exact",
      byName ? JSON.stringify({ audit_ref: i, compare: { original_a: f.name, original_b: f.name, method: "exact", result: "unique" } }) : null, "u1", "alice", now - i * 60000, now - i * 60000 + 3600000, "completed", 3600, 42.5); }
  const insTag = db.prepare("INSERT INTO tags (name) VALUES (?)"); for (const w of WORDS) insTag.run(w.toLowerCase());
  const insMT = db.prepare("INSERT OR IGNORE INTO model_tags (model_id, tag_id, added_at) VALUES (?,?,?)"); for (let m = 1; m <= MODELS; m += 3) insMT.run(m, 1 + (m % WORDS.length), now);
  db.exec("COMMIT");
});

// ---- derived stats + FTS ----
time("build_stats_and_fts", () => {
  db.exec(`INSERT INTO model_stats (model_id, print_count, print_count_confirmed, print_count_filename, last_printed_at)
    SELECT f.model_id, count(p.id), sum(p.link_confidence IN ('exact','high')), sum(p.link_method='filename'), max(p.started_at)
    FROM prints p JOIN files f ON f.content_key = p.content_key GROUP BY f.model_id`);
  db.exec(`INSERT INTO model_fts (rowid, name, designer, tags, collections, file_names, object_names, project_titles, notes)
    SELECT m.id, m.name, m.designer, '', '', (SELECT group_concat(name,' ') FROM (SELECT name FROM files WHERE model_id=m.id LIMIT 20)),
      (SELECT group_concat(name_norm,' ') FROM (SELECT DISTINCT o.name_norm FROM file_objects o JOIN files f ON f.id=o.file_id WHERE f.model_id=m.id LIMIT 30)), '', ''
    FROM models m`);
});
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

// ---- queries ----
const bench = (label, fn, runs = 20) => {
  step("query: " + label);
  fn(); const ts = [];
  for (let i = 0; i < runs; i++) { const t = process.hrtime.bigint(); fn(); ts.push(Number(process.hrtime.bigint() - t) / 1e6); }
  ts.sort((a, b) => a - b);
  return { label, median_ms: +ts[Math.floor(ts.length / 2)].toFixed(3), p95_ms: +ts[Math.floor(ts.length * 0.95)].toFixed(3) };
};
const Q = [];
const gridPage = db.prepare(`SELECT m.id, m.name, s.print_count, s.print_count_confirmed,
    (SELECT count(*) FROM files f JOIN variants v ON v.file_id=f.id WHERE f.model_id=m.id) AS variants
  FROM models m LEFT JOIN model_stats s ON s.model_id=m.id WHERE m.hidden=0 ORDER BY m.updated_at DESC LIMIT 60 OFFSET ?`);
Q.push(bench("grid page 1 (60 cards)", () => gridPage.all(0)));
Q.push(bench("grid page at offset 30000", () => gridPage.all(Math.min(30000, MODELS - 60))));
// M0 finding: the same filter written as a correlated EXISTS took 15.7 s at
// 10k files (SQLite re-walks variants_family once per model). As a set
// computed once (IN), it is sub-millisecond. M1 must use the IN form.
const gridByPrinter = db.prepare(`SELECT m.id, m.name FROM models m WHERE m.hidden=0 AND m.id IN
  (SELECT f.model_id FROM variants v JOIN files f ON f.id=v.file_id WHERE v.printer_family=?) ORDER BY m.updated_at DESC LIMIT 60`);
Q.push(bench("grid filtered Printer=U1", () => gridByPrinter.all("snapmaker-u1")));
const fts = db.prepare(`SELECT m.id, m.name FROM model_fts JOIN models m ON m.id=model_fts.rowid WHERE model_fts MATCH ? ORDER BY rank LIMIT 60`);
Q.push(bench("search 'gec*' (FTS, 60 results)", () => fts.all("gec*")));
Q.push(bench("search 'beard* drag*'", () => fts.all("beard* drag*")));
const facets = db.prepare(`SELECT v.printer_family, count(DISTINCT f.model_id) n FROM variants v JOIN files f ON f.id=v.file_id GROUP BY v.printer_family`);
Q.push(bench("printer facet counts (whole library)", () => facets.all(), 10));
const detailFiles = db.prepare(`SELECT f.*, c.method, c.confidence, c.state, c.evidence_json FROM files f LEFT JOIN claims c ON c.claim_key=f.model_claim_key WHERE f.model_id=?`);
const detailVars = db.prepare(`SELECT v.*, c.confidence, c.evidence_json FROM variants v JOIN files f ON f.id=v.file_id LEFT JOIN claims c ON c.claim_key=v.printer_claim_key WHERE f.model_id=?`);
const detailPrints = db.prepare(`SELECT p.* FROM prints p JOIN files f ON f.content_key=p.content_key WHERE f.model_id=? ORDER BY p.started_at DESC LIMIT 50`);
Q.push(bench("model page (files+claims, variants+claims, prints)", () => { const id = 1 + Math.floor(rnd() * MODELS); detailFiles.all(id); detailVars.all(id); detailPrints.all(id); }));
const lookup = db.prepare("SELECT id, size, mtime_ms, content_key FROM files WHERE root_id=? AND rel_path=?");
Q.push(bench("incremental scan: 1000 path lookups", () => { for (let i = 0; i < 1000; i++) { const f = files[(i * 97) % files.length]; lookup.get(f.root, f.rel); } }, 10));
const anchors = db.prepare(`SELECT model_id, count(*) n FROM model_anchors WHERE content_key IN (?,?,?,?,?) GROUP BY model_id ORDER BY n DESC`);
Q.push(bench("anchor match for a 5-file cluster", () => { const m = models[Math.floor(rnd() * MODELS)]; const k = m.files.map(f => f.ck).concat(["x", "x", "x", "x", "x"]).slice(0, 5); anchors.all(...k); }));
const review = db.prepare("SELECT * FROM review_items WHERE status='open' AND kind=? ORDER BY priority, created_at DESC LIMIT 60");
Q.push(bench("needs-attention page (60)", () => review.all("suggested_match")));
// Keyed on the object (the model), so it uses claims_object, not a scan of
// every file claim.
const diag = db.prepare(`SELECT c.* FROM claims c WHERE c.object_type='model' AND c.relation='member_of' AND c.object_key IN (SELECT 'uuid-'||id FROM models ORDER BY id LIMIT 60 OFFSET ?)`);
Q.push(bench("diagnostics: member_of claims for 60 models", () => diag.all(Math.floor(rnd() * (MODELS - 60)))));

// ---- sizes ----
step("vacuum + sizes");
db.exec("VACUUM");
const pageSize = db.prepare("PRAGMA page_size").get().page_size;
const totalBytes = db.prepare("PRAGMA page_count").get().page_count * pageSize;
const perObj = db.prepare("SELECT name, sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all();
const tbl = db.prepare("SELECT name, tbl_name FROM sqlite_schema").all();
const owner = Object.fromEntries(tbl.map(r => [r.name, r.tbl_name]));
const perTable = {};
for (const r of perObj) { const t = (owner[r.name] || r.name).replace(/^model_fts.*/, "model_fts"); perTable[t] = (perTable[t] || 0) + r.bytes; }
const counts = {};
for (const t of ["files", "file_objects", "file_titles", "projects", "plates", "variants", "claims", "models", "model_anchors", "decisions", "review_items", "prints"]) counts[t] = db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
const evidenceBytes = db.prepare("SELECT sum(length(evidence_json)) b, avg(length(evidence_json)) a FROM claims").get();

// Claims impact: the same database without evidence, and without claims at all.
const noEv = path.join(OUT, "noevidence.db"), noCl = path.join(OUT, "noclaims.db");
for (const p of [noEv, noCl]) fs.rmSync(p, { force: true });
db.exec(`VACUUM INTO '${noEv.replace(/'/g, "''")}'`);
db.close();
const d2 = new DatabaseSync(noEv); d2.exec("UPDATE claims SET evidence_json='[]'; VACUUM;");
const sizeNoEvidence = d2.prepare("PRAGMA page_count").get().page_count * pageSize;
d2.exec(`VACUUM INTO '${noCl.replace(/'/g, "''")}'`); d2.close();
const d3 = new DatabaseSync(noCl); d3.exec("DELETE FROM claims; VACUUM;");
const sizeNoClaims = d3.prepare("PRAGMA page_count").get().page_count * pageSize; d3.close();

step("rebuild simulation");
// Rebuild: delete every derived row (authored rows must survive), timed.
const RB = path.join(OUT, "rebuild-copy.db"); fs.rmSync(RB, { force: true });
{ const src = new DatabaseSync(DB); src.exec(`VACUUM INTO '${RB.replace(/'/g, "''")}'`); src.close(); }
const d4 = new DatabaseSync(RB);   // on a copy, so the measured DB stays populated for inspection
d4.exec("PRAGMA foreign_keys=ON");
const authoredBefore = ["roots", "models", "model_anchors", "decisions", "review_items", "prints", "tags", "model_tags"].map(t => [t, d4.prepare(`SELECT count(*) c FROM ${t}`).get().c]);
const tRb = process.hrtime.bigint();
d4.exec("BEGIN; DELETE FROM model_fts; DELETE FROM model_stats; DELETE FROM claims; DELETE FROM variants; DELETE FROM plates; DELETE FROM projects; DELETE FROM folder_classes; DELETE FROM file_titles; DELETE FROM file_objects; DELETE FROM content_aliases; DELETE FROM files; DELETE FROM scan_runs; DELETE FROM thumbs; COMMIT;");
const rebuildDeleteMs = Number(process.hrtime.bigint() - tRb) / 1e6;
const authoredAfter = authoredBefore.map(([t]) => [t, d4.prepare(`SELECT count(*) c FROM ${t}`).get().c]);
d4.close();

const MB = b => +(b / 1048576).toFixed(1);
console.log(JSON.stringify({
  files: N, models: MODELS, dbPath: DB,
  counts, claims: counts.claims,
  size_mb: { total: MB(totalBytes), without_evidence: MB(sizeNoEvidence), without_claims: MB(sizeNoClaims),
    evidence_share_mb: MB(totalBytes - sizeNoEvidence), claims_share_mb: MB(totalBytes - sizeNoClaims) },
  evidence_json: { total_mb: MB(evidenceBytes.b), avg_bytes_per_claim: Math.round(evidenceBytes.a) },
  per_table_mb: Object.fromEntries(Object.entries(perTable).map(([k, v]) => [k, MB(v)]).filter(([, v]) => v >= 0.1)),
  build_ms: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, Math.round(v)])),
  queries: Q,
  rebuild: { delete_all_derived_ms: Math.round(rebuildDeleteMs),
    authored_intact: authoredBefore.every(([t, c], i) => authoredAfter[i][1] === c), authoredAfter: Object.fromEntries(authoredAfter) },
}, null, 2));

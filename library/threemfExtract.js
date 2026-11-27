// library/threemfExtract.js — what a 3MF says about itself (§6.2): the slicer
// that wrote it, MakerWorld-style project metadata, the printer profile, the
// plates and which of them are sliced, filaments, object names, source-file
// references, plate pictures and the Auxiliaries.
//
// Pure: it is handed the few small entries the scanner read (never the mesh)
// and the archive's directory. Everything here is "what the file says": no
// relationship is inferred. The flavour is the one judgement, and it is
// returned with the method and the Evidence that decided it.
"use strict";
const crypto = require("crypto");
const { inflate } = require("./zipReader");

// Bump when extraction changes what it reads (files are re-read on start).
const RULE_VERSION = 1;

// The entries worth reading, given the directory. Sizes are the raw
// (uncompressed) sizes; the mesh is never among them.
const LIMITS = {
  configBytes: 16 * 1024 * 1024,   // project/model settings, slice info
  modelFullBytes: 2 * 1024 * 1024, // 3D/3dmodel.model read whole below this…
  modelHeadBytes: 64 * 1024,       // …else only its head (compressed bytes): the metadata comes first
  thumbBytes: 2 * 1024 * 1024,
  auxPictureBytes: 300 * 1024,     // Auxiliaries pictures kept as thumbnails up to this (§10)
};
const PLATE_GCODE = /^Metadata\/plate_(\d+)\.gcode$/;
const PLATE_MD5 = /^Metadata\/plate_(\d+)\.gcode\.md5$/;
const PLATE_PNG = /^Metadata\/plate_(\d+)(_small)?\.png$/;

function wantedEntries(directory) {
  const names = new Set(directory.map(e => e.name));
  const size = n => (directory.find(e => e.name === n) || {}).rawSize;
  const want = [];
  const add = (name, opts = {}) => { if (names.has(name)) want.push({ name, ...opts }); };
  if (names.has("3D/3dmodel.model")) want.push(size("3D/3dmodel.model") <= LIMITS.modelFullBytes ? { name: "3D/3dmodel.model" } : { name: "3D/3dmodel.model", headBytes: LIMITS.modelHeadBytes });
  for (const n of ["Metadata/project_settings.config", "Metadata/model_settings.config", "Metadata/slice_info.config", "Metadata/Slic3r_PE.config"]) {
    if (names.has(n) && size(n) <= LIMITS.configBytes) add(n);
  }
  for (const e of directory) if (PLATE_MD5.test(e.name) && e.rawSize <= 1024) add(e.name);
  // One picture per plate: the small one first (cheapest), else the full one.
  const plates = new Set();
  for (const e of directory) { const m = PLATE_PNG.exec(e.name) || PLATE_GCODE.exec(e.name); if (m) plates.add(+m[1]); }
  for (const p of plates) {
    const small = `Metadata/plate_${p}_small.png`, full = `Metadata/plate_${p}.png`;
    if (names.has(small) && size(small) <= LIMITS.thumbBytes) add(small);
    else if (names.has(full) && size(full) <= LIMITS.thumbBytes) add(full);
  }
  if (!plates.size && names.has("Auxiliaries/.thumbnails/thumbnail_3mf.png") && size("Auxiliaries/.thumbnails/thumbnail_3mf.png") <= LIMITS.thumbBytes) add("Auxiliaries/.thumbnails/thumbnail_3mf.png");
  for (const e of directory) if (isAuxiliary(e.name) && /\.(png|jpe?g|webp|gif)$/i.test(e.name) && e.rawSize <= LIMITS.auxPictureBytes) add(e.name);
  return want;
}

// Auxiliaries pictures and documents a person put in the project — not the
// slicer's own cached thumbnails (".thumbnails").
const isAuxiliary = n => /^Auxiliaries\//.test(n) && !n.endsWith("/") && !/\/\./.test(n);

// ---- small XML/attribute helpers (the files are slicer-written, flat) ----
const unescape = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unescape(m[1]) : null; };
function metadataPairs(xml) {   // <metadata key="k" value="v"/>
  const out = {};
  for (const m of xml.matchAll(/<metadata\b([^>]*?)\/?>/g)) { const k = attr(m[1], "key"); if (k != null) out[k] = attr(m[1], "value"); }
  return out;
}
const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "g"))].map(m => ({ attrs: m[1], body: m[2] }));
const cut = (s, n = 200) => (s == null ? null : String(s).slice(0, n));
const basename = p => String(p || "").split(/[\\/]/).pop();

// <metadata name="Title">…</metadata> in the 3MF model (the 3MF core spec's
// own metadata, where Bambu Studio and MakerWorld put the project's facts).
function modelMetadata(xml) {
  const out = {};
  for (const m of xml.matchAll(/<metadata\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/metadata>/g)) out[m[1]] = unescape(m[2]).trim();
  return out;
}

// ---- flavour ----
// Decided from the producer the file names, with the Evidence kept:
//   "BambuStudio-02.06.00.51"  Bambu Studio's own (four zero-padded parts)
//   "BambuStudio-2.3.5" + a Snapmaker printer  Snapmaker Orca (it writes the
//       Bambu name with its own three-part version; seen on real U1
//       projects, whose G-code says "Snapmaker Orca 2.3.5")
//   "OrcaSlicer-…", "CrealityPrint-…", "PrusaSlicer-…"  as named
function detectFlavour({ application, settings, names }) {
  const ev = [];
  if (application) ev.push({ signal: "application", value: application, source: "3D/3dmodel.model" });
  if (settings && settings.version) ev.push({ signal: "settings_version", value: String(settings.version), source: "Metadata/project_settings.config" });
  if (settings && settings.printer_model) ev.push({ signal: "printer_model", value: String(settings.printer_model), source: "Metadata/project_settings.config" });
  const app = String(application || "");
  const done = (flavour, method) => ({ flavour, method, evidence: ev });
  if (/^orca\s*slicer/i.test(app)) return done("orca", "application");
  if (/snapmaker/i.test(app)) return done("snapmaker_orca", "application");
  if (/creality/i.test(app)) return done("creality", "application");
  if (/prusa|slic3r/i.test(app) || names.has("Metadata/Slic3r_PE.config")) return done("prusa", app ? "application" : "slic3r_config");
  const bambu = /^bambu\s*studio-(.+)$/i.exec(app);
  if (bambu) {
    if (/^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(bambu[1])) return done("bambu", "application_version_form");
    if (/^\d+\.\d+\.\d+$/.test(bambu[1]) && /snapmaker/i.test(String(settings && settings.printer_model || ""))) return done("snapmaker_orca", "bambu_name_three_part_version+snapmaker_printer");
    return done("other", "bambu_name_unknown_fork");
  }
  return done("other", app ? "unrecognised_application" : "no_application");
}

const first = v => (Array.isArray(v) ? v[0] : v);
const list = v => (Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(";").map(s => s.trim()));
const num = v => { const n = parseFloat(first(v)); return Number.isFinite(n) ? n : null; };

// raw: name -> { comp (Buffer), entry: {name, method, crc, rawSize}, partial }
// directory: [{ name, rawSize, compSize, method }]
function extract3mf({ directory, raw, zip64 = false }) {
  const problems = [];
  const names = new Set(directory.map(e => e.name));
  const text = name => {
    const r = raw[name];
    if (!r) return null;
    try { return inflate(r.comp, r.entry, r.partial ? { partial: true, maxOut: 1024 * 1024 } : {}).toString("utf8"); }
    catch (e) { problems.push({ entry: name, error: e.message }); return null; }
  };
  const bytes = name => {
    const r = raw[name];
    if (!r || r.partial) return null;
    try { return inflate(r.comp, r.entry); } catch (e) { problems.push({ entry: name, error: e.message }); return null; }
  };

  // The project's own metadata (3MF core), from the head of the model file.
  const modelXml = text("3D/3dmodel.model");
  const md = modelXml ? modelMetadata(modelXml) : {};
  if (raw["3D/3dmodel.model"] && raw["3D/3dmodel.model"].partial) problems.push({ entry: "3D/3dmodel.model", note: "large model file: only its head was read for metadata" });
  const val = k => (md[k] != null && md[k] !== "" ? md[k] : null);
  const project = {
    application: val("Application"),
    title: val("Title"), designer: val("Designer"), license: val("License"), origin: val("Origin"),
    description: cut(val("Description"), 500), copyright: val("Copyright") || val("CopyRight"),
    designModelId: val("DesignModelId"), designProfileId: val("DesignProfileId"), designRegion: val("DesignRegion"),
    designerUserId: val("DesignerUserId"), profileTitle: val("ProfileTitle"), profileUserName: val("ProfileUserName"),
    profileUserId: val("ProfileUserId"), creationDate: val("CreationDate"), modificationDate: val("ModificationDate"),
    thumbnailMiddle: val("Thumbnail_Middle"), thumbnailSmall: val("Thumbnail_Small"),
  };

  // The profile (Bambu/Orca family): one JSON object.
  let settings = null;
  const psText = text("Metadata/project_settings.config");
  if (psText) { try { settings = JSON.parse(psText); } catch (e) { problems.push({ entry: "Metadata/project_settings.config", error: "not JSON: " + e.message }); } }
  const s = settings || {};
  const profile = settings ? {
    printer_model: s.printer_model || null, printer_settings_id: s.printer_settings_id || null, print_settings_id: s.print_settings_id || null,
    compatible_printers: list(s.print_compatible_printers), inherits: s.inherits || null, inherits_group: list(s.inherits_group).filter(Boolean),
    filament_settings_id: list(s.filament_settings_id), filament_type: list(s.filament_type), filament_colour: list(s.filament_colour),
    filament_vendor: list(s.filament_vendor), layer_height: num(s.layer_height), nozzle: num(s.nozzle_diameter),
    bed_type: s.curr_bed_type || null, version: s.version || null, from: s.from || null,
  } : null;
  const configHash = settings ? crypto.createHash("sha1").update(JSON.stringify(Object.keys(s).sort().map(k => [k, s[k]]))).digest("hex") : null;

  // Objects (model_settings): names, their parts (the meshes they were made
  // from) and source_file references — written by the slicer, so recorded as
  // what the file says.
  const objects = [], plates = new Map();
  const msText = text("Metadata/model_settings.config");
  if (msText) {
    for (const o of blocks(msText, "object")) {
      const head = metadataPairs(o.body.split("<part")[0]);
      const parts = blocks(o.body, "part").map(p => { const pm = metadataPairs(p.body); return { name: pm.name || null, sourceFile: pm.source_file || null }; });
      objects.push({ id: attr(o.attrs, "id"), name: head.name || null, parts });
    }
    for (const p of blocks(msText, "plate")) {
      const pm = metadataPairs(p.body.split("<model_instance")[0]);
      const no = parseInt(pm.plater_id, 10);
      if (!Number.isFinite(no)) continue;
      const ids = blocks(p.body, "model_instance").map(mi => metadataPairs(mi.body).object_id).filter(Boolean);
      plates.set(no, { plate_no: no, name: pm.plater_name || null, objectIds: ids, gcodeFile: pm.gcode_file || null, thumbnailFile: pm.thumbnail_file || null });
    }
  }
  const objectName = id => (objects.find(o => o.id === id) || {}).name || null;

  // Sliced plates (slice_info): printer id, time, weight, filaments, objects.
  const siText = text("Metadata/slice_info.config");
  const slicedInfo = new Map();
  let clientVersion = null;
  if (siText) {
    const h = /<header_item\s+key="X-BBL-Client-Version"\s+value="([^"]*)"/.exec(siText);
    clientVersion = h ? h[1] || null : null;
    for (const p of blocks(siText, "plate")) {
      const m = metadataPairs(p.body);
      const no = parseInt(m.index, 10);
      if (!Number.isFinite(no)) continue;
      const filaments = [...p.body.matchAll(/<filament\b([^>]*)\/>/g)].map(f => ({
        id: +attr(f[1], "id") || null, type: attr(f[1], "type"), color: attr(f[1], "color"),
        trayInfoIdx: attr(f[1], "tray_info_idx"), usedG: num(attr(f[1], "used_g")), usedM: num(attr(f[1], "used_m")),
      }));
      const objs = [...p.body.matchAll(/<object\b([^>]*)\/>/g)].map(o => ({ name: attr(o[1], "name"), skipped: attr(o[1], "skipped") === "true" }));
      slicedInfo.set(no, { printerModelId: m.printer_model_id || null, nozzle: num(m.nozzle_diameters), prediction: num(m.prediction), weight: num(m.weight), filaments, objects: objs });
    }
  }

  // Every plate the file knows of: from model_settings, slice_info, the plate
  // G-code entries and the plate pictures. Sliced means its G-code is inside.
  const plateNos = new Set([...plates.keys(), ...slicedInfo.keys()]);
  for (const n of names) { const m = PLATE_GCODE.exec(n) || PLATE_PNG.exec(n); if (m) plateNos.add(+m[1]); }
  const plateList = [...plateNos].sort((a, b) => a - b).map(no => {
    const ms = plates.get(no) || { plate_no: no, name: null, objectIds: [] };
    const si = slicedInfo.get(no) || null;
    const gcodeEntry = `Metadata/plate_${no}.gcode`;
    const md5Text = text(`Metadata/plate_${no}.gcode.md5`);
    const md5 = md5Text && /^[0-9a-f]{32}$/i.test(md5Text.trim()) ? md5Text.trim().toLowerCase() : null;
    const thumbName = [`Metadata/plate_${no}_small.png`, `Metadata/plate_${no}.png`].find(n => raw[n]);
    const picture = thumbName ? bytes(thumbName) : null;
    return {
      plate_no: no, name: ms.name, sliced: names.has(gcodeEntry),
      objects: ms.objectIds.map(objectName).filter(Boolean),
      slicedObjects: si ? si.objects.map(o => o.name).filter(Boolean) : [],
      gcodeEntry: names.has(gcodeEntry) ? gcodeEntry : null,
      gcodeSize: (directory.find(e => e.name === gcodeEntry) || {}).rawSize || null,
      gcodeMd5: md5, slice: si,
      thumbnail: picture && isPicture(picture) ? { entry: thumbName, mime: "image/png", ext: "png", data: picture } : null,
    };
  });

  // The file-level picture: plate 1's, else the 3MF thumbnail.
  let thumbnail = (plateList.find(p => p.thumbnail) || {}).thumbnail || null;
  if (!thumbnail && raw["Auxiliaries/.thumbnails/thumbnail_3mf.png"]) {
    const b = bytes("Auxiliaries/.thumbnails/thumbnail_3mf.png");
    if (b && isPicture(b)) thumbnail = { entry: "Auxiliaries/.thumbnails/thumbnail_3mf.png", mime: "image/png", ext: "png", data: b };
  }

  // Auxiliaries: pictures and documents a person added (entry Files, §6.2).
  const auxiliaries = directory.filter(e => isAuxiliary(e.name)).map(e => {
    const b = raw[e.name] ? bytes(e.name) : null;
    const pic = b && isPicture(b);
    return { entry: e.name, name: basename(e.name), size: e.rawSize, crc: e.crc,
      picture: pic ? { mime: pic, ext: pic.split("/")[1].replace("jpeg", "jpg"), data: b } : null };
  });

  const sourceFiles = [...new Set(objects.flatMap(o => o.parts.map(p => p.sourceFile)).filter(Boolean))];
  const meshNames = [...new Set(objects.flatMap(o => o.parts.map(p => p.name)).filter(n => n && /\.(stl|obj|step|stp|3mf|amf|ply)$/i.test(n)))];
  const flavour = detectFlavour({ application: project.application, settings, names });
  const app = /^(.*?)-(\d[\w.]*)$/.exec(project.application || "");

  return {
    ruleVersion: RULE_VERSION, zip64, entryCount: directory.length,
    flavour, producer: app ? app[1] : project.application, producerVersion: app ? app[2] : null, clientVersion,
    project, profile, configHash,
    identity: settings ? {   // what public/printer-identity.js reads, project-wide
      printerModel: profile.printer_model, printerSettingsId: profile.printer_settings_id,
      printCompatiblePrinters: profile.compatible_printers.join(";") || null, defaultPrintProfile: s.default_print_profile || null,
    } : null,
    objects: objects.map(o => ({ id: o.id, name: o.name, parts: o.parts.map(p => p.name).filter(Boolean) })),
    sourceFiles, meshNames,
    plates: plateList, slicedCount: plateList.filter(p => p.sliced).length,
    thumbnail, auxiliaries, problems,
  };
}

function isPicture(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length > 6 && b.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return null;
}

module.exports = { extract3mf, wantedEntries, detectFlavour, RULE_VERSION, LIMITS, isAuxiliary };

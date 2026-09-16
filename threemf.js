// threemf.js — reads a .3mf, which is a zip holding a slicer's project.
//
// SnapCon needs three things out of one: whether it can be printed at all,
// which printer it was sliced for, and the same header comments every plain
// gcode file has (so colours, weights and times keep coming from parser.js
// rather than a second, Bambu-shaped parser).
//
// WHY CONTENT, NEVER THE NAME. Two files exported from Bambu Studio on the same
// afternoon, both called .3mf, were an unsliced project and a sliced plate. The
// first cannot print — the printer is asked for Metadata/plate_1.gcode and
// there isn't one — and nothing about the file name says so. Every question
// here is answered by opening the archive.
//
// Scope: a *Bambu* .3mf. The library has accepted .3mf since FlashForge's AD5X
// (that is its multi-material format), and those files must keep behaving
// exactly as they did, so isBambu() decides who this applies to.
//
// Top level, beside parser.js, because both the server (library listing,
// colours, thumbnails) and the Bambu connector read it. Needs a Dockerfile COPY
// line — test/docker.test.js enforces that.
"use strict";
const fs = require("fs");
const zlib = require("zlib");

// A .3mf is tens of megabytes at most; the entry SnapCon reads out of one is
// the plate's gcode, a few MB. The cap is defence against a crafted archive
// claiming a gigabyte, not a real-file limit.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LOCAL_SIG = 0x04034b50;

// ---- the smallest zip reader this needs ----
// Central directory only: name, compression method, sizes and where the entry
// starts. No zip64 (a .3mf that large is not a print job), no encryption.
function readDirectory(fd, size) {
  // The end-of-central-directory record is last, after an optional comment.
  const tailLen = Math.min(size, 66560);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error("zip64 archives are not supported");
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = new Map();
  let o = 0;
  for (let i = 0; i < count && o + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(o) !== CD_SIG) break;
    const method = cd.readUInt16LE(o + 10);
    const compSize = cd.readUInt32LE(o + 20);
    const rawSize = cd.readUInt32LE(o + 24);
    const nameLen = cd.readUInt16LE(o + 28);
    const extraLen = cd.readUInt16LE(o + 30);
    const commentLen = cd.readUInt16LE(o + 32);
    const localOffset = cd.readUInt32LE(o + 42);
    const name = cd.toString("utf8", o + 46, o + 46 + nameLen);
    entries.set(name, { method, compSize, rawSize, localOffset });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(fd, entry, maxBytes) {
  if (entry.rawSize > Math.min(maxBytes, MAX_ENTRY_BYTES)) {
    throw new Error(`entry is too large to read (${entry.rawSize} bytes)`);
  }
  // The local header repeats the name and extra fields, and its lengths are the
  // authoritative ones for finding where the data starts.
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, entry.localOffset);
  if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error("damaged zip entry");
  const dataAt = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const comp = Buffer.alloc(entry.compSize);
  fs.readSync(fd, comp, 0, entry.compSize, dataAt);
  if (entry.method === 0) return comp;
  if (entry.method === 8) return zlib.inflateRawSync(comp, { maxOutputLength: Math.min(maxBytes, MAX_ENTRY_BYTES) });
  throw new Error("unsupported zip compression method " + entry.method);
}

function withArchive(file, fn) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    return fn(fd, readDirectory(fd, size));
  } finally {
    fs.closeSync(fd);
  }
}

// ---- what SnapCon asks of a .3mf ----

const PLATE_GCODE_RE = /^Metadata\/plate_(\d+)\.gcode$/;

// Bambu Studio and Orca both write the printer into project_settings.config,
// in a sliced project and an unsliced one alike (checked against real files
// from five vendors). That is what tells a Bambu .3mf from an AD5X one.
function isBambuSettings(json) {
  const text = [json && json.printer_model, json && json.printer_settings_id]
    .filter(v => typeof v === "string").join(" ").toLowerCase();
  return /bambu\s*lab/.test(text);
}

function parseSliceInfo(xml) {
  const out = { printerModelId: null, nozzle: null, filaments: [], prediction: null, weight: null };
  if (!xml) return out;
  const meta = (key) => {
    const m = new RegExp(`<metadata key="${key}" value="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
  };
  out.printerModelId = meta("printer_model_id");
  const nozzle = meta("nozzle_diameters");
  out.nozzle = nozzle ? Number(String(nozzle).split(/[,;\s]/)[0]) : null;
  const prediction = Number(meta("prediction"));
  out.prediction = Number.isFinite(prediction) ? prediction : null;
  const weight = Number(meta("weight"));
  out.weight = Number.isFinite(weight) ? weight : null;
  for (const m of xml.matchAll(/<filament\b([^>]*)\/>/g)) {
    const attr = (k) => { const a = new RegExp(`${k}="([^"]*)"`).exec(m[1]); return a ? a[1] : null; };
    out.filaments.push({
      id: Number(attr("id")) || out.filaments.length + 1,
      type: attr("type"),
      color: attr("color"),
      // Bambu's own filament id (GFA00 = PLA Basic, GFG00 = PETG Basic): what
      // the AMS trays report too, so the two can be matched on material rather
      // than colour alone.
      trayInfoIdx: attr("tray_info_idx"),
      usedG: Number(attr("used_g")) || null
    });
  }
  return out;
}

// One pass over the archive: everything the library row and the Send dialog
// need. Never throws for a damaged or unreadable file — the library still has
// to draw a row for it — so a failure comes back as `error`.
function read(file, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const info = {
    isBambu: false, sliced: false, plates: [], error: null,
    printerModelId: null, nozzle: null, filaments: [], prediction: null, weight: null,
    printerModel: null
  };
  try {
    withArchive(file, (fd, entries) => {
      const settingsEntry = entries.get("Metadata/project_settings.config");
      if (settingsEntry) {
        try {
          const json = JSON.parse(readEntry(fd, settingsEntry, maxBytes).toString("utf8"));
          info.isBambu = isBambuSettings(json);
          info.printerModel = (json && json.printer_model) || null;
        } catch { /* unreadable settings: not identifiable as Bambu */ }
      }
      info.plates = [...entries.keys()]
        .map(n => PLATE_GCODE_RE.exec(n)).filter(Boolean)
        .map(m => Number(m[1])).sort((a, b) => a - b);
      info.sliced = info.plates.length > 0;
      const sliceInfo = entries.get("Metadata/slice_info.config");
      if (sliceInfo) {
        try { Object.assign(info, parseSliceInfo(readEntry(fd, sliceInfo, maxBytes).toString("utf8"))); }
        catch { /* the row survives without it */ }
      }
    });
  } catch (e) {
    info.error = e.message;
  }
  return info;
}

// The plate's sliced gcode, as text, for parser.js. Deliberately the same
// parser every other file goes through: the header comments inside are the
// ordinary ones.
function plateGcode(file, plate = 1, { maxBytes = 64 * 1024 * 1024 } = {}) {
  return withArchive(file, (fd, entries) => {
    const entry = entries.get(`Metadata/plate_${plate}.gcode`);
    if (!entry) throw Object.assign(new Error(`This file has no sliced plate ${plate}`), { code: "ENOPLATE" });
    return readEntry(fd, entry, maxBytes).toString("utf8");
  });
}

// The picture Bambu Studio renders of the plate. Returns null when the file has
// none, which is not an error — the card just shows no thumbnail.
function plateThumbnail(file, plate = 1) {
  try {
    return withArchive(file, (fd, entries) => {
      for (const name of [`Metadata/plate_${plate}.png`, `Metadata/plate_${plate}_small.png`, "Metadata/plate_1.png"]) {
        const entry = entries.get(name);
        if (entry) return readEntry(fd, entry, 8 * 1024 * 1024);
      }
      return null;
    });
  } catch {
    return null;
  }
}

module.exports = { read, plateGcode, plateThumbnail, isBambuSettings, _internal: { readDirectory, parseSliceInfo } };

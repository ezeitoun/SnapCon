// parser.js — reads a sliced Snapmaker U1 gcode file and reports the FILAMENT
// the print actually needs.
//
// Key facts learned from real U1 gcode:
//  * The body uses T<n> where n is a LOGICAL palette index (0..N-1), NOT a
//    physical toolhead. The U1 has 4 physical heads and maps logical->physical
//    at print start (RFID match / Orca preprocessing).
//  * So the right answer is "which palette colors does this print use", and the
//    machine decides which of its 4 heads each lands in.

const SKIP = new Set([
  "G0","G1","G2","G3","G4","G17","G28","G29","G90","G91","G92",
  "M82","M83","M84","M104","M105","M106","M107","M109","M140","M190",
  "M201","M203","M204","M205","M220","M221","M73","M17","M18","M400","M412","M569","M593",
  "SET_VELOCITY_LIMIT","EXCLUDE_OBJECT_START","EXCLUDE_OBJECT_END"
]);

const CFG_RE = /^\s*;\s*([A-Za-z0-9_ %\[\]\(\)\/.-]+?)\s*=\s*(.*?)\s*$/;
const INTERESTING = /filament_colou?r|filament_type|filament_vendor|_map|mapping|initial_tool|initial_extruder/i;
const NOISE = /WIPE_START|WIPE_END|Change Tool|^[;\s]*[A-Za-z0-9+\/]{40,}={0,2}$/;

function splitAligned(s) {
  if (s == null) return [];
  let parts;
  if (s.includes(";")) parts = s.split(";");
  else if (s.split(",").length > 1) parts = s.split(",");
  else parts = [s];
  return parts.map(x => x.trim());
}
function firstKey(cfg, keys) { for (const k of keys) if (k in cfg) return cfg[k]; return undefined; }

// Full Spectrum detection. FS files blend/alternate physical filaments to
// create extra virtual colors, so they can legitimately use more logical
// colors than the 4 physical heads. Fingerprints in the config block:
//   ratdoux FullSpectrum : non-empty `mixed_filament_definitions`
//   Neotko feature pack  : pathblend_ / colorstitch / penultimate_multipass_ /
//                          interlayer_colormix_ keys
function detectFS(cfg) {
  const mixed = cfg["mixed_filament_definitions"];
  const ratdoux = mixed != null && !/^(\s*|""|\[\]|nil|null|0)$/i.test(String(mixed).trim());
  const neo = Object.keys(cfg).some(k =>
    /^(pathblend_|colorstitch|penultimate_multipass_|interlayer_colormix_)/.test(k));
  const fsFork = ratdoux ? "ratdoux" : (neo ? "neotko" : null);
  return { isFS: !!fsFork, fsFork };
}
function normHex(c) {
  if (!c) return null;
  let h = c.trim(); if (!h) return null;
  if (h[0] !== "#") h = "#" + h;
  if (/^#[0-9a-fA-F]{8}$/.test(h)) h = h.slice(0, 7);
  if (/^#[0-9a-fA-F]{6}$/.test(h) || /^#[0-9a-fA-F]{3}$/.test(h)) return h.toUpperCase();
  return null;
}

// Line-at-a-time parser, so callers can feed a whole string OR stream a huge
// file without ever holding it in memory: feed() every line, then result().
function makeParser({ scanBody = false } = {}) {
  const cfg = {};
  const cfgLines = [];
  const bodyUsed = new Set(); let bodyAny = false; const hist = {};

  function feed(line) {
    const m = line.match(CFG_RE);
    if (m) cfg[m[1].trim().toLowerCase()] = m[2];
    const t = line.trim();
    if (t.startsWith(";") && INTERESTING.test(t) && !NOISE.test(t) && cfgLines.length < 50) {
      cfgLines.push(t);
    }
    if (!scanBody) return;
    const code = line.split(";")[0].trim();
    if (!code) return;
    const tok = code.split(/\s+/)[0];
    const tm = tok.match(/^T(\d+)$/);
    if (tm) { bodyUsed.add(parseInt(tm[1], 10)); bodyAny = true; }
    if (!SKIP.has(tok)) hist[tok] = (hist[tok] || 0) + 1;
  }

  function result() {
    const colours = splitAligned(firstKey(cfg, ["filament_colour","filament_color","extruder_colour","extruder_color"]));
    const types   = splitAligned(firstKey(cfg, ["filament_type"]));
    const vendors = splitAligned(firstKey(cfg, ["filament_vendor"]));
    const weights = splitAligned(firstKey(cfg, ["filament used [g]","filament_used_g","filament used [grams]"]));

    // Prefer per-colour weights to decide what's used (a 0 means that colour
    // isn't printed). Only fall back to the body T#-scan when weights are
    // missing AND the body was scanned.
    const wNums = weights.map(w => parseFloat(w));
    const haveWeights = wNums.some(n => !isNaN(n));
    let used = new Set(), any = false, cmdHist = [];
    if (haveWeights) {
      wNums.forEach((n, i) => { if (!isNaN(n) && n > 0) { used.add(i); any = true; } });
    } else if (scanBody) {
      used = bodyUsed; any = bodyAny;
      cmdHist = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 25)
        .map(([k, v]) => String(v).padStart(7) + "  " + k);
    }

    const paletteCount = Math.max(colours.length, types.length, any ? Math.max(...used) + 1 : 0, 1);

    const palette = [];
    for (let i = 0; i < paletteCount; i++) {
      const hex = normHex(colours[i]);
      const type = (types[i] || "").trim();
      const vendor = (vendors[i] || "").trim();
      const wt = (weights[i] || "").trim();
      const present = !!(hex || type);
      const isUsed = any ? used.has(i) : present;
      palette.push({ i, hex, type, vendor, wt, present, used: isUsed });
    }

    const usedIdx = palette.filter(s => s.used).map(s => s.i);

    const ptime = firstKey(cfg, ["estimated printing time (normal mode)","model printing time","total estimated time","estimated printing time"]);
    let totalWt = 0, haveWt = false;
    for (const w of weights) { const n = parseFloat(w); if (!isNaN(n)) { totalWt += n; haveWt = true; } }
    const meta = [];
    if (ptime) meta.push(ptime.trim());
    if (haveWt) meta.push(totalWt.toFixed(1) + " g");

    const keys = []
      .concat(["=== logical filaments used ===", any ? usedIdx.join(", ") : "(could not determine)", ""])
      .concat(["=== filament / mapping config lines ===", ...(cfgLines.length ? cfgLines : ["(none captured)"]), ""])
      .concat(cmdHist.length ? ["=== top commands (count  token) ===", ...cmdHist] : []);

    return {
      palette, usedIdx, paletteCount,
      physicalHeads: 4,
      ...detectFS(cfg),
      printerModel: cfg["printer_model"] || null,
      meta, anyTC: any, noColors: !colours.length,
      keys, allKeys: Object.keys(cfg)
    };
  }

  return { feed, result };
}

function parseGcodeMap(text, opts = {}) {
  const p = makeParser(opts);
  for (const line of text.split(/\r?\n/)) p.feed(line);
  return p.result();
}

// Same output as parseGcodeMap, but from an async line source (e.g. readline
// over a file stream) — for files too big to hold as one string.
async function parseGcodeMapLines(lines, opts = {}) {
  const p = makeParser(opts);
  for await (const line of lines) p.feed(line);
  return p.result();
}

module.exports = { parseGcodeMap, parseGcodeMapLines, normHex };

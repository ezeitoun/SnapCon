// connectors/bambu-preview.js — the job preview (the plate image Bambu Studio
// renders into every sliced .3mf) for a Bambu Lab printer, read over FTPS.
//
// Where the file is: a print sent from Bambu Studio / Handy / MakerWorld is
// kept as "<job name>.3mf" (or ".gcode.3mf") in /cache/ or the storage root.
// On H2 firmware the printer's INTERNAL storage is not exposed over FTP —
// "Store sent files on external storage" has to be on in the printer's print
// options, with a USB drive / SD card inserted, for the file to be readable.
// Without it this reports "not found" and the card keeps its "—".
//
// How little is read: the .3mf is a ZIP, so only its tail (central directory)
// and the one Metadata/plate_<n>.png entry are fetched with ranged reads
// (FTP REST). Only if the server refuses offsets is the whole file read, up
// to a size limit. Results are cached per job, and misses are remembered for
// a while, because the fleet card may ask again every time it re-renders.
const { readCentralDirectory, readEntry } = require("./zip-reader");

const CACHE_MAX = 64;
const MISS_TTL_MS = 60 * 1000;       // "no such file" — the job's file will not appear by itself
const ERROR_BACKOFF_MS = 15 * 1000;   // a failed attempt
const WHOLE_FILE_MAX = 128 * 1024 * 1024;
const SEARCH_DIRS = ["/cache/", "/"];

const hits = new Map();    // key -> { png }
const misses = new Map();  // key -> expiry
const inflight = new Map();// key -> Promise
const locks = new Map();   // printer key -> Promise chain (one FTP session per printer at a time)

function remember(key, png) {
  hits.delete(key);
  hits.set(key, { png });
  while (hits.size > CACHE_MAX) hits.delete(hits.keys().next().value);
}

// The .3mf names a job can be stored under, most likely first.
function candidateNames(jobName, gcodeFile) {
  const out = [];
  const add = (n) => { if (n && !/[\r\n\0]/.test(n) && !out.includes(n)) out.push(n); };
  const job = String(jobName || "").trim();
  if (job) {
    if (/\.3mf$/i.test(job)) add(job);
    else { add(job + ".gcode.3mf"); add(job + ".3mf"); }
  }
  const g = String(gcodeFile || "").trim();
  // "/data/Metadata/plate_1.gcode" is the printer's RAM disk, not a file name.
  if (g && !/^\/?data\//i.test(g)) {
    const base = g.slice(g.lastIndexOf("/") + 1);
    if (/\.3mf$/i.test(base)) add(base);
    else if (base) { add(base + ".3mf"); add(base.replace(/\.gcode$/i, "") + ".gcode.3mf"); }
  }
  return out;
}

// Which plate the job is printing: "/data/Metadata/plate_3.gcode" -> 3.
function plateIndex(gcodeFile) {
  const m = /plate_(\d+)\.gcode/i.exec(String(gcodeFile || ""));
  return m ? Number(m[1]) : 1;
}

function pickPreview(entries, plate) {
  const byName = new Map(entries.map(e => [e.name, e]));
  return byName.get(`Metadata/plate_${plate}.png`) || byName.get("Metadata/plate_1.png")
    || entries.find(e => /^Metadata\/plate_\d+\.png$/i.test(e.name)) || null;
}

async function locate(ftp, names) {
  let sizeSupported = true;
  for (const dir of SEARCH_DIRS) {
    for (const name of names) {
      if (!sizeSupported) break;
      try {
        const size = await ftp.size(dir + name);
        if (size != null) return { path: dir + name, size };
      } catch (e) {
        if (e.code === "ENOSIZE") sizeSupported = false; else throw e;
      }
    }
  }
  if (sizeSupported) return null;
  // No SIZE: list the directories instead, then read the whole file.
  for (const dir of SEARCH_DIRS) {
    let listing = [];
    try { listing = await ftp.list(dir); } catch { continue; }
    const hit = names.find(n => listing.includes(n));
    if (hit) return { path: dir + hit, size: null };
  }
  return null;
}

async function extractPreview(ftp, file, plate) {
  let whole = null;
  const readWhole = async () => {
    if (!whole) whole = await ftp.read(file.path, 0, Infinity, WHOLE_FILE_MAX);
    return whole;
  };
  let ranged = file.size != null;
  const read = async (offset, length) => {
    if (ranged) {
      try { return await ftp.read(file.path, offset, length); }
      catch (e) { if (e.code !== "ENOREST") throw e; ranged = false; }
    }
    const all = await readWhole();
    return all.subarray(offset, offset + length);
  };
  const size = file.size != null ? file.size : (await readWhole()).length;
  const entries = await readCentralDirectory(read, size);
  const entry = pickPreview(entries, plate);
  if (!entry) return null;
  return readEntry(read, entry);
}

// getPreview({ printerKey, jobName, gcodeFile, connect }) -> PNG Buffer or null.
// `connect()` returns a logged-in FtpsClient (the connector owns host,
// credentials and TLS policy).
//
// The file is located on every call (one short FTP session: login + SIZE) and
// a cached image is reused only for the same path AND size — a job re-sliced
// under the same name is a different file and gets its own preview. The
// browser asks once per job (its URL carries a per-job token), so this costs
// one lookup per new job or page load, not one per poll.
async function getPreview({ printerKey, jobName, gcodeFile, connect }) {
  const names = candidateNames(jobName, gcodeFile);
  if (!names.length) return null;
  const plate = plateIndex(gcodeFile);
  const missKey = printerKey + "|" + names[0] + "|" + plate;
  const miss = misses.get(missKey);
  if (miss && miss > Date.now()) return null;
  if (inflight.has(missKey)) return inflight.get(missKey);
  const job = (async () => {
    // One FTP session per printer at a time — a camera-grid of cards asking at
    // once must not open a burst of sessions against one printer.
    const prev = locks.get(printerKey) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    const chain = prev.catch(() => {}).then(() => mine);
    locks.set(printerKey, chain);
    await prev.catch(() => {});
    let ftp = null;
    try {
      ftp = await connect();
      const file = await locate(ftp, names);
      if (!file) { misses.set(missKey, Date.now() + MISS_TTL_MS); return null; }
      const hitKey = printerKey + "|" + file.path + "|" + (file.size == null ? "?" : file.size) + "|" + plate;
      const hit = hits.get(hitKey);
      if (hit && file.size != null) return hit.png;
      const png = await extractPreview(ftp, file, plate);
      if (png) remember(hitKey, png); else misses.set(missKey, Date.now() + MISS_TTL_MS);
      return png;
    } catch (e) {
      // A transient failure (printer busy, network blip) is only held off
      // briefly — long enough to absorb the card's own retries, not for minutes.
      misses.set(missKey, Date.now() + ERROR_BACKOFF_MS);
      throw e;
    } finally {
      if (ftp) ftp.close();
      release();
      if (locks.get(printerKey) === chain) locks.delete(printerKey);
    }
  })();
  inflight.set(missKey, job);
  try { return await job; } finally { inflight.delete(missKey); }
}

module.exports = { getPreview, _internal: { candidateNames, plateIndex, pickPreview, hits, misses, clear() { hits.clear(); misses.clear(); inflight.clear(); locks.clear(); } } };

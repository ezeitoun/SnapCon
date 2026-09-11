// connectors/zip-reader.js — pull ONE entry out of a ZIP archive through a
// random-access `read(offset, length)` function, touching as few bytes as
// possible: the end-of-central-directory record from the tail, the central
// directory, then the one local entry. A Bambu Lab .3mf is a ZIP; its
// preview image is a few hundred KB inside an archive that can be tens of MB,
// and on the printer every read is an FTPS transfer.
//
// Stored (0) and deflated (8) entries are supported, plus ZIP64 offsets —
// that is everything a slicer writes into a 3MF.
const zlib = require("zlib");

const SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_LOC64 = 0x07064b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
const TAIL = 65536 + 22 + 20 + 56; // max comment + EOCD + ZIP64 locator + ZIP64 EOCD

async function readCentralDirectory(read, size) {
  const tailStart = Math.max(0, size - TAIL);
  const tail = await read(tailStart, size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== SIG_LOC64) throw new Error("ZIP64 archive without a locator");
    const eocd64Offset = Number(tail.readBigUInt64LE(loc + 8));
    const rec = eocd64Offset >= tailStart ? tail.subarray(eocd64Offset - tailStart, eocd64Offset - tailStart + 56) : await read(eocd64Offset, 56);
    if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error("bad ZIP64 end-of-central-directory record");
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > size) throw new Error("ZIP central directory lies outside the file");
  const cd = cdOffset >= tailStart ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize) : await read(cdOffset, cdSize);
  const entries = [];
  let o = 0;
  for (let n = 0; n < count && o + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(o) !== SIG_CEN) break;
    const method = cd.readUInt16LE(o + 10);
    let compSize = cd.readUInt32LE(o + 20), uncompSize = cd.readUInt32LE(o + 24);
    const nameLen = cd.readUInt16LE(o + 28), extraLen = cd.readUInt16LE(o + 30), commentLen = cd.readUInt16LE(o + 32);
    let localOffset = cd.readUInt32LE(o + 42);
    const name = cd.subarray(o + 46, o + 46 + nameLen).toString("utf8");
    const extra = cd.subarray(o + 46 + nameLen, o + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e), len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) { // ZIP64: only the fields that overflowed are present, in this order
        let p = e + 4;
        if (uncompSize === 0xffffffff) { uncompSize = Number(extra.readBigUInt64LE(p)); p += 8; }
        if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(p)); p += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(p)); }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compSize, uncompSize, localOffset });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(read, entry, maxBytes = 32 * 1024 * 1024) {
  if (entry.uncompSize > maxBytes || entry.compSize > maxBytes) throw new Error("ZIP entry too large");
  // The local header's own name/extra lengths can differ from the central
  // directory's, so read it first, then the data it points at.
  const head = await read(entry.localOffset, 30);
  if (head.readUInt32LE(0) !== SIG_LOC) throw new Error("bad ZIP local header");
  const dataStart = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const data = entry.compSize ? await read(dataStart, entry.compSize) : Buffer.alloc(0);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new Error("unsupported ZIP compression method " + entry.method);
}

module.exports = { readCentralDirectory, readEntry };

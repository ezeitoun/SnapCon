// connectors/firmwareImage.js — what can be established about a firmware file
// BEFORE it is sent to a printer, and — just as importantly — what cannot.
//
// A U1 upgrade image is a standard Rockchip RKFW container behind a short
// vendor prefix. Verified against U1_1.6.0.267_20260815150420_upgrade.bin:
//
//   0x00   192 opaque bytes (vendor prefix; contents unknown, not parsed)
//   0xC0   "RKFW" + a 102-byte header: build time, chip, and the offsets of
//          the loader and image sections, all relative to the RKFW header
//   …      loader ("LDR " magic) then the image itself
//   end    a trailer the header does not account for (~94 KB in that sample),
//          carrying a build id and an MD5-shaped digest
//
// WHAT THIS PROVES: that a file is an RKFW container for the chip the U1
// actually uses (RK3562, stored in the header as ASCII "2653"), that its
// internal offsets fit inside the file, and what version string the payload
// carries. Those are facts read out of the bytes.
//
// WHAT THIS DOES NOT PROVE: that the image belongs to a U1 rather than some
// other Snapmaker product on the same SoC. `product_code` and `hwver` — the
// fields a printer reports about itself — appear NOWHERE in plaintext in a
// 254 MB image (searched in full). The rootfs is compressed, so a model
// discriminator may exist inside it, but reaching it means unpacking a
// squashfs, and with a single firmware sample there is nothing to diff
// against to find one. The filename prefix ("U1_…") is therefore a WARNING
// only: filenames are renameable, and callers must not present a filename
// match as proof of compatibility.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RKFW_MAGIC = "RKFW";
// The chip field is four ASCII digits stored reversed: "2653" is RK3562.
const EXPECTED_CHIP = "3562";
// The RKFW magic sits behind a vendor prefix rather than at offset 0, so it is
// searched for instead of assumed. Bounded: a real image has it at 0xC0.
const MAGIC_SEARCH_BYTES = 4096;
// The version string lives inside the payload (~22.6 MB into the sample), well
// before the rootfs. Bounded so a 254 MB file is never read in full.
const DEFAULT_SCAN_BYTES = 32 * 1024 * 1024;

// <product>_<version>_<buildtime>_upgrade.bin, e.g.
// U1_1.6.0.267_20260815150420_upgrade.bin — the product half matches what
// system.get_device_info reports as product_code.
const NAME_RE = /^([A-Za-z0-9]+)_(\d+(?:\.\d+){2,3})_(\d{14})_upgrade\.bin$/i;

function parseFilename(basename) {
  const m = NAME_RE.exec(basename);
  return m ? { product: m[1], version: m[2], buildTime: m[3] } : null;
}

function readChunk(fd, offset, length, fileSize) {
  const len = Math.max(0, Math.min(length, fileSize - offset));
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, offset);
  return buf;
}

// Returns { hardFail: [...], warnings: [...], … }. hardFail non-empty means
// the file is not a firmware image we can recognise — the caller must refuse.
function inspectFirmwareImage(filePath, { scanBytes = DEFAULT_SCAN_BYTES } = {}) {
  const out = {
    file: path.basename(filePath),
    size: 0,
    container: null, chip: null, chipOk: false,
    headerConsistent: false,
    buildTime: null, version: null,
    filename: null,
    hardFail: [], warnings: [],
  };

  let stat;
  try { stat = fs.statSync(filePath); }
  catch { out.hardFail.push("The firmware file could not be read"); return out; }
  if (!stat.isFile()) { out.hardFail.push("Not a file"); return out; }
  out.size = stat.size;

  out.filename = parseFilename(out.file);
  if (!out.filename) {
    out.warnings.push("The file name is not in Snapmaker's usual "
      + "<product>_<version>_<build>_upgrade.bin form, so the model it is meant for cannot be read from it");
  }

  // Everything below is disk I/O, and a firmware folder is very often a
  // network share (SMB/UNC) that can disappear between the stat above and
  // the reads below. This function's contract is that it RETURNS its
  // verdict, so an unreadable file has to come back as a hard failure —
  // letting it throw turns a routine "the share dropped" into a 500 that
  // the caller can only report as an unexplained error.
  let fd;
  try { fd = fs.openSync(filePath, "r"); }
  catch (err) { out.hardFail.push("The firmware file could not be opened: " + err.message); return out; }
  try {
    const head = readChunk(fd, 0, MAGIC_SEARCH_BYTES, stat.size);
    const rk = head.indexOf(RKFW_MAGIC);
    if (rk < 0) {
      out.hardFail.push("Not a Rockchip firmware image (no RKFW container found)");
      return out;
    }
    out.container = RKFW_MAGIC;
    out.rkfwOffset = rk;

    const h = readChunk(fd, rk, 102, stat.size);
    if (h.length < 41) { out.hardFail.push("The RKFW header is truncated"); return out; }

    const headerSize = h.readUInt16LE(4);
    out.headerBuildTime = String(h.readUInt16LE(14))
      + String(h[16]).padStart(2, "0") + String(h[17]).padStart(2, "0")
      + String(h[18]).padStart(2, "0") + String(h[19]).padStart(2, "0") + String(h[20]).padStart(2, "0");

    // Stored reversed; report it the way people write it.
    const chipRaw = h.subarray(21, 25).toString("latin1");
    const chipDigits = Buffer.from(h.subarray(21, 25)).reverse().toString("latin1");
    out.chip = /^[0-9A-Za-z]{4}$/.test(chipDigits) ? "RK" + chipDigits : null;
    out.chipOk = chipDigits === EXPECTED_CHIP;
    if (!out.chipOk) {
      out.hardFail.push("Built for a different chip (" + (out.chip || JSON.stringify(chipRaw))
        + ") — the Snapmaker U1 uses RK" + EXPECTED_CHIP);
    }

    const loaderOffset = h.readUInt32LE(25), loaderSize = h.readUInt32LE(29);
    const imageOffset = h.readUInt32LE(33), imageSize = h.readUInt32LE(37);
    out.sections = { headerSize, loaderOffset, loaderSize, imageOffset, imageSize };

    // Every declared region must fit inside the file. This is what catches a
    // truncated download, which is the realistic way a "valid-looking" file
    // turns out to be half an image.
    const loaderEnd = rk + loaderOffset + loaderSize;
    const imageEnd = rk + imageOffset + imageSize;
    const sane = headerSize >= 41 && loaderOffset >= headerSize
      && loaderSize > 0 && imageSize > 0
      && loaderEnd <= stat.size && imageEnd <= stat.size
      && imageOffset >= loaderOffset + loaderSize;
    out.headerConsistent = sane;
    if (!sane) {
      out.hardFail.push("The image header does not fit the file — it is truncated or corrupt "
        + "(declares " + imageEnd.toLocaleString() + " bytes, file is " + stat.size.toLocaleString() + ")");
    }

    // Version, from the payload. Anchored on the BUILD_NUMBER= marker rather
    // than pattern-matching for something version-shaped: the loader carries
    // ASN.1 OIDs (1.2.840.10045…) and library versions (2.36.1.20210621) that
    // look exactly like a four-part version and appear far earlier in the file.
    // Bounded scan; the marker sits ~22.6 MB in, well before the rootfs, so a
    // 254 MB file is never read in full.
    const scan = readChunk(fd, 0, Math.min(scanBytes, stat.size), stat.size);
    const anchor = scan.indexOf("BUILD_NUMBER=");
    if (anchor >= 0) {
      const win = scan.subarray(anchor, Math.min(anchor + 200, scan.length)).toString("latin1");
      const build = /BUILD_NUMBER=(\d+)/.exec(win);
      const stamp = /(\d{14})/.exec(win);
      const ver = /(\d+\.\d+\.\d+\.\d+)/.exec(win);
      if (ver) out.version = ver[1];
      if (stamp) out.buildTime = stamp[1];
      // The version's last component IS the build number — a cheap internal
      // consistency check on the two values we just read out of the payload.
      if (build && out.version && !out.version.endsWith("." + build[1])) {
        out.warnings.push("The image's version (" + out.version + ") and build number ("
          + build[1] + ") disagree — the version could not be read reliably");
        out.version = null;
      }
    }
    if (!out.version) {
      out.warnings.push("No version string was found inside the image, so its contents could not be "
        + "cross-checked against the file name");
    } else if (out.filename && out.filename.version !== out.version) {
      out.warnings.push("The file name says " + out.filename.version
        + " but the image contains " + out.version + " — the file may have been renamed");
    } else if (out.filename && out.buildTime && out.filename.buildTime !== out.buildTime) {
      out.warnings.push("The file name's build stamp (" + out.filename.buildTime
        + ") does not match the image's (" + out.buildTime + ")");
    }
  } catch (err) {
    out.hardFail.push("The firmware file could not be read: " + err.message);
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone with the share */ }
  }

  return out;
}

// Compare an inspection against ONE printer's own self-report.
// `productCode` is what system.get_device_info returns (e.g. "U1").
//
// Deliberately a warning, never a hard failure: the match is made against the
// FILE NAME, which proves nothing about the payload. See this module's header.
function compatibilityFor(inspection, productCode) {
  const warnings = [...inspection.warnings];
  const named = inspection.filename && inspection.filename.product;
  if (named && productCode && named.toLowerCase() !== String(productCode).toLowerCase()) {
    warnings.push("The file name says this is firmware for " + named
      + ", but this printer reports itself as " + productCode
      + ". The image itself does not state which model it is for — check the file before continuing.");
  }
  return {
    hardFail: inspection.hardFail,
    warnings,
    // Never "compatible: true" — nothing here can establish that.
    filenameProductMatches: !!(named && productCode && named.toLowerCase() === String(productCode).toLowerCase()),
  };
}

// The identifier a printer uses for this exact build.
//
// A U1 reports its firmware at two granularities and they are easy to
// confuse — this is the mistake that had SnapCon offering to re-flash twelve
// printers that were already running the image:
//
//   product_info.firmware_version     "1.6.0"                     truncated
//   system.get_device_info.version    "1.6.0"                     truncated
//   printer/info software_version     "1.6.0.267_20260815150420"  the build
//   system.get_device_info.fullversion "1.6.0.267_20260815150420" the build
//
// The image states the same thing in two fields, and joining them gives a
// string identical to what the printer reports. Comparing anything shorter
// compares a prefix, and a prefix match is not "the same firmware".
//
// null when the payload does not state both halves — pre-1.6.0 U1 images
// carry no BUILD_NUMBER marker at all. Callers must treat that as "cannot
// tell" rather than falling back to the file name, which is renameable and
// would silently skip a printer that genuinely needs updating.
function firmwareBuildId(info) {
  return (info && info.version && info.buildTime) ? info.version + "_" + info.buildTime : null;
}

// The version half of whatever a printer reported, for display and for the
// weaker comparison available when an image states no build stamp.
function firmwareVersionPart(reported) {
  return reported ? String(reported).split("_")[0] : null;
}

module.exports = { inspectFirmwareImage, compatibilityFor, parseFilename,
                   firmwareBuildId, firmwareVersionPart, EXPECTED_CHIP };

// test/firmwareImage.test.js — what the pre-flight inspection may and may not
// claim about a firmware file.
//
// The distinction this whole module exists to hold is the one these tests pin:
//
//   HARD FAIL  — facts read out of the file's own bytes: it is not an RKFW
//                container, it is built for a different chip, or its declared
//                sections do not fit inside it (a truncated download).
//   WARNING    — everything about the FILE NAME. A name is renameable and says
//                nothing about the payload. `product_code`/`hwver` appear
//                nowhere in plaintext in a real 254 MB image, so nothing here
//                can establish that an image belongs to a U1 rather than to
//                another Snapmaker product on the same SoC.
//
// A test that let a filename check become fatal, or let a filename match be
// reported as proven compatibility, would be the bug.
//
// The fixtures are synthesised rather than sliced from a real 254 MB image:
// the header layout is fully specified (see connectors/firmwareImage.js), and
// a synthetic image can be made wrong in one specific way at a time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectFirmwareImage, compatibilityFor, parseFilename, EXPECTED_CHIP } =
  require("../connectors/firmwareImage");

const VENDOR_PREFIX = 192;    // the real container's RKFW magic sits at 0xC0
const HEADER_SIZE = 102;

let DIR;
test.before(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-fwimg-")); });

// Builds a well-formed RKFW container, then lets a test break exactly one thing.
function buildImage({
  name = "U1_1.6.0.267_20260815150420_upgrade.bin",
  magic = "RKFW",
  chip = EXPECTED_CHIP,          // "3562"; stored reversed
  loaderSize = 512,
  imageSize = 4096,
  imageSizeDeclared = null,       // declare more than is present → truncated
  payload = "BUILD_NUMBER=267\nVERSION=1.6.0.267\nBUILD_TIME=20260815150420\n",
  payloadAt = null,               // absolute offset for the payload marker
  decoys = true,
} = {}) {
  const loaderOffset = HEADER_SIZE;
  const imageOffset = loaderOffset + loaderSize;
  const total = VENDOR_PREFIX + imageOffset + imageSize;
  const buf = Buffer.alloc(total, 0x00);

  const h = VENDOR_PREFIX;
  buf.write(magic, h, "latin1");
  buf.writeUInt16LE(HEADER_SIZE, h + 4);
  buf.writeUInt16LE(2026, h + 14);
  buf[h + 16] = 8; buf[h + 17] = 15; buf[h + 18] = 15; buf[h + 19] = 5; buf[h + 20] = 0;
  // The chip field is four ASCII digits stored reversed.
  buf.write([...chip].reverse().join(""), h + 21, "latin1");
  buf.writeUInt32LE(loaderOffset, h + 25);
  buf.writeUInt32LE(loaderSize, h + 29);
  buf.writeUInt32LE(imageOffset, h + 33);
  buf.writeUInt32LE(imageSizeDeclared === null ? imageSize : imageSizeDeclared, h + 37);
  buf.write("LDR ", h + loaderOffset, "latin1");

  // Version-shaped strings that are NOT the version — an ASN.1 OID and a
  // library version, both of which appear in the real loader well before the
  // build marker. These are the reason the scan is anchored on BUILD_NUMBER=.
  if (decoys) buf.write("1.2.840.10045.3.1.7 OpenSSL 2.36.1.20210621", h + loaderOffset + 8, "latin1");

  buf.write(payload, payloadAt === null ? h + imageOffset + 16 : payloadAt, "latin1");

  const file = path.join(DIR, name);
  fs.writeFileSync(file, buf);
  return file;
}

// ---------------------------------------------------------------------------
// What the bytes can establish — hard failures
// ---------------------------------------------------------------------------

test("a well-formed image passes with no hard failures", () => {
  const r = inspectFirmwareImage(buildImage());
  assert.deepEqual(r.hardFail, []);
  assert.equal(r.container, "RKFW");
  assert.equal(r.chip, "RK3562");
  assert.equal(r.chipOk, true);
  assert.equal(r.headerConsistent, true);
});

test("a file that is not a Rockchip container is refused", () => {
  const r = inspectFirmwareImage(buildImage({ magic: "ZZZZ", name: "not-firmware.bin" }));
  assert.match(r.hardFail.join(" "), /not a Rockchip firmware image/i);
  assert.equal(r.container, null);
});

test("an image built for a different chip is refused", () => {
  const r = inspectFirmwareImage(buildImage({ chip: "3399", name: "U1_1.0.0.1_20260101000000_upgrade.bin" }));
  assert.equal(r.chipOk, false);
  assert.equal(r.chip, "RK3399");
  assert.match(r.hardFail.join(" "), /different chip/i);
  assert.match(r.hardFail.join(" "), /RK3562/);
});

test("a truncated download is refused — the header must fit the file", () => {
  // The classic way a "valid-looking" file turns out to be half an image: the
  // header says the payload is far larger than the bytes on disk.
  const r = inspectFirmwareImage(buildImage({ imageSize: 4096, imageSizeDeclared: 90_000_000 }));
  assert.equal(r.headerConsistent, false);
  assert.match(r.hardFail.join(" "), /truncated or corrupt/i);
});

test("a missing file is a hard failure, not an exception", () => {
  const r = inspectFirmwareImage(path.join(DIR, "does-not-exist.bin"));
  assert.equal(r.hardFail.length, 1);
  assert.match(r.hardFail[0], /could not be read/i);
});

test("a directory is not a firmware image", () => {
  const r = inspectFirmwareImage(DIR);
  assert.match(r.hardFail.join(" "), /Not a file/);
});

test("a file that vanishes between the stat and the read is a hard failure, not a throw", () => {
  // A firmware folder is very often an SMB/UNC share, which can drop between
  // one syscall and the next. This function's contract is that it RETURNS its
  // verdict — a throw here becomes an HTML 500, which the client then cannot
  // tell apart from an old server with no such route at all.
  const file = buildImage({ name: "vanishing.bin" });
  const realOpen = fs.openSync;
  fs.openSync = () => { const e = new Error("ENOENT: no such file or directory"); e.code = "ENOENT"; throw e; };
  try {
    const r = inspectFirmwareImage(file);
    assert.match(r.hardFail.join(" "), /could not be opened/i);
  } finally { fs.openSync = realOpen; }
});

test("a read that fails mid-file is a hard failure, and the handle is still closed", () => {
  const file = buildImage({ name: "half-read.bin" });
  const realRead = fs.readSync;
  let closed = false;
  const realClose = fs.closeSync;
  fs.closeSync = fd => { closed = true; return realClose(fd); };
  fs.readSync = () => { throw new Error("EIO: i/o error, read"); };
  try {
    const r = inspectFirmwareImage(file);
    assert.match(r.hardFail.join(" "), /could not be read/i);
    assert.equal(closed, true, "the file handle is released even on the error path");
  } finally { fs.readSync = realRead; fs.closeSync = realClose; }
});

// ---------------------------------------------------------------------------
// The version, read from the payload rather than guessed
// ---------------------------------------------------------------------------

test("the version comes from the image's own build marker, not from a version-shaped decoy", () => {
  const r = inspectFirmwareImage(buildImage());
  assert.equal(r.version, "1.6.0.267");
  assert.equal(r.buildTime, "20260815150420");
  // The decoys sit EARLIER in the file than the real marker; a scan that
  // pattern-matched for "four numbers with dots" would have picked one up.
  assert.notEqual(r.version, "1.2.840.10045");
  assert.notEqual(r.version, "2.36.1.20210621");
});

test("a version that disagrees with its own build number is discarded, not reported", () => {
  const r = inspectFirmwareImage(buildImage({
    payload: "BUILD_NUMBER=999\nVERSION=1.6.0.267\nBUILD_TIME=20260815150420\n",
  }));
  assert.equal(r.version, null, "an unreliable reading is dropped rather than shown");
  assert.match(r.warnings.join(" "), /could not be read reliably/i);
});

test("no version in the payload is a warning, never a hard failure", () => {
  const r = inspectFirmwareImage(buildImage({ payload: "no build marker here\n" }));
  assert.deepEqual(r.hardFail, []);
  assert.equal(r.version, null);
  assert.match(r.warnings.join(" "), /No version string was found/i);
});

test("the payload scan is bounded — a 254 MB image is never read in full", () => {
  // Same file, inspected with a scan window that stops before the marker.
  const file = buildImage();
  const full = inspectFirmwareImage(file);
  const clipped = inspectFirmwareImage(file, { scanBytes: 256 });
  assert.equal(full.version, "1.6.0.267");
  assert.equal(clipped.version, null, "the scan really stops where it says it does");
  assert.deepEqual(clipped.hardFail, [], "and a short scan is not a failure");
});

// ---------------------------------------------------------------------------
// The file name — a warning, and only ever a warning
// ---------------------------------------------------------------------------

test("a name/payload version mismatch is a warning, and the file is still usable", () => {
  const r = inspectFirmwareImage(buildImage({ name: "U1_9.9.9.9_20260815150420_upgrade.bin" }));
  assert.deepEqual(r.hardFail, [], "a renamed file is not a corrupt file");
  assert.match(r.warnings.join(" "), /file name says 9\.9\.9\.9 but the image contains 1\.6\.0\.267/i);
});

test("an unrecognised name shape is a warning that says what cannot be known", () => {
  const r = inspectFirmwareImage(buildImage({ name: "firmware.bin" }));
  assert.deepEqual(r.hardFail, []);
  assert.equal(r.filename, null);
  assert.match(r.warnings.join(" "), /the model it is meant for cannot be read from it/i);
});

test("parseFilename reads Snapmaker's naming convention, and nothing looser", () => {
  assert.deepEqual(parseFilename("U1_1.6.0.267_20260815150420_upgrade.bin"),
    { product: "U1", version: "1.6.0.267", buildTime: "20260815150420" });
  assert.equal(parseFilename("U1_1.6.0.267_upgrade.bin"), null);
  assert.equal(parseFilename("U1_1.6.0.267_20260815150420.bin"), null);
  assert.equal(parseFilename("upgrade.bin"), null);
});

test("a name/product mismatch warns, and is never a hard failure", () => {
  const r = inspectFirmwareImage(buildImage({ name: "A350_1.6.0.267_20260815150420_upgrade.bin" }));
  const c = compatibilityFor(r, "U1");
  assert.deepEqual(c.hardFail, [], "a name is not evidence about the payload");
  assert.match(c.warnings.join(" "), /file name says this is firmware for A350/i);
  assert.match(c.warnings.join(" "), /does not state which model it is for/i);
  assert.equal(c.filenameProductMatches, false);
});

test("a name/product MATCH is never reported as proven compatibility", () => {
  const r = inspectFirmwareImage(buildImage());
  const c = compatibilityFor(r, "U1");
  assert.equal(c.filenameProductMatches, true, "the name matches — which is all this says");
  // The one property that must hold: no field claims the image was verified
  // against this printer, because nothing here can establish that.
  assert.equal("compatible" in c, false);
  assert.equal("verified" in c, false);
  assert.deepEqual(Object.keys(c).sort(), ["filenameProductMatches", "hardFail", "warnings"]);
});

test("the module documents what it cannot prove, where a future reader will see it", () => {
  // This is a claim about the software's honesty, so it is worth a tripwire:
  // if someone strengthens the model check without new evidence, this fails.
  const src = fs.readFileSync(path.join(__dirname, "..", "connectors", "firmwareImage.js"), "utf8");
  assert.match(src, /WHAT THIS DOES NOT PROVE/);
  assert.match(src, /appear NOWHERE in plaintext/);
  // wrapped across comment lines in the source, so match across the wrap
  // wrapped across two comment lines in the source, so match across the wrap
  assert.match(src, /must not present a filename\s*(?:\/\/\s*)?match as proof of compatibility/);
  assert.match(src, /Never "compatible: true"/);
});

// ---------------------------------------------------------------------------
// The server refuses a hard failure before any printer is touched
// ---------------------------------------------------------------------------

test("a hard failure stops the request; a warning travels with it", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/firmware-deploy"'),
                               serverSrc.indexOf('app.get("/api/firmware-status"'));
  // Inspected once, before the per-printer loop — a bad image is not something
  // to discover on printer four of six.
  const inspectIdx = route.indexOf("firmwareImage.inspectFirmwareImage(");
  const loopIdx = route.indexOf("for (const ref of wanted)");
  assert.ok(inspectIdx > 0 && inspectIdx < loopIdx, "the image is judged before any printer is");
  assert.match(route, /if \(image\.hardFail\.length\) return res\.status\(400\)/);
  assert.match(route, /warnings: image\.warnings/);
  // The warnings must NOT be treated as a refusal.
  assert.equal(/image\.warnings\.length\) return res\.status/.test(route), false);
});

// test/firmwareProgress.test.js — the upload was rewritten to report real byte
// progress, and this proves the rewrite changed only the reporting.
//
// The old path was `fetch` + `openAsBlob`, which streams but exposes no
// progress hook at all — a ~250 MB transfer with no visible movement is
// indistinguishable from a hang. The new path is http-utils' uploadWithProgress,
// the same uploader every print already uses.
//
// Swapping the transport is exactly the kind of change that quietly moves a
// file somewhere else, so these tests are behavioural, against the mock printer
// (test/helpers/mockU1.js), and assert on what actually reached the wire:
//
//   * the image still lands in the printer's `gcodes` root
//   * the absolute path handed to system.upgrade is byte-identical
//   * progress reaches sent === total, once, for both phases
//   * the MD5 gate still refuses to flash a file that came back different
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const zlib = require("node:zlib");
const { startMockU1 } = require("./helpers/mockU1");
const u1fw = require("../connectors/snapmaker-u1-firmware");

// Big enough to arrive as several chunks, so a progress callback that only
// fires once would be visible as such.
const IMAGE = Buffer.alloc(700 * 1024).map((_, i) => (i * 31) & 0xff);
let tmpFile;

test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-fw-progress-"));
  tmpFile = path.join(dir, "fw.bin");
  fs.writeFileSync(tmpFile, IMAGE);
});

// ---------------------------------------------------------------------------
// Where the file goes — unchanged
// ---------------------------------------------------------------------------

test("the image still lands in the printer's gcodes root", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    await u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, watchSeconds: 5, verify: "md5" });

    assert.equal(mock.calls.uploads, 1);
    assert.equal(mock.calls.uploadPath, "/server/files/upload",
      "the same Moonraker upload endpoint every print already uses");
    // uploadWithProgress posts only the file part and lets Moonraker apply its
    // default root, which is `gcodes`. Nothing has to TRUST that: verification
    // reads the file back from /server/files/gcodes/..., and the mock serves
    // only that path — a file that had landed anywhere else would 404 there.
    // Asked in md5 mode so the proof is a whole-file read of that exact path.
    assert.match(mock.calls.uploadHeader, /name="file"; filename="fw\.bin"/);
    assert.equal(mock.calls.reads, 1, "the image was read back from the gcodes root");
  } finally { await mock.close(); }
});

test("the absolute path handed to system.upgrade is unchanged", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    await u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, watchSeconds: 5 });

    assert.equal(mock.calls.upgrade.length, 1);
    assert.equal(mock.calls.upgrade[0].type, "local");
    // Composed from the root the PRINTER reported (/userdata/gcodes) plus the
    // name the upload response returned — not hardcoded, and not derived from
    // anything the uploader rewrite touched.
    assert.equal(mock.calls.upgrade[0].filepath, "/userdata/gcodes/fw.bin");
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// Byte accounting
// ---------------------------------------------------------------------------

test("upload progress ends at sent === total, against the bytes really transferred", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    const upload = [];
    await u1fw.updateFromFile(mock.printer, tmpFile, {
      keepImage: true, watchSeconds: 5,
      onProgress: (phase, sent, total) => { if (phase === "upload") upload.push([sent, total]); },
    });

    assert.ok(upload.length > 1, "progress is reported per chunk, not once at the end");
    const [lastSent, lastTotal] = upload[upload.length - 1];
    // The total is the REQUEST BODY, not the bare file: that is what is
    // actually being transferred, and it is what the printer received.
    // On a 250 MB image the multipart framing is ~166 bytes, so the number
    // shown to the user is the file size to every digit they can read.
    assert.equal(lastTotal, mock.calls.uploadContentLength,
      "the total is the request body that actually went over the wire");
    assert.equal(lastSent, lastTotal, "the last report is a completed transfer");
    assert.ok(lastTotal >= IMAGE.length && lastTotal < IMAGE.length + 4096,
      "and it is the image plus only the multipart framing");
    // Monotonic, never past the total — a bar that jumps backwards or exceeds
    // 100% reads as a bug in the printer, which is the wrong thing to suggest.
    let prev = -1;
    for (const [sent, total] of upload) {
      assert.ok(sent >= prev, "progress never goes backwards");
      assert.ok(sent <= total, "progress never exceeds the total");
      assert.equal(total, lastTotal, "the total never changes mid-transfer");
      prev = sent;
    }
  } finally { await mock.close(); }
});

test("the bytes the printer received match the file, and Content-Length was exact", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    await u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, watchSeconds: 5 });

    // The body is multipart, so it is larger than the image by the part
    // headers — but it must contain the whole image, and the declared length
    // must match what actually arrived. A wrong Content-Length is how a
    // hand-rolled multipart uploader silently truncates a large file.
    assert.ok(mock.calls.uploadBytes > IMAGE.length, "the whole image was sent");
    assert.ok(mock.calls.uploadBytes < IMAGE.length + 4096, "and not much else");
    assert.equal(mock.calls.uploadContentLength, mock.calls.uploadBytes,
      "the declared length matched the bytes that arrived");
  } finally { await mock.close(); }
});

test("verify progress ends at sent === total, measured against the LOCAL size", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    const verify = [];
    await u1fw.updateFromFile(mock.printer, tmpFile, {
      keepImage: true, watchSeconds: 5,
      onProgress: (phase, sent, total) => { if (phase === "verify") verify.push([sent, total]); },
    });

    assert.ok(verify.length > 1, "the read-back reports progress too — it moves as many bytes");
    const [lastSent, lastTotal] = verify[verify.length - 1];
    assert.equal(lastTotal, IMAGE.length);
    assert.equal(lastSent, IMAGE.length);
  } finally { await mock.close(); }
});

test("the two phases are reported separately, in order", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    const phases = [];
    await u1fw.updateFromFile(mock.printer, tmpFile, {
      keepImage: true, watchSeconds: 5,
      onProgress: phase => { if (phases[phases.length - 1] !== phase) phases.push(phase); },
    });
    // "Uploading" and "checking the uploaded file" carry different advice about
    // whether it is safe to walk away, so they must never collapse into one.
    assert.deepEqual(phases, ["upload", "verify"]);
  } finally { await mock.close(); }
});

test("a deploy with no onProgress still completes — reporting is opt-in", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    const r = await u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, watchSeconds: 5 });
    assert.equal(mock.calls.upgrade.length, 1);
    assert.equal(r.before.fullversion, "1.5.2.13_20260722102206");
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// The MD5 gate, unchanged by the rewrite
// ---------------------------------------------------------------------------

test("a file that comes back different is still refused, and nothing is flashed", async () => {
  // The printer hands back bytes that are not what was sent.
  const mock = await startMockU1({ file: Buffer.concat([IMAGE, Buffer.from("X")]), name: "fw.bin" });
  try {
    const seen = [];
    await assert.rejects(
      () => u1fw.updateFromFile(mock.printer, tmpFile, {
        keepImage: true,
        onProgress: (phase, sent, total) => seen.push([phase, sent, total]),
      }),
      /does not match the local file/,
    );
    assert.equal(mock.calls.upgrade.length, 0, "system.upgrade must never reach the printer");
    // The upload still reported completion — the refusal comes from the
    // comparison afterwards, not from a short transfer.
    const uploads = seen.filter(x => x[0] === "upload");
    const [, sent, total] = uploads[uploads.length - 1];
    assert.equal(sent, total, "the whole image was sent before the gate refused it");
  } finally { await mock.close(); }
});

test("each mode reports the check it actually performed, computed from the real file", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    let step = null;
    await u1fw.updateFromFile(mock.printer, tmpFile, {
      keepImage: true, watchSeconds: 5, verify: "md5",
      onStep: s => { if (s.step === "verified") step = s; },
    });
    assert.equal(step.mode, "md5");
    assert.equal(step.local, createHash("md5").update(IMAGE).digest("hex"),
      "the digest is the real file's, not the uploader's idea of it");
  } finally { await mock.close(); }

  const mock2 = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    let step = null;
    await u1fw.updateFromFile(mock2.printer, tmpFile, {
      keepImage: true, watchSeconds: 5,
      onStep: s => { if (s.step === "verified") step = s; },
    });
    assert.equal(step.mode, "crc", "crc is the default");
    assert.equal(step.local, zlib.crc32(IMAGE) >>> 0,
      "the CRC is the real file's, and it matched what the printer archived");
  } finally { await mock2.close(); }
});

test("verification is on unless a caller explicitly asks for none", () => {
  // It IS a setting: the Firmware tab has a switch. What has to hold is that
  // every path which does not say otherwise still checks, and that "none" is
  // never arrived at by accident — no default, no fallback lands on it.
  const src = fs.readFileSync(path.join(__dirname, "..", "connectors", "snapmaker-u1-firmware.js"), "utf8");
  const fn = src.slice(src.indexOf("async function updateFromFile"));
  assert.match(fn, /^\s*verify = "crc",$/m, "the module default is the full check");
  assert.match(fn, /if \(verify === "none"\) \{/);
  assert.equal((fn.match(/await startLocalUpgrade\(/g) || []).length, 1,
    "one flash call, so an unverified deploy is a choice and not a second code path");
  // verifyFirmware is skipped outright rather than returning a pass it did
  // not earn — a function answering ok:true without looking is a trap.
  const verifyFn = src.slice(src.indexOf("async function verifyFirmware("), src.indexOf("exports.verifyFirmware"));
  assert.equal(/"none"/.test(verifyFn), false, "verifyFirmware must not know how to pass without checking");
  // The server maps only an explicit false; an absent field still verifies.
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSrc, /const verifyMode = b\.verify === false \? "none" : null;/);
  // ...and the switch states the consequence where the choice is made.
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<input type="checkbox" role="switch" id="fwVerify" class="switch-input" checked>/,
    "on by default — a missing `checked` here would silently disable the gate");
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8"));
  assert.match(en.settings.firmware.verify_desc, /unchecked/i);
  assert.match(en.settings.firmware.verify_desc, /unbootable|brick/i);
});

test("verification off: nothing is checked, and the row says so", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    const steps = [];
    const r = await u1fw.updateFromFile(mock.printer, tmpFile, {
      keepImage: true, watchSeconds: 5, verify: "none",
      onStep: s => steps.push(s.step),
    });
    assert.equal(mock.calls.zips, 0, "nothing was archived");
    assert.equal(mock.calls.reads, 0, "nothing was read back");
    assert.equal(mock.calls.upgrade.length, 1, "and the flash still happened");
    assert.ok(steps.includes("verify-skipped"), "the step log records that nothing checked it");
    assert.equal(steps.includes("verified"), false);
    assert.equal(r.verify, "none", "reported honestly on the result, which the audit reads");
  } finally { await mock.close(); }
});

test("verification off: a corrupted upload IS flashed — the cost of the switch", async () => {
  // Deliberately pinned. This is exactly what the switch trades away, and a
  // future reader should find the consequence stated here rather than
  // discover it on a printer. Every other mode refuses this same setup.
  const mock = await startMockU1({ file: Buffer.from("NOT THE IMAGE AT ALL"), name: "fw.bin" });
  try {
    await u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, watchSeconds: 5, verify: "none" });
    assert.equal(mock.calls.upgrade.length, 1,
      "with no check at all, nothing notices the printer holds different bytes");
  } finally { await mock.close(); }
});
test("the default check verifies without pulling the image back", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    await u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, watchSeconds: 5 });
    assert.equal(mock.calls.zips, 1, "the printer archived the file");
    assert.ok(mock.calls.ranges > 0, "and the CRC was read out of that archive");
    assert.equal(mock.calls.reads, 0, "no quarter-gigabyte came back over the network");
    assert.equal(mock.calls.upgrade.length, 1);
    // The scratch archive is never left behind on the printer.
    assert.ok(mock.calls.deletes.some(d => /\.zip$/.test(d)), "the archive was cleaned up");
  } finally { await mock.close(); }
});

test("a printer holding different bytes is still refused, whichever check runs", async () => {
  for (const [label, opts] of [["crc", {}], ["md5", { verify: "md5" }], ["sample", { verify: "sample" }]]) {
    const mock = await startMockU1({ file: Buffer.from("NOT THE IMAGE AT ALL"), name: "fw.bin" });
    try {
      await assert.rejects(
        () => u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, ...opts }),
        /does not match the local file/, label + " must refuse it");
      assert.equal(mock.calls.upgrade.length, 0, label + ": nothing was flashed");
    } finally { await mock.close(); }
  }
});

test("a printer with no archive endpoint degrades to a weaker check, never to none", async () => {
  // Older printer firmware has no /server/files/zip. That must not silently
  // become "flash it unchecked".
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin", noZip: true });
  try {
    let step = null;
    const r = await u1fw.updateFromFile(mock.printer, tmpFile, {
      keepImage: true, watchSeconds: 5,
      onStep: s => { if (s.step === "verified") step = s; },
    });
    assert.equal(step.mode, "sample", "it fell back to windowed sampling");
    assert.equal(step.fellBackFrom, "crc", "and says what it fell back from");
    assert.equal(r.verify, "sample");
    assert.ok(mock.calls.ranges > 0, "the sampled windows really were read");
    assert.equal(mock.calls.upgrade.length, 1);
  } finally { await mock.close(); }
});

test("the fallback still catches a truncated upload", async () => {
  // Sampling checks the size first, which is what a half-finished transfer
  // fails on — the case the fallback exists for.
  const mock = await startMockU1({ file: IMAGE.subarray(0, IMAGE.length - 1024), name: "fw.bin", noZip: true });
  try {
    await assert.rejects(
      () => u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true }),
      /does not match the local file/);
    assert.equal(mock.calls.upgrade.length, 0);
  } finally { await mock.close(); }
});

test("the audit records which check ran, and whether it fell back", () => {
  // If a printer later turns out to have been flashed with a bad image,
  // "which check ran, and was it the weaker one" is the question.
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const job = serverSrc.slice(serverSrc.indexOf("async function runFirmwareDeploy("),
                              serverSrc.indexOf("let fwDraining = false;"));
  assert.match(job, /verify: r\.verify \|\| null, verifyFellBackFrom: r\.fellBackFrom \|\| null,/);
});
// test/firmwarePreFlashGate.test.js — the last safety gate before an
// irreversible firmware write.
//
// A U1 can be idle when a deploy starts and printing by the time the image has
// finished uploading, because the upload takes minutes. Flashing then destroys
// the job and leaves the machine mid-write. The gate that prevents it is
// updateFromFile()'s awaited `beforeFlash` hook.
//
// This is proven behaviorally, against a mock printer (test/helpers/mockU1.js),
// rather than by asserting source order: the only convincing evidence that the
// flash did not happen is that system.upgrade never reached the wire. A
// structural check is kept as well, but only as a fast tripwire for a future
// reorder — it is not the proof.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockU1 } = require("./helpers/mockU1");
const u1fw = require("../connectors/snapmaker-u1-firmware");

const IMAGE = Buffer.from("SNAPCON-TEST-FIRMWARE-IMAGE".repeat(64));
let tmpFile;

test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-fw-gate-"));
  tmpFile = path.join(dir, "fw.bin");
  fs.writeFileSync(tmpFile, IMAGE);
});

// ---------------------------------------------------------------------------

test("printer goes busy during the upload → the flash never starts", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    // Idle when the deploy begins; the print starts while the image uploads.
    let state = "idle";
    const steps = [];

    await assert.rejects(
      () => u1fw.updateFromFile(mock.printer, tmpFile, {
        onStep: s => {
          steps.push(s.step);
          // The moment the upload lands, someone starts a job on the printer.
          if (s.step === "uploaded") state = "printing";
        },
        beforeFlash: async () => {
          // Exactly what the server passes: a fresh state read, throwing if busy.
          if (state === "printing" || state === "paused") {
            throw new Error("MOCK U1 started printing during the upload — nothing was flashed");
          }
        },
      }),
      /started printing during the upload/,
    );

    // THE assertion: nothing was written.
    assert.equal(mock.calls.upgrade.length, 0, "system.upgrade must never reach the printer");
    // ...and it got far enough to prove the gate ran late, not early.
    assert.ok(steps.includes("uploaded"), "the upload completed");
    assert.ok(steps.includes("verified"), "verification completed");
    assert.equal(steps.includes("flash"), false, "the flash step was never announced");
    assert.equal(mock.calls.uploads, 1);
    // Verification still ran before the gate — in the default CRC mode that
    // means the printer archived the file and the CRC was read out of it,
    // not that a quarter-gigabyte came back over the network.
    assert.equal(mock.calls.zips, 1, "the image was still verified");
    assert.equal(mock.calls.reads, 0, "and verifying it did not pull it back");
  } finally { await mock.close(); }
});

test("printer stays idle → the flash proceeds normally", async () => {
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    const steps = [];
    const res = await u1fw.updateFromFile(mock.printer, tmpFile, {
      keepImage: true,          // no delete route on the mock; nothing to clean up
      watchSeconds: 5,
      onStep: s => steps.push(s.step),
      beforeFlash: async () => { /* still idle */ },
    });

    assert.equal(mock.calls.upgrade.length, 1, "system.upgrade reached the printer exactly once");
    assert.equal(mock.calls.upgrade[0].type, "local");
    assert.match(mock.calls.upgrade[0].filepath, /^\/userdata\/gcodes\/fw\.bin$/,
      "flashed by absolute path, built from the printer's own reported root");
    assert.ok(steps.includes("flash"), "the flash step was announced");
    // fullversion is the BUILD, the way a real U1 reports it — not the
    // truncated three-part string it also reports in `version`.
    assert.equal(res.before.fullversion, "1.5.2.13_20260722102206");
    assert.equal(res.before.version, "1.5.2", "and the two are NOT the same string");
  } finally { await mock.close(); }
});

test("a deploy with no beforeFlash hook still flashes — the gate is opt-in", async () => {
  // The module's CLI path passes no hook; adding it must not have made the
  // parameter mandatory.
  const mock = await startMockU1({ file: IMAGE, name: "fw.bin" });
  try {
    await u1fw.updateFromFile(mock.printer, tmpFile, { keepImage: true, watchSeconds: 5 });
    assert.equal(mock.calls.upgrade.length, 1);
  } finally { await mock.close(); }
});

test("beforeFlash runs AFTER verification, so a corrupt image is caught first", async () => {
  // If the gate ran before verification, a mismatched upload would be reported
  // as "printer got busy" instead of "the image is corrupt".
  const mock = await startMockU1({ file: Buffer.from("DIFFERENT BYTES"), name: "fw.bin" });
  try {
    let gateRan = false;
    await assert.rejects(
      () => u1fw.updateFromFile(mock.printer, tmpFile, {
        keepImage: true,
        beforeFlash: async () => { gateRan = true; },
      }),
      /does not match the local file/,
    );
    assert.equal(gateRan, false, "the MD5 gate rejects before the pre-flash gate is consulted");
    assert.equal(mock.calls.upgrade.length, 0);
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------------------
// Tripwire: a fast structural check so an accidental reorder is caught quickly.
// This is NOT the proof — the behavioural tests above are.
// ---------------------------------------------------------------------------

test("beforeFlash is awaited immediately before the flash, after verification", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "connectors", "snapmaker-u1-firmware.js"), "utf8");
  const fn = src.slice(src.indexOf("async function updateFromFile"));
  assert.match(fn, /if \(beforeFlash\) await beforeFlash\(\);/);
  const verifyIdx = fn.indexOf("await verifyFirmware(");
  const gateIdx = fn.indexOf("if (beforeFlash) await beforeFlash();");
  const stepIdx = fn.indexOf('onStep({ step: "flash"');
  const flashIdx = fn.indexOf("await startLocalUpgrade(");
  assert.ok(verifyIdx > 0 && gateIdx > verifyIdx, "the gate runs after verification");
  assert.ok(gateIdx < stepIdx && stepIdx < flashIdx, "and immediately before the flash is announced and started");
  // Nothing irreversible may sit between the gate and the flash.
  assert.equal(/await (?!startLocalUpgrade)/.test(fn.slice(gateIdx + 40, flashIdx)), false,
    "no other awaited work belongs between the gate and the flash");
});

test("the server passes a fresh-probe gate, and its abort is a failure not a reboot", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // The gate lives in the per-printer job, not in the route — the route only
  // queues, and the flash happens minutes later.
  const job = serverSrc.slice(serverSrc.indexOf("async function runFirmwareDeploy("),
                              serverSrc.indexOf("let fwDraining = false;"));
  assert.ok(job.length > 0, "the per-printer job must exist");
  assert.match(job, /beforeFlash: async \(\) => \{\s*\n\s*const busy = await firmwareDeployBlockedBy\(p\);/);
  assert.match(job, /started printing during the upload — nothing was flashed/);
  // The throw lands in the catch, which records the failure. `result` is only
  // ever assigned on the success path, so an abort can never be reported as
  // version-unconfirmed.
  const setsResult = [...job.matchAll(/const result = /g)].length;
  assert.equal(setsResult, 1, "result is assigned once, on the success path only");
  const resultIdx = job.indexOf("const result = ");
  const catchIdx = job.indexOf("} catch (e) {");
  assert.ok(resultIdx > 0 && resultIdx < catchIdx, "the only assignment is before the catch");
  assert.match(job, /fwSet\(id, \{ phase: "failed", error: e\.message/);
  assert.match(job, /event: "firmware-deploy-failed"/);
});

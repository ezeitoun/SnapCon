// test/firmwareVersionMatch.test.js — which string counts as "this printer is
// already running this image".
//
// This exists because getting it wrong was silent and expensive. A U1 reports
// its firmware at two granularities:
//
//   product_info.firmware_version      "1.6.0"                      truncated
//   system.get_device_info.version     "1.6.0"                      truncated
//   printer/info software_version      "1.6.0.267_20260815150420"   the build
//   system.get_device_info.fullversion "1.6.0.267_20260815150420"   the build
//
// and an upgrade image states the build in two fields, version + buildTime,
// which join to exactly the string the printer reports. SnapCon compared the
// TRUNCATED printer field against the image's four-part version, so it never
// matched: "Skip printers already on this version" never once fired, and the
// Firmware tab offered to re-flash twelve printers that were already running
// the image. Observed on a live 15-printer fleet.
//
// The mock made it worse by returning the full build in BOTH device-info
// fields, so the tests agreed with the code instead of with the hardware. That
// is the specific failure these tests are here to prevent recurring.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { startMockU1 } = require("./helpers/mockU1");
const u1fw = require("../connectors/snapmaker-u1-firmware");
const { firmwareBuildId, firmwareVersionPart } = require("../connectors/firmwareImage");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// Real values, copied from a live U1 running 1.6.0.267 and from the image that
// put it there. If these two stop agreeing, the comparison is wrong again.
const PRINTER_FULL = "1.6.0.267_20260815150420";
const PRINTER_SHORT = "1.6.0";
const IMAGE = { version: "1.6.0.267", buildTime: "20260815150420" };

// ---------------------------------------------------------------------------

test("the image's build id is exactly what an updated printer reports", () => {
  assert.equal(firmwareBuildId(IMAGE), PRINTER_FULL);
  assert.equal(firmwareVersionPart(PRINTER_FULL), IMAGE.version);
  // ...and the truncated field is a PREFIX of it, which is precisely why
  // comparing it looked plausible and was wrong.
  assert.ok(PRINTER_FULL.startsWith(PRINTER_SHORT));
  assert.notEqual(PRINTER_SHORT, IMAGE.version);
});

test("an image with no build stamp yields no build id, rather than half of one", () => {
  // Pre-1.6.0 U1 images carry no BUILD_NUMBER marker at all, so neither field
  // is known. Composing something from the file name instead would silently
  // skip a printer that genuinely needs updating if the file were renamed.
  assert.equal(firmwareBuildId({ version: null, buildTime: null }), null);
  assert.equal(firmwareBuildId({ version: "1.5.2.13", buildTime: null }), null);
  assert.equal(firmwareBuildId(null), null);
  assert.equal(firmwareVersionPart(null), null);
});

test("the mock reports the two fields at the granularities hardware does", async () => {
  // The bug hid here: a mock returning the full build in BOTH fields makes the
  // broken comparison pass.
  const mock = await startMockU1({ file: Buffer.from("x"), version: PRINTER_FULL });
  try {
    const info = await u1fw.getDeviceInfo(mock.printer);
    assert.equal(info.fullversion, PRINTER_FULL);
    assert.equal(info.version, PRINTER_SHORT);
    assert.notEqual(info.version, info.fullversion,
      "these must differ, or a test cannot tell the two apart");
  } finally { await mock.close(); }
});

test("the server skips on the build id, never on the truncated version", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/firmware-deploy"'),
                                serverSrc.indexOf('app.get("/api/firmware-status"'));
  assert.match(route, /const targetBuild = firmwareImage\.firmwareBuildId\(image\);/);
  assert.match(route, /info\.fullversion \|\| info\.version/,
    "the full build is what gets read off the printer");
  assert.match(route, /String\(current\) === targetBuild/);
  // The old comparison must not come back.
  assert.equal(/String\(current\) === String\(image\.version\)/.test(route), false,
    "comparing the truncated field against the image version never matches");
  // Without a stamp it falls back to the version half — weaker, but still a
  // reading from the payload rather than from the file name.
  assert.match(route, /firmwareImage\.firmwareVersionPart\(current\) === image\.version/);
  // Never the file name: it is renameable, so a rename would silently skip a
  // printer that genuinely needs updating.
  assert.equal(/image\.filename/.test(route), false, "the skip must not consult the file name");
});

test("the browser compares the same strings the server does", () => {
  const sandbox = {
    SELECTED_FIRMWARE: null,
    firmwareTargetVersion: null, firmwareTargetBuild: null,
  };
  vm.createContext(sandbox);
  for (const name of ["firmwareTargetVersion", "firmwareTargetBuild",
                      "firmwarePrinterBuild", "firmwarePrinterVersion", "firmwareIsCurrent"]) {
    const start = appSrc.indexOf("function " + name + "(");
    assert.ok(start > 0, name + " must exist in public/app.js");
    const end = appSrc.indexOf("\n}", start);
    vm.runInContext(appSrc.slice(start, end + 2), sandbox);
  }
  const updated = { firmware: PRINTER_SHORT, klipper: PRINTER_FULL };
  const older = { firmware: "1.5.2", klipper: "1.5.2.13_20260722102206" };

  // The exact situation that was on screen: twelve printers offered for a
  // re-flash of the image they were already running.
  sandbox.SELECTED_FIRMWARE = { inspect: { version: IMAGE.version, buildId: PRINTER_FULL } };
  assert.equal(sandbox.firmwareIsCurrent(updated), true, "an updated printer is current");
  assert.equal(sandbox.firmwareIsCurrent(older), false, "an older one is not");
  // Displayed in the same terms at both ends of the arrow.
  assert.equal(sandbox.firmwarePrinterVersion(updated), IMAGE.version);
  assert.equal(sandbox.firmwarePrinterVersion(older), "1.5.2.13");

  // An image that states no stamp falls back to the version half.
  sandbox.SELECTED_FIRMWARE = { inspect: { version: IMAGE.version, buildId: null } };
  assert.equal(sandbox.firmwareIsCurrent(updated), true);
  assert.equal(sandbox.firmwareIsCurrent(older), false);

  // No image at all: nothing is "current", because there is nothing to be
  // current WITH.
  sandbox.SELECTED_FIRMWARE = null;
  assert.equal(sandbox.firmwareIsCurrent(updated), false);

  // A printer that reports only the truncated field still shows something,
  // rather than a blank cell.
  assert.equal(sandbox.firmwarePrinterVersion({ firmware: "1.6.0", klipper: null }), "1.6.0");
});

test("the chips and the rows read the same value", () => {
  // They disagreed on screen: chips said "1.6.0 · 10" from the truncated field
  // while the rows showed "1.6.0 → 1.6.0.267" against the image, so the summary
  // and the detail described different things.
  const chips = appSrc.slice(appSrc.indexOf("function renderFirmwareChips("),
                             appSrc.indexOf("// Selection, the footer and the deploy action"));
  assert.match(chips, /const v=firmwarePrinterVersion\(r\);/);
  assert.equal(/counts\.set\(r\.firmware/.test(chips), false,
    "the truncated field must not be counted");
  const cells = appSrc.slice(appSrc.indexOf("function updateFirmwareRowCells("),
                             appSrc.indexOf("// The one status slot per row"));
  assert.match(cells, /firmwarePrinterVersion\(r\)/);
  assert.equal(/ver\.textContent=r\.firmware/.test(cells), false);
});

test("grouping asks whether the printer is current, not whether two strings look alike", () => {
  const fn = appSrc.slice(appSrc.indexOf("function firmwareGroupOf("),
                          appSrc.indexOf("// ---------------------------------------------------------------------------\n// Rows"));
  assert.match(fn, /return firmwareIsCurrent\(r\) \? "uptodate" : "needs";/);
  assert.equal(/r\.firmware===target/.test(fn), false,
    "the truncated field can never equal a four-part image version");
});

// The compatibility gate reads the printer's model out of system.get_device_info,
// and the field is `product_code` — not `product`. Reading the wrong name does
// not fail loudly: it yields undefined, firmwareCompatReject sees "no product
// claimed", and the whole check silently becomes a no-op that can never reject
// anything. That shipped briefly and was caught only because the mock printer's
// reply shape disagreed with the route.
test("the deploy route reads product_code, the field the printer actually reports", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/firmware-deploy"'));
  const body = route.slice(0, route.indexOf("\n});"));
  assert.match(body, /product = info\.product_code/,
    "reading info.product makes the compatibility check inert");
  assert.doesNotMatch(body, /product = info\.product\b(?!_)/);
});

test("the mock printer answers get_device_info with the same field name", () => {
  // If these two ever disagree again, the gate goes quiet rather than breaking.
  const mock = fs.readFileSync(path.join(__dirname, "helpers", "mockU1.js"), "utf8");
  assert.match(mock, /product_code:/,
    "the mock is the only place this shape is exercised end to end");
});

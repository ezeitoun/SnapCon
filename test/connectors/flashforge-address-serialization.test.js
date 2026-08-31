// test/connectors/flashforge-address-serialization.test.js — the CREATION path.
//
// The original bug lived here and every existing test missed it, because they
// all called connector helpers with hand-written URLs. Nothing exercised what
// the Add Printer flow actually persists. These tests do.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { getAddress } = require("../../connectors");
const { composeAddressUrl, normalizePort } = require("../../connectors/address");
const { migratePrinterAddressConfig } = require("../../connectors/migratePrinterAddress");

const ROOT = path.join(__dirname, "..", "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// Mirrors server.js resolvePrinterAddress for the host+port case: the row sends
// ip/port, the server composes the canonical url from them.
function persistAddress(connector, { ip, port }) {
  const spec = getAddress(connector);
  const p = normalizePort(port);
  const out = { url: composeAddressUrl({ scheme: spec.scheme, host: ip, port: p }, spec), ip };
  if (p) out.port = p;
  return out;
}

for (const connector of ["flashforge-ad5x", "flashforge-adventurer"]) {
  test(`${connector}: declares no pre-fillable default port`, () => {
    // A defaultPort here is auto-filled into a new printer's port field by the
    // Settings row and persisted into the stored URL. That was the bug.
    assert.equal(getAddress(connector).defaultPort, null);
    // ...but the field stays available as the advanced override.
    assert.equal(getAddress(connector).portEditable, true);
  });

  test(`${connector}: a printer added with only an IP persists a host-only address`, () => {
    const rec = persistAddress(connector, { ip: "192.0.2.10", port: "" });
    assert.equal(rec.url, "http://192.0.2.10", "no port may be materialised");
    assert.equal(rec.port, undefined);
  });

  test(`${connector}: a deliberately entered custom port survives serialization`, () => {
    const rec = persistAddress(connector, { ip: "192.0.2.10", port: "5000" });
    assert.equal(rec.url, "http://192.0.2.10:5000");
    assert.equal(rec.port, 5000);
  });

  test(`${connector}: save -> reload -> re-save is idempotent, no port appears`, () => {
    const first = persistAddress(connector, { ip: "192.0.2.10", port: "" });
    // Reload: the row repopulates from the stored record (app.js addrPort), then
    // the user saves again without touching the address.
    const second = persistAddress(connector, { ip: first.ip, port: first.port || "" });
    assert.deepEqual(second, first, "a round-trip must not materialise a port");
    assert.equal(second.url, "http://192.0.2.10");
  });

  test(`${connector}: the startup migration leaves a host-only config untouched`, () => {
    const cfg = { printers: [{ id: "p1", name: "FF", url: "http://192.0.2.10", connector }] };
    const { cfg: out, changed } = migratePrinterAddressConfig(cfg);
    assert.equal(out.printers[0].url, "http://192.0.2.10");
    assert.equal(out.printers[0].port, undefined, "migration must not add a port");
    assert.equal(changed, true, "it still splits ip out, but adds no port");
    assert.equal(out.printers[0].ip, "192.0.2.10");
  });
}

test("the UI can only pre-fill a port when the connector declares one", () => {
  // With defaultPort null this branch cannot fire for FlashForge.
  assert.match(appSrc, /else if\(!portEl\.value\.trim\(\)&&spec\.defaultPort\) portEl\.value=String\(spec\.defaultPort\);/);
});

test("switching an existing printer TO a FlashForge connector stamps no port either", () => {
  // The auto-fill also runs on a deliberate connector change, not just new rows,
  // so the bug's reach was wider than newly-added printers.
  for (const connector of ["flashforge-ad5x", "flashforge-adventurer"]) {
    assert.equal(getAddress(connector).defaultPort, null, connector);
  }
});

// test/test-connection-credentials.test.js — regression test for Settings >
// Printers' "Test connection" button dropping printer credentials.
//
// The bug: /api/test-connection built its probe object as `const p = { url }`,
// and the client only ever sent url+connector. FlashForge authenticates every
// HTTP call with serialNumber+checkCode, so the probe went out with empty
// credentials and the printer answered "SN is different" — the SAME message it
// returns for a genuinely wrong serial, and for an empty one. Test connection
// could therefore never succeed for a FlashForge printer however correct the
// user's serial was, while the fleet poller (which reads the saved config)
// worked fine. Confirmed live against an Adventurer 5M Pro.
//
// Two halves, because server.js has no module.exports and no route-level test
// harness in this project (same constraint health-maintenance.test.js documents
// and works around the same way):
//   1. behavioral — the connector really does authenticate with whatever p
//      carries, so dropping the fields really does produce the user's error;
//   2. source-text — the route really does put those fields on p.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ff = require("../connectors/flashforge-adventurer");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const clientSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// Stands in for a real FlashForge: accepts exactly one serial/checkCode pair
// and rejects everything else the way the real firmware does (HTTP 200 with a
// code:1 body, not an HTTP error status).
function mockPrinter(expected) {
  const seen = [];
  const handler = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    const ok = body.serialNumber === expected.serialNumber && body.checkCode === expected.checkCode;
    return {
      ok: true,
      status: 200,
      json: async () => ok
        ? { code: 0, detail: { status: "ready", platTemp: 24, rightTemp: 27 } }
        : { code: 1, message: "SN is different" }
    };
  };
  return { handler, seen };
}

function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

const CREDS = { serialNumber: "SNMOMD9C03938", checkCode: "72463d2c" };

test("probe FAILS with the printer's auth error when the probe object carries no credentials (the old route's behavior)", async () => {
  const { handler, seen } = mockPrinter(CREDS);
  // Exactly what `const p = { url }` produced.
  const st = await withMockFetch(handler, () => ff.probe({ url: "http://printer.test" }));
  assert.equal(st.online, false);
  assert.equal(st.error, "SN is different", "this is the message the user actually saw");
  assert.equal(seen[0].serialNumber, "", "the old shape sent an empty serial");
  assert.equal(seen[0].checkCode, "", "the old shape sent an empty check code");
});

test("probe SUCCEEDS once the probe object carries serial + verificationCode", async () => {
  const { handler, seen } = mockPrinter(CREDS);
  const st = await withMockFetch(handler, () => ff.probe({
    url: "http://printer.test", name: "5M PRO",
    serial: "SNMOMD9C03938", verificationCode: "72463d2c"
  }));
  assert.equal(st.online, true);
  assert.equal(st.state, "standby");
  assert.equal(seen[0].serialNumber, "SNMOMD9C03938");
  assert.equal(seen[0].checkCode, "72463d2c");
});

test("/api/test-connection is a POST so the check code never travels in a query string", () => {
  assert.match(src, /app\.post\("\/api\/test-connection", requireAdmin/);
  assert.doesNotMatch(src, /app\.get\("\/api\/test-connection"/,
    "a leftover GET would keep leaking the secret into logs and history");
});

test("/api/test-connection builds its probe object with serial and verificationCode, not url alone", () => {
  const route = src.slice(src.indexOf('app.post("/api/test-connection"'));
  const body = route.slice(0, route.indexOf("\n});"));
  assert.match(body, /p\.serial\s*=/, "serial must reach the connector");
  assert.match(body, /p\.verificationCode\s*=/, "verificationCode must reach the connector");
  assert.doesNotMatch(body, /const p = \{ url \};/, "the credential-dropping shape must not come back");
});

test("/api/test-connection caps verificationCode at the same 8 chars sanitizePrinter stores", () => {
  const route = src.slice(src.indexOf('app.post("/api/test-connection"'));
  const body = route.slice(0, route.indexOf("\n});"));
  assert.match(body, /verificationCode\s*=\s*String\(b\.verificationCode\)\.slice\(0, 8\)/,
    "otherwise a longer code could pass the test but be truncated on save");
});

test("the Test connection click handler sends the row's serial and verificationCode", () => {
  const at = clientSrc.indexOf('postJSON("/api/test-connection"');
  assert.ok(at !== -1, "the client must POST, matching the route");
  const call = clientSrc.slice(at, at + 400);
  assert.match(call, /serial:row\.querySelector\("\.pserial"\)\.value\.trim\(\)/);
  assert.match(call, /verificationCode:row\.querySelector\("\.pvcode"\)\.value\.trim\(\)/);
});

// test/cameraStreamRoute.test.js — /api/camera-stream relays one printer's
// live video to a browser.
//
// Source-text, for the reason test-connection-credentials.test.js documents:
// server.js has no module.exports and starts a listener on require. What is
// asserted here is the part that must not regress silently — the access
// checks, and that a viewer who goes away releases the printer's camera.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function route() {
  const start = serverSrc.indexOf('app.get("/api/camera-stream"');
  assert.ok(start > 0, "the route must exist");
  return serverSrc.slice(start, serverSrc.indexOf("\napp.", start + 10));
}

test("the stream is behind login and the same printer-visibility check as snapshots", () => {
  // Video from a printer is exactly as sensitive as a still from it: a viewer
  // who cannot see the printer must not be able to watch it either.
  assert.match(route(), /requireAuth/);
  assert.match(route(), /printerVisibleTo\(req\.user, p\)/);
});

test("it refuses a printer whose connector has no live stream", () => {
  assert.match(route(), /cameraStream/);
});

test("a viewer that disconnects releases the printer's camera session", () => {
  // Without this the relay keeps one upstream session per abandoned tab, and
  // the printer serves video to nobody until SnapCon restarts.
  const r = route();
  assert.match(r, /req\.on\("close"/);
  assert.match(r, /unsubscribe\(\)/);
});

test("the browser is told which codec to decode", () => {
  const r = route();
  assert.match(r, /video\/mp4/);
  assert.match(r, /X-SnapCon-Codec/);
});

test("the relay can see how far behind a viewer is", () => {
  // A tab that stops consuming must be dropped by the relay rather than have
  // its video buffered in SnapCon's memory.
  assert.match(route(), /backlog:/);
});

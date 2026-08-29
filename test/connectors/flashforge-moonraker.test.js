// test/connectors/flashforge-moonraker.test.js — the Moonraker transport helper
// for FlashForge printers running a firmware mod (ZMOD, Forge-X).
//
// The camera tests here run against a REAL http server, not a mock. The thing
// being protected is that `fetch` does not follow a redirect off the printer's
// host, and a mocked fetch cannot prove anything about redirect handling — it
// would only prove the mock was written to agree with the test.
//
// Trust boundary being enforced: snapshot_url / stream_url come back from the
// printer and are untrusted input. A real Forge-X printer on this fleet
// advertises `enabled: true` with `http://198.51.100.23/webcam/?action=snapshot`
// — a different host, on a different subnet, that does not resolve. Fetching
// what the printer asks us to fetch would make SnapCon an SSRF proxy.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fm = require("../../connectors/flashforge-moonraker");

// Spin up a real server on 127.0.0.1 and hand back its origin.
function serve(handler) {
  const srv = http.createServer(handler);
  return new Promise(res => srv.listen(0, "127.0.0.1", () => {
    res({ origin: `http://127.0.0.1:${srv.address().port}`, port: srv.address().port, close: () => srv.close() });
  }));
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

// ---- baseUrl ----

test("baseUrl appends Moonraker's port when the stored url has none", () => {
  // FlashForge printers are stored host-only (the native connector applies 8898
  // itself), so without this a modded printer would hit :80 and get Fluidd.
  assert.equal(fm.baseUrl({ url: "http://192.0.2.10" }), "http://192.0.2.10:7125");
});

test("baseUrl leaves an explicitly configured port alone", () => {
  assert.equal(fm.baseUrl({ url: "http://192.0.2.10:7126" }), "http://192.0.2.10:7126");
});

// ---- ping ----

test("ping accepts a real Moonraker response", async () => {
  const s = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: { state: "ready" } }));
  });
  try { assert.equal(await fm.ping({ url: s.origin, name: "t" }), true); } finally { s.close(); }
});

test("ping rejects a 200 that isn't Moonraker", async () => {
  // A FlashForge box with bad credentials answers 200 with {code, message} on
  // every path. Treating any 200 as "Moonraker is here" would mis-detect the
  // transport and bury the printer's real auth error.
  const s = await serve((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: 5, message: "SN is different" }));
  });
  try { await assert.rejects(() => fm.ping({ url: s.origin, name: "t" })); } finally { s.close(); }
});

// ---- resolveWebcam ----
//
// The trust rule: the printer may supply the PATH and QUERY of its camera, but
// it never gets to choose the host SnapCon contacts. Any supplied host, scheme,
// credentials or port is discarded and the candidate is rebuilt against the
// printer's own configured host — then VERIFIED to actually return an image
// before camera is advertised at all.

// A printer whose Moonraker lists `webcams` and which optionally serves an
// image at `imagePath`. Records every path it is asked for.
function camPrinter({ webcams = [], imagePath = null, imageStatus = 200, imageType = "image/jpeg" } = {}) {
  const seen = [];
  return serve((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push(u.pathname + u.search);
    if (u.pathname === "/server/webcams/list") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ result: { webcams } }));
    }
    if (imagePath && u.pathname === imagePath) {
      res.statusCode = imageStatus;
      res.setHeader("content-type", imageType);
      return res.end(imageStatus === 200 ? JPEG : "nope");
    }
    res.statusCode = 404; res.end();
  }).then(s => Object.assign(s, { seen }));
}

test("a relative same-host camera is used", async () => {
  // The ZMOD AD5X shape.
  const s = await camPrinter({
    webcams: [{ name: "video", enabled: true, snapshot_url: "/webcam/?action=snapshot" }],
    imagePath: "/webcam/"
  });
  try {
    const u = await fm.resolveWebcam({ url: s.origin, name: "t" });
    assert.equal(new URL(u).hostname, "127.0.0.1");
    assert.equal(new URL(u).pathname, "/webcam/");
  } finally { s.close(); }
});

test("an absolute same-host camera is used", async () => {
  const s = await camPrinter({ webcams: [], imagePath: "/cam/" });
  const s2 = await camPrinter({
    webcams: [{ name: "video", enabled: true, snapshot_url: s.origin + "/cam/?action=snapshot" }],
    imagePath: "/cam/"
  });
  try {
    const u = await fm.resolveWebcam({ url: s2.origin, name: "t" });
    assert.ok(u && new URL(u).pathname === "/cam/");
  } finally { s.close(); s2.close(); }
});

test("a stale cross-host url is rebuilt onto the printer and works when the printer serves the image", async () => {
  // Confirmed on real hardware: the printer advertised
  // http://198.51.100.23/webcam/?action=snapshot (a host that does not resolve)
  // while serving a real 76KB JPEG at that same path on ITSELF. Rejecting the
  // entry for its host would have disabled a camera that demonstrably works.
  let foreignHits = 0;
  const foreign = await serve((req, res) => { foreignHits++; res.end("nope"); });
  const s = await camPrinter({
    webcams: [{ name: "FF Purple", enabled: true, snapshot_url: `http://localhost:${foreign.port}/webcam/?action=snapshot` }],
    imagePath: "/webcam/"
  });
  try {
    const u = await fm.resolveWebcam({ url: s.origin, name: "t" });
    assert.ok(u, "a working camera on the printer must be found");
    assert.equal(new URL(u).hostname, "127.0.0.1");
    assert.equal(foreignHits, 0, "the printer-supplied host must receive zero requests");
  } finally { foreign.close(); s.close(); }
});

test("the printer-supplied host receives zero requests even when the rebuilt candidate fails", async () => {
  let foreignHits = 0;
  const foreign = await serve((req, res) => { foreignHits++; res.end("nope"); });
  const s = await camPrinter({
    webcams: [{ name: "x", enabled: true, snapshot_url: `http://localhost:${foreign.port}/nope/?action=snapshot` }]
    // no imagePath -> the rebuilt candidate 404s
  });
  try {
    assert.equal(await fm.resolveWebcam({ url: s.origin, name: "t" }), null);
    assert.equal(foreignHits, 0, "no fallback may ever reach the supplied host");
  } finally { foreign.close(); s.close(); }
});

test("a rebuilt candidate that 404s does not enable the camera", async () => {
  const s = await camPrinter({ webcams: [{ name: "x", enabled: true, snapshot_url: "/gone/?action=snapshot" }] });
  try { assert.equal(await fm.resolveWebcam({ url: s.origin, name: "t" }), null); } finally { s.close(); }
});

test("a rebuilt candidate returning 200 but not an image does not enable the camera", async () => {
  // Fluidd's SPA answers 200 text/html for unknown paths, which would otherwise
  // read as a working camera.
  const s = await camPrinter({
    webcams: [{ name: "x", enabled: true, snapshot_url: "/page/?action=snapshot" }],
    imagePath: "/page/", imageType: "text/html"
  });
  try { assert.equal(await fm.resolveWebcam({ url: s.origin, name: "t" }), null); } finally { s.close(); }
});

test("with several entries, the first candidate that actually serves an image wins", async () => {
  const s = await camPrinter({
    webcams: [
      { name: "Example", enabled: false, snapshot_url: "/works/?action=snapshot" },  // disabled, skipped
      { name: "broken", enabled: true, snapshot_url: "/dead/?action=snapshot" },     // 404s
      { name: "real", enabled: true, snapshot_url: "/works/?action=snapshot" }
    ],
    imagePath: "/works/"
  });
  try {
    const u = await fm.resolveWebcam({ url: s.origin, name: "t" });
    assert.equal(new URL(u).pathname, "/works/");
  } finally { s.close(); }
});

test("disabled entries are ignored even when they would have worked", async () => {
  const s = await camPrinter({
    webcams: [{ name: "Example", enabled: false, snapshot_url: "/webcam/?action=snapshot" }],
    imagePath: "/webcam/"
  });
  try { assert.equal(await fm.resolveWebcam({ url: s.origin, name: "t" }), null); } finally { s.close(); }
});

test("resolveWebcam returns null when no webcam is configured at all", async () => {
  const s = await camPrinter({ webcams: [] });
  try { assert.equal(await fm.resolveWebcam({ url: s.origin, name: "t" }), null); } finally { s.close(); }
});

// ---- fetchSnapshot: the five required redirect cases ----

test("case 1 — same-host direct url is fetched", async () => {
  const s = await serve((req, res) => { res.setHeader("content-type", "image/jpeg"); res.end(JPEG); });
  try {
    const buf = await fm.fetchSnapshot({ url: s.origin, name: "t" }, s.origin + "/snap.jpg");
    assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  } finally { s.close(); }
});

test("case 2 — a same-host redirect within budget is followed", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/a") { res.statusCode = 302; res.setHeader("location", "/b"); return res.end(); }
    res.setHeader("content-type", "image/jpeg"); res.end(JPEG);
  });
  try {
    const buf = await fm.fetchSnapshot({ url: s.origin, name: "t" }, s.origin + "/a");
    assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  } finally { s.close(); }
});

test("case 3 — an off-host absolute url is never fetched", async () => {
  let hit = false;
  const other = await serve((req, res) => { hit = true; res.end("nope"); });
  const printer = await serve((req, res) => { res.end("unused"); });
  try {
    // "localhost" is a different host string from "127.0.0.1" — the check is on
    // the host as configured, not on where it happens to resolve.
    const target = `http://localhost:${other.port}/webcam/`;
    await assert.rejects(() => fm.fetchSnapshot({ url: printer.origin, name: "t" }, target));
    assert.equal(hit, false, "the off-host server must never receive a request");
  } finally { other.close(); printer.close(); }
});

test("case 4 — a same-host url redirecting off-host is not followed", async () => {
  // This is the case that silently defeats validating only the initial URL.
  let hit = false;
  const other = await serve((req, res) => { hit = true; res.end("nope"); });
  const printer = await serve((req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `http://localhost:${other.port}/webcam/`);
    res.end();
  });
  try {
    await assert.rejects(() => fm.fetchSnapshot({ url: printer.origin, name: "t" }, printer.origin + "/a"));
    assert.equal(hit, false, "the redirect target must never be requested");
  } finally { other.close(); printer.close(); }
});

test("case 5 — a same-host redirect loop aborts on the hop budget instead of hanging", async () => {
  // Every hop passes the host check, so only the counter can stop this.
  let hops = 0;
  const s = await serve((req, res) => {
    hops++;
    res.statusCode = 302;
    res.setHeader("location", "/again");
    res.end();
  });
  try {
    await assert.rejects(() => fm.fetchSnapshot({ url: s.origin, name: "t" }, s.origin + "/a"));
    assert.ok(hops <= fm.MAX_REDIRECTS + 1, `followed ${hops} hops, budget is ${fm.MAX_REDIRECTS}`);
  } finally { s.close(); }
});

test("a chain exactly at the budget still succeeds", async () => {
  const s = await serve((req, res) => {
    const n = Number((req.url.match(/^\/(\d+)$/) || [])[1]);
    if (n < fm.MAX_REDIRECTS) { res.statusCode = 302; res.setHeader("location", `/${n + 1}`); return res.end(); }
    res.setHeader("content-type", "image/jpeg"); res.end(JPEG);
  });
  try {
    const buf = await fm.fetchSnapshot({ url: s.origin, name: "t" }, s.origin + "/0");
    assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  } finally { s.close(); }
});

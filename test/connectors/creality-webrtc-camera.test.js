// test/connectors/creality-webrtc-camera.test.js — the WebRTC camera
// transport added alongside (never replacing) the server-side snapshot one.
//
// The frontend half is browser-global code with no Node harness in this
// project (same constraint test/i18n-closure.test.js documents), so the
// lifecycle/render rules are asserted against public/app.js's source text —
// the established pattern here — while the connector, the capability shape
// and the signaling contract are exercised for real against a stub server.
// Nothing in this file needs the physical printer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const conn = require("../../connectors/creality-klipper");

const ROOT = path.join(__dirname, "..", "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// The signaling port is part of the contract the device dictates (8000), so
// a stub standing in for it has to own that port rather than an ephemeral
// one. If something else on the machine already has it, these three tests
// skip with a reason instead of failing for an unrelated cause.
const SIGNAL_PORT = 8000;
const LOCAL_PRINTER = { name: "i7", url: "http://127.0.0.1:7125" };
function stubSignaling(mode) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (mode === "answer") {
        const payload = Buffer.from(JSON.stringify({ type: "answer", sdp: "v=0\r\na=sendonly\r\n" })).toString("base64");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(payload);
      } else if (mode === "empty") {
        // The real device answers 200 with "{}" for a body it cannot parse.
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("{}");
      } else {
        res.writeHead(500);
        res.end("nope");
      }
    });
  });
  return new Promise(resolve => {
    server.once("error", () => resolve(null)); // port taken — caller skips
    server.listen(SIGNAL_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---- capability shape: additive, never restructured ----

test("capabilities stay flat booleans — no nested camera object that would read as always-true", () => {
  assert.equal(typeof conn.capabilities.camera, "boolean");
  // Four call sites in app.js gate on `capabilities?.camera`; an object there
  // would be truthy for every printer, silently enabling cameras fleet-wide.
  assert.notEqual(typeof conn.capabilities.camera, "object");
});

test("a printer with no camera reports neither transport", () => {
  const caps = conn.getCapabilities({ url: "http://x" });
  assert.equal(!!caps.camera, false);
  assert.equal(!!caps.cameraSnapshot, false);
  assert.equal(!!caps.cameraWebrtc, false);
});

test("a snapshot camera reports camera + cameraSnapshot, and NOT webrtc", () => {
  const caps = conn.getCapabilities({ url: "http://x", cameraUrl: "http://x:8080/?action=snapshot" });
  assert.equal(caps.camera, true);
  assert.equal(caps.cameraSnapshot, true);
  assert.equal(!!caps.cameraWebrtc, false);
});

test("a WebRTC-only camera reports camera + cameraWebrtc, and NOT snapshot", () => {
  const caps = conn.getCapabilities({ url: "http://x", cameraWebrtc: true });
  assert.equal(caps.camera, true);
  assert.equal(caps.cameraWebrtc, true);
  // The one that matters: no server-side snapshot claim, so /api/snapshot and
  // notification images are never attempted for this printer.
  assert.equal(!!caps.cameraSnapshot, false);
});

test("a snapshot camera wins over WebRTC when a printer somehow has both", () => {
  const caps = conn.getCapabilities({ url: "http://x", cameraUrl: "http://x/snap.jpg", cameraWebrtc: true });
  assert.equal(caps.cameraSnapshot, true);
  assert.equal(!!caps.cameraWebrtc, false); // server-side path is strictly better — it also feeds notifications
});

// ---- signaling URL derivation ----

test("the signaling URL is derived from the printer's own host, never hardcoded", () => {
  assert.equal(conn.webrtcSignalUrl({ url: "http://10.0.0.5:7125" }), "http://10.0.0.5:8000/call/webrtc_local");
  assert.equal(conn.webrtcSignalUrl({ url: "http://printer.local" }), "http://printer.local:8000/call/webrtc_local");
  const src = fs.readFileSync(path.join(ROOT, "connectors", "creality-klipper.js"), "utf8");
  assert.doesNotMatch(src, /192\.168\.4\.240/, "the test printer's address must not be baked into the connector");
});

// ---- detection: confirmed yes / confirmed no / unreachable ----

test("detectCameraWebrtc returns the signaling URL when the device answers", async t => {
  const server = await stubSignaling("answer");
  if (!server) return t.skip("port " + SIGNAL_PORT + " is in use on this machine");
  try {
    assert.equal(await conn.detectCameraWebrtc(LOCAL_PRINTER), "http://127.0.0.1:8000/call/webrtc_local");
  } finally { server.close(); }
});

test("an HTTP 200 that is not a real answer is a confirmed NO, not a yes", async t => {
  const server = await stubSignaling("empty");
  if (!server) return t.skip("port " + SIGNAL_PORT + " is in use on this machine");
  try {
    // The device replies 200 "{}" to anything it does not understand — status
    // alone must never be read as success.
    assert.equal(await conn.detectCameraWebrtc(LOCAL_PRINTER), null);
  } finally { server.close(); }
});

test("a failing signaling service throws, so the caller retries instead of caching a false negative", async t => {
  const server = await stubSignaling("error");
  if (!server) return t.skip("port " + SIGNAL_PORT + " is in use on this machine");
  try {
    await assert.rejects(() => conn.detectCameraWebrtc(LOCAL_PRINTER), /unreachable/i);
  } finally { server.close(); }
});

test("a signaling service that isn't listening at all also throws rather than reporting 'no camera'", async () => {
  // Nothing bound on :8000 here — a connection error must propagate so
  // buildPrinterRecord leaves cameraChecked unset and retries on a later save.
  await assert.rejects(() => conn.detectCameraWebrtc({ name: "i7", url: "http://127.0.0.1:7199" }));
});

// ---- server wiring ----

test("WebRTC detection only runs when no snapshot camera was found, and cannot discard one", () => {
  const block = serverSrc.match(/if \(o\.connector === "creality-klipper"\)[\s\S]*?\n  \}/)[0];
  assert.match(block, /if \(!camUrl && conn\.detectCameraWebrtc\)/);
  // Its own try/catch: an unreachable WebRTC probe must not throw past the
  // snapshot detection that already succeeded.
  assert.match(block, /try \{ if \(await conn\.detectCameraWebrtc\(o\)\) o\.cameraWebrtc = true; \}\s*\n\s*catch/);
  assert.match(block, /if \(existing\.cameraWebrtc\) o\.cameraWebrtc = true;/); // cached like cameraUrl
});

test("the signaling URL reaches the client through the fleet row, not config.json", () => {
  assert.match(serverSrc, /function webrtcCameraFields\(p, conn\)/);
  assert.equal((serverSrc.match(/\.\.\.webrtcCameraFields\(p, conn\)/g) || []).length, 2, "both fleet-row builders");
  assert.match(serverSrc, /if \(!p\.cameraWebrtc \|\| typeof conn\.webrtcSignalUrl !== "function"\) return \{\};/);
});

// ---- the existing snapshot path is untouched ----

test("every previously snapshot-capable connector keeps camera:true and declares the snapshot transport", () => {
  for (const type of ["snapmaker-u1-klipper", "snapmaker-u1-klipper-ws", "flashforge-adventurer", "flashforge-ad5x"]) {
    const c = require("../../connectors/" + type);
    assert.equal(c.capabilities.camera, true, type + " must keep its camera capability");
    // Without this, a printer that genuinely serves server-side frames would
    // report cameraSnapshot:false — behaviourally harmless today (the live
    // tile also checks cameraWebrtc) but a lie to any future consumer.
    assert.equal(c.capabilities.cameraSnapshot, true, type + " serves frames server-side");
    assert.notEqual(c.capabilities.cameraWebrtc, true, type + " has no WebRTC transport");
  }
});

test("/api/snapshot, getSnapshot and CAM_SHOT_CACHE are all still in place", () => {
  assert.match(serverSrc, /app\.get\("\/api\/snapshot"/);
  assert.match(serverSrc, /async function getSnapshot\(|function getSnapshot\(/);
  assert.match(appSrc, /const CAM_SHOT_CACHE = new Map\(\)/);
  assert.match(appSrc, /img\.src="\/api\/snapshot\?printer="/); // the JPEG tile path survives
});

test("notification images still degrade to text-only, with no WebRTC involvement", () => {
  const fn = serverSrc.match(/async function sendEventNotification\([\s\S]*?\n  const jobs = \[\];/)[0];
  // A camera failure must never stop the notification itself.
  assert.match(fn, /try \{ image = await getSnapshot\(p\); \}/);
  assert.match(fn, /catch \{ \/\* no camera — send the text anyway \*\/ \}/);
  assert.doesNotMatch(fn, /webrtc|Webrtc|WebRTC/, "the server must not attempt a browser transport");
});

// ---- frontend lifecycle rules (source-level, per this project's convention) ----

test("a WebRTC-only printer renders a live tile instead of requesting /api/snapshot", () => {
  const mount = appSrc.match(/if\(rebuilt && VIEW_MODE==='camera'[\s\S]*?\n    \}/)[0];
  assert.match(mount, /p\.capabilities\?\.cameraWebrtc && !p\.capabilities\?\.cameraSnapshot && p\.cameraWebrtcUrl/);
  assert.match(mount, /mountCamRtc\(slot, p\.id, p\.cameraWebrtcUrl\)/);
  assert.match(mount, /else mountCamShot\(slot, p\.id, camRefreshMs, CAM_STAGGER\)/); // unchanged for everyone else
});

test("signaling requires a decoded answer — HTTP 200 alone is never success", () => {
  const fn = appSrc.match(/async function camRtcSignal\([\s\S]*?\n\}/)[0];
  assert.match(fn, /btoa\(JSON\.stringify\(\{type:"offer"/);
  assert.match(fn, /atob\(text\)/);
  assert.match(fn, /answer\.type!=="answer"\|\|typeof answer\.sdp!=="string"/);
});

test("the transceiver is recv-only and ICE gathering completes before the offer is posted", () => {
  const fn = appSrc.match(/async function openCamRtc\([\s\S]*?\n\}/)[0];
  assert.match(fn, /addTransceiver\("video",\{direction:"recvonly"\}\)/);
  assert.match(fn, /await camRtcGatheringComplete\(pc\)[\s\S]*?await camRtcSignal/);
});

test("opening a session is idempotent, so re-renders cannot stack peer connections", () => {
  const fn = appSrc.match(/async function openCamRtc\([\s\S]*?\n\}/)[0];
  assert.match(fn, /const existing=CAM_RTC\.get\(id\);[\s\S]*?if\(existing&&existing\.state!=="closed"\)/);
});

test("every teardown path closes the session", () => {
  assert.match(appSrc, /if\(e\.isIntersecting\)[\s\S]*?\}else\{\s*\n\s*closeCamRtc\(id\);/); // leaves viewport
  assert.match(appSrc, /if\(VIEW_MODE!=='camera'\) closeAllCamRtc\(\);/);                    // leaves Camera View
  assert.match(appSrc, /if\(cached\)\{ cached\.el\.remove\(\); closeCamRtc\(p\.id\); \}/);   // card rebuilt
  assert.match(appSrc, /if\(!seen\.has\(id\)\)\{ closeCamRtc\(id\);/);                        // deleted / offline / filtered
  assert.match(appSrc, /CARD_CACHE\.clear\(\); closeAllCamRtc\(\);/);                         // full rebuild
  assert.match(appSrc, /if\(document\.hidden\)\{ closeAllCamRtc\(\); return; \}/);            // tab hidden
  const cleanup = appSrc.match(/function camRtcCleanupEntry\([\s\S]*?\n\}/)[0];
  assert.match(cleanup, /entry\.pc\.close\(\)/);
  assert.match(cleanup, /entry\.video\.srcObject=null/);
});

test("sessions are gated on visibility by IntersectionObserver, not opened for every card", () => {
  assert.match(appSrc, /new IntersectionObserver\(/);
  const mount = appSrc.match(/function mountCamRtc\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(mount, /openCamRtc\(/, "mounting a tile must not itself open a session");
  assert.match(mount, /observeCamRtc\(video,id,url\)/);
});

test("an unusable context fails once with the LAN-only message and never retries", () => {
  const ctx = appSrc.match(/function camRtcContextSupported\([\s\S]*?\n\}/)[0];
  assert.match(ctx, /location\.protocol!=="https:"/);
  const mount = appSrc.match(/function mountCamRtc\([\s\S]*?\n\}/)[0];
  assert.match(mount, /if\(!camRtcContextSupported\(\)\)/);
  assert.match(mount, /t\("fleet\.camera\.lan_only"\)/);
  // A tile that has already failed is skipped rather than reconnected.
  assert.match(appSrc, /if\(el\.dataset\.camrtcfailed==="1"\) continue;/);
});

test("the manual snapshot captures from the video via canvas, with no upload", () => {
  const fn = appSrc.match(/async function captureCamRtcFrame\([\s\S]*?\n\}/)[0];
  assert.match(fn, /drawImage\(video,0,0,canvas\.width,canvas\.height\)/);
  assert.match(fn, /canvas\.toBlob\(/);
  assert.match(fn, /"image\/jpeg",0\.9/);
  assert.match(fn, /!video\.videoWidth\|\|!video\.videoHeight/); // not-ready guard
  assert.doesNotMatch(fn, /fetch\(|XMLHttpRequest/, "captured frames stay in the browser in this version");
});

// ---- locale coverage ----

test("the new strings exist in both bundled locales", () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
  const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));
  for (const loc of [en, es]) {
    assert.equal(typeof loc.fleet.camera.lan_only, "string");
    assert.equal(typeof loc.fleet.modal.snapshot.webrtc_not_ready, "string");
    assert.equal(typeof loc.fleet.modal.snapshot.webrtc_capture_failed, "string");
  }
  // Spanish must actually be translated, not an English copy.
  assert.notEqual(en.fleet.camera.lan_only, es.fleet.camera.lan_only);
  // No hardcoded English in the new frontend code.
  const rtc = appSrc.match(/const CAM_RTC = new Map\(\)[\s\S]*?async function openCamRtc\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(rtc, /"Camera available|"Live view is|"Could not capture/);
});

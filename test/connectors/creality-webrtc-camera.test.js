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
const SRC_CREALITY_BRANCH = 'if (o.connector === "creality-klipper")';
const crealityProbeSrc = () => {
  const i = serverSrc.indexOf("async function detectCrealityWebrtcCamera(");
  return i > 0 ? serverSrc.slice(i, i + 900) : "";
};

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
  const i = serverSrc.indexOf(SRC_CREALITY_BRANCH);
  assert.ok(i > 0, "the Creality branch must exist");
  const block = serverSrc.slice(i, i + 2200);
  // Both entry points are gated on there being no snapshot URL: a printer
  // that serves JPEGs keeps the server-side path, which also feeds
  // notification images.
  assert.ok(block.includes("if (!camUrl) await detectCrealityWebrtcCamera(conn, o);"));
  assert.ok(block.includes("else if (!o.cameraUrl) await detectCrealityWebrtcCamera(conn, o);"));
  assert.ok(block.includes("if (existing.cameraWebrtc) o.cameraWebrtc = true;")); // cached like cameraUrl
  // The probe owns its own try/catch, so an unreachable WebRTC service can
  // never throw past snapshot detection that already succeeded.
  const probe = crealityProbeSrc();
  assert.ok(probe.includes("if (await conn.detectCameraWebrtc(o)) o.cameraWebrtc = true;"));
  assert.ok(probe.includes("catch {"));
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
  // The rebuild branch gained a cursor guard between the brace and the
  // teardown (reconcileFleetCards' position-aware insertion has to step the
  // cursor off a node before detaching it), so this matches the pair inside
  // the block rather than one exact line. Same behavior asserted: a rebuilt
  // card removes its old node and closes that printer's session.
  assert.match(appSrc, /if\(cached\)\{[\s\S]*?cached\.el\.remove\(\); closeCamRtc\(p\.id\);/);   // card rebuilt
  assert.match(appSrc, /if\(!seen\.has\(id\)\)\{ closeCamRtc\(id\);/);                        // deleted / offline / filtered
  assert.match(appSrc, /CARD_CACHE\.clear\(\); closeAllCamRtc\(\);/);                         // full rebuild
  // tab hidden — the relayed-stream transport (Bambu) also drops the camera
  // modal's session there, which closeAllCamRtc() deliberately leaves alone.
  assert.match(appSrc, /if\(document\.hidden\)\{ closeAllCamRtc\(\);( closeAllCamStream\(true\);)? return; \}/);
  const cleanup = appSrc.match(/function camRtcCleanupEntry\([\s\S]*?\n\}/)[0];
  assert.match(cleanup, /entry\.pc\.close\(\)/);
  assert.match(cleanup, /entry\.video\.srcObject=null/);
});

// ---------------------------------------------------------------------------
// Session cleanup belongs to the VIEW BOUNDARY, not the render loop.
//
// List View rows mount no camera elements at all (renderFleetListRows never
// uses its camRefreshMs argument and emits no <img class="cam-shot"> or
// <video>), so the only session that can exist while List View is up is the
// short-lived one the Snapshot modal opens to capture a frame from a
// WebRTC-only camera. The List View render path used to call
// closeAllCamRtc() on every render, which killed that session mid-capture on
// the next fleet poll — the modal then timed out on "Live view is still
// connecting". Cleanup on leaving Camera View is what actually protects
// against stale sessions, and that lives in applyViewMode().
//
// These are source-level checks: applyViewMode()/renderFleet() are
// browser-global code with no module system and heavy DOM coupling (the same
// constraint the rest of this file documents). The behavioral half — a
// snapshot surviving real polls, and Camera View sessions actually being
// released on the way to List View — is browser-verified against the device.

test("leaving Camera View releases every session at the view boundary", () => {
  const fn = appSrc.match(/function applyViewMode\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if\(VIEW_MODE!=='camera'\) closeAllCamRtc\(\);/);
});

test("every path that switches into List View goes through applyViewMode()", () => {
  // This is what makes the render-loop call redundant: if any path could set
  // VIEW_MODE='list' without it, Camera View sessions could survive the switch.
  const cycle = appSrc.match(/function cycleViewMode\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(cycle, /VIEW_MODE=next;\s*\n\s*applyViewMode\(\);/);
  // Settings > View's default-view control, and the initial page-load path.
  assert.match(appSrc, /VIEW_MODE=\(\$\("setDefaultView"\)\.value==="printfarm"\)\?"regular":\$\("setDefaultView"\)\.value; applyViewMode\(\);/);
  // No assignment of the literal 'list' anywhere — it only ever arrives via
  // nextViewMode()/the default-view control, both of which apply the mode.
  assert.equal(/VIEW_MODE\s*=\s*['"]list['"]/.test(appSrc), false);
});

test("an ordinary List View render does NOT close WebRTC sessions", () => {
  const branch = appSrc.match(/if\(VIEW_MODE==='list'\)\{[\s\S]*?renderFleetListRows\([^)]*\);/)[0];
  assert.equal(/closeAllCamRtc\(\)/.test(branch.replace(/\/\/[^\n]*/g, "")), false,
    "a fleet refresh in List View must not tear down the Snapshot modal's session");
  // The rest of the branch is unchanged — the table is still rebuilt.
  assert.match(branch, /wrap\.innerHTML=""; CARD_CACHE\.clear\(\);/);
});

test("the full-rebuild teardown path still closes sessions", () => {
  // renderFleet() called with no arguments (view change, sort, filter, search)
  // still clears everything, which is what releases Camera View tiles when the
  // grid itself is rebuilt.
  assert.match(appSrc, /if\(!incremental\)\{ wrap\.innerHTML=""; CARD_CACHE\.clear\(\); closeAllCamRtc\(\); \}/);
});

test("sessions can only be created for visible Camera View tiles, so they cannot accumulate across view switches", () => {
  // mountCamRtc() is reachable from exactly one place, and only under the
  // camera-view guard; the Snapshot modal opens its own via camRtcFrameSource.
  const mountCalls = [...appSrc.matchAll(/mountCamRtc\(/g)].length;
  assert.equal(mountCalls, 2, "its definition and exactly one call site — nothing else may open a tile session");
  assert.match(appSrc, /if\(rebuilt && VIEW_MODE==='camera' && p\.online && p\.capabilities\?\.camera\)/);
});

test("List View rows mount no camera elements of their own", () => {
  const fn = appSrc.match(/function renderFleetListRows\([\s\S]*?\n\}/)[0];
  assert.equal(/mountCamRtc|mountCamShot|cam-shot-slot/.test(fn), false);
  // A camera button that opens the Snapshot modal is all a List row carries.
  assert.match(fn, /data-snap="\$\{p\.id\}"/);
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

// ---- model detection, and the upgrade path it feeds ----
//
// This connector covers several machines, so the model is detected from
// printer.cfg's own header stamp and kept. buildPrinterRecord's Creality
// branch is not exported, so its decision logic is asserted against
// server.js's source — the same convention the rest of this file uses.

function stubModelCfg(header) {
  const server = http.createServer((req, res) => {
    if (!req.url.includes("printer.cfg")) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(header + "\n[mcu]\nserial: /dev/ttyS1\n");
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("the model comes from printer.cfg's stamp, mapped to a human name", async () => {
  const server = await stubModelCfg("# F022\n# Printer_size: 260x260x300");
  try {
    const m = await conn.detectModel({ name: "i7", url: "http://127.0.0.1:" + server.address().port });
    assert.deepEqual(m, { code: "F022", label: "SPARKX i7" });
  } finally { server.close(); }
});

test("a model the table doesn't know still identifies itself by code", async () => {
  const server = await stubModelCfg("# F999");
  try {
    assert.deepEqual(await conn.detectModel({ name: "x", url: "http://127.0.0.1:" + server.address().port }),
      { code: "F999", label: "F999" });
  } finally { server.close(); }
});

test("firmware with no model stamp reports null rather than guessing", async () => {
  const server = await stubModelCfg("# some other comment");
  try {
    assert.equal(await conn.detectModel({ name: "x", url: "http://127.0.0.1:" + server.address().port }), null);
  } finally { server.close(); }
});

test("an unreachable printer throws, so the model is retried on a later save", async () => {
  await assert.rejects(() => conn.detectModel({ name: "x", url: "http://127.0.0.1:7199" }));
});

test("only the models confirmed to have a WebRTC camera are probed for one", () => {
  assert.equal(conn.modelHasWebrtcCamera("F022"), true);   // SPARKX i7
  assert.equal(conn.modelHasWebrtcCamera("f022"), true);   // case-insensitive
  assert.equal(conn.modelHasWebrtcCamera("F002"), false);  // Ender-3 V3 Plus — port 8000 closed, confirmed live
  assert.equal(conn.modelHasWebrtcCamera(null), false);
});

test("a printer camera-checked BEFORE WebRTC support still gets probed exactly once", () => {
  // The bug this covers: cameraChecked only ever meant "the snapshot probe
  // ran". Every Creality added before this feature carries cameraChecked:true
  // with no camera at all, and sat in the cached branch forever — no amount
  // of re-saving would ever run the WebRTC probe.
  const block = serverSrc.match(/if \(o\.connector === "creality-klipper"\)[\s\S]*?\n  \}/)[0];
  assert.match(block, /if \(existing\.cameraWebrtcChecked\) o\.cameraWebrtcChecked = true;/);
  assert.match(block, /else if \(!o\.cameraUrl\) await detectCrealityWebrtcCamera\(conn, o\);/);
  // …and once it has run, the flag stops it running again.
  const probe = serverSrc.match(/async function detectCrealityWebrtcCamera\([\s\S]*?\n\}/)[0];
  assert.match(probe, /o\.cameraWebrtcChecked = true;/);
});

test("a model known NOT to have a WebRTC camera is never probed for one", () => {
  const probe = serverSrc.match(/async function detectCrealityWebrtcCamera\([\s\S]*?\n\}/)[0];
  assert.match(probe, /if \(o\.modelCode && !conn\.modelHasWebrtcCamera\(o\.modelCode\)\) \{ o\.cameraWebrtcChecked = true; return; \}/);
  // An unidentified model is still probed — it is likelier to be a machine
  // this table has not met than one it has.
  assert.match(probe, /o\.modelCode &&/);
});

test("the detected model is tagged once, and stays deleted if removed", () => {
  const tagBlock = serverSrc.match(/\/\/ A connector that covers several machines tags[\s\S]*?\n  \}/)[0];
  assert.match(tagBlock, /if \(o\.model && !\(existing && existing\.modelChecked\)\)/);
  // Case-insensitive, so a user who already typed the model by hand does not
  // end up with it twice.
  assert.match(tagBlock, /t\.toLowerCase\(\) === o\.model\.toLowerCase\(\)/);
  assert.match(tagBlock, /o\.tags = \[\.\.\.tags, o\.model\]/);
});

test("the snapshot modal works from any view, not only while Camera View streams", () => {
  // The reported bug: the modal read CAM_RTC and nothing else, so opening it
  // from the fleet card (no tile streaming) could only ever report "still
  // connecting". It now opens its own short-lived session when none exists.
  const src = appSrc.slice(appSrc.indexOf("async function camRtcFrameSource("), appSrc.indexOf("async function camRtcFrameSource(") + 1200);
  assert.ok(src.includes("const live=CAM_RTC.get(printerId);"));
  assert.ok(src.includes("if(live&&live.video&&live.video.videoWidth) return live.video;")); // reuse, never re-negotiate
  assert.ok(src.includes("await openCamRtc(printerId,url,video);"));
  assert.ok(src.includes("SNAP_RTC_OWNED=live?null:printerId;"));                            // ownership recorded
  assert.ok(src.includes("while(!video.videoWidth&&Date.now()<deadline)"));                  // wait for a real frame
});

test("closing the modal closes only a session the modal itself opened", () => {
  const close = appSrc.slice(appSrc.indexOf("function closeSnapshot()"), appSrc.indexOf("function closeSnapshot()") + 420);
  assert.ok(close.includes("if(SNAP_RTC_OWNED!=null){ closeCamRtc(SNAP_RTC_OWNED); SNAP_RTC_OWNED=null; }"));
});

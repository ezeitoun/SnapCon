// test/camera-stream-client.test.js — the browser half of the relayed camera
// (Bambu Lab): /api/camera-stream played through Media Source Extensions.
//
// app.js is browser-global, so, like test/connectors/creality-webrtc-camera
// .test.js, the pure bookkeeping runs in a node:vm sandbox and the wiring is
// asserted on the source. Real playback needs a browser with an H.264
// decoder and is verified by hand; the server half (the fMP4 byte stream
// itself) is decoded by ffmpeg in test/connectors/bambu-camera.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const fnSrc = (src, name) => {
  const start = src.search(new RegExp("(async )?function " + name + "\\("));
  assert.ok(start >= 0, name + " must exist");
  return src.slice(start, src.indexOf("\n}", start) + 2);
};

test("closeAllCamStream keeps the camera modal's session unless told otherwise", () => {
  const sb = { URL: { revokeObjectURL() {} }, setTimeout, clearTimeout };
  vm.createContext(sb);
  vm.runInContext("const CAM_STREAM=new Map();" + fnSrc(appSrc, "camStreamCleanup") + fnSrc(appSrc, "closeCamStream") + fnSrc(appSrc, "closeAllCamStream") + ";this.CAM_STREAM=CAM_STREAM;", sb);
  const mk = () => ({ state: "live", aborted: false, abort: { abort() { this.hit = true; } }, video: null, url: null });
  const tile = mk(), modal = mk();
  sb.CAM_STREAM.set(3, tile); sb.CAM_STREAM.set("snap", modal);
  sb.closeAllCamStream(false);
  assert.deepEqual([...sb.CAM_STREAM.keys()], ["snap"], "a fleet re-render must not cut the open camera modal");
  assert.equal(tile.state, "closed");
  assert.ok(tile.abort.hit, "the tile's fetch was aborted");
  sb.closeAllCamStream(true);
  assert.equal(sb.CAM_STREAM.size, 0);
  assert.equal(modal.state, "closed");
});

test("a tile's session is closed one tick late, so a card rebuilt in the same pass adopts the running player", async () => {
  const sb = { URL: { revokeObjectURL() {} }, setTimeout, clearTimeout };
  vm.createContext(sb);
  vm.runInContext("const CAM_STREAM=new Map();" + fnSrc(appSrc, "camStreamCleanup") + fnSrc(appSrc, "closeCamStream") + ";this.CAM_STREAM=CAM_STREAM;", sb);
  const video = { pause() {}, removeAttribute() {}, load() {} };
  const mk = () => ({ state: "live", abort: { abort() {} }, video, url: null, pendingClose: null });
  const adopted = mk(), removed = mk(), modal = mk();
  sb.CAM_STREAM.set(1, adopted); sb.CAM_STREAM.set(2, removed); sb.CAM_STREAM.set("snap", modal);
  sb.closeCamStream(1); sb.closeCamStream(2); sb.closeCamStream("snap");
  assert.equal(modal.state, "closed", "the modal closes immediately");
  assert.equal(adopted.state, "live", "tiles are not closed yet");
  clearTimeout(adopted.pendingClose); adopted.pendingClose = null; // what mountCamStream does when it adopts
  await new Promise(r => setTimeout(r, 5));
  assert.equal(adopted.state, "live", "the adopted player keeps running");
  assert.equal(removed.state, "closed", "a tile nobody adopted is cleaned up on the next tick");
  assert.deepEqual([...sb.CAM_STREAM.keys()], [1]);
  assert.match(fnSrc(appSrc, "mountCamStream"), /running\.pendingClose[\s\S]*?clearTimeout\(running\.pendingClose\)[\s\S]*?slot\.replaceWith\(running\.video\)/);
});

test("live tiles are capped below the browser's per-host connection limit; the rest wait behind a click", () => {
  assert.match(appSrc, /const CAM_STREAM_MAX_TILES = 3;/);
  const obs = fnSrc(appSrc, "camStreamObserver");
  assert.match(obs, /if\(camStreamLiveTiles\(\)\.length>=CAM_STREAM_MAX_TILES\)\{[\s\S]*?camStreamWaitingEl\(id\)/);
  assert.match(fnSrc(appSrc, "camStreamWaitingEl"), /sort\(\(a,b\)=>a\[1\]\.startedAt-b\[1\]\.startedAt\)/, "clicking frees the longest-running tile");
});

test("decoder and buffer failures end the session (retry placeholder) instead of freezing the tile", () => {
  const fn = fnSrc(appSrc, "openCamStream");
  assert.match(fn, /sb\.addEventListener\("error",\(\)=>fail\(\)\)/);
  assert.match(fn, /ms\.addEventListener\("sourceended",\(\)=>fail\(\)\)/);
  assert.match(fn, /video\.addEventListener\("error",\(\)=>fail\(\),\{once:true\}\)/);
  assert.match(fn, /sb\.appendBuffer\(queue\[0\]\);\s*\n\s*queuedBytes-=queue\[0\]\.byteLength; queue\.shift\(\);/, "a refused chunk stays queued");
  assert.match(fn, /if\(queuedBytes>16\*1024\*1024\)/);
  assert.match(fn, /if\(!MS\|\|!MS\.isTypeSupported\(mime\)\) throw new Error\(t\("fleet\.camera\.stream_unsupported"\)\)/, "no silent black tile in a browser that cannot decode it");
});

test("coming back to the tab reconnects the visible tiles and the camera modal", () => {
  assert.match(appSrc, /loadFiles\(\); loadFleet\(\); camStreamResume\(\);/);
  assert.match(fnSrc(appSrc, "camStreamResume"), /CAM_STREAM_OBSERVER\.unobserve\(v\); CAM_STREAM_OBSERVER\.observe\(v\);/);
});

test("the relayed stream shares the WebRTC tiles' lifecycle: every teardown path closes it", () => {
  assert.match(fnSrc(appSrc, "closeCamRtc"), /^function closeCamRtc\(id\)\{\n\s*closeCamStream\(id\);/, "closed even when no RTC session exists");
  assert.match(fnSrc(appSrc, "closeAllCamRtc"), /closeAllCamStream\(false\);/);
  assert.match(appSrc, /if\(document\.hidden\)\{ closeAllCamRtc\(\); closeAllCamStream\(true\); return; \}/);
  assert.match(fnSrc(appSrc, "closeSnapshot"), /closeCamStream\("snap"\);/);
});

test("Camera View mounts the relayed stream for a cameraStream printer, before the other transports", () => {
  const fn = fnSrc(appSrc, "reconcileFleetCards");
  assert.match(fn, /if\(p\.capabilities\?\.cameraStream\) mountCamStream\(slot, p\.id\);\s*\n\s*else if\(p\.capabilities\?\.cameraWebrtc/);
});

test("the player uses MSE (works on plain-http LAN pages), the server's codec, and stays at the live edge", () => {
  const fn = fnSrc(appSrc, "openCamStream");
  assert.match(fnSrc(appSrc, "camStreamMediaSource"), /window\.ManagedMediaSource \|\| window\.MediaSource/);
  assert.match(fn, /r\.headers\.get\("X-SnapCon-Codec"\)/);
  assert.match(fn, /MS\.isTypeSupported\(mime\)/);
  assert.match(fn, /video\.disableRemotePlayback=true/, "ManagedMediaSource refuses to open without it");
  assert.match(fn, /end-video\.currentTime>2\.5\) video\.currentTime=/);
  assert.match(fn, /sb\.remove\(/, "the buffer is trimmed — a live view is not a recording");
  assert.doesNotMatch(appSrc, /new VideoDecoder\(/, "no WebCodecs: it is unavailable on http:// LAN pages");
});

test("the camera modal shows a relayed camera live, and the tile placeholder is retryable", () => {
  assert.match(fnSrc(appSrc, "loadSnapshot"), /streamPrinter\.capabilities\?\.cameraStream[\s\S]*?openCamStream\("snap",forPrinter,video\)/);
  assert.match(fnSrc(appSrc, "camStreamObserver"), /camShotPlaceholderEl\(t\("fleet\.camera\.no_feed"\),\(\)=>\{/);
});

test("server: /api/camera-stream is authenticated, group-checked, capability-gated and unsubscribes on disconnect", () => {
  const start = serverSrc.indexOf('app.get("/api/camera-stream", requireAuth,');
  assert.ok(start > 0);
  const route = serverSrc.slice(start, serverSrc.indexOf("\napp.", start + 10));
  assert.match(route, /printerVisibleTo\(req\.user, p\)/);
  assert.match(route, /getCapabilities\(p\.connector, p\)\.cameraStream/);
  assert.match(route, /"Content-Type": "video\/mp4"/);
  assert.match(route, /"X-SnapCon-Codec": codec/);
  assert.match(route, /req\.on\("close", finish\)/);
  assert.match(route, /if \(sub\) sub\.unsubscribe\(\);/);
  assert.match(route, /backlog: \(\) => res\.writableLength/, "a slow viewer can be dropped by the relay");
});

for (const loc of ["en", "es"]) {
  test(`${loc}.json has the relayed camera's strings`, () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", loc + ".json"), "utf8"));
    for (const k of ["live", "stream_paused", "stream_unsupported"]) assert.ok(j.fleet.camera[k] && j.fleet.camera[k].trim(), k);
  });
}

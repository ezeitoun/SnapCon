// connectors/snapmaker-u1-firmware.js — firmware update for the Snapmaker U1
// over the LAN, with no USB stick and no Snapmaker cloud.
//
// WHY THIS EXISTS AS ITS OWN FILE: nothing here belongs to the status/control
// surface the two U1 connectors implement. Flashing is a rare, destructive,
// multi-minute operation with its own failure modes, so it stays out of
// snapmaker-u1-klipper.js and snapmaker-u1-klipper-ws.js entirely and is
// required explicitly by whatever wants it. No connector exports change.
//
// HOW IT WORKS. The U1's firmware operations live in `unisrv`, a closed
// Snapmaker service reachable only over the printer's internal MQTT bus:
//
//     system.get_device_info          req_id
//     system.upgrade_check_remote     req_id                (cloud only)
//     system.upgrade_download_firmware req_id               (cloud only)
//     system.upgrade                  req_id, type, filepath
//
// u1-moonraker's repeater.py registers those as JSON-RPC methods, but on
// shipped firmware (verified on 1.5.2.13) the repeater's system.* handler
// NEVER RETURNS — no reply, no error, not even a line in moonraker.log. The
// camera endpoints in the same file work, which is why cameraRpc() in
// snapmaker-u1-klipper.js is fine as-is; the system ones are not. Note that
// cameraRpc resolves on the first message rather than matching an id, so it
// would report success here even when nothing answered.
//
// So this file bypasses the repeater and speaks to the MQTT bus directly.
// Moonraker registers /server/mqtt/publish and /server/mqtt/subscribe with
// only the *MQTT* transport excluded, so both are callable over the same
// WebSocket the connectors already use. Subscribe to system/response first
// (the call blocks until a message lands), then publish the JSON-RPC envelope
// the repeater would have sent. unisrv answers in about 10ms.
//
// `system.upgrade` with type "local" passes our `filepath` straight to
// /home/lava/bin/systemUpgrade.sh — the same script the touchscreen's Local
// Update uses — and accepts ANY absolute path, not just the udisk mount.
// Combined with Moonraker's 4 GB file upload, that is the whole trick:
// upload the image to /userdata/gcodes, then name it as filepath.
//
// Verified end to end on 2026-08-26: 1.5.2.13_20260722102206 ->
// 1.6.0.267_20260815150420 over the network.
//
// TWO THINGS THE CALLER MUST KNOW:
//
//  1. Every unisrv reply is an ACKNOWLEDGEMENT, not a result. system.upgrade
//     returns {"state":"success"} for a path that does not exist. The real
//     outcome arrives later as notify_system_upgrade on system/notification.
//     Never report success to a user from the RPC reply alone.
//
//  2. A successful flash kills the connection. Expect
//     notify_klippy_disconnected followed by the socket closing as services
//     go down to write the image; the printer returns minutes later on the
//     new version. Disconnection here means progress, not failure.
//
// SECURITY: /access/info returns trusted:true for any client on a private
// LAN — no key, no token, no pairing. Anything on the network can upload a
// file to a U1 and tell it to flash that file as firmware. Treat this module
// as privileged and never expose it on an unauthenticated route.
"use strict";

const { createHash } = require("node:crypto");
const zlib = require("node:zlib");
const fs = require("node:fs/promises");
const path = require("node:path");

const http = require("./http-utils");

// unisrv's own callers use epoch-ms request ids; match them.
const nextReqId = () => Date.now();

const DEFAULT_ROOT = "gcodes";

// ---------------------------------------------------------------------------
// MQTT bridge over Moonraker's WebSocket
// ---------------------------------------------------------------------------

// Addressed exactly like cameraRpc in snapmaker-u1-klipper.js: same URL, same
// optional token, so a printer configured once works everywhere.
// Deliberate difference from cameraRpc: `.host` rather than `.hostname`, so a
// printer configured with an explicit port (http://ip:7125, which is where
// Moonraker also listens) reaches that port instead of silently falling back
// to 80. For the normal port-80 config the two are identical.
function wsUrlFor(p) {
  const host = new URL(http.baseUrl(p)).host;
  const token = p.token || "";
  return `ws://${host}/websocket${token ? "?token=" + encodeURIComponent(token) : ""}`;
}

// One websocket, one unisrv call, matched by id.
//
// Ordering matters: server.mqtt.subscribe does not return until a message
// arrives on the topic, so it must be in flight BEFORE the publish or the
// response is missed. Both calls carry an explicit timeout — Moonraker's
// handlers wait forever without one, which is the most likely explanation for
// the repeater's hang.
function mqttRpc(p, method, params = {}, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      return reject(new Error("Firmware update needs Node 21+ (no global WebSocket)"));
    }

    const reqId = nextReqId();
    const envelope = {
      jsonrpc: "2.0",
      id: reqId,
      method,
      params: { ...params, req_id: reqId },
    };

    let ws;
    try { ws = new WebSocket(wsUrlFor(p)); }
    catch (e) { return reject(new Error("Cannot open printer WebSocket: " + e.message)); }

    let settled = false;
    const subId = 1;
    const pubId = 2;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`${method}: no response in ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs + 5000
    );

    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: subId, method: "server.mqtt.subscribe",
        params: { topic: "system/response", qos: 1, timeout: timeoutMs / 1000 },
      }));
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: pubId, method: "server.mqtt.publish",
        params: { topic: "system/request", payload: envelope, qos: 1, timeout: 10 },
      }));
    };

    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      // The printer broadcasts notify_* to every socket roughly once a second.
      // Anything without our ids is noise.
      if (msg.id === pubId && msg.error) {
        return finish(new Error("MQTT publish failed: " + (msg.error.message || "unknown")));
      }
      if (msg.id !== subId) return;
      if (msg.error) {
        return finish(new Error("MQTT subscribe failed: " + (msg.error.message || "unknown")));
      }

      const payload = msg.result && msg.result.payload;
      if (!payload) return finish(new Error("Empty response from the printer"));
      if (payload.error) {
        const e = new Error(payload.error.message || "unisrv error");
        e.code = payload.error.code;
        return finish(e);
      }
      finish(null, payload.result || {});
    };

    ws.onerror = () => finish(new Error("Printer WebSocket error"));
    ws.onclose = () => finish(new Error(`${method}: printer closed the connection`));
  });
}

// ---------------------------------------------------------------------------
// Read-only queries
// ---------------------------------------------------------------------------

// { fullversion, version, hwver, product_code, serial_number, mac_address }
async function getDeviceInfo(p) {
  return mqttRpc(p, "system.get_device_info");
}
exports.getDeviceInfo = getDeviceInfo;

// Where each Moonraker root actually lives on the printer's disk. An uploaded
// file's absolute path — the thing system.upgrade needs — is this plus the
// file name, and it is NOT guessable: 'gcodes' is /userdata/gcodes on 1.5.x,
// not the /home/lava/printer_data/gcodes the Moonraker defaults imply.
async function getRoots(p) {
  const { ok, status, json } = await http.fetchJSONTimeout(
    http.baseUrl(p) + "/server/files/roots", 8000);
  if (!ok) throw new Error("Could not read file roots (HTTP " + status + ")");
  const out = {};
  for (const r of json.result || []) out[r.name] = r.path;
  return out;
}
exports.getRoots = getRoots;

async function getFreeBytes(p, root = DEFAULT_ROOT) {
  const { ok, json } = await http.fetchJSONTimeout(
    `${http.baseUrl(p)}/server/files/directory?path=${encodeURIComponent(root)}`, 8000);
  if (!ok) return null;
  const du = (json.result || {}).disk_usage || {};
  return typeof du.free === "number" ? du.free : null;
}
exports.getFreeBytes = getFreeBytes;

// ---------------------------------------------------------------------------
// Getting the image onto the printer
// ---------------------------------------------------------------------------

// Upload a firmware image and return its absolute path on the printer.
//
// openAsBlob streams the file rather than buffering it — a firmware package is
// ~250 MB and this process also runs a print queue, so reading it into memory
// is not acceptable. No timeout is imposed: the upload legitimately takes
// minutes on a slow network, and aborting halfway leaves a truncated image in
// a place someone might later flash.
// onProgress(sent, total) fires per chunk while the image is going up.
//
// Streams through http-utils' uploadWithProgress — the same uploader every
// print already uses — rather than fetch + openAsBlob. Both stream, but
// Node's fetch exposes no upload-progress hook at all, and a ~250 MB transfer
// with nothing moving on screen is indistinguishable from a hang. No timeout
// is imposed either way: the upload legitimately takes minutes, and aborting
// halfway leaves a truncated image somewhere someone might later flash.
async function uploadFirmware(p, localPath, { root = DEFAULT_ROOT, subdir = "", onProgress = null } = {}) {
  const name = path.basename(localPath);
  const stat = await fs.stat(localPath);

  const free = await getFreeBytes(p, root);
  if (free !== null && free < stat.size * 2) {
    throw new Error(
      `Not enough space on the printer: ${(free / 1e9).toFixed(2)} GB free, ` +
      `need roughly ${((stat.size * 2) / 1e9).toFixed(2)} GB to store and unpack the image`);
  }

  // uploadWithProgress writes sent/total onto this object as bytes move; the
  // accessor turns those writes into onProgress calls without http-utils
  // needing to know a caller wants them.
  //
  // UNITS: `total` is the whole multipart REQUEST BODY, not the bare file —
  // that is what is actually being transferred. The framing adds ~166 bytes,
  // so on a ~250 MB image the figure shown to a user is the file size to
  // every digit they can read.
  const meter = {
    total: 0, _sent: 0,
    get sent() { return this._sent; },
    set sent(v) { this._sent = v; if (onProgress) onProgress(v, this.total); },
  };
  let body;
  try {
    body = await http.uploadWithProgress(http.baseUrl(p), localPath, name, meter);
  } catch (e) {
    throw new Error("Upload failed: " + e.message);
  }
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new Error("Upload returned a response that is not JSON: " + String(body).slice(0, 300)); }
  const item = (parsed.result || {}).item || {};
  const roots = await getRoots(p);
  if (!roots[root]) throw new Error(`Printer has no '${root}' root`);

  return {
    name: item.path || name,
    size: item.size,
    remotePath: roots[root].replace(/\/+$/, "") + "/" + (item.path || name),
  };
}
exports.uploadFirmware = uploadFirmware;

// --- verification ---------------------------------------------------------
//
// Something must confirm the printer holds the bytes we meant to send: a
// truncated image that still looks plausible is the realistic way this bricks
// a machine. The printer exposes no hash endpoint, so there are three ways to
// get that confirmation, in descending order of preference:
//
//   "crc"    Have the PRINTER compute it. POST /server/files/zip with
//            store_only:true archives with ZIP_STORED — no compression, but
//            the zip format stores a CRC-32 per entry that the printer
//            computes while copying. The central directory holding it sits at
//            the end of the archive, and Moonraker serves files through
//            Tornado's StaticFileHandler, which honors HTTP Range. So we read
//            about a kilobyte instead of a quarter gigabyte. Costs the printer
//            one read+write pass and temporary disk equal to the image.
//
//   "sample" No server-side work: compare a handful of Range-fetched windows
//            (head, tail, evenly spaced middles) against the local file. A few
//            MB over the wire. Catches truncation and torn writes; will not
//            catch a single flipped byte between windows.
//
//   "md5"    Download the whole thing and hash it. Certain, and by far the
//            most bytes. Kept for when you want no cleverness in the path.
//
// All three check length first, because a short file is the failure that
// actually happens.

function fileUrl(p, root, name) {
  return `${http.baseUrl(p)}/server/files/${root}/${encodeURIComponent(name)}`;
}

// onProgress(read, total) — in "crc" mode the network carries only a few KB,
// so THIS local pass over the image is the part that takes real time and is
// the only honest thing to show a progress bar for.
async function localCrc32(localPath, { onProgress = null } = {}) {
  let crc = 0, size = 0;
  const total = (await fs.stat(localPath)).size;
  const fh = await fs.open(localPath, "r");
  try {
    for await (const chunk of fh.createReadStream()) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      if (onProgress) onProgress(size, total);
    }
  } finally { await fh.close(); }
  return { crc, size };
}

async function fetchRange(p, root, name, start, end) {
  const res = await fetch(fileUrl(p, root, name), {
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (res.status !== 206) {
    throw new Error(`Printer did not honor a Range request (HTTP ${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Parse CRC-32 and uncompressed size out of a stored zip's central directory.
function parseZipCentralDirectory(cdBuf) {
  if (cdBuf.readUInt32LE(0) !== 0x02014b50) {
    throw new Error("Unexpected zip central directory signature");
  }
  return { crc: cdBuf.readUInt32LE(16), size: cdBuf.readUInt32LE(24) };
}

// Ask the printer to CRC the file for us. Returns { crc, size }.
async function remoteCrc32(p, name, { root = DEFAULT_ROOT } = {}) {
  const zipName = `verify-${Date.now()}.zip`;
  const res = await fetch(`${http.baseUrl(p)}/server/files/zip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dest: `${root}/${zipName}`,
      items: [`${root}/${name}`],
      store_only: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Printer could not archive the file (HTTP ${res.status})`);
  }
  await res.json();

  try {
    // The EOCD is within the last 64KB unless there is a huge zip comment.
    const head = await fetch(fileUrl(p, root, zipName), { headers: { Range: "bytes=0-0" } });
    const total = Number((head.headers.get("content-range") || "").split("/")[1]);
    if (!Number.isFinite(total)) throw new Error("Printer did not report the archive size");
    const tailStart = Math.max(0, total - 65536);
    const tail = await fetchRange(p, root, zipName, tailStart, total - 1);

    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("Could not find the zip end-of-central-directory");
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) {
      throw new Error("zip64 archive — file too large for this check");
    }
    const cdBuf = await fetchRange(p, root, zipName, cdOffset, cdOffset + cdSize - 1);
    return parseZipCentralDirectory(cdBuf);
  } finally {
    // Never leave a quarter-gigabyte scratch archive on the printer.
    await deleteRemote(p, zipName, { root }).catch(() => {});
  }
}
exports.remoteCrc32 = remoteCrc32;

async function remoteSize(p, name, { root = DEFAULT_ROOT } = {}) {
  const res = await fetch(fileUrl(p, root, name), { headers: { Range: "bytes=0-0" } });
  if (res.status !== 206) throw new Error(`Could not stat the uploaded file (HTTP ${res.status})`);
  const total = Number((res.headers.get("content-range") || "").split("/")[1]);
  if (!Number.isFinite(total)) throw new Error("Printer did not report the file size");
  return total;
}
exports.remoteSize = remoteSize;

async function verifyBySampling(p, localPath, { root, name, windows = 5, windowBytes = 1 << 20 }) {
  const stat = await fs.stat(localPath);
  const size = await remoteSize(p, name, { root });
  if (size !== stat.size) {
    return { ok: false, mode: "sample", reason: "size", localSize: stat.size, remoteSize: size };
  }
  const fh = await fs.open(localPath, "r");
  try {
    for (let i = 0; i < windows; i++) {
      const start = windows === 1 ? 0
        : Math.min(size - 1, Math.floor((size - windowBytes) * (i / (windows - 1))));
      const from = Math.max(0, start);
      const to = Math.min(size - 1, from + windowBytes - 1);
      const remote = await fetchRange(p, root, name, from, to);
      const local = Buffer.alloc(to - from + 1);
      await fh.read(local, 0, local.length, from);
      if (!local.equals(remote)) {
        return { ok: false, mode: "sample", reason: "content", offset: from };
      }
    }
  } finally { await fh.close(); }
  return { ok: true, mode: "sample", localSize: stat.size, remoteSize: size, windows };
}

async function verifyByMd5(p, localPath, { root, name, onProgress = null }) {
  const localHash = createHash("md5");
  let localSize = 0;
  const fh = await fs.open(localPath, "r");
  try {
    for await (const chunk of fh.createReadStream()) {
      localSize += chunk.length;
      localHash.update(chunk);
    }
  } finally { await fh.close(); }

  const res = await fetch(fileUrl(p, root, name));
  if (!res.ok) throw new Error(`Could not read the uploaded file back (HTTP ${res.status})`);
  const remoteHash = createHash("md5");
  let rSize = 0;
  for await (const chunk of res.body) {
    rSize += chunk.length;
    remoteHash.update(chunk);
    // md5 mode pulls the whole image back, so the read-back is what moves —
    // localSize is the denominator, since a differing remote size is exactly
    // what this check exists to catch.
    if (onProgress) onProgress(rSize, localSize);
  }

  const local = localHash.digest("hex");
  const remote = remoteHash.digest("hex");
  return { ok: local === remote && localSize === rSize, mode: "md5",
           local, remote, localSize, remoteSize: rSize };
}

// mode: "crc" (default) | "sample" | "md5" | "none"
// "crc" falls back to "sample" if the printer's zip endpoint is unavailable —
// an older firmware should degrade to a weaker check, never to no check.
//
// "none" is the exception, and it is never reached by accident: nothing
// defaults to it, no fallback lands on it, and the only way to select it is a
// caller passing it explicitly. See updateFromFile, which skips this function
// entirely rather than having it return a fake pass.
async function verifyFirmware(p, localPath, {
  root = DEFAULT_ROOT, remoteName, mode = "crc", onProgress = null,
} = {}) {
  const name = remoteName || path.basename(localPath);

  if (mode === "md5") return verifyByMd5(p, localPath, { root, name, onProgress });
  if (mode === "sample") return verifyBySampling(p, localPath, { root, name });

  const local = await localCrc32(localPath, { onProgress });
  let remote;
  try {
    remote = await remoteCrc32(p, name, { root });
  } catch (e) {
    const fallback = await verifyBySampling(p, localPath, { root, name });
    fallback.fellBackFrom = "crc";
    fallback.crcError = e.message;
    return fallback;
  }
  return {
    ok: local.crc === remote.crc && local.size === remote.size,
    mode: "crc",
    local: local.crc >>> 0,
    remote: remote.crc >>> 0,
    localSize: local.size,
    remoteSize: remote.size,
  };
}
exports.verifyFirmware = verifyFirmware;

async function deleteRemote(p, name, { root = DEFAULT_ROOT } = {}) {
  const url = `${http.baseUrl(p)}/server/files/${root}/${encodeURIComponent(name)}`;
  const res = await http.fetchTimeout(url, 30000, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
  return true;
}
exports.deleteRemote = deleteRemote;

// List everything actually sitting in a root, including non-gcode files.
//
// Two different listings, and the difference matters here:
//   /server/files/list?root=gcodes   filters to VALID_GCODE_EXTS
//                                    ['.gcode','.g','.gco','.ufp'] — a .bin is
//                                    invisible to it, which is why an uploaded
//                                    firmware image never pollutes the print
//                                    file manager, and also why a leftover one
//                                    is invisible to the user.
//   /server/files/directory?path=... does not filter — everything shows.
//
// Use this to sweep for images orphaned by an interrupted update. Nothing else
// in SnapCon will ever surface them.
async function listImages(p, { root = DEFAULT_ROOT, subdir = "", match = /\.bin$/i } = {}) {
  const target = subdir ? `${root}/${subdir}` : root;
  const { ok, status, json } = await http.fetchJSONTimeout(
    `${http.baseUrl(p)}/server/files/directory?path=${encodeURIComponent(target)}`, 10000);
  if (!ok) throw new Error(`Could not list ${target} (HTTP ${status})`);
  return (json.result.files || [])
    .filter(f => match.test(f.filename))
    .map(f => ({ name: f.filename, size: f.size, modified: f.modified }));
}
exports.listImages = listImages;

// ---------------------------------------------------------------------------
// Flashing
// ---------------------------------------------------------------------------

// Start a local flash. Resolves as soon as unisrv ACKNOWLEDGES the request —
// which it does even for a nonexistent path. The caller must watch
// system/notification (below) for the real outcome.
async function startLocalUpgrade(p, remotePath) {
  if (!remotePath || !remotePath.startsWith("/")) {
    throw new Error("filepath must be an absolute path on the printer");
  }
  return mqttRpc(p, "system.upgrade", { type: "local", filepath: remotePath });
}
exports.startLocalUpgrade = startLocalUpgrade;

// Listen on system/notification until the flash resolves or `seconds` elapse.
//
// Resolves { outcome, event } where outcome is:
//   "failed"       unisrv reported a failure — `event` has its message
//   "disconnected" the printer dropped us; on a real flash this is the
//                  EXPECTED path, since services go down to write the image
//   "timeout"      nothing conclusive within the window
function watchUpgrade(p, { seconds = 900, onEvent = () => {} } = {}) {
  return new Promise(resolve => {
    if (typeof WebSocket === "undefined") {
      return resolve({ outcome: "timeout", event: null });
    }
    let ws;
    try { ws = new WebSocket(wsUrlFor(p)); }
    catch { return resolve({ outcome: "disconnected", event: null }); }

    let settled = false;
    let nextId = 100;
    const finish = (outcome, event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ outcome, event });
    };
    const timer = setTimeout(() => finish("timeout", null), seconds * 1000);

    // Each subscribe returns after ONE message, so re-arm after every hit for
    // the whole window.
    const arm = () => {
      if (settled || ws.readyState !== 1) return;
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: nextId++, method: "server.mqtt.subscribe",
        params: { topic: "system/notification", qos: 1, timeout: 30 },
      }));
    };

    ws.onopen = arm;
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      // Klipper going away is the first sign a real flash has begun.
      if (msg.method === "notify_klippy_disconnected") {
        onEvent({ kind: "klippy_disconnected" });
        return;
      }
      if (typeof msg.id !== "number" || msg.id < 100) return;

      // A subscribe that timed out is normal; just re-arm.
      if (msg.error) return arm();

      const payload = (msg.result || {}).payload;
      const params = payload && payload.params;
      const state = Array.isArray(params) ? params[0] : params;
      if (state) {
        onEvent({ kind: "upgrade", state });
        if (String(state.state).toLowerCase() === "failed") {
          return finish("failed", state);
        }
      }
      arm();
    };
    ws.onerror = () => {};
    // The socket closing mid-flash is expected, not an error.
    ws.onclose = () => finish("disconnected", null);
  });
}
exports.watchUpgrade = watchUpgrade;

// ---------------------------------------------------------------------------
// The whole operation
// ---------------------------------------------------------------------------

// Upload, verify, flash, and wait. Returns { before, after, outcome }.
//
// `after` is null when the printer has not come back yet — that is not a
// failure, it is a quarter-gigabyte image being written. Poll getDeviceInfo
// until it answers.
async function updateFromFile(p, localPath, {
  root = DEFAULT_ROOT,
  verify = "crc",
  keepImage = false,
  watchSeconds = 900,
  onStep = () => {},
  // Byte progress for the two phases that move a quarter-gigabyte:
  // onProgress(phase, sent, total) where phase is "upload" or "verify".
  onProgress = null,
  // Awaited gate at the last point before anything irreversible happens.
  // onStep cannot serve this purpose: its calls are synchronous and their
  // return values discarded, so a rejected promise from one would be
  // dropped and the flash would proceed anyway. Throwing from here aborts
  // with nothing written; the uploaded image is left on the printer, inert.
  beforeFlash = null,
} = {}) {
  const before = await getDeviceInfo(p);
  onStep({ step: "device", info: before });

  onStep({ step: "upload", localPath });
  const up = await uploadFirmware(p, localPath, {
    root, onProgress: onProgress && ((sent, total) => onProgress("upload", sent, total)) });
  onStep({ step: "uploaded", ...up });

  // "none" skips the check outright rather than calling verifyFirmware and
  // having it hand back a pass it did not earn — a function that answers
  // "ok: true" without looking is the kind of thing a later reader trusts.
  let v = { mode: "none" };
  if (verify === "none") {
    onStep({ step: "verify-skipped" });
  } else {
    onStep({ step: "verify", mode: verify });
    v = await verifyFirmware(p, localPath, {
      root, remoteName: up.name, mode: verify,
      onProgress: onProgress && ((sent, total) => onProgress("verify", sent, total)) });
    if (!v.ok) {
      if (!keepImage) await deleteRemote(p, up.name, { root }).catch(() => {});
      throw new Error(
        `Uploaded image does not match the local file (${v.mode} check: local ` +
        `${v.local ?? v.localSize}, printer ${v.remote ?? v.remoteSize}` +
        `${v.reason ? ", differs by " + v.reason : ""}) — nothing was flashed`);
    }
    onStep({ step: "verified", mode: v.mode, local: v.local, fellBackFrom: v.fellBackFrom });
  }

  // Last exit. Upload and verification are done and cost minutes — long
  // enough for the printer to have started a job since this began. Flashing
  // then destroys that job and leaves the machine mid-write.
  if (beforeFlash) await beforeFlash();

  onStep({ step: "flash", remotePath: up.remotePath });
  await startLocalUpgrade(p, up.remotePath);

  const { outcome, event } = await watchUpgrade(p, {
    seconds: watchSeconds,
    onEvent: e => onStep({ step: "progress", ...e }),
  });

  if (outcome === "failed") {
    if (!keepImage) await deleteRemote(p, up.name, { root }).catch(() => {});
    throw new Error("Firmware update failed: " + (event && event.message || "see unisrv.log"));
  }

  let after = null;
  try { after = await getDeviceInfo(p); } catch { /* still rebooting */ }

  // Only clean up once the printer is back and reporting a version; deleting
  // while it may still be reading the file would be reckless.
  if (!keepImage && after) await deleteRemote(p, up.name, { root }).catch(() => {});

  return { before, after, outcome, image: up, verify: v.mode, fellBackFrom: v.fellBackFrom || null };
}
exports.updateFromFile = updateFromFile;

// ---------------------------------------------------------------------------
// CLI: node connectors/snapmaker-u1-firmware.js <ip> info|update <file>
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [, , host, cmd, arg] = process.argv;
  if (!host || !cmd) {
    console.error("usage: node snapmaker-u1-firmware.js <printer-ip> info");
    console.error("       node snapmaker-u1-firmware.js <printer-ip> update <firmware.bin>");
    process.exit(2);
  }
  const printer = { name: host, url: `http://${host}`, token: "" };

  (async () => {
    if (cmd === "info") {
      console.log(JSON.stringify(await getDeviceInfo(printer), null, 2));
      console.log("roots:", JSON.stringify(await getRoots(printer), null, 2));
      return;
    }
    if (cmd === "update") {
      if (!arg) throw new Error("update needs a path to a firmware .bin");
      const res = await updateFromFile(printer, arg, {
        onStep: s => {
          if (s.step === "device")   console.log("current:", s.info.fullversion);
          if (s.step === "uploaded") console.log("uploaded:", s.remotePath, `(${s.size} bytes)`);
          if (s.step === "verified") console.log(`verified (${s.mode}):`, s.local);
          if (s.step === "flash")    console.log("flashing — do not cut power");
          if (s.step === "progress") console.log("  ", JSON.stringify(s.state || s.kind));
        },
      });
      console.log(res.after
        ? `done: ${res.before.fullversion} -> ${res.after.fullversion}`
        : `flash started and the printer went offline to write it (expected). ` +
          `Re-run 'info' in a few minutes to confirm.`);
      return;
    }
    throw new Error("unknown command: " + cmd);
  })().catch(e => { console.error("error:", e.message); process.exit(1); });
}

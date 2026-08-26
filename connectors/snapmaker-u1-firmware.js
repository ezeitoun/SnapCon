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
const { openAsBlob } = require("node:fs");
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
async function uploadFirmware(p, localPath, { root = DEFAULT_ROOT } = {}) {
  const name = path.basename(localPath);
  const stat = await fs.stat(localPath);

  const free = await getFreeBytes(p, root);
  if (free !== null && free < stat.size * 2) {
    throw new Error(
      `Not enough space on the printer: ${(free / 1e9).toFixed(2)} GB free, ` +
      `need roughly ${((stat.size * 2) / 1e9).toFixed(2)} GB to store and unpack the image`);
  }

  const form = new FormData();
  form.append("root", root);
  form.append("path", "");
  form.append("file", await openAsBlob(localPath), name);

  const res = await fetch(http.baseUrl(p) + "/server/files/upload",
                          { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Upload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const item = ((await res.json()).result || {}).item || {};
  const roots = await getRoots(p);
  if (!roots[root]) throw new Error(`Printer has no '${root}' root`);

  return {
    name: item.path || name,
    size: item.size,
    remotePath: roots[root].replace(/\/+$/, "") + "/" + (item.path || name),
  };
}
exports.uploadFirmware = uploadFirmware;

// Read the uploaded copy back and compare MD5 against the local file.
//
// Do not skip this. A truncated or corrupted image that still passes a size
// check is the realistic way this bricks a printer, and the check costs one
// download over the LAN.
async function verifyFirmware(p, localPath, { root = DEFAULT_ROOT, remoteName } = {}) {
  const name = remoteName || path.basename(localPath);

  const localHash = createHash("md5");
  let localSize = 0;
  const fh = await fs.open(localPath, "r");
  try {
    for await (const chunk of fh.createReadStream()) {
      localSize += chunk.length;
      localHash.update(chunk);
    }
  } finally { await fh.close(); }

  const url = `${http.baseUrl(p)}/server/files/${root}/${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read the uploaded file back (HTTP ${res.status})`);

  const remoteHash = createHash("md5");
  let remoteSize = 0;
  for await (const chunk of res.body) {
    remoteSize += chunk.length;
    remoteHash.update(chunk);
  }

  const local = localHash.digest("hex");
  const remote = remoteHash.digest("hex");
  return { ok: local === remote && localSize === remoteSize, local, remote, localSize, remoteSize };
}
exports.verifyFirmware = verifyFirmware;

async function deleteRemote(p, name, { root = DEFAULT_ROOT } = {}) {
  const url = `${http.baseUrl(p)}/server/files/${root}/${encodeURIComponent(name)}`;
  const res = await http.fetchTimeout(url, 30000, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
  return true;
}
exports.deleteRemote = deleteRemote;

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
  keepImage = false,
  watchSeconds = 900,
  onStep = () => {},
  // Awaited gate at the last point before anything irreversible happens.
  // onStep cannot serve this purpose: its calls are synchronous and their
  // return values discarded, so a rejected promise from one would be
  // dropped and the flash would proceed anyway. Throwing from here aborts
  // with nothing written; the uploaded image is left on the printer.
  beforeFlash = null,
} = {}) {
  const before = await getDeviceInfo(p);
  onStep({ step: "device", info: before });

  onStep({ step: "upload", localPath });
  const up = await uploadFirmware(p, localPath, { root });
  onStep({ step: "uploaded", ...up });

  onStep({ step: "verify" });
  const v = await verifyFirmware(p, localPath, { root, remoteName: up.name });
  if (!v.ok) {
    if (!keepImage) await deleteRemote(p, up.name, { root }).catch(() => {});
    throw new Error(
      `Uploaded image does not match the local file (local ${v.local}, ` +
      `printer ${v.remote}) — nothing was flashed`);
  }
  onStep({ step: "verified", md5: v.local });

  // Last exit. Upload and verification are done and cost minutes — long
  // enough for the printer to have started a job since this began.
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

  return { before, after, outcome, image: up };
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
          if (s.step === "verified") console.log("verified md5:", s.md5);
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

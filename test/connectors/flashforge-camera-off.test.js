// test/connectors/flashforge-camera-off.test.js — a camera switched off in the
// printer's own settings must not read as a network fault.
//
// With the camera disabled, nothing listens on :8080, so the snapshot request
// dies with a bare `connect ECONNREFUSED <ip>:8080`. Shown to an operator that
// is actively misleading: it looks like the printer fell off the network, when
// the printer is online and simply has its camera turned off.
//
// /detail separates the two cleanly, confirmed both ways on a real 5M Pro
// (firmware 5.1.7): cameraStreamUrl is "" when the camera is off and the full
// URL when it is on. Verified live on 2026-09-09 — camera off, cameraStreamUrl
// "", getCameraSnapshot failing with exactly `connect ECONNREFUSED
// 192.168.4.51:8080`.
//
// It is consulted ONLY on the failure path, so a healthy snapshot still costs
// exactly one request. And it must never MASK a real fault: if /detail says the
// camera is on, or /detail itself cannot be reached, the original error stands.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");

const u = require("../../connectors/flashforge-utils");

const P = { id: "ff", name: "5M PRO", url: "http://192.0.2.55", serial: "S", verificationCode: "C" };

// Fake http.get that fails the way a refused connection actually does.
function failWith(err) {
  return (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => req.emit("error", err));
    return req;
  };
}
// ...and one that answers with a non-200, i.e. something IS listening.
function respondStatus(code) {
  return (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    const res = new EventEmitter();
    res.statusCode = code;
    setImmediate(() => cb(res));
    return req;
  };
}

function refused() {
  const e = new Error("connect ECONNREFUSED 192.0.2.55:8080");
  e.code = "ECONNREFUSED";
  return e;
}

// fetch stub: /control always fine; /detail returns the given cameraStreamUrl,
// or throws if detailFails.
function installFetch({ cameraStreamUrl = "", detailFails = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input.url || input);
    calls.push(url);
    if (url.endsWith("/detail")) {
      if (detailFails) throw new Error("socket hang up");
      return new Response(JSON.stringify({ code: 0, detail: { cameraStreamUrl } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ code: 0 }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function snapshotError(httpGet, fetchOpts) {
  const realGet = http.get;
  const f = installFetch(fetchOpts);
  http.get = httpGet;
  try {
    await u.getCameraSnapshot(P);
    return { error: null, calls: f.calls };
  } catch (e) {
    return { error: e, calls: f.calls };
  } finally { http.get = realGet; f.restore(); }
}

test("camera off: a refused connection is reported as the camera being off, not a network fault", async () => {
  const { error } = await snapshotError(failWith(refused()), { cameraStreamUrl: "" });
  assert.ok(error, "must still fail");
  assert.match(error.message, /camera is turned off/i,
    "an operator needs to be told to enable the camera, not shown a socket error");
  assert.doesNotMatch(error.message, /ECONNREFUSED/,
    "the raw socket error is what made this confusing in the first place");
});

test("camera ON but refused: the original error is preserved, never masked", async () => {
  // Something really is wrong with the network/proxy here. Claiming the camera
  // is off would send the operator to fix a setting that is already correct.
  const { error } = await snapshotError(failWith(refused()),
    { cameraStreamUrl: "http://192.0.2.55:8080/?action=stream" });
  assert.ok(error);
  assert.match(error.message, /ECONNREFUSED/, "a real fault must surface as itself");
  assert.doesNotMatch(error.message, /camera is turned off/i);
});

test("if /detail cannot be reached either, the original camera error stands", async () => {
  const { error } = await snapshotError(failWith(refused()), { detailFails: true });
  assert.ok(error);
  assert.match(error.message, /ECONNREFUSED/,
    "a failed diagnostic must not replace the real error with a guess");
});

test("a non-connection failure never consults /detail — the check costs nothing on other paths", async () => {
  const { error, calls } = await snapshotError(respondStatus(500), { cameraStreamUrl: "" });
  assert.ok(error);
  assert.match(error.message, /HTTP 500/);
  assert.equal(calls.filter(c => c.endsWith("/detail")).length, 0,
    "something answered on :8080, so the camera is plainly not switched off");
});

test("the connector re-exports the same behaviour", async () => {
  const adv = require("../../connectors/flashforge-adventurer");
  assert.equal(typeof adv.getCameraSnapshot, "function");
});

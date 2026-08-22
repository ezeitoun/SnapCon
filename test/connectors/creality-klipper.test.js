// test/connectors/creality-klipper.test.js — regression coverage for the
// Creality Filament System (CFS) read-only status support: getCapabilities()
// switching filamentHeads on/off per-printer based on `filamentMode`, and
// decodeCfsHeads() correctly parsing the real boxsInfo websocket schema
// (confirmed against 3dg1luk43/ha_creality_ws's ws_client.py/const.py) into
// the same {loaded,hex,material,sub,official}[] shape other multi-head
// connectors (e.g. snapmaker-u1-klipper's decodeHeads) already return.
const test = require("node:test");
const assert = require("node:assert/strict");
const conn = require("../../connectors/creality-klipper");

test("getCapabilities: plain printer (no filamentMode) reports filamentHeads:false, unchanged from the static default", () => {
  const caps = conn.getCapabilities({});
  assert.equal(caps.filamentHeads, false);
});

test("getCapabilities: filamentMode:'cfs' reports filamentHeads:true", () => {
  const caps = conn.getCapabilities({ filamentMode: "cfs" });
  assert.equal(caps.filamentHeads, true);
});

test("getCapabilities: does not mutate the shared static capabilities object", () => {
  conn.getCapabilities({ filamentMode: "cfs" });
  assert.equal(conn.capabilities.filamentHeads, false);
});

test("getCapabilities: no headMapping capability regardless of filamentMode (print-start slot-selection mechanism is unconfirmed)", () => {
  assert.equal(conn.getCapabilities({}).headMapping, undefined);
  assert.equal(conn.getCapabilities({ filamentMode: "cfs" }).headMapping, undefined);
});

test("decodeCfsHeads: a single CFS box with a mix of loaded/empty slots", () => {
  const boxsInfo = {
    materialBoxs: [
      {
        id: 0, state: 1, type: 0, temp: 25, humidity: 30,
        materials: [
          { id: 0, vendor: "Creality", type: "PLA", name: "PLA", color: "FF0000", percent: 80, state: 1, selected: 1 },
          { id: 1, vendor: "Creality", type: "PETG", name: "PETG", color: "00FF00", percent: 50, state: 1, selected: 0 },
          { id: 2, vendor: "", type: "", name: "", color: "", percent: 0, state: 0, selected: 0 },
          { id: 3, vendor: "", type: "", name: "", color: "", percent: 0, state: 0, selected: 0 }
        ]
      }
    ]
  };
  const { heads, activeExt } = conn._internal.decodeCfsHeads(boxsInfo);
  assert.equal(heads.length, 4);
  assert.deepEqual(heads[0], { loaded: true, hex: "#FF0000", material: "PLA", sub: null, official: false });
  assert.equal(heads[1].loaded, true);
  assert.equal(heads[1].hex, "#00FF00");
  assert.equal(heads[2].loaded, false);
  assert.equal(heads[2].hex, null);
  assert.equal(heads[3].loaded, false);
  assert.equal(activeExt, 0);
});

test("decodeCfsHeads: multiple boxes flatten into one continuous heads array, slot index preserved for activeExt", () => {
  const boxsInfo = {
    materialBoxs: [
      { id: 0, materials: [
        { color: "FF0000", vendor: "Creality", selected: 0 },
        { color: "", vendor: "", selected: 0 }
      ] },
      { id: 1, materials: [
        { color: "0000FF", vendor: "Creality", selected: 1 },
        { color: "", vendor: "", selected: 0 }
      ] }
    ]
  };
  const { heads, activeExt } = conn._internal.decodeCfsHeads(boxsInfo);
  assert.equal(heads.length, 4);
  assert.equal(activeExt, 2); // first box's 2 slots (0,1), then box 1's slot 0 is global index 2
  assert.equal(heads[2].hex, "#0000FF");
});

test("decodeCfsHeads: no boxes / missing fields never throws, returns empty heads and null activeExt", () => {
  assert.deepEqual(conn._internal.decodeCfsHeads(null), { heads: [], activeExt: null });
  assert.deepEqual(conn._internal.decodeCfsHeads({}), { heads: [], activeExt: null });
  assert.deepEqual(conn._internal.decodeCfsHeads({ materialBoxs: [] }), { heads: [], activeExt: null });
});

test("decodeCfsHeads: a color missing the '#' prefix or given lowercase is still parsed and normalized to uppercase '#RRGGBB'", () => {
  const boxsInfo = { materialBoxs: [{ materials: [{ color: "#ab00ff", vendor: "x", selected: 0 }] }] };
  const { heads } = conn._internal.decodeCfsHeads(boxsInfo);
  assert.equal(heads[0].hex, "#AB00FF");
});

test("fetchCfsStatus resolves to null (never throws/hangs) when WebSocket is unavailable (Node <21 environment)", async () => {
  const original = global.WebSocket;
  delete global.WebSocket;
  try {
    const result = await conn._internal.fetchCfsStatus({ url: "http://127.0.0.1:1" });
    assert.equal(result, null);
  } finally {
    if (original !== undefined) global.WebSocket = original;
  }
});

// ---- Camera detection ----
// getCapabilities() switching camera on/off per-printer based on whether
// detectCamera actually confirmed a working snapshot URL for that specific
// unit — confirmed live against two real Ender-3 V3 Plus units of the same
// model, one with a camera attached and one without, so this can't be a
// fixed connector-level fact the way it is for U1/AD5X.
function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}
const p = { name: "Test Creality", url: "http://192.168.4.162:7125" };

test("getCapabilities: no cameraUrl reports camera:false, unchanged from the static default", () => {
  assert.equal(conn.getCapabilities({}).camera, false);
});

test("getCapabilities: a printer with a detected cameraUrl reports camera:true", () => {
  assert.equal(conn.getCapabilities({ cameraUrl: "http://192.168.4.162:8080/?action=snapshot" }).camera, true);
});

test("detectCamera throws when Moonraker itself is unreachable (caller must not cache this as a confirmed 'no camera')", async () => {
  await assert.rejects(() =>
    withMockFetch(async () => ({ ok: false, status: 502 }), () => conn.detectCamera(p))
  );
});

test("detectCamera returns null when Moonraker's own webcam registry is empty (confirmed no camera, e.g. the real .87 unit)", async () => {
  const result = await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ result: { webcams: [] } }) }),
    () => conn.detectCamera(p)
  );
  assert.equal(result, null);
});

test("detectCamera resolves the as-published relative URL when it actually works on the printer's own port", async () => {
  const result = await withMockFetch(
    async (url) => {
      if (String(url).includes("/server/webcams/list")) {
        return { ok: true, status: 200, json: async () => ({ result: { webcams: [{ snapshot_url: "/webcam/?action=snapshot", stream_url: "/webcam/?action=stream" }] } }) };
      }
      if (String(url) === "http://192.168.4.162/webcam/?action=snapshot") {
        return { ok: true, status: 200, headers: { get: () => "image/jpeg" } };
      }
      return { ok: false, status: 404, headers: { get: () => "text/html" } };
    },
    () => conn.detectCamera(p)
  );
  assert.equal(result, "http://192.168.4.162/webcam/?action=snapshot");
});

test("detectCamera falls back to the MJPG-Streamer default port 8080 when the published relative path 404s (confirmed live: the real .162 unit's own port-80 httpd doesn't proxy it)", async () => {
  const result = await withMockFetch(
    async (url) => {
      if (String(url).includes("/server/webcams/list")) {
        return { ok: true, status: 200, json: async () => ({ result: { webcams: [{ snapshot_url: "/webcam/?action=snapshot" }] } }) };
      }
      if (String(url) === "http://192.168.4.162:8080/?action=snapshot") {
        return { ok: true, status: 200, headers: { get: () => "image/jpeg" } };
      }
      return { ok: false, status: 404, headers: { get: () => "text/html" } };
    },
    () => conn.detectCamera(p)
  );
  assert.equal(result, "http://192.168.4.162:8080/?action=snapshot");
});

test("detectCamera returns null when a webcam is registered but no candidate URL actually resolves to an image", async () => {
  const result = await withMockFetch(
    async (url) => {
      if (String(url).includes("/server/webcams/list")) {
        return { ok: true, status: 200, json: async () => ({ result: { webcams: [{ snapshot_url: "/webcam/?action=snapshot" }] } }) };
      }
      return { ok: false, status: 404, headers: { get: () => "text/html" } };
    },
    () => conn.detectCamera(p)
  );
  assert.equal(result, null);
});

test("detectCamera returns null (not a throw) when a webcam entry has neither snapshot_url nor stream_url", async () => {
  const result = await withMockFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ result: { webcams: [{ name: "weird" }] } }) }),
    () => conn.detectCamera(p)
  );
  assert.equal(result, null);
});

test("getCameraSnapshot throws a clear error when no camera has been detected for this printer", async () => {
  await assert.rejects(() => conn.getCameraSnapshot({}), /No camera detected/);
});

test("getCameraSnapshot fetches the stored cameraUrl and returns {contentType, buffer}", async () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const result = await withMockFetch(
    async (url) => {
      assert.equal(url, "http://192.168.4.162:8080/?action=snapshot");
      return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => jpegBytes };
    },
    () => conn.getCameraSnapshot({ cameraUrl: "http://192.168.4.162:8080/?action=snapshot" })
  );
  assert.equal(result.contentType, "image/jpeg");
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.deepEqual([...result.buffer], [...jpegBytes]);
});

// ---- Auto-level (applyHeadMapping) ----
// G29 confirmed as a real, registered gcode macro live on 192.168.4.162 (a
// real Ender-3 V3 Plus) and present, unmodified, in K1's and Ender-3 V3 KE's
// own gcode_macro.cfg — a full leveling routine (home, clear old mesh,
// nozzle-clear, re-home, probe, save), not a bare BED_MESH_CALIBRATE
// composed here from primitives.
test("getCapabilities: autoLevel is always true, independent of filamentMode", () => {
  assert.equal(conn.getCapabilities({}).autoLevel, true);
  assert.equal(conn.getCapabilities({ filamentMode: "cfs" }).autoLevel, true);
});

// applyHeadMapping now also queries bed_mesh once, before sending G29, as a
// "before" fingerprint for the connection-drop recovery path below — so a
// clean, uneventful run makes 2 fetch calls (bed_mesh query, then the G29
// script itself), not 1. mockMeshAndScript() gives each test a fetch mock
// that answers the bed_mesh query generically and tracks the G29 script
// call(s) separately, so assertions stay focused on what each test cares
// about instead of re-deriving this split every time.
function mockMeshAndScript(scriptHandler) {
  const scriptCalls = [];
  return async (url) => {
    const u = String(url);
    if (u.includes("bed_mesh")) {
      return { ok: true, status: 200, json: async () => ({ result: { status: { bed_mesh: { probed_matrix: [[1, 2]] } } } }) };
    }
    scriptCalls.push(u);
    return scriptHandler(u, scriptCalls.length);
  };
}

test("applyHeadMapping sends G29 when the per-job pref requests auto-level", async () => {
  let scriptUrl = null;
  const realFetch = global.fetch;
  global.fetch = mockMeshAndScript((u) => { scriptUrl = u; return { ok: true, status: 200, text: async () => "" }; });
  try {
    await conn.applyHeadMapping({ url: "http://127.0.0.1:1" }, [], {}, { autoLevel: true });
  } finally { global.fetch = realFetch; }
  assert.ok(scriptUrl, "G29 must have been sent");
  assert.equal(decodeURIComponent(new URL(scriptUrl).searchParams.get("script")), "G29");
});

test("applyHeadMapping falls back to the printer's own default when the job sends no explicit pref", async () => {
  let scriptCallCount = 0;
  const realFetch = global.fetch;
  global.fetch = mockMeshAndScript(() => { scriptCallCount++; return { ok: true, status: 200, text: async () => "" }; });
  try {
    await conn.applyHeadMapping({ url: "http://127.0.0.1:1", autoLevel: true }, [], {}, {});
  } finally { global.fetch = realFetch; }
  assert.equal(scriptCallCount, 1, "printer-level default must still trigger G29 when the job itself specifies nothing");
});

test("applyHeadMapping: an explicit false pref overrides a printer default of true (never silently levels anyway)", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; };
  try {
    await conn.applyHeadMapping({ url: "http://127.0.0.1:1", autoLevel: true }, [], {}, { autoLevel: false });
  } finally { global.fetch = realFetch; }
  assert.equal(calls.length, 0, "an explicit opt-out must not send G29 (or even check the current mesh) even though the printer default is on");
});

test("applyHeadMapping sends nothing at all when auto-level isn't requested anywhere", async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => "" }; };
  try {
    await conn.applyHeadMapping({ url: "http://127.0.0.1:1" }, [], {}, {});
  } finally { global.fetch = realFetch; }
  assert.equal(called, false);
});

// CODE_AUDIT.md P1-2: G29 genuinely blocks for the full leveling pass (see
// this connector's own comment above applyHeadMapping) — it must NOT
// inherit moonrakerPost's 8s fast-command default, or a real leveling pass
// would be wrongly aborted mid-flight. Bound raised from 5 to 12 minutes
// after a real K1C's own klippy.log showed a live PRTOUCH full-bed G29 pass
// still probing past the originally-documented "~1-3 minutes" — the old 5
// minute bound was routinely aborting the HTTP call before the physical
// macro finished, which silently orphaned the print (the abort doesn't stop
// the macro on the printer, it just stops server.js from ever reaching
// startPrintFile). Uses node:test's mock timers (same convention as
// test/connectors/snapmaker-u1-klipper-ws.test.js) to prove the actual
// bound without waiting 12 real minutes: a fetch that only ever settles in
// response to the AbortSignal, ticked to just under and then just past the
// 12-minute mark.
// Drains the microtask queue enough times for a rejection to propagate up
// through however many `await` layers sit between the mocked fetch and the
// test's own `.then()` observer — a fixed small count of flushes is brittle
// against call-stack depth (matched empirically for applyHeadMapping's own
// extra `await http.sendGcode(...)` layer beyond moonrakerPost itself).
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("applyHeadMapping (G29) uses a generous ~12-minute timeout, not the 8s fast-command default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false, rejected = false;
  const realFetch = global.fetch;
  // bed_mesh's own "before" fingerprint query resolves immediately (fixed,
  // real JSON) — only the G29 script call itself hangs on the AbortSignal,
  // so this test stays isolated to what it actually cares about: G29's own
  // timeout bound, not the separate mesh pre-check's behavior.
  global.fetch = (url, opts) => {
    if (String(url).includes("bed_mesh")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: { status: { bed_mesh: { probed_matrix: [[1, 2]] } } } }) });
    }
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  };
  const pending = conn.applyHeadMapping({ url: "http://127.0.0.1:1" }, [], {}, { autoLevel: true });
  pending.then(() => { settled = true; }, () => { settled = true; rejected = true; });
  pending.catch(() => {}); // avoid an unhandled-rejection warning while intentionally left pending below

  try {
    // applyHeadMapping now awaits the bed_mesh "before" fingerprint query
    // BEFORE calling sendGcode — that await chain (and the mocked bed_mesh
    // fetch's own microtask resolution) needs to fully drain first, or
    // G29's own AbortController/setTimeout hasn't been registered with the
    // mock timer system yet when tick() below runs, and never fires.
    await flush();
    t.mock.timers.tick(11 * 60 * 1000); // 11 minutes — well under the bound
    await flush();
    assert.equal(settled, false, "must not time out this early — would indicate it's still using a shorter override, not the 12-minute one");

    t.mock.timers.tick(65 * 1000); // cross the 12-minute mark
    await flush();
    assert.equal(settled, true);
    assert.equal(rejected, true);
  } finally {
    global.fetch = realFetch;
  }
});

// Regression: a real K1C's connection to Moonraker has been observed live,
// repeatedly (including 2-3 times on the SAME print, back to back), dropping
// mid-G29 with exactly this error shape ("Could not reach <name>: fetch
// failed" — a bare connection failure, not a timeout and not a real HTTP
// rejection from Moonraker) — orphaning the whole print since server.js
// never reaches startPrintFile once applyHeadMapping rejects. An earlier
// version of this fix blindly RESENT G29 after a drop, which turned out
// actively counterproductive when drops recurred mid-pass: each resend
// restarts the whole multi-minute probe from zero. The current design never
// resends — it waits for the printer to reconnect and confirms a changed
// bed mesh instead. MESH_RECOVERY_POLL_INTERVAL_MS/MESH_RECOVERY_TIMEOUT_MS
// (via _internal) let these tests assert the real poll cadence/bound rather
// than hardcoded numbers that could silently drift from the actual
// constants.
const { MESH_RECOVERY_POLL_INTERVAL_MS, MESH_RECOVERY_TIMEOUT_MS } = conn._internal;

test("applyHeadMapping (G29): on a connection drop, waits for reconnect and confirms a changed bed mesh — never resends G29", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = global.fetch;
  let meshQueryCount = 0, scriptCallCount = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("bed_mesh")) {
      meshQueryCount++;
      // First query is the "before" fingerprint; every later one (the
      // recovery poll) reports a genuinely different mesh, standing in for
      // a real completed leveling pass.
      const points = meshQueryCount === 1 ? [[1, 2]] : [[9, 9]];
      return { ok: true, status: 200, json: async () => ({ result: { status: { bed_mesh: { probed_matrix: points } } } }) };
    }
    scriptCallCount++;
    throw new Error("fetch failed");
  };
  try {
    const pending = conn.applyHeadMapping({ url: "http://127.0.0.1:1", name: "K1C" }, [], {}, { autoLevel: true });
    let resolved = false, rejected = false;
    pending.then(() => { resolved = true; }, () => { rejected = true; });

    await flush();
    assert.equal(scriptCallCount, 1, "G29 should have been sent exactly once so far");
    assert.equal(resolved || rejected, false, "must be waiting on the recovery poll, not settled yet");

    t.mock.timers.tick(MESH_RECOVERY_POLL_INTERVAL_MS);
    await flush();
    await pending;
    assert.equal(resolved, true, "a confirmed-changed mesh must resolve applyHeadMapping successfully");
    assert.equal(scriptCallCount, 1, "must NOT have resent G29 — recovery relies on polling the mesh, not resending the command");
  } finally {
    global.fetch = realFetch;
  }
});

// Regression for the actual bug hit live: confirmed on a real K1C mid-pass
// that bed_mesh.probed_matrix is cleared to an empty shape ([[]]) the
// INSTANT G29 starts (profile_name blanks too), and only repopulated once
// the whole pass finishes. An earlier version of readMeshFingerprint
// compared the raw matrix directly, so "old real mesh" -> "now empty"
// registered as "changed" and declared success while the printer was still
// actively probing — this must NOT happen: an empty/unpopulated matrix has
// to be treated the same as "no answer yet", not as a legitimate new value.
test("applyHeadMapping (G29): an empty/in-progress bed_mesh reading during recovery does NOT count as a fresh mesh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = global.fetch;
  let meshQueryCount = 0, scriptCallCount = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("bed_mesh")) {
      meshQueryCount++;
      // 1st = "before" (real, populated). 2nd = mid-pass, cleared/empty —
      // exactly what's been observed live. 3rd+ = the real, finished mesh.
      let matrix;
      if (meshQueryCount === 1) matrix = [[1, 2]];
      else if (meshQueryCount === 2) matrix = [[]];
      else matrix = [[9, 9]];
      return { ok: true, status: 200, json: async () => ({ result: { status: { bed_mesh: { probed_matrix: matrix } } } }) };
    }
    scriptCallCount++;
    throw new Error("fetch failed");
  };
  try {
    const pending = conn.applyHeadMapping({ url: "http://127.0.0.1:1", name: "K1C" }, [], {}, { autoLevel: true });
    let resolved = false;
    pending.then(() => { resolved = true; });

    await flush();
    t.mock.timers.tick(MESH_RECOVERY_POLL_INTERVAL_MS); // 2nd bed_mesh query — the empty/in-progress reading
    await flush();
    assert.equal(resolved, false, "an empty matrix mid-pass must NOT be mistaken for a freshly-completed one");

    t.mock.timers.tick(MESH_RECOVERY_POLL_INTERVAL_MS); // 3rd query — the real, finished mesh
    await flush();
    await pending;
    assert.equal(resolved, true, "must resolve once a real, populated, different mesh actually shows up");
    assert.equal(scriptCallCount, 1, "still must never have resent G29");
  } finally {
    global.fetch = realFetch;
  }
});

test("applyHeadMapping (G29): if the mesh never changes, gives up after the recovery window and throws — never resends G29", async (t) => {
  // waitForFreshMesh bounds itself with Date.now(), not an accumulated
  // setTimeout duration — "Date" must also be mocked, or the real wall
  // clock (barely moving during a fast test) never reaches the deadline no
  // matter how many mocked setTimeout callbacks fire.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const realFetch = global.fetch;
  let scriptCallCount = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("bed_mesh")) {
      // Same fingerprint every time — never confirms a fresh pass.
      return { ok: true, status: 200, json: async () => ({ result: { status: { bed_mesh: { probed_matrix: [[1, 2]] } } } }) };
    }
    scriptCallCount++;
    throw new Error("fetch failed");
  };
  try {
    const pending = conn.applyHeadMapping({ url: "http://127.0.0.1:1", name: "K1C" }, [], {}, { autoLevel: true });
    let error = null;
    pending.catch(e => { error = e; });

    const polls = Math.ceil(MESH_RECOVERY_TIMEOUT_MS / MESH_RECOVERY_POLL_INTERVAL_MS) + 1;
    for (let i = 0; i < polls; i++) {
      await flush();
      t.mock.timers.tick(MESH_RECOVERY_POLL_INTERVAL_MS);
    }
    await flush();
    assert.ok(error, "must eventually reject rather than hang forever");
    assert.match(error.message, /never confirmed the leveling pass finished/);
    assert.equal(scriptCallCount, 1, "must NOT have resent G29 even after giving up — only the initial send ever happened");
  } finally {
    global.fetch = realFetch;
  }
});

test("applyHeadMapping (G29) does NOT wait/recover on a real Moonraker rejection (non-2xx response) — only a connection drop triggers recovery", async () => {
  let scriptCallCount = 0;
  const realFetch = global.fetch;
  global.fetch = mockMeshAndScript(() => { scriptCallCount++; return { ok: false, status: 400, text: async () => "bad request" }; });
  try {
    await assert.rejects(
      conn.applyHeadMapping({ url: "http://127.0.0.1:1", name: "K1C" }, [], {}, { autoLevel: true }),
      /Moonraker 400/
    );
    assert.equal(scriptCallCount, 1, "a real rejection from Moonraker/Klipper must fail immediately — no recovery wait would fix it");
  } finally {
    global.fetch = realFetch;
  }
});

// ---- startPrintFile: local override, longer timeout than http-utils.js's
// shared 8s default ----
// Confirmed live on a real K1C: SDCARD_PRINT_FILE sent right after a G29
// pass can take longer than 8s to respond — SnapCon reported a failure
// while a probe moments later showed the print had actually started
// (state:"printing", virtual_sdcard.is_active:true). A false failure for a
// print that's actually working is worse than a slow-but-accurate success.
test("startPrintFile sends SDCARD_PRINT_FILE with the filename", async () => {
  let scriptUrl = null;
  const realFetch = global.fetch;
  global.fetch = async (url) => { scriptUrl = String(url); return { ok: true, status: 200, text: async () => "" }; };
  try {
    await conn.startPrintFile({ url: "http://127.0.0.1:1" }, "benchy.gcode");
  } finally { global.fetch = realFetch; }
  assert.equal(decodeURIComponent(new URL(scriptUrl).searchParams.get("script")), 'SDCARD_PRINT_FILE FILENAME="benchy.gcode"');
});

test("startPrintFile uses a longer timeout than the 8s fast-command default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false, rejected = false;
  const realFetch = global.fetch;
  global.fetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  const pending = conn.startPrintFile({ url: "http://127.0.0.1:1", name: "K1C" }, "benchy.gcode");
  pending.then(() => { settled = true; }, () => { settled = true; rejected = true; });
  pending.catch(() => {});
  try {
    t.mock.timers.tick(8000);
    await flush();
    assert.equal(settled, false, "must not time out at the old 8s default");

    t.mock.timers.tick(55 * 1000); // cross 60s
    await flush();
    assert.equal(settled, true);
    assert.equal(rejected, true);
  } finally {
    global.fetch = realFetch;
  }
});

test("startPrintFile rejects a filename containing a quote or newline before it ever reaches gcode (injection guard)", async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => "" }; };
  try {
    await assert.rejects(conn.startPrintFile({ url: "http://127.0.0.1:1" }, 'evil".gcode\nRUN_SHELL_COMMAND'), /Invalid characters/);
  } finally { global.fetch = realFetch; }
  assert.equal(called, false, "must reject before ever sending a request, not after");
});

// ---- pause/resume/cancel/eject/bedTemp: local overrides, same longer
// timeout as startPrintFile ----
// Confirmed live: a plain CANCEL_PRINT genuinely cancelled the printer
// immediately, but SnapCon still reported "K1C did not respond within
// 8000ms" — the exact same false-failure-on-a-working-command pattern
// already fixed for startPrintFile, just for a different command. estop is
// deliberately excluded — see its own test below.
test("pause/resume/cancel/eject/bedTemp send the correct gcode commands", async () => {
  let sentScript = null;
  const realFetch = global.fetch;
  global.fetch = async (url) => { sentScript = decodeURIComponent(new URL(String(url)).searchParams.get("script")); return { ok: true, status: 200, text: async () => "" }; };
  try {
    await conn.pause({ url: "http://127.0.0.1:1" }); assert.equal(sentScript, "PAUSE");
    await conn.resume({ url: "http://127.0.0.1:1" }); assert.equal(sentScript, "RESUME");
    await conn.cancel({ url: "http://127.0.0.1:1" }); assert.equal(sentScript, "CANCEL_PRINT");
    await conn.eject({ url: "http://127.0.0.1:1" }); assert.equal(sentScript, "SDCARD_RESET_FILE");
    await conn.bedTemp({ url: "http://127.0.0.1:1" }, 55.6); assert.equal(sentScript, "M140 S56", "rounds the target, same as before");
  } finally { global.fetch = realFetch; }
});

test("pause/resume/cancel/eject/bedTemp all use the longer 60s timeout, not the 8s fast-command default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = global.fetch;
  global.fetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  const printer = { url: "http://127.0.0.1:1", name: "K1C" };
  const calls = [
    () => conn.pause(printer), () => conn.resume(printer), () => conn.cancel(printer),
    () => conn.eject(printer), () => conn.bedTemp(printer, 60)
  ];
  try {
    for (const call of calls) {
      let settled = false, rejected = false;
      const pending = call();
      pending.then(() => { settled = true; }, () => { settled = true; rejected = true; });
      pending.catch(() => {});

      t.mock.timers.tick(8000);
      await flush();
      assert.equal(settled, false, "must not time out at the old 8s default");

      t.mock.timers.tick(55 * 1000); // cross 60s
      await flush();
      assert.equal(settled, true);
      assert.equal(rejected, true);
    }
  } finally {
    global.fetch = realFetch;
  }
});

// Safety-critical: estop must NOT get the same longer timeout as every
// other control action. In a real emergency the operator needs to know
// FAST if the command isn't landing — an unresponsive printer during an
// E-Stop may need the operator to act physically (pull power) instead of
// SnapCon quietly waiting longer hoping it eventually works.
test("estop is deliberately NOT given the longer timeout — still uses the 8s fast-command default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false, rejected = false;
  const realFetch = global.fetch;
  global.fetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  const pending = conn.estop({ url: "http://127.0.0.1:1", name: "K1C" });
  pending.then(() => { settled = true; }, () => { settled = true; rejected = true; });
  pending.catch(() => {});
  try {
    t.mock.timers.tick(7000);
    await flush();
    assert.equal(settled, false, "must not fire before the 8s default itself");

    t.mock.timers.tick(1500); // cross 8s
    await flush();
    assert.equal(settled, true, "must time out at the short 8s default, not the longer 60s control bound the other actions now use");
    assert.equal(rejected, true);
  } finally {
    global.fetch = realFetch;
  }
});

// ---- Thumbnail: embedded base64 PNG, not a Moonraker .thumbs/ sidecar ----
// Confirmed live: the shared http.getThumbnail's ".thumbs/*.png" sidecar
// convention 404s on every real Creality-Print-sliced file, because
// Creality Print embeds the thumbnail directly in the gcode's own header
// comments instead. Fixtures below use a real minimal 1x1 PNG, wrapped in
// the real comment dialects confirmed live across real files on the same
// printer — three so far: two separator variants of the "thumbnail
// begin/end" marker ("WxH" — the true OrcaSlicer/PrusaSlicer standard,
// confirmed live on a file with an "OrcaSlicer 2.3.0" header, and "W H" —
// confirmed live on a different, older-engine file), plus the older
// Cura-derived "png begin/end" dialect. Re-verified against all 48 real
// files present on that printer after the "WxH" gap was found and fixed —
// 48/48 decoded successfully.
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function wrapB64AsCommentLines(b64, width) {
  // Real files wrap at a fixed column width with a "; " prefix per line —
  // width is irrelevant to decoding, just varies the fixture realistically.
  const lines = [];
  for (let i = 0; i < b64.length; i += width) lines.push("; " + b64.slice(i, i + width));
  return lines.join("\n");
}
const stdThumbBlockX = (w, h, b64) => `; thumbnail begin ${w}x${h} ${b64.length}\n${wrapB64AsCommentLines(b64, 78)}\n; thumbnail end`;
const stdThumbBlock = (w, h, b64) => `; thumbnail begin ${w} ${h} ${b64.length}\n${wrapB64AsCommentLines(b64, 78)}\n; thumbnail end`;
const curaPngBlock = (w, h, b64) => `; png begin ${w}*${h} ${b64.length} 0 95 185\n${wrapB64AsCommentLines(b64, 78)}\n; png end`;

test("decodeEmbeddedThumbnail: standard 'thumbnail begin WxH' marker (real OrcaSlicer/PrusaSlicer/SuperSlicer convention — confirmed live on an 'OrcaSlicer 2.3.0' file)", () => {
  const text = "G28\n" + stdThumbBlockX(300, 300, TINY_PNG_B64) + "\nG1 X0\n";
  const buf = conn._internal.decodeEmbeddedThumbnail(text);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf], [...Buffer.from(TINY_PNG_B64, "base64")]);
});

test("decodeEmbeddedThumbnail: standard 'thumbnail begin W H' marker (space separator — confirmed live on a different, older-engine file on the same printer)", () => {
  const text = "G28\n" + stdThumbBlock(300, 300, TINY_PNG_B64) + "\nG1 X0\n";
  const buf = conn._internal.decodeEmbeddedThumbnail(text);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf], [...Buffer.from(TINY_PNG_B64, "base64")]);
});

test("decodeEmbeddedThumbnail: older Cura-derived 'png begin/end' dialect, used when no standard marker is present", () => {
  const text = "G28\n" + curaPngBlock(96, 96, TINY_PNG_B64) + "\nG1 X0\n";
  const buf = conn._internal.decodeEmbeddedThumbnail(text);
  assert.deepEqual([...buf], [...Buffer.from(TINY_PNG_B64, "base64")]);
});

test("decodeEmbeddedThumbnail: picks the largest embedded size when more than one is present (matches the real -300x300 sidecar convention it replaces)", () => {
  const small = Buffer.from(TINY_PNG_B64, "base64");
  // A second, distinguishable (but still valid-shaped) fixture so the test
  // can tell which block actually got picked.
  const big64 = Buffer.concat([small, small]).toString("base64");
  const text = curaPngBlock(96, 96, TINY_PNG_B64) + "\n" + curaPngBlock(300, 300, big64);
  const buf = conn._internal.decodeEmbeddedThumbnail(text);
  assert.equal(buf.length, Buffer.from(big64, "base64").length);
});

test("decodeEmbeddedThumbnail: prefers the standard marker over the Cura dialect when both are present (real files embed both, duplicating the same image)", () => {
  const std = Buffer.from(TINY_PNG_B64, "base64");
  const other64 = Buffer.concat([std, std]).toString("base64"); // distinguishable size
  const text = curaPngBlock(300, 300, other64) + "\n" + stdThumbBlock(300, 300, TINY_PNG_B64);
  const buf = conn._internal.decodeEmbeddedThumbnail(text);
  assert.equal(buf.length, std.length, "must use the standard 'thumbnail begin' block, not the Cura 'png begin' one");
});

test("decodeEmbeddedThumbnail: no embedded marker at all returns null, never throws", () => {
  assert.equal(conn._internal.decodeEmbeddedThumbnail("G28\nG1 X0\nM104 S200\n"), null);
  assert.equal(conn._internal.decodeEmbeddedThumbnail(""), null);
});

function withMockFetchThumb(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

test("getThumbnail: decodes the real embedded PNG and returns {contentType, buffer}", async () => {
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/server/files/metadata")) {
        return { ok: true, status: 200, json: async () => ({ result: { gcode_start_byte: 5000 } }) };
      }
      return { ok: true, status: 206, text: async () => stdThumbBlock(300, 300, TINY_PNG_B64) };
    },
    () => conn.getThumbnail(p, "a.gcode")
  );
  assert.equal(result.contentType, "image/png");
  assert.deepEqual([...result.buffer], [...Buffer.from(TINY_PNG_B64, "base64")]);
});

test("getThumbnail: requests a bounded Range capped at gcode_start_byte, never the whole (possibly huge) file", async () => {
  let requestedRange = null;
  await withMockFetchThumb(
    async (url, opts) => {
      if (String(url).includes("/server/files/metadata")) {
        return { ok: true, status: 200, json: async () => ({ result: { gcode_start_byte: 12345 } }) };
      }
      requestedRange = opts.headers.Range;
      return { ok: true, status: 206, text: async () => stdThumbBlock(96, 96, TINY_PNG_B64) };
    },
    () => conn.getThumbnail(p, "a.gcode")
  );
  assert.equal(requestedRange, "bytes=0-12345");
});

test("getThumbnail: falls back to the flat cap when Moonraker's own metadata is unreachable, still bounded (not the whole file)", async () => {
  let requestedRange = null;
  await withMockFetchThumb(
    async (url, opts) => {
      if (String(url).includes("/server/files/metadata")) return { ok: false, status: 502 };
      requestedRange = opts.headers.Range;
      return { ok: true, status: 206, text: async () => stdThumbBlock(96, 96, TINY_PNG_B64) };
    },
    () => conn.getThumbnail(p, "a.gcode")
  );
  assert.equal(requestedRange, "bytes=0-409600");
});

test("getThumbnail: throws a 404-tagged error when no embedded thumbnail is found (never returns garbage)", async () => {
  await assert.rejects(
    () => withMockFetchThumb(
      async (url) => {
        if (String(url).includes("/server/files/metadata")) return { ok: true, status: 200, json: async () => ({ result: {} }) };
        return { ok: true, status: 206, text: async () => "G28\nG1 X0\n" };
      },
      () => conn.getThumbnail(p, "a.gcode")
    ),
    (e) => e.status === 404
  );
});

test("getThumbnail: propagates a real HTTP failure fetching the gcode bytes as an error with .status set", async () => {
  await assert.rejects(
    () => withMockFetchThumb(
      async (url) => {
        if (String(url).includes("/server/files/metadata")) return { ok: false, status: 502 };
        return { ok: false, status: 404 };
      },
      () => conn.getThumbnail(p, "a.gcode")
    ),
    (e) => e.status === 404
  );
});

// ---- Layer estimate (getTotalLayers / probe) ----
// Klipper's own print_stats.info.current_layer/total_layer stays null on
// real Creality Print output (confirmed live: no SET_PRINT_STATS_INFO call
// in the sliced gcode) — total layer count is read instead from plain text
// near the top of the file, in either real dialect confirmed live, then the
// current layer is estimated as progress × total.
test("getTotalLayers: Cura dialect ';LAYER_COUNT:<n>'", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const total = await withMockFetchThumb(
    async () => ({ ok: true, status: 200, text: async () => ";LAYER_COUNT:183\n;LAYER:0\nG1 Z0.2\n" }),
    () => conn._internal.getTotalLayers({ url: "http://127.0.0.1:1" }, "a.gcode")
  );
  assert.equal(total, 183);
});

test("getTotalLayers: OrcaSlicer dialect 'total layer number: <n>' (confirmed live on a real 'OrcaSlicer 2.3.0' file)", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const total = await withMockFetchThumb(
    async () => ({ ok: true, status: 200, text: async () => "; HEADER_BLOCK_START\n; total layer number: 208\n; HEADER_BLOCK_END\n" }),
    () => conn._internal.getTotalLayers({ url: "http://127.0.0.1:1" }, "b.gcode")
  );
  assert.equal(total, 208);
});

// Regression: confirmed live on a real Creality-Print-sliced file that this
// slicer uses a THIRD phrasing, distinct from both Cura's and OrcaSlicer's
// own — "; total layers count = <n>" (note: "layerS count", not "layer
// number") — and confirmed that line lives in the file's own config-summary
// block, not wherever Cura/OrcaSlicer conventionally put theirs.
test("getTotalLayers: Creality Print dialect '; total layers count = <n>' (confirmed live on a real 3MB+ sliced file)", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const total = await withMockFetchThumb(
    async () => ({ ok: true, status: 200, text: async () => "; filament cost = 0.23\n; total layers count = 192\n; estimated printing time = 14m 50s\n" }),
    () => conn._internal.getTotalLayers({ url: "http://127.0.0.1:1" }, "creality.gcode")
  );
  assert.equal(total, 192);
});

// Regression: the same real file's "total layers count" line lives in the
// slicer's config-summary block near the END of the file (confirmed live:
// byte offset ~3.07MB into a 3.14MB file) — a head-only read (the original
// implementation) would never see it. Mocks Moonraker's own suffix-range
// ("last N bytes") response shape, confirmed live to work, to prove the
// tail is actually consulted, not just the head.
test("getTotalLayers: finds the count when it's ONLY in the tail (large file, marker near the end) — head-only would miss it", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const total = await withMockFetchThumb(
    async (url, opts) => {
      const range = opts && opts.headers && opts.headers.Range;
      if (range === "bytes=-65536") {
        return { ok: true, status: 206, text: async () => "; filament cost = 0.23\n; total layers count = 192\n" };
      }
      return { ok: true, status: 206, text: async () => "G28\nG1 X0\n; nothing relevant up here\n" }; // head: no marker
    },
    () => conn._internal.getTotalLayers({ url: "http://127.0.0.1:1" }, "large.gcode")
  );
  assert.equal(total, 192, "must fall back to the tail when the head has nothing");
});

test("getTotalLayers: caches per printer+filename — a second lookup for the same job makes no further network request", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  let calls = 0;
  const printer = { url: "http://127.0.0.1:1" };
  await withMockFetchThumb(
    async () => { calls++; return { ok: true, status: 200, text: async () => ";LAYER_COUNT:50\n" }; },
    async () => {
      assert.equal(await conn._internal.getTotalLayers(printer, "c.gcode"), 50);
      assert.equal(await conn._internal.getTotalLayers(printer, "c.gcode"), 50);
    }
  );
  assert.equal(calls, 2, "one head + one tail request on the first (uncached) lookup, none on the second");
});

test("getTotalLayers: a confirmed absence (fetched fine, neither tag present in head or tail) is also cached — not re-fetched every probe for a file that will never have one", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  let calls = 0;
  const printer = { url: "http://127.0.0.1:1" };
  await withMockFetchThumb(
    async () => { calls++; return { ok: true, status: 200, text: async () => "G28\nG1 X0\n" }; },
    async () => {
      assert.equal(await conn._internal.getTotalLayers(printer, "d.gcode"), null);
      assert.equal(await conn._internal.getTotalLayers(printer, "d.gcode"), null);
    }
  );
  assert.equal(calls, 2, "head + tail on the first lookup, none on the second (cached)");
});

test("getTotalLayers: a transient network failure is NOT cached, so the next probe retries instead of being stuck null forever", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  let calls = 0;
  const printer = { url: "http://127.0.0.1:1" };
  await withMockFetchThumb(
    async () => { calls++; throw new Error("ECONNRESET"); },
    async () => {
      assert.equal(await conn._internal.getTotalLayers(printer, "e.gcode"), null);
      assert.equal(await conn._internal.getTotalLayers(printer, "e.gcode"), null);
    }
  );
  assert.equal(calls, 4, "head+tail attempted on each of the 2 (uncached) lookups — a network failure must not be cached as a permanent negative");
});

// Regression: confirmed live on a real K1C, mid-print, that virtual_sdcard.
// progress and display_status.progress can genuinely disagree — the file's
// own START_PRINT macro blocks for several minutes of leveling before any
// real extrusion, during which Klipper's SD-card reader can already read
// ahead into its buffer (virtual_sdcard.progress > 0) even though nothing
// has actually executed yet (display_status.progress correctly stays 0,
// matching what Fluidd showed at the same moment SnapCon showed 3.6%/"layer
// 7"). display_status must win whenever it's a real number.
test("probe: prefers display_status.progress over virtual_sdcard.progress when both are present and disagree", async () => {
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/printer/objects/query")) {
        return {
          ok: true, status: 200, json: async () => ({ result: { status: {
            print_stats: { state: "printing", filename: "job.gcode", info: {} },
            display_status: { progress: 0.0 },
            virtual_sdcard: { progress: 0.0359 }
          } } })
        };
      }
      return { ok: true, status: 200, text: async () => "G28\n" };
    },
    () => conn.probe({ url: "http://127.0.0.1:1", name: "Test" })
  );
  assert.equal(result.progress, 0, "display_status's real 0% must win, not virtual_sdcard's misleading read-ahead progress");
});

test("probe: still falls back to virtual_sdcard.progress when display_status isn't configured at all (no [display_status] section)", async () => {
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/printer/objects/query")) {
        return {
          ok: true, status: 200, json: async () => ({ result: { status: {
            print_stats: { state: "printing", filename: "job.gcode", info: {} },
            virtual_sdcard: { progress: 0.42 }
          } } })
        };
      }
      return { ok: true, status: 200, text: async () => "G28\n" };
    },
    () => conn.probe({ url: "http://127.0.0.1:1", name: "Test" })
  );
  assert.equal(result.progress, 0.42);
});

test("probe: estimates layer from progress × total when Klipper's own print_stats.info is null (real Creality Print behavior)", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/printer/objects/query")) {
        return {
          ok: true, status: 200, json: async () => ({ result: { status: {
            print_stats: { state: "printing", filename: "job.gcode", info: { current_layer: null, total_layer: null } },
            virtual_sdcard: { progress: 0.25 }
          } } })
        };
      }
      return { ok: true, status: 200, text: async () => "; total layer number: 208\n" };
    },
    () => conn.probe({ url: "http://127.0.0.1:1", name: "Test" })
  );
  assert.deepEqual(result.layer, { current: 52, total: 208 });
});

// Regression: confirmed live on a real K1C that display_status.progress (the
// source for the progress×total estimate above) only updates in coarse
// whole-percent steps, so the estimate jumped by 2+ layers at a time (e.g.
// 4 -> 6 -> 8) even though the print was really advancing one layer at a
// time. virtual_sdcard also exposes a real, smoothly-incrementing `layer`
// field on this printer (a Creality-specific extension, not stock Klipper),
// confirmed live to move 4 -> 5 over 5 seconds while display_status.progress
// stayed flat — it must win over the coarse estimate whenever present.
test("probe: prefers virtual_sdcard.layer over the progress × total estimate when both are present and disagree", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/printer/objects/query")) {
        return {
          ok: true, status: 200, json: async () => ({ result: { status: {
            print_stats: { state: "printing", filename: "job.gcode", info: { current_layer: null, total_layer: null } },
            display_status: { progress: 0.01 },
            virtual_sdcard: { progress: 0.0817, layer: 5 }
          } } })
        };
      }
      return { ok: true, status: 200, text: async () => "; total layer number: 192\n" };
    },
    () => conn.probe({ url: "http://127.0.0.1:1", name: "Test" })
  );
  assert.deepEqual(result.layer, { current: 5, total: 192 }, "the real per-layer counter must win over round(progress * total)");
});

test("probe: falls back to the progress × total estimate when virtual_sdcard.layer isn't a valid positive number", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/printer/objects/query")) {
        return {
          ok: true, status: 200, json: async () => ({ result: { status: {
            print_stats: { state: "printing", filename: "job.gcode", info: { current_layer: null, total_layer: null } },
            display_status: { progress: 0.25 },
            virtual_sdcard: { progress: 0.25, layer: 0 }
          } } })
        };
      }
      return { ok: true, status: 200, text: async () => "; total layer number: 208\n" };
    },
    () => conn.probe({ url: "http://127.0.0.1:1", name: "Test" })
  );
  assert.deepEqual(result.layer, { current: 52, total: 208 }, "layer:0 is not a valid current layer — must fall back to the estimate");
});

test("probe: leaves layer null when no total layer count can be found anywhere (never fakes a number)", async () => {
  conn._internal.LAYER_COUNT_CACHE.clear();
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/printer/objects/query")) {
        return {
          ok: true, status: 200, json: async () => ({ result: { status: {
            print_stats: { state: "printing", filename: "job2.gcode", info: {} },
            virtual_sdcard: { progress: 0.5 }
          } } })
        };
      }
      return { ok: true, status: 200, text: async () => "G28\nG1 X0\n" };
    },
    () => conn.probe({ url: "http://127.0.0.1:1", name: "Test" })
  );
  assert.equal(result.layer, null);
});

test("probe: does not fetch layer count at all when the printer is idle (no job to estimate a layer for)", async () => {
  let layerFetchCalled = false;
  const result = await withMockFetchThumb(
    async (url) => {
      if (String(url).includes("/printer/objects/query")) {
        return {
          ok: true, status: 200, json: async () => ({ result: { status: {
            print_stats: { state: "standby", filename: "", info: {} },
            virtual_sdcard: { progress: 0 }
          } } })
        };
      }
      layerFetchCalled = true;
      return { ok: true, status: 200, text: async () => ";LAYER_COUNT:99\n" };
    },
    () => conn.probe({ url: "http://127.0.0.1:1", name: "Test" })
  );
  assert.equal(result.layer, null);
  assert.equal(layerFetchCalled, false);
});

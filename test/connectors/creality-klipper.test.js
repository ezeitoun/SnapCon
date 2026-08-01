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

test("applyHeadMapping sends G29 when the per-job pref requests auto-level", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; };
  try {
    await conn.applyHeadMapping({ url: "http://127.0.0.1:1" }, [], {}, { autoLevel: true });
  } finally { global.fetch = realFetch; }
  assert.equal(calls.length, 1);
  assert.equal(decodeURIComponent(new URL(calls[0]).searchParams.get("script")), "G29");
});

test("applyHeadMapping falls back to the printer's own default when the job sends no explicit pref", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; };
  try {
    await conn.applyHeadMapping({ url: "http://127.0.0.1:1", autoLevel: true }, [], {}, {});
  } finally { global.fetch = realFetch; }
  assert.equal(calls.length, 1, "printer-level default must still trigger G29 when the job itself specifies nothing");
});

test("applyHeadMapping: an explicit false pref overrides a printer default of true (never silently levels anyway)", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => "" }; };
  try {
    await conn.applyHeadMapping({ url: "http://127.0.0.1:1", autoLevel: true }, [], {}, { autoLevel: false });
  } finally { global.fetch = realFetch; }
  assert.equal(calls.length, 0, "an explicit opt-out must not send G29 even though the printer default is on");
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
  assert.equal(calls, 1);
});

test("getTotalLayers: a confirmed absence (fetched fine, neither tag present) is also cached — not re-fetched every probe for a file that will never have one", async () => {
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
  assert.equal(calls, 1);
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
  assert.equal(calls, 2, "a network failure must not be cached as a permanent negative");
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

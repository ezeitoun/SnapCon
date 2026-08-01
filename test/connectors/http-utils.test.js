// test/connectors/http-utils.test.js — regression test for C-3 (gcode/CRLF
// injection into the shared Moonraker script sink). startPrintFile()/
// excludeObject() must reject any filename/object-name containing a quote or
// a line break BEFORE it's ever interpolated into a literal `script` value,
// since Moonraker executes a multi-line script one gcode/macro command per
// line — an embedded CR/LF there turns one intended command into two.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("../../connectors/http-utils");

const p = { name: "Test Printer", url: "http://127.0.0.1:1" };

test("assertSafeGcodeArg accepts an ordinary filename", () => {
  assert.equal(http._internal.assertSafeGcodeArg("part.gcode"), "part.gcode");
});

test("assertSafeGcodeArg rejects an embedded newline", () => {
  assert.throws(() => http._internal.assertSafeGcodeArg("part.gcode\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=999.gcode"));
});

test("assertSafeGcodeArg rejects an embedded carriage return", () => {
  assert.throws(() => http._internal.assertSafeGcodeArg("part.gcode\rM112.gcode"));
});

test("assertSafeGcodeArg rejects an embedded double quote", () => {
  assert.throws(() => http._internal.assertSafeGcodeArg('part"; M112; "x.gcode'));
});

test("startPrintFile throws synchronously (never reaches the network) on an injected filename", () => {
  // No fetch mock installed on purpose — a passing test here proves the
  // malicious script string was never even built, let alone sent.
  assert.throws(
    () => http.startPrintFile(p, "part.gcode\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=999"),
    /Invalid characters/
  );
});

test("startPrintFile sends the expected script for a clean filename", async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => "" }; };
  try {
    await http.startPrintFile(p, "part.gcode");
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(calls.length, 1);
  const script = decodeURIComponent(new URL(calls[0]).searchParams.get("script"));
  assert.equal(script, 'SDCARD_PRINT_FILE FILENAME="part.gcode"');
});

test("excludeObject rejects an injected object name (rejected promise, not a network call)", async () => {
  const realFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => "" }; };
  try {
    await assert.rejects(() => http.excludeObject(p, 'x"\nM112'), /Invalid characters/);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(fetchCalled, false, "must reject before ever reaching the network");
});

// ---- parseFallbackStats / getFileMetadata fallback ----
// Moonraker's own metadata scanner reports slicer:"Unknown" (no
// estimated_time/filament_colour at all) on real Creality-Print-sliced
// gcode — confirmed live against two real files, each in a different real
// dialect depending on slicer version. Regression coverage for both, using
// the exact comment text captured from those live files.
function withMockFetch(handler, fn) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = realFetch; });
}

test("parseFallbackStats: Cura/Creality-OS dialect (older Creality Print) — ;TIME:/;Filament Weight: header tags", () => {
  const text = [
    ";FLAVOR:Creality OS",
    ";TIME:891.355",
    ";Filament used:3.92071m",
    ";Layer height:0.26",
    ";Filament Weight:11.693712"
  ].join("\n");
  assert.deepEqual(http._internal.parseFallbackStats(text), { estimatedTime: 891.355, filamentG: 11.693712 });
});

test("parseFallbackStats: OrcaSlicer/BambuStudio dialect (newer Creality Print) — footer stats block", () => {
  const text = [
    "; filament used [mm] = 79412.83",
    "; filament used [g] = 236.85",
    "; total filament used [g] = 236.85",
    "; estimated printing time (normal mode) = 9h 42m 19s",
    "; CONFIG_BLOCK_END"
  ].join("\n");
  assert.deepEqual(http._internal.parseFallbackStats(text), { estimatedTime: 34939, filamentG: 236.85 });
});

test("parseFallbackStats: prefers 'total filament used [g]' over the plain per-extruder line when both are present", () => {
  const text = "; filament used [g] = 100.00\n; total filament used [g] = 250.50\n";
  assert.equal(http._internal.parseFallbackStats(text).filamentG, 250.50);
});

test("parseFallbackStats: no recognizable dialect in the text returns both fields null, never throws", () => {
  assert.deepEqual(http._internal.parseFallbackStats("G1 X10 Y10\nG1 X20\n"), { estimatedTime: null, filamentG: null });
  assert.deepEqual(http._internal.parseFallbackStats(""), { estimatedTime: null, filamentG: null });
});

test("getFileMetadata: Moonraker's own data is used as-is when present, fallback parsing never runs", async () => {
  const result = await withMockFetch(
    async (url) => {
      if (String(url).includes("/server/files/metadata")) {
        return { ok: true, status: 200, json: async () => ({ result: { estimated_time: 500, filament_colour: "#FF0000", filament_type: "PLA", filament_weight: [20] } }) };
      }
      throw new Error("should not fetch raw gcode bytes when Moonraker's own metadata is already complete");
    },
    () => http.getFileMetadata(p, "a.gcode")
  );
  assert.equal(result.estimatedTime, 500);
  assert.equal(result.palette[0].wt, "20");
});

test("getFileMetadata: falls back to the tail-text Orca dialect when Moonraker reports slicer:Unknown with no data", async () => {
  const result = await withMockFetch(
    async (url) => {
      if (String(url).includes("/server/files/metadata")) {
        return { ok: true, status: 200, json: async () => ({ result: { slicer: "Unknown", gcode_start_byte: 0 } }) };
      }
      // tail fetch (Range: bytes=-51200)
      return { ok: true, status: 200, text: async () => "; estimated printing time (normal mode) = 1h 2m 3s\n; total filament used [g] = 42.50\n" };
    },
    () => http.getFileMetadata(p, "a.gcode")
  );
  assert.equal(result.estimatedTime, 3723);
  assert.equal(result.palette.length, 1);
  assert.equal(result.palette[0].wt, "42.5");
  assert.equal(result.palette[0].used, true);
});

test("getFileMetadata: falls back to a header-window fetch for the Cura dialect when the tail scan finds nothing", async () => {
  const calls = [];
  const result = await withMockFetch(
    async (url, opts) => {
      calls.push(String(url) + " " + JSON.stringify((opts && opts.headers) || {}));
      if (String(url).includes("/server/files/metadata")) {
        return { ok: true, status: 200, json: async () => ({ result: { slicer: "Unknown", gcode_start_byte: 20000 } }) };
      }
      const range = opts && opts.headers && opts.headers.Range;
      if (range === "bytes=-51200") return { ok: true, status: 200, text: async () => "; some unrelated tail content\n" };
      // header-window fetch, just before gcode_start_byte
      return { ok: true, status: 200, text: async () => ";TIME:120.5\n;Filament Weight:5.25\n" };
    },
    () => http.getFileMetadata(p, "a.gcode")
  );
  assert.equal(result.estimatedTime, 120.5);
  assert.equal(result.palette[0].wt, "5.25");
  assert.ok(calls.some(c => c.includes("bytes=3616-20000")), "must request a bounded window ending at gcode_start_byte, not the whole file");
});

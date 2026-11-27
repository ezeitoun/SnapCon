// test/connectors/thumbnail-metadata.test.js — job previews are located by
// ASKING Moonraker, not by guessing a filename.
//
// The bug, reported live: an AD5X on ZMOD showed no thumbnails while every U1
// did. Both printers in fact store thumbnails in .thumbs/; the difference is
// which sizes their slicers emit:
//
//   U1 Navy    96x96, 48x48, 300x300      <- SnapCon's hardcoded -300x300.png hit
//   AD5X Blue  32x32, 64x64, 140x110      <- no 300x300, so it 404'd
//
// So the U1 worked by coincidence. getThumbnail hardcoded
// "/server/files/gcodes/.thumbs/<stem>-300x300.png", a slicer convention
// rather than an API — a manufacturer-specific assumption in code shared by
// every Klipper-family connector (CLAUDE.md section 3).
//
// Moonraker documents the real answer: /server/files/metadata returns a
// thumbnails array, each entry carrying a relative_path. Verified live against
// both printers above: the metadata-derived path returns 200 image/png on
// each, while the hardcoded one 404s on the AD5X.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("../../connectors/http-utils");

// Real metadata shapes, copied from the two printers.
const AD5X_THUMBS = [
  { width: 32, height: 25, relative_path: ".thumbs/Ferret (11h21m)-32x32.png" },
  { width: 140, height: 110, relative_path: ".thumbs/Ferret (11h21m)-140x110.png" },
  { width: 64, height: 64, relative_path: ".thumbs/Ferret (11h21m)-64x64.png" },
];
const U1_THUMBS = [
  { width: 96, height: 96, relative_path: ".thumbs/Rose Dragon-96x96.png" },
  { width: 48, height: 48, relative_path: ".thumbs/Rose Dragon-48x48.png" },
  { width: 300, height: 300, relative_path: ".thumbs/Rose Dragon-300x300.png" },
];

// Serves metadata for any filename, and PNG bytes for exactly the paths listed.
function printer({ thumbs, servePaths, metaStatus = 200 }) {
  const calls = [];
  const handler = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/server/files/metadata")) {
      if (metaStatus !== 200) return { ok: false, status: metaStatus, text: async () => "", json: async () => ({}) };
      const body = { result: { thumbnails: thumbs } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    }
    const path = decodeURIComponent(u.slice(u.indexOf("/server/files/")));
    if (servePaths.includes(path)) {
      return { ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
    }
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { calls, handler };
}
function withMockFetch(handler, fn) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(fn()).finally(() => { global.fetch = real; });
}
const P = { url: "http://192.168.40.212:7125" };

test("AD5X: finds the preview even though no 300x300 exists", async () => {
  // THE regression. This file never had a -300x300.png to guess at.
  const s = printer({ thumbs: AD5X_THUMBS, servePaths: ["/server/files/gcodes/.thumbs/Ferret (11h21m)-140x110.png"] });
  const out = await withMockFetch(s.handler, () => http.getThumbnail(P, "Ferret (11h21m).gcode"));
  assert.equal(out.contentType, "image/png");
  assert.ok(out.buffer.length > 0);
});

test("picks the LARGEST thumbnail offered, not the first listed", async () => {
  // 140x110 is listed second on the AD5X and 300x300 last on the U1 — order
  // in the array means nothing.
  const s = printer({ thumbs: AD5X_THUMBS, servePaths: ["/server/files/gcodes/.thumbs/Ferret (11h21m)-140x110.png"] });
  await withMockFetch(s.handler, () => http.getThumbnail(P, "Ferret (11h21m).gcode"));
  const fetched = s.calls.filter(c => !c.includes("metadata"));
  assert.equal(fetched.length, 1);
  assert.match(decodeURIComponent(fetched[0]), /140x110/);
});

test("U1: still works, and still gets its 300x300", async () => {
  // The printers that worked before must keep working — this is shared code.
  const s = printer({ thumbs: U1_THUMBS, servePaths: ["/server/files/gcodes/.thumbs/Rose Dragon-300x300.png"] });
  const out = await withMockFetch(s.handler, () => http.getThumbnail({ url: "http://192.168.40.192" }, "Rose Dragon.gcode"));
  assert.equal(out.contentType, "image/png");
  const fetched = s.calls.filter(c => !c.includes("metadata"));
  assert.match(decodeURIComponent(fetched[0]), /300x300/);
});

test("the guessed -300x300 path is never requested any more", async () => {
  const s = printer({ thumbs: AD5X_THUMBS, servePaths: ["/server/files/gcodes/.thumbs/Ferret (11h21m)-140x110.png"] });
  await withMockFetch(s.handler, () => http.getThumbnail(P, "Ferret (11h21m).gcode"));
  assert.equal(s.calls.some(c => decodeURIComponent(c).includes("Ferret (11h21m)-300x300.png")), false);
});

test("a file in a subfolder resolves its thumbnail beside it", async () => {
  // relative_path is relative to the GCODE FILE's own directory, so a file in
  // a subfolder must not have its thumbnail looked for at the root.
  const s = printer({
    thumbs: [{ width: 140, height: 110, relative_path: ".thumbs/part-140x110.png" }],
    servePaths: ["/server/files/gcodes/jobs/batch 2/.thumbs/part-140x110.png"],
  });
  const out = await withMockFetch(s.handler, () => http.getThumbnail(P, "jobs/batch 2/part.gcode"));
  assert.equal(out.contentType, "image/png");
});

test("spaces and parentheses in the path are encoded, not sent raw", async () => {
  const s = printer({ thumbs: AD5X_THUMBS, servePaths: ["/server/files/gcodes/.thumbs/Ferret (11h21m)-140x110.png"] });
  await withMockFetch(s.handler, () => http.getThumbnail(P, "Ferret (11h21m).gcode"));
  const fetched = s.calls.filter(c => !c.includes("metadata"))[0];
  assert.doesNotMatch(fetched, / /, "a raw space would produce an invalid request");
  assert.match(fetched, /%20/);
  // The directory separator must survive encoding.
  assert.match(fetched, /\/server\/files\/gcodes\//);
});

test("a file with no thumbnails reports not-found rather than guessing", async () => {
  const s = printer({ thumbs: [], servePaths: [] });
  await withMockFetch(s.handler, async () => {
    await assert.rejects(() => http.getThumbnail(P, "plain.gcode"), e => {
      assert.equal(e.status, 404, "the route turns e.status into its own response");
      return true;
    });
  });
  assert.equal(s.calls.filter(c => !c.includes("metadata")).length, 0, "nothing else should be tried");
});

test("an unreadable metadata response surfaces its status", async () => {
  const s = printer({ thumbs: [], servePaths: [], metaStatus: 503 });
  await withMockFetch(s.handler, async () => {
    await assert.rejects(() => http.getThumbnail(P, "plain.gcode"), e => {
      assert.ok(e.status, "must carry a status for the route to pass through");
      return true;
    });
  });
});

// test/thumbnailZoomKept.test.js — a card's print thumbnail keeps its zoom
// when the card is redrawn (public/app.js: thumbImgHtml, thumbFitToPart).
//
// Reported (owner, 2026-11-27): "from time to time I see the thumbnail on
// printers that print flicker". Measured on the farm: a card is rebuilt
// whenever its printer changes tool (activeExt is in cardSignature), which a
// multi-colour print does all the time; the rebuilt card's <img> is a new
// element, and the new layout's zoom-to-the-part was only applied by its load
// event, so the picture was drawn unzoomed for one or two frames and then
// jumped (7 times in 75 seconds, on three printers).
// The zoom a picture was given is now remembered for its URL (one per print
// job) and written into the markup of the next <img> for it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHarness } = require("./helpers/cardHarness");

const P = { id: 7, name: "U1 Left", brand: "SnapMaker", online: true, state: "printing", filename: "Gear box v3.gcode", activeExt: 0 };
const STEM = "Gear box v3.gcode";
// A page whose pictures have the part in a known place, so the zoom is known.
function page(partBox) {
  const h = makeHarness({ view: "regular", layout: "v2" });
  h.ctx.__box = partBox;
  h.run("thumbPartBox = () => __box");          // the canvas read, which needs a browser
  // The harness loads a function of app.js when a call to it fails for want of
  // it; thumbFitToPart catches everything, so what it calls is loaded up front.
  h.run("rememberThumbFit");
  h.ctx.__p = { ...P };
  const markup = () => h.run('thumbImgHtml(__p, ' + JSON.stringify(STEM) + ', "v2-thumb-img", { fitPart: true })');
  // What the browser does when the picture has loaded: the onload handler.
  const load = html => {
    const img = { naturalWidth: 300, naturalHeight: 300, clientWidth: 96, style: {}, dataset: { thumbUrl: /data-thumb-url="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&") } };
    const inline = /style="transform:([^"]+)"/.exec(html); if (inline) img.style.transform = inline[1];
    h.ctx.__img = img; h.run("thumbFitToPart(__img)");
    return img;
  };
  return { h, markup, load };
}
const inlineZoom = html => (/ style="transform:([^"]+)"/.exec(html) || [])[1] || null;

test("the first time a job's picture is shown there is nothing to remember: the zoom comes when it has loaded", () => {
  const { markup, load } = page({ x0: 90, y0: 60, x1: 270, y1: 240 });
  const first = markup();
  assert.equal(inlineZoom(first), null);
  assert.match(first, /onload="thumbFitToPart\(this\)"/);
  assert.match(load(first).style.transform, /^translate\(-?[\d.]+px, -?[\d.]+px\) scale\(1\.\d+\)$/, "zoomed to the part");
});

test("a card redrawn during the same job draws its picture already zoomed, exactly as it was", () => {
  const { markup, load } = page({ x0: 90, y0: 60, x1: 270, y1: 240 });
  const zoomed = load(markup()).style.transform;
  // The printer changes tool: the card is rebuilt, the <img> is a new element.
  const again = markup();
  assert.equal(inlineZoom(again), zoomed, "in the markup, so the first frame has it");
  // Its own load event then finds the same place and changes nothing.
  assert.equal(load(again).style.transform, zoomed);
  assert.match(again, /onload="thumbFitToPart\(this\)"/, "still checked on load (the box may have changed size)");
});

test("a new job is a new picture: nothing is carried over from the last one", () => {
  // The zoom is remembered for the picture's URL, which names the printer, the
  // file and the job (thumbToken). Here the next job prints another file; the
  // harness's clock stands still, so a reprint of the same file is not shown.
  const { h, markup, load } = page({ x0: 90, y0: 60, x1: 270, y1: 240 });
  const before = markup(); load(before);
  const next = h.run('thumbImgHtml(__p, "Bracket.gcode", "v2-thumb-img", { fitPart: true })');
  assert.notEqual(/data-thumb-url="([^"]+)"/.exec(next)[1], /data-thumb-url="([^"]+)"/.exec(before)[1], "a new job has its own URL");
  assert.equal(inlineZoom(next), null);
  // And the first picture's zoom is still its own.
  assert.equal(inlineZoom(markup()), load(before).style.transform);
});

test("a picture that needs no zoom gets none, before or after a redraw", () => {
  const { markup, load } = page(null);          // no transparent margin: thumbPartBox finds no box
  assert.equal(load(markup()).style.transform, undefined);
  assert.equal(inlineZoom(markup()), null);
});

test("only the new layout's thumbnail is zoomed; the others' markup is as it was", () => {
  const { h, load, markup } = page({ x0: 90, y0: 60, x1: 270, y1: 240 });
  load(markup());
  const plain = h.run('thumbImgHtml(__p, ' + JSON.stringify(STEM) + ', "stats-thumb")');
  assert.equal(inlineZoom(plain), null);
  assert.doesNotMatch(plain, /onload=/);
});

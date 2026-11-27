// test/selectedFileDetails.test.js — the file browser's "Selected model" card
// says the same things in every fleet view (public/style.css).
//
// Reported (owner, 2026-11-27): with a file chosen, the filaments, their
// weights and the printer the file was sliced for were not there. They were
// hidden in Compact and Camera view by rules as old as those views ("hide the
// file panel's colour hints"), and shown in Full and List. The card is above
// the fleet, not part of a printer's card, so a denser fleet view is no
// reason to say less about the file about to be sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const sheets = ["style.css", "refresh.css"].map(f => fs.readFileSync(path.join(ROOT, "public", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
// The parts of the card: the filaments it needs (colour, type, toolhead,
// grams), the printer it was sliced for, and the line under them.
const PARTS = [".needstrip", ".jcompat", ".nohint"];

test("no fleet view hides the selected file's filaments, the printer it was sliced for, or the line under them", () => {
  for (const css of sheets) for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/display:\s*none|visibility:\s*hidden/.test(m[2])) continue;
    for (const sel of m[1].split(",").map(s => s.trim())) {
      if (!/body\.(compact|camview|listview)/.test(sel)) continue;
      for (const part of PARTS) assert.ok(!new RegExp(part.replace(".", "\\.") + "(?![\\w-])").test(sel), "hidden in a view: " + sel);
    }
  }
});

test("what Camera and Compact do hide stays hidden: it belongs to the printers' cards, not to the selected file", () => {
  const css = sheets[0];
  const hidden = [...css.matchAll(/([^{}]+)\{([^{}]*display:\s*none[^{}]*)\}/g)].flatMap(m => m[1].split(",").map(s => s.trim()));
  for (const sel of ["body.camview .stats-bar", "body.camview .cmap", "body.camview .afc-lanes"]) assert.ok(hidden.includes(sel), sel);
});

// ---- the card's picture ----
// Owner, 2026-11-27: "there is space for resizing a bit the thumbnail without
// expanding the selected model card". The picture was a fixed 96px square in
// a card whose text is 118 to 151px high (measured on seven files).
test("the selected file's picture is as tall as the card's text and never makes the card taller", () => {
  const css = sheets[0];
  const rule = sel => { const m = new RegExp("(^|\\})\\s*" + sel.replace(/[.#]/g, "\\$&") + "\\{([^}]*)\\}").exec(css); assert.ok(m, sel); return m[2]; };
  const thumb = rule(".jthumb");
  const w = /(^|;)\s*width:(\d+)px/.exec(thumb);
  assert.ok(w && +w[2] > 96 && +w[2] <= 140, "wider than the 96px it was, about the text's usual height: " + (w && w[2]));
  // Its own height counts for nothing when the row is sized (0), and it then
  // takes the row's: the text alone decides how tall the card is.
  assert.match(thumb, /(^|;)\s*height:0;/);
  assert.match(thumb, /min-height:100%/);
  assert.match(thumb, /object-fit:contain/, "the whole picture, never cropped or stretched");
  assert.match(thumb, /max-height:\d+px/, "a card with many filament rows does not get a very tall frame");
  // The row is never lower than the old picture was, so a file with little to say keeps the card it had.
  assert.match(rule(".jobcard-hdr-text"), /min-height:96px/);
  assert.match(rule(".jobcard-hdr"), /grid-template-columns:auto 1fr/, "no picture, no column: the text takes the width");
});

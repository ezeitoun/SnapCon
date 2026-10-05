// The fleet area's hide/restore contract.
//
// Health, the Queue dashboard, the Library and Settings hide the fleet area
// by setting an inline display:none on
//   .main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap
// and restore it with display="". So none of those elements may keep its
// own shown/hidden state in an inline display: the restore would wipe it.
// "Selected Model" (#jobsechead) did, and came back with no file selected
// after closing Health, the Queue or the Library.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = f => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
const html = read("index.html"), app = read("app.js"), library = read("library.js"), css = read("style.css");
const RESTORE = '".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap"';

test("the pages that hide the fleet area restore it by clearing inline display", () => {
  // Guards the premise of the tests below: if these paths change, revisit them.
  const restores = (app + library).split(RESTORE).length - 1;
  assert.ok(restores >= 5, `expected the shared hide/restore selector in app.js and library.js, found ${restores}`);
  assert.match(app, /closeHealthPage\(\)\{[\s\S]*?forEach\(el=>el\.style\.display=""\)/);
  assert.match(app, /closeQueueDashboard\(\)\{[\s\S]*?forEach\(el=>el\.style\.display=""\)/);
});

test("no heading, job card or loader starts hidden through an inline display", () => {
  const tags = html.match(/<[a-z]+\b[^>]*\bclass="(?:sechead|jobcard|jobloading)\b[^"]*"[^>]*>/g);
  assert.ok(tags && tags.length >= 3);
  for (const tag of tags) assert.doesNotMatch(tag, /style="[^"]*display/, tag);
});

test("Selected Model shows and hides through its class, never its inline display", () => {
  assert.match(css, /#jobsechead\{display:none;\}/);
  assert.match(css, /#jobsechead\.show\{display:flex;\}/);
  // The one inline write left is the single-printer link's permanent "none",
  // which a restore can clear safely: nothing adds .show there.
  const writes = [...(app + library).matchAll(/jobsechead"\)\.style\.display=("[^"]*")/g)].map(m => m[1]);
  assert.deepEqual(writes, ['"none"']);
  assert.doesNotMatch(app + library, /jobsechead'\)\.style\.display/);
});

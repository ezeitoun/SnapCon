// test/warnModifier.test.js — `.warn` is an amber colour modifier, not a
// hidden panel (docs/TODO.md §35).
//
// The print panel's no-colors warning box used to be styled as `.warn`, with
// display:none until `.show`. Every other element carrying the modifier —
// .settings-help.warn (the Notifications topic and webhook warnings, the
// G-code folder "no files" warning, the Telegram sign-in note), the 3MF "Not
// sliced" badge, the warranty "expires" value, firmware status chips, Remote
// Access's "Password only" tag, Library location status — got display:none
// from it too, and none of them ever showed. The box is now styled by its id.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// Every rule whose selector list includes `.warn` on its own (no other class
// or element compounded with it).
function bareWarnRules() {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, "")))) {
    const selectors = m[1].split(",").map(s => s.trim());
    if (selectors.some(s => /(^|[\s>+~])\.warn(\.[\w-]+)*$/.test(s) && !/[\w\]]\.warn/.test(s))) out.push(m[0].trim());
  }
  return out;
}

test("no rule hides everything with the warn class", () => {
  assert.deepEqual(bareWarnRules(), []);
});

test("the print panel's warning box is styled by its id, hidden until .show", () => {
  assert.match(css, /#warn\{display:none;/);
  assert.match(css, /#warn\.show\{display:block;\}/);
  assert.match(html, /<div class="warn" id="warn"><\/div>/);
  assert.match(appSrc, /const warn=\$\("warn"\);\s*\n\s*if\(MAP\.noColors\)\{ warn\.classList\.add\("show"\)/);
});

test("the status line has a warn colour, which the firmware summary uses", () => {
  assert.match(css, /\.pstatus\.warn\{color:var\(--warn\);\}/);
  assert.match(appSrc, /st\.className="pstatus "\+sum\.tone;/);
});

test("Discover's Add shows the new row in the Printers unsaved-changes footer at once", () => {
  const at = appSrc.indexOf("async function runDiscover(");
  const body = appSrc.slice(at, appSrc.indexOf("\n}", at));
  assert.match(body, /btn\.addEventListener\("click",\(\)=>\{ addPrinterRow\(f\.device_name\|\|"U1", f\.url, \{serial:f\.serial\|\|""\},true\); markPrintersDirty\(\);/);
});

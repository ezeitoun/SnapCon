// Writes the card scope guard's golden files from the current public/app.js:
//   npm run test:update-golden
// Run it only when a change to Full, Camera or List view is intended, and say
// so in the commit message; the guard exists so that a Compact-only change
// never needs it.
const fs = require("fs");
const path = require("path");
const { makeHarness } = require("../../helpers/cardHarness");
const printers = require("./printers");

const VIEWS = {
  "full-classic": { view: "regular", layout: "classic" },
  "full-v2": { view: "regular", layout: "v2" },
  camera: { view: "camera", layout: "classic" },
  list: { view: "list", layout: "classic" },
};

function render(viewName, state) {
  const h = makeHarness(VIEWS[viewName]);
  return viewName === "list" ? h.listRow(printers[state]) : h.card(printers[state]);
}

if (require.main === module) {
  for (const v of Object.keys(VIEWS)) for (const s of Object.keys(printers)) {
    fs.writeFileSync(path.join(__dirname, `${v}.${s}.html`), render(v, s) + "\n");
  }
  console.log("written");
}

module.exports = { VIEWS, render };

// test/costPlaceholders.test.js — the example in an empty cost box cannot be
// read as a saved value.
//
// Reported 2026-11-27: Settings > General showed "20" in "Filament, per
// spool" although no price was set. It was the box's example text; with
// nothing saved, no cost was shown anywhere. The two cost boxes now say
// "e.g. 20" and "e.g. 0.13", in both languages.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("the filament price and electricity rate boxes show an example that is not a bare number", () => {
  for (const [id, key] of [["setFilamentCost", "filament_cost_placeholder"], ["setElectricityRate", "electricity_rate_placeholder"]]) {
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html);
    assert.ok(tag, id);
    const shown = /\splaceholder="([^"]*)"/.exec(tag[0])[1];
    assert.doesNotMatch(shown, /^[\d.]+$/, id + " must not look like a value");
    assert.match(tag[0], new RegExp(`data-i18n-placeholder="settings\\.general\\.${key}"`));
    for (const loc of ["en", "es"]) {
      const text = require(`../locales-default/${loc}.json`).settings.general[key];
      assert.ok(text && !/^[\d.]+$/.test(text), loc + " " + key);
      assert.match(text, /\d/, "it still gives a number as the example");
    }
    assert.equal(shown, require("../locales-default/en.json").settings.general[key], "the page's own text is the English one");
  }
});

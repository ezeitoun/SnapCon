// test/energyCost.test.js — a print's energy cost uses the printer's own power
// draw (docs/TODO.md §45). Before: every energy cost was electricityRate ×
// hours, as if each printer drew 1,000 W, in three places, and the "Power
// draw, watts" field was never read. Owner's decisions (2026-11-09): no energy
// part when the watts (or rate) are unknown; the File Browser's file line
// shows filament cost only; the basis is recorded; watts reach the browser on
// the fleet row; the config key stays `costKwh`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", "es.json"), "utf8"));
const fn = (src, name) => { const at = src.indexOf("function " + name + "("); assert.ok(at >= 0, name); return src.slice(at, src.indexOf("\n}", at) + 2); };
const plain = o => JSON.parse(JSON.stringify(o));

function server(rate) {
  const sb = { CFG: { electricityRate: rate }, Number, Math };
  vm.createContext(sb); vm.runInContext(fn(serverSrc, "printEnergyEstimate") + "\nthis.f = printEnergyEstimate;", sb);
  return sb.f;
}

test("server: watts × hours × rate, with its basis; the field is text, as Settings stores it", () => {
  const f = server(0.15);
  assert.deepEqual(plain(f({ costKwh: "200" }, 3)), { kwhEst: 0.6, watts: 200, ratePerKwh: 0.15, cost: 0.6 * 0.15, basis: "estimate" });
  // The old rule would have charged 3 h × 0.15 = 0.45 here, as if 1,000 W.
  assert.ok(Math.abs(f({ costKwh: "200" }, 3).cost - 0.09) < 1e-9);
});

test("server: no energy part when the watts, the rate or the time is unknown — never a 1 kW guess", () => {
  for (const [p, h, rate, why] of [[{}, 3, 0.15, "no watts"], [{ costKwh: "" }, 3, 0.15, "empty watts"], [{ costKwh: "0" }, 3, 0.15, "zero watts"],
    [{ costKwh: "-5" }, 3, 0.15, "negative"], [{ costKwh: "abc" }, 3, 0.15, "not a number"], [{ costKwh: "200" }, 3, 0, "no rate"],
    [{ costKwh: "200" }, 3, undefined, "rate unset"], [{ costKwh: "200" }, 0, 0.15, "no time"], [null, 3, 0.15, "no printer"]]) {
    assert.equal(server(rate)(p, h), null, why);
  }
});

test("server: the completed print uses it, records the basis, and the 1 kW rule is gone", () => {
  assert.match(serverSrc, /const energy = printEnergyEstimate\(p, hours\);/);
  assert.match(serverSrc, /const eCost = energy \? energy\.cost : 0;/);
  assert.match(serverSrc, /\.\.\.\(energy \? \{ energy: \{ kwhEst: energy\.kwhEst, watts: energy\.watts, ratePerKwh: energy\.ratePerKwh, basis: energy\.basis \} \} : \{\}\)/);
  assert.doesNotMatch(serverSrc, /CFG\.electricityRate \* hours/);
});

test("fleet rows carry the printer's watts (both row builders), null when unknown", () => {
  const fleet = serverSrc.slice(serverSrc.indexOf('app.get("/api/fleet"'), serverSrc.indexOf("\n});", serverSrc.indexOf('app.get("/api/fleet"')));
  assert.equal((fleet.match(/powerDrawW: Number\(p\.costKwh\) > 0 \? Number\(p\.costKwh\) : null,/g) || []).length, 2);
});

function client(rate) {
  const sb = { ELECTRICITY_RATE: rate };
  vm.createContext(sb); vm.runInContext(fn(appSrc, "energyCostEstimate") + "\nthis.f = energyCostEstimate;", sb);
  return sb.f;
}

test("browser: the same rule; the printer-file dialog uses that printer's watts; the File Browser line is filament only", () => {
  assert.ok(Math.abs(client(0.15)(200, 3) - 0.09) < 1e-9, "0.15 × 3 h × 0.2 kW");
  assert.equal(client(0.15)(null, 3), 0, "no watts: no energy part");
  assert.equal(client(0)(200, 3), 0, "no rate");
  assert.equal(client(0.15)(200, 0), 0, "no time");
  assert.match(appSrc, /const eCost=energyCostEstimate\(\(FLEET\.find\(p=>p\.id===PFILE_PRINTER\)\|\|\{\}\)\.powerDrawW, timeSec\/3600\);/);
  assert.match(appSrc, /const totalCost=fCost;/);
  assert.doesNotMatch(appSrc, /ELECTRICITY_RATE\*timeHours|ELECTRICITY_RATE\*\(timeSec\/3600\)/, "no 1 kW rule left in the page");
});

test("Logs tab: the energy basis reads as a kWh estimate, not raw JSON; strings exist in en and es", () => {
  const sb = { CURRENCY: "$", JSON, Object, Math, String, t: (k, p) => { const [a, b, c] = k.split("."); return en[a][b][c].replace("{value}", p.value); } };
  vm.createContext(sb);
  vm.runInContext([appSrc.slice(appSrc.indexOf("const LOG_DETAIL_KNOWN_KEYS="), appSrc.indexOf("\n", appSrc.indexOf("const LOG_DETAIL_KNOWN_KEYS="))),
    fn(appSrc, "fmtLogHM"), fn(appSrc, "fmtLogDetail"), "this.f = fmtLogDetail;"].join("\n"), sb);
  const out = sb.f({ detail: JSON.stringify({ file: "a.gcode", elapsedSec: 10800, costEst: 1.27, energy: { kwhEst: 0.6, watts: 200, ratePerKwh: 0.15, basis: "estimate" } }) });
  assert.match(out, /≈0\.60 kWh \(estimated\)/);
  assert.doesNotMatch(out, /energy:|"watts"/);
  assert.ok(es.settings.logs.detail_energy && en._meta.version >= 115 && es._meta.version >= 115);
});

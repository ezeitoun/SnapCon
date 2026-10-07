// test/pageLoadNoise.test.js — errors and warnings a normal page load used to
// produce in the browser console.
//
// - View-role (and Regular) users got two 403s on every load: loadConfigUI()
//   asked /api/groups and /api/check-folder, both admin-only, for every role.
// - Chrome warned the preloaded JetBrains Mono "was not used" on most loads,
//   though the stylesheet uses it from first paint.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const read = f => fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
const appSrc = read("app.js");
function extractFn(name) {
  const a = appSrc.indexOf("async function " + name + "(");
  const at = a >= 0 ? a : appSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in public/app.js");
  return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
}

function world(admin) {
  const asked = [];
  const el = () => ({ className: "", textContent: "", value: "/mnt/gcode" });
  const els = { folderCheckStatus: el(), setFolder: el(), firmwareFolderCheckStatus: el(), setFirmwareFolder: el() };
  const sandbox = {
    isAdmin: () => admin, GROUPS: null,
    getJSON: async url => { asked.push(url); return []; },
    refreshAllPrinterGroupChecklists: () => {},
    $: id => els[id], t: k => k, tn: k => k, clearTimeout: () => {},
    setTimeout: fn => { fn(); },
  };
  vm.createContext(sandbox);
  vm.runInContext("let GROUPS=[]; let FOLDER_CHECK_TIMER=null, FIRMWARE_FOLDER_CHECK_TIMER=null;\n" +
    ["loadGroupsUI", "scheduleFolderCheck", "scheduleFirmwareFolderCheck"].map(extractFn).join("\n"), sandbox);
  return { asked, run: async () => { await vm.runInContext("loadGroupsUI", sandbox)(); vm.runInContext("scheduleFolderCheck", sandbox)(); vm.runInContext("scheduleFirmwareFolderCheck", sandbox)(); await new Promise(r => setImmediate(r)); } };
}

test("a non-admin never asks the admin-only groups and folder-check routes", async () => {
  const w = world(false);
  await w.run();
  assert.deepEqual(w.asked, []);
});

test("an admin still gets the groups list and both folder checks", async () => {
  const w = world(true);
  await w.run();
  assert.equal(w.asked[0], "/api/groups");
  assert.equal(w.asked.filter(u => u.startsWith("/api/check-folder")).length, 2);
});

test("the mono font isn't preloaded; the stylesheet still self-hosts and uses it", () => {
  assert.doesNotMatch(read("index.html"), /rel="preload"[^>]*JetBrainsMono/);
  const css = read("style.css");
  assert.match(css, /@font-face\{\s*font-family:'JetBrains Mono';/);
  assert.match(css, /src:url\('\/fonts\/JetBrainsMono-Variable\.woff2'\)/);
});

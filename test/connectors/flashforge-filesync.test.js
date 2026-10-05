// test/connectors/flashforge-filesync.test.js — file sync on a FlashForge
// running Moonraker (ZMOD / Forge-X), driven through the real sync engine.
//
// Regression: the sync engine used to hand connectors a URL string where every
// other connector call takes the printer. The FlashForge connectors decide the
// transport from the printer (moonrakerOnly), so on a string they found no
// mode, fell back to "native" and refused every sync with "File sync is not
// available on this printer's stock firmware" — on printers that have it.
// The capability test only checked that the functions exist.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mode = require("../../connectors/flashforge-mode");
const fm = require("../../connectors/flashforge-moonraker");
const ad5x = require("../../connectors/flashforge-ad5x");
const adv = require("../../connectors/flashforge-adventurer");
const { createSyncEngine } = require("../../sync/SyncEngine");

const DAY = 86400;

// A modded printer: no native API, Moonraker with one old log file.
function zmodPrinter() {
  const seen = [];
  const files = new Map([["klippy.log", "abc"]]);
  const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push(req.method + " " + u.pathname);
    if (u.pathname === "/detail") { res.statusCode = 404; return res.end(); }
    if (u.pathname === "/printer/info") return json(res, { result: { state: "ready" } });
    if (u.pathname === "/server/files/list") {
      return json(res, { result: [...files].map(([p, body]) => ({ path: p, size: body.length, modified: Date.now() / 1000 - 30 * DAY })) });
    }
    const m = /^\/server\/files\/logs\/(.+)$/.exec(u.pathname);
    if (m && files.has(decodeURIComponent(m[1]))) {
      const name = decodeURIComponent(m[1]);
      if (req.method === "DELETE") { files.delete(name); return json(res, { result: { item: { path: name } } }); }
      res.setHeader("content-length", files.get(name).length);
      return res.end(files.get(name));
    }
    res.statusCode = 404; res.end();
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () =>
    r({ url: `http://127.0.0.1:${srv.address().port}`, seen, files, close: () => srv.close() })));
}

test.beforeEach(() => { mode._resetAll(); fm._resetCaches(); });

for (const conn of [adv, ad5x]) {
  test(`${conn.label}: sync downloads and cleans up through Moonraker on a modded printer`, async t => {
    const s = await zmodPrinter();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffsync-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ffsync-dest-"));
    const engine = createSyncEngine({ baseDir, getConnector: () => conn });
    t.after(() => { s.close(); engine.store.close && engine.store.close(); });
    const p = { id: "ff_" + Math.random().toString(16).slice(2), name: "AD5X White", url: s.url, connector: "x" };

    const first = await engine.runSync(p, "logs", dest, 0);
    assert.equal(first.downloaded, 1, "got: " + JSON.stringify(first) + " " + s.seen.join(" | "));
    assert.equal(fs.readFileSync(path.join(dest, "AD5X White", "klippy.log"), "utf8"), "abc");

    // With a 7-day retention the 30-day-old file, now safely copied, is removed from the printer.
    await engine.runSync(p, "logs", dest, 7);
    assert.ok(s.seen.includes("DELETE /server/files/logs/klippy.log"), "got: " + s.seen.join(" | "));
    assert.equal(s.files.size, 0);
  });
}

// test/connectors/jobHistory.test.js — fetchJobHistory, the one connector call
// fleet utilization adds: read only (a single GET), bounded, and only on the
// connectors that speak Moonraker.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const httpUtils = require("../../connectors/http-utils");
const { getConnector, CONNECTOR_TYPES } = require("../../connectors");

async function server(t, handler) {
  const seen = [];
  const s = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url }); handler(req, res); });
  await new Promise(r => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  return { p: { url: `http://127.0.0.1:${s.address().port}` }, seen };
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("one GET of /server/history/list, with the paging asked for, limit bounded", async t => {
  const { p, seen } = await server(t, (req, res) => json(res, 200, { result: { count: 2, jobs: [{ job_id: "1" }, { job_id: "2" }] } }));
  const r = await httpUtils.fetchJobHistory(p, { since: 1700000000, start: 100, limit: 5000, order: "asc" });
  assert.deepEqual(r, { count: 2, jobs: [{ job_id: "1" }, { job_id: "2" }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  const u = new URL(seen[0].url, "http://x");
  assert.equal(u.pathname, "/server/history/list");
  assert.deepEqual(Object.fromEntries(u.searchParams), { limit: "100", start: "100", order: "asc", since: "1700000000" });
});

test("no history component (404): unavailable, not an error; other failures throw", async t => {
  const a = await server(t, (req, res) => json(res, 404, { error: { message: "Not Found" } }));
  assert.deepEqual(await httpUtils.fetchJobHistory(a.p), { unavailable: true, count: 0, jobs: [] });
  const b = await server(t, (req, res) => json(res, 500, {}));
  await assert.rejects(httpUtils.fetchJobHistory(b.p), /Moonraker 500/);
  const c = await server(t, (req, res) => json(res, 200, { result: { jobs: "nonsense" } }));
  assert.deepEqual(await httpUtils.fetchJobHistory(c.p), { count: null, jobs: [] });
});

test("a printer that stops answering does not hold it: the timeout ends the request", async t => {
  const { p } = await server(t, () => {});        // never answers
  const t0 = Date.now();
  await assert.rejects(httpUtils.fetchJobHistory(p, { timeoutMs: 300 }));
  assert.ok(Date.now() - t0 < 2000);
});

test("only Moonraker connectors offer job history, and each that declares it exports it", () => {
  const types = CONNECTOR_TYPES || [];
  const declaring = types.filter(ty => { const c = getConnector(ty); return c && c.capabilities && c.capabilities.jobHistory; });
  for (const ty of declaring) assert.equal(typeof getConnector(ty).fetchJobHistory, "function", ty);
  assert.deepEqual(declaring.sort(), ["creality-klipper", "klipper-moonraker", "snapmaker-u1-klipper-ws", "virtual-u1"].filter(x => types.includes(x)).sort());
  for (const ty of types.filter(x => /bambu|flashforge|simulator/.test(x))) assert.ok(!(getConnector(ty).capabilities || {}).jobHistory, ty);
});

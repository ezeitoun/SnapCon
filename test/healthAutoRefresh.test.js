// test/healthAutoRefresh.test.js — the Health page's auto-refresh never
// stacks requests (docs/TODO.md §50): while a Health load is still running, an
// auto-refresh tick is skipped (the fleet poll's FLEET_INFLIGHT rule); an
// explicit load (opening the page, switching printer) is never blocked; a
// failed or timed-out load always releases the guard; both requests are
// bounded so the guard can't stick. Runs public/app.js's own code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const fnSrc = name => {
  const at = appSrc.indexOf((appSrc.includes("async function " + name + "(") ? "async function " : "function ") + name + "(");
  assert.ok(at >= 0, name); return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
};
const lineSrc = start => { const at = appSrc.indexOf(start); assert.ok(at >= 0, start); return appSrc.slice(at, appSrc.indexOf("\n", at)); };
const tick = () => new Promise(r => setImmediate(r));
const T = (name, fn) => test(name, { timeout: 5000 }, fn);

function page({ state = "printing" } = {}) {
  const calls = [];           // { url, signal, resolve, reject }
  let interval = null;
  const sandbox = {
    AbortSignal, Promise, Math, parseInt,
    fetch: (url, opts) => new Promise((resolve, reject) => calls.push({ url, signal: opts && opts.signal, resolve, reject })),
    setInterval: fn => { interval = fn; return 1; }, clearInterval: () => { interval = null; },
    document: { hidden: false }, $: id => (id === "setRefresh" ? { value: "4" } : null),
    FLEET: [{ id: 3, state }], HEALTH_PRINTER_ID: 3, HEALTH_REQ_TOKEN: 0, HEALTH_DATA: null, HEALTH_MAINT: null, HEALTH_ATTENTION_CACHE: {},
    renderHealthBody: () => {}, renderHealthPicker: () => {}, resumeSyncPollingIfRunning: () => {}, healthServiceFormHasFocus: () => false,
    t: (k, p) => k + (p && p.message ? ": " + p.message : ""),
  };
  vm.createContext(sandbox);
  vm.runInContext([lineSrc("let HEALTH_INFLIGHT=0;"), lineSrc("let HEALTH_AUTO_TIMER=null;"), fnSrc("healthAutoRefreshStates"),
    fnSrc("startHealthAutoRefresh"), fnSrc("stopHealthAutoRefresh"), fnSrc("loadHealthData"),
    "this.api={ loadHealthData, startHealthAutoRefresh, inflight: () => HEALTH_INFLIGHT };"].join("\n"), sandbox);
  sandbox.api.startHealthAutoRefresh();
  const health = calls2 => calls2.filter(c => c.url.startsWith("/api/health"));
  return {
    api: sandbox.api, calls, sandbox, tick: () => interval && interval(),
    healthCalls: () => health(calls),
    answer: async (c, body) => { c.resolve({ json: async () => body }); await tick(); await tick(); },
    fail: async (c, e) => { c.reject(e); await tick(); await tick(); },
  };
}

T("an auto-refresh tick loads when nothing is in flight", async () => {
  const p = page();
  p.tick(); await tick();
  assert.equal(p.healthCalls().length, 1);
});

T("a tick while a Health load is still running is skipped; after it answers, the next tick loads", async () => {
  const p = page();
  p.tick(); await tick();
  for (let i = 0; i < 5; i++) { p.tick(); await tick(); }
  assert.equal(p.healthCalls().length, 1, "five more ticks, no new request");
  await p.answer(p.calls[0], { skipped: false });          // the Health answer
  assert.equal(p.api.inflight(), 1, "still waiting for /api/maintenance");
  p.tick(); await tick(); assert.equal(p.healthCalls().length, 1);
  await p.answer(p.calls[1], {});                          // the maintenance answer
  assert.equal(p.api.inflight(), 0);
  p.tick(); await tick();
  assert.equal(p.healthCalls().length, 2, "loads again once the previous one finished");
});

T("an explicit load (switching printer) is never blocked by an auto-refresh in flight", async () => {
  const p = page();
  p.tick(); await tick();
  p.api.loadHealthData(); await tick();
  assert.equal(p.healthCalls().length, 2);
  assert.equal(p.api.inflight(), 2);
});

T("a failed or timed-out load releases the guard", async () => {
  const p = page();
  p.tick(); await tick();
  await p.fail(p.calls[0], Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
  await p.fail(p.calls[1], new Error("network down"));
  assert.equal(p.api.inflight(), 0);
  assert.equal(p.sandbox.HEALTH_DATA.skipped, true, "shown as unavailable, as before");
  p.tick(); await tick();
  assert.equal(p.healthCalls().length, 2, "auto-refresh carries on");
});

T("both requests are bounded, so the guard can't stick", async () => {
  const p = page();
  p.tick(); await tick();
  await p.answer(p.calls[0], { skipped: true });
  assert.equal(p.calls.length, 2);
  for (const c of p.calls) assert.ok(c.signal instanceof AbortSignal, c.url + " has a time limit");
  await p.answer(p.calls[1], {});
});

T("an idle printer is still not auto-refreshed (unchanged)", async () => {
  const p = page({ state: "standby" });
  p.tick(); await tick();
  assert.equal(p.calls.length, 0);
});

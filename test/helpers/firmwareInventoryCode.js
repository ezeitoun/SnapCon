// test/helpers/firmwareInventoryCode.js — loads SnapCon's firmware inventory
// code (GET /api/firmware, probeFirmware, firmwareTabEligible and
// FW_PROBE_TIMEOUT_MS) with injected dependencies, for
// test/firmwareInventoryBehaviour.test.js.
//
// It runs routes/firmwareInventory.js's own source in a vm context and calls
// registerFirmwareInventoryRoutes(app, deps) with the injected dependencies
// (the code moved there from server.js; docs/refactoring-policy.md §3.7 allows
// only loadSource() below to change, the tests' assertions stay identical).
//
// Everything the code reaches is a fake, the same way on both sides of a
// move: app, requireAuth, printerVisibleTo, getConnector, getCapabilities,
// probeCached, the printer list and the timer functions. Nothing in the code
// under test is replaced: probeFirmware and firmwareTabEligible run as
// written and are exercised through the route only (after a move they are not
// reachable by name, and no test seam is needed for them).
//
// The printer list lives in `world.printers`; setPrinters() REPLACES the
// array, the way loadConfig() reassigns PRINTERS on a configuration reload.
// The timers are manual: setTimeout only records { fn, ms }, a test fires
// `fn` itself, and nothing ever waits 20 real seconds.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const MODULE = path.join(__dirname, "..", "..", "routes", "firmwareInventory.js");

// The only part that changes when the code moves.
function loadSource(sandbox, fakes, world) {
  // The module's own source runs in the sandbox. It requires nothing; its
  // dependencies arrive as parameters of registerFirmwareInventoryRoutes —
  // nothing is reachable as a global any more — and the printer list through
  // getPrinters(), read from world.printers at every call, so a replaced
  // array is seen exactly as a reassigned PRINTERS is.
  sandbox.module = { exports: {} };
  sandbox.require = name => { throw new Error("routes/firmwareInventory.js required an unexpected module: " + name); };
  vm.runInContext(fs.readFileSync(MODULE, "utf8"), sandbox, { filename: MODULE });
  const exported = sandbox.module.exports;
  if (Object.keys(exported).join() !== "registerFirmwareInventoryRoutes") throw new Error("unexpected exports: " + Object.keys(exported).join());
  const { app, ...deps } = fakes;
  const returned = exported.registerFirmwareInventoryRoutes(app, { ...deps, getPrinters: () => world.printers });
  if (returned !== undefined) throw new Error("registerFirmwareInventoryRoutes must return nothing");
}

function loadFirmwareInventoryCode(over = {}) {
  const routes = [];
  const timers = { created: [], cleared: [] };
  const world = { printers: over.printers || [] };
  const fakes = {
    app: { get: (p, ...handlers) => routes.push({ method: "GET", path: p, handlers }) },
    requireAuth: over.requireAuth || ((req, res, next) => next()),
    printerVisibleTo: over.printerVisibleTo || (() => true),
    getConnector: over.getConnector || (() => ({})),
    getCapabilities: over.getCapabilities || (() => ({})),
    probeCached: over.probeCached || (async () => ({ online: true, state: "standby" })),
  };
  const sandbox = {
    Symbol, Promise, Math, Array, Object, JSON, Number, String, Set, Map, Error, RegExp, isNaN, parseInt,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.created.push(t); return t; },
    clearTimeout: t => { timers.cleared.push(t); if (t) t.cleared = true; },
  };
  vm.createContext(sandbox);
  loadSource(sandbox, fakes, world);
  const route = routes.find(r => r.path === "/api/firmware");
  if (!route) throw new Error("GET /api/firmware was not registered");
  if (routes.length !== 1) throw new Error("expected exactly one route, got " + routes.map(r => r.path).join(", "));

  // Runs the route's handlers in order, like Express. Resolves when the
  // response has ended (res.json or res.end). `onLine(obj, ctl)` is called for
  // every NDJSON record as it is written. The returned promise carries
  // `.req`, so a test can make the request emit "close" (a browser navigating
  // away) at any moment: `pending.req.emit("close")`.
  function call(query = {}, { user = { role: "admin" }, onLine } = {}) {
    const req = new EventEmitter(); req.query = query; req.user = user;
    const pending = new Promise((resolve, reject) => {
      const out = { status: 200, headers: {}, json: undefined, text: undefined, lines: [], raw: "", ended: false, endCalls: 0, jsonCalls: 0 };
      const done = () => { out.ended = true; resolve(out); };
      const res = {
        get writableEnded() { return out.ended; },
        status(c) { out.status = c; return res; },
        set(k, v) { out.headers[k] = v; return res; },
        json(o) { out.jsonCalls++; out.text = JSON.stringify(o); out.json = JSON.parse(out.text); done(); return res; },
        write(s) { out.raw += s; for (const l of String(s).split("\n")) if (l) { const o = JSON.parse(l); out.lines.push(o); if (onLine) onLine(o, { close: () => req.emit("close") }); } return true; },
        end() { out.endCalls++; done(); },
      };
      let i = 0;
      const next = err => {
        if (err) return reject(err);
        const h = route.handlers[i++];
        if (!h) return reject(new Error("next() called past the last handler"));
        Promise.resolve().then(() => h(req, res, next)).catch(reject);
      };
      next();
    });
    pending.req = req;
    return pending;
  }
  return { route, routes, call, timers, setPrinters: list => { world.printers = list; } };
}

module.exports = { loadFirmwareInventoryCode };

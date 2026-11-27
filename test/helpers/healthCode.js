// test/helpers/healthCode.js — loads SnapCon's Health code (the GET
// /api/health route, its helpers and its module state) with injected
// dependencies, for test/healthBehaviour.test.js.
//
// It runs routes/health.js's own source in a vm context and calls
// registerHealthRoutes(app, deps) with the injected dependencies (the code
// moved there from server.js; docs/refactoring-policy.md §3.7 allows only
// this loader to change, the tests' assertions stay identical).
//
// One load = one process lifetime of that code: its Maps live as long as the
// returned object. Loading again models a restart (fresh, empty state).
// `deps.setPrinters()` / `deps.setConfig()` replace the arrays/objects the
// way loadConfig() reassigns PRINTERS and CFG on a reload.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const MODULE = path.join(__dirname, "..", "..", "routes", "health.js");

function loadHealthCode(over = {}) {
  const code = fs.readFileSync(MODULE, "utf8");
  const routes = [];
  const warns = [];
  const sandbox = {
    Symbol, Promise, Math, Array, Object, JSON, Number, String, Map, Set, Error,
    Date: over.Date || Date,                       // node:test mock.timers replaces the global Date
    setTimeout: over.setTimeout || setTimeout, clearTimeout: over.clearTimeout || clearTimeout,
    module: { exports: {} },
    app: { get: (p, ...handlers) => routes.push({ method: "GET", path: p, handlers }) },
    requireAuth: over.requireAuth || ((req, res, next) => next()),
    PRINTERS: over.printers || [],
    CFG: over.config || {},
    printerVisibleTo: over.printerVisibleTo || (() => true),
    getConnector: over.getConnector || (() => ({})),
    probeCached: over.probeCached || (async () => ({ online: true, state: "standby" })),
    computeMaintenanceAttention: over.computeMaintenanceAttention || (() => []),
    connHttp: over.connHttp || { baseUrl: p => p.url, queryRecentlyPrintedFiles: async () => new Set() },
    console: { warn: m => warns.push(String(m)), log: () => {}, error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code + `
;const __helpers = registerHealthRoutes(app, { requireAuth: this.requireAuth, getConfig: () => this.CFG, getPrinters: () => this.PRINTERS,
  getConnector: this.getConnector, printerVisibleTo: this.printerVisibleTo, probeCached: this.probeCached,
  computeMaintenanceAttention: this.computeMaintenanceAttention, connHttp: this.connHttp });
this.__health = { ...__helpers,
  heaterStableSince, fanMismatchSeen, HEATER_DWELL_MS, HEATER_TARGET_BAND_C, HEALTH_DEADLINE_MS };`, sandbox);
  const h = sandbox.__health;
  const route = routes.find(r => r.path === "/api/health");
  // Run a request through the route's middleware chain like Express does.
  const request = async ({ query = { printer: "0" }, user = null } = {}) => {
    const res = { code: 200, bodies: [], ended: false, status(c) { this.code = c; return this; }, json(b) { this.bodies.push(b); this.ended = true; return this; } };
    const req = { query, user };
    for (const fn of route.handlers) {
      let nextCalled = false;
      await fn(req, res, () => { nextCalled = true; });
      if (res.ended || !nextCalled) break;
    }
    return { status: res.code, body: res.bodies[0], bodies: res.bodies };
  };
  return {
    ...h, request, route, routes, warns,
    setPrinters: list => { sandbox.PRINTERS = list; },
    setConfig: cfg => { sandbox.CFG = cfg; },
  };
}

module.exports = { loadHealthCode };

// test/helpers/snapshotCode.js — loads SnapCon's camera-snapshot route (GET
// /api/snapshot, its throttle and the two Maps behind it) with injected
// dependencies, for test/snapshotBehaviour.test.js.
//
// It runs routes/snapshot.js's own source in a vm context and calls
// registerSnapshotRoutes(app, deps) with the injected dependencies (the code
// moved there from server.js; getSnapshot and checkSnapshot stayed behind —
// getSnapshot is a fake here). docs/refactoring-policy.md §3.7 allows only
// loadSource() below to change, the tests' assertions stay identical.
//
// Everything the code reaches is a fake supplied here, the same way on both
// sides of a move: app, requireAuth, printerVisibleTo, getSnapshot, the
// configuration and the printer list, and the clock (Date.now is `clock.now`,
// so a TTL is driven by assignment, never by waiting).
//
// One load = one process lifetime of that code: its Maps live as long as the
// returned object. Loading again models a restart (fresh, empty state).
// setConfig() / setPrinters() REPLACE the object / the array, the way
// loadConfig() reassigns CFG and PRINTERS on a reload.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const MODULE = path.join(__dirname, "..", "..", "routes", "snapshot.js");

// The only part that changes when the code moves. Returns how a reload
// replaces the configuration and the printer list the code under test sees.
function loadSource(sandbox) {
  // The module's own source runs in the sandbox. It requires nothing; its
  // dependencies arrive as parameters of registerSnapshotRoutes, the
  // configuration and the printer list through getters — nothing is reachable
  // as a global any more.
  const live = { CFG: sandbox.CFG, PRINTERS: sandbox.PRINTERS };
  const deps = { requireAuth: sandbox.requireAuth, getConfig: () => live.CFG, getPrinters: () => live.PRINTERS,
    printerVisibleTo: sandbox.printerVisibleTo, getSnapshot: sandbox.getSnapshot };
  const app = sandbox.app;
  for (const k of ["app", "requireAuth", "printerVisibleTo", "getSnapshot", "CFG", "PRINTERS"]) delete sandbox[k];
  sandbox.module = { exports: {} };
  sandbox.require = name => { throw new Error("routes/snapshot.js required an unexpected module: " + name); };
  vm.runInContext(fs.readFileSync(MODULE, "utf8"), sandbox, { filename: MODULE });
  const exported = Object.keys(sandbox.module.exports);
  if (JSON.stringify(exported) !== '["registerSnapshotRoutes"]') throw new Error("routes/snapshot.js must export registerSnapshotRoutes only, not " + JSON.stringify(exported));
  const returned = sandbox.module.exports.registerSnapshotRoutes(app, deps);
  if (returned !== undefined) throw new Error("registerSnapshotRoutes must return nothing");
  return {
    setConfig: cfg => { live.CFG = cfg; },
    setPrinters: list => { live.PRINTERS = list; },
  };
}

function loadSnapshotCode(over = {}) {
  const routes = [];
  const clock = { now: over.now === undefined ? 1000000 : over.now };
  const fetches = [];                                       // every getSnapshot call: its arguments
  const visibility = [];                                    // every printerVisibleTo call: its arguments
  const getSnapshot = over.getSnapshot || (async p => ({ contentType: "image/jpeg", buffer: Buffer.from("frame of " + p.name) }));
  const printerVisibleTo = over.printerVisibleTo || (() => true);
  const sandbox = {
    Map, Promise, parseInt,
    Date: { now: () => clock.now },
    app: { get: (p, ...handlers) => routes.push({ method: "GET", path: p, handlers }) },
    requireAuth: over.requireAuth || ((req, res, next) => next()),
    printerVisibleTo: (...a) => { visibility.push(a); return printerVisibleTo(...a); },
    getSnapshot: (...a) => { fetches.push(a); return getSnapshot(...a); },
    CFG: over.config || {},
    PRINTERS: over.printers || [],
  };
  vm.createContext(sandbox);
  const reload = loadSource(sandbox);
  const route = routes.find(r => r.path === "/api/snapshot");
  if (!route) throw new Error("GET /api/snapshot was not registered");

  // Runs the route's handlers in order, like Express. Resolves when the
  // response has been answered (res.json or res.send). A request that is
  // never answered (a fetch the test did not expect, and so never settles)
  // fails after 2 s of real time instead of leaving the test file hanging.
  function call(query = {}, { user = { role: "admin" } } = {}) {
    return new Promise((resolve, reject) => {
      const req = { query, user };
      const out = { status: 200, headers: [], json: undefined, body: undefined, answers: 0 };
      const unanswered = setTimeout(() => reject(new Error("GET /api/snapshot was not answered within 2 s: " + JSON.stringify(query))), 2000);
      const done = () => { clearTimeout(unanswered); out.answers++; resolve(out); };
      const res = {
        status(c) { out.status = c; return res; },
        set(k, v) { out.headers.push([k, v]); return res; },
        json(o) { out.json = JSON.parse(JSON.stringify(o)); done(); return res; },
        send(b) { out.body = b; done(); return res; },
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
  }
  return { route, routes, call, clock, fetches, visibility, setConfig: reload.setConfig, setPrinters: reload.setPrinters };
}

module.exports = { loadSnapshotCode };

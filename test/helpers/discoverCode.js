// test/helpers/discoverCode.js — loads SnapCon's Discover code (GET
// /api/discover and its helpers) with injected dependencies, for
// test/discoverBehaviour.test.js.
//
// It runs routes/discover.js's own source in a vm context and calls
// registerDiscoverRoutes(app, deps) with the injected dependencies (the code
// moved there from server.js; docs/refactoring-policy.md §3.7 allows only
// loadSource() below to change, the tests' assertions stay identical).
//
// Everything the code reaches is a fake supplied here, the same way on both
// sides of a move: `os` (interfaces), `dgram` (the route lookup's UDP
// socket), the connector registry (listConnectorTypes/getConnector — a fake
// connector's discoverAt is how a test decides what a scan "finds"),
// requireAdmin, and the timer functions. Nothing in the code under test is
// replaced: discoverAt/discoverIp run as written, against the fake registry.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const MODULE = path.join(__dirname, "..", "..", "routes", "discover.js");
const INTERNAL = ["ipToInt", "intToIp", "maskToPrefixLen", "parseSubnetSpec", "defaultRouteAddress", "scanSubnets", "localSubnets",
  "MIN_SCAN_PREFIX", "SKIP_INTERFACE_RE", "SKIP_ADDRESS_RE", "DISCOVER_PORTS"];

// A dgram stand-in. `behaviour`: "route" (connect succeeds, address() is
// `address`), "silent" (connect never answers), "error" (emits "error"),
// "throw-create" (createSocket throws), "throw-connect" (connect throws).
function fakeDgram({ behaviour = "route", address = "192.168.20.151" } = {}) {
  const sockets = [];
  return {
    sockets,
    createSocket(type) {
      if (behaviour === "throw-create") throw new Error("no sockets");
      const s = new EventEmitter();
      Object.assign(s, { type, closed: 0, connects: [],
        connect(port, host, cb) {
          s.connects.push([port, host]);
          if (behaviour === "throw-connect") throw new Error("connect refused");
          if (behaviour === "route") setImmediate(cb);
          if (behaviour === "error") setImmediate(() => s.emit("error", new Error("ENETUNREACH")));
        },
        address() { return { address }; },
        close() { s.closed++; } });
      sockets.push(s);
      return s;
    },
  };
}

// The only part that changes when the code moves.
function loadSource(sandbox) {
  // The module's own source runs in the sandbox. Its two requires (os, dgram)
  // resolve to the fakes; its dependencies arrive as parameters of
  // registerDiscoverRoutes — nothing is reachable as a global any more.
  const fakes = { os: sandbox.os, dgram: sandbox.dgram };
  const deps = { requireAdmin: sandbox.requireAdmin, getConnector: sandbox.getConnector, listConnectorTypes: sandbox.listConnectorTypes };
  const app = sandbox.app;
  for (const k of ["os", "dgram", "app", "requireAdmin", "getConnector", "listConnectorTypes"]) delete sandbox[k];
  sandbox.module = { exports: {} };
  sandbox.require = name => { if (!(name in fakes)) throw new Error("routes/discover.js required an unexpected module: " + name); return fakes[name]; };
  vm.runInContext(fs.readFileSync(MODULE, "utf8"), sandbox, { filename: MODULE });
  const { registerDiscoverRoutes, _internal } = sandbox.module.exports;
  const returned = registerDiscoverRoutes(app, deps);
  if (returned !== undefined) throw new Error("registerDiscoverRoutes must return nothing");
  for (const n of INTERNAL) if (!(n in _internal)) throw new Error("_internal is missing " + n);
  return _internal;
}

function loadDiscoverCode(over = {}) {
  const routes = [];
  const timers = { created: [], cleared: [] };
  const dgram = over.dgram || fakeDgram();
  const connectors = over.connectors || {};                 // { type: connectorObject }, in registry order
  const sandbox = {
    Symbol, Promise, Math, Array, Object, JSON, Number, String, Set, Map, Error, RegExp, isNaN, parseInt,
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); timers.created.push({ t, ms }); return t; },
    clearTimeout: t => { timers.cleared.push(t); return clearTimeout(t); },
    os: { networkInterfaces: () => (typeof over.interfaces === "function" ? over.interfaces() : over.interfaces || {}) },
    dgram,
    app: { get: (p, ...handlers) => routes.push({ method: "GET", path: p, handlers }) },
    requireAdmin: over.requireAdmin || ((req, res, next) => next()),
    listConnectorTypes: over.listConnectorTypes || (() => Object.keys(connectors).map(type => ({ type }))),
    getConnector: over.getConnector || (type => connectors[type]),
  };
  vm.createContext(sandbox);
  const internal = loadSource(sandbox);
  const route = routes.find(r => r.path === "/api/discover");
  if (!route) throw new Error("GET /api/discover was not registered");

  // Runs the route's handlers in order, like Express. Resolves when the
  // response has ended (res.json or res.end). `onLine(obj, ctl)` is called for
  // every NDJSON record as it is written; ctl.close() makes the request emit
  // "close", as a browser navigating away does.
  function call(query = {}, { user = { role: "admin" }, onLine } = {}) {
    return new Promise((resolve, reject) => {
      const req = new EventEmitter(); req.query = query; req.user = user;
      const out = { status: 200, headers: {}, json: undefined, lines: [], raw: "", ended: false, nextCalls: 0 };
      const done = () => { out.ended = true; resolve(out); };
      const res = {
        get writableEnded() { return out.ended; },
        status(c) { out.status = c; return res; },
        set(k, v) { out.headers[k] = v; return res; },
        json(o) { out.json = JSON.parse(JSON.stringify(o)); done(); return res; },
        write(s) { out.raw += s; for (const l of String(s).split("\n")) if (l) { const o = JSON.parse(l); out.lines.push(o); if (onLine) onLine(o, { close: () => req.emit("close") }); } return true; },
        end() { done(); },
      };
      let i = 0;
      const next = err => {
        if (err) return reject(err);
        out.nextCalls++;
        const h = route.handlers[i++];
        if (!h) return reject(new Error("next() called past the last handler"));
        Promise.resolve().then(() => h(req, res, next)).catch(reject);
      };
      out.nextCalls = -1;                                    // the first next() starts the chain
      next();
    });
  }
  return { route, call, internal, dgram, timers, sandbox };
}

module.exports = { loadDiscoverCode, fakeDgram };

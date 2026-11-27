// tools/refactor/harness/lifecycle-probe.js — preloaded (node --require) into
// SnapCon ONLY inside the isolated harness container, identically for base
// and head. Never part of the app. Records, per process start:
//   - every setInterval: creator function, delay, unref'd, cleared;
//   - every setTimeout created before the HTTP server listens (start-up);
//   - every runtime setTimeout whose delay is in LIFECYCLE_TRACK_DELAYS
//     (e.g. the Health deadline): created / cleared / fired;
//   - every process.on/once/addListener: event and creator;
//   - intervals still active when the process exits.
// Written to LIFECYCLE_OUT at exit. Creators are function names (not files or
// line numbers), so moving a function to another module does not change them.
"use strict";
const fs = require("fs");
const net = require("net");

const OUT = process.env.LIFECYCLE_OUT;
const TRACK = new Set(String(process.env.LIFECYCLE_TRACK_DELAYS || "").split(",").filter(Boolean).map(Number));
const rec = { intervals: [], startupTimeouts: [], tracked: {}, listeners: [], listening: false };

function creator() {
  const lines = String(new Error().stack).split("\n").slice(2);
  for (const l of lines) {
    if (l.includes("lifecycle-probe.js") || l.includes("node:internal") || l.includes("(node:")) continue;
    const m = /at (?:async )?([^ (]+) \(/.exec(l);
    return m ? m[1].replace(/^Object\./, "") : "<anonymous>";
  }
  return "<unknown>";
}

const origSetInterval = global.setInterval, origClearInterval = global.clearInterval;
const origSetTimeout = global.setTimeout, origClearTimeout = global.clearTimeout;
const byTimer = new WeakMap();
function watch(t, entry) {
  byTimer.set(t, entry);
  const u = t.unref;
  t.unref = function () { entry.unref = true; return u.call(this); };
  return t;
}
global.setInterval = function (fn, ms, ...a) {
  const e = { creator: creator(), delay: Number(ms) || 0, unref: false, cleared: false, phase: rec.listening ? "runtime" : "startup" };
  rec.intervals.push(e);
  return watch(origSetInterval.call(this, fn, ms, ...a), e);
};
global.clearInterval = function (t) { const e = t && byTimer.get(t); if (e) e.cleared = true; return origClearInterval.call(this, t); };
global.setTimeout = function (fn, ms, ...a) {
  const delay = Number(ms) || 0;
  if (!rec.listening) {
    const e = { creator: creator(), delay, unref: false, cleared: false };
    rec.startupTimeouts.push(e);
    return watch(origSetTimeout.call(this, fn, ms, ...a), e);
  }
  if (TRACK.has(delay)) {
    const s = rec.tracked[delay] = rec.tracked[delay] || { created: 0, cleared: 0, fired: 0 };
    s.created++;
    const e = { tracked: delay };
    const t = origSetTimeout.call(this, function (...x) { s.fired++; return fn.apply(this, x); }, ms, ...a);
    byTimer.set(t, e);
    return t;
  }
  return origSetTimeout.call(this, fn, ms, ...a);
};
global.clearTimeout = function (t) {
  const e = t && byTimer.get(t);
  if (e) { if (e.tracked !== undefined) { if (!e.done) { rec.tracked[e.tracked].cleared++; e.done = true; } } else e.cleared = true; }
  return origClearTimeout.call(this, t);
};
// The probe's own exit handler, registered BEFORE process.on/once are wrapped,
// so it is never recorded as one of the app's listeners.
process.once("exit", () => {
  if (!OUT) return;
  try {
    rec.activeIntervalsAtExit = rec.intervals.filter(e => !e.cleared).map(e => e.creator + "|" + e.delay + "|unref=" + e.unref).sort();
    fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));
  } catch { /* best effort: a missing file is reported by the runner */ }
});
for (const m of ["on", "once", "addListener", "prependListener"]) {
  const orig = process[m];
  process[m] = function (event, fn) { if (typeof event === "string") rec.listeners.push({ event, method: m, creator: creator() }); return orig.call(this, event, fn); };
}
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  this.once("listening", () => { rec.listening = true; });
  return origListen.apply(this, a);
};

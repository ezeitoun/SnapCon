// test/lastSeen.test.js — when SnapCon last reached each printer (lastSeenAt
// on /api/fleet, the offline card's "Last seen 14:02 · 2h 03m ago").
//
// Recorded in probeCached(), the one function every probe goes through (the
// fleet poll and notifyTick's background poll alike): set on a successful
// probe, never by a failed one, in memory only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
function extractFn(name) {
  const a = serverSrc.indexOf("async function " + name + "(");
  const at = a >= 0 ? a : serverSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}
const line = start => { const at = serverSrc.indexOf(start); assert.ok(at >= 0, start); return serverSrc.slice(at, serverSrc.indexOf("\n", at)); };

function world() {
  let answer = { online: true, state: "standby" };
  let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
  const sandbox = {
    Map, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    OFFLINE_RETRY_MS: 10 * 1000,
    offlineCache: new Map(),
    getConnector: () => ({ probe: async () => ({ ...answer }) }),
    stabilizeTemp: (_k, v) => v, stampCompletedAt: (_p, r) => r,
    firmwareNoteObserved: () => {}, firmwareCardState: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(line("const LAST_SEEN = new Map();") + "\n" + line("const lastSeenIso = p =>") + "\n" + extractFn("probeCached") +
    "\nthis.LAST_SEEN = LAST_SEEN; this.lastSeenIso = lastSeenIso; this.probeCached = probeCached;", sandbox);
  return {
    sandbox, set: a => { answer = a; }, advance: ms => { clock += ms; }, now: () => clock,
    probe: p => sandbox.probeCached(p), seen: p => sandbox.lastSeenIso(p),
  };
}
const P = { id: "p_1", url: "http://192.168.4.9", connector: "x" };

test("never reached: no time (the card says so)", () => {
  assert.equal(world().seen(P), null);
});

test("a successful probe records the time", async () => {
  const w = world();
  await w.probe(P);
  assert.equal(w.seen(P), new Date(w.now()).toISOString());
  w.advance(60 * 1000);
  await w.probe(P);
  assert.equal(w.seen(P), new Date(w.now()).toISOString(), "and moves with every later one");
});

test("a failed probe leaves the last time untouched, and so does a cached offline answer", async () => {
  const w = world();
  await w.probe(P);
  const before = w.seen(P);
  w.set({ online: false, error: "unreachable" });
  w.advance(5 * 60 * 1000);
  await w.probe(P);                       // a real failed probe
  assert.equal(w.seen(P), before);
  w.advance(1000);
  await w.probe(P);                       // inside OFFLINE_RETRY_MS: answered from the cache
  assert.equal(w.seen(P), before);
});

test("keyed by printer id, so an edited URL keeps its history and two printers don't share one", async () => {
  const w = world();
  await w.probe(P);
  assert.equal(w.seen({ ...P, url: "http://192.168.4.10" }), w.seen(P));
  assert.equal(w.seen({ ...P, id: "p_2" }), null);
});

test("/api/fleet sends lastSeenAt on both of its row builders, after the probe it reflects", () => {
  const fleet = serverSrc.slice(serverSrc.indexOf('app.get("/api/fleet"'), serverSrc.indexOf("\n});", serverSrc.indexOf('app.get("/api/fleet"')));
  assert.equal((fleet.match(/\.\.\.\(await probeCached\(p\)\), lastSeenAt: lastSeenIso\(p\)/g) || []).length, 2);
});

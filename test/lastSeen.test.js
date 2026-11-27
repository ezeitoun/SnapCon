// test/lastSeen.test.js — when SnapCon last reached each printer (lastSeenAt
// on /api/fleet, the offline card's "Last seen 14:02 · 2h 03m ago").
//
// Recorded by fleetProbe.js for every real, current probe — the authoritative
// probeCached() (notifyTick's background poll and every decision) and the
// fleet's display path alike: set on a successful probe, never by a failed or
// cached one, in memory only. (§48 moved the cache into fleetProbe.js; these
// run the real module with the server's own wiring lines.)
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
const block = start => { const at = serverSrc.indexOf(start); assert.ok(at >= 0, start); return serverSrc.slice(at, serverSrc.indexOf("\n});", at) + 4); };
const fleetProbe = require("../fleetProbe");

const P = { id: "p_1", url: "http://192.168.40.9", connector: "x" };
const P2 = { id: "p_2", url: "http://192.0.2.10", connector: "x" };
function world() {
  let answer = { online: true, state: "standby" };
  let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
  const sandbox = {
    Map, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    OFFLINE_RETRY_MS: 10 * 1000,
    PRINTERS: [P, P2], CFG: {},
    getConnector: () => ({ probe: async () => ({ ...answer }) }),
    stabilizeTemp: (_k, v) => v, stampCompletedAt: (_p, r) => r,
    firmwareNoteObserved: () => {}, firmwareCardState: () => null,
    // The real module, on this test's clock.
    createFleetProbe: o => fleetProbe.createFleetProbe({ ...o, now: () => clock }), fleetProbeKeyOf: fleetProbe.keyOf,
  };
  vm.createContext(sandbox);
  vm.runInContext(line("const LAST_SEEN = new Map();") + "\n" + line("const lastSeenIso = p =>") + "\n" + block("const FLEET_PROBE = createFleetProbe({") + "\n" +
    extractFn("probeCached") + "\n" + extractFn("probeForDisplay") + "\n" + extractFn("finishProbe") +
    "\nthis.LAST_SEEN = LAST_SEEN; this.lastSeenIso = lastSeenIso; this.probeCached = probeCached; this.probeForDisplay = probeForDisplay;", sandbox);
  return {
    sandbox, set: a => { answer = a; }, advance: ms => { clock += ms; }, now: () => clock,
    probe: p => sandbox.probeCached(p), display: p => sandbox.probeForDisplay(p), seen: p => sandbox.lastSeenIso(p),
  };
}

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
  assert.equal(w.seen({ ...P, url: "http://192.168.40.10" }), w.seen(P));
  assert.equal(w.seen({ ...P, id: "p_2" }), null);
});

test("the fleet's display path records it the same way: success yes, failure and served-offline no", async () => {
  const w = world();
  await w.display(P);
  const first = w.seen(P);
  assert.equal(first, new Date(w.now()).toISOString());
  w.set({ online: false, error: "unreachable" });
  w.advance(60 * 1000);
  await w.display(P);                     // a real failed probe (last seen online, so it is awaited)
  assert.equal(w.seen(P), first);
  w.advance(20 * 1000);
  const r = await w.display(P);           // served from the offline result; a background re-check fails too
  assert.equal(r.online, false); assert.ok(r.statusCheckedAt, "a served offline result says when it was observed");
  await new Promise(res => setImmediate(res)); await new Promise(res => setImmediate(res));
  assert.equal(w.seen(P), first);
});

test("/api/fleet sends lastSeenAt on both of its row builders, after the probe it reflects", () => {
  const fleet = serverSrc.slice(serverSrc.indexOf('app.get("/api/fleet"'), serverSrc.indexOf("\n});", serverSrc.indexOf('app.get("/api/fleet"')));
  assert.equal((fleet.match(/\.\.\.\(await probeForDisplay\(p\)\), lastSeenAt: lastSeenIso\(p\)/g) || []).length, 2);
});

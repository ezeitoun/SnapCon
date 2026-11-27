// test/fleetProbe.test.js — the fleet's non-blocking offline display path
// (docs/TODO.md §48) and stable printer identity (§43), with a controllable
// fake connector and a fake clock. Owner's safeguards (2026-11-08): display
// only; never a stale online/printing status; one display probe per printer,
// cleaned up on success, timeout and failure; bounded background work; no
// unhandled rejections; last-seen only from real successes; removed,
// re-addressed or re-transported printers can't be overwritten by an
// obsolete probe; a defined switch-off; decision paths always authoritative.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createFleetProbe, keyOf, signatureOf } = require("../fleetProbe");

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 4) { for (let i = 0; i < n; i++) await tick(); }

// A world: printers, a clock, timers, and a connector whose every probe waits
// until the test answers it.
function world({ backgroundMax = 4, displayTimeoutMs = 30000 } = {}) {
  let clock = 1_000_000;
  const printers = [];
  const calls = [];            // { p, resolve, reject, at }
  const seen = new Map();      // id -> ms
  const timers = [];
  let on = true;
  const fp = createFleetProbe({
    probe: p => new Promise((resolve, reject) => calls.push({ p, resolve, reject, at: clock })),
    currentPrinter: key => printers.find(x => keyOf(x) === key) || null,
    onOnline: (p, at) => seen.set(p.id, at),
    enabled: () => on,
    now: () => clock,
    retryMs: 10000, backgroundMax, displayTimeoutMs,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, done: false }; timers.push(t); return t; },
    clearTimer: t => { if (t) t.done = true; },
  });
  return {
    fp, printers, calls, seen,
    add: p => { printers.push(p); return p; },
    advance: async ms => { clock += ms; for (const t of timers) if (!t.done && t.at <= clock) { t.done = true; t.fn(); } await settle(); },
    now: () => clock, setEnabled: v => { on = v; },
    pending: () => calls.filter(c => !c.answered),
    answer: async (i, r) => { calls[i].answered = true; calls[i].resolve(r); await settle(); },
    fail: async (i, e) => { calls[i].answered = true; calls[i].reject(e); await settle(); },
  };
}
const OFF = { online: false, error: "fetch failed" };
const ON = { online: true, state: "printing", progress: 0.4 };

// A regression that leaves a probe unanswered must fail, not hang the suite.
const testT = (name, fn) => test(name, { timeout: 5000 }, fn);

let unhandled = [];
process.on("unhandledRejection", e => unhandled.push(e));
test.afterEach(() => { assert.deepEqual(unhandled, [], "no unhandled promise rejections"); unhandled = []; });

// ---------- slow and unreachable printers ----------
testT("an unreachable printer: the first display waits for its probe; after that the fleet never waits for it", async () => {
  const w = world(); const ad5x = w.add({ id: "p_red", url: "http://192.0.2.13:7125", connector: "flashforge-ad5x" });
  const first = w.fp.display(ad5x);
  assert.equal(w.calls.length, 1);
  await w.answer(0, OFF);
  assert.deepEqual((await first).result, OFF);
  // 30 s later the retry window has passed: answered at once from the offline result,
  // with one background re-check started — the reply does not wait for it.
  await w.advance(30000);
  let done = false; const r = w.fp.display(ad5x).then(x => { done = true; return x; });
  await settle();
  assert.equal(done, true, "answered without waiting for the 6-7 s probe");
  assert.equal((await r).cached, true); assert.deepEqual((await r).result, OFF);
  assert.equal(w.pending().length, 1, "one background re-check under way");
  assert.equal(w.fp.stats().background, 1);
});

testT("inside the retry window an offline printer is not probed again at all", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  const r = w.fp.display(p); await w.answer(0, OFF); await r;
  await w.advance(5000);
  await w.fp.display(p); await w.fp.display(p);
  assert.equal(w.calls.length, 1);
});

// ---------- concurrent fleet requests ----------
testT("concurrent display requests share one probe per printer (unknown printer)", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  const many = Array.from({ length: 10 }, () => w.fp.display(p));
  await settle();
  assert.equal(w.calls.length, 1, "ten requests, one probe");
  await w.answer(0, ON);
  for (const r of await Promise.all(many)) assert.deepEqual(r.result, ON);
  assert.equal(w.fp.stats().inflight, 0, "cleaned up after success");
});

testT("concurrent requests for an offline printer due a re-check start one background probe", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  const r = w.fp.display(p); await w.answer(0, OFF); await r;
  await w.advance(10000);
  await Promise.all(Array.from({ length: 8 }, () => w.fp.display(p)));
  assert.equal(w.calls.length, 2, "one initial probe + one shared background re-check");
});

testT("background re-checks are bounded fleet-wide; skipped ones are tried on a later poll", async () => {
  const w = world({ backgroundMax: 4 });
  const ps = Array.from({ length: 6 }, (_, i) => w.add({ id: "p" + i, url: "http://h" + i }));
  for (const p of ps) { const r = w.fp.display(p); await w.answer(w.calls.length - 1, OFF); await r; }
  await w.advance(10000);
  for (const p of ps) await w.fp.display(p);
  assert.equal(w.fp.stats().background, 4); assert.equal(w.pending().length, 4);
  assert.equal(w.fp.stats().skippedBusy, 2);
  for (let i = 6; i < 10; i++) await w.answer(i, OFF);
  assert.equal(w.fp.stats().background, 0);
});

// ---------- recovery ----------
testT("recovery: a background re-check that finds the printer online clears the offline result; the next poll is a live probe", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  let r = w.fp.display(p); await w.answer(0, OFF); await r;
  await w.advance(10000);
  r = await w.fp.display(p); assert.equal(r.cached, true);          // still shown offline…
  await w.answer(1, ON);                                             // …the background re-check sees it back
  assert.ok(w.seen.has("a"), "last seen recorded from the real success");
  const next = w.fp.display(p); await settle();
  assert.equal(w.calls.length, 3, "an online printer is always probed live, never served from memory");
  await w.answer(2, ON);
  assert.deepEqual((await next).result, ON); assert.equal((await next).cached, false);
});

testT("an online or printing status is never served from memory", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  for (let i = 0; i < 3; i++) { const r = w.fp.display(p); await settle(); await w.answer(i, ON); assert.equal((await r).cached, false); }
  assert.equal(w.calls.length, 3);
  assert.equal(w.fp.stats().offlineEntries, 0);
});

// ---------- failed and timed-out probes ----------
testT("a probe that throws: the display shows it offline, nothing is recorded, the slot is freed, no unhandled rejection", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  const r = w.fp.display(p); await w.fail(0, new Error("EHOSTUNREACH"));
  const out = await r;
  assert.equal(out.result.online, false); assert.equal(out.result.error, "EHOSTUNREACH");
  assert.equal(w.fp.stats().inflight, 0); assert.equal(w.fp.stats().offlineEntries, 0, "a throw is not stored, as before");
  w.fp.display(p); await settle(); assert.equal(w.calls.length, 2, "so the next poll probes again");
  await w.answer(1, OFF);
});

testT("a probe that never answers: the display gives up at displayTimeoutMs; its late answer is ignored", async () => {
  const w = world({ displayTimeoutMs: 30000 }); const p = w.add({ id: "a", url: "http://x" });
  const r = w.fp.display(p); await settle();
  await w.advance(30000);
  const out = await r;
  assert.equal(out.result.error, "timeout"); assert.equal(w.fp.stats().inflight, 0); assert.equal(w.fp.stats().timeouts, 1);
  await w.answer(0, ON);                                             // the connector finally answers
  assert.equal(w.seen.has("a"), false, "a late answer after the timeout records nothing");
  await w.fail(0, new Error("late")).catch(() => {});                // and a late failure is not unhandled
});

testT("the fresh (authoritative) path throws to its caller, as probeCached always did", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  const r = assert.rejects(w.fp.fresh(p), /boom/);      // the caller's handler is attached first
  await w.fail(0, new Error("boom"));
  await r;
});

// ---------- identity (§43) ----------
testT("§43: two printers without a URL no longer share one entry", async () => {
  const w = world();
  const a = w.add({ id: "p_a", connector: "simulator" }), b = w.add({ id: "p_b", connector: "simulator" });
  let r = w.fp.fresh(a); await w.answer(0, OFF); await r;
  r = w.fp.fresh(b); await settle();
  assert.equal(w.calls.length, 2, "b is probed for itself, not answered from a's offline result");
  await w.answer(1, ON);
  assert.deepEqual(await r, ON);
  assert.notEqual(keyOf(a), keyOf(b));
});

testT("§43: same URL, different printers: separate; same printer, edited URL: same identity, but the old result is not reused", async () => {
  const w = world();
  const a = w.add({ id: "p_a", url: "http://same" }), b = w.add({ id: "p_b", url: "http://same" });
  let r = w.fp.fresh(a); await w.answer(0, OFF); await r;
  r = w.fp.fresh(b); await settle(); assert.equal(w.calls.length, 2); await w.answer(1, ON); await r;
  assert.equal(keyOf({ id: "p_a", url: "http://new" }), keyOf(a));
  a.url = "http://new";                                              // re-addressed (Rediscover, Settings)
  r = w.fp.fresh(a); await settle(); assert.equal(w.calls.length, 3, "a changed address is never answered from the old address's result");
  await w.answer(2, ON);
});

testT("printers without an id (should not exist) are told apart by their whole configuration, never by URL alone", () => {
  assert.notEqual(keyOf({ connector: "simulator", name: "Dummy#1" }), keyOf({ connector: "simulator", name: "Dummy#2" }) === keyOf({ connector: "simulator" }) ? "x" : "y");
  assert.notEqual(keyOf({ url: "http://h", serial: "A" }), keyOf({ url: "http://h", serial: "B" }));
  assert.equal(signatureOf({ url: "u", name: "A", tags: ["x"] }), signatureOf({ url: "u", name: "B" }), "display-only fields are not part of it");
});

// ---------- configuration changes, rediscovery, removal ----------
testT("a configuration change during an in-flight probe: its result is discarded; new requests do not join it", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://old", transport: "native" });
  const r1 = w.fp.display(p); await settle();
  const idx = w.printers.indexOf(p); w.printers[idx] = { ...p, transport: "moonraker" };   // transport pinned while probing
  const r2 = w.fp.display(w.printers[idx]); await settle();
  assert.equal(w.calls.length, 2, "the new configuration gets its own probe");
  await w.answer(0, ON);                                             // the old probe answers "online"
  assert.equal(w.seen.has("a"), false, "an obsolete probe records nothing");
  assert.equal(w.fp.stats().discarded, 1);
  await w.answer(1, OFF); await r1; await r2;
  assert.equal(w.fp.stats().offlineEntries, 1); assert.equal(w.fp.stats().inflight, 0);
});

testT("removal during a probe: nothing is recorded for a printer that no longer exists; prune forgets it", async () => {
  const w = world(); const p = w.add({ id: "gone", url: "http://x" });
  let r = w.fp.display(p); await w.answer(0, OFF); await r;
  await w.advance(10000);
  await w.fp.display(p);                                             // background re-check starts
  w.printers.splice(0, 1);                                           // removed from config meanwhile
  await w.answer(1, ON);
  assert.equal(w.seen.has("gone"), false);
  w.fp.prune(new Set(w.printers.map(keyOf)));
  assert.equal(w.fp.stats().offlineEntries, 0);
});

testT("an older probe that finishes after a newer one never overwrites it", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  const older = w.fp.fresh(p); await settle();
  await w.advance(1000);
  const newer = w.fp.fresh(p); await settle();
  await w.answer(1, ON); await newer;                                // newer: online
  await w.answer(0, OFF); await older;                               // older: offline, arrives last
  assert.equal(w.fp.stats().offlineEntries, 0, "the newer online result stands");
});

// ---------- the switch ----------
testT("switched off: display() is exactly fresh() — no served offline results, no sharing", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  let r = w.fp.display(p); await w.answer(0, OFF); await r;
  await w.advance(10000);
  w.setEnabled(false);
  r = w.fp.display(p); await settle();
  assert.equal(w.calls.length, 2, "probed and awaited, as before §48");
  let done = false; r.then(() => { done = true; }); await settle(); assert.equal(done, false);
  await w.answer(1, OFF); assert.equal((await r).cached, false);
});

testT("switched off while a background re-check is in flight: it finishes and is recorded normally; nothing is left running", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  let r = w.fp.display(p); await w.answer(0, OFF); await r;
  await w.advance(10000);
  await w.fp.display(p);                                             // background re-check in flight
  w.setEnabled(false);
  const f = w.fp.display(p); await settle();                         // off: an authoritative probe of its own
  assert.equal(w.calls.length, 3);
  await w.answer(1, ON);                                             // the background one: a real, current result
  assert.ok(w.seen.has("a"));
  await w.answer(2, ON); assert.deepEqual((await f).result, ON);
  assert.equal(w.fp.stats().inflight, 0); assert.equal(w.fp.stats().background, 0);
});

// ---------- decision paths stay authoritative ----------
testT("fresh() never joins a display probe, never serves an expired offline result, never serves an online one", async () => {
  const w = world(); const p = w.add({ id: "a", url: "http://x" });
  const d = w.fp.display(p); await settle();                         // a display probe in flight
  const f = w.fp.fresh(p); await settle();
  assert.equal(w.calls.length, 2, "fresh() starts its own probe");
  await w.answer(0, OFF); await w.answer(1, OFF); await d; await f;
  await w.advance(10000);                                            // the offline result has expired
  await w.fp.display(p);                                             // display serves it (and re-checks in the background)
  const f2 = w.fp.fresh(p); await settle();
  assert.equal(w.calls.length, 4, "fresh() does not accept the expired result the display path still shows");
  await w.answer(2, ON); await w.answer(3, ON); assert.deepEqual(await f2, ON);
  const f3 = w.fp.fresh(p); await settle(); assert.equal(w.calls.length, 5, "an online result is never reused");
  await w.answer(4, ON);
});

testT("every module: only the fleet route uses the display path; every decision and action caller keeps probeCached()", () => {
  // Scans server.js AND every other app module (top-level files and the
  // subsystem/route folders), so a caller moved into a module is still
  // recognised and a new caller anywhere is caught. Any call form counts
  // (with or without await, any argument); comment lines and the two
  // definitions do not. The expected lists are unchanged from the server.js-only
  // version of this test.
  const root = path.join(__dirname, "..");
  const dirs = ["connectors", "remote-access", "sync", "queue", "transfers", "audit", "utilization", "library", "netfs", "routes"];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith(".js") ? [path.join(d, e.name)] : []));
  const files = [...fs.readdirSync(root).filter(f => f.endsWith(".js")).map(f => path.join(root, f)),
    ...dirs.map(d => path.join(root, d)).filter(d => fs.existsSync(d)).flatMap(walk)];
  const sites = name => files.flatMap(file => {
    const src = fs.readFileSync(file, "utf8");
    return [...src.matchAll(new RegExp("\\b" + name + "\\(", "g"))].filter(m => {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const line = src.slice(lineStart, src.indexOf("\n", m.index));
      return !/^\s*(\/\/|\*)/.test(line) && !/\bfunction\s+$/.test(src.slice(lineStart, m.index));
    }).map(m => ({ file: path.relative(root, file), src, at: m.index }));
  });
  // The enclosing named function or route of a call site, in its own file.
  const ownerOf = s => {
    const m = [...s.src.slice(0, s.at).matchAll(/\n\s*(?:async )?function (\w+)\(|\n\s*app\.(?:get|post|put|delete|patch)\("([^"]+)"/g)].pop();
    return m ? (m[1] || m[2]) : "(top level of " + s.file + ")";
  };
  const display = sites("probeForDisplay");
  assert.equal(display.length, 2, "probeForDisplay is called exactly twice in the whole app");
  for (const s of display) {
    assert.equal(s.file, "server.js", "probeForDisplay only in server.js");
    const fleetAt = s.src.indexOf('app.get("/api/fleet"'), fleetEnd = s.src.indexOf("\n});", fleetAt);
    assert.ok(s.at > fleetAt && s.at < fleetEnd, "probeForDisplay only inside GET /api/fleet");
  }
  const callers = sites("probeCached").map(ownerOf).sort();
  assert.deepEqual(callers, ["/api/health", "/api/printer-file-delete", "assertNotActiveJobFile", "firmwareDeployBlockedBy", "isPrinterIdle",
    "notifyTick", "probeFirmware", "reconcileDeferred", "sweepStagedFiles"].sort(),
    "the authoritative callers (update this list only with a reviewed reason)");
  const src = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(src, /async function probeCached\(p\) \{\n  return finishProbe\(p, await FLEET_PROBE\.fresh\(p\)\);\n\}/);
  assert.match(src, /async function probeForDisplay\(p\) \{/);
});

testT("server.js: the switch — default on, live route saved and audited, refused on an unreadable config, kept by a Settings save", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /enabled: \(\) => CFG\.fleetFastOffline !== false,/);
  const route = src.slice(src.indexOf('app.post("/api/fleet-fast-offline", requireAdmin'), src.indexOf("\n});", src.indexOf('app.post("/api/fleet-fast-offline"')));
  assert.match(route, /typeof b\.enabled !== "boolean"/);
  assert.match(route, /if \(CONFIG_LOAD_FAILED\) return res\.status\(409\)/);
  assert.match(route, /catch \(e\) \{ CFG\.fleetFastOffline = prev;/, "a failed save restores the previous value");
  assert.match(route, /event: "fleet-fast-offline-changed"/);
  assert.match(src, /app\.get\("\/api\/fleet-fast-offline", requireAdmin/);
  assert.match(src, /fleetFastOffline: typeof CFG\.fleetFastOffline === "boolean" \? CFG\.fleetFastOffline : undefined,/);
  assert.match(src, /FLEET_PROBE\.prune\(new Set\(PRINTERS\.map\(fleetProbeKeyOf\)\)\);/);
});

testT("the fleet row keeps its schema: a served offline result is the stored one plus statusCheckedAt only", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /return d\.cached \? \{ \.\.\.r, statusCheckedAt: new Date\(d\.checkedAt\)\.toISOString\(\) \} : r;/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8"), /statusCheckedAt/, "a new, optional field the UI does not depend on");
});

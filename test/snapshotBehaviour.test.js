// test/snapshotBehaviour.test.js — behavior pins for GET /api/snapshot, its
// throttle (getSnapshotThrottled) and the two Maps behind it, written BEFORE
// any refactoring (docs/refactoring-policy.md §3.1) for the behaviors no test
// covered (2026-11-19):
//   1. authentication: the route sits behind requireAuth, which runs first;
//   2. printer visibility and the printer argument;
//   3. the cache: its lifetime (TTL), what it is keyed by, shared fetches;
//   4. fresh: always a real fetch, and the cache is re-primed;
//   5. the answer: headers and body;
//   6. failures: the 502, and what a failure leaves behind;
//   7. a configuration reload: what is read again, and what survives.
// These pin what the code does TODAY, including what may look odd (see the
// tests named "today:"). test/snapshotCheck.test.js keeps getSnapshot's own
// checks of a connector's answer. Real HTTP and authentication are pinned by
// the contract harness (tools/refactor/harness). Loads the code through
// test/helpers/snapshotCode.js — only that loader may change when the code moves.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSnapshotCode } = require("./helpers/snapshotCode");

const ALPHA = { id: "p_alpha", name: "Alpha", connector: "x" };
const BRAVO = { id: "p_bravo", name: "Bravo", connector: "x" };
const frame = (text, contentType = "image/jpeg") => ({ contentType, buffer: Buffer.from(text) });
const flush = () => new Promise(r => setImmediate(r));
// A getSnapshot whose every call waits until the test settles it:
// calls[i].resolve(frame) / calls[i].reject(error).
function manual() {
  const calls = [];
  const getSnapshot = p => new Promise((resolve, reject) => calls.push({ p, resolve, reject }));
  return { calls, getSnapshot };
}
// A getSnapshot that answers at once with a numbered frame per printer:
// "Alpha #1", "Alpha #2", …
function numbered() {
  const n = {};
  return async p => { n[p.name] = (n[p.name] || 0) + 1; return frame(p.name + " #" + n[p.name]); };
}
const text = r => (r.body === undefined ? undefined : r.body.toString());

// ---------- 1. authentication ----------
test("1. GET /api/snapshot is registered with requireAuth as its only middleware, before the handler", () => {
  const requireAuth = (req, res, next) => next();
  const d = loadSnapshotCode({ requireAuth });
  assert.equal(d.routes.length, 1);
  assert.equal(d.route.method, "GET");
  assert.equal(d.route.path, "/api/snapshot");
  assert.equal(d.route.handlers.length, 2);
  assert.equal(d.route.handlers[0], requireAuth);
});
test("1. when requireAuth refuses, the handler never runs (no visibility check, nothing is fetched)", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], requireAuth: (req, res) => res.status(401).json({ error: "Login required" }) });
  for (const query of [{ printer: "0" }, { printer: "0", fresh: "1" }]) {
    const r = await d.call(query, { user: null });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: "Login required" });
    assert.deepEqual(r.headers, []);
    assert.equal(r.body, undefined);
  }
  assert.deepEqual(d.fetches, []);
  assert.deepEqual(d.visibility, []);
});
test("1. nothing is fetched and no visibility is asked when the code is loaded", () => {
  const d = loadSnapshotCode({ printers: [ALPHA] });
  assert.deepEqual(d.fetches, []);
  assert.deepEqual(d.visibility, []);
});

// ---------- 2. printer visibility and the printer argument ----------
test("2. a printer the user may not see: 400 Unknown printer, and nothing is fetched (plain and fresh)", async () => {
  const viewer = { role: "view", groupIds: [] };
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO], printerVisibleTo: (user, p) => p !== BRAVO });
  for (const query of [{ printer: "1" }, { printer: "1", fresh: "1" }]) {
    const r = await d.call(query, { user: viewer });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "Unknown printer" });
    assert.deepEqual(r.headers, []);
    assert.equal(r.body, undefined);
  }
  assert.deepEqual(d.fetches, []);
  assert.equal(d.visibility.length, 2);
  assert.equal(d.visibility[0][0], viewer, "asked with the request's user");
  assert.equal(d.visibility[0][1], BRAVO, "and the printer at that index");
  assert.equal(d.visibility[0].length, 2);
});
test("2. visibility is asked on every request: a frame cached for one user is not given to a user who may not see the printer", async () => {
  const admin = { role: "admin" }, viewer = { role: "view" };
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO], getSnapshot: numbered(), printerVisibleTo: (user, p) => user === admin || p !== BRAVO });
  const a = await d.call({ printer: "1" }, { user: admin });
  assert.equal(a.status, 200);
  assert.equal(text(a), "Bravo #1");
  const v = await d.call({ printer: "1" }, { user: viewer });
  assert.equal(v.status, 400);
  assert.deepEqual(v.json, { error: "Unknown printer" });
  assert.equal(v.body, undefined);
  assert.equal(d.fetches.length, 1);
  assert.equal(d.visibility.length, 2);
});
test("2. no printer at that index — out of range, negative, not a number, missing: 400 Unknown printer, no visibility question, no fetch", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO] });
  for (const query of [{ printer: "2" }, { printer: "9" }, { printer: "-1" }, { printer: "abc" }, { printer: "" }, {}, { fresh: "1" }, { printer: "abc", fresh: "1" }]) {
    const r = await d.call(query);
    assert.equal(r.status, 400, JSON.stringify(query));
    assert.deepEqual(r.json, { error: "Unknown printer" }, JSON.stringify(query));
    assert.deepEqual(r.headers, []);
  }
  assert.deepEqual(d.fetches, []);
  assert.deepEqual(d.visibility, []);
});
test("2. today: the printer argument is read with parseInt(…, 10) — leading digits count, the rest is ignored", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO], getSnapshot: numbered() });
  assert.equal(text(await d.call({ printer: "1abc" })), "Bravo #1");
  assert.equal(text(await d.call({ printer: " 0" })), "Alpha #1");
  assert.equal(text(await d.call({ printer: "0x1", fresh: "1" })), "Alpha #2", "base 10: 0x1 is 0");
  assert.equal(text(await d.call({ printer: "1.9", fresh: "1" })), "Bravo #2");
});
test("2. the fetch is asked for the printer object at that index, and nothing else", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO] });
  await d.call({ printer: "1" });
  await d.call({ printer: "0", fresh: "1" });
  assert.equal(d.fetches.length, 2);
  assert.equal(d.fetches[0].length, 1);
  assert.equal(d.fetches[0][0], BRAVO);
  assert.equal(d.fetches[1].length, 1);
  assert.equal(d.fetches[1][0], ALPHA);
});

// ---------- 3. the cache ----------
test("3. with cameraViewRefreshInterval unset the cache lives 6 s: one fetch serves every request inside it, the next one after it fetches again", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), now: 50000 });
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1");
  d.clock.now = 50001;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1");
  d.clock.now = 55999;
  const last = await d.call({ printer: "0" });
  assert.equal(last.status, 200);
  assert.equal(text(last), "Alpha #1");
  assert.equal(d.fetches.length, 1);
  d.clock.now = 56000;                                       // exactly 6 s: no longer fresh enough
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2");
  assert.equal(d.fetches.length, 2);
  d.clock.now = 61999;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2");
  assert.equal(d.fetches.length, 2);
});
test("3. the cache lives cameraViewRefreshInterval seconds; 0 means the default 6", async () => {
  const two = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), config: { cameraViewRefreshInterval: 2 }, now: 0 });
  await two.call({ printer: "0" });
  two.clock.now = 1999;
  assert.equal(text(await two.call({ printer: "0" })), "Alpha #1");
  two.clock.now = 2000;
  assert.equal(text(await two.call({ printer: "0" })), "Alpha #2");
  const thirty = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), config: { cameraViewRefreshInterval: 30 }, now: 0 });
  await thirty.call({ printer: "0" });
  thirty.clock.now = 29999;
  assert.equal(text(await thirty.call({ printer: "0" })), "Alpha #1");
  thirty.clock.now = 30000;
  assert.equal(text(await thirty.call({ printer: "0" })), "Alpha #2");
  const zero = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), config: { cameraViewRefreshInterval: 0 }, now: 0 });
  await zero.call({ printer: "0" });
  zero.clock.now = 5999;
  assert.equal(text(await zero.call({ printer: "0" })), "Alpha #1");
  zero.clock.now = 6000;
  assert.equal(text(await zero.call({ printer: "0" })), "Alpha #2");
});
test("3. the cache's age counts from when the frame arrived, not from when it was asked for", async () => {
  const m = manual();
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: m.getSnapshot, now: 0 });
  const first = d.call({ printer: "0" });
  await flush();
  d.clock.now = 4000;                                        // the camera took 4 s
  m.calls[0].resolve(frame("slow"));
  assert.equal(text(await first), "slow");
  d.clock.now = 9999;                                        // 5.999 s after it arrived
  assert.equal(text(await d.call({ printer: "0" })), "slow");
  assert.equal(m.calls.length, 1);
  d.clock.now = 10000;
  const again = d.call({ printer: "0" });
  await flush();
  assert.equal(m.calls.length, 2);
  m.calls[1].resolve(frame("new"));
  assert.equal(text(await again), "new");
});
test("3. requests arriving while a fetch is in flight share that ONE fetch and all get its frame", async () => {
  const m = manual();
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: m.getSnapshot });
  const pending = [d.call({ printer: "0" }), d.call({ printer: "0" }), d.call({ printer: "0" })];
  await flush();
  pending.push(d.call({ printer: "0" }));                    // a later arrival, still in flight
  await flush();
  assert.equal(m.calls.length, 1);
  const shot = frame("shared");
  m.calls[0].resolve(shot);
  const answers = await Promise.all(pending);
  for (const r of answers) {
    assert.equal(r.status, 200);
    assert.equal(r.body, shot.buffer, "the same Buffer");
    assert.deepEqual(r.headers, [["Content-Type", "image/jpeg"], ["Cache-Control", "no-store"]]);
  }
  assert.equal(text(await d.call({ printer: "0" })), "shared", "and it is cached afterwards");
  assert.equal(m.calls.length, 1);
});
test("3. the cache and the shared fetch are per printer index", async () => {
  const m = manual();
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO], getSnapshot: m.getSnapshot });
  const a = d.call({ printer: "0" }), b = d.call({ printer: "1" }), a2 = d.call({ printer: "0" });
  await flush();
  assert.equal(m.calls.length, 2, "one fetch per printer, not one for all");
  assert.equal(m.calls[0].p, ALPHA);
  assert.equal(m.calls[1].p, BRAVO);
  m.calls[1].resolve(frame("bravo frame"));
  assert.equal(text(await b), "bravo frame");
  m.calls[0].resolve(frame("alpha frame"));
  assert.equal(text(await a), "alpha frame");
  assert.equal(text(await a2), "alpha frame");
  assert.equal(text(await d.call({ printer: "1" })), "bravo frame");
  assert.equal(text(await d.call({ printer: "0" })), "alpha frame");
  assert.equal(m.calls.length, 2);
});
test("3. loading the code again starts with an empty cache (a restart)", async () => {
  const one = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered() });
  await one.call({ printer: "0" });
  await one.call({ printer: "0" });
  assert.equal(one.fetches.length, 1);
  const two = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered() });
  assert.equal(text(await two.call({ printer: "0" })), "Alpha #1");
  assert.equal(two.fetches.length, 1, "the second load did not see the first one's cache");
});

// ---------- 4. fresh ----------
test("4. fresh=1 always fetches, even with a frame cached a moment ago", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered() });
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1");
  const r = await d.call({ printer: "0", fresh: "1" });
  assert.equal(r.status, 200);
  assert.equal(text(r), "Alpha #2");
  assert.deepEqual(r.headers, [["Content-Type", "image/jpeg"], ["Cache-Control", "no-store"]]);
  assert.equal(text(await d.call({ printer: "0", fresh: "1" })), "Alpha #3");
  assert.equal(d.fetches.length, 3);
});
test("4. fresh re-primes the cache: the next plain request inside the TTL gets the fresh frame without another fetch, and the TTL restarts", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), now: 0 });
  await d.call({ printer: "0" });                            // cached at 0
  d.clock.now = 5000;
  assert.equal(text(await d.call({ printer: "0", fresh: "1" })), "Alpha #2");
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2");
  d.clock.now = 10999;                                       // 10.999 s after the first frame, 5.999 s after the fresh one
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2");
  assert.equal(d.fetches.length, 2);
  d.clock.now = 11000;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #3");
  assert.equal(d.fetches.length, 3);
});
test("4. fresh primes an empty cache too", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered() });
  assert.equal(text(await d.call({ printer: "0", fresh: "1" })), "Alpha #1");
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1");
  assert.equal(d.fetches.length, 1);
});
test("4. any non-empty fresh value bypasses the cache (\"0\" and \"false\" included); an empty one does not", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered() });
  await d.call({ printer: "0" });
  assert.equal(text(await d.call({ printer: "0", fresh: "0" })), "Alpha #2");
  assert.equal(text(await d.call({ printer: "0", fresh: "false" })), "Alpha #3");
  assert.equal(text(await d.call({ printer: "0", fresh: "yes" })), "Alpha #4");
  assert.equal(text(await d.call({ printer: "0", fresh: "" })), "Alpha #4");
  assert.equal(d.fetches.length, 4);
});
test("4. today: a fresh request never joins a fetch in flight, and a plain request never joins a fresh one — each makes its own", async () => {
  const m = manual();
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: m.getSnapshot });
  const plain = d.call({ printer: "0" });
  await flush();
  const fresh = d.call({ printer: "0", fresh: "1" });
  await flush();
  assert.equal(m.calls.length, 2, "fresh did not wait for the plain fetch");
  const fresh2 = d.call({ printer: "0", fresh: "1" });
  await flush();
  assert.equal(m.calls.length, 3, "nor for another fresh one");
  m.calls[0].resolve(frame("plain")); m.calls[1].resolve(frame("fresh")); m.calls[2].resolve(frame("fresh2"));
  assert.equal(text(await plain), "plain");
  assert.equal(text(await fresh), "fresh");
  assert.equal(text(await fresh2), "fresh2");

  const m2 = manual();
  const d2 = loadSnapshotCode({ printers: [ALPHA], getSnapshot: m2.getSnapshot });
  const f = d2.call({ printer: "0", fresh: "1" });
  await flush();
  const p = d2.call({ printer: "0" });
  await flush();
  assert.equal(m2.calls.length, 2, "a plain request does not share a fresh fetch");
  m2.calls[0].resolve(frame("fresh")); m2.calls[1].resolve(frame("plain"));
  assert.equal(text(await f), "fresh");
  assert.equal(text(await p), "plain");
});
test("4. today: the cache holds whichever fetch FINISHED last — a slow plain fetch that ends after a fresh one replaces the fresh frame", async () => {
  const m = manual();
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: m.getSnapshot, now: 0 });
  const plain = d.call({ printer: "0" });
  await flush();
  const fresh = d.call({ printer: "0", fresh: "1" });
  await flush();
  m.calls[1].resolve(frame("fresh, taken later"));
  assert.equal(text(await fresh), "fresh, taken later");
  d.clock.now = 3000;
  m.calls[0].resolve(frame("plain, taken earlier"));
  assert.equal(text(await plain), "plain, taken earlier");
  assert.equal(text(await d.call({ printer: "0" })), "plain, taken earlier");
  d.clock.now = 8999;                                        // its age counts from 3000
  assert.equal(text(await d.call({ printer: "0" })), "plain, taken earlier");
  assert.equal(m.calls.length, 2);
});

// ---------- 5. the answer ----------
test("5. the answer: Content-Type exactly the frame's, Cache-Control no-store, the body is the frame's Buffer — fetched, cached and fresh alike", async () => {
  const png = { contentType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: async () => png });
  for (const query of [{ printer: "0" }, { printer: "0" }, { printer: "0", fresh: "1" }]) {
    const r = await d.call(query);
    assert.equal(r.status, 200);
    assert.deepEqual(r.headers, [["Content-Type", "image/png"], ["Cache-Control", "no-store"]]);
    assert.equal(r.body, png.buffer, "the same Buffer, not a copy");
    assert.equal(r.json, undefined);
    assert.equal(r.answers, 1);
  }
  assert.equal(d.fetches.length, 2);
});
test("5. the type is passed on as getSnapshot gave it — the route does not change or default it", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: async () => ({ contentType: "image/x-custom+thing", buffer: Buffer.from("x") }) });
  const r = await d.call({ printer: "0" });
  assert.deepEqual(r.headers, [["Content-Type", "image/x-custom+thing"], ["Cache-Control", "no-store"]]);
  assert.deepEqual((await d.call({ printer: "0" })).headers, [["Content-Type", "image/x-custom+thing"], ["Cache-Control", "no-store"]], "from the cache too");
});

// ---------- 6. failures ----------
test("6. getSnapshot failing: 502 No camera frame: <message>, no headers, no body — plain and fresh", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: async p => { throw new Error(p.name + " has no camera"); } });
  for (const query of [{ printer: "0" }, { printer: "0", fresh: "1" }]) {
    const r = await d.call(query);
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: "No camera frame: Alpha has no camera" });
    assert.deepEqual(r.headers, []);
    assert.equal(r.body, undefined);
    assert.equal(r.answers, 1);
  }
});
test("6. a failure is not cached and leaves nothing in flight: the next request fetches again", async () => {
  let n = 0;
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: async () => { n++; if (n === 1) throw new Error("camera busy"); return frame("frame " + n); } });
  const bad = await d.call({ printer: "0" });
  assert.equal(bad.status, 502);
  assert.deepEqual(bad.json, { error: "No camera frame: camera busy" });
  const good = await d.call({ printer: "0" });                // same instant: no TTL has passed
  assert.equal(good.status, 200);
  assert.equal(text(good), "frame 2");
  assert.equal(d.fetches.length, 2);
  assert.equal(text(await d.call({ printer: "0" })), "frame 2");
  assert.equal(d.fetches.length, 2, "the good frame is cached");
});
test("6. every request waiting on a fetch that fails gets the 502, from ONE fetch; the request after that fetches again", async () => {
  const m = manual();
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: m.getSnapshot });
  const pending = [d.call({ printer: "0" }), d.call({ printer: "0" }), d.call({ printer: "0" })];
  await flush();
  assert.equal(m.calls.length, 1);
  m.calls[0].reject(new Error("timed out"));
  for (const r of await Promise.all(pending)) {
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: "No camera frame: timed out" });
    assert.equal(r.answers, 1);
  }
  const next = d.call({ printer: "0" });
  await flush();
  assert.equal(m.calls.length, 2, "nothing was left in flight");
  m.calls[1].resolve(frame("recovered"));
  assert.equal(text(await next), "recovered");
});
test("6. a failed fresh fetch does not replace or remove the cached frame", async () => {
  let fail = false, n = 0;
  const d = loadSnapshotCode({ printers: [ALPHA], now: 0, getSnapshot: async () => { if (fail) throw new Error("offline"); n++; return frame("frame " + n); } });
  await d.call({ printer: "0" });                            // "frame 1" cached at 0
  fail = true;
  d.clock.now = 3000;
  const bad = await d.call({ printer: "0", fresh: "1" });
  assert.equal(bad.status, 502);
  assert.deepEqual(bad.json, { error: "No camera frame: offline" });
  const cached = await d.call({ printer: "0" });
  assert.equal(cached.status, 200);
  assert.equal(text(cached), "frame 1");
  d.clock.now = 5999;                                        // still counted from 0: the failure did not restart the TTL
  assert.equal(text(await d.call({ printer: "0" })), "frame 1");
  d.clock.now = 6000;
  assert.equal((await d.call({ printer: "0" })).status, 502);
  assert.equal(d.fetches.length, 3);
});
test("6. a failed plain fetch after the TTL does not serve the expired frame", async () => {
  let fail = false;
  const d = loadSnapshotCode({ printers: [ALPHA], now: 0, getSnapshot: async () => { if (fail) throw new Error("offline"); return frame("old"); } });
  await d.call({ printer: "0" });
  fail = true;
  d.clock.now = 6000;
  const r = await d.call({ printer: "0" });
  assert.equal(r.status, 502);
  assert.deepEqual(r.json, { error: "No camera frame: offline" });
  assert.equal(r.body, undefined);
});
test("6. a failure for one printer leaves another printer's cache and fetches alone", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO], getSnapshot: async p => { if (p === BRAVO) throw new Error("Bravo has no camera"); return frame("alpha"); } });
  assert.equal(text(await d.call({ printer: "0" })), "alpha");
  assert.equal((await d.call({ printer: "1" })).status, 502);
  assert.equal(text(await d.call({ printer: "0" })), "alpha");
  assert.equal(d.fetches.length, 2);
});

// ---------- 7. a configuration reload ----------
test("7. the TTL is read from the CURRENT configuration on every request: a reload that replaces the configuration object takes effect at once", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), config: { cameraViewRefreshInterval: 30 }, now: 0 });
  await d.call({ printer: "0" });
  d.clock.now = 10000;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1", "10 s old, 30 s allowed");
  d.setConfig({ cameraViewRefreshInterval: 5 });             // reload: a NEW object
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2", "10 s old, 5 s allowed");
  d.clock.now = 14999;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2");
  d.setConfig({});                                           // the setting removed: back to 6 s
  d.clock.now = 15000;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2", "5 s old, 6 s allowed");
  d.clock.now = 16000;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #3");
  assert.equal(d.fetches.length, 3);
});
test("7. a setting changed in place on the same configuration object takes effect at once too", async () => {
  const config = { cameraViewRefreshInterval: 30 };
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), config, now: 0 });
  await d.call({ printer: "0" });
  d.clock.now = 10000;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1");
  config.cameraViewRefreshInterval = 5;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #2");
  assert.equal(d.fetches.length, 2);
});
test("7. the printer list is read on every request: after a reload REPLACES the array, the new list is the one used", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered() });
  assert.equal((await d.call({ printer: "1" })).status, 400, "no second printer yet");
  const CHARLIE = { id: "p_charlie", name: "Charlie", connector: "x" };
  d.setPrinters([ALPHA, CHARLIE]);                           // reload: a NEW array
  const r = await d.call({ printer: "1" });
  assert.equal(r.status, 200);
  assert.equal(text(r), "Charlie #1");
  assert.equal(d.fetches[0][0], CHARLIE);
  assert.equal(d.visibility[0][1], CHARLIE);
  d.setPrinters([]);                                         // every printer removed
  assert.equal((await d.call({ printer: "0" })).status, 400);
  assert.equal((await d.call({ printer: "1", fresh: "1" })).status, 400);
  assert.equal(d.fetches.length, 1);
});
test("7. the cache survives a reload", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: numbered(), config: { cameraViewRefreshInterval: 6 }, now: 0 });
  await d.call({ printer: "0" });
  d.setConfig({ cameraViewRefreshInterval: 6 });
  d.setPrinters([{ ...ALPHA }]);                             // the same printer, rebuilt by the reload
  d.clock.now = 5999;
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1");
  assert.equal(d.fetches.length, 1);
});
test("7. today: the cache is keyed by INDEX, not by printer — after a reload puts another printer at that index, its requests get the previous printer's frame until the TTL passes", async () => {
  const d = loadSnapshotCode({ printers: [ALPHA, BRAVO], getSnapshot: numbered(), now: 0 });
  assert.equal(text(await d.call({ printer: "0" })), "Alpha #1");
  d.setPrinters([BRAVO, ALPHA]);                             // reordered
  d.clock.now = 5999;
  const r = await d.call({ printer: "0" });
  assert.equal(d.visibility[1][1], BRAVO, "visibility is asked about the printer now at that index");
  assert.equal(text(r), "Alpha #1", "but the frame is the one cached under index 0");
  assert.equal(d.fetches.length, 1);
  d.clock.now = 6000;
  assert.equal(text(await d.call({ printer: "0" })), "Bravo #1");
  assert.equal(text(await d.call({ printer: "0", fresh: "1" })), "Bravo #2");
  assert.equal(text(await d.call({ printer: "1", fresh: "1" })), "Alpha #2");
});
test("7. a fetch in flight survives a reload: a request after the reload joins it and gets its frame", async () => {
  const m = manual();
  const d = loadSnapshotCode({ printers: [ALPHA], getSnapshot: m.getSnapshot });
  const before = d.call({ printer: "0" });
  await flush();
  const rebuilt = { ...ALPHA };
  d.setPrinters([rebuilt]);
  d.setConfig({ cameraViewRefreshInterval: 2 });
  const after = d.call({ printer: "0" });
  await flush();
  assert.equal(m.calls.length, 1, "no second fetch for the rebuilt printer object");
  assert.equal(m.calls[0].p, ALPHA);
  m.calls[0].resolve(frame("in flight across the reload"));
  assert.equal(text(await before), "in flight across the reload");
  assert.equal(text(await after), "in flight across the reload");
});

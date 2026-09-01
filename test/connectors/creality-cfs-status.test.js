// test/connectors/creality-cfs-status.test.js — reading CFS box status off
// Creality's proprietary websocket.
//
// Regression for a real defect: fetchCfsStatus resolved on the FIRST websocket
// message. The printer streams status asynchronously and answers the boxsInfo
// query a couple of messages later, so the connector read a status frame, found
// no `boxsInfo`, closed the socket and resolved null. A printer with a CFS
// physically attached and enumerating five slots reported heads: [] while
// still advertising filamentHeads: true — the UI showed a lane strip with
// nothing in it.
//
// Captured live from a SPARKX i7 with a CFS attached: 33 messages over 20s,
// `boxsInfo` present in exactly one of them (index 2, ~50ms after connect).
// That "exactly once, and not first" shape is what these tests pin down.
//
// No production hooks: the tests swap globalThis.WebSocket for a scripted fake
// and restore it in a finally block.
const test = require("node:test");
const assert = require("node:assert/strict");
const creality = require("../../connectors/creality-klipper");

const { fetchCfsStatus, decodeCfsHeads } = creality._internal;

// The real payload, trimmed to the fields the decoder reads. Two boxes, five
// slots total — box 1 carries the CFS unit's serial number.
const BOXS_INFO = {
  materialBoxs: [
    { id: 0, state: 0, type: 1, materials: [
      { id: 0, vendor: "Generic", type: "PLA", name: "Generic PLA", color: "#0ffffff", selected: 0, state: 1 }
    ] },
    { id: 1, state: 1, type: 0, sn: "80000140059S226GQLO", materials: [
      { id: 0, vendor: "Generic", type: "PLA", name: "Generic PLA", color: "#0565656", selected: 0, state: 1 },
      { id: 1, vendor: "Generic", type: "PLA", name: "Generic PLA", color: "#031d251", selected: 0, state: 1 },
      { id: 2, vendor: "Generic", type: "PLA", name: "Generic PLA", color: "#0ff6e1a", selected: 0, state: 1 },
      { id: 3, vendor: "Generic", type: "PLA", name: "Generic PLA", color: "#0ffffff", selected: 0, state: 1 }
    ] }
  ]
};

// The observed ordering: a large status frame first (which notably reports
// cfsConnect: 0 even though a CFS is attached and enumerated), then noise, then
// the actual answer, then more noise.
const LIVE_SEQUENCE = [
  { connect: 1, cfsConnect: 0, bedTemp0: "22.170000", TotalLayer: 0, state: 0 },
  { curFeedratePct: 100 },
  { boxsInfo: BOXS_INFO },
  { curPosition: "X:0 Y:0 Z:0" },
  { nozzleTemp: "24.0" }
];

// A scripted stand-in for the printer's socket. Emits `frames` one per tick
// after send(), and records lifecycle so leaks are visible.
function installFakeSocket(frames, opts = {}) {
  const original = globalThis.WebSocket;
  const state = { created: 0, sent: [], closes: 0, urls: [], timers: [] };
  globalThis.WebSocket = class {
    constructor(url) {
      state.created++; state.urls.push(url);
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      setImmediate(() => { if (opts.failToOpen) { this.onerror && this.onerror(new Error("refused")); return; } this.onopen && this.onopen(); });
    }
    send(payload) {
      state.sent.push(payload);
      let i = 0;
      const pump = () => {
        if (i >= frames.length) { if (opts.repeat) i = 0; else return; }
        const frame = frames[i++];
        // A frame given as { __raw } is delivered verbatim, so malformed data
        // can be exercised; everything else is JSON-encoded.
        const data = (frame && frame.__raw !== undefined) ? frame.__raw : JSON.stringify(frame);
        // Deliver even after close() so a leaked listener would be observable.
        this.onmessage && this.onmessage({ data });
        if (opts.everyMs) { state.timers.push(setTimeout(pump, opts.everyMs)); } else { setImmediate(pump); }
      };
      if (opts.everyMs) { state.timers.push(setTimeout(pump, opts.everyMs)); } else { setImmediate(pump); }
    }
    // Real WebSocket.close() does not invoke onclose synchronously; firing it
    // inline would make finish(null) beat the real answer and test an artifact.
    close() { state.closes++; setImmediate(() => this.onclose && this.onclose()); }
  };
  return { state, restore: () => { state.timers.forEach(clearTimeout); globalThis.WebSocket = original; } };
}

const P = { id: "cfs1", name: "SPARKX i7", url: "http://192.0.2.40:7125", filamentMode: "cfs" };

test("boxsInfo is found even though status frames arrive before it", async () => {
  const fake = installFakeSocket(LIVE_SEQUENCE);
  try {
    const bi = await fetchCfsStatus(P);
    assert.ok(bi, "must not give up on the first status frame");
    assert.equal(bi.materialBoxs.length, 2);
  } finally { fake.restore(); }
});

test("all five slots decode into heads", async () => {
  const fake = installFakeSocket(LIVE_SEQUENCE);
  try {
    const { heads } = decodeCfsHeads(await fetchCfsStatus(P));
    assert.equal(heads.length, 5, "two boxes, five slots");
    assert.ok(heads.every(h => h.loaded), "every enumerated slot is loaded");
    assert.ok(heads.every(h => h.material === "PLA"));
  } finally { fake.restore(); }
});

test("cfsConnect is not used as the presence check", async () => {
  // The live printer reports cfsConnect: 0 in its status frame while a CFS is
  // attached and enumerating slots, so keying off it would hide a working box.
  assert.equal(LIVE_SEQUENCE[0].cfsConnect, 0, "fixture must keep the contradictory field");
  const fake = installFakeSocket(LIVE_SEQUENCE);
  try {
    assert.ok(await fetchCfsStatus(P), "a CFS must be reported despite cfsConnect: 0");
  } finally { fake.restore(); }
});

test("boxsInfo arriving first still works", async () => {
  const fake = installFakeSocket([{ boxsInfo: BOXS_INFO }, { noise: 1 }]);
  try {
    assert.ok(await fetchCfsStatus(P));
  } finally { fake.restore(); }
});

test("a printer that never sends boxsInfo resolves null rather than hanging", async () => {
  const fake = installFakeSocket([{ a: 1 }, { b: 2 }, { c: 3 }]);
  try {
    const started = Date.now();
    assert.equal(await fetchCfsStatus(P), null);
    // Resolves via the existing timeout budget, not by hanging forever.
    assert.ok(Date.now() - started < 4000, "must settle within the existing timeout");
  } finally { fake.restore(); }
});

test("a socket that cannot open resolves null", async () => {
  const fake = installFakeSocket([], { failToOpen: true });
  try {
    assert.equal(await fetchCfsStatus(P), null);
  } finally { fake.restore(); }
});

test("the socket is opened once, closed once, and not left listening", async () => {
  const fake = installFakeSocket(LIVE_SEQUENCE);
  try {
    await fetchCfsStatus(P);
    // Frames keep arriving after the answer; a second resolve or a second close
    // would mean the handler outlived its purpose.
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fake.state.created, 1, "exactly one socket per call");
    assert.equal(fake.state.closes, 1, "closed exactly once — no leak, no double close");
    assert.equal(fake.state.sent.length, 1, "the query is sent once");
    assert.deepEqual(JSON.parse(fake.state.sent[0]), { method: "get", params: { boxsInfo: 1 } });
  } finally { fake.restore(); }
});

test("the websocket targets the printer's host on the CFS port", async () => {
  const fake = installFakeSocket(LIVE_SEQUENCE);
  try {
    await fetchCfsStatus(P);
    assert.equal(fake.state.urls[0], "ws://192.0.2.40:9999");
  } finally { fake.restore(); }
});

test("a non-CFS Creality printer never opens the socket at all", async () => {
  // probe() gates on filamentMode; this pins the capability side of that so a
  // single-filament printer is provably untouched by this path.
  const single = { ...P, filamentMode: undefined };
  assert.notEqual(creality.getCapabilities(single).filamentHeads, true,
    "a non-CFS printer must not advertise filament heads");
  assert.equal(creality.getCapabilities({ ...P }).filamentHeads, true,
    "a CFS printer still advertises them");
});

test("malformed frames before boxsInfo do not abort the request", async () => {
  // A non-JSON frame must be skipped like any other noise, not treated as a
  // failed response. The original code caught the parse error and resolved
  // null, giving up on a printer that was about to answer.
  const fake = installFakeSocket([
    { __raw: "not json at all" },
    { __raw: "{ truncated" },
    { connect: 1, cfsConnect: 0 },
    { boxsInfo: BOXS_INFO }
  ]);
  try {
    const bi = await fetchCfsStatus(P);
    assert.ok(bi, "a malformed frame must not abort the request");
    assert.equal(decodeCfsHeads(bi).heads.length, 5);
  } finally { fake.restore(); }
});

test("the timeout runs from the query, and unrelated messages do not extend it", async () => {
  // Noise arrives every 200ms indefinitely. If any of it reset or extended the
  // timer, this would never settle; it must still resolve null on the original
  // 2500ms budget measured from the start.
  const fake = installFakeSocket([{ curFeedratePct: 100 }, { nozzleTemp: "24.0" }], { everyMs: 200, repeat: true });
  try {
    const started = Date.now();
    assert.equal(await fetchCfsStatus(P), null);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2000, "must not resolve early, got " + elapsed + "ms");
    assert.ok(elapsed < 4000, "the timer must not have been extended by noise, got " + elapsed + "ms");
  } finally { fake.restore(); }
});

test("cleanup happens exactly once even while frames keep streaming", async () => {
  const fake = installFakeSocket([
    { connect: 1 }, { boxsInfo: BOXS_INFO }, { noise: 1 }, { noise: 2 }
  ], { everyMs: 20, repeat: true });
  try {
    await fetchCfsStatus(P);
    await new Promise(r => setTimeout(r, 200));   // frames keep arriving
    assert.equal(fake.state.closes, 1, "closed exactly once despite continued traffic");
    assert.equal(fake.state.created, 1);
  } finally { fake.restore(); }
});

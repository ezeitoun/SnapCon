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
    { id: 1, state: 1, type: 0, temp: 0, humidity: 0, sn: "80000140059S226GQLO", materials: [
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

test("the CFS's four slots decode into heads, without the placeholder box", async () => {
  const fake = installFakeSocket(LIVE_SEQUENCE);
  try {
    const { heads } = decodeCfsHeads(await fetchCfsStatus(P));
    assert.equal(heads.length, 4, "the four-slot CFS, not the placeholder as well");
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
    assert.equal(decodeCfsHeads(bi).heads.length, 4);
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

// ---------------------------------------------------------------------------
// Colour decoding.
//
// Creality reports SEVEN hex digits. The decoder originally kept the first six,
// which is wrong: the leading digit is a prefix and the colour is the last six.
// Established by reading four slots off a live CFS and comparing against the
// colours shown on the printer, all four agreeing:
//
//   raw #01743ed -> #1743ED  rgb(23,67,237)     operator: blue
//   raw #031d251 -> #31D251  rgb(49,210,81)     operator: green
//   raw #0ff6e1a -> #FF6E1A  rgb(255,110,26)    operator: orange
//   raw #0ffffff -> #FFFFFF  rgb(255,255,255)   operator: white
//
// The old first-six reading gave #01743E, #031D25, #0FF6E1, #0FFFFF — dark
// teal, near-black, mint and cyan. Wrong on every one.
// ---------------------------------------------------------------------------

const slot = color => ({ id: 0, vendor: "Generic", type: "PLA", name: "Generic PLA", color, selected: 0, state: 1 });
const decodeColors = colors =>
  decodeCfsHeads({ materialBoxs: [{ id: 1, state: 1, type: 0, sn: "SN-TEST", materials: colors.map(slot) }] }).heads.map(h => h.hex);

test("a seven-digit colour decodes to its last six digits, matching the printer", () => {
  assert.deepEqual(
    decodeColors(["#01743ed", "#031d251", "#0ff6e1a", "#0ffffff"]),
    ["#1743ED", "#31D251", "#FF6E1A", "#FFFFFF"]
  );
});

test("the old first-six reading is not what we produce", () => {
  // Guards against a regression back to the original behaviour.
  const [blue] = decodeColors(["#01743ed"]);
  assert.notEqual(blue, "#01743E", "must not keep the leading prefix digit");
  assert.equal(blue, "#1743ED");
});

test("a plain six-digit colour is unchanged", () => {
  assert.deepEqual(decodeColors(["#FF0000", "00FF00"]), ["#FF0000", "#00FF00"]);
});

test("a colour too short to be RGB yields null rather than a guess", () => {
  assert.deepEqual(decodeColors(["#abc", "", "xyz"]), [null, null, null]);
});

test("an empty slot still reports no colour", () => {
  const heads = decodeCfsHeads({ materialBoxs: [{ id: 1, state: 1, type: 0, sn: "SN-TEST", materials: [{ id: 0 }] }] }).heads;
  assert.equal(heads.length, 1);
  assert.equal(heads[0].loaded, false);
  assert.equal(heads[0].hex, null);
});

// ---------------------------------------------------------------------------
// Which boxes are real CFS units.
//
// The printer reports a non-hardware placeholder alongside the actual CFS —
// the direct/single-colour feed path. Flattening every entry produced five
// lanes for a four-slot CFS AND shifted every slot by one, so `activeExt`
// pointed at the wrong lane.
//
// Three independent observations identify it, all from a live SPARKX i7:
//   1. structure — the placeholder is {id, state, type} only: no serial, no
//      temp, no humidity. The real unit reports all three.
//   2. the printer's own summary — same_material listed four entries, every
//      one boxId:1, omitting the placeholder entirely.
//   3. behaviour — changing physical CFS spool #1 moved T2 on the fleet card,
//      proving T1 was not a CFS slot.
//
// A physical unit has a serial number; the virtual path has no hardware
// identity at all. That is the discriminator used here. `state` was rejected
// (it plausibly means "in use", so an idle-but-attached CFS could vanish) and
// so was `type` (semantics unknown, only two values ever observed).
// ---------------------------------------------------------------------------

const PLACEHOLDER_BOX = { id: 0, state: 0, type: 1, materials: [slot("#0ffffff")] };
const REAL_CFS_BOX = {
  id: 1, state: 1, type: 0, temp: 0, humidity: 0, sn: "80000140059S226GQLO",
  materials: ["#01743ed", "#031d251", "#0ff6e1a", "#0ffffff"].map(slot)
};

test("the non-hardware placeholder box is not rendered as a CFS lane", () => {
  const { heads } = decodeCfsHeads({ materialBoxs: [PLACEHOLDER_BOX, REAL_CFS_BOX] });
  assert.equal(heads.length, 4, "a four-slot CFS must produce four lanes, not five");
});

test("CFS slots keep their real order — no off-by-one from the placeholder", () => {
  // Changing physical spool #1 moved T2 before this fix; slot 1 must now be T1.
  const { heads } = decodeCfsHeads({ materialBoxs: [PLACEHOLDER_BOX, REAL_CFS_BOX] });
  assert.deepEqual(heads.map(h => h.hex), ["#1743ED", "#31D251", "#FF6E1A", "#FFFFFF"]);
});

test("activeExt indexes the CFS slot, not a placeholder-shifted position", () => {
  const box = { ...REAL_CFS_BOX, materials: REAL_CFS_BOX.materials.map((m, i) => ({ ...m, selected: i === 0 ? 1 : 0 })) };
  const { activeExt } = decodeCfsHeads({ materialBoxs: [PLACEHOLDER_BOX, box] });
  assert.equal(activeExt, 0, "the first CFS slot is index 0, not 1");
});

test("multiple chained CFS units are all kept", () => {
  // Creality supports chaining units; each real one reports its own serial.
  const second = { ...REAL_CFS_BOX, id: 2, sn: "80000140059S226GQLP" };
  const { heads } = decodeCfsHeads({ materialBoxs: [PLACEHOLDER_BOX, REAL_CFS_BOX, second] });
  assert.equal(heads.length, 8, "two four-slot units are eight lanes");
});

test("with nothing to distinguish, every box is kept rather than hidden", () => {
  // The filter is deliberately RELATIVE. When no box carries hardware identity
  // there is nothing to tell apart, so all are kept — the rule can never hide
  // real slots on a printer that reports less than this one does. A lone
  // placeholder (CFS unplugged) therefore still shows its single lane, which is
  // the conservative outcome: surfacing a spool that exists beats hiding slots
  // that do.
  const { heads } = decodeCfsHeads({ materialBoxs: [PLACEHOLDER_BOX] });
  assert.equal(heads.length, 1, "nothing marks this as a placeholder on its own");
});

test("a CFS Nano is recognised as hardware — it reports no real drying data", () => {
  // The Nano has no drying, and reports temp/humidity as 0 rather than omitting
  // them; its serial carries it regardless. Both shapes must register.
  const nanoWithZeros = { id: 1, state: 1, type: 0, temp: 0, humidity: 0, sn: "NANO-1", materials: [slot("#01743ed")] };
  const nanoNoDryingFields = { id: 1, state: 1, type: 0, sn: "NANO-1", materials: [slot("#01743ed")] };
  for (const box of [nanoWithZeros, nanoNoDryingFields]) {
    const { heads } = decodeCfsHeads({ materialBoxs: [PLACEHOLDER_BOX, box] });
    assert.equal(heads.length, 1, "the Nano's slot is kept and the placeholder dropped");
    assert.equal(heads[0].hex, "#1743ED");
  }
});

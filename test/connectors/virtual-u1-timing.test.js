// test/connectors/virtual-u1-timing.test.js — how long the virtual U1's steps
// take, against what U1 Yellow (firmware 2.0) did in recordings made with
// scripts/record-u1.js on 2026-10-11: a 33-tool-change print to the end, and
// a short print paused, resumed and cancelled.
//
// timing "fast" skips every wait; timing "real" keeps them, and a G-code
// request only returns when its step is done. These tests use "real" with
// clock: false and step model time by hand, so they run in well under a second.
const test = require("node:test");
const assert = require("node:assert/strict");
const u1c = require("../../connectors/snapmaker-u1-klipper");
const { startVirtualU1, VirtualU1 } = require("../../fixtures/virtual-u1");

const EXT = ["extruder", "extruder1", "extruder2", "extruder3"];

async function virtualU1(t, opts) {
  const u1 = await startVirtualU1(opts);
  t.after(() => u1.close());
  return { u1, p: { id: "virtual-" + u1.port, name: "Virtual U1", url: u1.url } };
}
const head = (u1, i) => u1.model.status()[EXT[i]];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Starts a two-colour job on heads 3 and 1 and steps it until it is printing.
async function printing(u1, p, { layers = 3, secondsPerLayer = 120 } = {}) {
  u1.model.addFile("Timing.gcode", { tools: [0, 1], layers, secondsPerLayer });
  await u1c.applyHeadMapping(p, [0, 1], { 0: 3, 1: 1 }, {});
  await u1c.startPrintFile(p, "Timing.gcode");
  while (u1.model.job.prepared < u1.model.job.prepare) u1.model.advance(1);
}

// A request that is still waiting on the printer, and whether it has answered.
function inFlight(promise) {
  const r = { done: false, error: null };
  r.promise = promise.then(() => { r.done = true; }, e => { r.done = true; r.error = e; });
  return r;
}
// Waits (in real time) until the server has the request and the model shows it.
async function until(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition never became true");
    await sleep(5);
  }
}

test("timing must be 'fast' or 'real'", () => {
  assert.throws(() => new VirtualU1({ timing: "slow" }), /timing must be "fast" or "real"/);
});

test("before a tool change the next head heats ~30s ahead and the head left drops to standby ~4s ahead", async t => {
  const { u1, p } = await virtualU1(t);
  await printing(u1, p);
  let heated = null, standby = null, switched = null;
  for (let i = 0; i < 200 && switched == null; i++) {
    u1.model.advance(1);
    const now = u1.model.time;
    if (heated == null && head(u1, 1).target === 215) heated = now;
    if (standby == null && head(u1, 3).target === 65) standby = now;
    if (u1.model.status().toolhead.extruder === "extruder1") switched = now;
  }
  assert.ok(switched != null, "the change from head 3 to head 1 happened");
  assert.ok(Math.abs(switched - heated - 30) <= 1, `heated ${switched - heated}s before`);
  assert.ok(Math.abs(switched - standby - 4) <= 1, `standby ${switched - standby}s before`);
});

test("standby and preheat follow the file's ooze prevention settings, not fixed values", async t => {
  const { u1, p } = await virtualU1(t);
  u1.model.addFile("Hotter standby.gcode", { tools: [0, 1], layers: 3, secondsPerLayer: 300, standbyDelta: -100, preheatTime: 60 });
  const text = u1.model.files.gcodes.get("Hotter standby.gcode").content.toString();
  assert.match(text, /; standby_temperature_delta = -100\n/, "the file says what it does");
  assert.match(text, /; preheat_time = 60\n/);
  await u1c.applyHeadMapping(p, [0, 1], { 0: 3, 1: 1 }, {});
  await u1c.startPrintFile(p, "Hotter standby.gcode");
  while (u1.model.job.prepared < u1.model.job.prepare) u1.model.advance(1);
  let heated = null, switched = null;
  for (let i = 0; i < 400 && switched == null; i++) {
    u1.model.advance(1);
    if (heated == null && head(u1, 1).target === 215) heated = u1.model.time;
    if (u1.model.status().toolhead.extruder === "extruder1") switched = u1.model.time;
  }
  assert.ok(switched != null, "the change from head 3 to head 1 happened");
  assert.ok(Math.abs(switched - heated - 60) <= 1, `heated ${switched - heated}s before`);
  assert.equal(head(u1, 3).target, 115, "215 - 100");
});

test("a used head stays at standby after its last use, until the job ends", async t => {
  const { u1, p } = await virtualU1(t);
  await printing(u1, p, { layers: 2 });
  // Layer 2: head 3 prints its last segment, then head 1 finishes the job.
  let sawLastSegment = false;
  for (let i = 0; i < 600 && u1.model.status().print_stats.state === "printing"; i++) {
    u1.model.advance(1);
    const st = u1.model.status();
    if (st.print_stats.state === "printing" && st.print_stats.info.current_layer === 2 && st.toolhead.extruder === "extruder1") {
      sawLastSegment = true;
      assert.equal(head(u1, 3).target, 65, "head 3 is not used again, and still waits at 65");
      assert.equal(head(u1, 0).target, 0, "a head the job never uses stays off");
    }
  }
  assert.ok(sawLastSegment);
  assert.equal(u1.model.status().print_stats.state, "complete");
  assert.ok([0, 1, 2, 3].every(h => head(u1, h).target === 0), "all off at the end");
});

test("fast timing: pause, resume and cancel finish within the request", async t => {
  const { u1, p } = await virtualU1(t);
  await printing(u1, p);
  await u1c.pause(p);
  assert.equal(head(u1, 3).target, 40);
  await u1c.resume(p);
  assert.equal(u1.model.status().print_stats.state, "printing");
  assert.ok(head(u1, 3).temperature >= 210, "the reheat was skipped, not waited for");
  await u1c.cancel(p);
  assert.equal(head(u1, 3).target, 0);
  assert.equal(u1.model.status().toolhead.homed_axes, "");
});

test("real timing: pause is immediate, the heads drop to 40°C ~3s later", async t => {
  const { u1, p } = await virtualU1(t, { timing: "real", clock: false });
  await printing(u1, p);
  const req = inFlight(u1c.pause(p));
  await until(() => u1.model.stats.state === "paused");
  assert.equal(head(u1, 3).target, 215, "not yet");
  u1.model.advance(3);
  await req.promise;
  assert.equal(req.error, null);
  assert.equal(head(u1, 3).target, 40);
  assert.equal(head(u1, 3).state, "ACTIVATE", "the head stays picked while paused");
});

test("real timing: RESUME waits for the reheat — 'paused' with action code 130 until then, and the request with it", async t => {
  const { u1, p } = await virtualU1(t, { timing: "real", clock: false });
  await printing(u1, p);
  u1.model.runScript("PAUSE");
  u1.model.advance(60); // cools towards 40
  const req = inFlight(u1c.resume(p));
  await until(() => u1.model.machine.action === 130);
  u1.model.advance(10);
  await sleep(20);
  assert.equal(req.done, false, "the request is still waiting");
  assert.equal(u1.model.status().print_stats.state, "paused");
  assert.equal(u1.model.status().machine_state_manager.action_code, 130);
  assert.equal((await u1c.probe(p)).state, "paused", "SnapCon still reads paused while it reheats");
  u1.model.advance(60);
  await req.promise;
  assert.equal(req.error, null);
  assert.equal(u1.model.status().print_stats.state, "printing");
  assert.equal(u1.model.status().machine_state_manager.action_code, 0);
});

test("real timing: CANCEL is 'cancelled' at once, heaters and homing are cleared ~9s later, then it returns", async t => {
  const { u1, p } = await virtualU1(t, { timing: "real", clock: false });
  await printing(u1, p);
  const req = inFlight(u1c.cancel(p));
  await until(() => u1.model.stats.state === "cancelled");
  const st = u1.model.status();
  assert.equal(st.virtual_sdcard.file_path, null);
  assert.equal(st.machine_state_manager.main_state, 0);
  assert.equal(head(u1, 3).target, 215, "heaters still on");
  u1.model.advance(9);
  await req.promise;
  assert.equal(req.error, null);
  assert.equal(head(u1, 3).target, 0);
  assert.equal(u1.model.status().heater_bed.target, 0);
  assert.equal(u1.model.status().toolhead.homed_axes, "");
  assert.equal(head(u1, 3).state, "ACTIVATE", "cancel does not park");
});

test("real timing: a tool change takes ~4s, with no head picked and toolhead.extruder on the old head", async t => {
  const { u1, p } = await virtualU1(t, { timing: "real", clock: false });
  await printing(u1, p);
  while (!u1.model.job.changing) u1.model.advance(1);
  const start = u1.model.time;
  assert.ok([0, 1, 2, 3].every(h => head(u1, h).state === "PARKED"));
  assert.equal(u1.model.status().toolhead.extruder, "extruder3");
  while (u1.model.job.changing) u1.model.advance(1);
  assert.equal(u1.model.time - start, 4);
  assert.equal(u1.model.status().toolhead.extruder, "extruder1");
  assert.equal(head(u1, 1).state, "ACTIVATE");
});

test("real timing: the job ends with a park, then ~4s later everything off and 'complete'", async t => {
  const { u1, p } = await virtualU1(t, { timing: "real", clock: false });
  await printing(u1, p, { layers: 1, secondsPerLayer: 40 });
  while (!u1.model.job.ending) u1.model.advance(1);
  assert.equal(u1.model.status().print_stats.state, "printing");
  assert.ok([0, 1, 2, 3].every(h => head(u1, h).state === "PARKED"));
  u1.model.advance(4);
  const st = u1.model.status();
  assert.equal(st.print_stats.state, "complete");
  assert.equal(st.heater_bed.target, 0);
  assert.equal(st.toolhead.homed_axes, "");
  assert.deepEqual(st.print_task_config.extruder_map_table.slice(0, 4), [0, 1, 2, 3]);
});

test("real timing with the wall clock: time moves by itself, and close() stops it", async t => {
  const u1 = await startVirtualU1({ timing: "real" });
  await sleep(600);
  assert.ok(u1.model.time >= 0.25, `model time ${u1.model.time}`);
  await u1.close();
  const after = u1.model.time;
  await sleep(400);
  assert.equal(u1.model.time, after);
});

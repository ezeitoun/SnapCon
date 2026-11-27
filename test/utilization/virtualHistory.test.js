// test/utilization/virtualHistory.test.js — fleet utilization against the
// Virtual U1 (fixtures/virtual-u1, 127.0.0.1 only): real prints on the
// simulator, read through the real U1 connector, recorded and reconciled by
// the real utilization module, as server.js drives it. No physical printer.
//
// What this can prove: the pieces fit (connector, history paging, tracker,
// writer, reconciliation, worker). What it cannot: how a real U1's history
// behaves; the simulator's history records are [guess] shapes (see its model).
const test = require("node:test");
const assert = require("node:assert/strict");
const u1c = require("../../connectors/snapmaker-u1-klipper");
const { startVirtualU1 } = require("../../fixtures/virtual-u1");
const { createUtilization } = require("../../utilization");
const { createUtilizationStore } = require("../../utilization/UtilizationStore");
const { quiet, tmpBase } = require("./helpers");

const until = async (fn, ms = 20000, what = "condition") => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise(r => setTimeout(r, 50)); } };

async function setup(t) {
  const sim = await startVirtualU1({ printSpeed: 10, instantHeat: true });
  t.after(() => sim.close());
  const p = { id: "vu1-history", name: "Virtual U1 (history)", connector: "virtual-u1", url: sim.url };
  const base = tmpBase(t);
  const u = createUtilization({ baseDir: base, log: quiet, isVirtual: () => true, historySetting: () => true,
    historyFor: printer => opts => u1c.fetchJobHistory(printer, opts),
    historyOptions: { startDelayMs: 0, minGapMs: 0, pageGapMs: 0, intervalMs: 0 },
    checkpointerOptions: { periodMs: 1e9 } });
  t.after(() => u.stop());
  u.start();
  // One poll, as notifyTick does it: the reading, then saving after.
  const poll = async () => { const st = await u1c.probe(p); u.beginTick([p], [p]); u.observe(p, st); u.endTick(); return st; };
  // A history pass ends between polls; what it found is saved after the next
  // poll's endTick, like every other analytics write.
  const settled = async () => { await until(() => !u.status().history.inflight, 20000, "history pass"); u.endTick(); await until(() => u.status().writer.pending === 0, 20000, "saved"); };
  const read = async fn => { const r = await u.stop(); void r; const s = createUtilizationStore({ baseDir: base, log: quiet }).open(); try { return fn(s); } finally { s.close(); } };
  return { sim, p, u, poll, settled, read };
}

test("a print that starts and finishes between two polls is recovered from the printer's history, once", async t => {
  const { sim, p, poll, settled, read } = await setup(t);
  sim.model.addFile("Quick.gcode", { layers: 1, secondsPerLayer: 10 });
  assert.equal((await poll()).state, "standby");
  await u1c.startPrintFile(p, "Quick.gcode");
  // The simulator's clock moves when told; the record's span is real seconds.
  await new Promise(r => setTimeout(r, 3000));
  sim.model.advance(600);
  assert.equal(sim.model.stats.state, "complete");
  assert.equal((await poll()).state, "complete", "SnapCon never saw it printing");
  await settled();                                      // the history pass started by that poll
  await poll(); await settled();                        // saved after the next poll
  await poll(); await settled();                        // and again: nothing new
  await read(s => {
    const jobs = s.jobs(p.id);
    assert.equal(jobs.length, 1);
    assert.deepEqual([jobs[0].source, jobs[0].filename, jobs[0].outcome, jobs[0].outcomeSource], ["backfilled", "Quick.gcode", "completed", "history"]);
    assert.ok(jobs[0].end > jobs[0].start);
    assert.ok(s.segments(p.id).every(x => x.provenance === "observed"), "no interval invented for it");
    assert.ok(s.historyState(p.id).counters.already >= 1, "the second read was a no-op");
  });
});

test("a print SnapCon watched and saw cancelled keeps its observed outcome and is linked to its history record", async t => {
  const { sim, p, poll, settled, read } = await setup(t);
  sim.model.addFile("Long.gcode", { layers: 20, secondsPerLayer: 60 });
  await poll();
  await u1c.startPrintFile(p, "Long.gcode");
  sim.model.advance(100);
  assert.equal((await poll()).state, "printing");
  await new Promise(r => setTimeout(r, 2000));
  await u1c.cancel(p);
  assert.equal((await u1c.probe(p)).state, "cancelled");
  await poll(); await settled();
  await poll(); await settled();
  await read(s => {
    const [j] = s.jobs(p.id);
    assert.equal(s.jobs(p.id).length, 1);
    assert.deepEqual([j.source, j.outcome], ["observed", "cancelled"]);
    assert.ok(j.historyId, "linked to the printer's record");
    assert.equal(s.historyState(p.id).counters.matched, 1);
  });
});

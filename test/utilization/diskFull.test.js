// test/utilization/diskFull.test.js — a full disk under utilization-data/
// (owner, pre-deployment safeguards). Saving fails with SQLITE_FULL, which the
// writer treats as transient: what was read waits in memory (bounded) and is
// saved with its real times once there is space. What could not be kept, or
// was still waiting when SnapCon stopped, is Not recorded from the last saved
// checkpoint: never invented. The database stays sound throughout.
//
// Two layers: the store failing with SQLite's own "database or disk is full"
// (everywhere), and a real ENOSPC from the operating system through a small
// LD_PRELOAD shim (Linux with a C compiler; skipped otherwise).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { rig, ledgerOf, sqliteError, T0, S, MIN, on } = require("./helpers");

const FULL = 13;
function failNext(r, n, err) { const was = r.store.applyBatch; let left = n; r.store.applyBatch = (...a) => { if (left-- > 0) throw err; return was(...a); }; return () => { r.store.applyBatch = was; }; }

test("disk full until SnapCon stops: after the restart, the time from the last saved checkpoint is Not recorded, nothing after it is invented, and recording goes on", t => {
  let r = rig(t);
  const p = r.P("u");
  r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, on("standby"), r.clock.t); r.flush();
  r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, on("printing", "a.gcode"), r.clock.t); r.flush();
  r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, on("printing", "a.gcode"), r.clock.t); r.flush();
  const savedAt = Number(r.store.getMeta("heartbeat"));          // the last saved checkpoint
  assert.equal(savedAt, r.clock.t);
  const full = failNext(r, 1e9, sqliteError(FULL, "database or disk is full"));
  for (let i = 0; i < 20; i++) {                                // ten minutes of polls, a job ending and an idle printer, none saved
    r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t);
    r.tracker.observe(p, i < 8 ? on("printing", "a.gcode") : on(i < 9 ? "complete" : "standby", "a.gcode"), r.clock.t);
    r.flush(); r.fireTimers();
  }
  assert.ok(r.writer.pending() > 0, "what was read waits in memory");
  assert.notEqual(r.writer.status().mode, "stopped", "not stopped: a full disk is transient");
  full();
  const stoppedAt = r.clock.t;
  r.clock.t += 2 * MIN;                                         // stopped with the disk still full; restarted with space
  r = r.restart();
  const restartedAt = r.clock.t;
  r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, on("standby"), r.clock.t); r.flush();
  r.clock.t += 30 * S; r.tracker.beginTick([p], [p], r.clock.t); r.tracker.observe(p, on("standby"), r.clock.t); r.flush();
  const segs = r.store.segments("u");
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start >= segs[i - 1].end, "no overlap");
  const job = segs.find(s => s.kind === "job");
  assert.ok(job, "the job saved before the disk filled is kept");
  assert.equal(job.end, savedAt, "and ends at the last saved checkpoint, not later");
  assert.ok(segs.every(s => s.start <= savedAt || s.start >= restartedAt), "no interval starts while the disk was full: nothing from then is kept or made up");
  assert.ok(segs.filter(s => s.start <= savedAt).every(s => s.end <= savedAt + 30 * S), "the intervals open when the disk filled end at the last saved checkpoint");
  const l = ledgerOf(r.store, "u", savedAt, restartedAt);
  assert.ok(l.buckets.notRecorded >= (restartedAt - savedAt) - 30 * S, "the full-disk time and the stop read as Not recorded");
  assert.equal(l.buckets.printing + l.buckets.failed, 0, "no printing is claimed for that time");
  assert.equal(r.writer.status().mode, "ok");
  assert.ok(stoppedAt < restartedAt);
});

// ---- a real ENOSPC, through the operating system ----
const SHIM_C = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>
static int full(int fd) {
  const char *dir = getenv("ENOSPC_DIR"), *flag = getenv("ENOSPC_FLAG");
  if (!dir || !flag || access(flag, F_OK) != 0) return 0;
  char link[64], p[4096]; snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, p, sizeof p - 1); if (n <= 0) return 0; p[n] = 0;
  if (strncmp(p, dir, strlen(dir)) != 0) return 0;
  errno = ENOSPC; return 1;
}
#define WRAP(ret, name, params, args) ret name params { static ret (*real) params; if (!real) real = dlsym(RTLD_NEXT, #name); if (full(fd)) return -1; return real args; }
WRAP(ssize_t, write, (int fd, const void *b, size_t c), (fd, b, c))
WRAP(ssize_t, pwrite, (int fd, const void *b, size_t c, off_t o), (fd, b, c, o))
WRAP(ssize_t, pwrite64, (int fd, const void *b, size_t c, off_t o), (fd, b, c, o))
WRAP(ssize_t, writev, (int fd, const struct iovec *v, int c), (fd, v, c))
WRAP(ssize_t, pwritev, (int fd, const struct iovec *v, int c, off_t o), (fd, v, c, o))
WRAP(int, ftruncate, (int fd, off_t l), (fd, l))
WRAP(int, fallocate, (int fd, int m, off_t o, off_t l), (fd, m, o, l))
`;
function buildShim(t) {
  if (process.platform !== "linux") return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-enospc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "enospc.c"), SHIM_C);
  const cc = spawnSync("cc", ["-shared", "-fPIC", "-O1", "-o", path.join(dir, "enospc.so"), path.join(dir, "enospc.c"), "-ldl"], { encoding: "utf8" });
  return cc.status === 0 ? dir : null;
}
// The child: the real store, tracker and writer on `base`, with the shim loaded.
const CHILD = `
const path = require("path"), fs = require("fs");
const H = require(${JSON.stringify(path.join(__dirname, "helpers.js"))});
const { createUtilizationStore } = require(${JSON.stringify(path.join(__dirname, "..", "..", "utilization", "UtilizationStore.js"))});
const { createTracker } = require(${JSON.stringify(path.join(__dirname, "..", "..", "utilization", "Tracker.js"))});
const { createWriter } = require(${JSON.stringify(path.join(__dirname, "..", "..", "utilization", "Writer.js"))});
const [base, flag, phase] = process.argv.slice(1);
const clock = { t: H.T0 + (phase === "after" ? 3 * 3600e3 : 0) };
const log = { log() {}, warn: m => out.warns.push(m), error: m => out.errors.push(m) };
const out = { warns: [], errors: [] };
const store = createUtilizationStore({ baseDir: base, log, now: () => clock.t }).open();
const turns = [], timers = [];
let tracker = null;
const writer = createWriter({ store, log, clock: () => clock.t, schedule: fn => turns.push(fn), timer: (fn, ms) => timers.push(fn), onResync: () => tracker && tracker.resync() });
tracker = createTracker({ store, writer, log });
tracker.start(clock.t);
const flush = () => { writer.kick(); let n = 0; while (turns.length) { turns.shift()(); if (++n > 1e5) throw new Error("never settles"); } };
const fire = () => { for (const fn of timers.splice(0)) fn(); };
const p = { id: "u", name: "U", connector: "snapmaker-u1-klipper-ws" };
const poll = reading => { clock.t += 30e3; tracker.beginTick([p], [p], clock.t); tracker.observe(p, reading, clock.t); flush(); fire(); flush(); };
if (phase === "run") {
  poll(H.on("standby")); poll(H.on("printing", "a.gcode"));
  out.savedAt = clock.t;
  fs.writeFileSync(flag, "");                                        // the disk fills
  for (let i = 0; i < 6; i++) poll(H.on("printing", "a.gcode"));
  poll(H.on("complete", "a.gcode")); poll(H.on("standby"));
  out.pendingWhileFull = writer.pending(); out.modeWhileFull = writer.status().mode;
  out.fullUntil = clock.t;
  fs.rmSync(flag);                                                   // space again: the next retry saves it
  clock.t += 30e3; fire(); flush();
  poll(H.on("standby"));
  out.pendingAfter = writer.pending();
  out.segments = store.segments("u").map(s => ({ kind: s.kind, start: s.start, end: s.end }));
  out.quick = store.pragma("quick_check");
  out.lastSavedBeforeStop = Number(store.getMeta("heartbeat"));     // the last saved checkpoint
  fs.writeFileSync(flag, "");                                        // full again, and SnapCon stops with it full
  poll(H.on("printing", "b.gcode")); poll(H.on("printing", "b.gcode"));
  store.abandon();                                                   // like a process that ends (a forced stop)
}
if (phase === "after-full") {
  // Started again with the disk still full: the database is left exactly where it is.
  out.available = store.isAvailable(); out.reason = store.status().reason;
  out.files = fs.readdirSync(path.join(base, "utilization-data"));
  try { store.close(); } catch {}
}
if (phase === "after") {
  poll(H.on("standby")); poll(H.on("standby"));
  out.segments = store.segments("u").map(s => ({ kind: s.kind, start: s.start, end: s.end }));
  out.quick = store.pragma("quick_check");
  store.close();
}
process.stdout.write(JSON.stringify(out));
`;

test("a real ENOSPC under utilization-data/: kept and saved with its real times when space returns; full until a stop, Not recorded after the restart; the database sound", t => {
  const shim = buildShim(t);
  if (!shim) return t.skip("needs Linux and a C compiler for the ENOSPC shim");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-full-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const flag = path.join(shim, "full");
  const env = { ...process.env, ENOSPC_DIR: path.join(base, "utilization-data") + path.sep, ENOSPC_FLAG: flag, LD_PRELOAD: path.join(shim, "enospc.so") };
  const run = phase => { const c = spawnSync(process.execPath, ["-e", CHILD, base, flag, phase], { encoding: "utf8", env, timeout: 60e3 }); assert.equal(c.status, 0, c.stderr); return JSON.parse(c.stdout); };
  const a = run("run");
  assert.ok(a.warns.some(w => /could not save \(database or disk is full\)/.test(w)), "the full disk is reported: " + a.warns.join(" | "));
  assert.equal(a.errors.length, 0, "recording is not stopped: " + a.errors.join(" | "));
  assert.ok(a.pendingWhileFull > 0, "what was read waits in memory");
  assert.notEqual(a.modeWhileFull, "stopped", "retrying, not stopped");
  assert.equal(a.pendingAfter, 0, "saved once there is space");
  const job = a.segments.find(s => s.kind === "job");
  assert.ok(job && job.start === a.savedAt && job.end > a.savedAt && job.end <= a.fullUntil, "the job seen while the disk was full is saved with its real times");
  for (let i = 1; i < a.segments.length; i++) assert.ok(a.segments[i].start >= a.segments[i - 1].end, "no overlap, nothing doubled");
  assert.equal(a.quick, "ok");
  // Started again while the disk is still full: not opened, left as it is, never moved aside.
  const files = fs.readdirSync(path.join(base, "utilization-data")).sort();
  const c = run("after-full");
  assert.equal(c.available, false);
  assert.match(c.reason, /could not be opened .*it is left as it is/);
  assert.deepEqual(c.files.filter(f => /corrupt/.test(f)), [], "never moved aside for a full disk");
  // Space again, and SnapCon started again: what was open is closed at the last saved checkpoint.
  fs.rmSync(flag);
  const b = run("after");
  assert.deepEqual(files.filter(f => /corrupt/.test(f)), []);
  assert.equal(b.quick, "ok", "the database is sound after a stop on a full disk");
  assert.ok(!b.segments.some(s => s.kind === "job" && s.start > a.lastSavedBeforeStop), "the print seen only while the disk was full is not invented");
  assert.ok(b.segments.every(s => s.end == null || s.end <= a.lastSavedBeforeStop || s.start >= a.lastSavedBeforeStop + 3 * 3600e3 - 60e3),
    "what was open when the disk filled ends at the last saved checkpoint; nothing until the restart: Not recorded");
  assert.ok(b.segments.some(s => s.start > a.lastSavedBeforeStop), "and recording goes on after the restart");
});

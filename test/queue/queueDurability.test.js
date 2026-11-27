// test/queue/queueDurability.test.js — the queue store's save order, its
// behaviour when a step of a save fails, and what start-up does with every
// combination of primary / backup / leftover temporary file.
//
// Background: after a power loss, queue-data.json and queue-data.json.bak
// were both found at full length and all zero bytes. The store wrote both
// within a millisecond on every save and never flushed either file's content.
//
// What these tests can and cannot show:
//   - The step-failure and recovery tests run the real store on a real
//     temporary folder, with single filesystem calls made to fail.
//   - The "simulated crash" tests run it on a MODEL (crashModelFs.js) — see
//     that file. They check the order of writes, flushes and renames against
//     one pessimistic model. They are not proof against a real power loss,
//     and say nothing about storage that ignores flush requests.
//   - The crash guarantee assumes a valid generation was already durable
//     before the interrupted save. The very first save has no such
//     generation; that case is tested separately (the store comes back empty
//     as a first run, or with the new data — never "recovery required").
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createQueueStore, defaultPrinterState } = require("../../queue/QueueStore");
const { createCrashModelFs, CrashSignal } = require("./crashModelFs");

// A synthetic store in the exact format the store has always written
// (JSON.stringify(store, null, 2)). No production data.
const SAMPLE_TEXT = fs.readFileSync(path.join(__dirname, "fixtures", "queue-store-sample.json"), "utf8");
const SAMPLE = JSON.parse(SAMPLE_TEXT);
const IDS = [...Object.keys(SAMPLE), "p_new"];
const text = obj => JSON.stringify(obj, null, 2);
const GEN1 = SAMPLE;                                                              // the older generation (backup)
const GEN2 = { ...SAMPLE, p_sample0002: { ...SAMPLE.p_sample0002, queuePaused: false } };   // the newer one (primary)
const GEN3 = { ...GEN2, p_sample0003: { ...SAMPLE.p_sample0003, queueState: "idle" } };     // only ever in a leftover .tmp
const toIdle = s => ({ ...s, queueState: "idle", updatedAt: 1760000001234 });

const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-qdur-"));
const P = base => path.join(base, "data", "queue-data.json");
const B = base => P(base) + ".bak";
const T = base => P(base) + ".tmp";
const quiet = t => { const o = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; t.after(() => Object.assign(console, o)); };
// What a store holds for the known printers, comparable: a printer with no
// record reads as the default state, whose updatedAt is "now" — left out.
const view = store => Object.fromEntries(IDS.map(id => [id, { ...store.getPrinterState(id), updatedAt: 0 }]));
const viewOf = obj => Object.fromEntries(IDS.map(id => [id, { ...(obj[id] || defaultPrinterState()), updatedAt: 0 }]));
const listing = base => { try { return fs.readdirSync(path.join(base, "data")).sort(); } catch { return []; } };
const bytesOf = base => Object.fromEntries(listing(base).map(n => [n, fs.readFileSync(path.join(base, "data", n)).toString("hex")]));
function seed(base, files) {
  fs.mkdirSync(path.join(base, "data"), { recursive: true });
  for (const [name, content] of Object.entries(files)) if (content !== undefined) fs.writeFileSync(path.join(base, "data", name), content);
}
function open(base, opts) { const store = createQueueStore({ baseDir: base, degradedRetryMs: 3600000, ...opts }); store.load(); return store; }

// The reader as it was before this change (queue/QueueStore.js load(), as
// deployed at fb5846a), reduced to what it returns. Used to check that files
// left by the new code are read the same way by the old one (a rollback).
function legacyRead(base) {
  const tryParse = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };
  if (!fs.existsSync(P(base))) return { store: {} };
  let loaded = tryParse(P(base));
  if (loaded === undefined) loaded = tryParse(B(base));
  if (loaded === undefined) return { recoveryRequired: true };
  return { store: loaded || {} };
}

// fs with single calls made to fail. rule(op, name) returns an Error to
// throw, { returns: n } / { max: n } for writeSync, or nothing. For a rename,
// name is the source and a third argument is the destination.
function faultyFs(rule) {
  const fdName = new Map(), calls = [];
  const hit = (op, name, to) => { calls.push(op + " " + name); const r = rule(op, name, to); if (r instanceof Error) throw r; return r; };
  const wrap = { ...fs,
    openSync(p, ...r) { const name = path.basename(p); hit("open", name); const fd = fs.openSync(p, ...r); fdName.set(fd, name); return fd; },
    writeSync(fd, buf, off, len, ...r) {
      const res = hit("write", fdName.get(fd));
      if (res && res.returns !== undefined) return res.returns;
      if (res && res.max) len = Math.min(len === undefined ? buf.length - (off || 0) : len, res.max);
      return fs.writeSync(fd, buf, off, len, ...r);
    },
    fsyncSync(fd) { hit("fsync", fdName.get(fd)); return fs.fsyncSync(fd); },
    closeSync(fd) { const name = fdName.get(fd); fdName.delete(fd); fs.closeSync(fd); hit("close", name); },
    copyFileSync(a, b) { hit("copy", path.basename(b)); return fs.copyFileSync(a, b); },
    renameSync(a, b) { hit("rename", path.basename(a), path.basename(b)); return fs.renameSync(a, b); },
    unlinkSync(p) { hit("unlink", path.basename(p)); return fs.unlinkSync(p); },
    readFileSync(p, ...r) { hit("read", path.basename(p)); return fs.readFileSync(p, ...r); },
  };
  return { fs: wrap, calls };
}
const err = code => Object.assign(new Error(code + ": simulated"), { code });
const NAME = { p: "queue-data.json", b: "queue-data.json.bak", t: "queue-data.json.tmp", d: "data" };

// ---------------------------------------------------------------- save order

test("a save writes, flushes and closes the temporary file before it replaces the primary, and flushes the backup before the rename", t => {
  quiet(t);
  const base = tmpBase();
  const f = faultyFs(() => {});
  const store = open(base, { fsImpl: f.fs });
  f.calls.splice(0);                          // start-up's own calls are not part of a save
  assert.equal(store.applyIntent("p_new", toIdle).ok, true);
  const first = f.calls.splice(0);
  const at = (calls, s) => calls.indexOf(s);
  assert.ok(at(first, "write " + NAME.t) >= 0 && at(first, "write " + NAME.t) < at(first, "fsync " + NAME.t), "written, then flushed");
  assert.ok(at(first, "fsync " + NAME.t) < at(first, "close " + NAME.t) && at(first, "close " + NAME.t) < at(first, "rename " + NAME.t), "flushed and closed before the rename");
  assert.ok(at(first, "rename " + NAME.t) < first.lastIndexOf("fsync " + NAME.d), "the folder is flushed after the rename");
  assert.equal(first.includes("fsync " + NAME.b), false, "first save: nothing to back up");

  assert.equal(store.applyIntent("p_sample0001", toIdle).ok, true);
  const second = f.calls.splice(0);
  assert.ok(at(second, "fsync " + NAME.t) < at(second, "copy " + NAME.b), "the new generation is durable before the backup is touched");
  assert.ok(at(second, "copy " + NAME.b) < at(second, "fsync " + NAME.b) && at(second, "fsync " + NAME.b) < at(second, "rename " + NAME.t), "the backup is flushed before the primary is replaced");
  assert.deepEqual(JSON.parse(fs.readFileSync(P(base), "utf8")).p_sample0001.queueState, "idle");
});

test("a write that takes several calls still lands every byte; a write that makes no progress fails the save", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: text(GEN2) });
  const short = open(base, { fsImpl: faultyFs((op, n) => op === "write" && n === NAME.t ? { max: 7 } : undefined).fs });
  assert.equal(short.applyIntent("p_new", toIdle).ok, true);
  assert.equal(fs.readFileSync(P(base), "utf8"), text({ ...GEN2, p_new: short.getPrinterState("p_new") }), "complete, byte for byte");

  const stuck = open(base, { fsImpl: faultyFs((op, n) => op === "write" && n === NAME.t ? { returns: 0 } : undefined).fs });
  const before = fs.readFileSync(P(base), "utf8");
  const r = stuck.applyIntent("p_sample0003", toIdle);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "persist-failed");
  assert.equal(fs.readFileSync(P(base), "utf8"), before, "the primary is untouched");
});

// ------------------------------------------------------ a step of a save fails

const STEPS = [
  ["opening the temporary file", (op, n) => op === "open" && n === NAME.t && err("EIO")],
  ["writing the temporary file", (op, n) => op === "write" && n === NAME.t && err("EIO")],
  ["a write that makes no progress (disk full)", (op, n) => op === "write" && n === NAME.t && { returns: 0 }],
  ["flushing the temporary file", (op, n) => op === "fsync" && n === NAME.t && err("EIO")],
  ["closing the temporary file", (op, n) => op === "close" && n === NAME.t && err("EIO")],
  ["copying the primary to the backup", (op, n) => op === "copy" && n === NAME.b && err("EIO")],
  ["opening the backup to flush it", (op, n) => op === "open" && n === NAME.b && err("EIO")],
  ["flushing the backup", (op, n) => op === "fsync" && n === NAME.b && err("EIO")],
  ["renaming over the primary", (op, n) => op === "rename" && n === NAME.t && err("ENOSPC")],
];

for (const [what, rule] of STEPS) {
  test(`save fails at: ${what} — reported, memory not changed, the last good generation still loads`, t => {
    quiet(t);
    const base = tmpBase();
    seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
    let on = true;
    const f = faultyFs((op, n) => on ? (rule(op, n) || undefined) : undefined);
    const store = open(base, { fsImpl: f.fs });
    const before = view(store);

    const r = store.applyIntent("p_new", toIdle);
    assert.equal(r.ok, false, "never reported as saved");
    assert.equal(r.reason, "persist-failed");
    assert.deepEqual(view(store), before, "an intent that could not be saved is not applied");
    assert.equal(store.getGlobalStatus().storeDegraded, true);
    assert.equal(store.applyIntent("p_new", toIdle).reason, "store-degraded");
    assert.equal(fs.readFileSync(P(base), "utf8"), text(GEN2), "the primary is the generation it was");

    // An observed event is kept in memory but not claimed as saved.
    const o = store.applyObserved("p_sample0003", toIdle);
    assert.equal(o.persisted, false);
    assert.equal(store.getPrinterState("p_sample0003").queueState, "idle");

    // A restart at this point finds a complete generation.
    const again = open(base);
    assert.equal(again.getGlobalStatus().queueStoreRecoveryRequired, false);
    assert.deepEqual(view(again), viewOf(GEN2));

    // Once the fault is gone, the retry saves what is in memory.
    on = false;
    assert.equal(store.retrySave().ok, true);
    assert.equal(store.getGlobalStatus().storeDegraded, false);
    assert.deepEqual(view(open(base)), view(store));
  });
}

test("the folder flush: a real I/O error fails the save (fail closed); 'not supported here' does not", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
  const eio = open(base, { fsImpl: faultyFs((op, n) => op === "fsync" && n === NAME.d && err("EIO")).fs });
  const before = view(eio);
  const r = eio.applyIntent("p_new", toIdle);
  assert.equal(r.ok, false, "a rename that may not be durable is not reported as saved");
  assert.deepEqual(view(eio), before);
  // The rename had happened: either generation may be on disk, each complete.
  const disk = JSON.parse(fs.readFileSync(P(base), "utf8"));
  assert.ok(disk.p_sample0001 && Array.isArray(disk.p_sample0001.queue));
  assert.equal(open(base).getGlobalStatus().queueStoreRecoveryRequired, false);

  // What the divergence looks like, so it is not a surprise: the file holds
  // the intent that was reported as failed until the retry rewrites it from memory.
  assert.equal(disk.p_new.queueState, "idle", "the rename had already happened");
  assert.equal(open(base).getPrinterState("p_new").queueState, "idle", "a restart now would show it");
  const healthy = open(base);                 // (a restart: memory and disk agree again)
  assert.equal(healthy.getGlobalStatus().storeDegraded, false);

});

// Exactly which folder-flush outcomes still count as a completed save.
test("the folder flush is skipped only where a folder cannot be flushed: Windows (not attempted) and EINVAL/ENOTSUP/EOPNOTSUPP/ENOSYS from the flush itself", t => {
  quiet(t);
  const fresh = (rule, platform) => {
    const b = tmpBase();
    seed(b, { [NAME.p]: text(GEN2) });
    const f = faultyFs(rule);
    return { s: open(b, { fsImpl: f.fs, platform }), f, b };
  };
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
    const { s } = fresh((op, n) => op === "fsync" && n === NAME.d && err(code), "linux");
    assert.equal(s.applyIntent("p_new", toIdle).ok, true, code + ": this filesystem has no folder flush — the save still completes");
    assert.equal(s.getGlobalStatus().storeDegraded, false);
  }
  // Windows: no attempt at all, so no error code is being interpreted.
  const win = fresh((op, n) => (op === "open" || op === "fsync") && n === NAME.d && err("EIO"), "win32");
  assert.equal(win.s.applyIntent("p_new", toIdle).ok, true);
  assert.equal(win.f.calls.includes("open " + NAME.d), false, "the folder is never opened on Windows");

  // Everything else is a failure, not "unsupported".
  const failing = [
    ...["EIO", "ENOSPC", "EDQUOT", "EROFS", "ESTALE", "EBADF", "EPERM", "EACCES", "ENOTTY", "ESOMETHINGNEW"].map(c => ["fsync", c]),
    ...["EACCES", "EMFILE", "ENFILE", "ENOENT", "EISDIR", "EPERM", "EIO"].map(c => ["open", c]),
  ];
  for (const [at, code] of failing) {
    const { s, b } = fresh((op, n) => op === at && n === NAME.d && err(code), "linux");
    const before = view(s);
    const r = s.applyIntent("p_new", toIdle);
    assert.equal(r.ok, false, at + " " + code + " on the folder fails the save");
    assert.equal(r.reason, "persist-failed");
    assert.deepEqual(view(s), before, at + " " + code + ": memory not changed");
    assert.equal(s.getGlobalStatus().storeDegraded, true);
    assert.equal(open(b).getGlobalStatus().queueStoreRecoveryRequired, false, "and the folder still loads");
  }
});

// ------------------------------------------------------------- the first save

test("the very first save failing leaves a first-run folder: nothing applied, nothing to recover, and the next save works", t => {
  quiet(t);
  for (const [what, rule] of STEPS.filter(([w]) => !/backup/.test(w))) {
    const base = tmpBase();
    let on = true;
    const store = open(base, { fsImpl: faultyFs((op, n) => on ? (rule(op, n) || undefined) : undefined).fs });
    const r = store.applyIntent("p_new", toIdle);
    assert.equal(r.ok, false, what);
    assert.equal(store.getPrinterState("p_new").queueState, "unmanaged", what);
    assert.equal(fs.existsSync(P(base)), false, what + ": no primary was created");
    const again = open(base);
    assert.deepEqual(again.getGlobalStatus().queueStoreRecoveryRequired, false, what);
    assert.equal(again.getPrinterState("p_new").queueState, "unmanaged", what + ": the unsaved data is not promoted");
    assert.equal(fs.existsSync(T(base)), false, what + ": no temporary file is left in the way");
    on = false;
    assert.equal(store.retrySave().ok, true, what);
    assert.equal(store.applyIntent("p_new", toIdle).ok, true, what);
    assert.equal(open(base).getPrinterState("p_new").queueState, "idle", what);
  }
});

// ------------------------------------------------------------ recovery matrix

const CONTENT = {
  good2: text(GEN2), good1: text(GEN1), zero: Buffer.alloc(text(GEN2).length), garbage: "corrupt {{{",
  "null": "null", array: "[]", number: "42", string: "\"queue\"", "true": "true", empty: "",
};
const MALFORMED = ["zero", "garbage", "null", "array", "number", "string", "true", "empty"];
const PRIMARY_KINDS = ["good2", ...MALFORMED, "missing", "unreadable"];
const BACKUP_KINDS = ["good1", "zero", "garbage", "null", "array", "missing", "unreadable"];
const TMP_KINDS = ["none", "valid", "garbage"];

function expected(p, b) {
  if (p === "good2") return { kind: "loaded", gen: GEN2 };
  if (p === "unreadable") return { kind: "blocked", mem: b === "good1" ? GEN1 : {} };
  if (b === "unreadable") return { kind: "blocked", mem: {} };
  if (b === "good1") return { kind: "loaded", gen: GEN1, primaryAside: p !== "missing" };
  if (p === "missing" && b === "missing") return { kind: "first-run" };
  return { kind: "recovery-required" };
}

for (const p of PRIMARY_KINDS) for (const b of BACKUP_KINDS) {
  test(`start-up: primary ${p}, backup ${b} (with and without a leftover temporary file)`, t => {
    quiet(t);
    for (const tmp of TMP_KINDS) {
      const label = `tmp ${tmp}`;
      const base = tmpBase();
      const tmpBytes = tmp === "valid" ? text(GEN3) : tmp === "garbage" ? "half-written {{{" : undefined;
      seed(base, {
        [NAME.p]: p === "missing" ? undefined : p === "unreadable" ? text(GEN2) : CONTENT[p],
        [NAME.b]: b === "missing" ? undefined : b === "unreadable" ? text(GEN1) : CONTENT[b],
        [NAME.t]: tmpBytes,
      });
      const unreadable = new Set([p === "unreadable" && NAME.p, b === "unreadable" && NAME.b].filter(Boolean));
      // Like a real error: the message names the full path (which must not reach users).
      const readErr = (code, n) => Object.assign(new Error(`${code}: simulated, open '${path.join(base, "data", n)}'`), { code });
      const f = faultyFs((op, n) => op === "read" && unreadable.has(n) ? readErr(p === "unreadable" ? "EACCES" : "EIO", n) : undefined);
      const before = bytesOf(base);
      const store = open(base, { fsImpl: f.fs });
      const st = store.getGlobalStatus();
      const want = expected(p, b);
      const names = listing(base);
      const aside = names.filter(n => n.startsWith(NAME.t + ".leftover-"));

      assert.notDeepEqual(view(store), viewOf(GEN3), label + ": a leftover temporary file is never promoted");

      if (want.kind === "loaded") {
        assert.equal(st.queueStoreRecoveryRequired, false, label);
        assert.equal(st.saveBlocked, null, label);
        assert.equal(st.storeDegraded, false, label);
        assert.deepEqual(view(store), viewOf(want.gen), label);
        assert.equal(fs.existsSync(T(base)), false, label + ": the temporary file is gone after a successful load");
        if (want.primaryAside) {
          const kept = names.filter(n => n.startsWith(NAME.p + ".corrupt-"));
          assert.equal(kept.length, 1, label + ": the bad primary is kept under another name");
          assert.equal(fs.readFileSync(path.join(base, "data", kept[0])).toString("hex"), before[NAME.p], label + ": byte for byte");
        }
        if (want.gen === GEN1) {
          assert.equal(aside.length, tmp === "none" ? 0 : 1, label + ": an unfinished save next to a bad or missing primary is kept, not overwritten");
          if (aside.length) assert.equal(fs.readFileSync(path.join(base, "data", aside[0]), "utf8"), tmpBytes, label);
          assert.equal(st.setAsidePaths.length, (want.primaryAside ? 1 : 0) + aside.length, label);
        } else {
          assert.equal(aside.length, 0, label + ": with a valid primary the unfinished save is simply discarded");
        }
        if (want.gen === GEN1) {
          assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN1), label + ": the good backup is untouched");
          assert.equal(fs.readFileSync(P(base), "utf8"), text(GEN1), label + ": the primary is re-established from it");
        }
      } else if (want.kind === "first-run") {
        assert.equal(st.queueStoreRecoveryRequired, false, label);
        assert.equal(st.saveBlocked, null, label);
        assert.deepEqual(view(store), viewOf({}), label);
        assert.equal(fs.existsSync(T(base)), false, label);
        assert.equal(aside.length, tmp === "none" ? 0 : 1, label + ": an uncommitted first save is kept aside, not deleted");
        if (aside.length) assert.equal(fs.readFileSync(path.join(base, "data", aside[0]), "utf8"), tmpBytes, label);
      } else if (want.kind === "recovery-required") {
        assert.equal(st.queueStoreRecoveryRequired, true, label);
        assert.deepEqual(view(store), viewOf({}), label);
        assert.equal(fs.existsSync(P(base)), false, label);
        assert.equal(fs.existsSync(B(base)), false, label);
        assert.equal(st.corruptFilePaths.length, (p !== "missing") + (b !== "missing"), label);
        for (const c of st.corruptFilePaths) assert.equal(fs.existsSync(c), true, label + ": kept, not deleted");
        assert.equal(aside.length, tmp === "none" ? 0 : 1, label + ": the leftover temporary file is kept too");
        if (aside.length) assert.equal(fs.readFileSync(path.join(base, "data", aside[0]), "utf8"), tmpBytes, label);
        assert.equal(store.applyIntent("p_new", toIdle).reason, "recovery-required", label);
      } else {
        assert.equal(st.saveBlocked, "unreadable", label);
        assert.equal(st.storeDegraded, true, label + ": reported through the existing degraded state");
        assert.equal(st.queueStoreRecoveryRequired, true, label + ": also reported as recovery-required, which every existing guard honours");
        assert.deepEqual(st.corruptFilePaths, [], label + ": but nothing was quarantined");
        assert.ok(st.saveBlockedDetail && /EACCES|EIO/.test(st.saveBlockedDetail), label);
        assert.equal(st.saveBlockedDetail.includes(base), false, label + ": no server path in what users are shown");
        assert.deepEqual(view(store), viewOf(want.mem), label);
        // Nothing may be written, moved or deleted — whatever is asked of it.
        assert.equal(store.applyIntent("p_new", toIdle).ok, false, label);
        assert.equal(store.applyBulkIntent(() => ({ p_new: toIdle(store.getPrinterState("p_new")) })).ok, false, label);
        assert.equal(store.claimNextForDispatch("p_sample0001").claimed, false, label);
        assert.equal(store.applyObserved("p_sample0003", toIdle).persisted, false, label);
        assert.equal(store.retrySave().ok, false, label);
        const reset = store.acknowledgeReset("RESET");
        assert.equal(reset.ok, false, label + ": a reset must not overwrite data that could not be read");
        assert.equal(reset.code, "queue_store_save_blocked", label);
        assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true, label);
        assert.deepEqual(bytesOf(base), before, label + ": every file is byte-identical");
      }

      // What a second start-up, another save and a third start-up do.
      if (want.kind === "loaded" || want.kind === "first-run") {
        const second = open(base);
        assert.deepEqual(view(second), view(store), label + ": a second start-up reads the same thing");
        assert.deepEqual(second.getGlobalStatus().setAsidePaths, [], label + ": and has nothing left to move aside");
        const legacy = legacyRead(base);
        assert.deepEqual(viewOf(legacy.store), view(store), label + ": the previous reader reads the same thing (rollback)");
        assert.equal(second.applyIntent("p_new", toIdle).ok, true, label);
        const third = open(base);
        assert.deepEqual(view(third), view(second), label);
        assert.equal(third.getPrinterState("p_new").queueState, "idle", label);
        assert.deepEqual(viewOf(legacyRead(base).store), view(second), label + ": and so does the previous reader after a save");
        if (want.gen) assert.deepEqual(JSON.parse(fs.readFileSync(B(base), "utf8")), want.gen === GEN1 ? GEN1 : GEN2, label + ": the backup holds the generation before that save");
      }
      if (want.kind === "recovery-required") {
        assert.equal(store.acknowledgeReset("RESET").ok, true, label);
        assert.equal(store.applyIntent("p_new", toIdle).ok, true, label);
        assert.equal(open(base).getPrinterState("p_new").queueState, "idle", label);
      }
    }
  });
}

// ------------------------------------------ the bad primary cannot be moved aside

const isCorruptCopy = n => n.startsWith(NAME.p + ".corrupt-");

test("backup loaded but the bad primary cannot be kept aside: saves are blocked, the good backup is never overwritten, and it clears once the copy works", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: CONTENT.zero, [NAME.b]: text(GEN1) });
  let on = true;
  const f = faultyFs((op, n) => on && op === "copy" && isCorruptCopy(n) ? err("EIO") : undefined);
  const before = bytesOf(base);
  const store = open(base, { fsImpl: f.fs });
  let st = store.getGlobalStatus();
  assert.equal(st.saveBlocked, "corrupt-primary-in-place");
  assert.equal(st.storeDegraded, true);
  assert.equal(st.queueStoreRecoveryRequired, false);
  assert.deepEqual(view(store), viewOf(GEN1), "the backup's content is what is shown");

  assert.equal(store.applyIntent("p_new", toIdle).ok, false);
  assert.equal(store.applyObserved("p_sample0003", toIdle).persisted, false);
  assert.equal(store.retrySave().ok, false);
  assert.equal(store.acknowledgeReset("RESET").ok, false);
  assert.deepEqual(bytesOf(base), before, "nothing on disk changed while blocked — the backup above all");
  assert.equal(f.calls.includes("copy " + NAME.b), false, "the bad primary was never copied towards the backup");
  assert.deepEqual(viewOf(legacyRead(base).store), viewOf(GEN1), "a rollback at this point still reads the backup");

  on = false;                               // the copy works now
  assert.equal(store.retrySave().ok, true);
  st = store.getGlobalStatus();
  assert.equal(st.saveBlocked, null);
  assert.equal(st.storeDegraded, false);
  assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN1), "the good backup survived the first save after recovery");
  const kept = listing(base).filter(isCorruptCopy);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(base, "data", kept[0])).toString("hex"), before[NAME.p], "the bad file's bytes are kept");
  assert.equal(f.calls.includes("copy " + NAME.b), false, "and the recovery save did not touch the backup either");
  const again = open(base);
  assert.equal(again.getPrinterState("p_sample0003").queueState, "idle", "the observed event kept in memory was saved");
  assert.equal(again.getGlobalStatus().saveBlocked, null);
  assert.equal(store.applyIntent("p_new", toIdle).ok, true, "ordinary saves work again");
  assert.deepEqual(JSON.parse(fs.readFileSync(B(base), "utf8")).p_sample0003.queueState, "idle", "and the backup rotates normally from then on");
});

// ------------------------------------- a leftover temporary file that cannot be kept
// A save reuses the temporary file's name. When the leftover found at start-up
// may be the only copy of something and cannot be moved aside, nothing is
// saved over it: recovery and saving are blocked until it can be moved.
const isLeftover = n => n.startsWith(NAME.t + ".leftover-");
const tmpStuck = on => (op, n, to) => on() && op === "rename" && n === NAME.t && isLeftover(to || "") ? err("EIO") : undefined;
const wroteTmp = calls => calls.includes("open " + NAME.t);

for (const [what, primary] of [["corrupt", CONTENT.garbage], ["missing", undefined]]) {
  test(`leftover temporary file cannot be moved aside, primary ${what}, good backup: recovery is blocked and nothing is overwritten; it completes once the file can be moved`, t => {
    quiet(t);
    const base = tmpBase();
    seed(base, { [NAME.p]: primary, [NAME.b]: text(GEN1), [NAME.t]: text(GEN3) });
    let on = true;
    const f = faultyFs(tmpStuck(() => on));
    const before = bytesOf(base);
    const store = open(base, { fsImpl: f.fs });
    let st = store.getGlobalStatus();
    assert.equal(st.saveBlocked, "leftover-tmp-in-place");
    assert.match(st.saveBlockedDetail, /could not be moved aside \(EIO\)/);
    assert.doesNotMatch(st.saveBlockedDetail, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no server path in text shown to users");
    assert.equal(st.storeDegraded, true);
    assert.deepEqual(view(store), viewOf(GEN1), "the backup is shown; the unfinished save is never loaded");

    assert.equal(store.applyIntent("p_new", toIdle).ok, false);
    assert.equal(store.applyObserved("p_sample0003", toIdle).persisted, false);
    assert.equal(store.retrySave().ok, false);
    assert.equal(store.acknowledgeReset("RESET").ok, false);
    assert.deepEqual(bytesOf(base), before, "nothing on disk changed: the leftover, the primary and the backup are as found");
    assert.equal(wroteTmp(f.calls), false, "the temporary file's name was never opened for writing");
    assert.equal(f.calls.some(c => c.startsWith("copy ")), false, "no copy was made either — the save stops before every other step");

    on = false;                               // it can be moved now
    assert.equal(store.retrySave().ok, true);
    st = store.getGlobalStatus();
    assert.equal(st.saveBlocked, null);
    assert.equal(st.storeDegraded, false);
    const kept = listing(base).filter(isLeftover);
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(base, "data", kept[0]), "utf8"), text(GEN3), "the unfinished save's bytes are kept");
    assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN1), "the good backup is untouched");
    assert.equal(JSON.parse(fs.readFileSync(P(base), "utf8")).p_sample0003.queueState, "idle", "the primary now holds memory (backup + the observed event)");
    assert.equal(open(base).getGlobalStatus().saveBlocked, null);
  });
}

test("leftover temporary file cannot be moved aside on a first run: saving is blocked, the file is not overwritten, and it clears once it can be moved", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.t]: text(GEN3) });
  let on = true;
  const f = faultyFs(tmpStuck(() => on));
  const before = bytesOf(base);
  const store = open(base, { fsImpl: f.fs });
  assert.equal(store.getGlobalStatus().saveBlocked, "leftover-tmp-in-place");
  assert.equal(store.getGlobalStatus().storeDegraded, true);
  assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, false);
  assert.equal(store.applyIntent("p_new", toIdle).reason, "store-degraded");
  assert.equal(store.applyObserved("p_new", toIdle).persisted, false);
  assert.equal(store.retrySave().ok, false);
  assert.deepEqual(bytesOf(base), before);
  assert.equal(wroteTmp(f.calls), false);
  on = false;
  assert.equal(store.retrySave().ok, true);
  assert.equal(store.getGlobalStatus().saveBlocked, null);
  const kept = listing(base).filter(isLeftover);
  assert.equal(fs.readFileSync(path.join(base, "data", kept[0]), "utf8"), text(GEN3));
  assert.equal(open(base).getPrinterState("p_new").queueState, "idle");
});

test("leftover temporary file cannot be moved aside with both queue files corrupt: recovery is required and a reset is refused until it can be moved", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: CONTENT.zero, [NAME.b]: CONTENT.garbage, [NAME.t]: text(GEN3) });
  let on = true;
  const f = faultyFs(tmpStuck(() => on));
  const store = open(base, { fsImpl: f.fs });
  let st = store.getGlobalStatus();
  assert.equal(st.queueStoreRecoveryRequired, true);
  assert.equal(st.saveBlocked, "leftover-tmp-in-place");
  const before = bytesOf(base);
  const reset = store.acknowledgeReset("RESET");
  assert.equal(reset.ok, false);
  assert.equal(reset.code, "queue_store_save_blocked");
  assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true, "the refused reset reset nothing");
  assert.equal(store.applyObserved("p_new", toIdle).persisted, false);
  assert.deepEqual(bytesOf(base), before);
  assert.equal(wroteTmp(f.calls), false);
  on = false;
  // "Retry save" (the button, or the retry timer) must not turn the empty
  // placeholder into a valid queue file: only an acknowledged reset may.
  assert.equal(store.retrySave().ok, false);
  assert.equal(fs.existsSync(P(base)), false, "no queue file was written while recovery is required");
  assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true);
  assert.equal(listing(base).filter(n => n.includes(".corrupt-")).length, 2, "both corrupt files are still kept");
  assert.equal(store.acknowledgeReset("RESET").ok, true);
  st = store.getGlobalStatus();
  assert.equal(st.queueStoreRecoveryRequired, false);
  assert.equal(st.saveBlocked, null);
  const kept = listing(base).filter(isLeftover);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(base, "data", kept[0]), "utf8"), text(GEN3));
});

// Every step of the recovery save failing in turn: the primary's name never
// goes missing, the backup is never written, and both this version and the
// previous reader still load the backup's generation.
const RECOVERY_STEPS = [
  ["copying the bad primary aside", (op, n) => op === "copy" && isCorruptCopy(n) && err("ENOSPC")],
  ["flushing that copy", (op, n) => op === "fsync" && isCorruptCopy(n) && err("EIO")],
  ["writing the temporary file", (op, n) => op === "write" && n === NAME.t && err("EIO")],
  ["flushing the temporary file", (op, n) => op === "fsync" && n === NAME.t && err("EIO")],
  ["renaming over the bad primary", (op, n, to) => op === "rename" && n === NAME.t && to === NAME.p && err("ENOSPC")],
];
for (const [what, rule] of RECOVERY_STEPS) {
  test(`recovery from the backup fails at: ${what} — blocked, backup intact, no missing primary, and the next start-up recovers`, t => {
    quiet(t);
    const base = tmpBase();
    seed(base, { [NAME.p]: CONTENT.garbage, [NAME.b]: text(GEN1), [NAME.t]: text(GEN3) });
    const f = faultyFs((op, n, to) => rule(op, n, to) || undefined);
    const store = open(base, { fsImpl: f.fs });
    const st = store.getGlobalStatus();
    assert.equal(st.saveBlocked, "corrupt-primary-in-place");
    assert.equal(st.storeDegraded, true);
    assert.deepEqual(view(store), viewOf(GEN1));
    assert.equal(fs.readFileSync(P(base), "utf8"), CONTENT.garbage, "the primary's name still holds the bad file — it never went missing");
    assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN1));
    assert.equal(f.calls.includes("copy " + NAME.b), false);
    assert.equal(listing(base).filter(n => n.startsWith(NAME.t + ".leftover-")).length, 1, "the unfinished save found at start-up was kept");
    assert.deepEqual(viewOf(legacyRead(base).store), viewOf(GEN1), "the previous reader loads the backup here (rollback is safe)");
    assert.equal(store.applyIntent("p_new", toIdle).reason, "store-degraded");

    const again = open(base);                 // a restart without the fault
    assert.deepEqual(view(again), viewOf(GEN1));
    assert.equal(again.getGlobalStatus().saveBlocked, null);
    assert.equal(again.getGlobalStatus().storeDegraded, false);
    assert.equal(fs.readFileSync(P(base), "utf8"), text(GEN1));
    assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN1));
    assert.ok(listing(base).filter(isCorruptCopy).length >= 1, "the bad file's bytes are kept");
    assert.notDeepEqual(view(again), viewOf(GEN3), "never the unfinished save");
  });
}

test("a file held for a moment (EBUSY/EPERM/EACCES) at start-up or at any new step of a save is retried, not treated as unreadable or failed", t => {
  quiet(t);
  for (const [op, name] of [["read", NAME.p], ["open", NAME.t], ["fsync", NAME.t], ["copy", NAME.b], ["fsync", NAME.b]]) for (const code of ["EBUSY", "EPERM", "EACCES"]) {
    const base = tmpBase();
    seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
    let left = 2; const slept = [];
    const f = faultyFs((o, n) => o === op && n === name && left > 0 ? (left--, err(code)) : undefined);
    const store = open(base, { fsImpl: f.fs, retry: { sleep: ms => slept.push(ms) } });
    const label = `${code} on ${op} ${name}`;
    assert.equal(store.getGlobalStatus().saveBlocked, null, label);
    assert.deepEqual(view(store), viewOf(GEN2), label);
    assert.equal(store.applyIntent("p_new", toIdle).ok, true, label);
    assert.deepEqual(slept, [10, 25], label + ": bounded backoff");
    assert.equal(open(base).getPrinterState("p_new").queueState, "idle", label);
  }
});

test("a backup that is torn or empty while the primary is intact changes nothing: the primary loads, and the next save writes a full backup", t => {
  quiet(t);
  for (const bak of [text(GEN1).slice(0, 100), "", CONTENT.zero]) {
    const base = tmpBase();
    seed(base, { [NAME.p]: text(GEN2), [NAME.b]: bak });
    const store = open(base);
    assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, false);
    assert.deepEqual(view(store), viewOf(GEN2));
    assert.equal(store.applyIntent("p_new", toIdle).ok, true);
    assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN2));
  }
});

// --------------------------------------------------------------- compatibility

test("an existing valid store loads unchanged, is rewritten in the same format, and the status keeps its existing fields", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: SAMPLE_TEXT });
  const store = open(base);
  assert.deepEqual(view(store), viewOf(SAMPLE));
  assert.equal(store.applyBulkIntent(() => ({})).ok, true);
  assert.equal(fs.readFileSync(P(base), "utf8"), SAMPLE_TEXT, "same bytes: the format did not change");
  assert.equal(fs.readFileSync(B(base), "utf8"), SAMPLE_TEXT);
  assert.deepEqual(listing(base), [NAME.p, NAME.b], "no other file is left behind");
  const st = store.getGlobalStatus();
  assert.deepEqual({ storeDegraded: st.storeDegraded, storeStoppedByAdmin: st.storeStoppedByAdmin, queueStoreRecoveryRequired: st.queueStoreRecoveryRequired, corruptFilePaths: st.corruptFilePaths },
    { storeDegraded: false, storeStoppedByAdmin: false, queueStoreRecoveryRequired: false, corruptFilePaths: [] });
  assert.equal(st.saveBlocked, null);
  assert.deepEqual(legacyRead(base).store, SAMPLE);
});

// ------------------------------------------------- simulated crash (a MODEL)

// Runs one save on the model, stopping after its n-th filesystem operation,
// and returns what the model says is on disk afterwards.
function crashDuringSave(prepare, mutate, n, mode) {
  const m = createCrashModelFs();
  const base = "/model";
  const store = createQueueStore({ baseDir: base, fsImpl: m.fs, degradedRetryMs: 3600000 });
  prepare(m, base);
  m.syncAll();                                 // the starting point is durable
  store.load();
  m.syncAll();
  const from = m.log.length;
  if (n !== null) m.crashAfterOp(n);
  let result;
  try { result = mutate(store); } catch (e) { if (!(e instanceof CrashSignal)) throw e; }
  return { ops: m.log.slice(from), files: m.afterCrash(mode), crashed: m.crashed, result };
}
function materialize(files) {
  const base = tmpBase();
  fs.mkdirSync(path.join(base, "data"), { recursive: true });
  for (const [p, buf] of Object.entries(files)) fs.writeFileSync(path.join(base, "data", path.basename(p)), buf);
  return base;
}
const MODES = [];
for (const names of ["names-current", "names-durable"]) for (const lost of ["zero", "empty"]) MODES.push({ names, lost });
const put = (m, base, name, content) => { m.fs.mkdirSync(path.join(base, "data")); m.fs.writeFileSync(path.join(base, "data", name), content); };

test("MODEL: a stop after any step of a save leaves the previous or the new generation loadable (given a durable generation to start from)", t => {
  quiet(t);
  const prepare = (m, base) => { put(m, base, NAME.p, text(GEN2)); put(m, base, NAME.b, text(GEN1)); };
  const mutate = store => store.applyIntent("p_new", toIdle);
  const total = crashDuringSave(prepare, mutate, null, MODES[0]).ops.length;
  assert.equal(total, 7, "write, flush, copy, flush, rename, folder flush (plus the open): " + total);
  let checked = 0;
  for (let n = 1; n <= total; n++) for (const mode of MODES) {
    const { files, ops } = crashDuringSave(prepare, mutate, n, mode);
    const label = `stop after step ${n} (${ops[ops.length - 1]}), ${mode.names}, lost content ${mode.lost}`;
    const base = materialize(files);
    const store = open(base);
    const st = store.getGlobalStatus();
    assert.equal(st.queueStoreRecoveryRequired, false, label);
    assert.equal(st.saveBlocked, null, label);
    const v = view(store);
    const isOld = JSON.stringify(v) === JSON.stringify(viewOf(GEN2));
    const isNew = v.p_new.queueState === "idle" && JSON.stringify({ ...v, p_new: 0 }) === JSON.stringify({ ...viewOf(GEN2), p_new: 0 });
    assert.ok(isOld || isNew, label + ": a complete generation, the one before or the one being saved");
    // Once the primary has been replaced, the backup must be the generation
    // it replaced, complete — this is what the backup flush is for.
    if (ops.includes("rename " + NAME.p) && mode.names === "names-current") {
      assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN2), label + ": the backup is the previous generation");
    }
    assert.equal(store.applyIntent("p_sample0003", toIdle).ok, true, label + ": and the store can save again");
    assert.equal(open(base).getPrinterState("p_sample0003").queueState, "idle", label);
    checked++;
  }
  assert.equal(checked, total * MODES.length);
});

test("MODEL: a stop during the very first save comes back as a first run or with the new data — there is no earlier generation to fall back on", t => {
  quiet(t);
  const prepare = (m, base) => { m.fs.mkdirSync(path.join(base, "data")); };
  const mutate = store => store.applyIntent("p_new", toIdle);
  const total = crashDuringSave(prepare, mutate, null, MODES[0]).ops.length;
  for (let n = 1; n <= total; n++) for (const mode of MODES) {
    const { files, ops } = crashDuringSave(prepare, mutate, n, mode);
    const label = `stop after step ${n} (${ops[ops.length - 1]}), ${mode.names}, lost content ${mode.lost}`;
    const base = materialize(files);
    const store = open(base);
    assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, false, label);
    assert.equal(store.getGlobalStatus().saveBlocked, null, label);
    assert.ok(["unmanaged", "idle"].includes(store.getPrinterState("p_new").queueState), label);
    assert.equal(store.applyIntent("p_new", toIdle).ok, true, label);
    assert.equal(open(base).getPrinterState("p_new").queueState, "idle", label);
  }
});

test("MODEL: a stop during the recovery itself (bad primary, good backup) never loses the backup's generation", t => {
  quiet(t);
  const run = n => {
    const m = createCrashModelFs(), base = "/model";
    put(m, base, NAME.p, CONTENT.zero); put(m, base, NAME.b, text(GEN1));
    m.syncAll();
    if (n !== null) m.crashAfterOp(n);
    const store = createQueueStore({ baseDir: base, fsImpl: m.fs, degradedRetryMs: 3600000 });
    try { store.load(); } catch (e) { if (!(e instanceof CrashSignal)) throw e; }
    return m;
  };
  const total = run(null).log.length - 2;      // minus the two seeding writes
  assert.ok(total >= 5);
  for (let n = 1; n <= total; n++) for (const mode of MODES) {
    const base = materialize(run(n).afterCrash(mode));
    const store = open(base);
    const label = `stop after recovery step ${n}, ${mode.names}, lost content ${mode.lost}`;
    assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, false, label);
    assert.deepEqual(view(store), viewOf(GEN1), label);
  }
});

// ------------------------------------------- recovery that outlives a restart
// "Both queue files are bad" moves them aside. Without something left behind,
// the next start-up would find no queue files and call it a first run.
NAME.m = NAME.p + ".recovery-required";
const M = base => path.join(base, "data", NAME.m);
const bothBad = () => ({ [NAME.p]: CONTENT.zero, [NAME.b]: CONTENT.garbage });
const isBeforeReset = n => n.includes(".before-reset-");
const EMPTY_VIEW = viewOf({});

test("both queue files bad: a marker is written and flushed before either file is moved, and every later start-up is still recovery-required until an admin resets", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, bothBad());
  const f = faultyFs(() => undefined);
  const store = open(base, { fsImpl: f.fs });
  assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true);
  assert.equal(store.getGlobalStatus().recoveryCarriedOver, false);
  const at = c => f.calls.indexOf(c), firstMove = f.calls.findIndex(c => c === "rename " + NAME.p || c === "rename " + NAME.b);
  assert.ok(at("fsync " + NAME.m) > -1 && at("fsync " + NAME.m) < at("fsync " + NAME.d), "marker flushed, then its folder");
  assert.ok(at("fsync " + NAME.d) < firstMove, "both before the first file is moved");
  assert.deepEqual(JSON.parse(fs.readFileSync(M(base), "utf8")).files.sort(), listing(base).filter(n => n.includes(".corrupt-")));
  // An older SnapCon does not know the marker: after a rollback this folder is a first run to it.
  assert.deepEqual(legacyRead(base), { store: {} });

  const before = bytesOf(base);
  for (let i = 0; i < 2; i++) {
    const again = open(base);
    const st = again.getGlobalStatus();
    assert.equal(st.queueStoreRecoveryRequired, true, "restart " + (i + 1) + " is not a first run");
    assert.equal(st.recoveryCarriedOver, true);
    assert.equal(st.corruptFilePaths.length, 2, "the kept files are still offered");
    assert.deepEqual(view(again), EMPTY_VIEW);
    assert.equal(again.applyIntent("p_new", toIdle).reason, "recovery-required");
    assert.equal(again.applyObserved("p_new", toIdle).persisted, false);
    assert.equal(again.retrySave().ok, false);
    assert.deepEqual(bytesOf(base), before, "nothing was written or moved");
  }

  const last = open(base);
  assert.equal(last.acknowledgeReset("RESET").ok, true);
  assert.deepEqual([last.getGlobalStatus().queueStoreRecoveryRequired, last.getGlobalStatus().recoveryCarriedOver], [false, false], "cleared in the running store, not only after a restart");
  assert.equal(fs.existsSync(M(base)), false, "the marker goes with the reset");
  assert.equal(fs.readFileSync(P(base), "utf8"), "{}");
  assert.equal(listing(base).filter(n => n.includes(".corrupt-")).length, 2, "the bad files are still kept");
  const after = open(base);
  assert.equal(after.getGlobalStatus().queueStoreRecoveryRequired, false);
  assert.equal(after.applyIntent("p_new", toIdle).ok, true);
});

for (const [what, rule, markerLeft] of [
  ["created", (op, n) => op === "open" && n === NAME.m && err("EROFS"), false],
  ["flushed", (op, n) => op === "fsync" && n === NAME.m && err("EIO"), true],
  ["made durable in its folder", (op, n) => op === "fsync" && n === NAME.d && err("EIO"), true],
]) {
  test(`both queue files bad and the marker cannot be ${what}: neither file is moved, so a restart finds the same evidence and requires recovery again`, t => {
    quiet(t);
    const base = tmpBase();
    seed(base, bothBad());
    const f = faultyFs((op, n) => rule(op, n) || undefined);
    const store = open(base, { fsImpl: f.fs });
    assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true);
    assert.equal(f.calls.some(c => c === "rename " + NAME.p || c === "rename " + NAME.b), false, "neither file was moved");
    assert.deepEqual(fs.readFileSync(P(base)), CONTENT.zero);
    assert.equal(fs.readFileSync(B(base), "utf8"), CONTENT.garbage);
    assert.equal(fs.existsSync(M(base)), markerLeft);

    const again = open(base);                  // restart, fault gone
    assert.equal(again.getGlobalStatus().queueStoreRecoveryRequired, true);
    assert.equal(again.getGlobalStatus().recoveryCarriedOver, markerLeft);
    assert.equal(again.acknowledgeReset("RESET").ok, true);
    const kept = listing(base).filter(n => n.includes(".corrupt-") || isBeforeReset(n)).map(n => fs.readFileSync(path.join(base, "data", n)).toString("hex")).sort();
    assert.deepEqual(kept, [CONTENT.zero.toString("hex"), Buffer.from(CONTENT.garbage).toString("hex")].sort(), "both bad files' bytes are kept through the reset");
    assert.equal(fs.readFileSync(P(base), "utf8"), "{}");
  });
}

test("a marker that cannot be read or understood still means recovery is required; names in it that are not this store's files are ignored", t => {
  quiet(t);
  for (const content of ["{{{", "", "null", JSON.stringify({ format: 1, files: ["../../config.json", "/etc/passwd", "users.json", 7, "queue-data.json.corrupt-1"] })]) {
    const base = tmpBase();
    seed(base, { [NAME.m]: content });
    const store = open(base);
    const st = store.getGlobalStatus();
    assert.equal(st.queueStoreRecoveryRequired, true, JSON.stringify(content));
    assert.deepEqual(st.corruptFilePaths, [], "nothing outside the store's own kept files, and nothing that is not there");
    assert.deepEqual(listing(base), [NAME.m]);
  }
  const base = tmpBase();
  seed(base, { [NAME.m]: "{}" });
  const f = faultyFs((op, n) => op === "read" && n === NAME.m ? err("EIO") : undefined);
  assert.equal(open(base, { fsImpl: f.fs }).getGlobalStatus().queueStoreRecoveryRequired, true, "present but unreadable");
});

test("carried-over recovery with queue files in place now: they are not loaded and not touched, and a reset moves them aside instead of writing over them", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.m]: JSON.stringify({ format: 1, files: [] }), [NAME.p]: text(GEN2), [NAME.b]: text(GEN1), [NAME.t]: text(GEN3) });
  const f = faultyFs(() => undefined);
  const store = open(base, { fsImpl: f.fs });
  assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true);
  assert.deepEqual(view(store), EMPTY_VIEW, "a queue file that appeared since is not taken into use");
  assert.equal(fs.readFileSync(P(base), "utf8"), text(GEN2));
  assert.equal(fs.readFileSync(B(base), "utf8"), text(GEN1));
  assert.equal(store.applyObserved("p_new", toIdle).persisted, false);
  assert.equal(wroteTmp(f.calls), false);

  assert.equal(store.acknowledgeReset("RESET").ok, true);
  const kept = Object.fromEntries(listing(base).filter(isBeforeReset).map(n => [n.replace(/\.before-reset-.*/, ""), fs.readFileSync(path.join(base, "data", n), "utf8")]));
  assert.deepEqual(kept, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
  assert.equal(fs.readFileSync(P(base), "utf8"), "{}");
  assert.equal(fs.existsSync(B(base)), false);
  assert.equal(listing(base).filter(isLeftover).length, 1);
  assert.equal(store.getGlobalStatus().setAsidePaths.length, 3);
});

test("carried-over recovery with a queue file that cannot be read: a reset is refused, as for any unreadable file", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.m]: "{}", [NAME.p]: text(GEN2) });
  const f = faultyFs((op, n) => op === "read" && n === NAME.p ? err("EIO") : undefined);
  const store = open(base, { fsImpl: f.fs });
  const st = store.getGlobalStatus();
  assert.equal(st.queueStoreRecoveryRequired, true);
  assert.equal(st.saveBlocked, "unreadable");
  const before = bytesOf(base);
  assert.equal(store.acknowledgeReset("RESET").code, "queue_store_save_blocked");
  assert.deepEqual(bytesOf(base), before);
});

// ------------------------------------------------ recovery required: no saves
test("while recovery is required nothing is saved by any route into the store: observed events are kept in memory only and are not a save failure", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, bothBad());
  const f = faultyFs(() => undefined);
  const store = open(base, { fsImpl: f.fs });
  const before = bytesOf(base), callsBefore = f.calls.length;
  const obs = store.applyObserved("p_new", toIdle);
  assert.deepEqual([obs.ok, obs.persisted, obs.nextState.queueState], [true, false, "idle"]);
  assert.equal(store.getPrinterState("p_new").queueState, "idle", "the event is still recorded in memory");
  assert.equal(store.setReconciliationPending("p_new", true).persisted, false);
  assert.equal(store.applyIntent("p_new", toIdle).reason, "recovery-required");
  assert.equal(store.applyBulkIntent(() => ({ p_new: toIdle({}) })).reason, "recovery-required");
  assert.equal(store.claimNextForDispatch("p_new").reason, "recovery-required");
  assert.equal(store.confirmManualBedClear("p_new", "x").reason, "recovery-required");
  for (const r of [store.assignPool("p_new"), store.unassignPool("p_new"), store.assignPoolMany(["p_new"]), store.unassignPoolMany(["p_new"])]) assert.equal(r.reason, "recovery-required");
  const retry = store.retrySave();
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, "QUEUE_RECOVERY_REQUIRED");
  assert.deepEqual(bytesOf(base), before);
  assert.deepEqual(f.calls.slice(callsBefore).filter(c => !c.startsWith("rename " + NAME.t)), [], "no file was opened, written, copied or renamed");
  assert.equal(store.getGlobalStatus().storeDegraded, false, "not reported as a failing save, and no retry timer");
});

// ------------------------------------------ a reset never writes over evidence
test("a reset never writes over a queue file it cannot move aside, and is not complete while the marker cannot be removed: no success, recovery still required; it works once both can be done", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, bothBad());
  let stuck = "primary";
  const f = faultyFs((op, n) => (stuck === "primary" && op === "rename" && n === NAME.p) || (stuck === "marker" && op === "unlink" && n === NAME.m) ? err("EIO") : undefined);
  const store = open(base, { fsImpl: f.fs });
  assert.deepEqual(fs.readFileSync(P(base)), CONTENT.zero, "the primary could not be moved at start-up and is still in place");
  for (const phase of ["primary", "marker"]) {
    stuck = phase;
    const before = phase === "primary" ? bytesOf(base) : null;
    const r = store.acknowledgeReset("RESET");
    assert.equal(r.ok, false, phase);
    assert.equal(r.code, "queue_reset_incomplete");
    assert.equal(/[\\/]/.test(r.error), false, "no server path in the message");
    assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true);
    assert.equal(fs.existsSync(M(base)), true);
    if (before) {
      assert.equal(wroteTmp(f.calls), false, "no save was attempted while a queue file was still in the way");
      assert.deepEqual(bytesOf(base), before);
    } else {
      // The marker is removed last: the empty queue file is already there, and the marker still says "not finished".
      assert.equal(fs.readFileSync(P(base), "utf8"), "{}");
      assert.equal(open(base).getGlobalStatus().queueStoreRecoveryRequired, true, "a restart is still recovery-required");
    }
  }
  stuck = null;
  assert.equal(store.acknowledgeReset("RESET").ok, true);
  assert.equal(store.getGlobalStatus().recoveryCarriedOver, false);
  const kept = listing(base).filter(n => n.startsWith(NAME.p + ".before-reset-")).map(n => fs.readFileSync(path.join(base, "data", n)).toString("hex")).sort();
  assert.deepEqual(kept, [CONTENT.zero.toString("hex"), Buffer.from("{}").toString("hex")].sort(), "the bad primary, and the empty file of the unfinished attempt — nothing written over");
  assert.equal(open(base).getGlobalStatus().queueStoreRecoveryRequired, false);
});

test("an ordinary reset (no recovery pending) keeps the current queue file and backup under other names instead of writing over them", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
  const store = open(base);
  assert.equal(store.acknowledgeReset("RESET").ok, true);
  const kept = listing(base).filter(isBeforeReset).map(n => fs.readFileSync(path.join(base, "data", n), "utf8")).sort();
  assert.deepEqual(kept, [text(GEN1), text(GEN2)].sort());
  assert.equal(fs.existsSync(M(base)), false, "the marker a reset works under is gone once it has finished");
  assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, false);
  assert.deepEqual(view(open(base)), EMPTY_VIEW, "a restart does not bring the old queue back from a backup");
});

test("a file moved or copied aside never lands on one kept earlier under the same name", t => {
  quiet(t);
  const NOW = 1760000000000;
  t.mock.method(Date, "now", () => NOW);
  const base = tmpBase();
  seed(base, { ...bothBad(), [NAME.t]: text(GEN3), [NAME.p + ".corrupt-" + NOW]: "kept earlier", [NAME.b + ".corrupt-" + NOW]: "kept earlier (backup)", [NAME.t + ".leftover-" + NOW]: "kept earlier too" });
  open(base);
  assert.equal(fs.readFileSync(B(base) + ".corrupt-" + NOW, "utf8"), "kept earlier (backup)");
  assert.equal(fs.readFileSync(B(base) + ".corrupt-" + NOW + "-1", "utf8"), CONTENT.garbage);
  assert.equal(fs.readFileSync(P(base) + ".corrupt-" + NOW, "utf8"), "kept earlier");
  assert.equal(fs.readFileSync(T(base) + ".leftover-" + NOW, "utf8"), "kept earlier too");
  assert.deepEqual(fs.readFileSync(P(base) + ".corrupt-" + NOW + "-1"), CONTENT.zero);
  assert.equal(fs.readFileSync(T(base) + ".leftover-" + NOW + "-1", "utf8"), text(GEN3));

  const base2 = tmpBase();                     // the copy kept by the recovery save
  seed(base2, { [NAME.p]: CONTENT.garbage, [NAME.b]: text(GEN1), [NAME.p + ".corrupt-" + NOW]: "kept earlier" });
  open(base2);
  assert.equal(fs.readFileSync(P(base2) + ".corrupt-" + NOW, "utf8"), "kept earlier");
  assert.equal(fs.readFileSync(P(base2) + ".corrupt-" + NOW + "-1", "utf8"), CONTENT.garbage);
});

test("a reset's own moves never land on a file kept by an earlier reset", t => {
  quiet(t);
  const NOW = 1760000000000;
  t.mock.method(Date, "now", () => NOW);
  const base = tmpBase();
  seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1), [NAME.p + ".before-reset-" + NOW]: "earlier reset", [NAME.b + ".before-reset-" + NOW]: "earlier reset (backup)" });
  assert.equal(open(base).acknowledgeReset("RESET").ok, true);
  assert.equal(fs.readFileSync(P(base) + ".before-reset-" + NOW, "utf8"), "earlier reset");
  assert.equal(fs.readFileSync(B(base) + ".before-reset-" + NOW, "utf8"), "earlier reset (backup)");
  assert.equal(fs.readFileSync(P(base) + ".before-reset-" + NOW + "-1", "utf8"), text(GEN2));
  assert.equal(fs.readFileSync(B(base) + ".before-reset-" + NOW + "-1", "utf8"), text(GEN1));
});

test("an ordinary reset that cannot finish its moves does not answer success and never brings an older generation back: recovery is required, now and after a restart, with both files' bytes kept", t => {
  quiet(t);
  for (const stuckName of [NAME.b, NAME.p]) {
    const base = tmpBase();
    seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
    let stuck = true;
    const f = faultyFs((op, n) => stuck && op === "rename" && n === stuckName ? err("EIO") : undefined);
    const store = open(base, { fsImpl: f.fs });
    const r = store.acknowledgeReset("RESET");
    assert.deepEqual([r.ok, r.code], [false, "queue_reset_incomplete"], stuckName);
    assert.equal(wroteTmp(f.calls), false, "nothing was saved");
    const have = Object.values(bytesOf(base));
    for (const gen of [GEN1, GEN2]) assert.ok(have.includes(Buffer.from(text(gen)).toString("hex")), "bytes kept");
    for (const s2 of [store, open(base)]) {
      assert.equal(s2.getGlobalStatus().queueStoreRecoveryRequired, true, stuckName);
      assert.deepEqual(view(s2), EMPTY_VIEW, "neither the queue being reset nor the backup's older one is live");
    }
    stuck = false;
    assert.equal(store.acknowledgeReset("RESET").ok, true);
    assert.deepEqual(view(open(base)), EMPTY_VIEW);
    assert.equal(open(base).getGlobalStatus().queueStoreRecoveryRequired, false);
  }
});

// -------------------------------------------- a reset is durable step by step
test("a reset makes each step durable before the next: the marker, then the moves, then the empty queue file — and only then removes the marker", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
  const f = faultyFs(() => undefined);
  const store = open(base, { fsImpl: f.fs });
  f.calls.splice(0);
  assert.equal(store.acknowledgeReset("RESET").ok, true);
  const c = f.calls, at = x => c.indexOf(x), flushes = c.map((x, i) => x === "fsync " + NAME.d ? i : -1).filter(i => i >= 0);
  assert.equal(flushes.length, 4, "one folder flush per step: " + c.join(", "));
  assert.ok(at("fsync " + NAME.m) > -1 && at("fsync " + NAME.m) < flushes[0], "marker written and flushed, then its folder");
  assert.ok(flushes[0] < at("rename " + NAME.b) && at("rename " + NAME.b) < at("rename " + NAME.p), "then the backup is moved, then the primary");
  assert.ok(at("rename " + NAME.p) < flushes[1] && flushes[1] < at("open " + NAME.t), "the moves are durable before the empty queue file is written");
  assert.ok(at("rename " + NAME.t) < flushes[2] && flushes[2] < at("unlink " + NAME.m), "the empty queue file is durable before the marker is removed");
  assert.ok(at("unlink " + NAME.m) < flushes[3] && flushes[3] === c.lastIndexOf("fsync " + NAME.d), "and the marker's removal is flushed last");

  // A marker that is already there may not be durable yet (an earlier attempt's folder flush failed): the folder
  // is flushed before anything is moved in that case too.
  const base2 = tmpBase();
  seed(base2, { [NAME.m]: "{}", [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
  const f2 = faultyFs(() => undefined);
  const store2 = open(base2, { fsImpl: f2.fs });
  f2.calls.splice(0);
  assert.equal(store2.acknowledgeReset("RESET").ok, true);
  assert.equal(f2.calls.includes("open " + NAME.m), false, "the marker is not rewritten");
  assert.ok(f2.calls.indexOf("fsync " + NAME.d) > -1 && f2.calls.indexOf("fsync " + NAME.d) < f2.calls.indexOf("rename " + NAME.b), "folder flushed before the first move: " + f2.calls.join(", "));
});

test("an ordinary reset whose marker was written but could not be made durable: the marker is left in place, recovery is required, and the answer does not say 'nothing was changed'", t => {
  quiet(t);
  for (const rule of [(op, n) => op === "fsync" && n === NAME.m, (op, n) => op === "fsync" && n === NAME.d]) {
    const base = tmpBase();
    seed(base, { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) });
    let failing = true;
    const f = faultyFs((op, n) => failing && rule(op, n) ? err("EIO") : undefined);
    const store = open(base, { fsImpl: f.fs });
    const r = store.acknowledgeReset("RESET");
    assert.deepEqual([r.ok, r.code], [false, "queue_reset_incomplete"]);
    assert.doesNotMatch(r.error, /nothing was changed/);
    assert.match(r.error, /after a restart the queue may be back as it was/);
    assert.equal(fs.existsSync(M(base)), true, "not removed again: that would be one more unflushed change");
    assert.equal(f.calls.includes("unlink " + NAME.m), false);
    assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true);
    assert.equal(fs.readFileSync(P(base), "utf8"), text(GEN2), "the queue file was not touched");
  }
});

test("a successful reset clears a failing-save state left from before it", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: text(GEN2) });
  let failing = true;
  const f = faultyFs((op, n) => failing && op === "open" && n === NAME.t ? err("EIO") : undefined);
  const store = open(base, { fsImpl: f.fs });
  store.applyObserved("p_new", toIdle);
  assert.equal(store.getGlobalStatus().storeDegraded, true);
  failing = false;
  assert.equal(store.acknowledgeReset("RESET").ok, true);
  assert.equal(store.getGlobalStatus().storeDegraded, false);
});

test("a queue file that cannot be read is what the status names, also when an unfinished save cannot be moved aside as well (a reset is refused for the unreadable file first)", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.m]: "{}", [NAME.p]: text(GEN2), [NAME.t]: text(GEN3) });
  const f = faultyFs((op, n) => (op === "read" && n === NAME.p) || (op === "rename" && n === NAME.t) ? err("EACCES") : undefined);
  const store = open(base, { fsImpl: f.fs, retry: { delays: [] } });
  const st = store.getGlobalStatus();
  assert.deepEqual([st.saveBlocked, st.saveBlockedDetail], ["unreadable", "queue-data.json could not be read (EACCES)"]);
  assert.match(store.acknowledgeReset("RESET").error, /could not be read/);
});

test("a reset whose final save fails does not answer success: recovery stays required, the marker stays, every file is kept, and nothing saves an empty queue later by itself", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, bothBad());
  let failing = true;
  const f = faultyFs((op, n) => failing && op === "write" && n === NAME.t ? err("ENOSPC") : undefined);
  const store = open(base, { fsImpl: f.fs });
  const evidence = listing(base).filter(n => n.includes(".corrupt-")).map(n => fs.readFileSync(path.join(base, "data", n)).toString("hex"));
  const r = store.acknowledgeReset("RESET");
  assert.deepEqual([r.ok, r.code], [false, "queue_reset_incomplete"]);
  assert.match(r.error, /ENOSPC/);
  assert.equal(/[\\/]/.test(r.error), false, "no server path in the message");
  const st = store.getGlobalStatus();
  assert.deepEqual([st.queueStoreRecoveryRequired, st.storeDegraded], [true, false], "recovery, not a save that a timer retries");
  assert.equal(fs.existsSync(M(base)), true);
  assert.equal(fs.existsSync(P(base)), false, "no queue file was put in place");
  assert.equal(store.retrySave().ok, false);
  assert.equal(store.applyIntent("p_new", toIdle).reason, "recovery-required");
  const have = Object.values(bytesOf(base));
  for (const e of evidence) assert.ok(have.includes(e));
  assert.equal(open(base).getGlobalStatus().queueStoreRecoveryRequired, true, "and after a restart");
  failing = false;
  assert.equal(store.acknowledgeReset("RESET").ok, true);
  assert.equal(fs.readFileSync(P(base), "utf8"), "{}");
});

const FAILABLE = /^(open|write|fsync|rename|unlink) /;
for (const [what, files, recovery] of [
  ["an ordinary reset", () => ({ [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) }), false],
  ["recovery with the bad files moved aside", () => bothBad(), true],
  ["carried-over recovery with valid queue files in place", () => ({ [NAME.m]: "{}", [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) }), true],
]) {
  test(`${what}, failing at each single filesystem call in turn: never a success answer, never an old queue live (now or after a restart), every file's bytes kept, and the reset completes once the fault is gone`, t => {
    quiet(t);
    const start = rule => { const base = tmpBase(); seed(base, files()); const f = faultyFs(rule); return { base, f, store: open(base, { fsImpl: f.fs }) }; };
    const clean = start(() => undefined);
    clean.f.calls.splice(0);
    assert.equal(clean.store.acknowledgeReset("RESET").ok, true);
    const count = clean.f.calls.filter(c => FAILABLE.test(c)).length;
    assert.ok(count >= 12, "calls in a reset: " + count);
    let refusedUntouched = 0;
    for (let k = 0; k < count; k++) {
      let armed = false, seen = -1, failed = null;
      const { base, store } = start((op, n) => { if (!armed || !FAILABLE.test(op + " ")) return undefined; if (++seen === k) { failed = op + " " + n; return err("EIO"); } return undefined; });
      const evidence = Object.entries(bytesOf(base)).filter(([n]) => n !== NAME.m).map(([, hex]) => hex);
      armed = true;
      const r = store.acknowledgeReset("RESET");
      armed = false;
      const label = `call ${k + 1} of ${count} (${failed})`;
      assert.equal(r.ok, false, label);
      assert.equal(/[\\/]/.test(r.error), false, label + ": no server path in the message");
      const kept = () => { const have = Object.values(bytesOf(base)); for (const e of evidence) assert.ok(have.includes(e), label + ": bytes kept"); };
      kept();
      if (!store.getGlobalStatus().queueStoreRecoveryRequired) {
        // Refused with nothing changed: possible only for an ordinary reset whose marker file was never created.
        assert.match(failed, /^open /, label + ": once the marker file exists, 'nothing was changed' is no longer answered");
        refusedUntouched++;
        assert.equal(recovery, false, label);
        assert.equal(r.code, "queue_store_save_blocked", label);
        assert.equal(fs.existsSync(M(base)), false, label + ": no marker left behind");
        assert.deepEqual(view(store), viewOf(GEN2), label);
        assert.deepEqual(view(open(base)), viewOf(GEN2), label + ": a restart loads the current queue, as if no reset had been asked for");
      } else {
        assert.equal(r.code, "queue_reset_incomplete", label);
        assert.deepEqual(view(store), EMPTY_VIEW, label);
        assert.equal(store.applyIntent("p_new", toIdle).reason, "recovery-required", label);
        assert.deepEqual(view(open(base)), EMPTY_VIEW, label + ": a restart never has an old queue");
      }
      assert.equal(store.acknowledgeReset("RESET").ok, true, label + ": completes once the fault is gone");
      const after = open(base);
      assert.equal(after.getGlobalStatus().queueStoreRecoveryRequired, false, label);
      assert.deepEqual(view(after), EMPTY_VIEW, label);
      kept();
      fs.rmSync(base, { recursive: true, force: true });
    }
    assert.equal(refusedUntouched > 0, !recovery, "an ordinary reset can still be refused untouched; a recovery reset cannot be 'untouched'");
  });
}

// The same three sequences on the crash MODEL (see crashModelFs.js for what
// that is and is not): a stop after every filesystem operation.
const hexSet = base => new Set(listing(base).map(n => fs.readFileSync(path.join(base, "data", n)).toString("hex")));
function sweep(prepare, act) {
  const run = n => {
    const m = createCrashModelFs(), base = "/model";
    m.fs.mkdirSync(path.join(base, "data"));
    prepare((name, content) => m.fs.writeFileSync(path.join(base, "data", name), content));
    m.syncAll();
    const store = createQueueStore({ baseDir: base, fsImpl: m.fs, degradedRetryMs: 3600000 });
    const from = act.afterLoad ? (store.load(), m.syncAll(), m.log.length) : m.log.length;
    if (n !== null) m.crashAfterOp(n);
    let result;
    try { result = act.afterLoad ? act.afterLoad(store) : store.load(); } catch (e) { if (!(e instanceof CrashSignal)) throw e; }
    return { m, log: m.log.slice(from), result };
  };
  const clean = run(null), total = clean.log.length, out = [];
  for (let n = 1; n <= total; n++) {
    const m = run(n).m;
    for (const mode of MODES) out.push({ n, label: `stop after operation ${n} of ${total}, ${mode.names}, lost content ${mode.lost}`, files: m.afterCrash(mode) });
    // Storage that does not keep name changes in order: every subset of those not yet flushed.
    for (let mask = 0; mask < (1 << m.pendingNameOps); mask++) for (const lost of ["zero", "empty"])
      out.push({ n, label: `stop after operation ${n} of ${total}, unflushed name changes kept: ${mask.toString(2).padStart(m.pendingNameOps, "0") || "none pending"}, lost content ${lost}`, files: m.afterCrash({ names: "names-subset", mask, lost }) });
  }
  // The call returned: whatever a stop keeps from here on.
  const done = [];
  for (const mode of MODES) done.push({ label: `after the call returned, ${mode.names}, lost content ${mode.lost}`, files: clean.m.afterCrash(mode) });
  for (let mask = 0; mask < (1 << clean.m.pendingNameOps); mask++) done.push({ label: `after the call returned, subset ${mask}`, files: clean.m.afterCrash({ names: "names-subset", mask, lost: "zero" }) });
  return { total, out, log: clean.log, result: clean.result, done };
}
const withBase = (files, fn) => { const base = materialize(files); try { return fn(base); } finally { fs.rmSync(base, { recursive: true, force: true }); } };

test("MODEL: a stop at any point while entering recovery (both queue files bad) comes back recovery-required with every bad file's bytes still there", t => {
  quiet(t);
  const evidence = [CONTENT.zero.toString("hex"), Buffer.from(CONTENT.garbage).toString("hex"), Buffer.from(text(GEN3)).toString("hex")];
  const { total, out } = sweep(put => { put(NAME.p, CONTENT.zero); put(NAME.b, CONTENT.garbage); put(NAME.t, text(GEN3)); }, {});
  assert.ok(total >= 6, "marker write, flush, folder flush, three moves: " + total);
  assert.ok(out.some(o => /kept: (01|10|001|010|011|101|110)/.test(o.label)), "out-of-order cases are part of the sweep");
  for (const { label, files } of out) withBase(files, base => {
    const have = hexSet(base);
    for (const e of evidence) assert.ok(have.has(e), label + ": evidence bytes kept");
    const store = open(base);
    assert.equal(store.getGlobalStatus().queueStoreRecoveryRequired, true, label);
    assert.deepEqual(view(store), EMPTY_VIEW, label);
    assert.equal(fs.existsSync(P(base)) && fs.readFileSync(P(base), "utf8") === "{}", false, label + ": no empty queue file was written");
  });
});

for (const [what, files, ordinary] of [
  ["the bad files already moved aside", { [NAME.m]: "{}", [NAME.p + ".corrupt-1"]: CONTENT.zero, [NAME.b + ".corrupt-1"]: CONTENT.garbage }, false],
  ["bad files still in place", { [NAME.m]: "{}", [NAME.p]: CONTENT.zero, [NAME.b]: CONTENT.garbage }, false],
  ["valid queue files in place beside the marker", { [NAME.m]: "{}", [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) }, false],
  ["no recovery pending (an ordinary reset of a live queue)", { [NAME.p]: text(GEN2), [NAME.b]: text(GEN1) }, true],
]) {
  test(`MODEL: a stop at any point during the acknowledged reset, with ${what}, including name changes kept out of order: afterwards recovery is still required or the queue is empty — never an older queue — and no file's bytes are lost`, t => {
    quiet(t);
    const evidence = Object.entries(files).filter(([n]) => n !== NAME.m).map(([, c]) => Buffer.from(c).toString("hex"));
    const { out, log, result, done } = sweep(put => { for (const [n, c] of Object.entries(files)) put(n, c); }, { afterLoad: store => store.acknowledgeReset("RESET") });
    assert.equal(result.ok, true);
    // An ordinary reset has not durably begun until its marker's folder flush: up to there a stop may leave the
    // current queue (the reset never happened). From there on, never.
    const begun = ordinary ? log.findIndex(l => l.startsWith("fsync-dir")) + 1 : 0;
    assert.ok(!ordinary || begun >= 3, "marker written, flushed, folder flushed: " + log.join(", "));
    let current = 0;
    for (const { n, label, files: disk } of out) withBase(disk, base => {
      const have = hexSet(base);
      for (const e of evidence) assert.ok(have.has(e), label + ": bytes kept");
      const store = open(base), st = store.getGlobalStatus();
      if (ordinary && n < begun && !st.queueStoreRecoveryRequired) { current++; assert.deepEqual(view(store), viewOf(GEN2), label + ": the reset had not begun — the current queue, never the backup's"); return; }
      assert.deepEqual(view(store), EMPTY_VIEW, label + ": never an old queue");
      if (!st.queueStoreRecoveryRequired) assert.equal(store.applyIntent("p_new", toIdle).ok, true, label + ": and usable");
    });
    assert.equal(current > 0, ordinary);
    assert.ok(out.some(o => /kept: (01|10)\b/.test(o.label)), "name changes kept out of order are part of this sweep");
    for (const { label, files: disk } of done) withBase(disk, base => {
      const store = open(base);
      assert.deepEqual([store.getGlobalStatus().queueStoreRecoveryRequired, view(store)], [false, EMPTY_VIEW], label + ": a reset that answered success stays done");
      const have = hexSet(base);
      for (const e of evidence) assert.ok(have.has(e), label + ": bytes kept");
    });
  });
}

// ------------------------------------------------- several printers, one save
test("assignPoolMany / unassignPoolMany change every printer in one save or none of them", t => {
  quiet(t);
  const base = tmpBase();
  seed(base, { [NAME.p]: text(GEN2) });
  let fail = true;
  const f = faultyFs((op, n) => fail && op === "write" && n === NAME.t ? err("EIO") : undefined);
  const store = open(base, { fsImpl: f.fs });
  const ids = ["p_new", "p_new2", "p_new3"];
  const r = store.assignPoolMany(ids);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "persist-failed");
  for (const id of ids) assert.equal(store.getPrinterState(id).queueState, "unmanaged", "none applied");
  assert.equal(fs.readFileSync(P(base), "utf8"), text(GEN2));
  fail = false;
  assert.equal(store.retrySave().ok, true);
  const opens = () => f.calls.filter(c => c === "open " + NAME.t).length, n0 = opens();
  assert.equal(store.assignPoolMany(ids).ok, true);
  assert.equal(opens() - n0, 1, "one save for all three");
  for (const id of ids) assert.equal(JSON.parse(fs.readFileSync(P(base), "utf8"))[id].queueState, "idle");
  assert.deepEqual(JSON.parse(fs.readFileSync(P(base), "utf8")).p_sample0002, GEN2.p_sample0002, "other printers untouched");
  assert.equal(store.unassignPoolMany(ids.slice(0, 2)).ok, true);
  assert.deepEqual(ids.map(id => store.getPrinterState(id).queueState), ["unmanaged", "unmanaged", "idle"]);
});

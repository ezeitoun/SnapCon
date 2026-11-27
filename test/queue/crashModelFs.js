// test/queue/crashModelFs.js — a small in-memory filesystem MODEL for the
// queue store's crash tests (test/queue/queueDurability.test.js).
//
// THIS IS A MODEL, NOT A FILESYSTEM. It encodes one pessimistic assumption
// about what a sudden stop keeps, chosen to match what was observed after a
// real power loss (both queue files at full length, all zero bytes):
//
//   - a file's CONTENT survives only if the file was flushed (fsync) after
//     its last write; otherwise the content is lost. Two ways of losing it
//     are modelled: "zero" (the length survives, every byte is zero) and
//     "empty" (length 0);
//   - a NAME change (create, rename, unlink) survives only if the directory
//     was flushed afterwards — or always, depending on the variant asked for
//     ("names-current": every name change survived; "names-durable": only
//     those before the last directory flush). A rename is atomic in both.
//     A third variant, "names-subset", keeps the names as of the last
//     directory flush plus ANY chosen subset of the name changes made since
//     (a bit mask over pendingNameOps): storage that does not keep directory
//     operations in order. Each kept change is applied whole.
//
// It proves nothing about a real power cut, about a disk or hypervisor that
// ignores flush requests, or about any filesystem's actual ordering rules.
// It only checks that the ORDER of writes, flushes and renames the store
// asks for leaves a loadable generation under this model.
const path = require("path");

class CrashSignal extends Error { constructor() { super("simulated crash"); this.code = "SIM_CRASH"; } }
const enoent = (op, p) => Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${p}'`), { code: "ENOENT" });

function createCrashModelFs() {
  let nextInode = 1, nextFd = 100;
  const inodes = new Map();       // id -> { data: Buffer, durable: Buffer|null }
  let names = new Map();          // path -> inode id (what a reader sees now)
  let durableNames = new Map();   // path -> inode id (as of the last directory flush)
  let pending = [];               // name changes since the last directory flush: { set: path, id } | { del: path } | { del, set, id } (rename)
  const fds = new Map();          // fd -> { dir: true } | { id, pos }
  const dirs = new Set();
  const log = [];                 // every mutating operation, in order
  let crashAfter = Infinity, crashed = false;

  function step(op, p) {
    if (crashed) throw new CrashSignal();
    log.push(op + " " + path.basename(p || ""));
    if (log.length >= crashAfter) { crashed = true; return true; }
    return false;
  }
  const after = hit => { if (hit) throw new CrashSignal(); };
  const inodeOf = (op, p) => { const id = names.get(p); if (id === undefined) throw enoent(op, p); return inodes.get(id); };

  const api = {
    mkdirSync(p) { dirs.add(p); },
    existsSync(p) { return names.has(p) || dirs.has(p); },
    openSync(p, flags = "r") {
      if (crashed) throw new CrashSignal();
      if (dirs.has(p)) { const fd = nextFd++; fds.set(fd, { dir: true }); return fd; }
      if (flags === "w") {
        const hit = step("open-w", p);
        let id = names.get(p);
        if (id === undefined) { id = nextInode++; inodes.set(id, { data: Buffer.alloc(0), durable: null }); names.set(p, id); pending.push({ set: p, id }); }
        else inodes.get(id).data = Buffer.alloc(0);
        const fd = nextFd++; fds.set(fd, { id, pos: 0 });
        after(hit);
        return fd;
      }
      const id = names.get(p); if (id === undefined) throw enoent("open", p);
      const fd = nextFd++; fds.set(fd, { id, pos: 0 }); return fd;
    },
    writeSync(fd, buf, off = 0, len = buf.length - off) {
      const f = fds.get(fd), ino = inodes.get(f.id);
      const hit = step("write", "");
      ino.data = Buffer.concat([ino.data.subarray(0, f.pos), buf.subarray(off, off + len)]);
      f.pos += len;
      after(hit);
      return len;
    },
    fsyncSync(fd) {
      const f = fds.get(fd);
      const hit = step(f.dir ? "fsync-dir" : "fsync-file", "");
      if (f.dir) { durableNames = new Map(names); pending = []; }
      else { const ino = inodes.get(f.id); ino.durable = Buffer.from(ino.data); }
      after(hit);
    },
    closeSync(fd) { if (crashed) throw new CrashSignal(); fds.delete(fd); },
    writeFileSync(p, data) {            // no flush: what the pre-fix store used
      const hit = step("writeFile", p);
      let id = names.get(p);
      if (id === undefined) { id = nextInode++; inodes.set(id, { data: Buffer.alloc(0), durable: null }); names.set(p, id); pending.push({ set: p, id }); }
      inodes.get(id).data = Buffer.from(data);
      after(hit);
    },
    copyFileSync(a, b) {                // rewrites the destination in place, no flush
      const src = inodeOf("copyfile", a);
      const hit = step("copyFile", b);
      let id = names.get(b);
      if (id === undefined) { id = nextInode++; inodes.set(id, { data: Buffer.alloc(0), durable: null }); names.set(b, id); pending.push({ set: b, id }); }
      inodes.get(id).data = Buffer.from(src.data);
      after(hit);
    },
    renameSync(a, b) {
      if (!names.has(a)) throw enoent("rename", a);
      const hit = step("rename", b);
      pending.push({ del: a, set: b, id: names.get(a) });
      names.set(b, names.get(a)); names.delete(a);
      after(hit);
    },
    unlinkSync(p) {
      if (!names.has(p)) throw enoent("unlink", p);
      const hit = step("unlink", p);
      names.delete(p); pending.push({ del: p });
      after(hit);
    },
    readFileSync(p, enc) { const d = inodeOf("open", p).data; return enc ? d.toString(enc) : Buffer.from(d); },
  };

  return {
    fs: api,
    log,
    get crashed() { return crashed; },
    // Everything present now is declared durable: the tests' starting point,
    // "an initially durable valid generation".
    syncAll() { for (const ino of inodes.values()) ino.durable = Buffer.from(ino.data); durableNames = new Map(names); pending = []; },
    get pendingNameOps() { return pending.length; },
    crashAfterOp(n) { crashAfter = log.length + n; crashed = false; },
    // What is on disk after the stop, as { path: Buffer }.
    //   names: "names-current" | "names-durable" | "names-subset" (with mask);  lost: "zero" | "empty"
    afterCrash({ names: nameMode, lost, mask = 0 }) {
      let view = nameMode === "names-durable" ? durableNames : names;
      if (nameMode === "names-subset") {
        view = new Map(durableNames);
        pending.forEach((op, i) => { if (!(mask & (1 << i))) return; if (op.del) view.delete(op.del); if (op.set) view.set(op.set, op.id); });
      }
      const out = {};
      for (const [p, id] of view) {
        const ino = inodes.get(id);
        const kept = ino.durable !== null && ino.durable.equals(ino.data);
        out[p] = kept ? Buffer.from(ino.data) : (lost === "zero" ? Buffer.alloc(ino.data.length) : Buffer.alloc(0));
      }
      return out;
    },
  };
}

module.exports = { createCrashModelFs, CrashSignal };

// test/sync/SyncStore.test.js — the sync history's nightly backup (backup():
// the Library's runBackup with prefix "sync"). Each test uses its own temp
// directory, never this repo's sync-data/.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSyncStore } = require("../../sync/SyncStore");

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-sync-test-"));

test("SyncStore: backup() is a complete copy, including writes still only in the WAL, and keeps seven", () => {
  const baseDir = fresh();
  const store = createSyncStore({ baseDir });
  for (let i = 0; i < 3; i++) {
    store.recordSynced({ printerId: "p1", root: "logs", remotePath: `klippy.log.${i}`, remoteSize: 3, remoteModified: 1, localPath: "/x", status: "ok" });
  }
  let clock = Date.now();
  const tick = () => (clock += 1000);
  const r = store.backup({ now: tick });
  assert.match(r.file, /^sync-\d{8}-\d{6}-nightly\.db$/);
  const { DatabaseSync } = require("node:sqlite");
  const copy = new DatabaseSync(path.join(baseDir, "sync-data", "backups", r.file));
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM synced_files").get().n, 3);
  copy.close();
  for (let i = 0; i < 9; i++) store.backup({ now: tick });
  assert.equal(store.listBackups().length, 7);
});

test("SyncStore: a failed backup throws for the caller to report, and leaves the store working", () => {
  const baseDir = fresh();
  const store = createSyncStore({ baseDir });
  fs.writeFileSync(path.join(baseDir, "sync-data", "backups"), "not a folder");
  assert.throws(() => store.backup(), /EEXIST|ENOTDIR|not a directory/i);
  store.recordSynced({ printerId: "p1", root: "logs", remotePath: "a.log", remoteSize: 1, remoteModified: 1, localPath: "/x", status: "ok" });
  assert.ok(store.getEntry("p1", "logs", "a.log"));
});

test("SyncStore: backup() is a no-op when the store is unavailable", () => {
  const baseDir = fresh();
  fs.writeFileSync(path.join(baseDir, "sync-data"), "a file where the folder should be");
  const store = createSyncStore({ baseDir });
  assert.equal(store.isAvailable(), false);
  assert.equal(store.backup(), null);
  assert.deepEqual(store.listBackups(), []);
});

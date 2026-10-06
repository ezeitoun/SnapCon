// test/snapshotCheck.test.js — what /api/snapshot (and notification images)
// accept from a connector's getCameraSnapshot().
//
// The bug: on ZMOD AD5X printers the connector returned a bare Buffer, so
// contentType was undefined. /api/snapshot copied it onto the response as the
// string "undefined", Express threw "invalid media type" while sending, its own
// 502 handler threw the same way, and the browser never got an answer — the
// "[unhandledRejection] TypeError: invalid media type" lines in the service
// log. getSnapshot() now checks the answer before anything uses it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
function extractFn(name) {
  const a = serverSrc.indexOf("async function " + name + "(");
  const at = a >= 0 ? a : serverSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, name + " must exist in server.js");
  return serverSrc.slice(at, serverSrc.indexOf("\n}", at) + 2);
}
let answer;
const sandbox = { Buffer, String, getConnector: () => ({ getCameraSnapshot: async () => answer }) };
vm.createContext(sandbox);
vm.runInContext(extractFn("getSnapshot") + "\n" + extractFn("checkSnapshot"), sandbox);
const snap = a => { answer = a; return vm.runInContext("getSnapshot", sandbox)({ name: "AD5X White", connector: "x" }); };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test("a proper frame passes through, its type reduced to the media type", async () => {
  const ok = await snap({ contentType: "image/jpeg", buffer: jpeg });
  assert.equal(ok.contentType, "image/jpeg");
  assert.equal(ok.buffer, jpeg, "the same frame, untouched");
  assert.equal((await snap({ contentType: "Image/JPEG; charset=binary", buffer: jpeg })).contentType, "image/jpeg");
});

test("the ZMOD case: a bare Buffer is refused as no image, not passed on with an undefined type", async () => {
  await assert.rejects(snap(jpeg), /AD5X White's camera returned no image/);
});

test("no type, a type that isn't an image, or an empty frame are refused", async () => {
  await assert.rejects(snap({ buffer: jpeg }), /returned no content type, not an image/);
  await assert.rejects(snap({ contentType: "text/html", buffer: jpeg }), /returned text\/html, not an image/);
  await assert.rejects(snap({ contentType: "undefined", buffer: jpeg }), /not an image/);
  await assert.rejects(snap({ contentType: "image/jpeg", buffer: Buffer.alloc(0) }), /returned no image/);
  await assert.rejects(snap(null), /returned no image/);
});

test("/api/snapshot sets the type only from a checked frame, so its 502 handler can still answer", () => {
  const route = serverSrc.slice(serverSrc.indexOf('app.get("/api/snapshot"'), serverSrc.indexOf("\n});", serverSrc.indexOf('app.get("/api/snapshot"')));
  // Both paths (fresh and throttled) go through getSnapshot(), which checks.
  assert.match(route, /await getSnapshot\(p\)/);
  assert.match(route, /await getSnapshotThrottled\(p, idx\)/);
  assert.match(extractFn("getSnapshotThrottled"), /await getSnapshot\(p\)/);
  assert.ok(route.indexOf('res.set("Content-Type", contentType)') > route.indexOf("getSnapshot"));
});

// test/bambuPoolGuard.test.js — a printer that takes different files from the
// rest of the fleet must not be put in a shared pool yet.
//
// A pool's "print on all" and "distribute" send one file to every printer in
// it, without asking what each one can print. With a Bambu Lab printer in a
// pool of Klipper machines, that means half the fleet gets a file it cannot
// start — at dispatch time, with no operator watching. Queue Management is
// outside the Bambu beta anyway (docs/TODO.md section 13), so the assignment is
// refused with a reason rather than half-supported.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function poolRoute() {
  const at = serverSrc.indexOf('app.post("/api/printer-pool"');
  assert.ok(at > 0, "the pool-assignment route must exist");
  return serverSrc.slice(at, serverSrc.indexOf("\n});", at));
}

test("assigning a pool checks what the printer can print", () => {
  assert.match(poolRoute(), /fileTypes/,
    "a connector with its own file types cannot share a pool until dispatch understands them");
});

test("the refusal carries a code, like the route's other refusals", () => {
  // The Settings tab translates by code rather than showing raw English.
  const route = poolRoute();
  assert.match(route, /code: "[a-z_]+"/);
  assert.match(route, /incompatible_file_types|file_types/);
});

test("removing a printer from a pool is always allowed", () => {
  // Otherwise a printer assigned before this guard existed could never be
  // taken out again.
  const route = poolRoute();
  const guardAt = route.search(/fileTypes/);
  const clearAt = route.indexOf("if (!printerPoolId)");
  assert.ok(clearAt > 0 && guardAt > clearAt,
    "the guard must sit after the 'clear the pool' branch has returned");
});

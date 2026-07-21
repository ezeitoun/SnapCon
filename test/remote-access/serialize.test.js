const test = require("node:test");
const assert = require("node:assert/strict");
const { createSerializer } = require("../../remote-access/serialize");

test("serialize() runs a second call only after the first has fully settled", async () => {
  const serialize = createSerializer();
  const order = [];
  let resolveFirst;
  const first = serialize(() => new Promise(resolve => {
    order.push("first-start");
    resolveFirst = () => { order.push("first-end"); resolve("first-result"); };
  }));
  const second = serialize(() => { order.push("second-start"); return "second-result"; });

  const p1 = first();
  const p2 = second();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ["first-start"], "the second call must not start until the first settles");

  resolveFirst();
  assert.equal(await p1, "first-result");
  assert.equal(await p2, "second-result");
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("serialize() shares ONE queue across every function wrapped through the same serializer — not one queue per function", async () => {
  const serialize = createSerializer();
  const order = [];
  let resolveA;
  const fnA = serialize(() => new Promise(resolve => { order.push("A-start"); resolveA = () => { order.push("A-end"); resolve(); }; }));
  const fnB = serialize(() => { order.push("B-start"); });

  const pA = fnA();
  const pB = fnB(); // a DIFFERENT wrapped function — must still wait for fnA, proving they share one queue
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ["A-start"], "fnB must not run until fnA (a different function on the same serializer) settles");

  resolveA();
  await pA; await pB;
  assert.deepEqual(order, ["A-start", "A-end", "B-start"]);
});

test("a rejected call does not break the queue for the next call", async () => {
  const serialize = createSerializer();
  const willReject = serialize(async () => { throw new Error("boom"); });
  const after = serialize(async () => "still works");

  await assert.rejects(() => willReject(), /boom/);
  assert.equal(await after(), "still works");
});

test("each call's own promise resolves/rejects independently, unaffected by other calls' outcomes", async () => {
  const serialize = createSerializer();
  const ok = serialize(async () => "ok-result");
  const fail = serialize(async () => { throw new Error("fail-result"); });

  const p1 = ok();
  const p2 = fail();
  const p3 = ok();

  assert.equal(await p1, "ok-result");
  await assert.rejects(() => p2, /fail-result/);
  assert.equal(await p3, "ok-result");
});

test("two independent serializers (e.g. two different service instances) do not share a queue", async () => {
  const serializeA = createSerializer();
  const serializeB = createSerializer();
  const order = [];
  let resolveSlow;
  const slow = serializeA(() => new Promise(resolve => { order.push("slow-start"); resolveSlow = () => { order.push("slow-end"); resolve(); }; }));
  const fast = serializeB(() => { order.push("fast-ran"); });

  const p1 = slow();
  const p2 = fast(); // different serializer entirely — must run immediately, not wait for `slow`
  await new Promise(r => setTimeout(r, 20));
  assert.ok(order.includes("fast-ran"), "a call on an unrelated serializer must not be blocked by another serializer's in-flight call");

  resolveSlow();
  await p1; await p2;
});

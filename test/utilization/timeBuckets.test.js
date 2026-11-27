// test/utilization/timeBuckets.test.js — local days and farm hours, including DST.
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../../utilization/timeBuckets");

const hours = r => (r.end - r.start) / 3600000;
const WEEKDAYS = { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" };
const NY = "America/New_York";

test("day lengths follow the zone", () => {
  assert.equal(hours(t.dayRange("2026-06-15", NY)), 24);
  assert.equal(hours(t.dayRange("2026-03-08", NY)), 23);
  assert.equal(hours(t.dayRange("2026-11-01", NY)), 25);
  assert.equal(hours(t.dayRange("2026-03-27", "Asia/Jerusalem")), 23);
  assert.equal(hours(t.dayRange("2026-10-25", "Asia/Jerusalem")), 25);
  assert.equal(hours(t.dayRange("2026-10-04", "Australia/Lord_Howe")), 23.5);
  assert.equal(hours(t.dayRange("2026-04-05", "Australia/Lord_Howe")), 24.5);
  assert.equal(hours(t.dayRange("2026-03-08", "UTC")), 24);
});

test("a day whose midnight does not exist still starts and adds up", () => {
  const r = t.dayRange("2026-03-08", "America/Havana");
  assert.equal(hours(r), 23);
  assert.equal(t.localDay(r.start, "America/Havana"), "2026-03-08");
  assert.equal(t.localDay(r.start - 1000, "America/Havana"), "2026-03-07");
});

test("the same instant is a different day in a different zone; days touch with no gap", () => {
  const ts = Date.UTC(2026, 5, 15, 2);
  assert.equal(t.localDay(ts, "UTC"), "2026-06-15");
  assert.equal(t.localDay(ts, NY), "2026-06-14");
  for (const day of ["2026-03-07", "2026-03-08", "2026-10-31", "2026-11-01"]) {
    const a = t.dayRange(day, NY), b = t.dayRange(t.addDays(day, 1), NY);
    assert.equal(a.end, b.start, day);
    assert.equal(t.localDay(a.start, NY), day);
    assert.equal(t.localDay(a.end - 1, NY), day);
  }
});

test("a farm window across a DST change holds its real hours", () => {
  const sunday = { days: [0], start: "01:00", end: "03:00" };
  assert.equal(hours(t.farmWindows("2026-03-08", sunday, NY)[0]), 1, "the skipped hour is not worked");
  assert.equal(hours(t.farmWindows("2026-11-01", sunday, NY)[0]), 3, "the repeated hour is worked");
  const allDay = { days: [0], start: "00:00", end: "24:00" };
  assert.equal(hours(t.farmWindows("2026-11-01", allDay, NY)[0]), 25);
  assert.equal(hours(t.farmWindows("2026-03-08", allDay, NY)[0]), 23);
});

test("a window that ends inside the repeated hour runs to its second pass", () => {
  // 01:30 happens twice on 2026-11-01: 00:00 to the later 01:30 is 2.5 real hours.
  assert.equal(hours(t.farmWindows("2026-11-01", { days: [0], start: "00:00", end: "01:30" }, NY)[0]), 2.5);
  // One that starts inside it starts at the first pass: 01:30 to 03:00 is 2.5 too.
  assert.equal(hours(t.farmWindows("2026-11-01", { days: [0], start: "01:30", end: "03:00" }, NY)[0]), 2.5);
});

test("a window starting or ending in the skipped hour is what is left of it", () => {
  const s = { days: [0], start: "02:30", end: "04:00" };
  assert.equal(hours(t.farmWindows("2026-03-08", s, NY)[0]), 1);
  assert.deepEqual(t.farmWindows("2026-03-08", { days: [0], start: "02:10", end: "02:50" }, NY), [], "entirely inside the skip: nothing");
});

test("unscheduled days have no farm hours; scheduled days use local time", () => {
  assert.deepEqual(t.farmWindows("2026-06-13", WEEKDAYS, NY), []);
  const [w] = t.farmWindows("2026-06-15", WEEKDAYS, NY);
  assert.equal(w.start, Date.UTC(2026, 5, 15, 12));
  assert.equal(w.end, Date.UTC(2026, 5, 15, 22));
});

test("a schedule that makes no sense is refused, saying why", () => {
  for (const bad of [null, {}, { days: [], start: "08:00", end: "18:00" }, { days: [7], start: "08:00", end: "18:00" }, { days: [1, 1], start: "08:00", end: "18:00" }, { days: [1.5], start: "08:00", end: "18:00" }, { days: [1], start: "8:00", end: "18:00" }, { days: [1], start: "08:60", end: "18:00" }, { days: [1], start: "24:00", end: "24:00" }, { days: [1], start: "08:00", end: "08:00" }, { days: [1], start: "00:00", end: "00:00" }, { days: [1], start: "08:00", end: "24:01" }]) {
    assert.ok(t.scheduleError(bad), JSON.stringify(bad));
  }
  assert.equal(t.scheduleError(WEEKDAYS), null);
  assert.equal(t.scheduleError({ days: [1], start: "18:00", end: "08:00" }), null, "overnight (owner, Phase 3 closeout)");
  assert.throws(() => t.farmWindows("2026-06-15", { days: [] }, NY), /invalid schedule/);
});

test("ranges, the previous period, and blocks counted back from the newest", () => {
  const seven = t.rangeDays("2026-11-01", 7);
  assert.equal(seven[0], "2026-10-26");
  assert.equal(seven[6], "2026-11-01");
  assert.deepEqual([t.previousRange(seven)[0], t.previousRange(seven)[6]], ["2026-10-19", "2026-10-25"]);
  const blocks = t.rollingBlocks(t.rangeDays("2026-11-01", 90), 7);
  assert.equal(blocks.length, 13);
  assert.equal(blocks[0].length, 6, "only the oldest is short");
  assert.ok(blocks.slice(1).every(b => b.length === 7));
  assert.equal(blocks[12][6], "2026-11-01");
  assert.equal(new Set(blocks.flat()).size, 90);
  assert.deepEqual(t.blockSpan(blocks[0]), { from: "2026-08-04", to: "2026-08-09", days: 6 }, "the short block says its real dates");
  assert.deepEqual(t.blockSpan(blocks[12]), { from: "2026-10-26", to: "2026-11-01", days: 7 });
  assert.equal(t.addDays("2028-02-28", 1), "2028-02-29");
  assert.throws(() => t.addDays("2026-02-30", 1), /invalid day/);
  assert.throws(() => t.rangeDays("2026-11-01", 0), /at least one/);
});

test("clip keeps only what is inside the windows, and keeps the interval's fields", () => {
  const out = t.clip([{ start: 0, end: 100, kind: "idle" }], [{ start: 10, end: 20 }, { start: 90, end: 200 }]);
  assert.deepEqual(out, [{ start: 10, end: 20, kind: "idle" }, { start: 90, end: 100, kind: "idle" }]);
  assert.deepEqual(t.clip([{ start: 0, end: 5 }], [{ start: 5, end: 9 }]), []);
});

test("time zones are checked", () => {
  assert.equal(t.isValidTimeZone(NY), true);
  for (const bad of ["Mars/Base", "", null, 5]) assert.equal(t.isValidTimeZone(bad), false);
});

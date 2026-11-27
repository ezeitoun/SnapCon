// utilization/timeBuckets.js — local days and farm hours over UTC timestamps
// (Fleet utilization, Phase 0). Pure: the zone is always an argument. Timestamps
// are milliseconds. A day is 'YYYY-MM-DD' in the zone; its length is whatever the
// zone makes it (23, 24, 25 hours, or Lord Howe's 23.5 and 24.5).
"use strict";

const DAY_MS = 86400000;
const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}
function localParts(ts, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}
function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}
const offsetAt = (ts, tz) => {
  const s = Math.floor(ts / 1000) * 1000, p = localParts(s, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
};
const pad = n => String(n).padStart(2, "0");
function localDay(ts, tz) {
  const p = localParts(ts, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
function parseDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) throw new Error(`invalid day: ${day}`);
  const y = +m[1], mo = +m[2], d = +m[3], t = Date.UTC(y, mo - 1, d);
  const c = new Date(t);
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) throw new Error(`invalid day: ${day}`);
  return { y, mo, d, t };
}
function addDays(day, n) {
  const c = new Date(parseDay(day).t + n * DAY_MS);
  return `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}`;
}
const dayOfWeek = day => new Date(parseDay(day).t).getUTCDay();   // 0 Sunday .. 6 Saturday

// A wall-clock time on a day -> the instant. A time the clocks skip means the
// first instant after the skip; a time that happens twice means the earlier or
// the later one, as asked.
function localToUtc(day, minutes, tz, prefer = "earlier") {
  const { y, mo, d } = parseDay(day);
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  const before = offsetAt(wall - DAY_MS, tz), after = offsetAt(wall + DAY_MS, tz);
  const found = [...new Set([before, after])].map(o => wall - o).filter(c => c + offsetAt(c, tz) === wall).sort((a, b) => a - b);
  if (found.length) return prefer === "later" ? found[found.length - 1] : found[0];
  let lo = wall - DAY_MS, hi = wall + DAY_MS;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2 / 1000) * 1000;
    if (offsetAt(mid, tz) === before) lo = mid; else hi = mid;
  }
  return hi;
}
function dayRange(day, tz) {
  return { start: localToUtc(day, 0, tz, "earlier"), end: localToUtc(addDays(day, 1), 0, tz, "earlier") };
}

function hhmmToMinutes(s, { allowEndOfDay = false } = {}) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  if (+m[2] > 59) return null;
  if (v === 1440) return allowEndOfDay ? v : null;
  return v < 1440 ? v : null;
}
// A schedule: { days: [0..6], start: 'HH:MM', end: 'HH:MM' }: one shift starting
// on each day named. An end not after the start is overnight: the shift ends on
// the next day (22:00 to 06:00; an end of 00:00 is the next midnight). Start
// and end the same is refused: it could mean nothing or the whole day.
// Returns what is wrong, or null.
function scheduleError(s) {
  if (!s || typeof s !== "object") return "no schedule";
  if (!Array.isArray(s.days) || !s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(s.days).size !== s.days.length) return "days must be 0-6, at least one, no repeats";
  const a = hhmmToMinutes(s.start), b = hhmmToMinutes(s.end, { allowEndOfDay: true });
  if (a == null || b == null) return "times must be HH:MM";
  if (b === a) return "the start and the end must differ";
  return null;
}
const overnight = s => hhmmToMinutes(s.end, { allowEndOfDay: true }) <= hhmmToMinutes(s.start);
// The shift that starts on `day`, as instants, or null (not a scheduled day, or
// nothing left of it after a clock change). Starts take the earlier instant of
// a repeated local time and the end the later, so a repeated hour is working
// time; a start in the skipped hour is where the clock resumes.
function shiftOf(day, s, tz) {
  if (!s.days.includes(dayOfWeek(day))) return null;
  const a = hhmmToMinutes(s.start), b = hhmmToMinutes(s.end, { allowEndOfDay: true });
  const start = localToUtc(day, a, tz, "earlier");
  const end = overnight(s) ? localToUtc(addDays(day, 1), b, tz, "later") : localToUtc(day, b, tz, "later");
  return end > start ? { start, end } : null;
}
// The farm hours inside one local day, as instants: the part of the shift
// starting that day, and of an overnight shift from the day before. Each part
// says which shift it belongs to (shiftStart, shiftEnd), so a shift cut by
// midnight still counts as one scheduled day (owner decision D7). [] when no
// shift touches the day.
function farmWindows(day, schedule, tz) {
  const err = scheduleError(schedule);
  if (err) throw new Error(`invalid schedule: ${err}`);
  const { start: ds, end: de } = dayRange(day, tz);
  const out = [];
  for (const sh of [overnight(schedule) ? shiftOf(addDays(day, -1), schedule, tz) : null, shiftOf(day, schedule, tz)]) {
    if (!sh) continue;
    const a = Math.max(sh.start, ds), b = Math.min(sh.end, de);
    if (b > a) out.push({ start: a, end: b, shiftStart: sh.start, shiftEnd: sh.end });
  }
  return out;
}

// Initialise the zone data once (the first Intl formatter with a time zone
// loads ICU's: ~16-20 ms), so that it happens at start, not in a request.
const warmTimeZones = () => { formatter("UTC").format(0); };

// The n days ending on endDay, oldest first; and the n before them.
function rangeDays(endDay, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error("a range needs at least one day");
  return Array.from({ length: n }, (_, i) => addDays(endDay, i - n + 1));
}
const previousRange = days => rangeDays(addDays(days[0], -1), days.length);
// Blocks of size days counted back from the newest. Only the oldest can be short.
function rollingBlocks(days, size) {
  const out = [];
  for (let e = days.length; e > 0; e -= size) out.unshift(days.slice(Math.max(0, e - size), e));
  return out;
}

// What a block covers, for its label: its real first and last day and how many.
const blockSpan = block => ({ from: block[0], to: block[block.length - 1], days: block.length });

// What is left of intervals inside windows.
function clip(intervals, windows) {
  const out = [];
  for (const i of intervals) for (const w of windows) {
    const start = Math.max(i.start, w.start), end = Math.min(i.end, w.end);
    if (end > start) out.push({ ...i, start, end });
  }
  return out;
}

module.exports = { isValidTimeZone, localDay, addDays, dayOfWeek, localToUtc, dayRange, scheduleError, farmWindows, shiftOf, rangeDays, previousRange, rollingBlocks, blockSpan, clip, warmTimeZones };

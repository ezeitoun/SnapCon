// tools/refactor/lib/contracts.js — compares contract-harness runs: two base
// runs (to prove volatility) and one head run. A field is masked only when it
// is declared volatile AND differs between the two base runs; every masked
// field is reported with its values. Everything else is compared exactly.
"use strict";

function flatten(v, p = "", out = new Map()) {
  if (v && typeof v === "object") {
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    if (!keys.length) out.set(p || "/", Array.isArray(v) ? "[]" : "{}");
    for (const k of keys) flatten(v[k], p + "/" + String(k).replace(/~/g, "~0").replace(/\//g, "~1"), out);
  } else out.set(p || "/", JSON.stringify(v));
  return out;
}
const matches = (ptr, decl) => {
  const a = ptr.split("/"), b = decl.split("/");
  return a.length === b.length && a.every((s, i) => b[i] === s || (b[i] === "*" && /^\d+$/.test(s)));
};

// Lifecycle (from harness/lifecycle-probe.js), per process start. A category
// that differs between the two base runs is UNVERIFIED (never masked); one
// that agrees must be identical in head.
function lifecycleCategories(l) {
  if (!l || l.missing) return null;
  const ms = a => a.slice().sort();
  return {
    startupIntervals: ms(l.intervals.filter(e => e.phase === "startup").map(e => `${e.creator}|${e.delay}|unref=${e.unref}`)),
    runtimeIntervals: ms(l.intervals.filter(e => e.phase === "runtime").map(e => `${e.creator}|${e.delay}|unref=${e.unref}|cleared=${e.cleared}`)),
    startupTimeouts: ms(l.startupTimeouts.map(e => `${e.creator}|${e.delay}|unref=${e.unref}|cleared=${e.cleared}`)),
    processListeners: ms(l.listeners.map(e => `${e.event}|${e.method}|${e.creator}`)),
    trackedTimeouts: l.tracked,
    activeIntervalsAtExit: l.activeIntervalsAtExit || null,
  };
}
function compareLifecycle(b1, b2, h) {
  const out = { status: "PASS", starts: [] };
  if (!Array.isArray(b1) || !Array.isArray(b2) || !Array.isArray(h)) return { status: "UNVERIFIED", why: "lifecycle not recorded" };
  const n = Math.max(b1.length, h.length);
  for (let i = 0; i < n; i++) {
    const c1 = lifecycleCategories(b1[i]), c2 = lifecycleCategories(b2[i]), ch = lifecycleCategories(h[i]);
    if (!c1 || !c2 || !ch) { out.starts.push({ start: i, status: "UNVERIFIED", why: "lifecycle record missing" }); continue; }
    const cats = {};
    for (const k of Object.keys(c1)) {
      const s1 = JSON.stringify(c1[k]), s2 = JSON.stringify(c2[k]), sh = JSON.stringify(ch[k]);
      cats[k] = s1 !== s2 ? { status: "UNVERIFIED", why: "differs between the two base runs", base1: c1[k], base2: c2[k], head: ch[k] }
        : s1 === sh ? { status: "PASS", count: Array.isArray(c1[k]) ? c1[k].length : undefined } : { status: "FAIL", base: c1[k], head: ch[k] };
    }
    const st = Object.values(cats).map(c => c.status);
    out.starts.push({ start: i, status: st.includes("FAIL") ? "FAIL" : st.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS", categories: cats });
  }
  const st = out.starts.map(s => s.status);
  out.status = st.includes("FAIL") ? "FAIL" : st.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
  return out;
}

// The measured-duration exception is narrow by construction: a log-line
// declaration must be kind "duration", anchored at the start of one specific
// line by at least 12 characters of literal text, and every capture group
// must be a plain number. Anything broader is refused, not applied.
const NUMBER_GROUPS = new Set(["(\\d+)", "(\\d+\\.\\d)", "(\\d+\\.\\d+)", "(\\d+(?:\\.\\d+)?)"]);
// The one other exception: the process ID in Node's OWN runtime-warning
// prefix "(node:<pid>) " — kind "pid", accepted for exactly this regex only.
const NODE_PID_PREFIX = "^\\(node:(\\d+)\\) ";
function validateLinePattern(p) {
  if (p.kind === "pid") {
    if (p.regex !== NODE_PID_PREFIX) throw new Error(`log pattern ${p.regex}: kind "pid" is accepted only for Node's runtime-warning prefix ${NODE_PID_PREFIX}`);
    return { ...p, re: new RegExp(p.regex) };
  }
  if (p.kind !== "duration") throw new Error(`log pattern ${p.regex}: only kind "duration" (or "pid" for Node's warning prefix) may be masked`);
  if (!p.regex.startsWith("^")) throw new Error(`log pattern ${p.regex}: must be anchored at the start of the line`);
  const literal = p.regex.slice(1).split("(")[0].replace(/\\(.)/g, "$1");
  if (literal.length < 12 || /[.*+?[\]{}|]/.test(p.regex.slice(1).split("(")[0].replace(/\\./g, ""))) throw new Error(`log pattern ${p.regex}: needs at least 12 characters of literal text before the first group`);
  const groups = p.regex.match(/\((?!\?:)(?:[^()]|\((?:[^()])*\))*\)/g) || [];
  if (!groups.length || groups.some(g => !NUMBER_GROUPS.has(g))) throw new Error(`log pattern ${p.regex}: every capture group must be a plain number`);
  return { ...p, re: new RegExp(p.regex) };
}

function compareRuns(base1, base2, head, volatile) {
  const report = { results: [], masked: [], declaredButStable: [], logs: null, printerRequests: null, files: null, audit: null, isolation: null, errors: null };
  report.isolation = { base1: base1.isolation && base1.isolation.ok, base2: base2.isolation && base2.isolation.ok, head: head.isolation && head.isolation.ok };
  report.errors = { base1: base1.errors, base2: base2.errors, head: head.errors };
  const byId = run => new Map(run.results.map(r => [r.id, r]));
  const B1 = byId(base1), B2 = byId(base2), H = byId(head);
  // Every result of every run is covered: one that any of the three runs
  // lacks is reported by name, never skipped and never thrown on.
  const ids = [...new Set([...B1.keys(), ...B2.keys(), ...H.keys()])];
  for (const id of ids) {
    const b1 = B1.get(id), b2 = B2.get(id), h = H.get(id);
    if (!b1 || !b2 || !h) {
      const missingIn = [["base1", b1], ["base2", b2], ["head", h]].filter(([, r]) => !r).map(([l]) => l);
      report.results.push({ id, status: "FAIL", why: "missing in " + missingIn.join(" and "), missingIn });
      continue;
    }
    const decls = (volatile.results && volatile.results[id]) || [];
    // An NDJSON answer (harness/ndjson.js) is compared record by record, in
    // order: a missing, extra, reordered or changed record is a difference at
    // its position, and the record count and final newline are compared too.
    // NDJSON fields can never be declared volatile (only /json pointers can).
    const shape = r => ({ status: r.status, contentType: r.contentType, json: r.json, text: r.text, ...(r.ndjson !== undefined ? { ndjson: r.ndjson } : {}) });
    const f1 = flatten(shape(b1)), f2 = flatten(shape(b2)), fh = flatten(shape(h));
    const diffs = [];
    // A malformed record is never acceptable, even when base and head agree on it.
    for (const [label, r] of [["base1", b1], ["base2", b2], ["head", h]]) {
      if (!r || !r.ndjson) continue;
      r.ndjson.records.forEach((rec, i) => { if (!rec.ok) diffs.push({ field: `/ndjson/records/${i}`, run: label, malformed: rec.raw }); });
      if (r.ndjson.count && !r.ndjson.endsWithNewline) diffs.push({ field: "/ndjson/endsWithNewline", run: label, malformed: "the last record is not terminated by a newline" });
    }
    // Fields of all three runs. A field that differs between the two base
    // runs is acceptable only when it is a declared volatile JSON field
    // (masked and reported, as before). Any other baseline difference — a
    // field present in one base run only included — blocks, even when head
    // equals base1: the baseline itself is then not a stable reference.
    const show = (f, k) => (f.has(k) ? f.get(k) : "<missing>");
    for (const k of new Set([...f1.keys(), ...f2.keys(), ...fh.keys()])) {
      const inJson = k.startsWith("/json");
      const decl = inJson ? decls.find(d => matches(k.slice(5), d.pointer)) : null;
      const varies = f1.get(k) !== f2.get(k);
      if (decl && varies) { report.masked.push({ id, field: k, kind: decl.kind, reason: decl.reason, base1: f1.get(k), base2: f2.get(k), head: fh.get(k) }); if (!fh.has(k)) diffs.push({ field: k, base: f1.get(k), head: "<missing>" }); continue; }
      if (varies) { diffs.push({ field: k, base: show(f1, k), base2: show(f2, k), head: show(fh, k), note: "varies between base runs but is not declared volatile" }); continue; }
      if (f1.get(k) !== fh.get(k)) diffs.push({ field: k, base: show(f1, k), head: show(fh, k) });
    }
    for (const d of decls) if (![...new Set([...f1.keys(), ...f2.keys()])].some(k => k.startsWith("/json") && matches(k.slice(5), d.pointer) && f1.get(k) !== f2.get(k))) report.declaredButStable.push({ id, pointer: d.pointer });
    report.results.push({ id, method: h.method, path: h.path, status: diffs.length ? "FAIL" : "PASS", diffs });
  }
  // Logs: line content and count compared exactly, except the capture groups
  // of explicitly declared line patterns (kind "duration"), each one reported.
  const pats = ((volatile.logs && volatile.logs.linePatterns) || []).map(validateLinePattern);
  const maskedLogs = [];
  const maskLine = (line, run) => {
    for (const p of pats) {
      const m = p.re.exec(line);
      if (!m) continue;
      let out = line;
      for (let g = m.length - 1; g >= 1; g--) if (m[g] !== undefined) { const at = m.index + m[0].indexOf(m[g]); out = out.slice(0, at) + "<" + p.kind + ">" + out.slice(at + m[g].length); }
      maskedLogs.push({ run, kind: p.kind, regex: p.regex, original: line });
      return out;
    }
    return line;
  };
  const lines = run => run.logs.map(l => maskLine(l.line, run.label)).sort();
  const stepped = run => run.logs.filter(l => (volatile.logs.exactStepPrefixes || []).some(p => l.line.startsWith(p))).map(l => l.step + " :: " + l.line);
  const lb = lines(base1), lh = lines(head);
  const missing = lb.filter((l, i, a) => lh.filter(x => x === l).length < a.filter(x => x === l).length);
  const extra = lh.filter((l, i, a) => lb.filter(x => x === l).length < a.filter(x => x === l).length);
  const sb = stepped(base1), shd = stepped(head);
  report.maskedLogLines = maskedLogs;
  report.logs = { status: !missing.length && !extra.length && JSON.stringify(sb) === JSON.stringify(shd) ? "PASS" : "FAIL",
    baseLines: lb.length, headLines: lh.length, missingInHead: [...new Set(missing)], extraInHead: [...new Set(extra)], steppedBase: sb, steppedHead: shd,
    stepAttributionVaries: JSON.stringify(base1.logs.map(l => l.step)) !== JSON.stringify(base2.logs.map(l => l.step)) };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  report.lifecycle = compareLifecycle(base1.lifecycle, base2.lifecycle, head.lifecycle);
  report.printerRequests = { status: eq(base1.printerRequests, head.printerRequests) ? "PASS" : (eq(base1.printerRequests, base2.printerRequests) ? "FAIL" : "UNVERIFIED"),
    base: base1.printerRequests, head: head.printerRequests, baseRunsAgree: eq(base1.printerRequests, base2.printerRequests) };
  report.files = { status: eq(base1.files, head.files) ? "PASS" : "FAIL", base: base1.files, head: head.files };
  report.audit = { status: eq(base1.audit, head.audit) ? "PASS" : "FAIL", base: base1.audit, head: head.audit };
  const all = [...report.results.map(r => r.status), report.logs.status, report.printerRequests.status, report.files.status, report.audit.status, report.lifecycle.status];
  const isoOk = Object.values(report.isolation).every(Boolean);
  const noErrors = !base1.errors.length && !base2.errors.length && !head.errors.length;
  report.status = !isoOk || !noErrors ? "FAIL" : all.includes("FAIL") ? "FAIL" : all.includes("UNVERIFIED") ? "UNVERIFIED" : "PASS";
  return report;
}

module.exports = { compareRuns, flatten, matches, validateLinePattern, compareLifecycle, NODE_PID_PREFIX };

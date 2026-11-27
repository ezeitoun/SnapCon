// fixtures/virtual-u1/shape.js — "what fields does a U1 report, and of what
// type", reduced from a full printer.objects.query so two captures (two
// firmware versions, or a capture and the simulator) can be compared without
// their values getting in the way.
//
// Used by scripts/capture-u1.js (what changed since the last capture) and by
// test/connectors/virtual-u1-drift.test.js (does the simulator still report
// what the real printer reports).

// Type name for one value. Arrays are typed by their first element, which is
// enough here: every per-head array on a U1 is homogeneous.
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array<" + (v.length ? typeOf(v[0]) : "empty") + ">";
  return typeof v;
}

// { objectName: { fieldName: typeName } } — one level deep, like Moonraker's
// own status deltas.
function shapeOf(status) {
  const out = {};
  for (const [name, obj] of Object.entries(status || {})) {
    out[name] = {};
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [field, v] of Object.entries(obj)) out[name][field] = typeOf(v);
    }
  }
  return out;
}

// Two types are compatible when either side is null (Klipper reports null for
// "not set yet", e.g. print_stats.info before a file's SET_PRINT_STATS_INFO) or
// either array is empty — neither says anything about the real type.
function compatible(a, b) {
  if (a === b) return true;
  if (a === "null" || b === "null") return true;
  if (a.startsWith("array<") && b.startsWith("array<")) return a === "array<empty>" || b === "array<empty>";
  return false;
}

// Differences from `before` to `after`, both shapeOf() results.
function diffShapes(before, after) {
  const d = { addedObjects: [], removedObjects: [], addedFields: [], removedFields: [], changedTypes: [] };
  for (const name of Object.keys(after)) if (!(name in before)) d.addedObjects.push(name);
  for (const name of Object.keys(before)) {
    if (!(name in after)) { d.removedObjects.push(name); continue; }
    const a = before[name], b = after[name];
    for (const f of Object.keys(b)) if (!(f in a)) d.addedFields.push(name + "." + f);
    for (const f of Object.keys(a)) {
      if (!(f in b)) d.removedFields.push(name + "." + f);
      else if (!compatible(a[f], b[f])) d.changedTypes.push(`${name}.${f}: ${a[f]} -> ${b[f]}`);
    }
  }
  return d;
}

function isEmptyDiff(d) {
  return Object.values(d).every(list => list.length === 0);
}

function formatDiff(d) {
  const lines = [];
  const section = (title, list) => { if (list.length) lines.push(title + ":", ...list.map(x => "  " + x)); };
  section("Objects added", d.addedObjects);
  section("Objects removed", d.removedObjects);
  section("Fields added", d.addedFields);
  section("Fields removed", d.removedFields);
  section("Field types changed", d.changedTypes);
  return lines.length ? lines.join("\n") : "No differences.";
}

module.exports = { typeOf, shapeOf, diffShapes, isEmptyDiff, formatDiff };

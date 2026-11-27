// tools/refactor/lib/identity.js — V3 moved-code identity. Extracts a
// top-level declaration (or a route's handler) from the base and from any
// file of the head, applies ONLY the manifest's declared rewrites to the base
// text — scope-aware: a name is rewritten only where it refers to the
// module-level binding, never a local or a property — removes common
// indentation, and requires the two texts to be identical.
"use strict";
const j = require("jscodeshift").withParser("babel");
const { parse } = require("../mapper/map-server");

function dedent(text) {
  const lines = text.replace(/\s+$/, "").split("\n");
  const ind = Math.min(...lines.slice(1).filter(l => l.trim()).map(l => l.match(/^ */)[0].length), Infinity);
  return [lines[0].trimStart(), ...lines.slice(1).map(l => (Number.isFinite(ind) ? l.slice(ind) : l))].join("\n");
}

// Text of the declaration named `name` — a function declaration, or a
// single-declarator const/let/var — at ANY depth (a helper may move inside a
// register function). Returns { text } or { error } when it is ambiguous.
function declText(src, name) {
  const root = parse(src);
  const found = [];
  root.find(j.FunctionDeclaration).forEach(p => { if (p.node.id && p.node.id.name === name) found.push(p.node); });
  root.find(j.VariableDeclaration).forEach(p => {
    const d = p.node.declarations;
    if (d.length === 1 && d[0].id.type === "Identifier" && d[0].id.name === name) found.push(p.node);
  });
  if (found.length > 1) return { error: "declared more than once in one file" };
  return found.length ? { text: src.slice(found[0].start, found[0].end) } : null;
}

// Text of the handler (last argument) of app.<method>("<path>", …) anywhere in src.
function routeHandlerText(src, method, routePath) {
  const root = parse(src);
  let found = null, middleware = null;
  root.find(j.CallExpression).forEach(p => {
    const c = p.node.callee, a0 = p.node.arguments[0];
    if (found || c.type !== "MemberExpression" || c.property.name !== method.toLowerCase()) return;
    if (!(a0 && (a0.type === "Literal" || a0.type === "StringLiteral") && a0.value === routePath)) return;
    const args = p.node.arguments;
    found = args[args.length - 1];
    middleware = args.slice(1, -1).map(a => src.slice(a.start, a.end));
  });
  return found ? { text: src.slice(found.start, found.end), middleware } : null;
}

// Apply declared rewrites ({from, to}) to references of module-level
// bindings only. `globals` is the set of names that are module-level in the
// snippet's ORIGINAL file (so a local of the same name is never touched).
function applyRewrites(snippet, rewrites) {
  if (!rewrites.length) return snippet;
  // Parse a function expression wrapped in parentheses, or anything else
  // (declarations, several statements) as it is — and apply the edits to
  // exactly the text that was parsed.
  const wrapped = "(" + snippet + ")";
  let root, src;
  try { root = parse(wrapped); src = wrapped; } catch { root = parse(snippet); src = snippet; }
  const map = new Map(rewrites.map(r => [r.from, r.to]));
  const edits = [];
  root.find(j.Identifier).forEach(p => {
    const name = p.node.name;
    if (!map.has(name)) return;
    const par = p.parent && p.parent.node;
    if (par && (par.type === "MemberExpression" || par.type === "OptionalMemberExpression") && par.property === p.node && !par.computed) return;
    if (par && (par.type === "ObjectProperty" || par.type === "Property") && par.key === p.node && !par.computed && par.value !== p.node) return;
    let scope = null; try { scope = p.scope && p.scope.lookup(name); } catch { /* ignore */ }
    if (scope && !scope.isGlobal) return;          // a local binding of the same name
    if (par && par.type === "AssignmentExpression" && par.left === p.node) throw new Error(`assignment to ${name} cannot be rewritten to ${map.get(name)}`);
    edits.push([p.node.start, p.node.end, map.get(name)]);
  });
  let out = src;
  for (const [s, e, t] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + t + out.slice(e);
  return src === wrapped ? out.slice(1, -1) : out;
}

function compareMoved(args) {
  try { return compareMovedUnsafe(args); }
  catch (e) { return { symbol: args.symbol, status: "FAIL", why: "could not analyse: " + e.message.split("\n")[0] }; }
}
// `destinations` (optional): the files a moved declaration may live in after
// the move — every file the manifest lets the refactor change (its new files,
// its allowed files, the file it moved from). When given,
// a declaration of the same name in any OTHER file (a connector's own
// function of that name, say) is not a candidate: it is listed in
// `sameNameElsewhere` and ignored, because V1/V2 already refuse changes
// outside the declared files. A duplicate WITHIN the destinations — the code
// copied rather than moved — still fails, and so does a symbol found only
// elsewhere. Without `destinations`, every head file is a candidate (as before).
function compareMovedUnsafe({ baseSrc, headSources, symbol, rewrites, destinations }) {
  const m = /^(GET|POST|PUT|DELETE|PATCH) (\/\S+)$/.exec(symbol);
  let base, head = null, headFile = null, baseMw = null, headMw = null;
  const candidate = file => !destinations || destinations.includes(file);
  const sameNameElsewhere = [];
  if (m) {
    const b = routeHandlerText(baseSrc, m[1], m[2]);
    base = b && b.text; baseMw = b && b.middleware;
    for (const [file, src] of Object.entries(headSources)) { const h = routeHandlerText(src, m[1], m[2]); if (h) { if (head) return { symbol, status: "FAIL", why: "defined more than once in head" }; head = h.text; headMw = h.middleware; headFile = file; } }
  } else {
    const b = declText(baseSrc, symbol);
    if (b && b.error) return { symbol, status: "FAIL", why: "base: " + b.error };
    base = b && b.text;
    for (const [file, src] of Object.entries(headSources)) {
      const h = declText(src, symbol);
      if (!h) continue;
      if (!candidate(file)) { sameNameElsewhere.push(file); continue; }
      if (h.error) return { symbol, status: "FAIL", why: file + ": " + h.error };
      if (head) return { symbol, status: "FAIL", why: "defined more than once in head (" + headFile + ", " + file + ")" };
      head = h.text; headFile = file;
    }
  }
  if (!base) return { symbol, status: "FAIL", why: "not found in base" };
  if (!head) return { symbol, status: "FAIL", why: "not found in head" + (sameNameElsewhere.length ? " (a declaration of this name exists only outside the declared destinations: " + sameNameElsewhere.join(", ") + ")" : "") };
  let expected;
  try { expected = dedent(applyRewrites(base, rewrites)); } catch (e) { return { symbol, status: "FAIL", why: e.message }; }
  const got = dedent(head);
  if (expected !== got) {
    const el = expected.split("\n"), gl = got.split("\n");
    const i = el.findIndex((l, k) => l !== gl[k]);
    return { symbol, status: "FAIL", headFile, why: "text differs after declared rewrites", firstDifference: { line: i + 1, expected: el[i], got: gl[i] } };
  }
  if (baseMw && JSON.stringify(baseMw) !== JSON.stringify(headMw)) return { symbol, status: "FAIL", headFile, why: "middleware differs", base: baseMw, head: headMw };
  return { symbol, status: "PASS", headFile, ...(sameNameElsewhere.length ? { sameNameElsewhere } : {}) };
}

module.exports = { compareMoved, applyRewrites, declText, routeHandlerText, dedent };

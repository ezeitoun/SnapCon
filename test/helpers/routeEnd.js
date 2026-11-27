// test/helpers/routeEnd.js — where a server.js route handler ends, for tests
// that slice a route out of the source. Most end "\n});"; the ones wrapped in
// withGcodeHolds(...) end "\n}));". Returns the index the old
// indexOf("\n});") would have, shifted by one for a wrapped route, so the
// callers' "+ 4" / "+ 5" still take the whole closing.
function routeEnd(src, from = 0, trailingNewline = false) {
  const nl = trailingNewline ? "\n" : "";
  const a = src.indexOf("\n});" + nl, from), b = src.indexOf("\n}));" + nl, from);
  return b >= 0 && (a < 0 || b < a) ? b + 1 : a;
}
module.exports = { routeEnd };

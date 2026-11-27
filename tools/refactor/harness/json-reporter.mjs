// tools/refactor/harness/json-reporter.mjs — a node:test reporter that emits
// one JSON line per finished test (file, name, nesting, status), so suites
// can be compared test by test, never by counts alone.
//
// status: "pass" | "fail" | "skip" | "todo-pass" | "todo-fail".
// A test declared { todo } is a documented known bug: node:test reports it as
// test:pass or test:fail with data.todo set and never counts it as a failure.
// It is kept apart from genuine failures ("fail") here; a failing todo keeps
// its error, so its signature can still be checked.
export default async function* jsonReporter(source) {
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data;
    if (d.details && d.details.type === "suite") continue;
    const failed = ev.type === "test:fail";
    const status = d.todo ? (failed ? "todo-fail" : "todo-pass") : failed ? "fail" : d.skip ? "skip" : "pass";
    yield JSON.stringify({ file: d.file, name: d.name, nesting: d.nesting, status,
      error: failed && d.details && d.details.error ? String(d.details.error.message || d.details.error).slice(0, 500) : undefined }) + "\n";
  }
}

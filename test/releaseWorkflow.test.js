// test/releaseWorkflow.test.js — what pushing a release tag does
// (.github/workflows/release.yml). Static checks of the workflow file, plus a
// run of the one step that writes the release text; the workflow itself only
// runs on GitHub.
//
//   - The release is created as a DRAFT. Publishing it is a person's decision,
//     after looking at the builds made on GitHub's Windows and macOS machines.
//   - No other step can create or publish a release: the late Intel-Mac job may
//     only add its file to the release that already exists.
//   - The release text is the section of RELEASE_NOTES.md for the tagged
//     version (the reviewed notes), not text GitHub generates. GitHub shows a
//     release's text with every line break kept, so lines wrapped in the file
//     are joined again; the words are untouched.
//   - The builds install exactly what package-lock.json pins (npm ci).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
const lines = workflow.split("\n");
const indentOf = l => l.length - l.trimStart().length;

// The steps of the workflow: { job, text, uses, name }. A step starts at a
// "- " item directly under a job's "steps:".
function steps() {
  const out = [];
  let job = null, stepIndent = -1, cur = null;
  for (const line of lines) {
    const mJob = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (mJob) { job = mJob[1]; stepIndent = -1; cur = null; continue; }
    if (/^\s*steps:\s*$/.test(line)) { stepIndent = indentOf(line) + 2; cur = null; continue; }
    if (stepIndent < 0) continue;
    if (line.trim() && !line.trimStart().startsWith("#") && indentOf(line) < stepIndent) { stepIndent = -1; cur = null; continue; }
    if (indentOf(line) === stepIndent && line.trimStart().startsWith("- ")) { cur = { job, text: [] }; out.push(cur); }
    if (cur) cur.text.push(line);
  }
  return out.map(s => {
    const text = s.text.join("\n");
    return { job: s.job, text, uses: (/^\s*(?:- )?uses:\s*(\S+)/m.exec(text) || [])[1] || null, name: (/^\s*(?:- )?name:\s*(.+)$/m.exec(text) || [])[1] || null };
  });
}
// A step's "run: |" script, with the YAML indentation taken off.
function runScript(step) {
  const sl = step.text.split("\n");
  const at = sl.findIndex(l => /^\s*run:\s*\|\s*$/.test(l));
  if (at < 0) return (/^\s*run:\s*(.+)$/m.exec(step.text) || [])[1] || null;
  const body = [];
  for (const l of sl.slice(at + 1)) { if (l.trim() && indentOf(l) <= indentOf(sl[at])) break; body.push(l); }
  const cut = Math.min(...body.filter(l => l.trim()).map(indentOf));
  return body.map(l => l.slice(cut)).join("\n");
}
const all = steps();
const releaseAction = s => /softprops\/action-gh-release/.test(s.uses || "");

test("a tag push makes a draft release, never a published one", () => {
  const making = all.filter(releaseAction);
  assert.equal(making.length, 1, "exactly one step creates the release");
  assert.equal(making[0].job, "release");
  assert.match(making[0].text, /^\s*draft:\s*true\s*$/m, "the release must be a draft");
  assert.doesNotMatch(making[0].text, /make_latest/, "a draft is not made the latest release");
});

test("the release text comes from a file the workflow writes, not from GitHub's generated notes", () => {
  const making = all.find(releaseAction);
  assert.match(making.text, /^\s*body_path:\s*release-body\.md\s*$/m);
  assert.doesNotMatch(workflow, /generate_release_notes:\s*true/);
  const order = all.filter(s => s.job === "release").map(s => s.name || s.uses);
  assert.ok(order.indexOf("Write the release text") >= 0 && order.indexOf("Write the release text") < order.findIndex(n => /softprops/.test(n) || /draft/i.test(n)),
    "the text is written before the release is made: " + order.join(" | "));
});

test("no other step can create, publish or edit a release: the late Intel-Mac job only uploads its file", () => {
  for (const s of all) {
    const script = runScript(s) || "";
    assert.doesNotMatch(script, /gh\s+release\s+(create|edit|delete)/, `${s.job}: ${s.name}`);
    assert.doesNotMatch(script, /releases\b.*-X\s*(POST|PATCH)|draft=false/, `${s.job}: ${s.name}`);
  }
  const intel = all.filter(s => s.job === "build-intel");
  assert.ok(intel.length > 0, "the Intel-Mac job is still there");
  assert.equal(intel.filter(releaseAction).length, 0, "it must not use the release action, which would publish a draft it finds");
  const upload = intel.map(runScript).filter(Boolean).filter(r => /gh\s+release\s+upload/.test(r));
  assert.equal(upload.length, 1, "it adds its file with gh release upload");
  assert.match(upload[0], /gh\s+release\s+upload\s+"\$GITHUB_REF_NAME"/);
});

test("every build installs exactly what package-lock.json pins", () => {
  const installs = all.map(s => ({ s, script: runScript(s) || "" })).filter(x => /\bnpm\s+(ci|install|i)\b/.test(x.script));
  assert.equal(installs.length, 2, "the three-system build job and the Intel-Mac job");
  for (const { s, script } of installs) assert.match(script.trim(), /^npm ci$/, `${s.job}: ${s.name}`);
});

// ---- the step that writes the release text, run for real ----

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const haveShell = process.platform !== "win32" && spawnSync("bash", ["-c", "command -v awk"], { encoding: "utf8" }).status === 0;
function writeReleaseText(t, refName, notes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-text-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (notes === undefined) fs.copyFileSync(path.join(ROOT, "RELEASE_NOTES.md"), path.join(dir, "RELEASE_NOTES.md"));
  else fs.writeFileSync(path.join(dir, "RELEASE_NOTES.md"), notes);
  const step = all.find(s => s.name === "Write the release text");
  assert.ok(step, "the step exists");
  const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", runScript(step)], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_REF_NAME: refName } });
  const file = path.join(dir, "release-body.md");
  return { status: r.status, stderr: r.stderr, body: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
}

test("the release text is the download paragraph followed by the notes for the tagged version, and nothing else", { skip: !haveShell && "needs bash and awk" }, t => {
  const { status, stderr, body } = writeReleaseText(t, "v" + VERSION);
  assert.equal(status, 0, stderr);
  const notes = fs.readFileSync(path.join(ROOT, "RELEASE_NOTES.md"), "utf8").split("\n");
  const from = notes.indexOf(VERSION);
  assert.ok(from >= 0, `RELEASE_NOTES.md has a "${VERSION}" line`);
  const versionLine = /^\d+\.\d+\.\d+$/;
  const next = notes.findIndex((l, i) => i > from && versionLine.test(l.trim()));
  const section = notes.slice(from + 1, next < 0 ? notes.length : next).join("\n").trim();
  assert.ok(section.length > 500, "the section has real content");
  assert.ok(body.startsWith("## SnapCon\n"), "the download paragraph comes first");
  assert.match(body, /Download the build for your OS/);
  const words = s => s.split(/\s+/).filter(Boolean).join(" ");
  assert.ok(words(body).endsWith(words(section)), "then the reviewed notes for this version, word for word, to the end");
  const before = notes.slice(0, from).filter(l => l.startsWith("### "));
  assert.ok(before.length > 10);
  for (const h of before) assert.ok(!body.includes(h + "\n") || section.includes(h + "\n"), "nothing from an earlier version: " + h);
  assert.ok(body.length < 125000, "within GitHub's limit for a release text: " + body.length);
  // Shape: the same headings and list items as the file, each on a line of
  // its own, and no paragraph or list item left broken across lines.
  const sec = section.split("\n");
  const firstHeading = sec.find(l => l.startsWith("### "));
  const out = body.slice(body.indexOf(firstHeading)).split("\n");   // the notes, after the download paragraph
  const count = (ls, re) => ls.filter(l => re.test(l)).length;
  assert.equal(count(out, /^### /), count(sec, /^### /), "headings");
  assert.equal(count(out, /^\s*- /), count(sec, /^\s*- /), "list items");
  const starts = /^(#{1,6} |\s*- |\s*\d+[.)] |\s*\||\s*>|\s*```)/;
  const broken = out.filter((l, i) => i > 0 && l.trim() && out[i - 1].trim() && !starts.test(l) && !/^#{1,6} /.test(out[i - 1]));
  assert.deepEqual(broken, [], "lines still wrapped mid-paragraph");
});

test("wrapped lines are joined; headings, list items, tables, code and deliberate line breaks keep their lines", { skip: !haveShell && "needs bash and awk" }, t => {
  const notes = [
    "0.9.0", "### Older", "old text", "",
    "1.2.3", "",
    "### A heading",
    "A paragraph that was wrapped",
    "over two lines.",
    "",
    "- **First item** continues",
    "  on a second line",
    "  and a third.",
    "  - nested item wrapped",
    "    as well;",
    "- Second item.",
    "",
    "1. Step one is",
    "   wrapped.",
    "2. Step two.",
    "",
    "A line ending in two spaces  ",
    "stays above this one.",
    "",
    "A wrapped line that",
    "ends in two spaces  ",
    "breaks only there.",
    "",
    "| Column | Other |",
    "|---|---|",
    "| a | b |",
    "",
    "```",
    "code line one",
    "  code line two",
    "```",
    "",
    "    indented code one",
    "    indented code two",
    "",
    "> a quote",
    "> in two lines",
    "",
    "Last paragraph, wrapped",
    "once.",
    "",
    "2.0.0", "### Newer", "new text", "",
  ].join("\n");
  const { status, stderr, body } = writeReleaseText(t, "v1.2.3", notes);
  assert.equal(status, 0, stderr);
  const got = body.slice(body.indexOf("### A heading")).trimEnd().split("\n");
  assert.deepEqual(got, [
    "### A heading",
    "A paragraph that was wrapped over two lines.",
    "",
    "- **First item** continues on a second line and a third.",
    "  - nested item wrapped as well;",
    "- Second item.",
    "",
    "1. Step one is wrapped.",
    "2. Step two.",
    "",
    "A line ending in two spaces  ",
    "stays above this one.",
    "",
    "A wrapped line that ends in two spaces  ",
    "breaks only there.",
    "",
    "| Column | Other |",
    "|---|---|",
    "| a | b |",
    "",
    "```",
    "code line one",
    "  code line two",
    "```",
    "",
    "    indented code one",
    "    indented code two",
    "",
    "> a quote",
    "> in two lines",
    "",
    "Last paragraph, wrapped once.",
  ]);
  assert.doesNotMatch(body, /old text|new text|### Older|### Newer/);
});

test("a tag whose version has no notes fails the step, so no release is drafted with the wrong text", { skip: !haveShell && "needs bash and awk" }, t => {
  const { status, stderr } = writeReleaseText(t, "v0.0.0");
  assert.notEqual(status, 0);
  assert.match(stderr, /RELEASE_NOTES\.md has no section for 0\.0\.0/);
});

test("an earlier version's notes stop at the next version, for a tag in the middle of the file", { skip: !haveShell && "needs bash and awk" }, t => {
  const { status, body } = writeReleaseText(t, "v0.7.2");
  assert.equal(status, 0);
  assert.match(body, /### Bambu Lab: time remaining and fan speed/);
  assert.doesNotMatch(body, /### New version numbers/, "the next version's notes are not included");
});

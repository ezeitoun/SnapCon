// test/fileDeleteDialog.test.js — the File Browser's delete dialog (public/app.js):
// Move to Trash is selected every time it opens; Delete permanently is shown
// only to a signed-in Admin with accounts on, asks once more, and is sent as
// mode "permanent" for every selected file. Run from app.js's own source
// against a minimal page.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales-default", "es.json"), "utf8"));
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const block = appSrc.slice(appSrc.indexOf("// ---- Delete: Move to Trash (default) or Delete permanently ----"), appSrc.indexOf("function openNewFolderModal(){"));

function el() {
  const classes = new Set();
  return { textContent: "", innerHTML: "", hidden: false, checked: false, className: "", dataset: {}, focus() {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } };
}
function page({ usersEnabled = true, role = "admin", confirmAnswer = true, reply = null } = {}) {
  const els = {};
  const $ = id => (els[id] || (els[id] = el()));
  const fill = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (_, k) => (k in p ? p[k] : "{" + k + "}"));
  const t = (key, p) => { const v = key.split(".").reduce((o, k) => (o || {})[k], en); assert.ok(typeof v === "string", "missing string " + key); return fill(v, p); };
  const sandbox = {
    $, t, tn: (k, n, p) => t(k + (n === 1 ? "_one" : "_other"), { count: n, ...(p || {}) }),
    esc: s => String(s).replace(/[&<>"']/g, c => "&#" + c.charCodeAt(0) + ";"),
    splitFilePath: fp => { const i = fp.lastIndexOf("/"); return i < 0 ? { sub: "", name: fp } : { sub: fp.slice(0, i), name: fp.slice(i + 1) }; },
    USERS_ENABLED: usersEnabled, CURRENT_USER: role ? { role } : null,
    confirms: [], posts: [],
    confirm: m => { sandbox.confirms.push(m); return confirmAnswer; },
    postJSON: async (url, body) => { sandbox.posts.push({ url, body }); const d = reply || { results: body.files.map(f => ({ ...f, ok: true, path: (f.sub ? f.sub + "/" : "") + f.name })) }; return { ok: !d.error, status: d.error ? 403 : 200, json: async () => d }; },
    setTimeout: () => 0, SELECTED: null, SEND_SOURCE: null, SELECTED_FILES: new Set(), SELECT_ANCHOR: null, CURRENT_SUB: "",
    clearJobSelection() {}, updateMultiSelectUI() {}, loadFiles() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(block + "\nthis.api = { openDeleteDialog, confirmDeleteDialog, syncDeleteDialog, canDeletePermanently };", sandbox);
  return { ...sandbox.api, $, sandbox, change: () => sandbox.api.syncDeleteDialog() };
}
const settle = () => new Promise(r => setImmediate(r));

test("one file: titled with its name; Move to Trash selected, explained, and the action names its scope", () => {
  const p = page();
  p.openDeleteDialog(["U1/bracket.gcode"]);
  assert.equal(p.$("deleteFilesTitle").textContent, "Delete “bracket.gcode”?");
  assert.match(p.$("deleteFilesList").innerHTML, /U1\/bracket\.gcode/);
  assert.equal(p.$("deleteModeTrash").checked, true);
  assert.equal(p.$("deleteModePermanent").checked, false);
  assert.match(p.$("deleteModeTrashHelp").textContent, /30 days, and can be recovered/);
  assert.equal(p.$("deleteFilesGo").textContent, "Move 1 file to the trash");
  assert.equal(p.$("deleteFilesGo").className, "btn danger");
  assert.ok(p.$("deleteFilesModal").classList.contains("show"));
});

test("several files: titled with the count, at most 10 listed, the rest counted", () => {
  const p = page();
  const files = Array.from({ length: 13 }, (_, i) => `f${i}.gcode`);
  p.openDeleteDialog(files);
  assert.equal(p.$("deleteFilesTitle").textContent, "Delete 13 files?");
  assert.equal((p.$("deleteFilesList").innerHTML.match(/<li/g) || []).length, 11);
  assert.match(p.$("deleteFilesList").innerHTML, /…and 3 more/);
  assert.equal(p.$("deleteFilesGo").textContent, "Move 13 files to the trash");
});

test("Move to Trash sends mode trash for every selected file, with no second confirmation", async () => {
  const p = page();
  p.openDeleteDialog(["a.gcode", "U1/b.gcode"]);
  await p.confirmDeleteDialog(); await settle();
  assert.deepEqual([...p.sandbox.confirms], []);
  assert.deepEqual(JSON.parse(JSON.stringify(p.sandbox.posts)), [{ url: "/api/files/delete", body: { files: [{ sub: "", name: "a.gcode" }, { sub: "U1", name: "b.gcode" }], mode: "trash" } }]);
  assert.equal(p.$("fileOpStatus").textContent, "Moved 2 files to the trash");
});

test("Delete permanently is offered only to a signed-in Admin with accounts on", () => {
  for (const [usersEnabled, role, shown] of [[false, null, false], [false, "admin", false], [true, "regular", false], [true, "viewer", false], [true, null, false], [true, "admin", true]]) {
    const p = page({ usersEnabled, role });
    p.openDeleteDialog(["a.gcode"]);
    assert.equal(p.$("deleteModePermanentBlock").hidden, !shown, `${usersEnabled} ${role}`);
  }
});

test("a hidden Permanent option can never be what is sent, even if checked", async () => {
  const p = page({ usersEnabled: false, role: null });
  p.openDeleteDialog(["a.gcode"]);
  p.$("deleteModePermanent").checked = true; p.$("deleteModeTrash").checked = false; p.change();
  await p.confirmDeleteDialog(); await settle();
  assert.equal(p.sandbox.posts[0].body.mode, "trash");
});

test("Delete permanently: the action changes, a second confirmation names what goes, then mode permanent is sent", async () => {
  const p = page();
  p.openDeleteDialog(["a.gcode", "b.gcode", "c.gcode"]);
  p.$("deleteModePermanent").checked = true; p.$("deleteModeTrash").checked = false; p.change();
  assert.equal(p.$("deleteFilesGo").textContent, "Delete 3 files permanently");
  assert.equal(p.$("deleteFilesGo").className, "btn danger-filled");
  await p.confirmDeleteDialog(); await settle();
  assert.deepEqual([...p.sandbox.confirms], ["Permanently delete 3 files?\n\nThey will be removed from the NAS and can't be restored through SnapCon."]);
  assert.equal(p.sandbox.posts[0].body.mode, "permanent");
  assert.equal(p.sandbox.posts[0].body.files.length, 3);
  assert.equal(p.$("fileOpStatus").textContent, "Deleted 3 files permanently");

  const one = page();
  one.openDeleteDialog(["U1/a.gcode"]);
  one.$("deleteModePermanent").checked = true; one.$("deleteModeTrash").checked = false; one.change();
  await one.confirmDeleteDialog();
  assert.match(one.sandbox.confirms[0], /^Permanently delete “U1\/a\.gcode”\?/);
});

test("declining the second confirmation deletes nothing", async () => {
  const p = page({ confirmAnswer: false });
  p.openDeleteDialog(["a.gcode"]);
  p.$("deleteModePermanent").checked = true; p.$("deleteModeTrash").checked = false; p.change();
  await p.confirmDeleteDialog();
  assert.equal(p.sandbox.posts.length, 0);
});

test("the method resets to Move to Trash every time the dialog opens", async () => {
  const p = page();
  p.openDeleteDialog(["a.gcode"]);
  p.$("deleteModePermanent").checked = true; p.$("deleteModeTrash").checked = false; p.change();
  await p.confirmDeleteDialog(); await settle();
  p.openDeleteDialog(["b.gcode"]);
  assert.equal(p.$("deleteModeTrash").checked, true);
  assert.equal(p.$("deleteModePermanent").checked, false);
  assert.equal(p.$("deleteFilesGo").textContent, "Move 1 file to the trash");
  assert.doesNotMatch(block, /localStorage|sessionStorage/, "never remembered");
});

test("a partial batch and a server refusal are reported, per file", async () => {
  const p = page({ reply: { results: [{ sub: "", name: "a.gcode", ok: true, path: "a.gcode" }, { sub: "", name: "b.gcode", ok: false, code: "in_use", error: "It is in U1 Navy's queue." }] } });
  p.openDeleteDialog(["a.gcode", "b.gcode"]);
  p.$("deleteModePermanent").checked = true; p.$("deleteModeTrash").checked = false; p.change();
  await p.confirmDeleteDialog(); await settle();
  assert.equal(p.$("fileOpStatus").textContent, "Deleted 1 of 2 permanently. Not deleted: b.gcode (It is in U1 Navy's queue.)");
  const refused = page({ reply: { error: "Only an Admin can delete files permanently." } });
  refused.openDeleteDialog(["a.gcode"]);
  await refused.confirmDeleteDialog(); await settle();
  assert.equal(refused.$("fileOpStatus").textContent, "Delete failed: Only an Admin can delete files permanently.");
});

test("the dialog's controls: real radios with labels, danger roles, and every string in Spanish too", () => {
  for (const id of ["deleteModeTrash", "deleteModePermanent"]) {
    assert.match(html, new RegExp(`<input type="radio" name="deleteMode" id="${id}"`));
    assert.match(html, new RegExp(`<label for="${id}"`));
  }
  assert.match(html, /<input type="radio" name="deleteMode" id="deleteModeTrash" value="trash" checked>/);
  assert.match(html, /<div id="deleteModePermanentBlock" hidden>/, "hidden until shown to an Admin");
  for (const k of Object.keys(en.files).filter(k => k.startsWith("delete"))) assert.ok(typeof es.files[k] === "string", "es: files." + k);
});

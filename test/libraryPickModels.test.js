// test/libraryPickModels.test.js — selecting Models in the Library's grid to
// hide or delete several at once (owner, 2026-11-27).
//
// Each Model card has a checkbox; a bar, or a right-click on a card, offers
// "Hide" and "Delete". Hide is the Library's own, reversible action. Delete
// hands the Models' print files in the G-code folder to the File Browser's
// delete (Move to Trash, or permanently for a signed-in Admin:
// docs/file-delete.md) and then hides the Models; everything else a Model
// holds stays where it is.
//
// These tests cover what is decided in the page: which files a deletion
// names, which Models are hidden afterwards, and who is offered what. The
// delete itself is the File Browser's route and has its own tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "library.js"), "utf8");
function extractFn(name) {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at > 0, "public/library.js has " + name + "()");
  return src.slice(at, src.indexOf("\n  }\n", at) + 4);
}
function page(names, globals = {}) {
  const ctx = vm.createContext({
    t: (k, p) => k + (p ? " " + JSON.stringify(p) : ""), tn: (k, n) => k + "#" + n,
    esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    ...globals,
  });
  vm.runInContext(names.map(extractFn).join("\n"), ctx);
  // Arrays and objects come back from another realm: copied, so that they
  // compare by value.
  return (n, ...a) => { const r = vm.runInContext(n, ctx)(...a); return r && typeof r === "object" ? JSON.parse(JSON.stringify(r)) : r; };
}
const file = (p, o = {}) => ({ root: "gcode", rootName: "G-code folder", path: p, name: p.split("/").pop(), availability: "ok", duplicates: [], ...o });

test("a Model's deletion names its print files in the G-code folder, each once", () => {
  const plan = page(["modelDeletePlan"])("modelDeletePlan", {
    uuid: "u1", name: "Gear box",
    printables: [
      { file: file("Gears/Gear box.gcode") },
      // Two plates of one project file: the file is named once.
      { file: file("Gears/Gear box.gcode.3mf"), plate: 1 }, { file: file("Gears/Gear box.gcode.3mf"), plate: 2 },
      // A copy of the first file elsewhere in the Model.
      { file: file("Gears/Gear box v2.gcode", { duplicates: [{ root: "gcode", rootName: "G-code folder", path: "Old/Gear box v2.gcode", name: "Gear box v2.gcode" }] }) },
    ],
    projects: [{ file: file("Gears/Gear box.3mf") }],
    others: [file("Gears/photo.jpg", { role: "image" }), file("Gears/readme.txt", { role: "document" })],
  });
  assert.deepEqual(plan.files, ["Gears/Gear box.gcode", "Gears/Gear box.gcode.3mf", "Gears/Gear box v2.gcode", "Old/Gear box v2.gcode", "Gears/Gear box.3mf"]);
  assert.equal(plan.kept, 2, "the picture and the text file stay");
});

test("files in another location, inside a 3MF, or already missing are never named", () => {
  const plan = page(["modelDeletePlan"])("modelDeletePlan", {
    printables: [
      { file: file("a.gcode", { root: "nas2", rootName: "Archive" }) },
      { file: file("b.gcode", { availability: "missing" }) },
      { file: file("c.gcode", { availability: "offline" }) },
      { file: file("d.gcode") },
    ],
    projects: [],
    others: [file("Metadata/plate_1.png", { container: { path: "x.3mf" }, entry: "Metadata/plate_1.png" }), file("../outside.gcode"), file("")],
  });
  assert.deepEqual(plan.files, ["d.gcode"]);
  assert.equal(plan.kept, 6);
});

test("a Model is hidden after its deletion only when every file named for it went", () => {
  const f = page(["modelsToHideAfterDelete"]);
  const plans = [
    { uuid: "all-gone", files: ["a.gcode", "b.gcode"] },
    { uuid: "one-left", files: ["c.gcode", "d.gcode"] },
    { uuid: "nothing-to-delete", files: [] },
  ];
  assert.deepEqual(f("modelsToHideAfterDelete", plans, new Set(["a.gcode", "b.gcode", "c.gcode"])), ["all-gone", "nothing-to-delete"]);
  assert.deepEqual(f("modelsToHideAfterDelete", plans, new Set()), ["nothing-to-delete"]);
});

test("the confirmation names the Model, or says how many", () => {
  const f = page(["pickTitle"]);
  assert.equal(f("pickTitle", "delete", [{ uuid: "u1", name: "Gear box" }]), 'library.delete_title {"name":"Gear box"}');
  assert.equal(f("pickTitle", "delete", Array.from({ length: 22 }, (_, i) => ({ uuid: "u" + i, name: "m" + i }))), "library.delete_n_title#22");
  assert.equal(f("pickTitle", "hide", [{ uuid: "u1", name: "Gear box" }]), 'library.hide_title {"name":"Gear box"}');
  assert.equal(f("pickTitle", "hide", [{ uuid: "u1", name: "a" }, { uuid: "u2", name: "b" }]), "library.hide_n_title#2");
});

test("a right-click acts on the selection when the card is part of it, else on that card alone", () => {
  const f = page(["pickTargets"]);
  const pick = new Map([["u1", "One"], ["u2", "Two"]]);
  assert.deepEqual(f("pickTargets", pick, "u2", "Two"), [{ uuid: "u1", name: "One" }, { uuid: "u2", name: "Two" }]);
  assert.deepEqual(f("pickTargets", pick, "u9", "Nine"), [{ uuid: "u9", name: "Nine" }]);
  assert.deepEqual(f("pickTargets", new Map(), "u9", "Nine"), [{ uuid: "u9", name: "Nine" }]);
});

test("the checkbox is on a card only for someone who may hide Models; Delete is offered only to someone who may also act on files", () => {
  const card = hide => {
    const f = page(["cardHtml"], {
      can: k => k === "hide" && hide, L: { pick: new Map([["u2", "Two"]]) },
      coverHtml: () => "", typeTagsHtml: () => "", cardMetaHtml: () => "", familyChips: () => "", folderLineHtml: () => "",
    });
    return uuid => f("cardHtml", { uuid, name: "A <model>", families: [], types: [], cover: null });
  };
  assert.doesNotMatch(card(false)("u1"), /lib-card-selbox/);
  const html = card(true)("u1");
  assert.match(html, /<label class="lib-card-sel" title="library\.pick_title"><input type="checkbox" class="checkbox-input lib-card-selbox" data-uuid="u1"/);
  assert.match(html, /aria-label="library\.pick_aria \{&quot;name&quot;:&quot;A &lt;model>&quot;\}"/);
  assert.doesNotMatch(html, / checked/);
  assert.match(card(true)("u2"), /data-uuid="u2".* checked><\/label>/, "a selected Model stays ticked when the grid is drawn again");

  const offers = (hide, act) => page(["canDeleteModels"], { can: k => k === "hide" && hide, canAct: () => act })("canDeleteModels");
  assert.equal(offers(true, true), true);
  assert.equal(offers(true, false), false);
  assert.equal(offers(false, true), false);
});

test("hidden Models are offered Unhide, not Hide (the grid shows either the hidden ones or the others, never both)", () => {
  // Reported 2026-11-27: with "Show hidden models" on, the bar and the
  // right-click menu still offered Hide for Models that were already hidden.
  const offers = (showingHidden, act) => page(["canDeleteModels", "pickOffers"], { can: k => k === "hide", canAct: () => act })("pickOffers", showingHidden);
  assert.deepEqual(offers(false, true), ["hide", "delete"]);
  assert.deepEqual(offers(true, true), ["unhide", "delete"]);
  assert.deepEqual(offers(false, false), ["hide"]);
  assert.deepEqual(offers(true, false), ["unhide"]);
  // Both places ask the same function, with what the grid is showing.
  assert.equal((src.match(/pickOffers\(L\.filters\.hidden\)/g) || []).length, 2, "the bar and the menu");
  const en = require("../locales-default/en.json").library, es = require("../locales-default/es.json").library;
  for (const k of ["unhide_n_btn_one", "unhide_n_btn_other", "done_unhide_n_one", "done_unhide_n_other"]) { assert.ok(en[k], "en " + k); assert.ok(es[k], "es " + k); assert.match(es[k], /\{count\}/); assert.match(en[k], /\{count\}/); }
});

test("every new text exists in English and Spanish with the same placeholders, and Delete is the danger button", () => {
  const en = require("../locales-default/en.json").library, es = require("../locales-default/es.json").library;
  const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
  const keys = ["pick_title", "pick_aria", "hide_n_help", "delete_title", "delete_nothing", "done_delete", "delete_partial", "delete_loading", "delete_not_done",
    ...["picked_n", "hide_n_btn", "delete_n_btn", "hide_n_title", "hide_n_ok", "done_hide_n", "delete_n_title", "delete_files_line", "delete_kept_line", "delete_then_hidden", "delete_ok"].flatMap(k => [k + "_one", k + "_other"])];
  for (const k of keys) { assert.ok(en[k], "en " + k); assert.ok(es[k], "es " + k); assert.equal(ph(es[k]), ph(en[k]), k); }
  assert.match(en.delete_title, /^Delete Model “\{name\}”\?$/);
  assert.equal(en.delete_n_title_other, "Delete {count} Models?");
  assert.match(src, /class="btn danger btn-sm" id="libPickDelete"/);
  assert.match(src, /dialog\(\{ title:pickTitle\("delete",targets\), confirm:tn\("library\.delete_ok",n\), danger:true,/);
});

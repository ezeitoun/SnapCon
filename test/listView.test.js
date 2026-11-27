// test/listView.test.js — List View's table between polls
// (renderFleetListRows in public/app.js). A poll (incremental) keeps the
// table and its rows and rewrites only the cells whose HTML changed, so a
// focused button or checkbox in an unchanged cell stays the same element.
// Any other render builds the table afresh. The HTML itself is pinned by the
// List golden files in test/compactCard.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHarness } = require("./helpers/cardHarness");
const printers = require("./fixtures/card-golden/printers");

// Just enough DOM for the list: real parent/child links, so moves, removals
// and identity can be checked, and a log of every DOM write.
function makeDom() {
  const writes = [];
  class El {
    constructor(tag) { this.tagName = tag; this.className = ""; this.children = []; this.parentNode = null; this._html = ""; this.listeners = {}; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { const s = this.parentNode && this.parentNode.children; return s ? s[s.indexOf(this) + 1] || null : null; }
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      if (i < 0) throw new Error("insertBefore: reference is not a child");
      this.children.splice(i, 0, c); c.parentNode = this;
      writes.push({ op: "insert", el: c });
      return c;
    }
    appendChild(c) { return this.insertBefore(c, null); }
    remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; writes.push({ op: "remove", el: this }); } }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    get innerHTML() { return this._html; }
    set innerHTML(html) {
      writes.push({ op: "html", el: this, html });
      this._html = html;
      for (const c of this.children) c.parentNode = null;
      this.children = [];
      if (this.tagName === "table") {
        // colgroup, then <thead><tr>…</tr></thead>, then an empty <tbody>.
        const m = /<thead><tr>([\s\S]*)<\/tr><\/thead><tbody><\/tbody>$/.exec(html);
        const thead = new El("thead"), tr = new El("tr"), tbody = new El("tbody");
        tr._html = m[1]; thead.children.push(tr); tr.parentNode = thead;
        this.tHead = thead;
        this.children.push(thead, tbody); thead.parentNode = tbody.parentNode = this;
      } else if (this.tagName === "tr") {
        for (const m of html.matchAll(/<td(?: class="([^"]*)")?>([\s\S]*?)<\/td>/g)) {
          const td = new El("td"); td.className = m[1] || ""; td._html = m[2];
          if (/class="cam-chk/.test(m[2])) td.chk = { checked: false };
          td.parentNode = this; this.children.push(td);
        }
      }
      // A checkbox element, new each time the cell that holds it is written.
      if (this.tagName === "td" && /class="cam-chk/.test(html)) this.chk = { checked: false };
    }
    get cells() { return this.children; }
    get rows() { return this.children; }
    querySelector(sel) {
      if (sel === "tbody") return this.children.find(c => c.tagName === "tbody") || null;
      if (sel === ".cam-chk") { const td = this.children.find(c => c.chk); return td ? td.chk : null; }
      // The old per-<th> sort listener (kept working so this file can be run
      // against the previous renderFleetListRows).
      if (sel === '[data-listsort="name"]') return { addEventListener() {} };
      throw new Error("querySelector " + sel);
    }
  }
  return { writes, document: { createElement: tag => new El(tag), querySelector: () => null, querySelectorAll: () => [] }, El };
}

function setup(strings) {
  const h = makeHarness({ view: "list", strings });
  const dom = makeDom();
  h.ctx.document = dom.document;
  const wrap = dom.document.createElement("div");
  const render = (rows, incremental) => {
    h.ctx.__rows = rows; h.ctx.__wrap = wrap; h.ctx.__inc = incremental;
    // A full render clears #fleet first, as renderFleet() does.
    if (!incremental) wrap.innerHTML = "";
    dom.writes.length = 0;
    h.run("renderFleetListRows(__rows, __wrap, 6000, __inc)");
  };
  const table = () => wrap.children[0];
  const trs = () => table().querySelector("tbody").children;
  return { h, dom, wrap, render, table, trs };
}
const fleet = () => [structuredClone(printers.printing), structuredClone(printers.complete), structuredClone(printers.error)];
const cellWrites = writes => writes.filter(w => w.op === "html" && w.el.tagName === "td");

test("a poll with nothing changed keeps the table, every row and cell, and writes nothing", () => {
  const s = setup();
  s.render(fleet(), false);
  const table = s.table(), rows = [...s.trs()], cells = rows.map(r => [...r.cells]);
  s.render(fleet(), true);
  assert.equal(s.table(), table);
  assert.equal(s.wrap.children.length, 1);
  assert.deepEqual([...s.trs()], rows);
  assert.deepEqual([...s.trs()].map(r => [...r.cells]), cells);
  assert.deepEqual(s.dom.writes, []);
});

test("a printing row's poll rewrites only Progress and Layers; its buttons stay the same elements", () => {
  const s = setup();
  s.render(fleet(), false);
  const row = s.trs()[0], actions = row.cells[9], file = row.cells[3];
  const next = fleet();
  next[0].progress = 0.47; next[0].elapsed += 600; next[0].layer = { current: 91, total: 210 };
  s.render(next, true);
  const written = cellWrites(s.dom.writes).map(w => row.cells.indexOf(w.el));
  assert.deepEqual(written, [6, 7]);
  assert.equal(s.dom.writes.length, 2);
  assert.equal(s.trs()[0], row);
  assert.equal(row.cells[9], actions);
  assert.equal(row.cells[3], file);
  assert.match(row.cells[6].innerHTML, /47%/);
  assert.equal(row.cells[7].innerHTML, "91 / 210");
});

test("a state change rewrites the cells it changes, and the row is what a full render would build", () => {
  const s = setup();
  s.render(fleet(), false);
  const next = fleet();
  next[0].state = "paused";
  s.render(next, true);
  const written = cellWrites(s.dom.writes).map(w => s.trs()[0].cells.indexOf(w.el));
  assert.ok(written.includes(4) && written.includes(9), "status and actions");
  assert.ok(!written.includes(0) && !written.includes(1), "checkbox and printer untouched");
  const fresh = setup();
  fresh.render(next, false);
  assert.deepEqual(s.trs()[0].cells.map(c => c.innerHTML), fresh.trs()[0].cells.map(c => c.innerHTML));
  assert.equal(s.trs()[0].className, fresh.trs()[0].className);
});

test("a printer going offline changes the row's class without a new row", () => {
  const s = setup();
  s.render(fleet(), false);
  const row = s.trs()[1];
  const next = fleet(); next[1].online = false;
  s.render(next, true);
  assert.equal(s.trs()[1], row);
  assert.equal(row.className, "list-row offline");
});

test("rows follow the new order, moving only what is out of place, and a printer that left is removed", () => {
  const s = setup();
  s.render(fleet(), false);
  const [a, b, c] = s.trs();
  const [pa, pb, pc] = fleet();
  s.render([pb, pa, pc], true);
  assert.deepEqual([...s.trs()], [b, a, c]);
  assert.equal(s.dom.writes.filter(w => w.op === "insert").length, 1);
  s.render([pb, pc], true);
  assert.deepEqual([...s.trs()], [b, c]);
  assert.equal(a.parentNode, null);
  // Back again: a new row for it, in place.
  s.render([pa, pb, pc], true);
  assert.equal(s.trs().length, 3);
  assert.notEqual(s.trs()[0], a);
  assert.deepEqual(s.trs().slice(1), [b, c]);
});

test("the header is rewritten only when it changes, and the table stays", () => {
  const s = setup();
  s.render(fleet(), false);
  const table = s.table(), headRow = table.tHead.rows[0];
  s.render(fleet(), true);
  assert.equal(headRow.innerHTML.includes("⇅"), true);
  s.h.run("LIST_SORT_NAME_DIR='asc'");
  s.render(fleet(), true);
  assert.equal(s.table(), table);
  assert.match(headRow.innerHTML, /▲/);
  assert.equal(s.dom.writes.filter(w => w.el === headRow).length, 1);
});

test("the sort click is on the table, so it survives a header rewrite", () => {
  const s = setup();
  s.render(fleet(), false);
  const clicks = s.table().listeners.click || [];
  assert.equal(clicks.length, 1);
  const th = { closest: sel => (sel === '[data-listsort="name"]' ? {} : null) };
  s.h.run("LIST_SORT_NAME_DIR=null");
  clicks[0]({ target: th });
  assert.equal(s.h.run("LIST_SORT_NAME_DIR"), "asc");
  clicks[0]({ target: { closest: () => null } });
  assert.equal(s.h.run("LIST_SORT_NAME_DIR"), "asc", "a click elsewhere in the table does not sort");
});

test("the checkbox follows the selection without its cell being rewritten", () => {
  const s = setup();
  s.render(fleet(), false);
  const chk = s.trs()[0].querySelector(".cam-chk");
  assert.equal(chk.checked, false);
  s.h.run("CAM_SELECTED.add(11)");
  s.render(fleet(), true);
  assert.equal(s.trs()[0].querySelector(".cam-chk"), chk, "same element");
  assert.equal(chk.checked, true);
  assert.deepEqual(cellWrites(s.dom.writes), []);
  s.h.run("CAM_SELECTED.delete(11)");
  s.render(fleet(), true);
  assert.equal(chk.checked, false);
});

test("a render that is not a poll builds a new table", () => {
  const s = setup();
  s.render(fleet(), false);
  const table = s.table();
  s.render(fleet(), false);
  assert.notEqual(s.table(), table);
  assert.equal(s.wrap.children.length, 1);
});

test("a poll after #fleet was cleared by another view builds a new table", () => {
  const s = setup();
  s.render(fleet(), false);
  const table = s.table();
  s.wrap.innerHTML = ""; // what a card view's full render does
  s.render(fleet(), true);
  assert.notEqual(s.table(), table);
  assert.equal(s.wrap.children.length, 1);
  assert.equal(s.trs().length, 3);
});

// ---- action feedback under the status badge ----

const statusCell = s => s.trs()[0].cells[4].innerHTML;

test("a status message shows under the badge, escaped, and the row's other cells are left alone", () => {
  const s = setup();
  s.render(fleet(), false);
  assert.match(statusCell(s), /<\/span><div class="pstatus" id="pst-11"><\/div>$/, "an empty status element, for ctl() to write into");
  s.h.run(`CARD_STATUS.set("11", {cls:"pstatus err", txt:"Heater <b>off</b>"})`);
  s.render(fleet(), true);
  assert.match(statusCell(s), /<div class="pstatus err" id="pst-11">Heater &lt;b&gt;off&lt;\/b&gt;<\/div>$/);
  assert.deepEqual(cellWrites(s.dom.writes).map(w => s.trs()[0].cells.indexOf(w.el)), [4]);
});

test("a message that only repeats the badge is not shown, as on the compact card; feedback is", () => {
  const h = { "fleet.print.status_printing_on": "Printing on {printer}" };
  const s = setup(h);
  const next = fleet(); next[0].state = "paused";
  s.h.run(`CARD_STATUS.set("11", {cls:"pstatus ok", txt:"Printing on U1 Left"})`);
  s.render(next, false);
  assert.match(statusCell(s), /<div class="pstatus" id="pst-11"><\/div>$/);
  s.h.run(`CARD_STATUS.set("11", {cls:"pstatus work", txt:"Resuming…"})`);
  s.render(next, true);
  assert.match(statusCell(s), />Resuming…<\/div>$/);
});

// ---- keyboard focus across a render (fleetFocusKey / restoreFleetFocus) ----

function focusSetup() {
  const h = makeHarness({ view: "list" });
  const doc = { body: { tagName: "BODY" }, activeElement: null };
  doc.activeElement = doc.body;
  const items = [];
  const wrap = { contains: e => items.includes(e), querySelectorAll: tag => items.filter(i => i.tagName === tag) };
  doc.getElementById = id => (id === "fleet" ? wrap : null);
  h.ctx.document = doc;
  h.ctx.$ = id => doc.getElementById(id);
  const el = (attrs, opts = {}) => {
    const e = {
      tagName: opts.tag || "BUTTON", attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
      disabled: !!opts.disabled, hidden: !!opts.hidden, isConnected: true,
      focus() { doc.activeElement = this; },
      closest(sel) { return sel === "[hidden]" && this.hidden ? this : null; },
    };
    items.push(e);
    return e;
  };
  // What a render does to the focused control: it leaves the page.
  const drop = e => { items.splice(items.indexOf(e), 1); e.isConnected = false; if (doc.activeElement === e) doc.activeElement = doc.body; };
  const key = e => { h.ctx.__e = e; return h.run("fleetFocusKey(__e)"); };
  const restore = (k, e) => { h.ctx.__k = k; h.ctx.__e = e; h.run("restoreFleetFocus(__k, __e)"); };
  return { doc, el, drop, key, restore };
}

test("Pause and Resume are one control: focus on Pause moves to the Resume that replaced it", () => {
  const f = focusSetup();
  const pause = f.el({ "data-ctl": "7", "data-act": "pause" });
  f.el({ "data-ctl": "7", "data-act": "cancel" });
  pause.focus();
  const k = f.key(pause);
  f.drop(pause);
  const resume = f.el({ "data-ctl": "7", "data-act": "resume" });
  f.restore(k, pause);
  assert.equal(f.doc.activeElement, resume);
});

test("focus goes to the same control of the same printer, never another printer's or another action", () => {
  const f = focusSetup();
  const cancel = f.el({ "data-ctl": "7", "data-act": "cancel" });
  cancel.focus();
  const k = f.key(cancel);
  f.drop(cancel);
  f.el({ "data-ctl": "8", "data-act": "cancel" });
  f.el({ "data-ctl": "7", "data-act": "pause" });
  f.restore(k, cancel);
  assert.equal(f.doc.activeElement, f.doc.body);
  const again = f.el({ "data-ctl": "7", "data-act": "cancel" });
  f.restore(k, cancel);
  assert.equal(f.doc.activeElement, again);
});

test("a control that is gone, disabled or in a closed menu is not focused", () => {
  const f = focusSetup();
  const estop = f.el({ "data-estop": "7" });
  estop.focus();
  const k = f.key(estop);
  f.drop(estop);
  f.el({ "data-estop": "7" }, { hidden: true });
  f.el({ "data-estop": "7" }, { disabled: true });
  f.restore(k, estop);
  assert.equal(f.doc.activeElement, f.doc.body);
});

test("focus that stayed, or moved somewhere else, is left alone", () => {
  const f = focusSetup();
  const chk = f.el({ "data-camsel": "7" }, { tag: "INPUT" });
  chk.focus();
  const k = f.key(chk);
  f.restore(k, chk);
  assert.equal(f.doc.activeElement, chk, "still there: nothing to do");
  const other = f.el({ "data-snap": "9" });
  f.drop(chk);
  other.focus(); // e.g. a dialog took focus
  f.el({ "data-camsel": "7" }, { tag: "INPUT" });
  f.restore(k, chk);
  assert.equal(f.doc.activeElement, other);
});

test("only controls in the fleet area with data-* attributes have an identity; an upload's job id is not part of it", () => {
  const f = focusSetup();
  assert.equal(f.key(f.doc.body), null);
  assert.equal(f.key(f.el({})), null);
  const outside = { tagName: "BUTTON", attributes: [{ name: "data-ctl", value: "7" }] };
  assert.equal(f.key(outside), null);
  assert.equal(f.key(f.el({ "data-cancel-upload": "", "data-printer": "7" })), f.key(f.el({ "data-cancel-upload": "job-42", "data-printer": "7" })));
  assert.notEqual(f.key(f.el({ "data-id": "7", "data-start": "0" })), f.key(f.el({ "data-id": "7", "data-start": "1" })), "Upload and Print stay apart");
});

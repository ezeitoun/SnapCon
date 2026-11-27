// test/compactCard.test.js — the printer card in Compact view
// (buildCompactCardHtml in public/app.js): its own markup, built only when
// VIEW_MODE is 'compact'.
//
// The scope guard comes first: with Compact off, buildCardHtml() (Full view,
// classic and new layout, and Camera view) and the List view's row must
// produce exactly the HTML they produced before Compact had its own card.
// The golden files were written from public/app.js before that change
// (test/fixtures/card-golden/regenerate.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { makeHarness, appSrc } = require("./helpers/cardHarness");
const golden = require("./fixtures/card-golden/regenerate");
const goldenPrinters = require("./fixtures/card-golden/printers");

const GOLDEN_DIR = path.join(__dirname, "fixtures", "card-golden");

// ---- scope guard ----

for (const view of Object.keys(golden.VIEWS)) {
  for (const state of Object.keys(goldenPrinters)) {
    test(`scope guard: ${view} view, ${state} card is unchanged`, () => {
      const want = fs.readFileSync(path.join(GOLDEN_DIR, `${view}.${state}.html`), "utf8");
      assert.equal(golden.render(view, state) + "\n", want);
    });
  }
}

test("scope guard: buildCardHtml hands Compact to its own builder before anything else runs", () => {
  const body = appSrc.slice(appSrc.indexOf("function buildCardHtml("));
  const firstStatement = body.split("\n").find(l => l.trim() && !l.trim().startsWith("//") && !l.startsWith("function"));
  assert.equal(firstStatement.trim(), "if(VIEW_MODE==='compact') return buildCompactCardHtml(p, dragEnabled);");
});

// ---- the compact card, by state ----

const caps = { camera: true, filamentHeads: true, unloadFilament: true, excludeObject: true, webUi: true };
const heads = [
  { loaded: true, hex: "#F2C200", material: "PLA" },
  { loaded: true, hex: "#101010", material: "PETG" },
  { loaded: false },
  { loaded: true, hex: "#FFFFFF", material: "PLA" },
];
const base = { id: 7, name: "U1 Left", brand: "SnapMaker", url: "http://192.168.1.40", online: true, heads, capabilities: caps, activeExt: 1 };
const PRINTERS = {
  printing: { ...base, state: "printing", filename: "Gear box v3.gcode", progress: 0.457, elapsed: 52920, filamentUsed: 77040, plate: { total: 4, excluded: 1 } },
  paused: { ...base, state: "paused", filename: "Gear box v3.gcode", progress: 0.457, elapsed: 52920, filamentUsed: 77040, plate: { total: 4, excluded: 1 } },
  complete: { ...base, state: "complete", filename: "Bracket.gcode", progress: 1, elapsed: 62820, filamentUsed: 138600, completedAt: Date.UTC(2026, 9, 15, 9, 12) },
  idle: { ...base, state: "standby", filename: "", progress: 0, elapsed: 0 },
  idleWithLastFile: { ...base, state: "standby", filename: "Old job.gcode", progress: 0, elapsed: 0 },
  error: { ...base, state: "error", filename: "Vase.gcode", progress: 0.52, elapsed: 26400, message: "Heater extruder not heating at expected rate" },
  offline: { ...base, online: false, state: "standby", lastSeenAt: new Date(Date.UTC(2026, 9, 15, 10, 12)).toISOString() },
};
// The compact card's own lines in real English, so their placeholders are
// filled in; every other string shows as its key.
const EN = Object.fromEntries(Object.entries(require("../locales-default/en.json").fleet.compact).map(([k, v]) => ["fleet.compact." + k, v]));
const COMPACT_LINES = Object.fromEntries(["left", "elapsed", "took", "done_at", "stopped_at", "layer", "time_in", "ready", "ready_to_print"].map(k => ["fleet.compact." + k, EN["fleet.compact." + k]]));
const compactHarness = opts => makeHarness({ view: "compact", strings: COMPACT_LINES, ...opts });
const compact = (p, opts) => compactHarness(opts).card(p);
// The card without its "···" menu, i.e. what is shown on the card itself.
const withoutMenu = html => html.replace(/<div class="cc-menu"[\s\S]*?<\/div><\/div><\/div>/, "");
const menuOf = html => { const m = /<div class="cc-menu"[^>]*>([\s\S]*?)<\/div><\/div><\/div>/.exec(html); return m ? m[1] : null; };
const menuLabels = html => [...(menuOf(html) || "").matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map(m => m[1]);
const pillLabels = html => [...withoutMenu(html).matchAll(/class="btn-chip cc-pill"[^>]*><img[^>]*><span>([^<]*)</g)].map(m => m[1]);

test("printing: file name, time left and percentage, bar, one quiet line, Pause and Plate", () => {
  const html = compact(PRINTERS.printing);
  assert.match(html, /<div class="cc-file" title="Gear box v3\.gcode">Gear box v3\.gcode<\/div>/);
  assert.match(html, /<span class="cc-big" data-live="remaining">17h 27m<\/span>/, "fmtRemaining(52920, 0.457), the full card's Remaining");
  assert.match(html, /<span class="cc-big cc-pct" data-live="pct">45\.7%<\/span>/);
  assert.match(html, /<div class="prog-track cc-track"><div class="prog-fill cyan" data-live="bar" style="width:45\.7%;/);
  // Two parts; CSS puts the " · " between the ones that show.
  assert.match(html, /<div class="cc-quiet"><span class="cc-part"><span class="cc-val" data-live="elapsed">14h 42m<\/span> elapsed<\/span><span class="cc-part"><span class="cc-val" data-live="center-val">77\.0m<\/span><\/span><\/div>/);
  assert.deepEqual(pillLabels(html), ["printer.action_pause", "printer.action_plate"]);
  assert.match(html, /class="status-badge cc-badge cc-pulse"><span class="cc-dot" aria-hidden="true"><\/span>printer_status\.printing</);
  assert.doesNotMatch(html, /prog-time-label|stats-bar|afc-lane/, "none of the full card's parts");
});

test("paused: Resume and Plate, the numbers and bar in the paused colour, no pulse", () => {
  const html = compact(PRINTERS.paused);
  assert.deepEqual(pillLabels(html), ["printer.action_resume", "printer.action_plate"]);
  assert.match(html, /<div class="cc-headline cc-paused">/);
  assert.match(html, /<div class="prog-track cc-track amber"><div class="prog-fill amber" data-live="bar"/);
  assert.doesNotMatch(html, /cc-pulse/);
  assert.match(html, /style="--status-color:var\(--paused\)"/, "statusColorText()'s colour");
});

test("printing without a multi-object plate: Pause alone", () => {
  assert.deepEqual(pillLabels(compact({ ...PRINTERS.printing, plate: { total: 1, excluded: 0 } })), ["printer.action_pause"]);
});

test("complete: Done at the finish time, a full bar, took … · filament, Print and Reprint", () => {
  const html = compact(PRINTERS.complete);
  assert.match(html, /<span class="cc-big cc-state">09:12<\/span>/);
  assert.match(html, /<div class="prog-fill cc-fill-done" style="width:100%"><\/div>/);
  assert.match(html, /<span class="cc-part cc-lead">Done at <span class="cc-big cc-state">09:12<\/span><\/span>/);
  assert.match(html, /<div class="cc-quiet"><span class="cc-part">took <span class="cc-val" data-live="elapsed">17h 27m<\/span><\/span><span class="cc-part"><span class="cc-val" data-live="center-val">138\.6m<\/span><\/span><\/div>/);
  assert.deepEqual(pillLabels(html), ["printer.action_print", "printer.action_reprint"]);
});

test("idle: Ready, with no percentage, no bar and no dashes, with or without a last file", () => {
  for (const p of [PRINTERS.idle, PRINTERS.idleWithLastFile]) {
    const html = withoutMenu(compact(p));
    assert.match(html, /<div class="cc-ready">Ready<\/div>/);
    assert.doesNotMatch(html, /data-live="pct"|cc-track|—|cc-file/);
    assert.deepEqual(pillLabels(html), ["printer.action_print", "printer.action_preheat"]);
  }
});

test("Loaded outranks Complete and Cancelled, as on the badge: the staged file and Ready, not Done at", () => {
  for (const state of ["complete", "cancelled"]) {
    const html = compact({ ...PRINTERS.complete, state, queuedFile: { name: "Next.gcode", status: "ready" } });
    assert.match(html, /<div class="cc-file" title="Next\.gcode">Next\.gcode<\/div><div class="cc-ready">Ready to print<\/div>/, state);
    assert.doesNotMatch(html, /Done at|Stopped at|cc-fill-done/, state);
  }
});

test("Loaded (a staged file) names the file and says Ready to print; Maintenance is not called Ready", () => {
  const loaded = compact({ ...PRINTERS.idle, queuedFile: { name: "Next <job>.gcode", status: "ready" } });
  assert.match(loaded, /<div class="cc-file" title="Next &lt;job&gt;\.gcode">Next &lt;job&gt;\.gcode<\/div><div class="cc-ready">Ready to print<\/div>/);
  const maint = compact({ ...PRINTERS.idle, state: "maintenance" });
  assert.doesNotMatch(maint, /cc-ready/);
  assert.match(maint, /disabled data-id="7" data-start="1" title="printer\.action_maintenance_mode_title"/);
});

test("error: the printer's message in plain words, Stopped at … · … in, today's idle buttons, no tiles", () => {
  const html = compact(PRINTERS.error);
  assert.match(html, /<div class="cc-error">Heater extruder not heating at expected rate<\/div>/);
  assert.match(html, /<div class="cc-quiet"><span class="cc-part">Stopped at <span class="cc-val" data-live="pct">52\.0%<\/span><\/span><span class="cc-part"><span class="cc-val" data-live="elapsed">7h 20m<\/span> in<\/span><\/div>/);
  assert.doesNotMatch(html, /cc-tiles/);
  assert.deepEqual(pillLabels(html), ["printer.action_print", "printer.action_preheat"]);
});

test("error with a catalogued code: the catalogue's title, the code in the tooltip", () => {
  const h = compactHarness();
  h.run(`ERROR_CODES["0003-0523-0000-0021"]={t:"Nozzle heating failed", d:"Check the heater.", u:""}`);
  const html = h.card({ ...PRINTERS.error, errorCode: "0003-0523-0000-0021" });
  assert.match(html, /<div class="cc-error" title="fleet\.error_panel\.code_prefix \{&quot;code&quot;:&quot;0003-0523-0000-0021&quot;\}">Nozzle heating failed<\/div>/);
});

test("cancelled: the file and the Error card's quiet line, no Ready", () => {
  const html = compact({ ...PRINTERS.error, state: "cancelled", message: undefined });
  assert.match(html, /<div class="cc-file"/);
  assert.match(html, /<div class="cc-quiet"><span class="cc-part">Stopped at <span class="cc-val" data-live="pct">52\.0%<\/span><\/span><span class="cc-part"><span class="cc-val" data-live="elapsed">7h 20m<\/span> in<\/span><\/div>/);
  assert.doesNotMatch(html, /cc-ready|cc-error/);
});

test("stopped at: the layer when the percentage is 0, and only the parts that are known", () => {
  const cancelled = { ...PRINTERS.error, state: "cancelled", message: undefined, progress: 0, elapsed: 66000, layer: { current: 356, total: 551 } };
  assert.match(compact(cancelled), /<div class="cc-quiet"><span class="cc-part">Stopped at layer <span class="cc-val"><span data-live="layer-current">356<\/span><span data-live="layer-target">\/551<\/span><\/span><\/span><span class="cc-part"><span class="cc-val" data-live="elapsed">18h 20m<\/span> in<\/span><\/div>/);
  // No percentage and no layer: the time alone.
  assert.match(compact({ ...cancelled, layer: undefined }), /<div class="cc-quiet"><span class="cc-part" hidden>Stopped at <\/span><span class="cc-part"><span class="cc-val" data-live="elapsed">18h 20m<\/span> in<\/span><\/div>/);
  // Nothing known: no line at all.
  assert.doesNotMatch(compact({ ...cancelled, layer: undefined, elapsed: undefined }), /cc-quiet/);
});

test("a missing value is left out of its line, never shown as a dash", () => {
  const noFilament = compact({ ...PRINTERS.printing, filamentUsed: undefined });
  assert.match(noFilament, /<span class="cc-part" hidden><span class="cc-val" data-live="center-val">—<\/span><\/span>/);
  const noRemaining = compact({ ...PRINTERS.printing, progress: 0, elapsed: 0 });
  assert.match(noRemaining, /<span class="cc-part cc-lead" hidden>/, "no \"— left\"");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(css, /body\.compact \.cc-part\[hidden\]\{display:none;\}/);
  assert.match(css, /body\.compact \.cc-part:not\(\[hidden\]\) ~ \.cc-part:not\(\[hidden\]\)::before\{content:"\\00a0·\\00a0";\}/, "the separator only between parts that show");
});

test("offline: dimmed, the last-seen line, no buttons, no tiles, no state line", () => {
  const html = compact(PRINTERS.offline);
  assert.match(html, /^<div class="pcard cc-card offline"/);
  assert.match(html, /<span class="offline-info-seen" data-live="seen">fleet\.card\.offline_seen_today /);
  assert.doesNotMatch(html, /cc-foot|cc-more|cc-tiles|cc-line/);
});

test("updating/rebooting: the header and badge only", () => {
  const html = compact({ ...PRINTERS.printing, online: false, state: "updating" });
  assert.match(html, /printer_status\.updating/);
  assert.doesNotMatch(html, /cc-foot|cc-tiles|cc-big/);
});

// ---- header ----

test("brand as stored on one line, the transport only in its tooltip; the full name in the name's", () => {
  const html = compact({ ...PRINTERS.idle, brand: "FlashForge", transport: "moonraker", name: "AD5X <White>" });
  assert.match(html, /<div class="hdr-brand" title="FlashForge \(fleet\.card\.transport_moonraker\)">FlashForge<\/div>/);
  assert.match(html, /<div class="hdr-name" title="AD5X &lt;White&gt;">AD5X &lt;White&gt;<\/div>/);
});

test("a virtual printer says so on the brand line, so it is never taken for a real one", () => {
  assert.match(compact({ ...PRINTERS.idle, virtual: true }), /<div class="hdr-brand" title="SnapMaker · fleet\.card\.virtual">SnapMaker · fleet\.card\.virtual<\/div>/);
  assert.match(compact({ ...PRINTERS.idle, brand: "Test printer", virtual: true }), />Test printer · fleet\.card\.virtual</);
  // A transport stays in the tooltip, after the visible line.
  assert.match(compact({ ...PRINTERS.idle, virtual: true, transport: "moonraker" }), /title="SnapMaker · fleet\.card\.virtual \(fleet\.card\.transport_moonraker\)">SnapMaker · fleet\.card\.virtual</);
  assert.match(compact(PRINTERS.idle), /<div class="hdr-brand" title="SnapMaker">SnapMaker<\/div>/, "a real printer's line is the brand alone");
});

test("header: checkbox, brand, icons and badge on the first line; the name alone on the second", () => {
  const html = compact(PRINTERS.printing);
  assert.match(html, /<div class="top cc-top"><div class="cc-head"><label class="cam-select">[\s\S]*?<\/label><div class="hdr-brand" title="SnapMaker">SnapMaker<\/div><div class="card-right"><div class="card-pills">[\s\S]*?<\/div><span class="status-badge cc-badge[^"]*">[\s\S]*?<\/span><\/div><\/div><div class="hdr-name" title="U1 Left">U1 Left<\/div><\/div>/);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(css, /body\.compact \.cc-card \.top\.cc-top\{flex-direction:column;/);
  assert.match(css, /body\.compact \.cc-card \.hdr-name\{[^}]*white-space:nowrap; overflow:hidden; text-overflow:ellipsis;/, "a name too long for the whole line is still cut, with the title");
});

test("the badge and the state line take statusColorText()'s colour", () => {
  for (const [p, colour] of [[PRINTERS.printing, "--busy"], [PRINTERS.complete, "--complete"], [PRINTERS.idle, "--ok"], [PRINTERS.error, "--bad"], [PRINTERS.offline, "--ink-faint"]]) {
    assert.match(compact(p), new RegExp(`^<div class="pcard[^"]*" data-pid="7" style="--status-color:var\\(${colour}\\)">`), p.state);
  }
});

// ---- spool tiles ----

test("tiles: slot label and material, light fill gets dark text, the active one marked, an empty one dashed with its number", () => {
  const html = compact(PRINTERS.printing);
  const tiles = /<div class="cc-tiles" style="grid-template-columns:repeat\(4,minmax\(0,1fr\)\)">(.*?)<\/div>/.exec(html)[1];
  assert.match(tiles, /<button type="button" class="cc-tile on-light spool-click" data-unload-printer="7" data-unload-ext="0" style="background:#F2C200" title="fleet\.compact\.slot_title \{&quot;slot&quot;:&quot;1&quot;,&quot;material&quot;:&quot;PLA&quot;\}">1 PLA<\/button>/);
  assert.match(tiles, /class="cc-tile active spool-click" data-unload-printer="7" data-unload-ext="1" style="background:#101010"[^>]*>2 PETG</, "black: light text, and the active slot");
  assert.match(tiles, /<span class="cc-tile empty" title="fleet\.compact\.slot_empty_title \{&quot;slot&quot;:&quot;3&quot;\}">3<\/span>/);
  assert.match(tiles, /class="cc-tile on-light spool-click"[^>]*data-unload-ext="3" style="background:#FFFFFF"/, "white: dark text");
  assert.doesNotMatch(tiles, /yellow|#F2C200&quot;/, "no colour in the tooltip");
});

test("tiles use the lane's own label (Bambu's A2), and are plain when the printer can't unload", () => {
  const p = { ...PRINTERS.idle, capabilities: { ...caps, unloadFilament: false }, heads: [{ loaded: true, hex: "#2244FF", material: "PLA", label: "A1" }, { loaded: true, hex: "#22FF44", material: "PETG", label: "A2" }] };
  const html = compact(p);
  assert.match(html, /<span class="cc-tile active on-light" style="background:#22FF44" title="fleet\.compact\.slot_title \{&quot;slot&quot;:&quot;A2&quot;,&quot;material&quot;:&quot;PETG&quot;\}">A2 PETG<\/span>/);
  assert.match(html, /repeat\(2,/);
  assert.doesNotMatch(html, /spool-click/);
});

test("the tile text colour follows needsDarkText(): light fill dark text, dark fill light text", () => {
  const h = compactHarness();
  const tile = hex => h.run(`compactSpoolTilesHtml([{loaded:true,hex:${JSON.stringify(hex)},material:"PLA"}],null,1,false)`);
  for (const light of ["#FFFFFF", "#F2C200", "#E0E0E0"]) assert.match(tile(light), /cc-tile on-light/, light);
  for (const dark of ["#101010", "#1E3A8A", "#7F1D1D"]) assert.doesNotMatch(tile(dark), /on-light/, dark);
});

test("view-only: a tile is shown but not usable, as the full card's spool is", () => {
  assert.match(compact(PRINTERS.idle, { canAct: false }), /class="cc-tile on-light spool-click inert-action"/);
});

// ---- the "···" menu ----

test("the menu per state: the main actions, then Cancel print and E-Stop only while printing or paused", () => {
  assert.deepEqual(menuLabels(compact(PRINTERS.printing)), ["printer.action_pause", "printer.action_plate", "fleet.compact.cancel_print", "printer.action_estop"]);
  assert.deepEqual(menuLabels(compact(PRINTERS.paused)), ["printer.action_resume", "printer.action_plate", "fleet.compact.cancel_print", "printer.action_estop"]);
  assert.deepEqual(menuLabels(compact(PRINTERS.complete)), ["printer.action_print", "printer.action_reprint", "printer.action_preheat"], "Complete's Preheat is kept, in the menu");
  assert.deepEqual(menuLabels(compact(PRINTERS.idle)), ["printer.action_print", "printer.action_preheat"]);
  assert.deepEqual(menuLabels(compact(PRINTERS.error)), ["printer.action_print", "printer.action_preheat"]);
  assert.equal(menuOf(compact(PRINTERS.offline)), null, "no menu where today's card has no buttons");
  const busyMenu = menuOf(compact(PRINTERS.printing));
  assert.match(busyMenu, /<div class="cc-menu-sep" role="separator"><\/div><button type="button" class="cc-menu-item danger"/);
  assert.doesNotMatch(menuOf(compact(PRINTERS.idle)), /cc-menu-sep|danger/);
});

test("Cancel print and E-Stop are only in the menu, never on the card itself", () => {
  for (const p of [PRINTERS.printing, PRINTERS.paused]) {
    const card = withoutMenu(compact(p));
    assert.doesNotMatch(card, /data-act="cancel"|data-estop=/, p.state);
    assert.match(menuOf(compact(p)), /data-act="cancel"[\s\S]*data-estop="7"/);
  }
});

test("menu items carry the full card's own action attributes, so the same handler runs", () => {
  const busy = menuOf(compact(PRINTERS.printing));
  assert.match(busy, /role="menuitem" tabindex="-1"  data-ctl="7" data-act="pause" title="printer\.action_pause">/);
  assert.match(busy, /data-plate="7" title="printer\.action_plate_title \{&quot;done&quot;:3,&quot;total&quot;:4\}"/);
  assert.match(busy, /data-ctl="7" data-act="cancel"/);
  assert.match(busy, /data-estop="7" title="printer\.action_estop_title"/);
  const idle = menuOf(compact(PRINTERS.idle));
  assert.match(idle, /data-id="7" data-start="1" title="printer\.action_print_title_pick"/);
  assert.match(idle, /data-preheat="7" title="printer\.action_preheat"/);
});

test("view-only: every action is disabled with a title, on the card and in the menu", () => {
  for (const p of [PRINTERS.printing, PRINTERS.idle, PRINTERS.complete]) {
    const html = compact(p, { canAct: false });
    const buttons = [...html.matchAll(/<button type="button" class="(?:btn-chip cc-pill|cc-menu-item[^"]*)"([^>]*)>/g)].map(m => m[1]);
    assert.ok(buttons.length >= 3, p.state);
    for (const b of buttons) { assert.match(b, /\bdisabled\b/, b); assert.match(b, /title="/, b); }
  }
});

test("E-Stop on a printer that can't do one: disabled in the menu, with the reason", () => {
  const html = menuOf(compact({ ...PRINTERS.printing, capabilities: { ...caps, estop: false } }));
  assert.match(html, /disabled data-estop="7" title="printer\.action_estop_unsupported_title"/);
});

test("the ··· button: a labelled menu button tied to its menu", () => {
  const html = compact(PRINTERS.printing);
  assert.match(html, /<button type="button" class="cc-more" data-card-menu="7" aria-haspopup="menu" aria-expanded="false" aria-controls="ccm-7" aria-label="fleet\.compact\.menu_label \{&quot;name&quot;:&quot;U1 Left&quot;\}"/);
  assert.match(html, /<div class="cc-menu" id="ccm-7" role="menu" aria-label="[^"]+" hidden>/);
});

test("the menu is wired once at startup, after the card's own handler, and closes on Esc, Tab and outside clicks", () => {
  assert.match(appSrc, /  wireFleetCardEvents\(\);\n  wireCompactCardMenu\(\);\n/);
  const wire = appSrc.slice(appSrc.indexOf("function wireCompactCardMenu("), appSrc.indexOf("\n}", appSrc.indexOf("function wireCompactCardMenu(")));
  assert.match(wire, /e\.key==="Escape"\)\{ e\.preventDefault\(\); closeCompactCardMenu\(true\)/);
  assert.match(wire, /e\.key==="Tab"\)\{ closeCompactCardMenu\(false\)/);
  assert.match(wire, /addEventListener\("pointerdown"/);
  assert.match(wire, /ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End/);
});

// ---- status message ----

const STATUS_STRINGS = { ...COMPACT_LINES, "fleet.print.status_printing_on": "Printing on {printer}", "fleet.print.status_printing_on_mapped": "Printing on {printer} — heads mapped", "fleet.print.status_uploaded": "Uploaded", "fleet.queued.printing_status": "Printing {filename}" };
const withStatus = (p, cls, txt) => { const h = compactHarness({ strings: STATUS_STRINGS }); h.run(`CARD_STATUS.set("7",${JSON.stringify({ cls, txt })})`); return h.card(p); };

test("status message: \"Printing on Dummy#1\" is not shown on a paused (or printing) card, which already says so", () => {
  for (const p of [PRINTERS.paused, PRINTERS.printing]) {
    assert.match(withStatus(p, "pstatus ok", "Printing on Dummy#1"), /<div class="pstatus" id="pst-7"><\/div>/, p.state);
    assert.match(withStatus(p, "pstatus ok", "Printing on Dummy#1 — heads mapped"), /<div class="pstatus" id="pst-7"><\/div>/, p.state);
  }
  // "Uploaded" on a card that says Loaded.
  assert.match(withStatus({ ...PRINTERS.idle, queuedFile: { name: "Next.gcode", status: "ready" } }, "pstatus ok", "Uploaded"), /<div class="pstatus" id="pst-7"><\/div>/);
});

test("status message: action feedback, errors and anything else are still shown", () => {
  assert.match(withStatus(PRINTERS.paused, "pstatus work", "Pausing…"), /<div class="pstatus work" id="pst-7">Pausing…<\/div>/);
  assert.match(withStatus(PRINTERS.paused, "pstatus err", "Printing on Dummy#1 failed: timeout"), /<div class="pstatus err" id="pst-7">Printing on Dummy#1 failed: timeout<\/div>/);
  assert.match(withStatus(PRINTERS.paused, "pstatus ok", "Bed set to 60°"), /<div class="pstatus ok" id="pst-7">Bed set to 60°<\/div>/, "real feedback, not the state");
  // The same message where the card does not say it: shown.
  assert.match(withStatus(PRINTERS.idle, "pstatus ok", "Printing on Dummy#1"), /<div class="pstatus ok" id="pst-7">Printing on Dummy#1<\/div>/);
  assert.match(withStatus(PRINTERS.idle, "pstatus ok", "Uploaded"), /<div class="pstatus ok" id="pst-7">Uploaded<\/div>/, "not Loaded");
});

test("status message: the Full card is unchanged, it still shows the message", () => {
  const h = makeHarness({ view: "regular", layout: "classic" });
  h.run(`CARD_STATUS.set("11",{cls:"pstatus ok",txt:"Printing on U1 Left"})`);
  assert.match(h.card(goldenPrinters.printing), /<div class="pstatus ok" id="pst-11">Printing on U1 Left<\/div>/);
});

// ---- the upload strip ----

const uploading = (h, extra = "") => h.run(`UPLOADS.set("7",{state:"uploading",origin:"local",jobId:"j1",name:"Gear <box>.gcode",pct:34,sent:15600000,total:46000000${extra}})`);

test("upload strip: arrow, the file name (full name in the title), percentage, ✕ to cancel, over the bar; under the header", () => {
  const h = compactHarness();
  uploading(h);
  h.run(`UPLOAD_CANCEL.set("7","j1")`);
  const html = h.card(PRINTERS.idle);
  assert.match(html, /<div class="cc-line"><\/div><div class="upload-strip cc-upload"><svg class="cc-upload-icon"/);
  assert.match(html, /<span class="cc-upload-name" title="Gear &lt;box&gt;\.gcode">Gear &lt;box&gt;\.gcode<\/span><span class="cc-upload-pct" data-live="upload-pct">34%<\/span>/);
  assert.match(html, /<button type="button" class="cc-upload-cancel" data-cancel-upload="j1" data-printer="7" aria-label="fleet\.print\.cancel_upload" title="fleet\.print\.cancel_upload"><svg/);
  assert.match(html, /<div class="upload-strip-bar"><div class="upload-strip-fill" data-live="upload-bar" style="width:34%"><\/div><\/div><\/div>/);
  assert.doesNotMatch(html, /fleet\.upload\.uploading/, "the name, not \"Uploading: …\"");
  assert.match(html, /<div class="cc-ready">Ready<\/div>/, "the headline stays");
});

test("upload strip: ✕ disabled with the reason until the job can be cancelled, and for view-only users", () => {
  const h = compactHarness();
  uploading(h);
  assert.match(h.card(PRINTERS.idle), /data-cancel-upload="" data-printer="7" aria-label="fleet\.upload\.cancel_not_yet_title" title="fleet\.upload\.cancel_not_yet_title" disabled>/);
  const v = compactHarness({ canAct: false });
  uploading(v);
  v.run(`UPLOAD_CANCEL.set("7","j1")`);
  assert.match(v.card(PRINTERS.idle), /title="fleet\.upload\.cancel_view_only_title" disabled>/);
  // Another tab's upload: cancellable once the fleet data says so.
  const f = compactHarness();
  uploading(f, `,origin:"fleet",cancellable:true`);
  assert.match(f.card(PRINTERS.idle), /data-cancel-upload="j1" data-printer="7" aria-label="fleet\.print\.cancel_upload"/);
});

test("upload strip: a failed upload keeps the shared strip, with Retry and Dismiss", () => {
  const h = compactHarness();
  h.run(`UPLOADS.set("7",{state:"failed",origin:"local",jobId:"j1",name:"Gear.gcode",pct:40,reason:"Lost connection"})`);
  const html = h.card(PRINTERS.idle);
  assert.match(html, /<div class="upload-strip failed">/);
  assert.match(html, /data-upload-retry="7"[\s\S]*data-upload-dismiss="7"/);
});

test("paintUploadProgress moves the compact strip's percentage and bar (same hooks)", () => {
  const paint = appSrc.slice(appSrc.indexOf("function paintUploadProgress("), appSrc.indexOf("\n}", appSrc.indexOf("function paintUploadProgress(")));
  assert.match(paint, /'\[data-live="upload-pct"\]'/);
  assert.match(paint, /'\[data-live="upload-bar"\]'/);
});

// ---- layout ----

test("the spools and the buttons sit together at the bottom of the card", () => {
  const html = compact(PRINTERS.printing);
  assert.match(html, /<div class="pstatus" id="pst-7"><\/div><div class="cc-bottom"><div class="cc-tiles"[^>]*>[\s\S]*?<\/div><div class="cc-foot">[\s\S]*<\/div><\/div><\/div><\/div>$/, "the status message above the group, so it can't push the buttons");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(css, /body\.compact \.cc-bottom\{[^}]*margin-top:auto;/);
  assert.doesNotMatch(css, /body\.compact \.cc-foot\{[^}]*margin-top:auto/, "the group is anchored, not the buttons alone");
});

test("offline: the last-seen line may take two lines before it is cut", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(css, /body\.compact \.cc-offline \.offline-info-seen\{white-space:normal;[^}]*-webkit-line-clamp:2;/);
});

// ---- live values ----

test("data-live hooks on the compact card are patched by updateFleetCardLiveValues, without a rebuild", () => {
  const h = compactHarness();
  for (const p of [PRINTERS.printing, PRINTERS.complete, PRINTERS.error, PRINTERS.offline]) {
    const html = h.card(p);
    const hooks = [...html.matchAll(/data-live="([^"]+)"/g)].map(m => m[1]);
    const els = {};
    const card = { querySelector: sel => { const m = /^\[data-live="([^"]+)"\]$/.exec(sel); if (!m || !hooks.includes(m[1])) return null; return els[m[1]] || (els[m[1]] = { textContent: "", style: {} }); } };
    h.ctx.__card = card;
    h.ctx.__p = { ...p, progress: 0.5, elapsed: 3600, filamentUsed: 80000, lastSeenAt: p.lastSeenAt };
    h.run("updateFleetCardLiveValues(__card, __p)");
    for (const hook of hooks) assert.ok(els[hook], `${p.state}: ${hook} was written`);
    if (hooks.includes("pct")) assert.equal(els.pct.textContent, "50.0%");
    if (hooks.includes("remaining")) assert.equal(els.remaining.textContent, "1h 00m");
    if (hooks.includes("elapsed")) assert.equal(els.elapsed.textContent, "1h 00m");
    if (hooks.includes("center-val")) assert.equal(els["center-val"].textContent, "80.0m");
    if (hooks.includes("bar")) assert.equal(els.bar.style.width, "50.0%");
  }
});

test("a part whose value arrives later is shown by the live update; one that goes missing is hidden", () => {
  const h = compactHarness();
  h.card({ ...PRINTERS.printing, filamentUsed: undefined });
  // A card with one part holding the filament value, hidden at build.
  const value = { textContent: "—", style: {} };
  const part = { hidden: true, querySelector: () => value };
  const card = { classList: { contains: c => c === "cc-card" }, querySelector: sel => (sel === '[data-live="center-val"]' ? value : null), querySelectorAll: () => [part] };
  h.ctx.__card = card;
  h.ctx.__p = { ...PRINTERS.printing, filamentUsed: 12300 };
  h.run("updateFleetCardLiveValues(__card, __p)");
  assert.equal(value.textContent, "12.3m");
  assert.equal(part.hidden, false);
  h.ctx.__p = { ...PRINTERS.printing, filamentUsed: undefined };
  h.run("updateFleetCardLiveValues(__card, __p)");
  assert.equal(part.hidden, true);
});

test("the live update leaves Full and Camera cards exactly as built: the compact step never runs on them", () => {
  // Every golden card (the same printers the scope guard pins), built the
  // real way, then live-updated with new values. The card's lookups for
  // data-live hooks find nothing here (no DOM), so any change to the card
  // itself, or any call to querySelectorAll (which only the compact step
  // makes), would come from the new line.
  for (const view of ["full-classic", "full-v2", "camera"]) {
    for (const state of Object.keys(goldenPrinters)) {
      const h = makeHarness(golden.VIEWS[view]);
      h.ctx.__p = goldenPrinters[state];
      const el = h.run("buildCardHtml(__p, [], false)");
      assert.ok(!el.classList.contains("cc-card"), `${view} ${state} is not a compact card`);
      const before = JSON.stringify({ cls: el.className, html: el.innerHTML, data: el.dataset, props: el.props });
      let queriedAll = 0;
      el.querySelector = () => null;
      el.querySelectorAll = () => { queriedAll++; return []; };
      h.ctx.__card = el;
      h.ctx.__p = { ...goldenPrinters[state], progress: 0.9, elapsed: 99999, filamentUsed: 123456 };
      h.run("updateFleetCardLiveValues(__card, __p)");
      assert.equal(queriedAll, 0, `${view} ${state}: the compact step ran`);
      assert.equal(JSON.stringify({ cls: el.className, html: el.innerHTML, data: el.dataset, props: el.props }), before, `${view} ${state}`);
    }
  }
});

test("List view never goes through the card grid's live update or reconcile", () => {
  const code = appSrc.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  const calls = [...code.matchAll(/updateFleetCardLiveValues\(/g)].length;
  assert.equal(calls, 2, "the definition and one call");
  const reconcile = appSrc.slice(appSrc.indexOf("function reconcileFleetCards("), appSrc.indexOf("\n}", appSrc.indexOf("function reconcileFleetCards(")));
  assert.match(reconcile, /updateFleetCardLiveValues\(el, p\)/, "the one call is the card grid's reuse path");
  const list = code.slice(code.indexOf("function renderFleetListRows("), code.indexOf("\n}", code.indexOf("function renderFleetListRows(")));
  assert.doesNotMatch(list, /updateFleetCardLiveValues|reconcileFleetCards/);
});

test("the live update leaves other views' cards alone (no classList.contains('cc-card'))", () => {
  const fn = appSrc.slice(appSrc.indexOf("function updateFleetCardLiveValues("), appSrc.indexOf("\n}", appSrc.indexOf("function updateFleetCardLiveValues(")));
  assert.match(fn, /if\(card\.classList && card\.classList\.contains\("cc-card"\)\) syncCompactParts\(card\);$/);
});

// ---- strings and CSS ----

test("every compact string exists in English and Spanish, with the same placeholders", () => {
  const en = require("../locales-default/en.json").fleet.compact;
  const es = require("../locales-default/es.json").fleet.compact;
  const used = [...new Set([...appSrc.matchAll(/"fleet\.compact\.([a-z_]+)"/g)].map(m => m[1]))];
  const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
  for (const k of used) {
    assert.ok(en[k], "en " + k); assert.ok(es[k], "es " + k);
    assert.equal(ph(es[k]), ph(en[k]), k);
  }
  assert.deepEqual(Object.keys(en).sort(), used.sort(), "no unused keys");
});

test("no ALL CAPS on the compact card: the badge and brand undo the shared uppercase", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(css, /body\.compact \.cc-badge\{[^}]*text-transform:none/);
  assert.match(css, /body\.compact \.cc-card \.hdr-brand\{[^}]*text-transform:none/);
});

test("every compact card rule is scoped to Compact view", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  const start = css.indexOf("/* ---- Compact card (buildCompactCardHtml");
  const end = css.indexOf("/* ---- Camera view ---- */");
  assert.ok(start > 0 && end > start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of block.split("}")) {
    const sel = rule.split("{")[0].trim();
    if (!sel || /^@keyframes|^@media|^\d+%|^[0-9,%]+$/.test(sel)) continue;
    for (const one of sel.split(",")) {
      assert.match(one.trim(), /^(\[data-theme="light"\] )?body\.compact /, one.trim());
    }
  }
});

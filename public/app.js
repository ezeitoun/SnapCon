

// entry.t/entry.d/entry.u (the Snapmaker catalog itself, error-codes.js) are
// permanently out of i18n scope — left exactly as authored. Only the
// fallback used when a code has NO catalog entry is SnapCon-owned text.
function lookupKlipperError(code, msg){
  if(!code&&!msg) return null;
  const entry=code?ERROR_CODES[code]:null;
  // An entry with an EMPTY description defers to the live message. Only the
  // two KLIPPER_* entries use that; all 413 Snapmaker codes carry curated
  // text and are unaffected (pinned by test/klipperErrorPanel.test.js).
  return{code, title:entry?entry.t:(code||t("fleet.error_panel.unknown_error_title")), description:(entry&&entry.d)||msg||code||'', url:entry?entry.u:''};
}
const $ = id => document.getElementById(id);
const VERSION = "0.7.0";
// A session that expired mid-use (idle timeout, or an Admin deleted the
// account) shows the login overlay again on the next call rather than
// leaving the UI silently broken.
// LAST_LOGIN_AT guards against a request that was already in flight when the
// overlay was showing: if it resolves with a stale 401 just after a fresh
// login succeeds, this skips re-triggering the overlay on top of a session
// that's actually valid again. A genuine mid-session expiry is always far
// more than a second past the last login, so it's unaffected.
let LAST_LOGIN_AT=0;
function checkAuthFailure(r){ if(r.status===401 && USERS_ENABLED && Date.now()-LAST_LOGIN_AT>1000){ CURRENT_USER=null; showLoginOverlay(); } return r; }
const getJSON = url => fetch(url).then(r => { checkAuthFailure(r); return r.json(); });
const postJSON = (url, data) => fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)}).then(r => { checkAuthFailure(r); return r; });

// Per-print options — pfilemodal ("Print from printer") and sendmodal
// ("Send to Printers") both render a checkbox per entry whose `cap` is true
// on the target printer('s connector capabilities), so a brand with no
// SET_PRINT_PREFERENCES equivalent (everything but snapmaker-u1-klipper,
// today) simply shows none of these.
// labelKey text intentionally preserves this control's own existing
// title-case wording ("Flow Calibration") — distinct from Quick Print's own
// QP_OPT_DEFS below, which already used different sentence-case wording
// ("Flow calibration") before this phase; not unified since that would be
// an unrequested copy change beyond localization, not a translation one.
const PRINT_OPT_DEFS = [
  { key: "flowCalibrate", cap: "flowCalibration", labelKey: "fleet.modal.print_opts.flow_calibration" },
  { key: "timelapse", cap: "timelapse", labelKey: "fleet.modal.print_opts.timelapse" },
  { key: "autoLevel", cap: "autoLevel", labelKey: "fleet.modal.print_opts.auto_leveling" }
];
// Same switch-row/switch-input markup as switchHtml() (see that function's
// own comment for why it's a real <input type=checkbox role=switch>, not a
// div) — not reusing switchHtml() itself since it has no way to attach the
// data-popt hook these need for wiring. idPrefix keeps ids unique between
// pfileOpts and sendOpts, which both exist in the DOM at once (one just
// hidden), so a bare "flowCalibrate" id in both would collide.
function printOptsHtml(caps, prefs, idPrefix) {
  return PRINT_OPT_DEFS.filter(o => caps && caps[o.cap]).map(o => {
    const id = idPrefix + "-" + o.key;
    return `<label class="switch-row" for="${esc(id)}">`+
      `<input type="checkbox" role="switch" id="${esc(id)}" class="switch-input" data-popt="${o.key}"${prefs[o.key] ? " checked" : ""}>`+
      `<span class="switch-text"><span class="switch-label">${esc(t(o.labelKey))}</span></span>`+
    `</label>`;
  }).join("");
}
let FILES = [], FOLDERS = [], CURRENT_SUB = "", SELECTED = null, MAP = null, FLEET = [], MAPSEL = {};
// Multi-select state for the file manager (shift/ctrl-click, Explorer-style)
// — keyed by the same "/"-joined relative path used everywhere else
// (CURRENT_SUB+"/"+name), so a selected file is unambiguous even once a
// search spans multiple folders.
let SELECTED_FILES = new Set();
// The last plain- or ctrl-clicked file — a shift-click ranges from here to
// the newly clicked row, exactly like Explorer/Finder.
let SELECT_ANCHOR = null;
let SEARCH_RESULTS = null; // non-null while the search box has a query — replaces the normal folder view
let USE_T_NOTATION = false, FILAMENT_COST = 0, ELECTRICITY_RATE = 0, CURRENCY = "$";
let SYSTEM_DEFAULT_LOCALE = "en";
let ALLOW_MAPPING = true, SUGGEST_MATCHING = true;
let RA_POLL_TIMER = null, RA_INFLIGHT = false;
// Printer "Connector" types + their capabilities, fetched once from the
// server (single source of truth — connectors/index.js) instead of a
// hardcoded list duplicated in this file.
let CONNECTOR_TYPES = [];
async function loadConnectorTypes(){
  try{ CONNECTOR_TYPES=await getJSON("/api/connectors"); }catch{ CONNECTOR_TYPES=[]; }
}
function connectorCaps(type){
  return (CONNECTOR_TYPES.find(c=>c.type===type)||{}).capabilities||{};
}
// The one connector whose Brand field the user may type into: Klipper/
// Moonraker is a protocol many vendors speak (Voron, Ratrig, a self-built
// CoreXY), so "Klipper" names the connector, not the machine's maker. Every
// other connector IS a brand, so its Brand stays derived and read-only.
// The server enforces the same rule at save time — this constant only keeps
// the UI in step with it.
const BRAND_EDITABLE_CONNECTOR="klipper-moonraker";
// True only for a brand string SnapCon itself derives from a connector.
// A generic-Klipper printer with a typed brand ("Voron") is deliberately
// NOT one of these — see isCompatiblePrinter(), which treats an unknown
// brand as "can't tell" rather than a mismatch.
function isKnownConnectorBrand(brand){
  const b=String(brand||"").trim().toLowerCase();
  return !!b&&CONNECTOR_TYPES.some(c=>String(c.brand||"").trim().toLowerCase()===b);
}

// ---- User Access Management: session state + role helpers ----
// Both hard-return true when USERS_ENABLED is false, so every gated call site
// below is correct with zero enabled/disabled branching at the call site.
let USERS_ENABLED = false, CURRENT_USER = null;
function isAdmin(){ return !USERS_ENABLED || (CURRENT_USER && CURRENT_USER.role==='admin'); }
function canAct(){ return !USERS_ENABLED || (CURRENT_USER && (CURRENT_USER.role==='regular'||CURRENT_USER.role==='admin')); }

// Groups (Audit feature): loaded fresh whenever Settings opens, since both
// the Users tab's Groups modal and the Printers tab's Access checklist read
// from this same cache rather than each fetching their own copy.
let GROUPS = [];
const GROUP_EVERYONE_ID = "grp_everyone";
async function loadGroupsUI(){
  try{ GROUPS = await getJSON("/api/groups"); }
  catch{ GROUPS = []; }
  // Every already-rendered Printers-tab row baked its Access checklist into
  // static HTML at row-creation time — it has no way to notice the group
  // list changed elsewhere (e.g. a group added from the Users tab's Groups
  // modal) unless something explicitly re-renders it, so do that here on
  // every refresh rather than only at initial page load.
  refreshAllPrinterGroupChecklists();
}
function refreshAllPrinterGroupChecklists(){
  document.querySelectorAll("#setPrinters .prow").forEach(row=>{
    const list=row.querySelector(".pgroups-list");
    if(!list) return;
    const checked=[...list.querySelectorAll(".pgroups-chk:checked")].map(c=>c.value);
    list.innerHTML=groupsChecklistHtml(checked);
    list.querySelectorAll(".pgroups-chk").forEach(el=>{
      el.addEventListener("input", markPrintersDirty);
      el.addEventListener("change", markPrintersDirty);
    });
  });
}

// ---- Queue Management: feature flag + Printer Pools cache, loaded
// fresh whenever Settings opens (same convention as GROUPS). ----
let QUEUE_MANAGEMENT_ENABLED = false;
let PRINTER_POOLS = [];
let QUEUE_STORE_STATUS = { storeDegraded: false, storeStoppedByAdmin: false, queueStoreRecoveryRequired: false };
async function loadQueueManagementUI(){
  try{
    const status = await getJSON("/api/queue-management/status");
    QUEUE_MANAGEMENT_ENABLED = !!status.enabled;
    QUEUE_STORE_STATUS = status.store || QUEUE_STORE_STATUS;
    $("setQueueEnabled").checked = QUEUE_MANAGEMENT_ENABLED;
    $("queueModeRow").style.display = QUEUE_MANAGEMENT_ENABLED ? "" : "none";
    $("printerPoolsCard").style.display = QUEUE_MANAGEMENT_ENABLED ? "" : "none";
  }catch{ QUEUE_MANAGEMENT_ENABLED = false; }
  try{ PRINTER_POOLS = await getJSON("/api/printer-pools"); }
  catch{ PRINTER_POOLS = []; }
  // Printer -> pool assignments can change server-side without this
  // client's PRINTERS_CFG snapshot knowing — a bulk auto-assign to Default
  // Manual the moment the feature gets enabled, or a reassignment saved
  // from a different tab/session. Patch printerPoolId back in from a
  // fresh /api/config read rather than trusting the stale array (same class
  // of bug already fixed once for the Access-groups checklist).
  if(QUEUE_MANAGEMENT_ENABLED && isAdmin()){
    try{
      const cfg = await getJSON("/api/config");
      (cfg.printers||[]).forEach(p=>{
        const entry=PRINTERS_CFG.find(x=>x.id===p.id);
        if(entry) entry.printerPoolId=p.printerPoolId;
      });
    }catch{}
  }
  renderQueueStoreWarning();
  renderPrinterPoolsList();
  refreshAllPrinterPoolDropdowns();
  document.querySelectorAll("[data-queue-section]").forEach(el=>{ el.style.display = QUEUE_MANAGEMENT_ENABLED ? "" : "none"; });
  // applyRoleUI() is the authority for queueBtn's visibility (enablement +
  // whether Settings/the Queue dashboard is currently open) — this runs
  // async, resolving after Settings has already opened, so it must defer to
  // that rather than unconditionally showing the button out from under it.
  applyRoleUI();
}
function printerPoolOptionsHtml(selectedId){
  if(!PRINTER_POOLS.length) return `<option value="">${t("settings.printers.pool_none_yet_option")}</option>`;
  return `<option value="">${t("settings.printers.pool_none_option")}</option>`+PRINTER_POOLS.map(p=>`<option value="${esc(p.id)}" ${p.id===selectedId?"selected":""}>${esc(p.name)}</option>`).join("");
}
// Reads the selected value from PRINTERS_CFG (the source of truth once
// loadQueueManagementUI has resynced it), not from whatever the dropdown's
// DOM happened to already show — this field self-saves immediately on
// change, so there's never a legitimate "unsaved local edit" to preserve.
function refreshAllPrinterPoolDropdowns(){
  document.querySelectorAll("#setPrinters .prow").forEach(row=>{
    const sel=row.querySelector(".pprinterpool");
    if(!sel) return;
    const entry=PRINTERS_CFG.find(p=>p.id===row.dataset.printerId);
    sel.innerHTML=printerPoolOptionsHtml(entry?entry.printerPoolId:sel.value);
  });
}

// Maps additive `code` fields from /api/queue*, /api/printer-pools*, and
// /api/queue-store/* (see server.js) to translation keys. unknown_printer/
// unknown_pool reuse the exact keys already established in the Printers
// phase's /api/printer-pool route — same code, same text, one translation.
// Any code not listed (or absent — raw connector/filesystem/network
// diagnostics) falls back to the raw error text, same precedent as every
// other phase.
const QUEUE_ERROR_KEYS={
  unknown_printer:"settings.printers.pool_error_unknown_printer",
  unknown_pool:"settings.printers.pool_error_unknown_pool",
  no_printer_access:"queue.error_no_printer_access",
  pool_not_found:"queue.error_pool_not_found",
  pool_name_required:"queue.error_pool_name_required",
  reset_confirm_mismatch:"queue.error_reset_confirm_mismatch",
  monitor_only:"settings.printers.pool_error_monitor_only"
};
function queueErrorText(d,fallback){
  if(d&&d.code==="queue_save_failed") return d.detail?t("queue.error_queue_save_failed_detail",{detail:d.detail}):t("queue.error_queue_save_failed");
  return (d&&d.code&&QUEUE_ERROR_KEYS[d.code])?t(QUEUE_ERROR_KEYS[d.code]):fallback;
}
function renderQueueStoreWarning(){
  const card=$("queueStoreWarningCard"), box=$("queueStoreWarning");
  if(!card||!box) return;
  const s=QUEUE_STORE_STATUS;
  if(!QUEUE_MANAGEMENT_ENABLED || (!s.storeDegraded && !s.storeStoppedByAdmin && !s.queueStoreRecoveryRequired)){
    card.style.display="none"; return;
  }
  card.style.display="";
  if(s.queueStoreRecoveryRequired){
    box.innerHTML=`<div class="settings-warning-title">${t("queue.recovery_required_title")}</div>`+
      `<div>${t("queue.recovery_required_body")}</div>`+
      `<div style="margin-top:10px;display:flex;gap:8px;align-items:center">`+
      `<input class="field" id="queueResetConfirm" placeholder="${esc(t("queue.reset_confirm_placeholder"))}" style="max-width:200px">`+
      `<button class="btn ghost danger" id="queueAckResetBtn">${t("queue.reset_button")}</button>`+
      `<span class="pstatus" id="queueAckResetStatus"></span>`+
      `</div>`;
    $("queueAckResetBtn").addEventListener("click",async()=>{
      const st=$("queueAckResetStatus");
      st.className="pstatus work"; st.textContent=t("queue.resetting");
      try{
        const r=checkAuthFailure(await postJSON("/api/queue-store/acknowledge-reset",{confirm:$("queueResetConfirm").value}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
        await loadQueueManagementUI();
      }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
    });
    return;
  }
  const parts=[];
  if(s.storeDegraded) parts.push(`<div>${t("queue.store_degraded_line")}</div>`);
  if(s.storeStoppedByAdmin) parts.push(`<div>${t("queue.store_stopped_by_admin_line")}</div>`);
  box.innerHTML=`<div class="settings-warning-title">${t("queue.needs_attention_title")}</div>`+parts.join("")+
    `<div style="margin-top:10px;display:flex;gap:8px">`+
    (s.storeDegraded?`<button class="btn ghost" id="queueRetrySaveBtn">${t("queue.retry_save_button")}</button>`:"")+
    (s.storeStoppedByAdmin?`<button class="btn ghost" id="queueResumeAllBtn">${t("queue.resume_all_queues_button")}</button>`:`<button class="btn ghost" id="queueStopAllBtn">${t("queue.stop_all_queues_button")}</button>`)+
    `<span class="pstatus" id="queueStoreActionStatus"></span>`+
    `</div>`;
  if($("queueRetrySaveBtn")) $("queueRetrySaveBtn").addEventListener("click",()=>queueStoreAction("/api/queue-store/retry-save"));
  if($("queueResumeAllBtn")) $("queueResumeAllBtn").addEventListener("click",()=>queueStoreAction("/api/queue-store/resume-all"));
  if($("queueStopAllBtn")) $("queueStopAllBtn").addEventListener("click",()=>queueStoreAction("/api/queue-store/stop-all"));
}
async function queueStoreAction(url){
  const st=$("queueStoreActionStatus");
  if(st){ st.className="pstatus work"; st.textContent=t("queue.working"); }
  try{
    const r=checkAuthFailure(await postJSON(url,{}));
    const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
    await loadQueueManagementUI();
  }catch(e){ if(st){ st.className="pstatus err"; st.textContent=e.message; } }
}

const POOL_TYPE_LABEL_KEYS={ manual:"queue.pool_type_manual" };
function poolTypeLabel(type){ return POOL_TYPE_LABEL_KEYS[type]?t(POOL_TYPE_LABEL_KEYS[type]):type; }
function renderPrinterPoolsList(){
  const list=$("printerPoolsList");
  if(!list) return;
  list.innerHTML=PRINTER_POOLS.map(p=>{
    const isDefault=p.isDefault;
    return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px" data-printerpool="${esc(p.id)}">`+
      `<input class="field printerpool-rename" value="${esc(p.name)}" maxlength="40" ${isDefault?"disabled":""} style="flex:1">`+
      `<span class="pi-lbl" style="flex:none">${esc(poolTypeLabel(p.type))}</span>`+
      (isDefault?"":`<button type="button" class="btn ghost printerpool-delete" title="Delete pool" data-i18n-title="queue.delete_pool_title">×</button>`)+
      `</div>`;
  }).join("");
  list.querySelectorAll(".printerpool-rename").forEach(inp=>{
    const orig=inp.value;
    inp.addEventListener("change",async()=>{
      const id=inp.closest("[data-printerpool]").dataset.printerpool;
      const name=inp.value.trim();
      if(!name||name===orig){ inp.value=name||orig; return; }
      try{
        const r=checkAuthFailure(await fetch("/api/printer-pools/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
        await loadQueueManagementUI();
      }catch(e){ alert(e.message); inp.value=orig; }
    });
  });
  list.querySelectorAll(".printerpool-delete").forEach(btn=>{
    btn.addEventListener("click",async()=>{
      const id=btn.closest("[data-printerpool]").dataset.printerpool;
      const p=PRINTER_POOLS.find(x=>x.id===id);
      if(!confirm(t("queue.delete_pool_confirm",{name:p?p.name:""}))) return;
      try{
        const r=checkAuthFailure(await fetch("/api/printer-pools/"+id,{method:"DELETE"}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
        await loadQueueManagementUI();
      }catch(e){ alert(e.message); }
    });
  });
}

// ---- /orca/<printer name> deep link — "_" = space, case-insensitive — shows
// only that printer's fleet card. Read once at load; the path doesn't change
// within a session.
const URL_PRINTER_FILTER = (() => {
  const m = location.pathname.match(/^\/orca\/(.+)$/i);
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ').trim().toLowerCase() : null;
})();

// ---- File list sort ----
let FILE_SORT = localStorage.getItem('snapcon-filesort') || 'new';
const FILE_SORTS = {
  new:   (a,b)=>b.mtime-a.mtime,
  old:   (a,b)=>a.mtime-b.mtime,
  az:    (a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}),
  za:    (a,b)=>b.name.localeCompare(a.name,undefined,{sensitivity:'base'}),
  big:   (a,b)=>b.size-a.size,
  small: (a,b)=>a.size-b.size
};
const FILE_SORT_LABELS = { new:'Newest', old:'Oldest', az:'A–Z', za:'Z–A', big:'Largest', small:'Smallest' };
// Full-sentence-per-mode title keys (not "Sort: " + a translated word) so a
// translation never has to reassemble a sentence out of fragments — same
// reasoning as every other composed-title/confirm conversion in this phase.
const FILE_SORT_TITLE_KEYS = { new:'global.file_sort.title_new', old:'global.file_sort.title_old', az:'global.file_sort.title_az', za:'global.file_sort.title_za', big:'global.file_sort.title_big', small:'global.file_sort.title_small' };

function applyFileSortUI(){
  Object.keys(FILE_SORT_LABELS).forEach(k=>{
    const el = $('fsc-'+k);
    if(el) el.textContent = FILE_SORT === k ? '✓' : '';
  });
  $('fileSortBtn').title = t(FILE_SORT_TITLE_KEYS[FILE_SORT] || FILE_SORT_TITLE_KEYS.new);
}

// ---- Camera view: status tabs, tag filter, multi-select + bulk actions ----
// All scoped to VIEW_MODE==='camera' only — switching back to regular/compact
// always shows the full, unfiltered fleet with no selection UI at all.
let CAM_TAB = 'all'; // 'all' | 'printing' | 'attention' | 'idle' | 'offline'
let CAM_TAG_FILTER = '';
let CAM_SELECTED = new Set();
// Settings tab's "Stagger camera refresh across printers" — default true,
// kept in sync with the checkbox at both load and save (same convention as
// ALLOW_MAPPING/SUGGEST_MATCHING). See mountCamShot()'s staggerOffset for
// why this matters at real fleet sizes: without it, every camera-capable
// printer's refresh becomes due at the same instant, since they're all
// mounted in the same renderFleet() pass.
let CAM_STAGGER = true;
function camBucket(p){
  if(!p.online) return 'offline';
  if(p.errorCode||p.message) return 'attention';
  if(p.state==='printing'||p.state==='paused') return 'printing';
  return 'idle'; // idle, complete, cancelled, maintenance
}
// Shared by the card grid and the list-view table — one source of truth for
// the status-badge color/label mapping so the two render paths can't drift.
// statusTxt is already-translated presentation text (t("printer_status.*")) —
// the underlying semantic state driving every branch here (p.online,
// p.state, p.queuedFile.status) is untouched and remains what every real
// caller (sortedFleet's STATUS_RANK, search filtering, etc.) keys off of.
// No caller may compare statusTxt against an English literal for logic —
// verified against every current call site during this phase's audit.
// Client-side, per-initiator status-badge override while THIS browser tab's
// own pollJob() is mid-"mapping" phase for a printer (e.g. a real bed-level
// pass on Creality) — the printer's own reported state stays "standby" the
// whole time (Klipper's print_stats only reflects a queued print job, not a
// pre-print macro), so without this the badge would misleadingly keep
// saying "Idle"/"Loaded" while a multi-minute physical operation is
// actually running. Purely local UI state, same limitation the existing
// pstatus/send-row text already has: another browser tab watching the same
// fleet won't see it, only the tab that triggered the action.
const STATUS_OVERRIDE = new Map(); // String(printer id) -> {statusColor, statusTxt}
function statusColorText(p){
  const override=STATUS_OVERRIDE.get(String(p.id));
  if(override) return override;
  // A firmware deploy in flight. Checked BEFORE offline on purpose: the
  // printer legitimately drops off the network for minutes while it writes
  // the image, and reporting that as "Offline" is exactly what tempts
  // someone into power-cycling it mid-write. The server decides how long
  // this may claim the card (FW_REBOOT_GRACE_MS in server.js) — it is not
  // open-ended.
  if(p.state==="updating") return { statusColor:"var(--violet)", statusTxt:t("printer_status.updating") };
  // Distinct from Updating on purpose: one is work in progress, the other is
  // a wait for the machine to come back. Amber matches the row's own bar.
  if(p.state==="rebooting") return { statusColor:"var(--warn)", statusTxt:t("printer_status.rebooting") };
  if(!p.online) return { statusColor:"var(--ink-faint)", statusTxt:t("printer_status.offline") };
  if(p.state==="printing") return { statusColor:"var(--busy)", statusTxt:t("printer_status.printing") };
  if(p.state==="paused") return { statusColor:"var(--paused)", statusTxt:t("printer_status.paused") };
  if(p.state==="error") return { statusColor:"var(--bad)", statusTxt:t("printer_status.error") };
  if(p.state==="maintenance") return { statusColor:"var(--violet-soft)", statusTxt:t("printer_status.maintenance") };
  // A file sitting on the printer ready to print is more useful to see at a
  // glance than "Idle"/"Complete"/"Cancelled" — takes priority over those
  // (but not over Printing/Paused/Error/Maintenance, which are more urgent).
  if(p.queuedFile&&p.queuedFile.status==='ready') return { statusColor:"var(--signal)", statusTxt:t("printer_status.loaded") };
  if(p.state==="complete") return { statusColor:"var(--complete)", statusTxt:t("printer_status.complete") };
  if(p.state==="cancelled") return { statusColor:"var(--bad)", statusTxt:t("printer_status.cancelled") };
  return { statusColor:"var(--ok)", statusTxt:t("printer_status.idle") };
}

// Whether the card offers Eject -- "this printer is no longer holding a job for
// me". True when Klipper has a file loaded OR SnapCon has one staged, in a
// state where the printer is not mid-job.
//
// 'standby' is the string Klipper connectors actually emit; a live 20-printer
// fleet reported only {standby, paused, complete, printing}. The old condition
// required 'idle', which NO connector produces -- it is only statusColorText's
// display fallback -- so Eject appeared solely via 'complete'/'cancelled' and
// was missing on a printer sitting at standby with a file loaded. 'idle' is
// kept anyway: flashforge-utils.js normalises standby->idle in one path.
//
// p.queuedFile is SnapCon's own staged file (the "Loaded" badge). It is cleared
// only when the file is finally printed, so without this it could not be
// dismissed at all. Only a 'ready' staged file counts -- one still uploading is
// not yet a job the printer is holding.
// A connector reports estop:false when the printer ACKNOWLEDGES an emergency
// stop and never performs one — confirmed live on FlashForge native firmware,
// where ~M112 returns "ok" and the machine keeps printing. The button stays
// VISIBLE but disabled with an explanation: silently removing an emergency
// control teaches an operator it does not exist, whereas saying why sends them
// to Cancel or the power switch.
//
// Tested for === false on purpose. Connectors with a working e-stop (U1,
// Creality, Klipper) never declare the flag, and a truthiness check here would
// disable E-Stop across the whole rest of the fleet.
function estopUnsupported(p){
  return !!(p && p.capabilities && p.capabilities.estop === false);
}

// A connector that reports control:false only WATCHES its printers (Bambu Lab
// today — see connectors/monitorOnly.js). Every control for such a printer is
// left out rather than shown disabled: none of them is ever going to work on
// it, so the footer says so once instead of offering a row of dead buttons,
// and the server refuses the routes regardless (refuseMonitorOnly).
//
// Same === false rule as estopUnsupported above, for the same reason: no
// controllable connector declares the flag, and a truthiness check would
// strip the controls from the entire rest of the fleet.
function monitorOnly(p){
  return !!(p && p.capabilities && p.capabilities.control === false);
}
// A connector that reports thumbnails:false has no job preview to serve
// (Bambu Lab: it lives inside the .3mf on the printer's own storage). Leaving
// the <img> out shows the usual "—" at once, instead of a broken-image icon
// and four doomed thumbRetry() fetches per card per job. Same === false rule.
function noThumbs(p){
  return !!(p && p.capabilities && p.capabilities.thumbnails === false);
}
// The one line a monitor-only printer's footer / list-row actions show in
// place of controls. The title says where control actually lives.
function monitorOnlyNoteHtml(compact){
  return `<span class="monitor-only-note${compact?' compact':''}" title="${esc(t("printer.monitor_only_title"))}">`+
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`+
    `<span>${esc(t("printer.monitor_only_label"))}</span></span>`;
}

function canEject(p){
  if(!p) return false;
  const st=p.state;
  if(st==='printing'||st==='paused') return false;
  if(!(st==='idle'||st==='standby'||st==='complete'||st==='cancelled')) return false;
  return !!(p.filename||(p.queuedFile&&p.queuedFile.status==='ready'));
}

// Whether a printer is free to be sent a file right now -- drives the Send
// modal's default selection and its row dot.
//
// Same trap canEject fell into: 'standby' is what the Klipper connectors
// actually emit, and 'idle' is only the label statusColorText falls back to for
// display, so the old p.state==='idle' at both call sites was dead on every
// real fleet -- nothing was ever pre-checked, and an idle printer got the busy
// dot beside its own "Idle" text. 'idle' is kept for the same defensive reason
// canEject keeps it.
//
// complete/cancelled are deliberately excluded: statusColorText gives those
// their own label and colour, so they are not "Idle" rows, and the button is
// "Idle only".
function isIdle(p){
  if(!p||!p.online) return false;
  return p.state==='standby'||p.state==='idle';
}

// ---- Camera view: live snapshot elements persist ACROSS renders ----
// renderFleet() rebuilds every card's innerHTML on every metadata poll tick
// (every `refreshInterval` seconds, deliberately fast — see startFleetRefresh)
// — if the camera <img> were part of that template string, it'd be torn down
// and recreated on every one of those ticks, which reads as the image
// blinking/reloading every 1-2s regardless of the camera refresh setting,
// even though the server already serves a cached frame underneath. Instead
// the template only emits an empty `.cam-shot-slot` marker; the actual
// <img> (or, once a feed's been marked dead, a placeholder) lives here,
// keyed by printer id, and is only swapped in for a NEW element (a real
// network request) once camRefreshMs has actually elapsed — every render in
// between just re-inserts the same element into that render's fresh slot.
const CAM_SHOT_CACHE = new Map(); // printer id -> { el, nextDueAt, dead, refreshing }

// ---- WebRTC cameras (a SECOND camera transport, parallel to the snapshot
// path above — it shares none of its cache, polling or server routes) ----
//
// Some printers expose a camera only over WebRTC (confirmed on a Creality
// F022/SPARKX i7): no still-image endpoint exists at any path, so the frames
// can only be obtained by a browser holding a live peer connection. That
// makes this a view-and-capture transport: live tiles and a canvas-captured
// manual snapshot, but nothing the SERVER can fetch, which is why
// notification images stay unavailable for these printers.
//
// One session per printer id, owned entirely by this map. Every path that
// can retire a tile (viewport, view switch, card rebuild, offline, delete,
// hidden tab) funnels into closeCamRtc(), so a peer connection can never
// outlive the element that showed it.
const CAM_RTC = new Map(); // printer id -> { pc, video, state, url, failed }
// A page served over HTTPS cannot sign a WebRTC session to a plain-http://
// printer: the signaling POST is mixed content, and Chrome's Private Network
// Access rules block a public origin reaching a private address. That is the
// Remote Access case, and no amount of retrying fixes it — the tile says so
// once and stops.
function camRtcContextSupported(){
  if(!window.RTCPeerConnection) return false;
  return location.protocol!=="https:";
}
function camRtcCleanupEntry(entry){
  if(!entry) return;
  if(entry.pc){ try{ entry.pc.close(); }catch{} }
  if(entry.video){ try{ entry.video.srcObject=null; }catch{} }
}
function closeCamRtc(id){
  closeCamStream(id); // the relayed-stream tile for this printer, if any — same lifecycle
  const entry=CAM_RTC.get(id);
  if(!entry) return;
  camRtcCleanupEntry(entry);
  CAM_RTC.delete(id);
}
function closeAllCamRtc(){
  closeAllCamStream(false);
  for(const entry of CAM_RTC.values()) camRtcCleanupEntry(entry);
  CAM_RTC.clear();
}
// Non-trickle ICE, matching what the device's own page does: it answers only
// once candidate gathering has finished, so the offer is posted after the
// null candidate rather than incrementally.
function camRtcGatheringComplete(pc){
  if(pc.iceGatheringState==="complete") return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{ if(pc.iceGatheringState==="complete"){ pc.removeEventListener("icegatheringstatechange",done); resolve(); } };
    pc.addEventListener("icegatheringstatechange",done);
    // The device answers a fully-gathered offer; a host that never reaches
    // "complete" (no network path at all) must not hang the tile forever.
    setTimeout(()=>{ pc.removeEventListener("icegatheringstatechange",done); resolve(); }, 4000);
  });
}
// base64(JSON{type:"offer",sdp}) in, base64(JSON{type:"answer",sdp}) out.
// The device replies HTTP 200 with a literal "{}" for anything it doesn't
// understand, so a 200 alone proves nothing — the decoded payload must be a
// real answer before it is handed to setRemoteDescription().
async function camRtcSignal(url, offer){
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"plain/text"},body:btoa(JSON.stringify({type:"offer",sdp:offer.sdp}))});
  if(!r.ok) throw new Error("signaling HTTP "+r.status);
  const text=(await r.text()).trim();
  let answer;
  try{ answer=JSON.parse(atob(text)); }catch{ throw new Error("signaling returned a non-answer"); }
  if(!answer||answer.type!=="answer"||typeof answer.sdp!=="string") throw new Error("signaling returned a non-answer");
  return answer;
}
// Idempotent by construction: an id already connecting or connected is never
// re-negotiated, which is what stops a render storm (the fleet re-renders on
// every poll) from stacking peer connections for the same tile. A session
// that has already failed is not retried either — the printer is either
// unreachable or the context can't support it, and a retry loop against a
// camera that cannot work is worse than a static message.
async function openCamRtc(id, url, video){
  const existing=CAM_RTC.get(id);
  if(existing&&existing.state!=="closed"){ existing.video=video; if(existing.stream) video.srcObject=existing.stream; return existing; }
  const entry={ pc:null, video, state:"connecting", url, stream:null };
  CAM_RTC.set(id,entry);
  try{
    const pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
    entry.pc=pc;
    // Recv-only: the device advertises a=sendonly and there is nothing to
    // send it. (Its own page uses sendrecv; recvonly is the correct half.)
    pc.addTransceiver("video",{direction:"recvonly"});
    pc.ontrack=e=>{
      const cur=CAM_RTC.get(id);
      if(!cur||cur.pc!==pc){ try{ pc.close(); }catch{} return; } // superseded while negotiating
      cur.stream=e.streams[0];
      cur.state="connected";
      if(cur.video) cur.video.srcObject=e.streams[0];
    };
    pc.oniceconnectionstatechange=()=>{
      if(["failed","disconnected","closed"].includes(pc.iceConnectionState)){
        const cur=CAM_RTC.get(id);
        if(cur&&cur.pc===pc){ cur.state="closed"; camRtcCleanupEntry(cur); CAM_RTC.delete(id); }
      }
    };
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    await camRtcGatheringComplete(pc);
    const answer=await camRtcSignal(url,pc.localDescription);
    if(CAM_RTC.get(id)!==entry){ try{ pc.close(); }catch{} return null; } // closed mid-negotiation
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    return entry;
  }catch(e){
    camRtcCleanupEntry(entry);
    CAM_RTC.delete(id);
    throw e;
  }
}
function camShotPlaceholderEl(text, onRetry){
  const div=document.createElement("div");
  div.className="cam-shot-placeholder"+(onRetry?" cam-shot-retryable":"");
  div.innerHTML=`<img class="cam-shot-placeholder-icon" src="/camera-disabled.svg" alt=""><span>${esc(text)}</span>`;
  if(onRetry){ div.title=t("fleet.camera.retry_title"); div.addEventListener("click", onRetry); }
  return div;
}
// Some connectors (FlashForge's stream endpoint in particular) return a
// perfectly valid HTTP 200 JPEG even when no physical camera is attached —
// it's just a blank/near-black frame. capabilities.camera is a static
// per-connector-type flag, so this is the only point anything can actually
// tell "a camera should exist here" from "a live feed is really present."
// Sampled at a tiny size purely for speed — a rough "basically all black"
// heuristic, not real image analysis.
function camShotIsBlack(img){
  try{
    const c=document.createElement("canvas");
    c.width=16; c.height=12;
    const ctx=c.getContext("2d");
    ctx.drawImage(img,0,0,16,12);
    const data=ctx.getImageData(0,0,16,12).data;
    let sum=0;
    for(let i=0;i<data.length;i+=4) sum+=(data[i]+data[i+1]+data[i+2])/3;
    return (sum/(data.length/4)) < 8; // near-zero average luma across the sample
  }catch{ return false; } // canvas read failure (e.g. tainted) — don't second-guess a real image over this
}
// Clears this printer's cache entry and rebuilds now, rather than waiting
// for the next poll tick — wired as the click handler on a "No Feed"
// placeholder, the only path back to a live attempt once a feed is dead.
function retryCamShot(id){
  CAM_SHOT_CACHE.delete(id);
  renderFleet();
}
// Only called when there is NO previously-good frame to fall back to (the
// very first attempt for this printer) — installs the placeholder in place
// of whatever's currently in the cache and marks it dead (see mountCamShot's
// dead check for why that stops future auto-retries).
function camShotFailed(id){
  const cached=CAM_SHOT_CACHE.get(id);
  const ph=camShotPlaceholderEl(t("fleet.camera.no_feed"), ()=>retryCamShot(id));
  if(cached && cached.el && cached.el.parentNode) cached.el.parentNode.replaceChild(ph, cached.el);
  CAM_SHOT_CACHE.set(id, { el:ph, nextDueAt:Infinity, dead:true, refreshing:false });
}
// CAM_SHOT_CACHE is a separate cache from CARD_CACHE, keyed by printer id —
// mountCamShot() always prefers a cached element over rebuilding one, even
// on a full card rebuild (see reconcileFleetCards()), so a "No Feed"
// placeholder sitting in this cache would otherwise survive a locale switch
// completely untouched. Only ever mutates a DEAD entry's own text/title in
// place — never clears the cache, never touches a live image element,
// never triggers retryCamShot()/a new fetch, so this can't restart a camera
// or reload a URL, satisfying the "camera refresh must not regress
// translated text, and vice versa" invariant in both directions.
function refreshCamShotPlaceholders(){
  for(const entry of CAM_SHOT_CACHE.values()){
    if(!entry.dead || !entry.el) continue;
    const span=entry.el.querySelector("span");
    if(span) span.textContent=t("fleet.camera.no_feed");
    entry.el.title=t("fleet.camera.retry_title");
  }
}
// Fetches the NEXT frame in the background (an off-DOM Image, not the
// visible element) and only swaps it in once it has fully loaded and passed
// the black-frame check — the currently-displayed frame stays on screen
// the entire time, so a refresh never shows a blank/black gap before the
// new picture appears. A refresh that errors or comes back black is treated
// as a transient blip, not a dead feed: the last known-good frame just stays
// up and the next normal interval tries again — only the very first attempt
// for a printer (mountCamShot's else-branch) has no fallback to keep
// showing and flips straight to "No Feed" on failure.
function startCamShotRefresh(id, refreshMs){
  const cached=CAM_SHOT_CACHE.get(id);
  if(!cached || cached.dead || cached.refreshing) return;
  cached.refreshing=true;
  const next=new Image();
  next.onload=()=>{
    const entry=CAM_SHOT_CACHE.get(id);
    if(!entry) return; // pruned (printer removed) while this was in flight
    entry.refreshing=false;
    entry.nextDueAt=Date.now()+refreshMs;
    if(camShotIsBlack(next)) return; // blip — keep the old frame, already rescheduled above
    next.className="cam-shot"; next.alt=""; next.loading="lazy";
    if(entry.el && entry.el.parentNode) entry.el.parentNode.replaceChild(next, entry.el);
    entry.el=next;
  };
  next.onerror=()=>{
    const entry=CAM_SHOT_CACHE.get(id);
    if(entry){ entry.refreshing=false; entry.nextDueAt=Date.now()+refreshMs; } // blip — keep the old frame, retry next interval
  };
  next.src="/api/snapshot?printer="+id+"&t="+Date.now();
}
// stagger: at real fleet sizes (tens of printers), every camera-capable
// printer gets mounted in the same renderFleet() pass, so without this
// they'd all become "due" at the exact same instant, forever — a burst of
// simultaneous RPC/MJPEG hits every single refresh cycle instead of spread
// load. A random offset assigned ONCE per printer (on its first successful
// load, baked into nextDueAt) keeps each printer on its own stable phase of
// the refresh cycle for as long as its cache entry lives, rather than
// re-randomizing — and therefore re-clustering by chance — every render.
function mountCamShot(slot, id, refreshMs, stagger){
  const cached=CAM_SHOT_CACHE.get(id);
  if(cached){
    // Always show whatever's already cached first — a refresh being due
    // never means the slot goes blank while a new one loads, only that a
    // background fetch for the NEXT frame kicks off alongside it.
    slot.replaceWith(cached.el);
    if(!cached.dead && !cached.refreshing && Date.now()>=cached.nextDueAt) startCamShotRefresh(id, refreshMs);
    return;
  }
  // Nothing shown yet for this printer — this one request is unavoidably
  // visible while it loads; every refresh after this goes through
  // startCamShotRefresh() instead, which never blanks an already-visible frame.
  const now=Date.now();
  const img=document.createElement("img");
  img.className="cam-shot"; img.alt=""; img.loading="lazy";
  const firstDueAt=now+refreshMs+(stagger?Math.random()*refreshMs:0);
  CAM_SHOT_CACHE.set(id, { el:img, nextDueAt:firstDueAt, dead:false, refreshing:false });
  img.onload=()=>{
    if(camShotIsBlack(img)) camShotFailed(id);
  };
  img.onerror=()=>camShotFailed(id);
  img.src="/api/snapshot?printer="+id+"&t="+now;
  slot.replaceWith(img);
}
// The WebRTC counterpart of mountCamShot: same slot contract (replace the
// placeholder element), different transport. Deliberately NOT routed through
// CAM_SHOT_CACHE — a <video> has no "next frame due" and must never be fed
// to the snapshot refresh loop.
//
// The session is not opened here. The observer below opens it when the tile
// is actually on screen and closes it when it scrolls away, which is what
// keeps a 100-printer farm from holding 100 media sessions.
function mountCamRtc(slot, id, url){
  const video=document.createElement("video");
  video.className="cam-shot cam-rtc";
  video.autoplay=true; video.playsInline=true; video.muted=true;
  video.dataset.camrtc=String(id);
  const entry=CAM_RTC.get(id);
  if(entry){ entry.video=video; if(entry.stream) video.srcObject=entry.stream; }
  slot.replaceWith(video);
  if(!camRtcContextSupported()){
    // No retry: over HTTPS this can never succeed (mixed content + Private
    // Network Access), so it states the limitation once.
    video.replaceWith(camShotPlaceholderEl(t("fleet.camera.lan_only")));
    return;
  }
  observeCamRtc(video,id,url);
}
// One observer for every WebRTC tile. Visible -> connect (idempotent),
// hidden -> close, so sessions track what is actually on screen.
let CAM_RTC_OBSERVER=null;
function camRtcObserver(){
  if(CAM_RTC_OBSERVER) return CAM_RTC_OBSERVER;
  CAM_RTC_OBSERVER=new IntersectionObserver(entries=>{
    for(const e of entries){
      const el=e.target, id=parseInt(el.dataset.camrtc,10), url=el.dataset.camrtcurl;
      if(e.isIntersecting){
        if(el.dataset.camrtcfailed==="1") continue; // already reported — no retry loop
        openCamRtc(id,url,el).catch(()=>{
          el.dataset.camrtcfailed="1";
          const ph=camShotPlaceholderEl(t("fleet.camera.no_feed"));
          el.replaceWith(ph);
          CAM_RTC_OBSERVER.unobserve(el);
        });
      }else{
        closeCamRtc(id);
      }
    }
  },{root:null,rootMargin:"200px",threshold:0.01});
  return CAM_RTC_OBSERVER;
}
function observeCamRtc(video,id,url){
  video.dataset.camrtcurl=url;
  camRtcObserver().observe(video);
}

// ---- Relayed camera streams (a THIRD transport: server-relayed fMP4) ----
//
// Some printers stream H.264 over RTSP, which no browser can open (Bambu Lab
// H2: RTSPS on port 322). SnapCon's server holds the one RTSP session and
// re-wraps the video as fragmented MP4 (/api/camera-stream); the page plays
// that byte stream through Media Source Extensions. MSE, not WebCodecs:
// SnapCon is usually opened as plain http://<lan-ip>, which is not a secure
// context, and WebCodecs only exists in secure contexts. The browser does all
// the decoding; the server never touches a pixel.
//
// Sessions are keyed separately from printers so a Camera View tile and the
// camera modal can watch the same printer at once (the server shares one
// upstream between them). Tile keys are the printer id, the modal's is
// "snap". Every path that retires a tile already calls closeCamRtc(), which
// closes the tile's stream too — so both live transports share one lifecycle.
const CAM_STREAM = new Map(); // key -> { video, abort, url, state, startedAt, pendingClose }
// Browsers open at most 6 connections to one host over HTTP/1.1, and every
// live view holds one for as long as it plays. Past this many live tiles the
// fleet poll and thumbnails would queue behind video, so further tiles wait
// behind a "click to watch" placeholder instead (the camera modal is extra).
const CAM_STREAM_MAX_TILES = 3;
function camStreamMediaSource(){ return window.ManagedMediaSource || window.MediaSource || null; }
function camStreamCleanup(entry){
  entry.state="closed";
  clearTimeout(entry.pendingClose); entry.pendingClose=null;
  try{ entry.abort.abort(); }catch{}
  if(entry.video){ try{ entry.video.pause(); entry.video.removeAttribute("src"); entry.video.load(); }catch{} }
  if(entry.url){ try{ URL.revokeObjectURL(entry.url); }catch{} }
}
// A Camera View tile is closed one tick late: a card rebuilt in the same
// render pass (it re-renders on every layer change) mounts a new slot right
// away, and mountCamStream adopts the running player into it instead of
// reconnecting and showing black for a second. A real removal is simply
// cleaned up on that next tick. The modal's session closes at once.
function closeCamStream(key){
  const entry=CAM_STREAM.get(key);
  if(!entry) return;
  if(key!=="snap"&&entry.state!=="closed"&&entry.video){
    if(!entry.pendingClose) entry.pendingClose=setTimeout(()=>{ if(CAM_STREAM.get(key)===entry){ CAM_STREAM.delete(key); camStreamCleanup(entry); } },0);
    return;
  }
  CAM_STREAM.delete(key);
  camStreamCleanup(entry);
}
// Tiles only unless `all` — a full fleet re-render must not cut the camera
// modal that is open on top of it.
function closeAllCamStream(all){
  for(const [key,entry] of [...CAM_STREAM]){
    if(!all && key==="snap") continue;
    CAM_STREAM.delete(key); camStreamCleanup(entry);
  }
}
// Plays /api/camera-stream in `video` until the stream ends or the session is
// closed. Resolves when it was closed on purpose; rejects when the camera, the
// network or the decoder ended it, so the caller can show a retryable
// placeholder instead of a frozen frame.
async function openCamStream(key, printerId, video){
  const prev=CAM_STREAM.get(key);
  if(prev){ CAM_STREAM.delete(key); camStreamCleanup(prev); }
  const entry={ video, abort:new AbortController(), url:null, state:"connecting", startedAt:Date.now(), pendingClose:null, failure:null };
  CAM_STREAM.set(key, entry);
  const fail=(err)=>{ if(entry.state!=="closed"&&!entry.failure){ entry.failure=err||new Error(t("fleet.camera.no_feed")); try{ entry.abort.abort(); }catch{} } };
  try{
    const r=await fetch("/api/camera-stream?printer="+printerId,{signal:entry.abort.signal, cache:"no-store"});
    checkAuthFailure(r);
    if(!r.ok){ let msg=""; try{ msg=(await r.json()).error||""; }catch{} throw new Error(msg||("HTTP "+r.status)); }
    const codec=r.headers.get("X-SnapCon-Codec")||"avc1.640028";
    const mime='video/mp4; codecs="'+codec+'"';
    const MS=camStreamMediaSource();
    if(!MS||!MS.isTypeSupported(mime)) throw new Error(t("fleet.camera.stream_unsupported"));
    const ms=new MS();
    video.disableRemotePlayback=true; // ManagedMediaSource (iOS/Safari) requires it
    entry.url=URL.createObjectURL(ms);
    video.src=entry.url;
    video.addEventListener("error",()=>fail(),{once:true});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(t("fleet.camera.no_feed"))),5000);
      ms.addEventListener("sourceopen",()=>{ clearTimeout(timer); resolve(); },{once:true});
    });
    ms.addEventListener("sourceended",()=>fail());
    ms.addEventListener("sourceclose",()=>fail());
    const sb=ms.addSourceBuffer(mime);
    sb.mode="segments";
    sb.addEventListener("error",()=>fail());
    const queue=[];
    let queuedBytes=0;
    const pump=()=>{
      if(entry.state==="closed"||entry.failure||sb.updating||!queue.length||ms.readyState!=="open") return;
      const b=video.buffered;
      // Keep the buffer short: this is a live picture, not a recording.
      if(b.length&&video.currentTime-b.start(0)>20){ try{ sb.remove(b.start(0),video.currentTime-5); return; }catch{} }
      try{
        // Peek, append, then drop: a chunk refused with QuotaExceededError must
        // be retried, not lost — chunks are arbitrary slices of one byte stream.
        sb.appendBuffer(queue[0]);
        queuedBytes-=queue[0].byteLength; queue.shift();
      }catch(e){
        if(e&&e.name==="QuotaExceededError"&&b.length&&video.currentTime-b.start(0)>1){ try{ sb.remove(b.start(0),video.currentTime-1); }catch{} return; }
        fail(e);
      }
    };
    sb.addEventListener("updateend",()=>{
      const b=video.buffered;
      if(b.length){
        const end=b.end(b.length-1);
        // Stay at the live edge: start at the first buffered frame, and jump
        // forward whenever playback has fallen behind (a stall, a background tab).
        if(video.currentTime<b.start(b.length-1)||end-video.currentTime>2.5) video.currentTime=Math.max(b.start(b.length-1),end-0.3);
        if(video.paused) video.play().catch(()=>{});
      }
      if(entry.state==="connecting") entry.state="live";
      pump();
    });
    const reader=r.body.getReader();
    for(;;){
      const { done, value }=await reader.read();
      if(done||entry.state==="closed") break;
      if(entry.failure) throw entry.failure;
      queue.push(value); queuedBytes+=value.byteLength;
      // A decoder that stopped consuming must not let the page buffer video forever.
      if(queuedBytes>16*1024*1024) throw new Error(t("fleet.camera.no_feed"));
      pump();
    }
  }catch(e){
    if(entry.state==="closed") return; // closed on purpose (scrolled away, modal closed, view switched)
    if(CAM_STREAM.get(key)===entry){ CAM_STREAM.delete(key); camStreamCleanup(entry); }
    throw entry.failure||e;
  }
  if(entry.state==="closed") return;
  if(CAM_STREAM.get(key)===entry){ CAM_STREAM.delete(key); camStreamCleanup(entry); }
  throw entry.failure||new Error(t("fleet.camera.no_feed"));
}
// Same slot contract as mountCamShot/mountCamRtc. The session opens when the
// tile scrolls into view and closes when it leaves, via the observer below.
function mountCamStream(slot, id){
  const running=CAM_STREAM.get(id);
  if(running&&running.pendingClose&&running.video&&running.state!=="closed"){
    // Adopt the player of the card this one replaces (see closeCamStream).
    clearTimeout(running.pendingClose); running.pendingClose=null;
    slot.replaceWith(running.video);
    running.video.play().catch(()=>{});
    return;
  }
  const video=document.createElement("video");
  video.className="cam-shot cam-rtc cam-stream";
  video.autoplay=true; video.playsInline=true; video.muted=true;
  video.dataset.camstream=String(id);
  slot.replaceWith(video);
  camStreamObserver().observe(video);
}
function camStreamLiveTiles(){ return [...CAM_STREAM].filter(([k,e])=>k!=="snap"&&e.state!=="closed"&&!e.pendingClose); }
// A tile that could not start because the live-tile limit is reached. Clicking
// it frees the longest-running tile (which gets this placeholder in turn).
function camStreamWaitingEl(id){
  return camShotPlaceholderEl(t("fleet.camera.stream_paused"),function onClick(){
    const ph=this instanceof Element?this:null;
    const live=camStreamLiveTiles().sort((a,b)=>a[1].startedAt-b[1].startedAt);
    if(live.length>=CAM_STREAM_MAX_TILES){
      const [oldId,oldEntry]=live[0];
      const oldVideo=oldEntry.video;
      CAM_STREAM.delete(oldId); camStreamCleanup(oldEntry);
      if(oldVideo&&oldVideo.isConnected){ if(CAM_STREAM_OBSERVER) CAM_STREAM_OBSERVER.unobserve(oldVideo); oldVideo.replaceWith(camStreamWaitingEl(oldId)); }
    }
    const target=ph||document.querySelector('.cam-shot-placeholder[data-camwait="'+id+'"]');
    if(!target) return;
    const slot=document.createElement("div");
    target.replaceWith(slot);
    mountCamStream(slot,id);
  });
}
let CAM_STREAM_OBSERVER=null;
function camStreamObserver(){
  if(CAM_STREAM_OBSERVER) return CAM_STREAM_OBSERVER;
  CAM_STREAM_OBSERVER=new IntersectionObserver(entries=>{
    for(const e of entries){
      const el=e.target, id=parseInt(el.dataset.camstream,10);
      if(e.isIntersecting){
        const cur=CAM_STREAM.get(id);
        if(cur&&cur.video===el&&cur.state!=="closed"){ clearTimeout(cur.pendingClose); cur.pendingClose=null; continue; }
        if(camStreamLiveTiles().length>=CAM_STREAM_MAX_TILES){
          CAM_STREAM_OBSERVER.unobserve(el);
          const wait=camStreamWaitingEl(id); wait.dataset.camwait=String(id);
          el.replaceWith(wait);
          continue;
        }
        openCamStream(id,id,el).catch(err=>{
          if(!el.isConnected) return;
          CAM_STREAM_OBSERVER.unobserve(el);
          // Retryable: a camera that was switched off, or a printer that
          // dropped off the network, can come back.
          const ph=camShotPlaceholderEl(t("fleet.camera.no_feed"),()=>{
            const slot=document.createElement("div");
            ph.replaceWith(slot);
            mountCamStream(slot,id);
          });
          ph.title=err&&err.message?err.message:t("fleet.camera.retry_title");
          el.replaceWith(ph);
        });
      }else if(CAM_STREAM.get(id)&&CAM_STREAM.get(id).video===el){
        closeCamStream(id);
      }
    }
  },{root:null,rootMargin:"200px",threshold:0.01});
  return CAM_STREAM_OBSERVER;
}
// Coming back to a hidden tab: every session was closed when it was hidden
// (visibilitychange), but a tile whose card did not change is reused as-is and
// the observer does not fire again for an element that never left the view.
// Re-observing makes it report the current intersection, which reconnects the
// visible tiles; an open camera modal reloads its stream the same way.
function camStreamResume(){
  if(CAM_STREAM_OBSERVER){
    document.querySelectorAll("video[data-camstream]").forEach(v=>{ CAM_STREAM_OBSERVER.unobserve(v); CAM_STREAM_OBSERVER.observe(v); });
  }
  if($("snapmodal")&&$("snapmodal").classList.contains("show")&&SNAP_PRINTER!==null){
    const p=FLEET.find(f=>f.id===SNAP_PRINTER);
    if(p&&p.capabilities?.cameraStream&&!CAM_STREAM.has("snap")) loadSnapshot();
  }
}

// ---- Fleet sort ----
let SORT_MODE = localStorage.getItem('snapcon-sort') || 'none';
const STATUS_RANK = { printing:0, paused:1, error:2, cancelled:2, complete:3, idle:4 };

function sortedFleet(){
  const arr = [...FLEET];
  if(SORT_MODE === 'status'){
    arr.sort((a,b)=>{
      const ra = a.online ? (STATUS_RANK[a.state] ?? 5) : 6;
      const rb = b.online ? (STATUS_RANK[b.state] ?? 5) : 6;
      return ra - rb;
    });
  } else if(SORT_MODE === 'time'){
    const rem = p => {
      if(!p.online || p.state !== 'printing') return Infinity;
      // Printer-reported countdown (Bambu Lab) first — its elapsed can be
      // unknown, and null*x would sort it as "finishing now".
      if(typeof p.remaining === 'number' && isFinite(p.remaining)) return p.remaining;
      if(!p.progress || p.progress <= 0 || !(p.elapsed > 0)) return Infinity;
      return p.elapsed * (1 / p.progress - 1);
    };
    arr.sort((a,b) => rem(a) - rem(b));
  } else if(SORT_MODE === 'name'){
    // numeric:true so "U1-2" sorts before "U1-10" instead of lexicographically after it.
    arr.sort((a,b)=>(a.name||'').localeCompare(b.name||'', undefined, {numeric:true, sensitivity:'base'}));
  }
  return arr;
}

// Full-sentence-per-mode keys, same reasoning as FILE_SORT_TITLE_KEYS above.
const SORT_TITLE_KEYS = { none:'global.sort.title_none', status:'global.sort.title_status', time:'global.sort.title_time', name:'global.sort.title_name' };
function applySortUI(){
  ['none','status','time','name'].forEach(k=>{
    const el = $('sc-'+k);
    if(el) el.textContent = SORT_MODE === k ? '✓' : '';
  });
  const btn = $('sortBtn');
  if(btn) btn.title = t(SORT_TITLE_KEYS[SORT_MODE] || SORT_TITLE_KEYS.none);
}

// ---- File list toggle (hidden by default) ----
let FILES_OPEN = false;
let FILES_WERE_OPEN = false;
function applyFilesOpen(){
  // Closing the file list DROPS the selection rather than remembering it. A
  // selection that outlives the list is invisible but still live: it kept
  // driving the per-card colour->head mapping row, which then reads as
  // belonging to the printer rather than to a file the operator can no longer
  // see — reported after an eject, where the mapping stayed on the card.
  //
  // Guarded on a real open->closed transition: this function also runs at
  // startup and from the settings flow, and clearJobSelection() renders the
  // fleet, which must not happen before the fleet has loaded.
  //
  // Safe for the card actions because they are gated differently on purpose.
  // Upload has nothing to upload without a selection and correctly goes
  // disabled; Print is NOT gated on it and falls back to offering the
  // printer's own files, which the tooltips already anticipate.
  if(FILES_WERE_OPEN && !FILES_OPEN && SELECTED) clearJobSelection();
  FILES_WERE_OPEN = FILES_OPEN;
  document.body.classList.toggle('showfiles', FILES_OPEN);
  const b = $('filesBtn');
  if(b){ b.title = t(FILES_OPEN ? 'global.topbar.files_hide_title' : 'global.topbar.files_show_title'); }
  // "Selected Model" is picked FROM the file list, so it only makes sense to
  // show while that list is open. Orca mode already hides this permanently.
  if(!URL_PRINTER_FILTER){
    // Also suppressed while the Queue dashboard is showing — it replaces
    // the Fleet content area these two belong to, so they'd otherwise
    // reappear stacked on top of it instead of the Fleet grid they expect.
    const show=FILES_OPEN&&!!MAP&&!$("queueDashboard").classList.contains("show");
    $("jobsechead").style.display=show?"":"none";
    $("jobcard").classList.toggle("show",show);
  }
}

// ---- Regular / Compact / Camera / List / Print Farm view cycle ----
// Launch state comes from the "Default View to Launch" setting (loadConfigUI);
// the header button only switches the current session. The button's icon
// always shows the NEXT mode a click will switch to (existing convention).
// 'printfarm' is Queue Management's own full-page dashboard, not a body-class
// CSS mode like the other four — see openQueueDashboard()/closeQueueDashboard()
// for how entering/leaving it is kept in sync with this same VIEW_MODE.
let VIEW_MODE = 'regular'; // 'regular' | 'compact' | 'camera' | 'list' | 'printfarm'
// Settings tab (View)'s "Alternate Display" — 'all' cycles through every
// view (the original behavior); any specific mode instead makes the header
// button a plain two-way toggle between Regular and that one view only.
let ALT_DISPLAY = 'all'; // 'all' | 'compact' | 'camera' | 'list' | 'printfarm'
const ALL_CYCLE = { regular:'compact', compact:'camera', camera:'list', list:'printfarm', printfarm:'regular' };
const VIEW_ICON  = { regular:'/view-regular.svg', compact:'/view-compact.svg', camera:'/view-camera.svg', list:'/view-list.svg', printfarm:'/view-printfarm.svg' };
const VIEW_TITLE_KEYS = { regular:'global.topbar.view_title_regular', compact:'global.topbar.view_title_compact', camera:'global.topbar.view_title_camera', list:'global.topbar.view_title_list', printfarm:'global.topbar.view_title_printfarm' };
// Extracted from applyViewMode() so the printfarm path (which bypasses the
// body-class logic below — see cycleViewMode()) can still keep the header
// button's icon/title showing the correct next mode.
function syncViewModeButtonIcon(){
  const btn=$('compactBtn');
  if(btn){
    const next=nextViewMode();
    btn.querySelector('img').src=VIEW_ICON[next]; btn.title=t(VIEW_TITLE_KEYS[next]);
  }
}
function nextViewMode(){
  if(ALT_DISPLAY==='all') return ALL_CYCLE[VIEW_MODE] || 'regular';
  // Two-state toggle regardless of how VIEW_MODE got here (e.g. left over
  // from a previous "All" setting) — anything that isn't already Regular
  // goes back to Regular; Regular goes to the one configured alternate.
  return VIEW_MODE==='regular' ? ALT_DISPLAY : 'regular';
}
// All four fleet display modes (regular, compact, camera, list) share the
// same toolbar (status tabs, tag filter, checkbox multi-select, bulk
// actions, Edit Tags) and the same cards/bulk actions underneath — there's
// no reason selection or tag/status filtering should only work in two of
// the four. Print Farm (VIEW_MODE==='printfarm') is a separate full-page
// dashboard with its own printer list, not part of this grid at all — it's
// deliberately excluded, and #fleet-wrap (this toolbar's own ancestor) is
// hidden outright while it's open regardless of this function's answer.
function gridToolbarActive(){ return VIEW_MODE==='camera' || VIEW_MODE==='list' || VIEW_MODE==='regular' || VIEW_MODE==='compact'; }
// Shows which non-default view is active right next to the SnapCon name —
// Queue Management takes priority over the four fleet display modes since
// it's a separate page, not one of them; the standard fleet view shows
// nothing extra. Called from applyViewMode() and the Queue dashboard's own
// open/close, the only two things that change which view is current.
const VIEW_LABEL_KEYS = { camera:'global.topbar.view_label_camera', compact:'global.topbar.view_label_compact', list:'global.topbar.view_label_list', printfarm:'global.topbar.view_label_printfarm' };
function updateTopbarViewLabel(){
  const el=$("topbarViewLabel");
  if(!el) return;
  const key=VIEW_LABEL_KEYS[VIEW_MODE];
  el.textContent=key?"("+t(key)+")":"";
}
function applyViewMode(){
  // Camera View is the only view that holds live sessions; leaving it
  // (or entering any other) releases every one of them.
  if(VIEW_MODE!=='camera') closeAllCamRtc();
  document.body.classList.toggle('compact', VIEW_MODE==='compact');
  document.body.classList.toggle('camview', VIEW_MODE==='camera');
  document.body.classList.toggle('listview', VIEW_MODE==='list');
  // Selection/filters are grid-toolbar-only state — leaving BOTH camera and
  // list view resets them so the next visit starts clean rather than
  // silently carrying over a stale selection or filter from a previous
  // session; switching between camera and list preserves it.
  if(!gridToolbarActive()){ CAM_SELECTED.clear(); CAM_TAB='all'; CAM_TAG_FILTER=''; }
  syncViewModeButtonIcon();
  // Camera view polls each printer's snapshot on every fast metadata tick —
  // the server (not the client poll interval) is what actually throttles
  // real camera hardware (see getSnapshotThrottled() in server.js), so
  // there's nothing to re-floor here; this just realigns the fleet poll
  // timer immediately on a mode switch rather than waiting for it to
  // naturally fire next.
  if($("setRefresh")) startFleetRefresh();
  updateTopbarViewLabel();
}
function cycleViewMode(){
  const next=nextViewMode();
  const wasPrintFarm=VIEW_MODE==='printfarm';
  if(next==='printfarm'){
    // Not reachable if the feature is off — fall back to Regular rather
    // than try to open a dashboard that isn't available. QUEUE_MANAGEMENT_ENABLED
    // is only known once Settings has loaded at least once (loadQueueManagementUI);
    // treat "unknown yet" the same as "off" here, since this is a live user
    // click, not a launch-time default that already waited on that load.
    if(!QUEUE_MANAGEMENT_ENABLED){ VIEW_MODE='regular'; applyViewMode(); renderFleet(); return; }
    openQueueDashboard(); // sets VIEW_MODE + syncs the button icon itself
    return;
  }
  if(wasPrintFarm) closeQueueDashboard();
  VIEW_MODE=next;
  applyViewMode();
  renderFleet();
}
const ICONS = {
  pause:  `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  play:   `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  x:      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  zap:    `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  check:  `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
  flame:  `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10M12 12a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>`,
  power:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`,
  alert:  `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16" stroke-width="2.5" stroke-linecap="round"/></svg>`,
};

function headLabel(i){ return USE_T_NOTATION ? 'T'+i : String(i+1); }

// ---- Login overlay ----
// showLoginOverlay() returns a promise that resolves once login succeeds, so
// the initial auth gate in init() can await it; a mid-session 401 (idle
// timeout, or an Admin deleting the account) calls it again as a fire-and-
// forget re-prompt — checkAuthFailure() doesn't await the result.
let LOGIN_RESOLVE=null, LOGIN_PENDING=null, OTP_LOGIN_NAME=null;
// Additive `code` fields from /api/login, /api/login/otp/request, and
// /api/login/otp/verify (server.js + auth.js) map to translated text here;
// the existing `error` string is always kept as the fallback for an
// unrecognized/absent code, same established pattern as
// QUEUE_ERROR_KEYS/USER_ERROR_KEYS. otp_delivery_failed carries the raw
// delivery diagnostic in `detail` — SnapCon-owned wrapper translated,
// diagnostic text itself left exactly as the server sent it.
// SECURITY: invalid_credentials, otp_request_generic_fail, and
// otp_verify_incorrect are each shared verbatim across multiple distinct
// backend conditions specifically so a translation can't be used to
// enumerate accounts — never split one of these into more than one key.
const AUTH_ERROR_KEYS={
  users_disabled:"auth.error_users_disabled",
  invalid_credentials:"auth.error_invalid_credentials",
  otp_required:"auth.error_otp_required",
  otp_not_configured:"auth.error_otp_not_configured",
  otp_request_generic_fail:"auth.error_otp_request_generic_fail",
  otp_verify_incorrect:"auth.error_otp_verify_incorrect",
  otp_verify_request_new:"auth.error_otp_verify_request_new",
  otp_verify_expired:"auth.error_otp_verify_expired",
  otp_verify_too_many_attempts:"auth.error_otp_verify_too_many_attempts"
};
function authErrorText(d,fallback){
  // hasTranslation() guard mirrors applyI18nToDom()'s own "never show a raw
  // key" rule (see i18n.js) — on a total locale-fetch outage (English never
  // loaded either), t() would otherwise return the raw key itself instead
  // of the server's perfectly good English d.error text already in hand.
  if(d&&d.code==="otp_delivery_failed"){
    return hasTranslation("auth.error_otp_delivery_failed")?t("auth.error_otp_delivery_failed",{detail:d.detail||fallback}):fallback;
  }
  const key=d&&d.code&&AUTH_ERROR_KEYS[d.code];
  return (key&&hasTranslation(key))?t(key):fallback;
}
// The temporary pre-login language choice — deliberately NOT the same key
// user.locale round-trips through (settings.dirty_bar etc. never touch
// this). No account exists yet to persist it against, so it lives in
// localStorage only, same mechanism already used for theme/sort/view-mode
// preferences. Never written to the server; never overwrites a real
// account's saved locale (see applyAccountLocale(), which always wins once
// a user is actually signed in).
function getPreAuthLocale(){ try{ return localStorage.getItem("snapcon-preauth-locale")||null; }catch{ return null; } }
function setPreAuthLocale(locale){ try{ localStorage.setItem("snapcon-preauth-locale",locale); }catch{} }
// Public, unauthenticated endpoint (see server.js) — fine to call before any
// session exists. Fire-and-forget from showLoginOverlay(): the login form
// itself must never wait on this, only the selector's own options do.
async function populatePreAuthLocaleSelector(){
  const sel=$("loginLocale");
  if(!sel) return;
  let list=[];
  try{ const d=await getJSON("/api/public-locales"); list=d.locales||[]; }catch{ sel.style.display="none"; return; }
  if(!list.length) { sel.style.display="none"; return; }
  sel.innerHTML=list.map(l=>`<option value="${esc(l.locale)}">${esc(l.nativeName||l.language||l.locale)}</option>`).join("");
  sel.value=i18nCurrentLocale();
  sel.style.display="";
}
function showLoginOverlay(){
  if(LOGIN_PENDING) return LOGIN_PENDING;
  $("loginOverlay").style.display="flex";
  $("loginStep1").style.display="";
  $("loginStep2").style.display="none";
  $("loginPassword").value="";
  $("loginStatus").textContent="";
  populatePreAuthLocaleSelector();
  LOGIN_PENDING=new Promise(resolve=>{ LOGIN_RESOLVE=resolve; });
  return LOGIN_PENDING;
}
function hideLoginOverlay(){
  $("loginOverlay").style.display="none";
  LOGIN_PENDING=null;
}
function onLoginSuccess(user){
  CURRENT_USER=user;
  applyAccountTheme(user);
  applyAccountLocale(user);
  LAST_LOGIN_AT=Date.now();
  hideLoginOverlay();
  if(LOGIN_RESOLVE){ const r=LOGIN_RESOLVE; LOGIN_RESOLVE=null; r(); }
  applyRoleUI();
  if($("setUserLocale")) $("setUserLocale").value=user.locale||"";
  loadConfigUI(); loadFiles(); loadFleet();
}
async function doLoginPassword(){
  const loginName=$("loginName").value.trim(), password=$("loginPassword").value;
  const st=$("loginStatus");
  if(!loginName||!password){ st.className="pstatus err"; st.textContent=t("auth.error_missing_login_fields"); return; }
  const btn=$("loginSubmit"); btn.disabled=true;
  st.className="pstatus work"; st.textContent=t("auth.status_logging_in");
  try{
    const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName,password})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(authErrorText(d,d.error||("HTTP "+r.status)));
    onLoginSuccess(d.user);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}
async function doRequestOtp(){
  const loginName=$("loginName").value.trim();
  const st=$("loginStatus");
  if(!loginName){ st.className="pstatus err"; st.textContent=t("auth.error_missing_login_name"); return; }
  const btn=$("loginOtpBtn"); btn.disabled=true;
  st.className="pstatus work"; st.textContent=t("auth.status_sending_code");
  try{
    const r=await fetch("/api/login/otp/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(authErrorText(d,d.error||("HTTP "+r.status)));
    OTP_LOGIN_NAME=loginName;
    st.className="pstatus"; st.textContent="";
    $("loginStep1").style.display="none";
    $("loginStep2").style.display="";
    $("otpCode").value=""; $("otpStatus").textContent="";
    $("otpCode").focus();
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}
async function doVerifyOtp(){
  const code=$("otpCode").value.trim();
  const st=$("otpStatus");
  if(!code){ st.className="pstatus err"; st.textContent=t("auth.error_missing_otp_code"); return; }
  const btn=$("otpSubmit"); btn.disabled=true;
  st.className="pstatus work"; st.textContent=t("auth.status_verifying");
  try{
    const r=await fetch("/api/login/otp/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName:OTP_LOGIN_NAME,code})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(authErrorText(d,d.error||("HTTP "+r.status)));
    onLoginSuccess(d.user);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}
function wireLoginOverlay(){
  $("loginSubmit").addEventListener("click", doLoginPassword);
  $("loginPassword").addEventListener("keydown", e=>{ if(e.key==="Enter") doLoginPassword(); });
  $("loginName").addEventListener("keydown", e=>{ if(e.key==="Enter") doLoginPassword(); });
  $("loginOtpBtn").addEventListener("click", doRequestOtp);
  $("otpSubmit").addEventListener("click", doVerifyOtp);
  $("otpCode").addEventListener("keydown", e=>{ if(e.key==="Enter") doVerifyOtp(); });
  $("otpBack").addEventListener("click", ()=>{ $("loginStep2").style.display="none"; $("loginStep1").style.display=""; $("otpStatus").textContent=""; });
  $("logoutBtn").addEventListener("click", async ()=>{
    try{ await fetch("/api/logout",{method:"POST"}); }catch{}
    CURRENT_USER=null;
    applyRoleUI();
    showLoginOverlay();
  });
  // Temporary, local-only, pre-login choice — never a session/auth action.
  // Live-translates the still-open overlay in place; entered field values
  // are untouched since applyI18nToDom() only ever writes textContent/
  // placeholder/title/aria-label/alt attributes, never .value.
  $("loginLocale").addEventListener("change", async ()=>{
    const val=$("loginLocale").value;
    setPreAuthLocale(val);
    await setI18nLocale(val);
    applyI18nToDom();
  });
}
async function authGate(){
  // One retry on network failure: giving up immediately would default
  // USERS_ENABLED to false and show a fully-open UI even though the server
  // still requires login, with every subsequent call silently 401ing.
  for(let attempt=0; attempt<2; attempt++){
    try{
      const s=await fetch("/api/session").then(r=>r.json());
      USERS_ENABLED=!!s.usersEnabled;
      SYSTEM_DEFAULT_LOCALE=s.locale||"en";
      if(USERS_ENABLED && s.authenticated){ CURRENT_USER=s.user; applyAccountTheme(CURRENT_USER); }
      break;
    }catch{
      if(attempt===0) await new Promise(r=>setTimeout(r,800));
      else { USERS_ENABLED=false; SYSTEM_DEFAULT_LOCALE="en"; }
    }
  }
  // Resolve + load i18n BEFORE the login overlay (if any) becomes visible,
  // so it never flashes raw English/raw keys: an already-signed-in session
  // (cookie survived a refresh) uses that account's own saved locale;
  // otherwise the locally-remembered pre-auth choice, then the system
  // default, then English. This never blocks login availability —
  // initI18n()'s own fetch failure already falls back to English
  // internally (see i18n.js), so a locale-service outage still leaves
  // login fully usable, just untranslated.
  const preAuthLocale=(USERS_ENABLED&&CURRENT_USER&&CURRENT_USER.locale)||getPreAuthLocale()||SYSTEM_DEFAULT_LOCALE;
  await initI18n(preAuthLocale);
  applyI18nToDom();
  if(USERS_ENABLED && !CURRENT_USER) await showLoginOverlay();
}

// ---- Role gating ----
// Called after init/login/logout. Both isAdmin()/canAct() hard-return true
// when USERS_ENABLED is false, so this is a no-op restoring today's fully-
// open UI whenever the feature is off.
function applyRoleUI(){
  const admin=isAdmin(), act=canAct();
  // Settings hides filesBtn itself while open ($("gear")'s click handler) —
  // this runs on every login/logout AND after a mid-settings Save, so it must
  // not re-show it out from under that, or the folder button flashes back in
  // on top of the settings panel.
  const settingsOpen = $("setup").classList.contains("show");
  $("gear").style.display = admin ? "" : "none";
  // The Queue dashboard is a normal part of the working UI, not an
  // exclusive full-page takeover like Settings — every other topbar
  // control (folder, sort, compact view, bulk heat, maintenance, Settings
  // itself) stays available while it's open, so only Settings gates these.
  if($("filesBtn")) $("filesBtn").style.display = (act && !settingsOpen) ? "" : "none";
  if($("jobSend")) $("jobSend").style.display = act ? "" : "none";
  // queueBtn must never hide itself while the Queue dashboard it opened is
  // still showing — it's the only way back to Fleet (mirrors #gear staying
  // visible/clickable the whole time Settings is open).
  if($("queueBtn")) $("queueBtn").style.display = (QUEUE_MANAGEMENT_ENABLED && !settingsOpen) ? "" : "none";
  // Health is read-only diagnostics — available to every role, same as the
  // fleet card itself; only Settings (an exclusive full-page takeover)
  // hides it, same as bulkHeatBtn/filesBtn above.
  if($("healthBtn")) $("healthBtn").style.display = settingsOpen ? "none" : "";
  if(USERS_ENABLED && CURRENT_USER){
    // First name if set, else fall back to the login name.
    const uname=CURRENT_USER.firstName||CURRENT_USER.loginName;
    $("userBadge").style.display="flex";
    if($("logoutBtn")) $("logoutBtn").title=t("global.topbar.logout_title_named",{name:uname});
  } else if($("userBadge")){
    $("userBadge").style.display="none";
  }
  renderVbadge();
  renderFleet();
}

// Always-on topbar clock — lives in the persistent topbar (near Settings),
// not any one view, so it ticks regardless of which screen is open. Full
// date is a title tooltip rather than permanent text, to keep it out of the
// way of the icon row it sits in.
function tickTopbarClock(){
  const el=$("topbarClock");
  if(!el) return;
  const now=new Date();
  el.textContent=now.toLocaleTimeString([], { hour12:false });
  el.title=now.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric", year:"numeric" });
}
tickTopbarClock();
setInterval(tickTopbarClock, 1000);

init();
async function init(){
  wireLoginOverlay();
  await authGate();
  applyRoleUI();
  wireUI();
  // Single-printer deep link: this is a focused view — the search box, file
  // browser, sort, compact toggle, settings, the "Selected Model" summary and
  // the "Fleet x/x online" heading are all dead weight/noise; only the
  // printer card itself earns a place here. Inline display:none beats the
  // .show class toggle these elements use, so this stays permanent even once
  // a file gets selected (e.g. via a notify-load pending delivery).
  if(URL_PRINTER_FILTER){
    if($("fleetSearch")) $("fleetSearch").style.display="none";
    if($("filesBtn")) $("filesBtn").style.display="none";
    const topSort=document.querySelector(".topbar .sort-wrap");
    if(topSort) topSort.style.display="none";
    if($("compactBtn")) $("compactBtn").style.display="none";
    if($("themeBtn")) $("themeBtn").style.display="none";
    if($("gear")) $("gear").style.display="none";
    if($("topbarClock")) $("topbarClock").style.display="none";
    if($("jobsechead")) $("jobsechead").style.display="none";
    if($("jobloading")) $("jobloading").style.display="none";
    if($("jobcard")) $("jobcard").style.display="none";
    const fleetSechead=$("fleetcount")&&$("fleetcount").closest(".sechead");
    if(fleetSechead) fleetSechead.style.display="none";
  }
  await checkVersion(); await loadConfigUI();
  // Resolution: this account's saved locale -> the system default we just
  // learned from loadConfigUI() -> English. The Settings PANEL isn't open at
  // boot, so nothing on-screen needs translated text before this point —
  // but loadConfigUI() above already called renderMilestoneChips(), which
  // WRITES a t()/tn()-computed hint into the (currently hidden) DOM before
  // English has even loaded, using whatever t()/tn() falls back to when
  // enData is still empty (the raw key). applyI18nToDom() below can't fix
  // that retroactively — it only re-scans [data-i18n] attributes, and this
  // hint is set via .textContent from a JS template, not a static attribute
  // — so it's re-rendered explicitly once i18n is actually ready, the same
  // reason populateLocaleSelectors() below is also called here and not
  // earlier.
  await initI18n((USERS_ENABLED&&CURRENT_USER&&CURRENT_USER.locale)||SYSTEM_DEFAULT_LOCALE);
  applyI18nToDom();
  refreshDynamicI18nText();
  // Printer rows were already built once above (inside loadConfigUI(), via
  // renderPrinterRowsFromConfig()) before English/the active locale had
  // loaded — every t()-computed label baked into that template rendered as
  // a raw key at that point, and applyI18nToDom() above can't fix it
  // retroactively since it's not data-i18n-attribute markup. Rebuilding now
  // is safe because the Settings panel isn't open yet at boot, so there's
  // no in-progress edit to lose.
  if(PRINTERS_CFG&&PRINTERS_CFG.length) renderPrinterRowsFromConfig();
  await populateLocaleSelectors();
  await loadFiles(); await initialFleetLoad();
  // /health or /health/<id> deep link — read once here, after FLEET is
  // populated (auto-select-first-attention needs it). Live navigation after
  // this point goes through selectHealthPrinter()/the popstate listener,
  // not this check again.
  const healthMatch=location.pathname.match(/^\/health\/?(\d*)$/i);
  if(healthMatch) openHealthPage(healthMatch[1]?parseInt(healthMatch[1],10):null);
  // First fleet data is in (or failed) — fade the splash out and drop it.
  const splash=$("splash");
  if(splash){ splash.classList.add("hide"); setTimeout(()=>splash.remove(), 600); }
  setInterval(()=>{ if(!document.hidden) loadFiles(); }, 15000);
  startFleetRefresh();
  document.addEventListener("visibilitychange", ()=>{
    // A hidden tab has no visible camera tile, so nothing should be holding a
    // media session open. Coming back re-renders the fleet, which re-mounts
    // the tiles and lets the observer reconnect the ones actually on screen.
    if(document.hidden){ closeAllCamRtc(); closeAllCamStream(true); return; }
    loadFiles(); loadFleet(); camStreamResume();
  });
}

// Modal boilerplate: any listed button, or a click on the backdrop, closes it.
function wireModal(modalId, closeFn, buttonIds){
  buttonIds.forEach(id=>$(id).addEventListener("click", closeFn));
  $(modalId).addEventListener("click", e=>{ if(e.target===$(modalId)) closeFn(); });
}

// The icon shows the theme clicking would switch TO, not the one you're
// already in — the common convention for a theme toggle (a moon while you're
// in light mode means "click for dark"). Icon, alt and title therefore all
// describe the same destination, so nothing on the button reads as stale
// after a click.
function syncThemeButton(){
  const light=document.documentElement.getAttribute("data-theme")==="light";
  $("themeBtnIcon").src=light?"/moon.svg":"/sun.svg";
  $("themeBtnIcon").alt=t(light?"global.topbar.theme_alt_dark":"global.topbar.theme_alt_light");
  $("themeBtn").title=t(light?"global.topbar.theme_title_to_dark":"global.topbar.theme_title_to_light");
  $("themeBtn").setAttribute("aria-pressed",light?"true":"false");
}
// A signed-in user's saved theme is authoritative over whatever this
// particular browser guessed for first paint (local prefers-color-scheme or
// a stale localStorage value from someone else on a shared machine) — and
// gets written back to localStorage so the NEXT load on this same browser
// already has it before the inline <head> script even runs, no flash, no
// waiting on this request. A no-op for accounts that haven't picked a theme
// yet (theme is null) — they keep following prefers-color-scheme as usual.
function applyAccountTheme(user){
  if(!user || (user.theme!=="light" && user.theme!=="dark")) return;
  localStorage.setItem("snapcon-theme",user.theme);
  if(document.documentElement.getAttribute("data-theme")===user.theme) return;
  document.documentElement.setAttribute("data-theme",user.theme);
  syncThemeButton();
}
// applyI18nToDom() only re-scans [data-i18n]/[data-i18n-*] attributes on
// static markup — anything rendered imperatively (a t()/tn() call inside a
// JS function, not a template attribute) stays in whatever language it was
// last drawn in until something explicitly redraws it. Notifications'
// milestone hint (renderMilestoneChips()) is the one such case right now.
// Call this alongside every applyI18nToDom() that can fire from a LIVE
// language switch (not the initial page-load resolution, which redraws
// everything fresh anyway) so a mid-session switch can't leave
// stale-language text sitting in a control whose content depends on JS
// state rather than markup.
function refreshDynamicI18nText(){
  renderMilestoneChips();
  updatePrintersDirtyFooter();
  if($("collapseAll")) syncCollapseAllButtonLabel();
  refreshBlankPrinterRowSummaries();
  // Re-renders each row's status dot/text from the already-fetched FLEET
  // array — normally only called after a poll returns a CHANGED payload
  // (see loadFleet()'s `if(body!==FLEET_PREV_BODY)` guard), so a printer
  // sitting idle with an unchanged payload would otherwise show a
  // stale-language status indefinitely after a locale switch, not just
  // until "the next poll" as that guard's comment implies. Pure re-render
  // off cached data, no network/mutation, safe to call here.
  updateAllPrinterRowStatuses();
  // The generic per-tab dirty bar (General + Notifications, via
  // registerSettingsTab()) diffs current field values against a saved
  // snapshot and writes a tn()-computed count into .dirty-text — pure
  // re-render off already-known state, but nothing previously re-invoked it
  // on a live locale switch, so an unsaved Notifications (or General)
  // change would show a stale-language count until the next actual edit.
  Object.keys(SETTINGS_TAB_TRACKERS).forEach(updateSettingsDirtyBar);
  refreshOtpTelegramBotHint();
  refreshUserRowDynamicText();
  refreshRemoteAccessDynamicText();
  refreshQueueManagementDynamicText();
  refreshLogsDynamicText();
  refreshGlobalUIDynamicText();
  refreshFleetDynamicText();
  refreshHealthDynamicText();
  refreshMaintDynamicText();
  refreshFirmwareDynamicText();
  refreshLangEditorDynamicText();
}
// cardSignature() (reconcileFleetCards()'s incremental-render dedup key)
// deliberately doesn't include locale, so an unchanged card is reused
// verbatim across a normal poll — meaning a locale switch alone would
// otherwise sit stale until something else about the printer changes.
// renderFleet() with no args forces the existing full-rebuild path (see
// reconcileFleetCards: incremental=false rebuilds every card), which is a
// pure re-render off the already-cached FLEET array — no network call, same
// invariant as every other refresh*DynamicText() above. Safe for cameras:
// mountCamShot() always checks CAM_SHOT_CACHE first and relocates the
// existing <img> rather than re-fetching, so this can't restart a feed.
// refreshCamShotPlaceholders() covers the one thing a full card rebuild
// does NOT reach — a dead "No Feed" placeholder living in that same
// separate cache, reused as-is by mountCamShot() regardless of rebuild.
function refreshFleetDynamicText(){
  if($("fleet")) renderFleet();
  refreshCamShotPlaceholders();
  refreshFleetModalsDynamicText();
  // renderJob()'s "Selected Model" preview card is a pure re-render off
  // already-selected SELECTED/MAP state (no network) — only refresh it
  // while actually visible, and never while it's mid-load (jobloading
  // showing instead) since MAP may not reflect SELECTED yet at that point.
  if($("jobcard")&&$("jobcard").classList.contains("show")) renderJob();
}
// Printer-detail modals set their own dynamic (non-data-i18n) text once, at
// open time, from a captured printerId — never rebuilt via full innerHTML
// replace, so a live locale switch must re-derive just that text in place
// rather than reopen/reconstruct the modal (which would lose typed values,
// checkboxes, or the selected color/tab). Every branch here is a pure
// re-render off already-known state (FLEET, PLATE_DATA, SPOOL_MODAL_*) —
// no network call, and only runs for whichever modal is actually open.
// Known minor exception: the unload modal's material/RFID line (set once at
// open from p.heads[ext]) isn't re-derived here — low-traffic secondary
// text, not the title/confirm/button text a user is actively reading mid-
// switch; closing and reopening picks up the new locale same as always.
function refreshFleetModalsDynamicText(){
  if($("bedmodal")&&$("bedmodal").classList.contains("show")&&BEDMODAL_PRINTER!==null){
    const p=FLEET.find(f=>f.id===BEDMODAL_PRINTER);
    if(p) $("bedmodaltitle").textContent=t("fleet.modal.bed.title",{printer:(p.brand||'SnapMaker')+" "+p.name});
  }
  if($("platemodal")&&$("platemodal").classList.contains("show")&&PLATE_DATA){
    renderPlate();
  }
  if($("unloadmodal")&&$("unloadmodal").classList.contains("show")&&SPOOL_MODAL_PRINTER!==null){
    const p=FLEET.find(f=>f.id===SPOOL_MODAL_PRINTER);
    if(UNLOAD_DIALOG_MODE==="color"){
      $("unloadtitle").textContent=t("fleet.modal.unload.color_mode_title");
      $("unloadSubtitle").textContent=t("fleet.modal.unload.color_mode_subtitle",{head:headLabel(SPOOL_MODAL_EXT),printer:(p&&p.name)||""});
      updateUnloadCompareSwatches();
      renderUnloadPaletteGrid();
    } else {
      $("unloadtitle").textContent=t("fleet.modal.unload.title",{head:headLabel(SPOOL_MODAL_EXT)});
      $("unloadmsg").textContent=t("fleet.modal.unload.confirm_message",{head:headLabel(SPOOL_MODAL_EXT)});
      updateUnloadConfirmLabel();
      if(p){
        $("unloadAllLabel").textContent=t("fleet.modal.unload.unload_all_instead",{n:(p.heads||[]).length});
        renderUnloadPrintWarning(p);
      }
    }
  }
  if($("snapmodal")&&$("snapmodal").classList.contains("show")&&SNAP_PRINTER!==null){
    const p=FLEET.find(f=>f.id===SNAP_PRINTER);
    if(p) $("snaptitle").textContent=t("fleet.modal.snapshot.title",{printer:p.name});
  }
  if($("sendmodal")&&$("sendmodal").classList.contains("show")){
    $("sendtitle").textContent=t("fleet.modal.send.title");
    renderSendList();
  }
  if($("quickPrintModal")&&$("quickPrintModal").classList.contains("show")&&QP_PRINTER!==null){
    const p=FLEET.find(f=>f.id===QP_PRINTER);
    if(p) $("qpSubtitle").textContent=t("fleet.modal.quickprint.subtitle",{printer:p.name});
    renderQuickPrintOpts();
  }
  if($("pfilemodal")&&$("pfilemodal").classList.contains("show")&&PFILE_PRINTER!==null){
    const p=FLEET.find(f=>f.id===PFILE_PRINTER);
    if(p) $("pfiletitle").textContent=t("fleet.modal.pfile.title",{printer:p.name});
    renderPfileOpts();
    renderPfileList();
    if(PFILE_META){ renderPfileInfo(); renderPfileMap(); }
  }
  if($("bulkheatmodal")&&$("bulkheatmodal").classList.contains("show")){
    refreshBulkHeatDynamicText();
  }
}
// Health has no auto-polling except its own sync-status loop, which always
// renders fresh from server JSON via t() — already locale-correct with no
// special handling. This is only for a live locale switch while the page is
// open. renderHealthPicker()/renderHealthBody() are pure re-renders off
// already-cached FLEET/HEALTH_DATA/HEALTH_MAINT/HEALTH_SYNC_STATE, no
// network call. This used to skip renderHealthBody() entirely whenever the
// service form was open — the form was destroyed by that render, and losing
// a half-typed entry to a language switch was worse than leaving the cards
// in the old locale. That trade-off is gone: the form is now moved across
// each render (mountHealthServiceForm) and only re-initialised on a printer
// change, so the page can re-translate in full without touching it.
function refreshHealthDynamicText(){
  if(!$("healthPage")||!$("healthPage").classList.contains("show")) return;
  renderHealthPicker();

  renderHealthBody();
  renderHealthSvcChips();      // the form's own translated bits — it survived the render above
  updateHealthNextDuePreview();
}
// Mirrors refreshHealthDynamicText() above: pure re-renders off already-
// cached MAINT_ENTRIES/MAINT_WARRANTY/MAINT_CURRENT_PRINTER_NAME (added
// specifically to support this, same as Fleet's BEDMODAL_PRINTER) and
// current DOM input values — never touches the typed Date/Cost/Part/Notes
// fields or re-fetches anything.
function refreshMaintDynamicText(){
  if(!$("maintReportModal")||!$("maintReportModal").classList.contains("show")) return;
  if($("maintDetail").style.display==="none") return;
  if(MAINT_CURRENT_PRINTER_NAME) $("maintHistoryTitle").textContent=t("maintenance.history_title",{name:MAINT_CURRENT_PRINTER_NAME});
  renderMaintWarranty(MAINT_WARRANTY);
  renderMaintLastService(MAINT_ENTRIES);
  renderMaintHistory(MAINT_ENTRIES);
  updateNextScheduledPreview();
}
// Topbar/global-chrome titles, labels, and the config-load warning are all
// set imperatively (composed titles, ternary label swaps), not via
// data-i18n attributes — none of them are re-scanned by applyI18nToDom().
// Every one of these functions is also a pure re-render off already-known
// state (SORT_MODE, FILE_SORT, FILES_OPEN, VIEW_MODE, current theme,
// CONFIG_LOAD_FAILED/CONFIG_LOAD_QUARANTINE_PATH) — no network call, same
// invariant as every other refresh*DynamicText() above.
function refreshGlobalUIDynamicText(){
  if($("sortMenu")) applySortUI();
  if($("fileSortMenu")) applyFileSortUI();
  if($("filesBtn")) applyFilesOpen();
  if($("compactBtn")) syncViewModeButtonIcon();
  if($("topbarViewLabel")) updateTopbarViewLabel();
  if($("themeBtn")) syncThemeButton();
  if($("configLoadWarningCard")) renderConfigLoadWarning({configLoadFailed:CONFIG_LOAD_FAILED, configLoadQuarantinePath:CONFIG_LOAD_QUARANTINE_PATH});
  // logoutBtn's title carries the current user's display name — set by
  // applyRoleUI() on login/logout, which also does a lot more (visibility
  // toggling, renderFleet()) that a locale switch must not re-trigger, so
  // this re-derives just the title instead of re-running that whole function.
  if(USERS_ENABLED && CURRENT_USER && $("logoutBtn")){
    $("logoutBtn").title=t("global.topbar.logout_title_named",{name:CURRENT_USER.firstName||CURRENT_USER.loginName});
  }
  // gear's title is "Back" while Settings is open, "Settings" otherwise (set
  // imperatively by the click handler above) — applyI18nToDom() just reset it
  // to the static data-i18n-title="settings.title" value regardless of
  // state, via the SAME attribute this reuses for the closed case, so this
  // re-derives just the title from current DOM state rather than re-running
  // the click handler or any Settings-rendering logic.
  if($("gear")&&$("setup")){
    $("gear").title=$("setup").classList.contains("show")?t("common.back"):t("settings.title");
  }
  // Same class of bug as gear's title above, just discovered later: Health's
  // openHealthPage()/closeHealthPage() set healthBtn.title imperatively
  // ("Back to Fleet"/"Printer health"), bypassing the data-i18n-title on the
  // same element entirely — a live switch would otherwise leave this title
  // in whatever locale was active when Health was opened/closed, and could
  // even fight the data-i18n-title write from applyI18nToDom() itself.
  if($("healthBtn")&&$("healthPage")){
    $("healthBtn").title=$("healthPage").classList.contains("show")?t("global.topbar.back_to_fleet_title"):t("global.topbar.health_title");
  }
  // Same bug, same fix, on Queue Management's own topbar button — found
  // during the final i18n closure pass by inspecting every imperative
  // `.title=` assignment app-wide (see openQueueDashboard()/
  // closeQueueDashboard() above).
  if($("queueBtn")&&$("queueDashboard")){
    $("queueBtn").title=$("queueDashboard").classList.contains("show")?t("global.topbar.back_to_fleet_title"):t("settings.tabs.queue");
  }
  // First-run onboarding's welcome banner — set once when Settings opens
  // for a never-configured install, cleared on first successful save
  // (loadConfigUI()'s own caller sets it, saveConfig() clears it to "").
  // A user could plausibly switch language mid-onboarding before saving,
  // so keep it current rather than leaving it in whatever locale was
  // active when onboarding started.
  if($("setupmsg")&&$("setupmsg").textContent) $("setupmsg").textContent=t("settings.onboarding_welcome");
}
// Pure re-renders off already-cached queue/pool state (QUEUE_VIEW_DATA,
// QUEUE_STORE_STATUS, PRINTER_POOLS) — no network call, same invariant as
// Remote Access's cached refresh. renderQueueDashboard() rebuilds the whole
// Command Center body, so it's gated on the dashboard actually being the
// visible full-page view (same visibility-gating idea as the Remote Access
// poller only running while its tab is open) — the two Settings-tab
// renders are cheap and already no-op safely when their cards aren't shown.
function refreshQueueManagementDynamicText(){
  renderPrinterPoolsList();
  renderQueueStoreWarning();
  if($("queueDashboard")&&$("queueDashboard").classList.contains("show")) renderQueueDashboard();
}
// Row summary headers fall back to "New Printer" (translated) only while the
// name field is blank — that fallback text is set once at row-creation time
// and on each keystroke (see the .pname "input" listener in addPrinterRow),
// neither of which fires on a live language switch, so a blank row's summary
// would otherwise keep showing the old locale's fallback text.
function refreshBlankPrinterRowSummaries(){
  const wrap=$("setPrinters");
  if(!wrap) return;
  wrap.querySelectorAll(".prow").forEach(row=>{
    const nameEl=row.querySelector(".pname"), sumName=row.querySelector(".prow-sumname");
    if(nameEl&&sumName&&!nameEl.value.trim()) sumName.textContent=t("settings.printers.new_printer_default");
  });
}
// Same idea as applyAccountTheme above, but for language — only relevant
// for a fresh login mid-session (init()'s own initI18n() call already
// resolves user->system default->en at page load). Re-renders the
// currently-visible Settings UI in place via applyI18nToDom() rather than
// reloading — no application-wide reactive rendering system exists (or is
// needed) since only Settings is translated in this phase.
async function applyAccountLocale(user){
  const target=(user&&user.locale)||SYSTEM_DEFAULT_LOCALE;
  if(target===i18nCurrentLocale()) return;
  await setI18nLocale(target);
  applyI18nToDom();
  refreshDynamicI18nText();
}
// Populates every per-user/system language <select> from the same
// /api/locales discovery call — #setLocale (Settings > General,
// admin-editable system default, installed locales only), #setUserLocale
// (Settings > View, per-user override, deferred to that tab's own Save),
// and #topbarLocale (the compact "My language" picker next to Logout,
// applies+saves immediately — see chooseUserLocale). The latter two share
// the same option set: installed locales plus a leading
// "System default — X" option for "inherit, don't override". Called once
// t() is ready (after initI18n()) so the "System default" option's own
// label is translated correctly on first paint, not just after a later
// re-render.
async function populateLocaleSelectors(){
  let list=[];
  try{ const d=await getJSON("/api/locales"); list=d.locales||[]; }catch{}
  const optsHtml=list.map(l=>`<option value="${esc(l.locale)}">${esc(l.nativeName||l.language||l.locale)}</option>`).join("");
  if($("setLocale")){ $("setLocale").innerHTML=optsHtml; $("setLocale").value=SYSTEM_DEFAULT_LOCALE; }
  const sysEntry=list.find(l=>l.locale===SYSTEM_DEFAULT_LOCALE);
  const sysLabel=t("settings.view.language_default_option",{locale:sysEntry?(sysEntry.nativeName||sysEntry.language||SYSTEM_DEFAULT_LOCALE):SYSTEM_DEFAULT_LOCALE});
  const userOptsHtml=`<option value="">${esc(sysLabel)}</option>`+optsHtml;
  const userValue=(USERS_ENABLED&&CURRENT_USER&&CURRENT_USER.locale)||"";
  if($("setUserLocale")){ $("setUserLocale").innerHTML=userOptsHtml; $("setUserLocale").value=userValue; }
  if($("topbarLocale")){ $("topbarLocale").innerHTML=userOptsHtml; $("topbarLocale").value=userValue; }
}
// Persists a per-user locale override (or null, meaning "follow system
// default") to the account — the one place either control actually talks
// to the server, so #setUserLocale (Settings > View) and #topbarLocale
// (the compact picker) can never drift into two different save paths.
// A no-op without a real account, same guard the route itself enforces.
async function saveUserLocalePreference(value){
  if(!(USERS_ENABLED&&CURRENT_USER)) return;
  try{
    await postJSON("/api/session/locale",{locale:value||null});
    CURRENT_USER.locale=value||null;
  }catch{}
}
// The compact topbar picker has no surrounding form/Save button, so unlike
// Settings > View's #setUserLocale (live-preview only, persisted through
// the normal Settings Save flow), this applies AND saves immediately —
// the same instant-apply UX as the theme toggle.
async function chooseUserLocale(value){
  await setI18nLocale(value||SYSTEM_DEFAULT_LOCALE);
  applyI18nToDom();
  refreshDynamicI18nText();
  await saveUserLocalePreference(value);
  await populateLocaleSelectors();
}

// ---- Language Editor ----
// Admin-only (every mutating route is requireAdmin server-side — this UI
// only controls what's shown, never what's allowed). English is always
// present as a read-only reference chip; every other installed locale is
// editable. State is intentionally simple: one locale loaded/edited at a
// time, matching wireModal's existing single-purpose-modal convention
// rather than a multi-document editor.
let LANG_ED_LIST=[];        // [{locale,language,nativeName,version,snapconVersion,updated,completionPercent}]
let LANG_ED_CURRENT=null;   // locale code currently loaded into the editor, or null
let LANG_ED_DATA=null;      // full nested JSON of the currently loaded locale (mutated in place as the admin edits)
let LANG_ED_FINGERPRINT=null;
let LANG_ED_EN_FLAT={};     // English, flattened — the canonical key set/source text
let LANG_ED_SAVE_ANYWAY=false; // set once the admin explicitly confirms saving despite a placeholder mismatch

// Client-side mirror of locales.js's flattenKeys/extractPlaceholders — small
// enough, and genuinely can't require() the server module from a browser
// script, so this is necessary duplication across the client/server
// boundary rather than avoidable "parallel infrastructure."
function i18nFlatten(obj,prefix){
  const out={};
  if(!obj||typeof obj!=="object"||Array.isArray(obj)) return out;
  for(const k of Object.keys(obj)){
    if((prefix||"")===""&&k==="_meta") continue;
    const key=prefix?prefix+"."+k:k;
    const v=obj[k];
    if(v&&typeof v==="object"&&!Array.isArray(v)) Object.assign(out,i18nFlatten(v,key));
    else out[key]=v;
  }
  return out;
}
function i18nPlaceholders(str){
  const set=new Set();
  if(typeof str!=="string") return set;
  const re=/\{(\w+)\}/g; let m;
  while((m=re.exec(str))) set.add(m[1]);
  return set;
}
function i18nPlaceholdersEqual(a,b){
  if(a.size!==b.size) return false;
  for(const x of a) if(!b.has(x)) return false;
  return true;
}
function i18nSetNested(obj,dottedKey,value){
  const parts=dottedKey.split(".");
  let cur=obj;
  for(let i=0;i<parts.length-1;i++){
    if(typeof cur[parts[i]]!=="object"||cur[parts[i]]===null) cur[parts[i]]={};
    cur=cur[parts[i]];
  }
  cur[parts[parts.length-1]]=value;
}

async function openLanguageEditor(){
  $("langEditorModal").classList.add("show");
  $("langNewForm").style.display="none";
  $("langImportForm").style.display="none";
  await loadLangEditorList();
}
function closeLanguageEditor(){
  $("langEditorModal").classList.remove("show");
  LANG_ED_CURRENT=null; LANG_ED_DATA=null; LANG_ED_FINGERPRINT=null; LANG_ED_SAVE_ANYWAY=false;
}
async function loadLangEditorList(){
  try{
    const d=await getJSON("/api/locales");
    LANG_ED_LIST=d.locales||[];
  }catch{ LANG_ED_LIST=[]; }
  renderLangChips();
  const stillExists=LANG_ED_CURRENT&&LANG_ED_LIST.some(l=>l.locale===LANG_ED_CURRENT);
  if(!stillExists){
    const firstNonEn=LANG_ED_LIST.find(l=>l.locale!=="en");
    await selectLangEditorLocale(firstNonEn?firstNonEn.locale:"en");
  }
}
function renderLangChips(){
  $("langChipsRow").innerHTML=LANG_ED_LIST.map(l=>{
    const active=l.locale===LANG_ED_CURRENT?" active":"";
    const label=l.locale==="en"
      ? esc(l.nativeName||"English")+" — "+t("settings.language_editor.english_source_badge")
      : esc(l.nativeName||l.language||l.locale)+" — "+l.completionPercent+"%";
    return `<button type="button" class="btn ghost lang-chip${active}" data-lang-chip="${esc(l.locale)}">${label}</button>`;
  }).join("");
  $("langChipsRow").querySelectorAll("[data-lang-chip]").forEach(btn=>{
    btn.addEventListener("click",()=>selectLangEditorLocale(btn.dataset.langChip));
  });
}
async function selectLangEditorLocale(locale){
  try{
    const d=await getJSON("/api/locales/"+encodeURIComponent(locale));
    if(locale==="en"){ LANG_ED_EN_FLAT=i18nFlatten(d.data); }
    LANG_ED_CURRENT=locale;
    LANG_ED_DATA=d.data;
    LANG_ED_FINGERPRINT=d.fingerprint;
    LANG_ED_SAVE_ANYWAY=false;
    if(!LANG_ED_EN_FLAT||!Object.keys(LANG_ED_EN_FLAT).length){
      // English hasn't been loaded into this editor session yet (first
      // thing selected was a non-English chip) — fetch it once, silently.
      try{ const enD=await getJSON("/api/locales/en"); LANG_ED_EN_FLAT=i18nFlatten(enD.data); }catch{}
    }
  }catch(e){
    LANG_ED_CURRENT=locale; LANG_ED_DATA=null; LANG_ED_FINGERPRINT=null;
  }
  renderLangChips();
  renderLangMeta();
  $("langConflictWarning").style.display="none";
  renderLangKeyList();
  renderLangOrphans();
  renderLangFooter();
}
function renderLangMeta(){
  const panel=$("langMetaPanel");
  if(!LANG_ED_DATA){ panel.innerHTML=""; return; }
  const meta=LANG_ED_DATA._meta||{};
  const isEn=LANG_ED_CURRENT==="en";
  panel.innerHTML=
    `<div class="settings-field"><label class="settings-label">${t("settings.language_editor.meta_locale")}</label><input class="field" value="${esc(meta.locale||"")}" disabled></div>`+
    `<div class="settings-field"><label class="settings-label">${t("settings.language_editor.meta_language")}</label><input class="field" id="langMetaLanguage" value="${esc(meta.language||"")}" ${isEn?"disabled":""}></div>`+
    `<div class="settings-field"><label class="settings-label">${t("settings.language_editor.meta_native_name")}</label><input class="field" id="langMetaNativeName" value="${esc(meta.nativeName||"")}" ${isEn?"disabled":""}></div>`+
    `<div class="settings-field"><label class="settings-label">${t("settings.language_editor.meta_version")}</label><input class="field" value="${esc(String(meta.version||0))}" disabled></div>`+
    `<div class="settings-field"><label class="settings-label">${t("settings.language_editor.meta_snapcon_version")}</label><input class="field" value="${esc(meta.snapconVersion||"—")}" disabled></div>`+
    `<div class="settings-field"><label class="settings-label">${t("settings.language_editor.meta_updated")}</label><input class="field" value="${esc(meta.updated||"—")}" disabled></div>`;
  if(!isEn){
    $("langMetaLanguage").addEventListener("input",()=>{ LANG_ED_DATA._meta.language=$("langMetaLanguage").value; });
    $("langMetaNativeName").addEventListener("input",()=>{ LANG_ED_DATA._meta.nativeName=$("langMetaNativeName").value; renderLangChips(); });
  }
  const stale=meta.snapconVersion&&meta.snapconVersion!==VERSION;
  $("langStaleNote").style.display=(!isEn&&stale)?"":"none";
  $("langStaleNote").textContent=t("settings.language_editor.stale_version_note");
}
function renderLangKeyList(){
  const box=$("langKeyList");
  if(!LANG_ED_DATA){ box.innerHTML=""; return; }
  const isEn=LANG_ED_CURRENT==="en";
  const localeFlat=i18nFlatten(LANG_ED_DATA);
  const search=($("langSearch").value||"").trim().toLowerCase();
  const untranslatedOnly=$("langUntranslatedOnly").checked;
  let untranslatedCount=0;
  const rows=Object.keys(LANG_ED_EN_FLAT).sort().filter(key=>{
    const enText=LANG_ED_EN_FLAT[key];
    const trVal=localeFlat[key];
    const isUntranslated=!(typeof trVal==="string"&&trVal.trim()!=="");
    if(isUntranslated) untranslatedCount++;
    if(untranslatedOnly&&!isEn&&!isUntranslated) return false;
    if(search&&!key.toLowerCase().includes(search)&&!String(enText).toLowerCase().includes(search)) return false;
    return true;
  }).map(key=>{
    const enText=LANG_ED_EN_FLAT[key];
    const trVal=localeFlat[key];
    const isUntranslated=!(typeof trVal==="string"&&trVal.trim()!=="");
    const enPh=i18nPlaceholders(enText);
    const trPh=i18nPlaceholders(typeof trVal==="string"?trVal:"");
    const mismatch=!isEn&&!isUntranslated&&enPh.size>0&&!i18nPlaceholdersEqual(enPh,trPh);
    return `<div class="lang-key-row${isUntranslated&&!isEn?" untranslated":""}${mismatch?" placeholder-mismatch":""}" data-lang-key="${esc(key)}">`+
      `<div class="lang-key-cell lang-key-key">${esc(key)}</div>`+
      `<div class="lang-key-cell lang-key-en">${esc(String(enText))}</div>`+
      `<div class="lang-key-cell lang-key-tr">${isEn
        ? `<span>${esc(String(enText))}</span>`
        : `<input class="field lang-tr-input" data-lang-tr-key="${esc(key)}" value="${esc(typeof trVal==="string"?trVal:"")}">`
      }${mismatch?`<div class="settings-help err">${esc(t("settings.language_editor.placeholder_mismatch_warning"))}</div>`:""}</div>`+
    `</div>`;
  }).join("");
  box.innerHTML=rows||`<div style="padding:14px;color:var(--ink-faint);font-size:13px">—</div>`;
  if(!isEn){
    box.querySelectorAll("[data-lang-tr-key]").forEach(input=>{
      input.addEventListener("input",()=>{
        i18nSetNested(LANG_ED_DATA,input.dataset.langTrKey,input.value);
        LANG_ED_SAVE_ANYWAY=false;
        renderLangFooter();
      });
    });
  }
  updateLangUntranslatedCount();
}
// Split out from renderLangKeyList() so a live locale switch can refresh
// just this count (see refreshLangEditorDynamicText()) without rebuilding
// the key list's own <input> fields, which would discard any translation
// the admin is actively mid-edit on.
function updateLangUntranslatedCount(){
  if(!LANG_ED_DATA){ $("langUntranslatedCount").textContent=""; return; }
  const isEn=LANG_ED_CURRENT==="en";
  const localeFlat=i18nFlatten(LANG_ED_DATA);
  let untranslatedCount=0;
  Object.keys(LANG_ED_EN_FLAT).forEach(key=>{
    const trVal=localeFlat[key];
    if(!(typeof trVal==="string"&&trVal.trim()!=="")) untranslatedCount++;
  });
  $("langUntranslatedCount").textContent=isEn?"":tn("settings.language_editor.untranslated_count",untranslatedCount);
}
function renderLangOrphans(){
  const section=$("langOrphanedSection");
  if(!LANG_ED_DATA||LANG_ED_CURRENT==="en"){ section.style.display="none"; return; }
  const localeFlat=i18nFlatten(LANG_ED_DATA);
  const orphans=Object.keys(localeFlat).filter(k=>!(k in LANG_ED_EN_FLAT));
  section.style.display=orphans.length?"":"none";
  $("langOrphanedList").innerHTML=orphans.map(key=>
    `<div style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="font-family:var(--mono);color:var(--ink-faint);flex:1">${esc(key)}</span><button type="button" class="btn ghost" data-orphan-remove="${esc(key)}" style="padding:3px 8px;font-size:12px">${t("common.remove")}</button></div>`
  ).join("");
  $("langOrphanedList").querySelectorAll("[data-orphan-remove]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const parts=btn.dataset.orphanRemove.split(".");
      let cur=LANG_ED_DATA;
      for(let i=0;i<parts.length-1;i++){ if(!cur[parts[i]]) return; cur=cur[parts[i]]; }
      delete cur[parts[parts.length-1]];
      renderLangOrphans();
    });
  });
}
function renderLangFooter(){
  if(!LANG_ED_DATA||LANG_ED_CURRENT==="en"){ $("langFooterProgress").textContent=""; return; }
  const localeFlat=i18nFlatten(LANG_ED_DATA);
  const totalKeys=Object.keys(LANG_ED_EN_FLAT);
  const translated=totalKeys.filter(k=>typeof localeFlat[k]==="string"&&localeFlat[k].trim()!=="").length;
  const percent=totalKeys.length?Math.round((translated/totalKeys.length)*100):100;
  $("langFooterProgress").textContent=t("settings.language_editor.footer_progress",{translated,total:totalKeys.length,percent});
}
// Live-locale-switch refresh for the app's OWN chrome around the editor —
// found during Fleet Phase 3-style testing (this exact class of bug, twice
// already: healthBtn/queueBtn's imperative titles). renderLangChips()/
// renderLangOrphans()/renderLangFooter() are all safe to fully re-render
// (buttons and plain text, no user-typed input). renderLangMeta()'s
// Language-name/Native-name fields and renderLangKeyList()'s per-key
// translation <input>s are deliberately NOT touched here — rebuilding them
// would discard whatever the admin is actively mid-edit on; the labels
// around those specific inputs stay in whatever locale was active when
// this locale was selected, same "closes/reopens cleanly" gap already
// accepted for the unload modal's secondary line.
function refreshLangEditorDynamicText(){
  if(!$("langEditorModal")||!$("langEditorModal").classList.contains("show")) return;
  renderLangChips();
  updateLangUntranslatedCount();
  renderLangOrphans();
  renderLangFooter();
}
async function saveLangEditor(){
  if(!LANG_ED_DATA||LANG_ED_CURRENT==="en"||!LANG_ED_CURRENT) return;
  const localeFlat=i18nFlatten(LANG_ED_DATA);
  const mismatches=Object.keys(LANG_ED_EN_FLAT).filter(key=>{
    const trVal=localeFlat[key];
    if(!(typeof trVal==="string"&&trVal.trim()!=="")) return false;
    const enPh=i18nPlaceholders(LANG_ED_EN_FLAT[key]);
    if(enPh.size===0) return false;
    return !i18nPlaceholdersEqual(enPh,i18nPlaceholders(trVal));
  });
  if(mismatches.length&&!LANG_ED_SAVE_ANYWAY){
    if(!confirm(t("settings.language_editor.placeholder_mismatch_warning")+" ("+mismatches.length+")\n\n"+t("settings.language_editor.save_anyway")+"?")) return;
    LANG_ED_SAVE_ANYWAY=true;
  }
  try{
    const r=await postJSON("/api/locales/"+encodeURIComponent(LANG_ED_CURRENT),{data:LANG_ED_DATA,expectedFingerprint:LANG_ED_FINGERPRINT});
    if(r.status===409){
      $("langConflictWarning").style.display="";
      $("langConflictWarning").textContent=t("settings.language_editor.conflict_message");
      return;
    }
    const d=await r.json();
    if(d.error) throw new Error(d.error);
    await loadLangEditorList();
    await populateLocaleSelectors();
    if((USERS_ENABLED&&CURRENT_USER&&CURRENT_USER.locale)===LANG_ED_CURRENT||SYSTEM_DEFAULT_LOCALE===LANG_ED_CURRENT){
      await setI18nLocale(i18nCurrentLocale()); applyI18nToDom(); refreshDynamicI18nText();
    }
  }catch(e){ alert(e.message); }
}
async function createLangEditorLanguage(){
  const locale=$("langNewLocale").value.trim();
  const language=$("langNewLanguage").value.trim();
  const nativeName=$("langNewNativeName").value.trim();
  const st=$("langNewStatus");
  st.className="pstatus work"; st.textContent="…";
  try{
    const r=await (await postJSON("/api/locales",{locale,language,nativeName})).json();
    if(r.error) throw new Error(r.error);
    st.className="pstatus ok"; st.textContent="";
    $("langNewForm").style.display="none";
    $("langNewLocale").value=""; $("langNewLanguage").value=""; $("langNewNativeName").value="";
    await loadLangEditorList();
    await selectLangEditorLocale(locale);
    await populateLocaleSelectors();
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}
let LANG_IMPORT_PARSED=null;
async function handleLangImportFile(){
  const file=$("langImportFile").files[0];
  $("langImportCommit").disabled=true;
  $("langImportPreview").textContent="";
  LANG_IMPORT_PARSED=null;
  if(!file) return;
  const st=$("langImportStatus");
  try{
    const text=await file.text();
    const parsed=JSON.parse(text);
    const locale=parsed&&parsed._meta&&parsed._meta.locale;
    if(!locale) throw new Error(t("settings.language_editor.import_error_no_locale"));
    const preview=await (await postJSON("/api/locales/"+encodeURIComponent(locale)+"/import-preview",{data:parsed})).json();
    if(preview.error) throw new Error(preview.error);
    LANG_IMPORT_PARSED={locale,data:parsed};
    $("langImportPreview").textContent=
      t("settings.language_editor.import_preview_recognized",{count:preview.recognizedKeys})+" · "+
      t("settings.language_editor.import_preview_missing",{count:preview.missingKeys})+" · "+
      t("settings.language_editor.import_preview_orphaned",{count:preview.orphanedKeys})+" · "+
      t("settings.language_editor.import_preview_placeholder_errors",{count:preview.placeholderErrors});
    $("langImportCommit").disabled=false;
    st.textContent="";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}
async function commitLangImport(){
  if(!LANG_IMPORT_PARSED) return;
  const st=$("langImportStatus");
  try{
    const importedLocale=LANG_IMPORT_PARSED.locale;
    const r=await (await postJSON("/api/locales/"+encodeURIComponent(importedLocale)+"/import",{data:LANG_IMPORT_PARSED.data})).json();
    if(r.error) throw new Error(r.error);
    $("langImportForm").style.display="none";
    $("langImportFile").value=""; $("langImportPreview").textContent=""; LANG_IMPORT_PARSED=null;
    await loadLangEditorList();
    await selectLangEditorLocale(importedLocale);
    await populateLocaleSelectors();
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}
function exportLangEditorLocale(){
  if(!LANG_ED_DATA||LANG_ED_CURRENT==="en") return;
  const blob=new Blob([JSON.stringify(LANG_ED_DATA,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download=LANG_ED_CURRENT+".json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function wireUI(){
  wireModal("platemodal", closePlate, ["platex","plateCancel"]);
  $("plateSkip").addEventListener("click", doPlateSkip);
  wireModal("thumbmodal", closeThumb, ["thumbx"]);
  wireModal("snapmodal", closeSnapshot, ["snapx"]);
  // The X button always fully closes; Cancel and the backdrop are mode-aware
  // (back out of color mode instead of closing, when a color edit is in
  // progress) — not run through wireModal(), which assumes one close
  // behavior for everything.
  $("unloadx").addEventListener("click", closeUnload);
  $("unloadNo").addEventListener("click", unloadCancelClicked);
  $("unloadmodal").addEventListener("click", e=>{ if(e.target===$("unloadmodal")) unloadCancelClicked(); });
  $("unloadEditColorBtn").addEventListener("click", enterColorMode);
  document.querySelectorAll("#unloadColorTabs .scc-tab").forEach(b=>{
    b.addEventListener("click",()=>{ SPOOL_MODAL_TAB=b.dataset.scctab; renderUnloadColorTabs(); });
  });
  $("unloadHexField").addEventListener("input",()=>applyCustomHex($("unloadHexField").value));
  $("unloadColorInput").addEventListener("input",applyNativeColor);
  ["unloadR","unloadG","unloadB"].forEach(id=>$(id).addEventListener("input",applyCustomRgb));
  // Feature-detected, not assumed — EyeDropper is Chromium-only as of this
  // writing. The button stays hidden (its default state in the markup) on
  // any browser without it.
  if(typeof window.EyeDropper!=="undefined"){
    $("unloadEyedropper").style.display="";
    $("unloadEyedropper").addEventListener("click",async ()=>{
      try{
        const result=await new window.EyeDropper().open();
        if(result&&result.sRGBHex) setPendingColor(result.sRGBHex,null);
      }catch{ /* user pressed Escape / cancelled — not an error */ }
    });
  }
  $("unloadSaveColorBtn").addEventListener("click", doApplyUnloadColor);
  $("unloadAllCheck").addEventListener("change", updateUnloadConfirmLabel);
  wireModal("quickPrintModal", closeQuickPrintModal, ["qpX","qpCancel"]);
  $("qpPrint").addEventListener("click", doQuickPrint);
  // Single-button toggle, same convention as #gear: click opens the
  // dashboard, clicking it again while open closes it — there's no separate
  // close/X button now that this is a full-page view, not a modal.
  $("queueBtn").addEventListener("click", ()=>{
    if($("queueDashboard").classList.contains("show")) closeQueueDashboard();
    else openQueueDashboard();
  });
  $("healthBtn").addEventListener("click", ()=>{
    if($("healthPage").classList.contains("show")) closeHealthPage();
    else openHealthPage();
  });
  $("themeBtn").addEventListener("click", ()=>{
    const next=document.documentElement.getAttribute("data-theme")==="light"?"dark":"light";
    document.documentElement.setAttribute("data-theme",next);
    localStorage.setItem("snapcon-theme",next);
    syncThemeButton();
    // Best-effort: this device already has the new theme regardless of
    // whether the save round-trips, so nothing here needs to be awaited or
    // surfaced as an error — a failed save just means the NEXT device/login
    // won't pick it up yet.
    if(USERS_ENABLED && CURRENT_USER){
      CURRENT_USER.theme=next;
      fetch("/api/session/theme",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({theme:next})}).catch(()=>{});
    }
  });
  syncThemeButton();
  // No stored choice yet — the page opened on whatever prefers-color-scheme
  // said at load (see the inline <head> script). Keep following the OS
  // setting live until the user makes an explicit pick via the button
  // above, at which point localStorage.getItem below stops returning null
  // and this listener becomes a no-op forever.
  if(window.matchMedia){
    const mq=window.matchMedia("(prefers-color-scheme: light)");
    const onOsThemeChange=(e)=>{
      if(localStorage.getItem("snapcon-theme")) return;
      document.documentElement.setAttribute("data-theme",e.matches?"light":"dark");
      syncThemeButton();
    };
    if(mq.addEventListener) mq.addEventListener("change",onOsThemeChange);
    else if(mq.addListener) mq.addListener(onOsThemeChange);
  }
  // Live preview only — instant re-render via applyI18nToDom(), matching
  // the "re-render Settings in place, no reload" decision. The actual
  // account-level persistence happens through the normal Settings Save
  // flow (see saveConfig()), same as every other View-tab field; if the
  // admin navigates away without saving, the next load just re-resolves to
  // whatever WAS actually saved, same as any other unsaved View field.
  if($("setUserLocale")){
    $("setUserLocale").addEventListener("change", async ()=>{
      const val=$("setUserLocale").value;
      await setI18nLocale(val||SYSTEM_DEFAULT_LOCALE);
      applyI18nToDom();
      refreshDynamicI18nText();
    });
  }
  // Compact "My language" picker (topbar, next to Logout) — reachable by
  // every signed-in role, not just Admin (Settings itself stays
  // Admin-only; this is the deliberately small, no-restructuring answer to
  // that gap). Applies and saves immediately through the same
  // chooseUserLocale()/saveUserLocalePreference() path #setUserLocale
  // above eventually calls through on Save — one persistence path, two
  // entry points.
  if($("topbarLocale")) $("topbarLocale").addEventListener("change", ()=>chooseUserLocale($("topbarLocale").value));
  if($("editLanguagesBtn")) $("editLanguagesBtn").addEventListener("click", openLanguageEditor);
  wireModal("langEditorModal", closeLanguageEditor, ["langEditorX","langEditorCancel"]);
  $("langEditorSave").addEventListener("click", saveLangEditor);
  $("langRefreshBtn").addEventListener("click", async ()=>{ await postJSON("/api/locales/refresh",{}); await loadLangEditorList(); });
  $("langExportBtn").addEventListener("click", exportLangEditorLocale);
  $("langSearch").addEventListener("input", renderLangKeyList);
  $("langUntranslatedOnly").addEventListener("change", renderLangKeyList);
  $("langNewBtn").addEventListener("click", ()=>{ $("langImportForm").style.display="none"; $("langNewForm").style.display=$("langNewForm").style.display==="none"?"":"none"; });
  $("langNewCancel").addEventListener("click", ()=>{ $("langNewForm").style.display="none"; });
  $("langNewCreate").addEventListener("click", createLangEditorLanguage);
  $("langImportBtn").addEventListener("click", ()=>{ $("langNewForm").style.display="none"; $("langImportForm").style.display=$("langImportForm").style.display==="none"?"":"none"; });
  $("langImportCancel").addEventListener("click", ()=>{ $("langImportForm").style.display="none"; $("langImportFile").value=""; $("langImportPreview").textContent=""; LANG_IMPORT_PARSED=null; });
  $("langImportFile").addEventListener("change", handleLangImportFile);
  $("langImportCommit").addEventListener("click", commitLangImport);
  $("healthSvcCancel").addEventListener("click", closeHealthServiceForm);
  $("healthSvcSave").addEventListener("click", saveHealthService);
  $("healthSvcOffline").addEventListener("change", toggleHealthOffline);
  $("healthSvcDate").addEventListener("input", updateHealthNextDuePreview);
  $("healthSvcFrequency").addEventListener("change", updateHealthNextDuePreview);
  $("healthSvcComponentOther").addEventListener("input", ()=>{ updateHealthNextDuePreview(); syncHealthSvcSaveEnabled(); });
  wireModal("sendQueueModal", closeSendQueueModal, ["sendQueueX","sendQueueCancel"]);
  $("sendToQueueBtn").addEventListener("click", openSendQueueModal);
  $("sendQueuePool").addEventListener("change", renderSendQueuePreview);
  document.querySelectorAll('input[name="sendQueueMode"]').forEach(r=>r.addEventListener("change", renderSendQueuePreview));
  $("sendQueueAdd").addEventListener("click", ()=>doSendQueue(false));
  $("sendQueueAddStart").addEventListener("click", ()=>doSendQueue(true));
  wireModal("tagsmodal", closeTagsModal, ["tagsx","tagsCancel"]);
  $("tagsSave").addEventListener("click", saveTagsEditor);
  $("camEditTags").addEventListener("click", openTagsEditor);
  wireModal("groupsModal", closeGroupsModal, ["groupsModalX","groupsModalCancel"]);
  $("groupsModalSave").addEventListener("click", ()=>{
    if(GROUPS_MODAL_ROW) GROUPS_MODAL_ROW.dataset.groupIds=JSON.stringify(checkedGroupIds());
    closeGroupsModal();
  });
  $("addGroupBtn").addEventListener("click", async ()=>{
    const name=$("newGroupName").value.trim();
    const st=$("groupsManageStatus");
    if(!name){ st.className="pstatus err"; st.textContent=t("settings.users.enter_a_name"); return; }
    st.className="pstatus work"; st.textContent=t("settings.users.adding_group");
    try{
      const r=await fetch("/api/groups",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});
      const d=await r.json(); if(!r.ok||d.error) throw new Error(userErrorText(d,d.error||("HTTP "+r.status)));
      const kept=checkedGroupIds();
      await loadGroupsUI();
      $("newGroupName").value="";
      renderGroupsCheckList(kept);
      renderGroupsManageList();
      st.className="pstatus ok"; st.textContent=t("settings.users.group_added");
    }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  });
  document.querySelectorAll("#camTabs button[data-camtab]").forEach(b=>{
    b.addEventListener("click",()=>{ CAM_TAB=b.dataset.camtab; renderFleet(); });
  });
  $("camTagFilter").addEventListener("change",()=>{ CAM_TAG_FILTER=$("camTagFilter").value; renderFleet(); });
  $("camSelectAll").addEventListener("change",()=>{
    const checked=$("camSelectAll").checked;
    $("fleet").querySelectorAll(".cam-chk").forEach(el=>{
      el.checked=checked;
      const id=parseInt(el.dataset.camsel,10);
      if(checked) CAM_SELECTED.add(id); else CAM_SELECTED.delete(id);
    });
    updateCamToolbar();
  });
  wireModal("bedmodal", closeBedModal, ["bedmodalx","bedmodalcancel"]);
  wireHoldConfirmDialog();
  wireModal("bulkheatmodal", closeBulkHeatModal, ["bulkheatx","bulkheatCancel"]);
  $("bulkHeatBtn").addEventListener("click", openBulkHeat);
  $("bulkheatSelectAll").addEventListener("change", bulkheatToggleSelectAll);
  $("bulkheatSlider").addEventListener("input", ()=>updateBulkHeatTemp(parseInt($("bulkheatSlider").value,10)));
  $("bulkheatPresets").addEventListener("click", e=>{
    const btn=e.target.closest(".btn-chip[data-preset]");
    if(btn) updateBulkHeatTemp(parseInt(btn.dataset.preset,10));
  });
  $("bulkheatStagger").addEventListener("change", ()=>{
    $("bulkheatStaggerSecs").disabled = !$("bulkheatStagger").checked;
    updateBulkHeatSummary();
  });
  $("bulkheatStaggerSecs").addEventListener("input", updateBulkHeatSummary);
  $("bulkheatCancelQueue").addEventListener("click", ()=>{ BULKHEAT_CANCEL=true; });
  $("bulkheatGo").addEventListener("click", doBulkHeat);
  wireModal("subnetModal", closeSubnetModal, ["subnetModalX","subnetModalCancel"]);
  $("subnetModalScan").addEventListener("click", doSubnetScan);
  wireModal("newFolderModal", closeNewFolderModal, ["newFolderModalX","newFolderModalCancel"]);
  $("newFolderModalCreate").addEventListener("click", doCreateFolder);
  $("newFolderModalInput").addEventListener("keydown", e=>{ if(e.key==="Enter") doCreateFolder(); });
  $("newFolderBtn").addEventListener("click", openNewFolderModal);
  $("uploadFilesBtn").addEventListener("click", ()=>$("uploadFilesInput").click());
  $("uploadFilesInput").addEventListener("change", e=>{ uploadLocalFiles(e.target.files); e.target.value=""; });
  $("multiselectClear").addEventListener("click", ()=>{ SELECTED_FILES.clear(); SELECT_ANCHOR=null; updateMultiSelectUI(); renderList(); });
  wireFileDrag();
  wireModal("maintReportModal", closeMaintReport, ["maintReportX","maintCancel"]);
  $("maintPrinterSel").addEventListener("change", ()=>loadMaintDetail(parseInt($("maintPrinterSel").value,10)));
  $("maintSave").addEventListener("click", saveMaintenance);
  $("maintOfflineToggle").addEventListener("change", toggleMaintenanceMode);
  $("maintDate").addEventListener("change", updateNextScheduledPreview);
  $("maintFrequency").addEventListener("change", updateNextScheduledPreview);
  $("maintComponentFilter").addEventListener("input", onMaintComponentChange);
  wireModal("browsemodal", closeBrowse, ["browsex","browsecancel"]);
  wireModal("fwpickmodal", closeFirmwarePicker, ["fwpickx","fwpickcancel"]);
  wireModal("elecmodal", closeElecModal, ["elecmodalx","elecmodalcancel"]);
  wireModal("sendmodal", closeSendModal, ["sendmodalx","sendmodalcancel"]);
  wireModal("pfilemodal", closePrinterFiles, ["pfilex","pfilecancel"]);
  $("pfilego").addEventListener("click", doPrintFile);
  $("pfileSearch").addEventListener("input", renderPfileList);

  $("snaprefresh").addEventListener("click", loadSnapshot);
  $("browseBtn").addEventListener("click", ()=>openBrowse("setFolder"));
  $("browseLogsBtn").addEventListener("click", ()=>openBrowse("setLogsFolder"));
  $("browseCameraBtn").addEventListener("click", ()=>openBrowse("setCameraFolder"));
  $("browseFirmwareBtn").addEventListener("click", ()=>openBrowse("setFirmwareFolder"));
  $("browseGcodeSyncBtn").addEventListener("click", ()=>openBrowse("setGcodeSyncFolder"));
  // 0 and blank mean different things here (blank = never delete, 0 would
  // mean delete immediately) but the save path already treats "0 days" as
  // "never" (see saveConfig's `>0` check) — so a field showing "0" would
  // silently behave as "never" while still looking like a real, different
  // value. Reject it at the source: any non-positive entry collapses back
  // to blank immediately, the same state a user clearing the field reaches.
  ["setLogsRetentionDays","setCameraRetentionDays","setGcodeSyncRetentionDays"].forEach(id=>{
    $(id).addEventListener("input", ()=>{
      const el=$(id);
      if(el.value!=="" && parseInt(el.value,10)<=0) el.value="";
    });
  });
  $("browsego").addEventListener("click", ()=>navigateBrowse($("browsepath").value.trim()));
  $("browsepath").addEventListener("keydown", e=>{ if(e.key==="Enter") navigateBrowse($("browsepath").value.trim()); });
  $("browseok").addEventListener("click", ()=>{
    const p=$("browsepath").value.trim();
    if(p){
      $(BROWSE_TARGET_FIELD).value=p;
      if(BROWSE_TARGET_FIELD==="setFolder") scheduleFolderCheck();
      updateSettingsDirtyBar("general");
    }
    closeBrowse();
  });
  $("setFolder").addEventListener("input", scheduleFolderCheck);
  $("setFirmwareFolder").addEventListener("input", scheduleFirmwareFolderCheck);
  $("setRefresh").addEventListener("input", updateRefreshHelper);
  $("setCurrency").addEventListener("change", updateCurrencyLabels);
  $("setAllowMapping").addEventListener("change", syncAutoMatchNesting);
  $("generalDiscard").addEventListener("click", ()=>discardSettingsTab("general"));
  $("generalSaveBtn").addEventListener("click", saveConfig);
  $("elecSearch").addEventListener("click", openElecModal);
  $("elecLookup").addEventListener("click", doElecLookup);
  $("elecZip").addEventListener("keydown", e=>{ if(e.key==="Enter") doElecLookup(); });
  $("elecApply").addEventListener("click", ()=>{ closeElecModal(); });

  wireFleetCardEvents();
  wireFleetDrag();
  wirePrinterDrag();

  applySortUI();
  $("sortBtn").addEventListener("click", e=>{ e.stopPropagation(); $("sortMenu").classList.toggle("open"); });
  document.querySelectorAll("#sortMenu .sort-opt").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      SORT_MODE = btn.dataset.sort;
      localStorage.setItem("snapcon-sort", SORT_MODE);
      applySortUI();
      $("sortMenu").classList.remove("open");
      renderFleet();
    });
  });

  applyFileSortUI();
  $("fileSortBtn").addEventListener("click", e=>{ e.stopPropagation(); $("fileSortMenu").classList.toggle("open"); });
  document.querySelectorAll("#fileSortMenu .sort-opt").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      FILE_SORT = btn.dataset.fsort;
      localStorage.setItem("snapcon-filesort", FILE_SORT);
      applyFileSortUI();
      $("fileSortMenu").classList.remove("open");
      renderList();
    });
  });

  document.addEventListener("click", ()=>{
    $("sortMenu").classList.remove("open"); $("fileSortMenu").classList.remove("open");
    if($("fwSortMenu")) $("fwSortMenu").classList.remove("open");
    document.querySelectorAll(".prow-menu.open").forEach(m=>m.classList.remove("open"));
  });

  // Number-input stepper: enhance whatever's already in the DOM, then keep
  // catching new number inputs (printer rows, modals) as they're rendered —
  // one observer instead of every render function remembering to call this.
  enhanceNumberInputs(document);
  new MutationObserver(muts=>{
    for(const m of muts) for(const n of m.addedNodes){
      if(n.nodeType!==1) continue;
      if(n.matches && n.matches('input[type="number"]')) enhanceNumberInput(n);
      else if(n.querySelectorAll) enhanceNumberInputs(n);
    }
  }).observe(document.body,{childList:true,subtree:true});

  // One delegated listener drives every registered settings tab's dirty
  // footer — new tabs just need to call registerSettingsTab(), no extra
  // per-field wiring required.
  const onSettingsFieldChange=e=>{
    const panel=e.target.closest(".set-panel");
    if(!panel) return;
    const name=panel.id.replace("tab-","");
    if(SETTINGS_TAB_TRACKERS[name]) updateSettingsDirtyBar(name);
  };
  $("setup").addEventListener("input", onSettingsFieldChange);
  $("setup").addEventListener("change", onSettingsFieldChange);

  applyViewMode();
  $("compactBtn").addEventListener("click", cycleViewMode);

  applyFilesOpen();
  $("filesBtn").addEventListener("click", ()=>{ FILES_OPEN=!FILES_OPEN; applyFilesOpen(); });

  $("ntfEnabled").addEventListener("change", applyNtfEnabled);
  $("ntfGenTopic").addEventListener("click", ()=>{
    if($("ntfTopic").value.trim() && !confirm(t("settings.notif.regenerate_confirm"))) return;
    $("ntfTopic").value=genRandomTopic();
    updateSettingsDirtyBar("notif"); // programmatic value change — no native input/change event to catch it
  });
  $("ntfTopicCopy").addEventListener("click", async ()=>{
    const v=$("ntfTopic").value.trim();
    if(!v) return;
    try{
      await navigator.clipboard.writeText(v);
      const b=$("ntfTopicCopy"), old=b.textContent;
      b.textContent=t("common.copied"); setTimeout(()=>{ b.textContent=old; },1200);
    }catch{}
  });
  wireSecretField($("ntfBotTokenField"));
  wireSecretField($("ntfWebhookUrlField"));
  $("ntfMilestones").addEventListener("change", syncMilestoneNesting);
  $("ntfMilestoneChips").addEventListener("click", e=>{
    const btn=e.target.closest(".btn-chip[data-pct]");
    if(!btn||btn.disabled) return;
    const pct=parseInt(btn.dataset.pct,10);
    if(NTF_MILESTONES.has(pct)) NTF_MILESTONES.delete(pct); else NTF_MILESTONES.add(pct);
    renderMilestoneChips();
    updateSettingsDirtyBar("notif");
  });
  $("ntfyEnabled").addEventListener("change", ()=>syncProviderCard("ntfyEnabled","ntfyBody"));
  $("telegramEnabled").addEventListener("change", ()=>syncProviderCard("telegramEnabled","telegramBody"));
  $("webhookEnabled").addEventListener("change", ()=>syncProviderCard("webhookEnabled","webhookBody"));
  $("ntfTestNtfy").addEventListener("click", ()=>sendProviderTest("ntfy","ntfTestNtfy","ntfTestNtfyStatus"));
  $("ntfTestTelegram").addEventListener("click", ()=>sendProviderTest("telegram","ntfTestTelegram","ntfTestTelegramStatus"));
  $("ntfTestWebhook").addEventListener("click", ()=>sendProviderTest("webhook","ntfTestWebhook","ntfTestWebhookStatus"));
  $("notifDiscard").addEventListener("click", ()=>discardSettingsTab("notif"));
  $("notifSaveBtn").addEventListener("click", saveConfig);

  $("otpSvcResend").addEventListener("change", applyOtpServiceUI);
  $("otpSvcNtfy").addEventListener("change", ()=>{
    // Default to whatever the Notifications tab already has, but only if the
    // OTP topic hasn't been given its own value yet — never clobber a
    // deliberately-different one.
    if(!$("otpNtfyTopic").value.trim()) $("otpNtfyTopic").value=$("ntfTopic").value.trim();
    applyOtpServiceUI();
  });
  $("otpNtfyGenTopic").addEventListener("click", ()=>{ $("otpNtfyTopic").value=genRandomTopic(); });
  $("otpSvcTelegram").addEventListener("change", ()=>{
    // Same pre-fill-but-never-clobber convention as the ntfy topic above —
    // suggest the fleet-notification chat ID as a starting point, since the
    // bot token itself is a secret and can't be pre-filled client-side.
    if(!$("otpTelegramChatId").value.trim()) $("otpTelegramChatId").value=$("ntfChatId").value.trim();
    applyOtpServiceUI();
  });
  $("otpTest").addEventListener("click", doOtpTest);

  document.querySelectorAll(".set-tab").forEach(btn=>{
    btn.addEventListener("click", ()=>showSetTab(btn.dataset.tab));
  });

  $("logFilterBtn").addEventListener("click", ()=>loadAuditLogUI(true));
  $("logLoadMore").addEventListener("click", ()=>{ LOG_OFFSET+=LOG_LIMIT; loadAuditLogUI(false); });
  $("saveAuditRetention").addEventListener("click", async ()=>{
    const st=$("auditRetentionStatus");
    const days=parseInt($("setAuditRetention").value,10);
    if(!days||days<1){ st.className="pstatus err"; st.textContent=t("settings.logs.retention_invalid"); return; }
    st.className="pstatus work"; st.textContent=t("settings.dirty_bar.saving");
    try{
      const r=checkAuthFailure(await postJSON("/api/config",{auditRetentionDays:days}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      st.className="pstatus ok"; st.textContent=t("settings.dirty_bar.saved");
    }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  });

  $("setQueueEnabled").addEventListener("change", async function(){
    const wantOn=this.checked;
    try{
      await postJSON(wantOn?"/api/queue-management/enable":"/api/queue-management/disable",{});
      await loadQueueManagementUI();
    }catch(e){ this.checked=!wantOn; alert(e.message); }
  });
  $("addPrinterPoolBtn").addEventListener("click", async ()=>{
    const st=$("printerPoolStatus");
    const name=$("newPrinterPoolName").value.trim();
    if(!name){ st.className="pstatus err"; st.textContent=t("settings.users.enter_a_name"); return; }
    st.className="pstatus work"; st.textContent=t("settings.users.adding_group");
    try{
      const r=checkAuthFailure(await postJSON("/api/printer-pools",{name}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      $("newPrinterPoolName").value="";
      st.className="pstatus ok"; st.textContent=t("settings.users.group_added");
      await loadQueueManagementUI();
    }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  });

  $("fwGet").addEventListener("click", loadFirmware);
  $("fwSelect").addEventListener("click", openFirmwarePicker);
  $("fwDeploy").addEventListener("click", confirmFirmwareDeploy);
  // Filter/search/sort work on rows already in the DOM — no refetch, and no
  // rebuild, so a row the deploy poll is writing progress into survives.
  $("fwSearch").addEventListener("input", renderFirmwareList);
  $("fwConnector").addEventListener("change", renderFirmwareList);
  $("fwStop").addEventListener("click", stopFirmwareQueue);
  // Saved on change, like the other settings on this page — there is no Save
  // button on this tab because nothing else here is a stored value.
  ["fwSkipCurrent","fwVerify"].forEach(id=>{
    $(id).addEventListener("change", ()=>{ saveFirmwareOptions(); renderFirmwareImageCard(); });
  });
  $("fwSortBtn").addEventListener("click", e=>{ e.stopPropagation(); $("fwSortMenu").classList.toggle("open"); });
  document.querySelectorAll("#fwSortMenu .sort-opt").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      FW_SORT=btn.dataset.fwsort;
      $("fwSortMenu").classList.remove("open");
      applyFirmwareSortUI();
      renderFirmwareList();
    });
  });


  $("jobEject").addEventListener("click", clearJobSelection);
  $("jobSend").addEventListener("click", openSendModal);
  $("doUpload").addEventListener("click", ()=>doSendUpload(false));
  $("doUploadPrint").addEventListener("click", ()=>doSendUpload(true));
  $("sendSelectAll").addEventListener("click",()=>{
    document.querySelectorAll(".send-chk").forEach(c=>c.checked=true);
  });
  $("sendSelectIdle").addEventListener("click",()=>{
    document.querySelectorAll(".send-chk").forEach(c=>{
      const row=FLEET.find(p=>p.id===c.dataset.id);
      c.checked=isIdle(row);
    });
  });
  $("sendSelectCompatible").addEventListener("click",()=>{
    const detectedBrand=MAP?detectPrinterBrand(MAP.printerModel,MAP.printerSettingsId):null;
    document.querySelectorAll(".send-chk").forEach(c=>{
      const row=FLEET.find(p=>p.id===c.dataset.id);
      // Keeps confirmed-compatible AND "can't tell" printers checked —
      // only a KNOWN mismatch (isCompatiblePrinter===false, same test the
      // red row-name highlighting uses) is excluded.
      c.checked=!row||isCompatiblePrinter(detectedBrand,row.brand)!==false;
    });
  });
}

// VBADGE_BASE holds the version-status text on its own; renderVbadge() layers
// the "(View Mode)" suffix on top so checkVersion() (runs once) and
// applyRoleUI() (runs on every login/logout) can't stomp on each other
// regardless of which one last touched the badge.
let VBADGE_BASE="";
function renderVbadge(){
  const b=$("vbadge");
  if(!b) return;
  const viewMode=USERS_ENABLED && CURRENT_USER && CURRENT_USER.role==="view";
  b.textContent=VBADGE_BASE+(viewMode?" (View Mode)":"");
}
async function checkVersion(){
  const b=$("vbadge");
  try{
    const sv=(await getJSON("/api/version")).version;
    if(sv===VERSION){ b.className="vbadge"; VBADGE_BASE="v"+VERSION; }
    else { b.className="vbadge bad"; VBADGE_BASE="page v"+VERSION+" ≠ server v"+sv+" — restart server.js"; }
  }catch(e){
    b.className="vbadge bad"; VBADGE_BASE="page v"+VERSION+" · server has no version — update & restart server.js";
  }
  renderVbadge();
}
$("refresh").addEventListener("click", ()=>{ loadFiles(); loadFleet(); });
// Empty box = browse the current folder as normal (renderList). Any text =
// a recursive search from the gcode root, across every subfolder, replacing
// the folder view with a flat list of matches (debounced so fast typing
// doesn't fire a request per keystroke).
let SEARCH_DEBOUNCE=null;
$("filter").addEventListener("input", ()=>{
  const q=$("filter").value.trim();
  clearTimeout(SEARCH_DEBOUNCE);
  if(!q){ SEARCH_RESULTS=null; renderList(); return; }
  SEARCH_DEBOUNCE=setTimeout(()=>runSearch(q), 250);
});
async function runSearch(q){
  try{
    const d=await getJSON("/api/files/search?q="+encodeURIComponent(q));
    // The box may have changed (or been cleared) while this was in flight.
    if($("filter").value.trim()!==q) return;
    SEARCH_RESULTS=d.files||[];
    renderList();
  }catch(e){ /* leave the previous view up rather than blank it on a blip */ }
}
$("fleetSearch").addEventListener("input", renderFleet);

async function loadFiles(sub){
  // Only an actual navigation (an explicit sub, from a folder click/Back/
  // move/mkdir refresh) clears checked files — the periodic no-arg refresh
  // (timer, Refresh button) must not wipe an in-progress multi-select.
  if(sub!==undefined){ CURRENT_SUB=sub; SELECTED_FILES.clear(); SELECT_ANCHOR=null; updateMultiSelectUI(); }
  try{ const d = await getJSON("/api/files?sub="+encodeURIComponent(CURRENT_SUB));
    if(d.error){ $("folderline").textContent=d.error; FILES=[]; FOLDERS=[]; renderList(); return; }
    $("folderline").textContent=d.folder; FILES=d.files; FOLDERS=d.folders||[]; renderList();
  }catch(e){ $("folderline").textContent=t("files.server_unreachable"); }
}
function fmtSize(b){ return b>1048576 ? (b/1048576).toFixed(1)+" MB" : Math.max(1,Math.round(b/1024))+" KB"; }
function fmtTime(ms){ const d=new Date(ms), df=(Date.now()-ms)/1000;
  if(df<60)return t("files.time_just_now"); if(df<3600)return t("files.time_minutes_ago",{n:Math.floor(df/60)}); if(df<86400)return t("files.time_hours_ago",{n:Math.floor(df/3600)});
  return d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function stripExt(name){ return String(name||"").replace(/\.[^./\\]+$/,""); }
function hexToHsl(hex){
  if(!hex||!hex.startsWith('#')) return null;
  let h=hex.replace('#',''); if(h.length===3) h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if(h.length!==6) return null;
  const r=parseInt(h.slice(0,2),16)/255, g=parseInt(h.slice(2,4),16)/255, b=parseInt(h.slice(4,6),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), l=(max+min)/2;
  if(max===min) return [0,0,l];
  const d=max-min, s=l>0.5?d/(2-max-min):d/(max+min);
  let hue; if(max===r) hue=((g-b)/d+(g<b?6:0))/6; else if(max===g) hue=((b-r)/d+2)/6; else hue=((r-g)/d+4)/6;
  return [hue*360, s, l];
}
const COLOR_FAMILIES={
  red:[[345,360],[0,15]], orange:[15,45], yellow:[45,70], green:[70,160],
  cyan:[160,200], teal:[160,200], blue:[200,260], purple:[260,290],
  violet:[260,290], magenta:[290,345], pink:[290,345]
};
function matchesColorFamily(heads, family){
  const ranges=COLOR_FAMILIES[family];
  const isAchromatic=family==='white'||family==='black'||family==='grey'||family==='gray';
  return (heads||[]).some(h=>{
    if(!h||!h.hex) return false;
    const hsl=hexToHsl(h.hex); if(!hsl) return false;
    const [hue,sat,lig]=hsl;
    if(family==='white') return lig>0.8;
    if(family==='black') return lig<0.15;
    if(family==='grey'||family==='gray') return sat<0.15&&lig>0.15&&lig<0.8;
      if(!ranges) return false;
      // Achromatic colours carry hue 0 by convention, and the red family
      // spans [0,15] -- so without this guard every white, black and grey
      // spool matched a search for "red". A hue family only means anything
      // for a colour saturated and mid-toned enough to have a real hue; the
      // thresholds are the same ones the white/black/grey branches above use,
      // so the two sets stay complementary instead of overlapping.
      if(sat<0.15||lig<0.15||lig>0.8) return false;
    return (Array.isArray(ranges[0])?ranges:[ ranges]).some(r=>hue>=r[0]&&hue<=r[1]);
  });
}
// matchesColorFamily above knows white/black/grey/gray, but they are not keys
// in COLOR_FAMILIES -- so a `q in COLOR_FAMILIES` gate left that code
// unreachable and "white" only ever did a text match. This is the real set.
function isColorFamilyName(n){
  return (n in COLOR_FAMILIES)||n==='white'||n==='black'||n==='grey'||n==='gray';
}

// "@red,blue,white" -> ["red","blue","white"]; anything else -> null.
function parseColorSetQuery(q){
  if(!q||q[0]!=='@') return null;
  const names=q.slice(1).split(',').map(s=>s.trim()).filter(Boolean);
  return names.length?names:null;
}

// Every requested colour must be satisfied by a DISTINCT loaded head -- the
// question being asked is "can this printer run my N-colour file", so one red
// spool must not satisfy two red slots. Greedy assignment can strand a colour
// (handing a violet head to "blue" first, then having nothing left for
// "violet"), so this backtracks. Fleets have at most a handful of heads, so the
// search space is trivial.
function matchesAllColorFamilies(heads, names){
  const loaded=(heads||[]).filter(h=>h&&h.hex);
  if(names.length>loaded.length) return false;
  const taken=new Array(loaded.length).fill(false);
  const assign=i=>{
    if(i>=names.length) return true;
    for(let j=0;j<loaded.length;j++){
      if(taken[j]||!matchesColorFamily([loaded[j]],names[i])) continue;
      taken[j]=true;
      if(assign(i+1)) return true;
      taken[j]=false;
    }
    return false;
  };
  return assign(0);
}

// The fleet search box's whole predicate, in one place so it can be tested.
// `q` is already trimmed and lowercased by the caller.
//
// Colour is ADDITIVE, not exclusive: searching "blue" must return both the
// printer named Blue and the printers loaded with blue filament. It used to
// return only the latter, which hid a printer whose own name was the query.
function matchesFleetQuery(p, q){
  if(!q) return true;
  const pct=q.match(/^([<>]=?)\s*(\d+)\s*%?$/);
  if(pct){
    if(!p.online||p.progress==null) return false;
    const v=p.progress*100, n=parseFloat(pct[2]), op=pct[1];
    return op==='>'?v>n:op==='>='?v>=n:op==='<'?v<n:v<=n;
  }
  const set=parseColorSetQuery(q);
  if(set) return set.every(isColorFamilyName)&&matchesAllColorFamilies(p.heads,set);
  if(isColorFamilyName(q)&&matchesColorFamily(p.heads,q)) return true;
  const statusTxt=p.online?(p.state==='printing'?'printing':p.state==='paused'?'paused':p.state==='error'?'error':p.state==='complete'?'complete':p.state==='cancelled'?'cancelled':'idle'):'offline';
  return [p.brand||"",p.name||"",p.state||"",statusTxt].join(" ").toLowerCase().includes(q);
}
function needsDarkText(hex){
  if(!hex) return false;
  let h=hex.replace('#',''); if(h.length===3) h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if(h.length!==6) return false;
  return (0.299*parseInt(h.slice(0,2),16)+0.587*parseInt(h.slice(2,4),16)+0.114*parseInt(h.slice(4,6),16))/255 > 0.65;
}

// Special "/[color]/" tag syntax: a tag literally wrapped in slashes is a
// formatting directive that tints that printer's card background, not an
// ordinary label — a name CSS understands natively ("/red/"), an "r,g,b"
// triple ("/255,80,80/" — a bare comma list, NOT the CSS rgb() function
// syntax), or a hex code ("/#ff5050/" or "/f50/", '#' optional, 3/6/8 hex
// digits). isColorTag() is the SYNTAX check alone (any /.../ tag, whether or
// not the inside actually resolves) — this is what every other component
// (list view, tag filter, counts, search) must use to keep these out of
// ordinary tag UI, since a typo'd one (e.g. "/nosuchcolor/") is still a
// color-tag attempt, not a label with odd punctuation. resolveColorTag()
// additionally validates the inside and returns the real CSS color value,
// or null if it's slash-wrapped but doesn't resolve to anything — a bare
// keyword is handed to CSS as-is and trusted to validate itself, so an
// unresolvable one (a real typo, or a name CSS doesn't recognize) fails
// silently at the CSS layer with no error surfaced anywhere; the tag editor
// is the one place that gap is visible (see tagEditorSwatchHtml below).
function isColorTag(tag){
  return /^\/(.+)\/$/.test(String(tag||"").trim());
}
function resolveColorTag(tag){
  const m=/^\/(.+)\/$/.exec(String(tag||"").trim());
  if(!m) return null;
  const inner=m[1].trim();
  if(/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$|^#?[0-9a-fA-F]{8}$/.test(inner)){
    return inner[0]==='#'?inner:'#'+inner;
  }
  const rgb=/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(inner);
  if(rgb){
    const [r,g,b]=rgb.slice(1,4).map(n=>Math.min(255,parseInt(n,10)));
    return `rgb(${r},${g},${b})`;
  }
  if(/^[a-zA-Z]+$/.test(inner)) return inner.toLowerCase();
  return null;
}
// The first match wins if a printer has more than one color tag.
function parseColorTag(tags){
  for(const t of (tags||[])){
    const c=resolveColorTag(t);
    if(c) return c;
  }
  return null;
}
// Both tag editors are raw comma-separated text fields, not per-tag chips —
// this renders one small indicator next to the field reflecting whatever
// color tag is currently typed: a swatch in the resolved color, or a "!"
// mark if a /.../ tag is present but doesn't resolve to anything (the one
// place that failure is ever surfaced, since the CSS layer fails silently).
function colorTagSwatchHtml(rawTagsStr){
  const tags=(rawTagsStr||"").split(",").map(t=>t.trim()).filter(Boolean);
  const colorTags=tags.filter(isColorTag);
  if(!colorTags.length) return "";
  const resolved=colorTags.map(t=>({tag:t,color:resolveColorTag(t)}));
  const ok=resolved.find(r=>r.color);
  if(ok) return `<span class="tag-color-swatch" style="background:${esc(ok.color)}" title="${esc(t("fleet.modal.tags.swatch_match_title",{tag:ok.tag,color:ok.color}))}"></span>`;
  const bad=resolved[0];
  return `<span class="tag-color-swatch invalid" title="${esc(t("fleet.modal.tags.swatch_invalid_title",{tag:bad.tag}))}">!</span>`;
}

function renderList(){
  const list=$("list");
  list.innerHTML="";
  if(SEARCH_RESULTS!==null){ renderSearchResults(); return; }
  if(CURRENT_SUB){
    const back=document.createElement("button"); back.className="folder-back";
    back.innerHTML="← "+esc(t("common.back"));
    back.addEventListener("click",()=>{
      const parts=CURRENT_SUB.split("/").filter(Boolean);
      parts.pop();
      loadFiles(parts.join("/"));
    });
    list.appendChild(back);
  }
  FOLDERS.forEach(name=>{
    const b=document.createElement("button"); b.className="folder-item";
    b.innerHTML=`📁 ${esc(name)}`;
    b.dataset.folder=CURRENT_SUB?CURRENT_SUB+"/"+name:name;
    b.addEventListener("click",()=>loadFiles(CURRENT_SUB?CURRENT_SUB+"/"+name:name));
    list.appendChild(b);
  });
  const shown=FILES.slice().sort(FILE_SORTS[FILE_SORT]||FILE_SORTS.new);
  if(!FOLDERS.length&&!shown.length&&!CURRENT_SUB){ list.innerHTML=`<div class="empty-list">${esc(t("files.empty_no_files_yet"))}</div>`; return; }
  if(!shown.length){ const m=document.createElement("div"); m.className="empty-list"; m.textContent=t("files.empty_no_files_in_folder"); list.appendChild(m); return; }
  const shownPaths=shown.map(f=>CURRENT_SUB?CURRENT_SUB+"/"+f.name:f.name);
  shown.forEach((f,i)=>{
    const filePath=shownPaths[i];
    const b=document.createElement("div");
    b.className="job"+(SELECTED===filePath?" active":"")+(SELECTED_FILES.has(filePath)?" multi-selected":"");
    b.draggable=true; b.dataset.file=filePath;
    b.tabIndex=0; b.setAttribute("role","button");
    const fsBadge=(SELECTED===filePath&&MAP&&MAP.isFS)?` <img src="/fs-badge.svg" class="fs-badge" title="${esc(t("files.full_spectrum_title"))}">`:``;
    b.innerHTML=`<div class="jn">${esc(stripExt(f.name))}${fsBadge}</div>`+
      `<div class="jm">${fmtTime(f.mtime)} · ${fmtSize(f.size)}</div>`;
    b.addEventListener("click",e=>fileRowClick(e,filePath,shownPaths));
    b.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fileRowClick(e,filePath,shownPaths); } });
    list.appendChild(b);
  });
}

// Flat cross-folder results (SEARCH_RESULTS) — read-only browse/select, no
// checkboxes or drag: a search spans folders, so "the current folder" a move
// would target is ambiguous here, unlike the normal per-folder view.
function renderSearchResults(){
  const list=$("list");
  const shown=(SEARCH_RESULTS||[]).slice().sort(FILE_SORTS[FILE_SORT]||FILE_SORTS.new);
  if(!shown.length){ list.innerHTML=`<div class="empty-list">${esc(t("files.empty_no_search_matches"))}</div>`; return; }
  shown.forEach(f=>{
    const filePath=f.sub?f.sub+"/"+f.name:f.name;
    const b=document.createElement("button"); b.className="job"+(SELECTED===filePath?" active":"");
    const fsBadge=(SELECTED===filePath&&MAP&&MAP.isFS)?` <img src="/fs-badge.svg" class="fs-badge" title="${esc(t("files.full_spectrum_title"))}">`:``;
    const where=f.sub?`<span class="jm-path">${esc(f.sub)}/</span>`:``;
    b.innerHTML=`<div class="jn">${where}${esc(stripExt(f.name))}${fsBadge}</div><div class="jm">${fmtTime(f.mtime)} · ${fmtSize(f.size)}</div>`;
    b.addEventListener("click",()=>selectFile(filePath));
    list.appendChild(b);
  });
}

// ---- Multi-select (shift/ctrl-click) → drag-to-move, and "New Folder"/"Upload" ----
// shiftKey: range-select between SELECT_ANCHOR and this row (replaces the
// current selection, matching Explorer/Finder — not additive to it).
// ctrlKey/metaKey: toggle just this row in/out, keeping everything else.
// Plain click: clear multi-select and fall back to the normal single-select
// (open the job details panel), same as before this feature existed.
function fileRowClick(e, filePath, orderedPaths){
  if(e.shiftKey){
    e.preventDefault();
    const anchorIdx=SELECT_ANCHOR!=null?orderedPaths.indexOf(SELECT_ANCHOR):-1;
    const clickIdx=orderedPaths.indexOf(filePath);
    SELECTED_FILES.clear();
    if(anchorIdx===-1){ SELECTED_FILES.add(filePath); SELECT_ANCHOR=filePath; }
    else{
      const [lo,hi]=anchorIdx<clickIdx?[anchorIdx,clickIdx]:[clickIdx,anchorIdx];
      for(let i=lo;i<=hi;i++) SELECTED_FILES.add(orderedPaths[i]);
    }
    updateMultiSelectUI(); renderList();
  } else if(e.ctrlKey||e.metaKey){
    e.preventDefault();
    if(SELECTED_FILES.has(filePath)) SELECTED_FILES.delete(filePath); else SELECTED_FILES.add(filePath);
    SELECT_ANCHOR=filePath;
    updateMultiSelectUI(); renderList();
  } else {
    SELECTED_FILES.clear(); SELECT_ANCHOR=filePath;
    updateMultiSelectUI();
    selectFile(filePath);
  }
}
function updateMultiSelectUI(){
  const n=SELECTED_FILES.size, bar=$("multiselectBar");
  if(n>0){
    bar.style.display="";
    $("multiselectCount").textContent=tn("files.multiselect_count",n);
    if($("sendToQueueBtn")) $("sendToQueueBtn").style.display=QUEUE_MANAGEMENT_ENABLED?"":"none";
    $("jobcard").classList.remove("show");
    $("jobloading").classList.remove("show");
    if(!URL_PRINTER_FILTER) $("jobsechead").style.display="none";
  } else {
    bar.style.display="none";
    if(SELECTED&&MAP){
      if(!URL_PRINTER_FILTER) $("jobsechead").style.display="";
      $("jobcard").classList.add("show");
    }
  }
}

// ---- Send to Queue modal — multi-file version of the "Send to printers"
// flow, targeting one Printer Pool instead of individually-checked
// printers. `SELECTED_FILES` holds full relative paths (the same string
// /api/print already accepts as `file` directly); the queue routes want
// {name, sub} split apart instead, so that split happens once here. ----
let SEND_QUEUE_ITEMS=[];
function splitFilePath(fp){
  const idx=fp.lastIndexOf("/");
  return idx===-1 ? {sub:"",name:fp} : {sub:fp.slice(0,idx), name:fp.slice(idx+1)};
}
function openSendQueueModal(){
  SEND_QUEUE_ITEMS=[...SELECTED_FILES].map(fp=>{ const {sub,name}=splitFilePath(fp); return {path:fp, name, sub, quantity:1}; });
  renderSendQueueFiles();
  $("sendQueuePool").innerHTML=PRINTER_POOLS.length
    ? PRINTER_POOLS.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")
    : `<option value="">${t("queue.no_pools_yet_option")}</option>`;
  $("sendQueueModeWrap").style.display=SEND_QUEUE_ITEMS.length>1?"":"none";
  const modeInput=document.querySelector('input[name="sendQueueMode"][value="print-on-all"]');
  if(modeInput) modeInput.checked=true;
  $("sendQueueStatus").className="pstatus"; $("sendQueueStatus").textContent="";
  renderSendQueuePreview();
  $("sendQueueModal").classList.add("show");
}
function closeSendQueueModal(){ $("sendQueueModal").classList.remove("show"); }
function renderSendQueueFiles(){
  $("sendQueueFiles").innerHTML=SEND_QUEUE_ITEMS.map((it,i)=>
    `<div style="display:flex;align-items:center;gap:8px">`+
    `<span style="flex:1;font-size:12px;font-family:var(--mono);color:var(--ink-dim);word-break:break-all">${esc(it.name)}</span>`+
    `<span class="pi-lbl">×</span>`+
    `<input type="number" class="field sendq-qty" data-idx="${i}" min="1" max="50" value="${it.quantity}" style="max-width:90px">`+
    `</div>`
  ).join("");
  $("sendQueueFiles").querySelectorAll(".sendq-qty").forEach(inp=>{
    inp.addEventListener("input",()=>{
      const idx=parseInt(inp.dataset.idx,10);
      SEND_QUEUE_ITEMS[idx].quantity=Math.max(1,Math.min(50,parseInt(inp.value,10)||1));
      renderSendQueuePreview();
    });
  });
}
// Purely client-side, deterministic given files×quantities×mode×the target
// pool's printer list — no server round-trip needed just to preview.
function renderSendQueuePreview(){
  const box=$("sendQueuePreview");
  const poolId=$("sendQueuePool").value;
  const modeInput=document.querySelector('input[name="sendQueueMode"]:checked');
  const mode=modeInput?modeInput.value:"print-on-all";
  const printers=PRINTERS_CFG.filter(p=>p.printerPoolId===poolId);
  if(!printers.length){ box.innerHTML=`<div class="settings-help">${t("queue.no_printers_in_pool_yet")}</div>`; return; }
  const expanded=[];
  SEND_QUEUE_ITEMS.forEach(it=>{ for(let i=0;i<it.quantity;i++) expanded.push(it); });
  const perPrinter=printers.map(()=>[]);
  if(mode==="print-on-all"){
    printers.forEach((p,pi)=>{ perPrinter[pi]=expanded.slice(); });
  } else {
    expanded.forEach((it,i)=>{ perPrinter[i%printers.length].push(it); });
  }
  box.innerHTML=printers.map((p,pi)=>{
    const counts=new Map();
    perPrinter[pi].forEach(it=>counts.set(it.name,(counts.get(it.name)||0)+1));
    const line=[...counts.entries()].map(([n,c])=>esc(n)+" ×"+c).join(", ")||"(nothing)";
    return `<div style="font-size:12px;padding:3px 0"><b>${esc(p.name)}</b>: ${line}</div>`;
  }).join("");
}
async function doSendQueue(startImmediately){
  const st=$("sendQueueStatus");
  const poolId=$("sendQueuePool").value;
  if(!poolId){ st.className="pstatus err"; st.textContent=t("queue.choose_pool_first"); return; }
  if(!SEND_QUEUE_ITEMS.length){ st.className="pstatus err"; st.textContent=t("queue.no_files_selected"); return; }
  const modeInput=document.querySelector('input[name="sendQueueMode"]:checked');
  const mode=modeInput?modeInput.value:"print-on-all";
  st.className="pstatus work"; st.textContent=t("queue.sending");
  try{
    const r=checkAuthFailure(await postJSON("/api/queue/send",{
      files: SEND_QUEUE_ITEMS.map(it=>({name:it.name, sub:it.sub, quantity:it.quantity})),
      poolId, mode, startImmediately
    }));
    const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
    closeSendQueueModal();
    SELECTED_FILES.clear(); SELECT_ANCHOR=null; updateMultiSelectUI(); renderList();
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// ---- Queue Management view — the operational control panel, not just a
// status viewer: reordering isn't implemented yet in this first pass, but
// every failure-resolution/pause/stop/confirm action lives here, grouped by
// Printer Pool (design doc §A7). Implemented as a modal, same convention
// as Maintenance/Bulk-heat, rather than a dedicated full-page view. ----
let QUEUE_VIEW_DATA={}, QUEUE_VIEW_TIMER=null;
// Action IDs mirror QueueEngine.js's RESOLUTIONS_BY_REASON exactly (server-
// side has no labels — those are purely a frontend presentation concern).
// Kept as plain action-id arrays (not [id,label] pairs) so the label always
// comes from queueActionLabel() at render time, live-switch-safe by
// construction rather than needing a separate refresh path.
const QUEUE_ACTION_LABEL_KEYS={
  resume:"queue.action_resume", retry:"queue.action_retry_job", skip:"queue.action_skip_job", stop:"queue.action_stop_queue",
  "retry-bed-clear":"queue.action_retry_bed_clear", "skip-bed-clear":"queue.action_skip_bed_clear",
  "accept-file-change":"queue.action_use_current_file", "acknowledge":"queue.action_acknowledge_resume"
};
function queueActionLabel(action){ return QUEUE_ACTION_LABEL_KEYS[action]?t(QUEUE_ACTION_LABEL_KEYS[action]):action; }
const QUEUE_ATTENTION_RESOLUTIONS={
  "print-failed": ["resume","retry","skip","stop"],
  "dispatch-failed": ["retry","skip","stop"],
  "bed-clear-failed": ["retry-bed-clear","skip-bed-clear","stop"],
  "file-missing": ["skip","stop"],
  "file-changed": ["accept-file-change","skip","stop"],
  "pool-invalid": ["stop"],
  "recovery-mismatch": ["acknowledge","stop"],
  "recovery-interrupted": ["retry","skip","stop"],
  "recovery-unknown-outcome": ["resume","retry","skip","stop"]
};
// attentionReason is always one of QueueEngine.js's frozen ATTENTION_REASONS
// slugs (e.g. "print-failed") — previously shown to the user completely
// raw/untranslated ("Needs attention — print-failed"). This is the missing
// human-readable label layer; an unrecognized reason (shouldn't happen, but
// the server contract isn't compile-time-checked from here) falls back to
// the raw slug rather than showing nothing.
const ATTENTION_REASON_LABEL_KEYS={
  "print-failed":"queue.attention_print_failed", "dispatch-failed":"queue.attention_dispatch_failed",
  "bed-clear-failed":"queue.attention_bed_clear_failed", "file-missing":"queue.attention_file_missing",
  "file-changed":"queue.attention_file_changed", "pool-invalid":"queue.attention_pool_invalid",
  "recovery-mismatch":"queue.attention_recovery_mismatch", "recovery-interrupted":"queue.attention_recovery_interrupted",
  "recovery-unknown-outcome":"queue.attention_recovery_unknown_outcome"
};
function attentionReasonLabel(reason){ return ATTENTION_REASON_LABEL_KEYS[reason]?t(ATTENTION_REASON_LABEL_KEYS[reason]):(reason||t("queue.attention_generic")); }
// Fleet, Settings, Queue Management, and Health are mutually exclusive
// full-page views (same show/hide idiom as .setup) — openQueueDashboard()/
// closeQueueDashboard() are the ONLY path in or out, so timer creation and
// teardown can never be duplicated or skipped regardless of which of the
// several entry points (queueBtn click, gear opening Settings on top of an
// open dashboard) triggered it.
function openQueueDashboard(){
  if($("queueDashboard").classList.contains("show")) return;
  closeHealthPage();
  $("queueDashboard").classList.add("show");
  // Only the Fleet-specific CONTENT is swapped out for the dashboard (can't
  // show the printer grid and the dashboard at once) — every topbar
  // control (folder, sort, compact view, bulk heat, maintenance, Settings)
  // stays visible and usable, unlike Settings' own exclusive takeover.
  document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="none");
  $("queueBtn").title=t("global.topbar.back_to_fleet_title");
  // Kept in sync with VIEW_MODE regardless of which button opened this
  // (the dedicated queueBtn, or the alternate-display cycle button when
  // configured to include Print Farm) — this is the one place both paths
  // funnel through, so the cycle button's own icon/title always reflects
  // reality no matter how the dashboard got opened.
  VIEW_MODE='printfarm';
  syncViewModeButtonIcon();
  updateTopbarViewLabel();
  refreshQueueDashboard();
  if(!QUEUE_VIEW_TIMER) QUEUE_VIEW_TIMER=setInterval(refreshQueueDashboard, 5000);
}
function closeQueueDashboard(){
  if(!$("queueDashboard").classList.contains("show")) return;
  if(QUEUE_VIEW_TIMER){ clearInterval(QUEUE_VIEW_TIMER); QUEUE_VIEW_TIMER=null; }
  $("queueDashboard").classList.remove("show");
  document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="");
  $("queueBtn").title=t("settings.tabs.queue");
  if(VIEW_MODE==='printfarm'){ VIEW_MODE='regular'; syncViewModeButtonIcon(); }
  updateTopbarViewLabel();
  // applyRoleUI() is the authority for filesBtn/gear/queueBtn/jobSend (role +
  // canAct() + whether Settings is open + Queue Management's own enablement)
  // — restoring those by hand here would regress a View-role user or a
  // Queue-disabled install into seeing controls they shouldn't, exactly the
  // "show everything unconditionally" bug this replaces.
  applyRoleUI();
}
function fleetRowForPrinterId(pid){
  const idx=PRINTERS_CFG.findIndex(p=>p.id===pid);
  return idx===-1?null:FLEET.find(f=>f.id===idx);
}

// ---- Health page — fifth mutually-exclusive full-page view (same
// show/hide idiom as #queueDashboard above). Deliberately NO timer: every
// value is fetched once on open/printer-switch, or via the Refresh button —
// see connectors/http-utils.js's queryHealth for why the data itself is
// sectioned. HEALTH_SYNCING_FROM_POPSTATE suppresses pushState while we're
// the ones reacting to a back/forward navigation, not causing one. ----
let HEALTH_PRINTER_ID=null, HEALTH_DATA=null, HEALTH_MAINT=null, HEALTH_REQ_TOKEN=0, HEALTH_SYNCING_FROM_POPSTATE=false;

const DISK_CRITICAL_PCT=0.05, DISK_CRITICAL_BYTES=2*1024*1024*1024;
// Per-session cache of the RICH (per-printer, /api/health-derived)
// needsAttention result, filled in only for printers whose Health page has
// actually been opened this session — the picker chips use this to enrich
// the attention marker beyond the cheap fleet-wide flag (maintenance/queue
// only) WITHOUT ever fetching /api/health for a printer nobody opened. A
// printer never opened this session still falls back to the cheap flag.
const HEALTH_ATTENTION_CACHE={};


function openHealthPage(printerId){
  closeQueueDashboard();
  $("healthPage").classList.add("show");
  document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="none");
  $("healthBtn").title=t("global.topbar.back_to_fleet_title");
  let id=printerId;
  if(id==null){
    const attn=FLEET.find(p=>p.needsAttention);
    id=attn?attn.id:(FLEET[0]?FLEET[0].id:null);
  }
  selectHealthPrinter(id);
  startHealthAutoRefresh();
}
// Auto-refresh on the fleet's own configured interval (Settings > General),
// but ONLY while the printer is actually printing or paused — that is when
// these readings move. An idle printer's health does not change on its own,
// and /api/health is a real probe plus a maintenance read per tick, so
// polling one for every open Health page would be pure load.
//
// Deliberately re-reads the printer's state from FLEET on each tick rather
// than latching it at open time: a print starting or finishing while the
// page is open turns polling on and off by itself.
let HEALTH_AUTO_TIMER=null;
function healthAutoRefreshStates(state){ return state==="printing"||state==="paused"; }
function startHealthAutoRefresh(){
  stopHealthAutoRefresh();
  const ms=Math.max(1,parseInt($("setRefresh")&&$("setRefresh").value,10)||2)*1000;
  HEALTH_AUTO_TIMER=setInterval(()=>{
    if(document.hidden||HEALTH_PRINTER_ID==null) return;
    // Same rule the fleet poll uses: never refresh out from under someone
    // who is filling in a field. A service entry takes a while to type and
    // the readings behind it can wait — the next tick picks them up.
    if(healthServiceFormHasFocus()) return;
    const p=FLEET.find(f=>f.id===HEALTH_PRINTER_ID);
    if(!p||!healthAutoRefreshStates(p.state)) return;
    loadHealthData({quiet:true});
  },ms);
}
function stopHealthAutoRefresh(){
  if(HEALTH_AUTO_TIMER){ clearInterval(HEALTH_AUTO_TIMER); HEALTH_AUTO_TIMER=null; }
}
function closeHealthPage(){
  if(!$("healthPage").classList.contains("show")) return;
  $("healthPage").classList.remove("show");
  document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="");
  $("healthBtn").title=t("global.topbar.health_title");
  HEALTH_PRINTER_ID=null; HEALTH_DATA=null; HEALTH_MAINT=null;
  stopHealthAutoRefresh();
  if(!HEALTH_SYNCING_FROM_POPSTATE && location.pathname.toLowerCase().startsWith("/health")) history.pushState(null,"","/");
  applyRoleUI();
}
function selectHealthPrinter(id){
  HEALTH_PRINTER_ID=id;
  if(!HEALTH_SYNCING_FROM_POPSTATE && id!=null){
    const target="/health/"+id;
    if(location.pathname!==target) history.pushState(null,"",target);
  }
  renderHealthPicker();
  loadHealthData();
}
window.addEventListener("popstate",()=>{
  const m=/^\/health\/?(\d*)$/i.exec(location.pathname);
  HEALTH_SYNCING_FROM_POPSTATE=true;
  try{
    if(!m){ if($("healthPage").classList.contains("show")) closeHealthPage(); return; }
    const id=m[1]?parseInt(m[1],10):null;
    if(!$("healthPage").classList.contains("show")) openHealthPage(id);
    else selectHealthPrinter(id);
  } finally { HEALTH_SYNCING_FROM_POPSTATE=false; }
});

// Rides the existing fleet poll (FLEET already carries needsAttention per
// row from /api/fleet) — no fetch of its own, called from renderFleet().
function updateHealthBadge(){
  const badge=$("healthBadge");
  if(!badge) return;
  const n=FLEET.filter(p=>p.needsAttention).length;
  if(n>0){ badge.textContent=n>99?"99+":String(n); badge.style.display=""; }
  else badge.style.display="none";
}
function renderHealthPicker(){
  const wrap=$("healthPicker");
  if(!wrap) return;
  if(!FLEET.length){ wrap.innerHTML=`<span class="settings-help">${esc(t("maintenance.no_printers_configured"))}</span>`; return; }
  wrap.innerHTML=FLEET.map(p=>{
    const {statusColor}=statusColorText(p);
    const active=p.id===HEALTH_PRINTER_ID;
    // Either source can flag it, never one overriding the other: the cached
    // health result covers the printer's own diagnostics, the fleet flag
    // covers queue dispatch. Letting the cache win (as this used to) made a
    // queue-blocked printer's marker vanish the moment you opened its page.
    const needsAttention=!!HEALTH_ATTENTION_CACHE[p.id]||!!p.needsAttention;
    const title=needsAttention?t("health.chip_title_attention",{name:p.name}):p.name;
    return `<button type="button" class="health-chip${active?" active":""}" data-healthchip="${p.id}" style="--status-color:${statusColor}" title="${esc(title)}">`+
      `<span class="health-chip-dot"></span><span class="health-chip-name">${esc(p.name)}</span>`+
      (needsAttention?`<span class="health-chip-attn" aria-hidden="true"></span>`:"")+
    `</button>`;
  }).join("");
  wrap.querySelectorAll("[data-healthchip]").forEach(b=>{
    b.addEventListener("click",()=>selectHealthPrinter(parseInt(b.dataset.healthchip,10)));
  });
}

// `quiet` skips the "blank everything and re-render" step, so an automatic
// refresh updates values in place instead of flashing the whole page through
// its loading state every interval. Only the first load of a printer (and a
// printer switch) clears first, where there genuinely is nothing to show yet.
async function loadHealthData(opts){
  const quiet=!!(opts&&opts.quiet);
  const pid=HEALTH_PRINTER_ID;
  if(pid==null){ HEALTH_DATA=null; HEALTH_MAINT=null; renderHealthBody(); return; }
  const token=++HEALTH_REQ_TOKEN;
  if(!quiet){ HEALTH_DATA=null; HEALTH_MAINT=null; renderHealthBody(); }
  let health, maint;
  try{ health=await (await fetch("/api/health?printer="+pid)).json(); }
  catch(e){ health={ skipped:true, reason:t("health.could_not_reach",{message:e.message}) }; }
  try{ maint=await (await fetch("/api/maintenance?printer="+pid)).json(); }
  catch(e){ maint=null; }

  if(token!==HEALTH_REQ_TOKEN||pid!==HEALTH_PRINTER_ID) return; // superseded by a newer switch/refresh
  HEALTH_DATA=health; HEALTH_MAINT=maint;
  if(!health.skipped) HEALTH_ATTENTION_CACHE[pid]=!!health.needsAttention;
  renderHealthBody();
  renderHealthPicker(); // re-render so the enriched attention marker (if it changed) shows immediately, not just on the next printer switch
  if(!health.skipped) resumeSyncPollingIfRunning(pid);
}
// A sync is server-side and outlives the browser tab that started it (same
// as a print job) — so opening/reloading the Health page has no way to know
// one is already in progress until it actually asks. One status check per
// root, per printer-load; if genuinely running, that's what kicks off the
// ongoing 1.5s poll loop. If not, this is a single cheap request, not
// recurring — never calls loadHealthData() itself (unlike pollSyncStatus's
// own "just finished" branch), so it can't loop.
async function resumeSyncPollingIfRunning(printerId){
  let anyRunning=false;
  for(const root of ["logs","camera","gcodes"]){
    let st;
    try{ st=await getJSON("/api/sync-status?printer="+printerId+"&root="+root); }
    catch{ continue; }
    HEALTH_SYNC_STATE[syncKey(printerId,root)]=st;
    if(syncRunning(st)){
      anyRunning=true;
      const key=syncKey(printerId,root);
      clearTimeout(HEALTH_SYNC_TIMERS[key]);
      HEALTH_SYNC_TIMERS[key]=setTimeout(()=>pollSyncStatus(printerId,root),1500);
    }
  }
  if(anyRunning&&HEALTH_PRINTER_ID===printerId) renderHealthBody();
}

function fmtBytes(n){
  if(n==null||!isFinite(n)) return "—";
  const units=["B","KB","MB","GB","TB"];
  let v=Math.max(0,n), i=0;
  while(v>=1024&&i<units.length-1){ v/=1024; i++; }
  return (i===0?Math.round(v):v.toFixed(1))+" "+units[i];
}
function lastServiceText(maint){
  if(!maint||!maint.entries||!maint.entries.length) return t("maintenance.last_service_never");
  return fmtMaintDate(maint.entries.reduce((a,b)=>(a.date>b.date?a:b)).date);
}
// Server-generated attention reasons carry an additive `code` (+ safe raw
// params like {component,date} or {name,rpm}) for every deterministic,
// Health-local condition (see computeHealthAttention/computeMaintenanceAttention/
// checkFanMismatch in server.js) — the client translates FROM code+params,
// never from re-parsing r.title/r.detail (which stay English server-side for
// any other consumer). An unrecognized/legacy reason with no matching code
// falls back to the server's own raw title/detail text rather than showing
// nothing — same fallback shape as Queue's attentionReasonLabel().
const HEALTH_ATTENTION_KEYS={
  "fan-not-spinning":{title:"health.attention.fan_not_spinning_title",detail:"health.attention.fan_not_spinning_detail"},
  "undervoltage":{title:"health.attention.undervoltage_title",detail:"health.attention.undervoltage_detail"},
  "throttled":{title:"health.attention.throttled_title",detail:"health.attention.throttled_detail"},
  "low-disk-space":{title:"health.attention.low_disk_space_title",detail:"health.attention.low_disk_space_detail"},
  "recent-fault":{title:"health.attention.recent_fault_title",detail:"health.attention.recent_fault_detail"},
  "maintenance-overdue":{title:"health.attention.maintenance_overdue_title",detail:"health.attention.maintenance_overdue_detail"},
  "maintenance-due-soon":{title:"health.attention.maintenance_due_soon_title",detail:"health.attention.maintenance_due_soon_detail"},
  "queue-attention":{title:"health.attention.queue_title",detail:"health.attention.queue_detail"}
};
function healthAttentionText(r){
  const keys=HEALTH_ATTENTION_KEYS[r.code];
  if(!keys) return { title:r.title, detail:r.detail };
  // The queue's own message names the actual blocker (a missing file, by
  // name) — far more use than the generic line, so it wins when present.
  if(r.code==="queue-attention"&&r.message) return { title:t(keys.title), detail:r.message };
  return { title:t(keys.title), detail:t(keys.detail,{name:r.name,rpm:r.rpm,component:r.component,date:r.date}) };
}
// /api/health only knows the printer's own diagnostics (throttle, disk,
// faults, fans, maintenance). The fleet row carries the OTHER half — queue
// dispatch state — and that is what the topbar badge counts. Merging them
// here is what stops the badge saying "2" while both of those printers'
// Health pages claim nothing needs attention.
function attentionReasonsFor(d){
  const health=(d&&d.attentionReasons)||[];
  const row=FLEET.find(p=>p.id===HEALTH_PRINTER_ID);
  const fleet=(row&&row.attentionReasons)||[];
  const seen=new Set(health.map(r=>r.code||r.title));
  return health.concat(fleet.filter(r=>!seen.has(r.code||r.title)));
}
function renderAttentionList(d){
  const reasons=attentionReasonsFor(d).slice().sort((a,b)=>(a.severity==="critical"?0:1)-(b.severity==="critical"?0:1));
  if(!reasons.length) return `<div class="health-card"><div class="health-card-hdr">${esc(t("health.attention.card_title"))}</div><p class="settings-help">${esc(t("health.attention.nothing"))}</p></div>`;
  return `<div class="health-card"><div class="health-card-hdr">${esc(t("health.attention.card_title"))}</div><div class="health-attn-list">`+
    reasons.map(r=>{
      const {title,detail}=healthAttentionText(r);
      return `<div class="health-attn-item ${esc(r.severity)}"><span class="health-attn-dot"></span><div class="health-attn-text"><div class="health-attn-title">${esc(title)}</div><div class="health-attn-detail">${esc(detail)}</div></div>`+
      (r.suggestedComponent?`<button type="button" class="btn ghost btn-sm" data-logfix="${esc(r.suggestedComponent)}">${esc(t("health.attention.log_fix_button"))}</button>`:"")+
    `</div>`;
    }).join("")+
  `</div></div>`;
}
// ReadingRow — the shared anatomy every Health card metric renders through:
// a human label + a state-colored current-vs-threshold value on one line, an
// optional duty/percent bar underneath. `state` is one of
// 'healthy'|'warning'|'critical'|'neutral' ('neutral' = not evaluated: idle,
// heating/cooling in transit, unmeasurable). The value TEXT and the bar FILL
// deliberately use different color rules: a healthy row's value stays quiet
// secondary grey while its bar still fills green — only warning/critical
// color the text, so a card with a real problem is the one that visually
// stands out. `pct` of null skips the bar entirely (used for states like
// "Idle" where there's nothing to measure). `opts.title`, if given, adds a
// hover explanation and an info mark on the label — for a row whose value
// needs a caveat that doesn't fit inline (e.g. Storage's "Other" bucket).
function readingRow(label,valueText,pct,state,opts){
  opts=opts||{};
  const cls=["healthy","warning","critical","neutral"].includes(state)?state:"healthy";
  const bar=pct==null?"":`<div class="reading-bar"><div class="reading-bar-fill ${cls}" style="width:${Math.max(0,Math.min(100,pct))}%"></div></div>`;
  const lbl=label+(opts.title?" ⓘ":"");
  return `<div class="reading-row"${opts.title?` title="${esc(opts.title)}"`:""}>`+
    `<div class="reading-row-top"><span class="reading-label">${esc(lbl)}</span><span class="reading-value ${cls}">${esc(valueText)}</span></div>`+
    bar+
  `</div>`;
}
// MCU stats become readings, not a raw dump: a state dot plus the 3 values
// that actually mean something, each against a warn/crit threshold with a
// plain-language explanation. None of these thresholds are validated
// against real degraded hardware — they're starting points, same caveat as
// every other threshold on this page. `freq` (raw clock frequency) isn't a
// health signal by itself — there's no known-good "nominal" frequency per
// board to compute drift against, so rather than fabricate one, it moves
// into the raw disclosure instead of the primary view, along with
// srtt/rttvar/bytesWrite.
const MCU_RETRANSMIT_RATE_WARN=1, MCU_RETRANSMIT_RATE_CRIT=5; // per 1,000,000 bytes written
const MCU_TASK_AVG_WARN=0.001, MCU_TASK_AVG_CRIT=0.005; // seconds
const MCU_INVALID_BYTES_WARN=1, MCU_INVALID_BYTES_CRIT=50; // count, cumulative since boot
function stateFor(val,warn,crit){ return val==null?"healthy":val>=crit?"critical":val>=warn?"warning":"healthy"; }
function worstOf(...states){ return states.includes("critical")?"critical":states.includes("warning")?"warning":"healthy"; }
// Shared by every "X data unavailable[: reason]." card fallback (Controller/
// Heaters/Fans/Storage/System) instead of five near-duplicate keys —
// sectionTitle is itself an already-translated card-title string (e.g.
// t("health.controller.card_title")), interpolated as data the same way a
// printer name would be. reason (connector-supplied, e.g. "Moonraker 500")
// is raw diagnostic text and stays untranslated by design.
function healthDataUnavailable(sectionTitle,reason){
  return reason?t("health.data_unavailable_reason",{section:sectionTitle,reason}):t("health.data_unavailable",{section:sectionTitle});
}
function mcuReading(m){
  const rate=(m.bytesWrite&&m.bytesRetransmit!=null)?(m.bytesRetransmit/m.bytesWrite*1000000):null;
  const rateState=stateFor(rate,MCU_RETRANSMIT_RATE_WARN,MCU_RETRANSMIT_RATE_CRIT);
  const invalidState=stateFor(m.bytesInvalid,MCU_INVALID_BYTES_WARN,MCU_INVALID_BYTES_CRIT);
  const taskState=stateFor(m.mcuTaskAvg,MCU_TASK_AVG_WARN,MCU_TASK_AVG_CRIT);
  return { rate, rateState, invalidState, taskState, worst:worstOf(rateState,invalidState,taskState) };
}
function renderControllerCard(d){
  const mcus=d.mcus;
  const cardTitle=t("health.controller.card_title");
  if(!mcus||!mcus.available) return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div><p class="settings-help">${esc(healthDataUnavailable(cardTitle,mcus&&mcus.reason))}</p></div>`;
  if(!mcus.list.length) return "";
  // One row per controller instead of a ~300px block each. No bars: none of
  // these three readings has a defined maximum (retransmits are a rate,
  // invalid bytes a cumulative count, task load a duration), so a bar filled
  // to some fraction of the CRITICAL THRESHOLD was drawing a proportion of
  // nothing — "33 invalid bytes" is not "60% of anything". The number itself
  // carries the state color, and the row's dot carries the worst of the
  // three so a healthy fleet reads without parsing any numbers.
  const unhealthy=[];
  const rows=mcus.list.map(m=>{
    const r=mcuReading(m);
    const name=mcuLabel(m.name);
    if(r.worst!=="healthy"){
      const detail=r.rateState!=="healthy"?t("health.controller.explain_retransmits")
        :r.invalidState!=="healthy"?t("health.controller.explain_invalid")
        :t("health.controller.explain_task_load");
      unhealthy.push({name,detail,worst:r.worst});
    }
    // The raw dump that used to be a visible line per block. srtt/rttvar/
    // freq/task stddev aren't actionable and the rest duplicates the columns,
    // so it lives on the row's title instead of costing four lines of height.
    // Klipper/MCU protocol vocabulary — untranslated by the same convention
    // as every other raw firmware diagnostic on this page.
    const raw=`retransmit ${m.bytesRetransmit??"—"} · invalid ${m.bytesInvalid??"—"} · bytes written ${m.bytesWrite??"—"} · srtt ${m.srtt??"—"} · rttvar ${m.rttvar??"—"} · freq ${m.freq??"—"} · task avg ${m.mcuTaskAvg??"—"} · task stddev ${m.mcuTaskStddev??"—"}`;
    const num=(text,state)=>`<span class="mcu-cell mcu-num ${state}" role="cell">${esc(text)}</span>`;
    return `<div class="mcu-row" role="row" title="${esc(raw)}">`+
      `<span class="mcu-cell mcu-name" role="cell"><span class="health-mcu-dot ${r.worst}"></span>${esc(name)}</span>`+
      num(r.rate!=null?r.rate.toFixed(2):"—",r.rateState)+
      num(m.bytesInvalid??"—",r.invalidState)+
      num(m.mcuTaskAvg!=null?(m.mcuTaskAvg*1000).toFixed(3):"—",r.taskState)+
    `</div>`;
  }).join("");
  // One warning for the whole card, naming the worst controller and what to
  // check — not the same explanation repeated inside every block.
  unhealthy.sort((a,b)=>(a.worst==="critical"?0:1)-(b.worst==="critical"?0:1));
  const lead=unhealthy[0];
  const note=lead?`<div class="reading-note ${lead.worst}">`+
    esc(t("health.controller.warn_line",{controller:lead.name,detail:lead.detail}))+
    (unhealthy.length>1?" "+esc(tn("health.controller.warn_more",unhealthy.length-1,{count:unhealthy.length-1})):"")+
  `</div>`:"";
  // Two-line header: label, then the column's constant unit under it. Every
  // row — this one included — emits exactly four cells through the same grid,
  // which is what keeps each header sitting over its own numbers.
  const th=(label,unit,extraClass)=>`<span class="mcu-cell mcu-th ${extraClass||""}" role="columnheader">${esc(label)}`+
    (unit?`<span class="mcu-unit">${esc(unit)}</span>`:"")+`</span>`;
  return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div>`+
    `<div class="mcu-table" role="table">`+
      `<div class="mcu-row mcu-head" role="row">`+
        th(t("health.controller.col_controller"),"")+
        th(t("health.controller.reading_retransmits"),t("health.controller.unit_per_million"),"mcu-num")+
        th(t("health.controller.reading_invalid_bytes"),t("health.controller.unit_bytes"),"mcu-num")+
        th(t("health.controller.reading_task_load"),t("health.controller.unit_ms"),"mcu-num")+
      `</div>`+
      rows+
    `</div>`+
    note+
  `</div>`;
}
// System utilization — the host machine running Klipper, not the printer's
// own hardware. Thresholds are starting points, same caveat as everywhere
// else on this page: this is a Pi-class SBC in the common case (though
// confirmed elsewhere on this page that this fleet's own U1 hardware isn't
// literally a Pi), so 80°C is used as a rough thermal-throttle reference
// point rather than a validated figure for this specific board.
const CPU_TEMP_WARN=70, CPU_TEMP_CRIT=80; // °C
const CPU_USAGE_WARN=85, CPU_USAGE_CRIT=97; // percent
const MEM_USAGE_WARN=85, MEM_USAGE_CRIT=95; // percent
function renderSystemCard(d){
  const s=d.system;
  const cardTitle=t("health.system.card_title");
  if(!s||!s.available) return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div><p class="settings-help">${esc(healthDataUnavailable(cardTitle,s&&s.reason))}</p></div>`;
  const rows=[];
  if(s.cpuTemp!=null){
    // No bar: CPU temperature has no defined maximum, so the old
    // temp/CPU_TEMP_CRIT fill was drawing a fraction of a threshold, not of a
    // real ceiling — the same reason the Controller card dropped its bars.
    // CPU usage and memory below keep theirs: those ARE true 0-100%.
    rows.push(readingRow(t("health.system.reading_cpu_temp"),Math.round(s.cpuTemp)+" °C",null,stateFor(s.cpuTemp,CPU_TEMP_WARN,CPU_TEMP_CRIT)));
  }
  if(s.cpuUsage!=null){
    rows.push(readingRow(t("health.system.reading_cpu_usage"),Math.round(s.cpuUsage)+"%",s.cpuUsage,stateFor(s.cpuUsage,CPU_USAGE_WARN,CPU_USAGE_CRIT)));
  }
  if(s.memory&&s.memory.total){
    const pct=s.memory.used/s.memory.total*100;
    rows.push(readingRow(t("health.system.reading_memory"),Math.round(pct)+"% used",pct,stateFor(pct,MEM_USAGE_WARN,MEM_USAGE_CRIT)));
  }
  if(!rows.length) return "";
  // health-diag-vals is a raw diagnostic dump, same convention as the
  // Controller card's — left untranslated by design.
  return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div>`+
    rows.join("")+
    `<div class="health-diag-vals">uptime ${s.uptimeSec!=null?fmtDuration(s.uptimeSec):"—"} · memory ${s.memory?s.memory.used+" / "+s.memory.total+" KB":"—"}</div>`+
  `</div>`;
}
// Single source of truth for "which physical toolhead does this Klipper
// object refer to," shared by every card that references a toolhead
// (heaters, fans, MCUs). Klipper's own extruder/e-index numbering is 0-based
// (extruder == head 0, e0 == head 0, ...) but every other head number shown
// in SnapCon is 1-based (T1..T4) — fixed, hand-checked, NOT derived from
// headLabel()/USE_T_NOTATION, which is a different (0-based, G-code
// Tn-command-style) numbering used by the Toolheads card and left untouched.
function toolheadNumber(i){ return "T"+(i+1); }
// heater_bed isn't a toolhead at all; "extruder" (no digit) is head 0 = T1.
function heaterLabel(name){
  if(name==="heater_bed") return t("fleet.card.bed_label");
  const m=/^extruder(\d*)$/.exec(name);
  if(m) return t("health.heaters.hotend_label",{t:toolheadNumber(m[1]===""?0:parseInt(m[1],10))});
  return name;
}
// Fan names carry their toolhead index as an "eN" token wherever it
// appears (e.g. "heater_fan e0_nozzle_fan", "fan_generic e1_fan") — names
// with no eN token (cavity_fan, power_fan, the plain "fan", purifier's own
// fan) have no confirmed toolhead association, so they're left as-is.
// Explicit overrides for names with no eN token to derive a toolhead number
// from — confirmed live, not guessed (no authoritative Snapmaker naming doc
// exists for these; see the earlier research on this in the session).
const FAN_NAME_OVERRIDE_KEYS={ "fan":"health.fans.name_main_cooling", "fan_generic cavity_fan":"health.fans.name_assist_cooling", "purifier inner fan":"health.fans.name_recirculation", "purifier exhaust fan":"health.fans.name_exhaust" };
function fanLabel(name){
  if(FAN_NAME_OVERRIDE_KEYS[name]) return t(FAN_NAME_OVERRIDE_KEYS[name]);
  // The trailing boundary can't be \b here — every real name has "eN"
  // immediately followed by "_" (e.g. "e0_nozzle_fan"), and "_" counts as a
  // word character, so \b never matches there. A lookahead for "_" or
  // end-of-string is what "the eN token ends here" actually means.
  const m=/\be(\d)(?=_|$)/.exec(name);
  if(!m) return name;
  const rest=name.replace(/^(heater_fan|fan_generic)\s+e\d_/,"").replace(/_/g," ").trim();
  return toolheadNumber(parseInt(m[1],10))+(rest?" "+rest:"");
}
// MCU names are already relabeled server-side ("mainboard", "toolhead e0"..
// "toolhead e3" — see fetchMcuSection in connectors/http-utils.js).
function mcuLabel(name){
  if(name==="mainboard") return t("health.controller.mainboard_label");
  const m=/\be(\d)\b/.exec(name);
  if(m) return toolheadNumber(parseInt(m[1],10));
  return name;
}
// Duty is only meaningful once a reading has been stably AT target for a
// while — server.js's annotateHeaterStates() does the actual dwell tracking
// (it needs to survive across manual refreshes, so it lives server-side);
// these thresholds judge the duty number once the server has told us it's
// trustworthy (h.state==="stable"). Unvalidated starting points, same
// caveat as every other threshold on this page.
const HEATER_DUTY_WARN=0.6;
const HEATER_DUTY_CRIT=0.85;
const HEATER_DUTY_IMBALANCE_DELTA=0.3; // percentage-point spread (as a 0-1 fraction) between same-target siblings
// h.state itself (server-set: idle/heating/cooling/settling/stable) is
// never touched — only the DISPLAYED word for it is translated, via this
// map, at render time.
const HEALTH_HEATER_STATE_KEYS={heating:"health.heaters.state_heating",cooling:"health.heaters.state_cooling",settling:"health.heaters.state_settling"};
function heaterReadingRow(h){
  const label=heaterLabel(h.name);
  if(h.state==="idle") return readingRow(label,t("health.heaters.state_idle"),null,"neutral");
  const cur=h.temperature!=null?Math.round(h.temperature):"—";
  const tgt=h.target!=null?Math.round(h.target):"—";
  const dutyPct=h.power!=null?Math.round(h.power*100):null;
  if(h.state==="heating"||h.state==="cooling"||h.state==="settling"){
    const word=t(HEALTH_HEATER_STATE_KEYS[h.state]);
    return readingRow(label,t("health.heaters.reading_transit",{cur,tgt,word}),dutyPct,"neutral");
  }
  // stable — the only state where duty is trusted enough to color-judge.
  const state=h.power!=null&&h.power>=HEATER_DUTY_CRIT?"critical":h.power!=null&&h.power>=HEATER_DUTY_WARN?"warning":"healthy";
  return readingRow(label,t("health.heaters.reading_stable",{cur,tgt,pctText:dutyPct!=null?dutyPct+"%":"—"}),dutyPct,state);
}
// Cross-head duty imbalance: only compares stably-at-target extruder heads
// sharing the same target (heater_bed has no siblings; different targets
// aren't comparable). One named, specific note — not a generic warning —
// or none at all. Returns {text,state} so the caller can color the note to
// match its own severity (warning, or critical if the high head is already
// past the critical duty threshold).
function heaterImbalanceNote(list){
  const stable=list.filter(h=>h.state==="stable"&&h.power!=null&&/^extruder\d*$/.test(h.name));
  const byTarget=new Map();
  stable.forEach(h=>{ const k=h.target; if(!byTarget.has(k)) byTarget.set(k,[]); byTarget.get(k).push(h); });
  for(const group of byTarget.values()){
    if(group.length<2) continue;
    const sorted=group.slice().sort((a,b)=>b.power-a.power);
    const hi=sorted[0], lo=sorted[sorted.length-1];
    if(hi.power-lo.power>=HEATER_DUTY_IMBALANCE_DELTA&&hi.power>=HEATER_DUTY_WARN){
      return {
        text:t("health.heaters.imbalance_note",{hiLabel:heaterLabel(hi.name),hiPct:Math.round(hi.power*100),loLabel:heaterLabel(lo.name),loPct:Math.round(lo.power*100)}),
        state:hi.power>=HEATER_DUTY_CRIT?"critical":"warning"
      };
    }
  }
  return null;
}
function renderHeatersCard(d){
  const heaters=d.heaters;
  const cardTitle=t("health.heaters.card_title");
  if(!heaters||!heaters.available) return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div><p class="settings-help">${esc(healthDataUnavailable(cardTitle,heaters&&heaters.reason))}</p></div>`;
  if(!heaters.list.length) return "";
  const rows=heaters.list.map(heaterReadingRow).join("");
  const note=heaterImbalanceNote(heaters.list);
  return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div>`+
    rows+
    (note?`<div class="reading-note ${note.state}">${esc(note.text)}</div>`:"")+
  `</div>`;
}
// Same commanded-vs-measured mismatch semantics as server.js's
// checkFanMismatch, but evaluated fresh on every render, single-snapshot —
// this is a card-coloring decision, not a Needs Attention trigger. The
// server-side check additionally requires the mismatch to persist across
// two consecutive manual refreshes before it becomes an attention item,
// which this row-level color deliberately does not wait for.
const FAN_MISMATCH_RPM_THRESHOLD=50;
function fanReadingRow(f){
  const commandedPct=f.speed!=null?Math.round(f.speed*100):null;
  const measurable=f.rpm!=null;
  const commanded=f.speed!=null&&f.speed>0.1;
  const mismatched=measurable&&commanded&&f.rpm<FAN_MISMATCH_RPM_THRESHOLD;
  // Percentage on its own — "commanded" was the only word in the row and it
  // described the number rather than adding to it. An unmeasurable fan reads
  // N/A instead of a phrase, since the column is otherwise all values.
  const val=`${commandedPct!=null?t("health.fans.reading_commanded",{pct:commandedPct}):"—"} · ${measurable?t("health.fans.reading_rpm",{rpm:Math.round(f.rpm)}):t("health.fans.reading_not_measurable")}`;
  const state=mismatched?"warning":measurable?"healthy":"neutral";
  return readingRow(fanLabel(f.name),val,commandedPct,state);
}
// On SnapMaker U1, "fan_generic e1_fan"/"e2_fan"/"e3_fan" (no "_nozzle_")
// are the SAME physical fan as the plain "fan" object (Main Cooling Fan) —
// just mirrored per active toolhead, not distinct hardware. Shown alongside
// "Main Cooling Fan" they'd read as 4 separate fans when there's really
// one; filtered out here rather than displayed as redundant duplicates.
// "e0_fan" never exists at all (only e0_nozzle_fan does), which is exactly
// this pattern's other tell.
const FAN_REDUNDANT_MIRROR=/^fan_generic e\d_fan$/;
function renderFansCard(d){
  const fans=d.fans;
  const cardTitle=t("health.fans.card_title");
  if(!fans||!fans.available) return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div><p class="settings-help">${esc(healthDataUnavailable(cardTitle,fans&&fans.reason))}</p></div>`;
  const list=fans.list.filter(f=>!FAN_REDUNDANT_MIRROR.test(f.name));
  if(!list.length) return "";
  // Every fan, always. The old "N fans, all stopped [Show all]" summary
  // collapsed the card whenever nothing was spinning — which is the normal
  // idle state, so the card was usually collapsed exactly when someone opened
  // the page to look at it.
  return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div>${list.map(fanReadingRow).join("")}</div>`;
}
// Recent Faults: exception_manager's per-entry field shape was never
// confirmed live (every printer checked had zero entries) — rendered
// defensively, trying a few plausible field names before falling back to a
// raw compact dump, rather than assuming a shape that was never observed.
// The one entry whose shape IS known is the "current active error" folded
// in by fetchFaultsSection from the probe result.
function renderFaultEntry(f){
  if(f.current) return `<div class="health-fault-row"><span class="health-fault-badge">${esc(t("health.faults.active_badge"))}</span><span class="health-fault-text">${esc(f.errorCode?`[${f.errorCode}] `:"")}${esc(f.message||t("health.faults.unknown_error"))}</span></div>`;
  // exception_manager's per-entry shape was never confirmed live (see this
  // function's original comment) — the guessed field value or the raw
  // JSON.stringify(f) fallback is genuinely raw/unstructured connector
  // output and stays untranslated by design.
  const guess=["message","msg","reason","description","code"].map(k=>f[k]).find(v=>v!=null&&v!=="");
  return `<div class="health-fault-row"><span class="health-fault-text">${esc(guess!=null?String(guess):JSON.stringify(f))}</span></div>`;
}
function renderFaultsCard(d){
  const f=d.faults;
  const cardTitle=t("health.faults.card_title");
  if(!f||!f.available) return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div><p class="settings-help">${esc(healthDataUnavailable(cardTitle,f&&f.reason))}</p></div>`;
  if(!f.list.length) return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div><p class="settings-help">${esc(t("health.faults.none"))}</p></div>`;
  return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div>`+f.list.map(renderFaultEntry).join("")+`</div>`;
}

// Every service logged for this printer, newest first. Deliberately just the
// log: printer hours live in the form above it, and last service / warranty
// are already on screen (the metric tile and the printer heading), so
// repeating them here would be a third copy of the same two facts.
function renderServiceLogCard(maint){
  const entries=(maint&&maint.entries)||[];
  const header=`<div class="health-card-hdr">${esc(t("health.service_history.card_title"))}</div>`;
  // Notes is a textarea in the form, so it gets its own line under the
  // date/component/cost row rather than a squeezed, ellipsized column —
  // "replaced the 0.4 nozzle and cleaned the sock" is the part worth reading
  // later, and it is the one field with no length to speak of.
  const body=entries.length
    ? entries.slice().reverse().map(e=>`<div class="health-service-entry">`+
        `<div class="health-service-row">`+
          `<span class="health-service-date">${esc(fmtMaintDate(e.date))}</span>`+
          `<span class="health-service-component">${esc(e.component||"—")}</span>`+
          `<span class="health-service-cost">${e.cost?esc(CURRENCY)+Number(e.cost).toFixed(2):""}</span>`+
        `</div>`+
        (e.comment?`<div class="health-service-notes">${esc(e.comment)}</div>`:"")+
      `</div>`).join("")
    : `<p class="settings-help">${esc(t("health.service_history.none"))}</p>`;
  return `<div class="health-card" id="healthMaintCard">${header}${body}</div>`;
}
// Warranty as a suffix on the printer heading — only when there is a real
// date to show. computeWarranty() (server.js) returns status "unknown" with a
// null expiry whenever the printer has no purchase date, and that renders
// nothing rather than an empty parenthesis.
function warrantyHeadingSuffix(maint){
  const w=maint&&maint.warranty;
  if(!w||!w.expiry||w.status==="unknown") return "";
  const date=fmtMaintDate(w.expiry);
  return " ("+(w.status==="expired"?t("health.warranty_expired_on",{date}):t("health.warranty_until",{date}))+")";
}

// ---- Inline service form ("not a modal", per spec) — one static instance
// in #healthPage, shown/hidden rather than a popup. Reuses the Maintenance
// modal's own shared constants/helpers (MAINT_FREQ_SPEC, MAINT_FREQ_MAP,
// addDaysClient/addMonthsClient, fmtMaintDate, fmtHours) so the next-due
// preview math and default-frequency suggestion stay identical to the
// modal's — only the markup/element ids and the "inline, not popup" framing
// differ. POSTs to the same /api/maintenance the modal uses. ----
let HEALTH_SVC_COMPONENT="", HEALTH_SVC_HOURS_SEC=null;
function currentHealthSvcComponent(){
  return $("healthSvcComponentOther").value.trim()||HEALTH_SVC_COMPONENT;
}
function syncHealthSvcSaveEnabled(){
  $("healthSvcSave").disabled=!currentHealthSvcComponent();
}
// Roughly two rows of chips, ordered by how often this printer has actually
// been serviced for each component — the full list ran to five rows and put
// the parts you replace weekly below the ones you never touch. Anything not
// shown is still reachable through the "or type a new component" field,
// which accepts an existing name just as well as a new one.
const HEALTH_SVC_CHIP_LIMIT=10;
function healthSvcVisibleComponents(){
  const comps=(HEALTH_MAINT&&HEALTH_MAINT.components)||[];
  const used=new Map();
  for(const e of (HEALTH_MAINT&&HEALTH_MAINT.entries)||[]) if(e.component) used.set(e.component,(used.get(e.component)||0)+1);
  // Server order breaks ties, so a printer with no history yet keeps the
  // original, deliberate ordering rather than something arbitrary.
  const shown=comps.slice()
    .sort((a,b)=>((used.get(b)||0)-(used.get(a)||0))||(comps.indexOf(a)-comps.indexOf(b)))
    .slice(0,HEALTH_SVC_CHIP_LIMIT);
  // A selection made elsewhere (the Attention list's "log a fix" button)
  // must stay visible even when that component isn't in the top set.
  if(HEALTH_SVC_COMPONENT&&comps.includes(HEALTH_SVC_COMPONENT)&&!shown.includes(HEALTH_SVC_COMPONENT)) shown[shown.length-1]=HEALTH_SVC_COMPONENT;
  return shown;
}
function renderHealthSvcChips(){
  const wrap=$("healthSvcChips");
  if(!wrap) return;
  const comps=healthSvcVisibleComponents();
  wrap.innerHTML=comps.map(c=>`<button type="button" class="maint-chip${c===HEALTH_SVC_COMPONENT?" active":""}" data-comp="${esc(c)}">${esc(c)}</button>`).join("");
  wrap.querySelectorAll("[data-comp]").forEach(b=>{
    b.addEventListener("click",()=>{
      HEALTH_SVC_COMPONENT=b.dataset.comp;
      $("healthSvcComponentOther").value="";
      const known=MAINT_FREQ_MAP[HEALTH_SVC_COMPONENT];
      if(known) $("healthSvcFrequency").value=known;
      renderHealthSvcChips();
      updateHealthNextDuePreview();
      syncHealthSvcSaveEnabled();
    });
  });
}
function updateHealthNextDuePreview(){
  const spec=MAINT_FREQ_SPEC[$("healthSvcFrequency").value];
  const date=$("healthSvcDate").value;
  const component=currentHealthSvcComponent();
  if(!spec){
    $("healthSvcNextDue").textContent=t("maintenance.next_due_not_scheduled");
    $("healthSvcNextHint").textContent=t("maintenance.next_due_no_reminder_hint");
    return;
  }
  const next=spec.unit==="days"?addDaysClient(date,spec.amount):addMonthsClient(date,spec.amount);
  $("healthSvcNextDue").textContent=next?fmtMaintDate(next):"—";
  $("healthSvcNextHint").textContent=date?(component?t("maintenance.next_due_hint_component",{date:fmtMaintDate(date),freqLabel:t(spec.labelKey),component}):t("maintenance.next_due_hint",{date:fmtMaintDate(date),freqLabel:t(spec.labelKey)})):"";
}
function openHealthServiceForm(prefillComponent){
  const wrap=healthServiceFormEl();
  if(!wrap||HEALTH_PRINTER_ID==null) return;
  wrap.style.display="";
  $("healthSvcDate").value=new Date().toISOString().slice(0,10);
  $("healthSvcComponentOther").value="";
  HEALTH_SVC_COMPONENT=prefillComponent||"";
  $("healthSvcFrequency").value=MAINT_FREQ_MAP[HEALTH_SVC_COMPONENT]||"monthly";
  $("healthSvcCost").value="0.00";
  $("healthSvcPart").value="";
  $("healthSvcComment").value="";
  $("healthSvcStatus").textContent="";
  const p=FLEET.find(f=>f.id===HEALTH_PRINTER_ID);
  $("healthSvcOffline").checked=!!(p&&p.state==="maintenance");
  renderHealthSvcChips();
  updateHealthNextDuePreview();
  syncHealthSvcSaveEnabled();
  HEALTH_SVC_HOURS_SEC=null;
  $("healthSvcHours").textContent=t("maintenance.hours_loading");
  getJSON("/api/printer-hours?printer="+HEALTH_PRINTER_ID).then(d=>{
    HEALTH_SVC_HOURS_SEC=d.totalSeconds!=null?d.totalSeconds:null;
    $("healthSvcHours").textContent=HEALTH_SVC_HOURS_SEC!=null?fmtHours(HEALTH_SVC_HOURS_SEC):t("maintenance.hours_unavailable");
  }).catch(()=>{ $("healthSvcHours").textContent=t("maintenance.hours_unavailable"); });
  // Only scroll when the user asked for this specific component (the
  // Attention list's "log a fix" buttons). The form is permanently on screen
  // now, so scrolling on every printer switch would yank the page for no
  // reason.
  if(prefillComponent) wrap.scrollIntoView({behavior:"smooth",block:"nearest"});
}
function closeHealthServiceForm(){
  const wrap=healthServiceFormEl();
  if(wrap) wrap.style.display="none";
}
async function toggleHealthOffline(){
  const chk=$("healthSvcOffline");
  const st=$("healthSvcStatus");
  const offline=chk.checked;
  chk.disabled=true;
  st.className="pstatus work"; st.textContent=offline?t("maintenance.status_taking_offline"):t("maintenance.status_bringing_online");
  try{
    const r=await postJSON("/api/maintenance-mode",{printer:HEALTH_PRINTER_ID,offline});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=d.maintenanceMode?t("maintenance.status_taken_offline"):t("maintenance.status_back_online");
    chk.checked=!!d.maintenanceMode;
    loadFleet();
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; chk.checked=!offline; }
  finally{ chk.disabled=false; }
}
async function saveHealthService(){
  const st=$("healthSvcStatus");
  const date=$("healthSvcDate").value;
  if(!date){ st.className="pstatus err"; st.textContent=t("maintenance.error_pick_date"); return; }
  const component=currentHealthSvcComponent();
  if(!component){ st.className="pstatus err"; st.textContent=t("maintenance.error_pick_component"); return; }
  const pid=HEALTH_PRINTER_ID;
  const entry={
    date, comment:$("healthSvcComment").value.trim(), part:$("healthSvcPart").value.trim(),
    hours:HEALTH_SVC_HOURS_SEC!=null?fmtHours(HEALTH_SVC_HOURS_SEC):"—", totalSeconds:HEALTH_SVC_HOURS_SEC,
    component, frequency:$("healthSvcFrequency").value,
    cost:parseFloat($("healthSvcCost").value)||0
  };
  $("healthSvcSave").disabled=true;
  st.className="pstatus work"; st.textContent=t("maintenance.status_saving");
  try{
    const r=await postJSON("/api/maintenance",{printer:pid,entry});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=t("maintenance.status_saved");
    closeHealthServiceForm();
    loadHealthData(); // full re-fetch so Overview/Needs Attention/Service History all reflect the new entry
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ $("healthSvcSave").disabled=!currentHealthSvcComponent(); }
}
// "Timelapse" was the originally-assumed storage category, but Moonraker's
// real /server/files/roots on a live U1 has no dedicated timelapse root
// (only config/logs/gcodes/camera). Camera and timelapse both live under
// the same "camera" root on the U1, so they stay one category, labeled
// plainly "Camera."
const HEALTH_STORAGE_CATS=[
  { key:"gcodes", labelKey:"health.storage.cat_gcode", color:"var(--storage-gcode)" },
  { key:"logs", labelKey:"settings.printer_sync.logs", color:"var(--storage-logs)" },
  { key:"camera", labelKey:"settings.printer_sync.camera", color:"var(--storage-camera)" }
];
function storageLegendRow(label,color,extra,valueText,title){
  return `<div class="storage-legend-row"${title?` title="${esc(title)}"`:""}>`+
    `<span class="storage-legend-dot" style="background:${color}"></span>`+
    `<span class="storage-legend-label">${esc(label)}${extra||""}</span>`+
    `<span class="storage-legend-value">${esc(valueText)}</span>`+
  `</div>`;
}
// ---- Logs/Camera/G-code sync ----
// Client-side cache of the last known status per printer+root, keyed
// separately from HEALTH_DATA so it survives the full-body re-render a
// completed sync itself triggers (to pick up any disk-usage change from
// retention cleanup) without losing track of "still running."
const HEALTH_SYNC_STATE={};
const HEALTH_SYNC_TIMERS={};
// printer|root -> the `lastSyncAt` that root was showing when a NEWER sync
// was started, i.e. "this result is last time's, don't print it next to the
// current run's." The status line joins all three roots, and a finished
// root's result text lives on forever (the server keeps lastSyncAt until
// that root runs again), so without this a camera result stays glued to the
// front of a later logs run: "Camera: 12 downloaded · Logs: listing files…".
//
// Marked rather than deleted on purpose. Deleting HEALTH_SYNC_STATE entries
// looks right for a moment and then undoes itself: every completed sync ends
// with loadHealthData() -> resumeSyncPollingIfRunning(), which refetches all
// three roots from the server and writes them straight back — so the stale
// line would reappear at exactly the moment the new result arrived.
//
// Compared by VALUE, never against a clock: lastSyncAt is stamped with the
// server's Date.now() and this runs in the browser, so any timestamp
// comparison would break under clock skew — in the direction that hides the
// new result, not the old one. A root un-suppresses itself simply by running
// again, which gives it a different lastSyncAt.
const HEALTH_SYNC_STALE_AT={};
// Called when a sync starts: every root of that printer that isn't currently
// running has its present result marked as belonging to the previous run.
// Running roots are deliberately left alone — those lines are live, not
// stale, and two roots can legitimately sync at once.
function markOtherSyncResultsStale(printerId){
  for(const r of ["logs","camera","gcodes"]){
    const k=syncKey(printerId,r);
    const st=HEALTH_SYNC_STATE[k];
    if(st&&!syncRunning(st)) HEALTH_SYNC_STALE_AT[k]=st.lastSyncAt||null;
  }
}
// True while a root's finished state is still the one that was on screen
// when a newer sync started. Only ever suppresses finished text (a result or
// an error); progress phases have no lastSyncAt of their own to match.
function syncResultIsStale(printerId,root,st){
  if(!st||syncRunning(st)) return false;
  const k=syncKey(printerId,root);
  return k in HEALTH_SYNC_STALE_AT && (st.lastSyncAt||null)===HEALTH_SYNC_STALE_AT[k];
}
// Same three concepts as HEALTH_STORAGE_CATS above (Logs/Camera reuse
// settings.printer_sync's identical labels; G-code stays its own key since
// settings.printer_sync.gcode_archive says "G-code archive," a genuinely
// different phrase, not a duplicate).
// Deliberately NOT health.storage.cat_gcode ("G-code"): that one names the
// disk-usage category in the legend, this one names the thing being synced
// ("Jobs") on the buttons and status lines. Same root, two different jobs —
// test/i18n/bundled-content.test.js pins the legend label separately.
const SYNC_ROOT_LABEL_KEYS={logs:"settings.printer_sync.logs",camera:"settings.printer_sync.camera",gcodes:"health.storage.sync_root_gcodes"};
function syncRootLabel(root){ return t(SYNC_ROOT_LABEL_KEYS[root]||root); }
function syncKey(printerId,root){ return printerId+"|"+root; }
function syncRunning(st){ return st&&(st.phase==="listing"||st.phase==="downloading"||st.phase==="cleaning-up"); }
// Progress fraction (0-100) for baking directly into the button's own fill
// gradient (see syncBtn() in renderStorageCard) — same "the button itself
// is the progress bar" idiom as the existing file-upload buttons
// (setBtnFill in the print-queue code). null means "no fill" (idle/error).
function syncProgressPct(st){
  if(!st) return null;
  if(st.phase==="listing") return 0;
  if(st.phase==="downloading") return st.total?Math.round((st.completed||0)/st.total*100):0;
  if(st.phase==="cleaning-up") return 100;
  return null;
}
// st.phase itself (server-reported: listing/downloading/cleaning-up/idle/
// error) is never touched — this if/else only decides which already-
// translated template to render, same as every other stable-state→
// presentation mapping on this page. st.currentFile/st.lastError are raw,
// printer/connector-supplied values and stay untranslated.
function syncStatusText(root,st){
  if(!st) return "";
  const label=syncRootLabel(root);
  if(st.phase==="listing") return t("health.storage.sync_status_listing",{label});
  if(st.phase==="downloading") return st.currentFile
    ? t("health.storage.sync_status_downloading_file",{label,completed:st.completed,total:st.total,file:st.currentFile})
    : t("health.storage.sync_status_downloading",{label,completed:st.completed,total:st.total});
  if(st.phase==="cleaning-up") return t("health.storage.sync_status_cleaning",{label});
  if(st.phase==="error") return t("health.storage.sync_status_error",{label,error:st.lastError||t("health.storage.unknown_error")});
  if(st.phase==="idle"&&st.lastSyncAt){
    let text=t("health.storage.sync_status_result",{label,downloaded:st.downloaded,skipped:st.skipped});
    // Complete, self-contained comma-clauses appended when present — same
    // "join complete fragments" idiom as Fleet's bulk-result messages,
    // rather than concatenating translated word fragments mid-sentence.
    if(st.failed) text+=t("health.storage.sync_status_result_failed_suffix",{failed:st.failed});
    if(st.deletedFromSource) text+=t("health.storage.sync_status_result_removed_suffix",{removed:st.deletedFromSource});
    return text;
  }
  return "";
}
async function startSync(printerId,root){
  const key=syncKey(printerId,root);
  // Before anything else, so a failed start also clears the previous run's
  // lines rather than showing this root's error beside them.
  markOtherSyncResultsStale(printerId);
  try{
    const r=await postJSON("/api/sync?printer="+printerId+"&root="+root,{});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    HEALTH_SYNC_STATE[key]={phase:"listing"};
    if(HEALTH_PRINTER_ID===printerId) renderHealthBody();
    pollSyncStatus(printerId,root);
  }catch(e){
    HEALTH_SYNC_STATE[key]={phase:"error",lastError:e.message};
    if(HEALTH_PRINTER_ID===printerId) renderHealthBody();
  }
}
async function pollSyncStatus(printerId,root){
  const key=syncKey(printerId,root);
  clearTimeout(HEALTH_SYNC_TIMERS[key]);
  let st;
  try{ st=await getJSON("/api/sync-status?printer="+printerId+"&root="+root); }
  catch{ HEALTH_SYNC_TIMERS[key]=setTimeout(()=>pollSyncStatus(printerId,root),1500); return; }
  HEALTH_SYNC_STATE[key]=st;
  if(syncRunning(st)){
    if(HEALTH_PRINTER_ID===printerId) renderHealthBody();
    HEALTH_SYNC_TIMERS[key]=setTimeout(()=>pollSyncStatus(printerId,root),1500);
  } else if(HEALTH_PRINTER_ID===printerId){
    loadHealthData(); // full refresh — picks up any disk-usage change from retention cleanup
  }
}
function renderStorageCard(d,printerId){
  const s=d.storage;
  const cardTitle=t("health.storage.card_title");
  if(!s||!s.available) return `<div class="health-card"><div class="health-card-hdr">${esc(cardTitle)}</div><p class="settings-help">${esc(healthDataUnavailable(cardTitle,s&&s.reason))}</p></div>`;
  const du=s.diskUsage, total=du.total||1;
  const critical=du.free<du.total*DISK_CRITICAL_PCT||du.free<DISK_CRITICAL_BYTES;
  const segs=HEALTH_STORAGE_CATS.map(c=>({...c, label:t(c.labelKey), bytes:(s.categories[c.key]&&s.categories[c.key].bytes)||0}));
  // Only the three named categories get a segment — the rest of the track
  // (everything else on disk, including free space) is left unfilled and
  // unlabeled on purpose, per spec: no "Other," no "Free" row here (Free
  // space already has its own metric card at the top of the page).
  const barHtml=segs.map(c=>`<span class="health-storage-seg" style="width:${Math.max(0,c.bytes/total*100).toFixed(2)}%;background:${c.color}" title="${esc(c.label)}: ${fmtBytes(c.bytes)}"></span>`).join("");
  const legendHtml=segs.map(c=>{
    if(c.key!=="gcodes"||!s.categories.gcodes) return storageLegendRow(c.label,c.color,"",fmtBytes(c.bytes));
    const gc=s.categories.gcodes;
    let extra=" "+esc(tn("health.storage.files_count",gc.fileCount)), title=null;
    if(gc.unusedCount!=null){
      extra+=esc(t("health.storage.unused_suffix",{n:gc.unusedCount}));
      title=tn("health.storage.unused_title",gc.unusedThresholdDays,{days:gc.unusedThresholdDays});
    }
    return storageLegendRow(c.label,c.color,extra,fmtBytes(c.bytes),title);
  }).join("");
  const syncFolders=d.syncFolders||{};
  const syncStates={logs:HEALTH_SYNC_STATE[syncKey(printerId,"logs")], camera:HEALTH_SYNC_STATE[syncKey(printerId,"camera")], gcodes:HEALTH_SYNC_STATE[syncKey(printerId,"gcodes")]};
  // The button itself is the progress bar — same idiom as the existing
  // file-upload buttons elsewhere in the app (a hard-edged two-tone
  // gradient baked into the inline style, not a separate bar element).
  // Baked into the rendered HTML from HEALTH_SYNC_STATE on every pass
  // (rather than an imperative setBtnFill() call) because renderHealthBody()
  // fully rebuilds this markup on every poll tick, which would otherwise
  // orphan any direct DOM reference to the button.
  const syncBtn=(root)=>{
    const st=syncStates[root], running=syncRunning(st), configured=syncFolders[root];
    const disabled=!d.syncSupported||!configured||running;
    const label=syncRootLabel(root);
    const title=!d.syncSupported?t("health.storage.sync_title_unsupported")
      :!configured?t("health.storage.sync_title_not_configured",{label})
      :running?t("health.storage.sync_title_running")
      :"";
    const text=running?t("health.storage.sync_button_syncing",{label:label.toLowerCase()}):t("health.storage.sync_button_idle",{label:label.toLowerCase()});
    const pct=syncProgressPct(st);
    const fill=pct!=null?`background:linear-gradient(to right, rgba(167,139,250,0.55) ${pct}%, rgba(167,139,250,0.13) ${pct}%);`:"";
    // Falls back to the button's own text: at one tile wide these labels are
    // ellipsized rather than allowed to wrap (see .health-metrics-storage in
    // style.css), so the full wording has to stay reachable on hover. An
    // explanatory title — unsupported/not configured/already running — still
    // wins, since it says more than the label does.
    return `<button type="button" class="btn ghost" style="${fill}" ${disabled?"disabled":""} title="${esc(title||text)}" data-sync="${root}" data-syncprinter="${printerId}">${esc(text)}</button>`;
  };
  const statusText=["logs","camera","gcodes"]
    .map(r=>syncResultIsStale(printerId,r,syncStates[r])?"":syncStatusText(r,syncStates[r]))
    .filter(Boolean).join(" · ");
  // health-diag-vals (total/used/free) is plain SnapCon-owned prose, not
  // protocol jargon like the Controller/System cards' diag lines — kept
  // translated, unlike those.
  return `<div class="health-card">
    <div class="health-card-hdr">${esc(cardTitle)}</div>
    ${critical?`<div class="health-critical-banner">${esc(t("health.storage.critical_banner"))}</div>`:""}
    <div class="health-storage-bar">${barHtml}</div>
    ${legendHtml}
    <div class="health-diag-vals health-storage-totals">${esc(t("health.storage.totals",{total:fmtBytes(du.total),used:fmtBytes(du.used)}))}</div>
    <div class="health-storage-actions">
      ${syncBtn("logs")}
      ${syncBtn("camera")}
      ${syncBtn("gcodes")}
    </div>
    ${statusText?`<div class="settings-help" style="margin-top:8px">${esc(statusText)}</div>`:""}
  </div>`;
}
function renderHealthBody(){
  const body=$("healthBody");
  if(!body) return;
  if(HEALTH_PRINTER_ID==null){ body.innerHTML=`<div class="settings-help">${esc(t("health.no_printer_selected"))}</div>`; closeHealthServiceForm(); return; }
  const d=HEALTH_DATA;
  const p=FLEET.find(f=>f.id===HEALTH_PRINTER_ID);
  const name=p?p.name:t("health.printer_fallback");
  if(!d){ body.innerHTML=`<div class="settings-help">${esc(t("health.loading",{name}))}</div>`; closeHealthServiceForm(); return; }
  if(d.skipped){
    body.innerHTML=`<div class="health-unsupported"><h3>${esc(name)}</h3><p>${esc(t("health.unsupported"))}</p>${d.reason?`<p class="settings-help">${esc(d.reason)}</p>`:""}</div>`;
    closeHealthServiceForm();
    return;
  }
  const hist=d.history&&d.history.available?d.history:null;
  const printTime=hist?fmtDuration(hist.totalPrintTime):"—";
  const recent=hist&&hist.recent;
  const recentPctTxt=recent&&recent.sampleSize?Math.round(recent.completed/recent.sampleSize*100)+"%":"—";
  const recentSub=recent&&recent.sampleSize?t("health.recent_success_jobs",{completed:recent.completed,total:recent.sampleSize}):"";
  const storage=d.storage&&d.storage.available?d.storage:null;
  const systemCardHtml=renderSystemCard(d);
  const controllerCardHtml=renderControllerCard(d);
  const heatersCardHtml=renderHeatersCard(d);
  const fansCardHtml=renderFansCard(d);
  const freeTxt=storage?fmtBytes(storage.diskUsage.free):"—";
  const metricsHtml=`<div class="health-metrics">`+
    `<div class="health-metric"><span class="health-metric-label">${esc(t("health.metric_print_time"))}</span><span class="health-metric-val">${printTime}</span></div>`+
    `<div class="health-metric"><span class="health-metric-label">${esc(t("health.metric_recent_success"))}</span><span class="health-metric-val">${recentPctTxt}</span>${recentSub?`<span class="health-metric-sub">${esc(recentSub)}</span>`:""}</div>`+
    `<div class="health-metric"><span class="health-metric-label">${esc(t("health.metric_free_space"))}</span><span class="health-metric-val">${freeTxt}</span></div>`+
    `<div class="health-metric"><span class="health-metric-label">${esc(t("health.metric_last_service"))}</span><span class="health-metric-val">${esc(lastServiceText(HEALTH_MAINT))}</span></div>`+
    // These cards sit INSIDE the metrics grid rather than in .health-grid
    // below, which is what makes them exactly one metric tile wide (and keeps
    // them that way as auto-fit changes the column count) without hardcoding
    // a width.
    // ---- Below the tiles: three COLUMN STACKS, not a card per grid cell.
    // One grid item per column, each stacking its own cards, because grid
    // rows are as tall as their tallest member: with a card per cell, the
    // tall Log service form set row 2's height and Storage was left floating
    // in a stretched cell with System pushed a row further down. A stack owns
    // its whole column, so its cards sit a fixed 10px apart no matter how
    // tall the neighbouring column gets — and there is only one item per
    // column left for auto-placement to get wrong.
    `<div class="health-metrics-col1">`+
      `<div class="health-metrics-storage">${renderStorageCard(d,HEALTH_PRINTER_ID)}</div>`+
      // renderSystemCard()/renderControllerCard() return "" when the printer
      // reports nothing for them — emit no wrapper at all in that case.
      (systemCardHtml||"")+
      (controllerCardHtml||"")+
    `</div>`+
    // Column 2 stacks Heaters then Fans, both at one tile wide.
    (heatersCardHtml||fansCardHtml?`<div class="health-metrics-col2">${heatersCardHtml||""}${fansCardHtml||""}</div>`:"")+
    // The service-record form goes into the empty slot as a MOVED element
    // (see mountHealthServiceForm) rather than re-emitted markup, so a
    // half-typed entry survives the 1.5s poll re-render.
    `<div class="health-metrics-col34">`+
      `<div id="healthSvcSlot"></div>`+
    `</div>`+
    // Full width, under all three column stacks — the log is a wide table of
    // rows, not a column-shaped card. Needs attention and Recent faults then
    // split the row beneath it, half the log's width each.
    `<div class="health-metrics-full">${renderServiceLogCard(HEALTH_MAINT)}</div>`+
    `<div class="health-metrics-half-l">${renderAttentionList(d)}</div>`+
    `<div class="health-metrics-half-r">${renderFaultsCard(d)}</div>`+
  `</div>`;
  detachHealthServiceForm(); // must happen before innerHTML — see that function
  const warrantySuffix=warrantyHeadingSuffix(HEALTH_MAINT);
  body.innerHTML=`<h3 class="health-printer-name">${esc(name)}`+
    (warrantySuffix?`<span class="health-printer-warranty${(HEALTH_MAINT&&HEALTH_MAINT.warranty&&HEALTH_MAINT.warranty.status)==="expired"?" bad":""}">${esc(warrantySuffix)}</span>`:"")+
    // Every card lives in the metrics grid now, so there is no second grid
    // below it to render.
    `</h3>`+metricsHtml;
  body.querySelectorAll("[data-sync]").forEach(b=>{
    b.addEventListener("click",()=>startSync(parseInt(b.dataset.syncprinter,10),b.dataset.sync));
  });
  body.querySelectorAll("[data-logfix]").forEach(b=>{
    b.addEventListener("click",()=>openHealthServiceForm(b.dataset.logfix));
  });
  mountHealthServiceForm();
}
// The service form is a single static element (index.html), not markup this
// function emits — so it is MOVED into the freshly rendered slot on every
// pass. appendChild relocates the live node: its listeners, its chip state
// and anything already typed into it survive a poll re-render, which
// re-emitting it as HTML would destroy every 1.5 seconds.
//
// Its fields are re-initialised only when the printer actually changed, for
// the same reason: openHealthServiceForm() resets every input, and calling
// that on each render would wipe an entry mid-typing.
let HEALTH_SVC_FOR_PRINTER=null;
// Held as a JS reference, not looked up each time: while the form is parked
// between renders it is detached from the document, and getElementById()
// cannot find a detached node.
let HEALTH_SVC_EL=null;
function healthServiceFormEl(){
  if(!HEALTH_SVC_EL) HEALTH_SVC_EL=document.getElementById("healthServiceForm");
  return HEALTH_SVC_EL;
}
// Called immediately BEFORE #healthBody is rewritten. Once the form has been
// moved into a slot inside that subtree, an innerHTML assignment would
// destroy it outright — and it is the one static instance, so it would never
// come back. Detaching first keeps the node (and everything typed into it)
// alive in HEALTH_SVC_EL until mountHealthServiceForm() re-attaches it.
function detachHealthServiceForm(){
  const wrap=healthServiceFormEl();
  if(!wrap||!wrap.parentNode) return;
  // Removing a focused element from the document blurs it, so whatever the
  // caret was in has to be remembered here and put back by
  // mountHealthServiceForm() — otherwise any render that happens mid-typing
  // (a sync poll, a locale switch) drops the user out of the field.
  const a=document.activeElement;
  HEALTH_SVC_FOCUS=(a&&a.id&&wrap.contains(a))?{id:a.id,start:a.selectionStart,end:a.selectionEnd}:null;
  wrap.parentNode.removeChild(wrap);
}
// True while the caret is somewhere inside the service form.
function healthServiceFormHasFocus(){
  const wrap=healthServiceFormEl(), a=document.activeElement;
  return !!(wrap&&a&&wrap.contains(a));
}
let HEALTH_SVC_FOCUS=null;
function restoreHealthServiceFocus(){
  if(!HEALTH_SVC_FOCUS) return;
  const {id,start,end}=HEALTH_SVC_FOCUS;
  HEALTH_SVC_FOCUS=null;
  const el=document.getElementById(id);
  if(!el) return;
  el.focus({preventScroll:true});
  // Caret position, so typing resumes mid-word rather than at the end.
  // Not every input type supports selection ranges (number, date) — those
  // throw, and losing the caret offset there is harmless.
  if(start!=null){ try{ el.setSelectionRange(start,end); }catch{ /* unsupported input type */ } }
}
function mountHealthServiceForm(){
  const wrap=healthServiceFormEl(), slot=$("healthSvcSlot");
  if(!wrap) return;
  if(!slot||HEALTH_PRINTER_ID==null){ closeHealthServiceForm(); HEALTH_SVC_FOR_PRINTER=null; return; }
  if(wrap.parentNode!==slot) slot.appendChild(wrap);
  if(HEALTH_SVC_FOR_PRINTER!==HEALTH_PRINTER_ID){
    HEALTH_SVC_FOR_PRINTER=HEALTH_PRINTER_ID;
    HEALTH_SVC_FOCUS=null; // a different printer's form — nothing to return to
    openHealthServiceForm();
  }else{
    wrap.style.display="";
    restoreHealthServiceFocus();
  }
}
async function refreshQueueDashboard(){
  try{
    const status=await getJSON("/api/queue-management/status");
    QUEUE_STORE_STATUS=status.store||QUEUE_STORE_STATUS;
  }catch{}
  const managedIds=PRINTERS_CFG.filter(p=>p.printerPoolId).map(p=>p.id);
  const results=await Promise.all(managedIds.map(id=>getJSON("/api/queue/"+id).catch(()=>null)));
  QUEUE_VIEW_DATA={};
  managedIds.forEach((id,i)=>{ if(results[i]) QUEUE_VIEW_DATA[id]=results[i]; });
  renderQueueDashboard();
}

// ---- Fleet Status / stat-card categorization — ONE precedence chain shared
// by both, so a printer is never shown as "printing" in one place and "idle"
// in the other. Highest-wins order: offline > error > awaiting sign-off >
// stopped > printing > idle (queuePaused with no other condition just folds
// into idle — the reference legend has no separate "paused" category). ----
// Paused reuses --violet, the same hue the Fleet card's own Pause/Resume
// buttons already use elsewhere in this app (.btn-pause/.btn-resume) — one
// consistent color for "paused" everywhere rather than inventing a second
// one just for this chip. Offline gets its own --offline token (a warm
// gray) instead of reusing --idle's cool gray — the two used to be visually
// indistinguishable at chip size, icon or no icon.
const QUEUE_STATUS_CATEGORY_COLOR = { offline:"var(--offline)", error:"var(--bad)", awaiting:"var(--ok)", stopped:"var(--signal)", paused:"var(--violet)", printing:"var(--busy)", idle:"var(--idle)" };
// Reuses printer_status.* for the categories that mean the exact same thing
// as the Printers tab's own status labels — only "awaiting" and "stopped"
// are genuinely Queue-Management-specific concepts without a Printers-tab
// equivalent.
const QUEUE_STATUS_CATEGORY_LABEL_KEYS = { offline:"printer_status.offline", error:"printer_status.error", awaiting:"queue.category_awaiting", stopped:"queue.category_stopped", paused:"printer_status.paused", printing:"printer_status.printing", idle:"printer_status.idle" };
function queueStatusCategoryLabel(cat){ return t(QUEUE_STATUS_CATEGORY_LABEL_KEYS[cat]); }
function printerQueueCategory(p){
  const fleetRow=fleetRowForPrinterId(p.id);
  if(!fleetRow||!fleetRow.online) return "offline";
  const qs=QUEUE_VIEW_DATA[p.id];
  if((qs&&qs.queueState==="queue_attention_required")||fleetRow.state==="error") return "error";
  // A printer can be physically printing without the QUEUE knowing anything
  // about it — Queue Management only intercepts an upload while the printer
  // is already busy; a print started while idle (direct upload, or from the
  // printer's own screen) goes through the legacy path entirely, leaving
  // qs.queueState at "idle" the whole time. Fleet Status is describing the
  // fleet's real physical state, so the live probe's state is the primary
  // signal here — the queue's own busy states (dispatching/bed_clear_running)
  // only matter for the moments the probe alone wouldn't yet show "printing"
  // (e.g. mid-upload, before the printer has actually started).
  if(fleetRow.state==="printing"||(qs&&["dispatching","printing","bed_clear_running"].includes(qs.queueState))) return "printing";
  if(qs&&qs.queueState==="awaiting_bed_clear") return "awaiting";
  // queuePaused/queueStopped are orthogonal booleans (see QueueEngine) — a
  // printer can technically carry both; Stopped wins since it's the more
  // deliberate, longer-lived action of the two.
  if(qs&&qs.queueStopped) return "stopped";
  if(qs&&qs.queuePaused) return "paused";
  return "idle";
}
function queueLocalDateKey(ts){ const d=new Date(ts); return d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate(); }
function isToday(ts){ return ts!=null && queueLocalDateKey(ts)===queueLocalDateKey(Date.now()); }
function fmtElapsedSince(ts){
  return fmtDuration((Date.now()-ts)/1000);
}

function computeQueueStats(){
  const managed=PRINTERS_CFG.filter(p=>p.printerPoolId);
  const counts={printing:0, idle:0, awaiting:0, stopped:0, paused:0, error:0, offline:0};
  managed.forEach(p=>{ counts[printerQueueCategory(p)]++; });
  let partsToday=0;
  managed.forEach(p=>{
    const qs=QUEUE_VIEW_DATA[p.id]; if(!qs) return;
    (qs.recentHistory||[]).forEach(it=>{ if(it.status==="completed" && isToday(it.finishedAt)) partsToday++; });
  });
  return { counts, active:counts.printing, total:managed.length, partsToday };
}

// ---- Queue Status ("Active Projects") — one card per Printer Pool, one
// progress row per distinct filename currently active in it. Discrete item
// counts (completed/printing/queued) are the denominator; only the
// "effective completed" numerator carries a live progress fraction, so the
// percentage moves smoothly but the denominator never does (design doc
// correction round). No QueueEngine/QueueStore changes — purely a client-
// side aggregation over data already served today. ----
function computeActiveProjectsForPool(pool){
  const printers=PRINTERS_CFG.filter(p=>p.printerPoolId===pool.id);
  const byName=new Map();
  const entryFor=name=>{ let e=byName.get(name); if(!e){ e={ activeCreatedAts:[], printingProgress:[], queuedCount:0, historyCompleted:[], brands:new Set() }; byName.set(name,e); } return e; };
  printers.forEach(p=>{
    const qs=QUEUE_VIEW_DATA[p.id]; if(!qs) return;
    const fleetRow=fleetRowForPrinterId(p.id);
    if(qs.currentItem && qs.queueState==="printing"){
      const e=entryFor(qs.currentItem.file.name);
      e.activeCreatedAts.push(qs.currentItem.createdAt);
      e.printingProgress.push((fleetRow&&typeof fleetRow.progress==="number")?fleetRow.progress:0);
      if(fleetRow&&fleetRow.brand) e.brands.add(fleetRow.brand);
    }
    (qs.queue||[]).forEach(it=>{
      const e=entryFor(it.file.name);
      e.activeCreatedAts.push(it.createdAt);
      e.queuedCount++;
      if(fleetRow&&fleetRow.brand) e.brands.add(fleetRow.brand);
    });
    (qs.recentHistory||[]).forEach(it=>{
      if(it.status!=="completed") return;
      const e=entryFor(it.file.name);
      e.historyCompleted.push(it.finishedAt);
      if(fleetRow&&fleetRow.brand) e.brands.add(fleetRow.brand);
    });
  });
  const rows=[];
  byName.forEach((e,name)=>{
    if(e.activeCreatedAts.length){
      const windowStart=Math.min(...e.activeCreatedAts);
      const completedCount=e.historyCompleted.filter(ts=>ts>=windowStart).length;
      const printingCount=e.printingProgress.length;
      const queuedCount=e.queuedCount;
      const totalCount=completedCount+printingCount+queuedCount;
      const effectiveCompleted=completedCount+e.printingProgress.reduce((a,b)=>a+b,0);
      const pct=totalCount?Math.round(effectiveCompleted/totalCount*100):0;
      rows.push({ kind:"active", name, completedCount, printingCount, queuedCount, totalCount, pct, windowStart, brands:[...e.brands] });
    } else {
      const completedToday=e.historyCompleted.filter(isToday).length;
      if(completedToday>0) rows.push({ kind:"completed-today", name, completedCount:completedToday, brands:[...e.brands] });
    }
  });
  return rows;
}
function renderActiveProjectRow(r){
  if(r.kind==="completed-today"){
    return `<div class="queue-project-row">`+
      `<div class="queue-project-name">${esc(r.name)}</div>`+
      `<div class="queue-project-meta"><span class="queue-status-badge" style="color:var(--ok)">${t("queue.completed_badge")}</span> ${t("queue.completed_today_count",{count:r.completedCount})}</div>`+
      `</div>`;
  }
  const brands=r.brands.length?esc(r.brands.join(", ")):"";
  return `<div class="queue-project-row">`+
    `<div class="queue-project-name">${esc(r.name)}</div>`+
    `<div class="queue-project-bar"><div class="queue-project-fill" style="width:${r.pct}%"></div></div>`+
    `<div class="queue-project-meta">${esc(t("queue.active_project_stats",{completed:r.completedCount,printing:r.printingCount,queued:r.queuedCount,pct:r.pct}))}</div>`+
    `<div class="queue-project-footer">${esc(t("queue.so_far_prefix",{elapsed:fmtElapsedSince(r.windowStart)}))}${brands?" · "+brands:""}</div>`+
    `</div>`;
}
function renderActiveProjectsSection(pools){
  return `<div class="fl" style="margin:16px 0 8px">${t("queue.queue_status_title")}</div>`+
    pools.map(g=>{
      const rows=computeActiveProjectsForPool(g.pool);
      const body=rows.length ? rows.map(renderActiveProjectRow).join("") : `<div class="settings-help">${t("queue.nothing_active")}</div>`;
      return `<div class="setcard" style="margin-bottom:12px">`+
        `<div class="fl" style="margin-bottom:8px">${esc(g.pool.name)}</div>`+
        body+
        `</div>`;
    }).join("");
}

// ---- Fleet Status — per-pool rows of colored, labeled printer chips + a
// legend. Every chip carries a text tooltip (name + status word) and the
// badges/legend already spell status out in text, so nothing here is ever
// conveyed by color alone. ----
// Multi-select legend filter over the chip strips — empty means "show
// everything" (the default); survives re-renders the same way
// QUEUE_EXPANDED_ROWS does, since renderQueueDashboard() rebuilds this
// section's innerHTML on every 5s poll.
let QUEUE_FLEET_STATUS_FILTER=new Set();
// Offline reads as a glyph, not a color — a plain dot can't be told apart
// from "idle" by anyone who can't distinguish the two dim grays, and this
// state specifically means "someone needs to walk over," which is a bigger
// deal than idle. currentColor so it always matches --status-color like the
// dot it replaces.
const QUEUE_OFFLINE_ICON=`<svg class="qchip-icon" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" stroke-width="1"></circle><line x1="1.8" y1="1.8" x2="6.2" y2="6.2" stroke="currentColor" stroke-width="1"></line></svg>`;
// Per-chip fill percent (printing only) + the extra tooltip fact each state
// contributes beyond "name — state": current file/percent, offline-since,
// or the actual fault, so nothing is ever titled with just a state word.
function fleetChipDetail(p, cat, fleetRow, qs){
  if(cat==="printing"){
    const file=(qs&&qs.currentItem)?qs.currentItem.file.name:((fleetRow&&fleetRow.filename)||"");
    const pct=(fleetRow&&typeof fleetRow.progress==="number")?Math.round(fleetRow.progress*100):null;
    return { fillPct:pct||0, extra:[file, pct!=null?pct+"%":""].filter(Boolean).join(", ") };
  }
  if(cat==="offline") return { fillPct:0, extra:offlineSinceLabel(p.id, false) };
  if(cat==="error"){
    // attentionDetail.message mixes raw connector diagnostics with SnapCon
    // fallback prose unpredictably (see queue/QueueEngine.js) — left as an
    // opaque raw fallback. attentionReason, by contrast, is always one of
    // the stable ATTENTION_REASONS slugs, so it goes through the label map.
    const msg=(qs&&qs.attentionDetail&&qs.attentionDetail.message)||(qs&&qs.attentionReason&&attentionReasonLabel(qs.attentionReason))||(fleetRow&&fleetRow.error)||"";
    // Only a real hardware error (the printer itself reporting state:error)
    // is something "eject the loaded file" can fix — a queue_attention_required
    // caused by e.g. a missing/changed file has nothing physically loaded to
    // release, and already has its own Retry/Skip/Stop resolution controls
    // in the Printers section below, so no click hint is added for that case.
    const hw=fleetRow&&fleetRow.state==="error";
    return { fillPct:0, extra:[msg, hw?t("queue.click_to_release"):""].filter(Boolean).join(" — ") };
  }
  if(cat==="awaiting") return { fillPct:0, extra:t("queue.waiting_for_bed_clear") };
  if(cat==="stopped") return { fillPct:0, extra:t("queue.stopped_click_to_release") };
  if(cat==="paused") return { fillPct:0, extra:t("queue.paused_click_to_resume") };
  return { fillPct:0, extra:"" };
}
function renderFleetStatusSection(pools){
  const rows=pools.map(g=>{
    const cats=g.printers.map(printerQueueCategory);
    const counts={};
    cats.forEach(c=>{ counts[c]=(counts[c]||0)+1; });
    const chips=g.printers.map((p,i)=>{
      const cat=cats[i], color=QUEUE_STATUS_CATEGORY_COLOR[cat], label=queueStatusCategoryLabel(cat);
      const fleetRow=fleetRowForPrinterId(p.id), qs=QUEUE_VIEW_DATA[p.id];
      const { fillPct, extra }=fleetChipDetail(p, cat, fleetRow, qs);
      const title=[p.name+" — "+label, extra].filter(Boolean).join(": ");
      const hidden=QUEUE_FLEET_STATUS_FILTER.size && !QUEUE_FLEET_STATUS_FILTER.has(cat);
      // Stopped/Paused never clear themselves (nothing in the queue-management
      // lifecycle un-sets either flag except an explicit Resume) and a real
      // hardware error (the printer itself reporting state:error, not just a
      // queue-side attention item) can be released the same way the Fleet
      // card's own Eject button would — by ejecting whatever's loaded. Every
      // other state either resolves on its own (printing/idle/awaiting) or
      // needs a real decision the chip can't make for you (queue attention).
      const hwError=cat==="error" && fleetRow && fleetRow.state==="error";
      const actionable=cat==="stopped"||cat==="paused"||hwError;
      const tag=actionable?"button":"span";
      const attrs=actionable?` type="button" data-printer="${esc(p.id)}" data-cat="${esc(cat)}"`:"";
      return `<${tag} class="queue-chip${actionable?" qchip-actionable":""}${hidden?" qchip-hidden":""}"${attrs} style="--status-color:${color}" title="${esc(title)}">`+
        (cat==="printing"?`<span class="qchip-fill" style="width:${fillPct}%"></span>`:"")+
        (cat==="offline"?QUEUE_OFFLINE_ICON:`<span class="qchip-dot" aria-hidden="true"></span>`)+
        `<span class="qchip-label">${esc(p.name)}</span>`+
        `</${tag}>`;
    }).join("");
    const badges=Object.keys(QUEUE_STATUS_CATEGORY_LABEL_KEYS).filter(c=>counts[c]).map(c=>
      `<span class="queue-status-badge" style="color:${QUEUE_STATUS_CATEGORY_COLOR[c]}">${counts[c]} ${esc(queueStatusCategoryLabel(c))}</span>`
    ).join("");
    return `<div class="queue-fleet-row">`+
      `<div class="queue-fleet-name">`+
      `<div class="queue-fleet-name-row"><b title="${esc(g.pool.name)}">${esc(g.pool.name)}</b><span class="queue-mode-badge">${esc(poolTypeLabel(g.pool.type))}</span></div>`+
      `<span class="queue-fleet-count">${tn("queue.printer_count",g.printers.length)}</span>`+
      `</div>`+
      `<div class="queue-fleet-chips">${chips}</div>`+
      `<div class="queue-fleet-badges">${badges}</div>`+
      `</div>`;
  }).join("");
  const legend=Object.keys(QUEUE_STATUS_CATEGORY_LABEL_KEYS).map(c=>
    `<button type="button" class="queue-legend-btn" data-cat="${esc(c)}" aria-pressed="${QUEUE_FLEET_STATUS_FILTER.has(c)}" style="--status-color:${QUEUE_STATUS_CATEGORY_COLOR[c]}">`+
    `<span class="queue-legend-swatch"></span>${esc(queueStatusCategoryLabel(c))}</button>`
  ).join("");
  return `<div class="fl" style="margin:16px 0 8px">${t("queue.fleet_status_title")}</div>`+
    `<div class="setcard">${rows}<div class="queue-legend">${legend}</div></div>`;
}

function renderQueueDashboard(){
  const warnBox=$("queueViewStoreWarning");
  const s=QUEUE_STORE_STATUS;
  if(s.queueStoreRecoveryRequired||s.storeDegraded||s.storeStoppedByAdmin){
    warnBox.style.display="";
    warnBox.textContent = s.queueStoreRecoveryRequired ? t("queue.dashboard_warning_recovery_required") :
      s.storeDegraded ? t("queue.dashboard_warning_degraded") :
      t("queue.dashboard_warning_stopped_by_admin");
  } else { warnBox.style.display="none"; }

  // Sticky header values are updated in place (textContent only) rather than
  // rebuilt via innerHTML, so this 5s data refresh never disturbs the
  // separately-ticking 1s clock in the same header.
  const stats=computeQueueStats();
  $("statPrinting").textContent=stats.counts.printing||0;
  $("statIdle").textContent=stats.counts.idle||0;
  $("statAwaiting").textContent=stats.counts.awaiting||0;
  $("statPartsToday").textContent=stats.partsToday;
  $("queueUtilPct").textContent=(stats.total?Math.round(stats.active/stats.total*100):0)+"%";
  $("queueUtilFrac").textContent="("+stats.active+"/"+stats.total+")";

  const body=$("queueDashboardBody");
  const pools=PRINTER_POOLS.map(pool=>({ pool, printers: PRINTERS_CFG.filter(p=>p.printerPoolId===pool.id) })).filter(g=>g.printers.length);
  // Unassigned (isDefault) is where printers land by default, not a real
  // queue group anyone set up — always shown last, after every actual
  // Printer Pool, regardless of its position in the underlying config.
  pools.sort((a,b)=>(!!a.pool.isDefault)-(!!b.pool.isDefault));
  if(!pools.length){
    body.innerHTML=`<div class="settings-help" style="padding:20px">${t("queue.no_pools_assigned")}</div>`;
    return;
  }
  body.innerHTML=
    renderActiveProjectsSection(pools)+
    renderFleetStatusSection(pools)+
    `<div class="fl" style="margin:16px 0 8px">${t("queue.printers_title")}</div>`+
    pools.map(g=>`<div class="qgroup">`+renderQueueGroup(g.pool,g.printers)+`</div>`).join("");

  wireQueueRows(body);
}

// ---- Per-printer queue rows ----
// A different, narrower categorization than printerQueueCategory() (used by
// Fleet Status above): this component has no separate "Stopped" row state —
// queueStopped only affects the Pause/Resume button label inside the
// expanded panel — and adds "attention" as its own state, since a queue
// failure needing resolution is materially different from "waiting for a
// bed clear" and deserves its own treatment, not to be folded into either.
const QUEUE_ROW_STATE_COLOR={offline:"var(--bad)", attention:"var(--bad)", blocked:"var(--signal)", printing:"var(--busy)", idle:"var(--idle)"};
function queueRowCategory(qs, fleetRow){
  if(!fleetRow||!fleetRow.online) return "offline";
  if(qs&&qs.queueState==="queue_attention_required") return "attention";
  if(qs&&qs.queueState==="awaiting_bed_clear") return "blocked";
  if((fleetRow&&fleetRow.state==="printing")||(qs&&["dispatching","printing","bed_clear_running"].includes(qs.queueState))) return "printing";
  return "idle";
}
// n is 0-based position within qs.queue AFTER the "Next" one (n=0 -> "3rd",
// n=1 -> "4th", ...) — kept separate from the "+N" queue-depth badge so a
// row's position label is never confused with how many are behind it.
// English's st/nd/rd/th suffix rules don't apply in Spanish (ordinals there
// are formed with a trailing "º" regardless of the number) — reads the
// currently active locale at call time, same as every t()/tn() call, so
// this stays correct on a live language switch without its own refresh path.
function ordinalTag(n){
  const pos=n+3;
  if(i18nCurrentLocale()!=="en"){ return pos+"º"; }
  const mod100=pos%100;
  const suf=(mod100>=11&&mod100<=13)?"th":({1:"st",2:"nd",3:"rd"}[pos%10]||"th");
  return pos+suf;
}
// Client-side only — first tick a printer is seen offline, remember when.
// No server-side tracking exists for this; resets the moment it's back online.
const QUEUE_OFFLINE_SINCE=new Map();
function offlineSinceLabel(printerId, online){
  if(online){ QUEUE_OFFLINE_SINCE.delete(printerId); return t("printer_status.offline"); }
  if(!QUEUE_OFFLINE_SINCE.has(printerId)) QUEUE_OFFLINE_SINCE.set(printerId, Date.now());
  // toLocaleTimeString() renders in the browser's own locale, independent of
  // SnapCon's app-level i18n language — out of scope per the master spec's
  // date/number-localization exclusion.
  return t("queue.offline_since",{time:new Date(QUEUE_OFFLINE_SINCE.get(printerId)).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})});
}

let QUEUE_EXPANDED_ROWS=new Set(); // printerId -> expanded, survives re-renders (renderQueueDashboard() rebuilds innerHTML every 5s)

function renderQueueGroup(pool, printers){
  const catByP={};
  printers.forEach(p=>{ catByP[p.id]=queueRowCategory(QUEUE_VIEW_DATA[p.id], fleetRowForPrinterId(p.id)); });
  const counts={printing:0, waiting:0, idle:0};
  let totalJobs=0;
  printers.forEach(p=>{
    const cat=catByP[p.id];
    if(cat==="printing") counts.printing++;
    else if(cat==="blocked"||cat==="attention") counts.waiting++;
    else counts.idle++; // idle + offline folded together for this one summary line only
    const qs=QUEUE_VIEW_DATA[p.id];
    if(qs) totalJobs += (qs.currentItem?1:0)+((qs.queue&&qs.queue.length)||0);
  });
  const allExpanded=printers.length>0 && printers.every(p=>QUEUE_EXPANDED_ROWS.has(p.id));
  // The Unassigned pool isn't a pool anyone opted into queue orchestration
  // for — no Auto-balance or Pause All Queues, mirroring the same omission
  // of Pause/Stop on its individual rows below.
  return `<div class="qgroup-header">`+
    `<div class="qgroup-title"><span class="qgroup-name">${esc(pool.name)}</span><span class="queue-mode-badge">${esc(poolTypeLabel(pool.type))}</span></div>`+
    `<div class="qgroup-summary">${esc(t("queue.group_summary",{printing:counts.printing,waiting:counts.waiting,idle:counts.idle}))} · ${esc(tn("queue.jobs_queued",totalJobs))}</div>`+
    `<div class="qgroup-actions">`+
    (pool.isDefault?"":switchHtml("autobalance-"+pool.id, !!pool.autoBalance, t("queue.auto_balance_label"), null, false, "queue.auto_balance_label"))+
    `<button type="button" class="btn ghost qexpand-all" data-pool="${esc(pool.id)}">${allExpanded?t("queue.collapse_all"):t("queue.expand_all")}</button>`+
    (pool.isDefault?"":`<button type="button" class="btn ghost queue-pause-all" data-pool="${esc(pool.id)}">${t("queue.pause_all_queues_button")}</button>`)+
    `</div></div>`+
    printers.map(p=>renderQueueRow(p, QUEUE_VIEW_DATA[p.id], fleetRowForPrinterId(p.id), catByP[p.id])).join("");
}

function renderQueueRow(p, qs, fleetRow, cat){
  const color=QUEUE_ROW_STATE_COLOR[cat];
  const expanded=QUEUE_EXPANDED_ROWS.has(p.id);
  const queueLen=(qs&&qs.queue&&qs.queue.length)||0;
  const hasExpandable=cat!=="idle"||queueLen>0;
  let fillPct=0, jobHtml, pctHtml="<span></span>", etaHtml="<span></span>";

  if(cat==="printing"){
    const full=qs&&qs.currentItem?qs.currentItem.file.name:((fleetRow&&fleetRow.filename)||"");
    const name=stripExt(full)||"—";
    fillPct=(fleetRow&&typeof fleetRow.progress==="number")?Math.round(fleetRow.progress*100):0;
    const outsideNote=(qs&&qs.currentItem)?"":` <span class="pi-lbl">${t("queue.started_outside_queue")}</span>`;
    jobHtml=`<b title="${esc(full)}">${esc(name)}</b>${outsideNote}`;
    pctHtml=`<span class="qc-pct">${fillPct}%</span>`;
    etaHtml=`<span class="qc-eta">${esc(fmtRemaining(fleetRow&&fleetRow.elapsed, fleetRow&&fleetRow.progress, fleetRow&&fleetRow.remaining))}</span>`;
  } else if(cat==="blocked"){
    jobHtml=`${t("queue.waiting_for_bed_clear")} <button type="button" class="btn primary qbedclear-btn queue-confirm-bedclear" data-printer="${esc(p.id)}">${t("queue.bed_clear_print_next_button")}</button>`;
  } else if(cat==="attention"){
    const reason=attentionReasonLabel(qs&&qs.attentionReason);
    const msg=(qs&&qs.attentionDetail&&qs.attentionDetail.message)||reason;
    jobHtml=`<span title="${esc(msg)}">${esc(t("queue.needs_attention",{reason}))}</span>`;
  } else if(cat==="offline"){
    jobHtml=esc(offlineSinceLabel(p.id, false));
  } else { // idle
    if(queueLen>0) jobHtml=esc(qs&&qs.queueStopped?tn("queue.idle_with_queue_stopped",queueLen,{count:queueLen}):tn("queue.idle_with_queue",queueLen,{count:queueLen}));
    else jobHtml=esc(t("queue.idle_empty"));
    if(fleetRow&&fleetRow.online) QUEUE_OFFLINE_SINCE.delete(p.id);
  }

  const badgeHtml=queueLen>0?`<span class="qc-badge">+${queueLen}</span>`:`<span></span>`;
  const chevronHtml=hasExpandable?`<span class="qc-chevron">▶</span>`:`<span></span>`;

  const expandAttrs=hasExpandable?` tabindex="0" role="button" aria-expanded="${expanded}"`:"";
  return `<div class="qrow ${cat}${expanded?" expanded":""}" data-printer="${esc(p.id)}"${hasExpandable?"":" data-noexpand"}${expandAttrs} style="--status-color:${color}">`+
    (cat==="printing"?`<div class="qrow-fill" style="width:${fillPct}%"></div>`:"")+
    `<span class="qc-dot" aria-hidden="true"></span>`+
    `<span class="qc-name" title="${esc(p.name)}">${esc(p.name)}</span>`+
    `<span class="qc-job">${jobHtml}</span>`+
    pctHtml+etaHtml+badgeHtml+chevronHtml+
    `<span class="qc-menu"><button type="button" class="qc-menu-btn" title="More" data-i18n-title="queue.more_title" data-printer-menu="${esc(p.id)}">⋮</button></span>`+
    `</div>`+
    (expanded&&hasExpandable?renderQueueExpandedPanel(p, qs, cat):"");
}

function renderQueueExpandedPanel(p, qs, cat){
  const items=[];
  if(cat==="printing"){
    const full=qs&&qs.currentItem?qs.currentItem.file.name:"";
    const fleetRow=fleetRowForPrinterId(p.id);
    items.push({ tag:t("queue.tag_printing_now"), now:true,
      name:full?stripExt(full):stripExt((fleetRow&&fleetRow.filename)||"")||"—", full:full||(fleetRow&&fleetRow.filename)||"",
      pct:(fleetRow&&typeof fleetRow.progress==="number")?Math.round(fleetRow.progress*100)+"%":"",
      eta:fmtRemaining(fleetRow&&fleetRow.elapsed, fleetRow&&fleetRow.progress, fleetRow&&fleetRow.remaining) });
  } else if(cat==="blocked"){
    items.push({ tag:t("queue.tag_blocked"), now:true, name:t("queue.waiting_for_bed_clear"), full:"" });
  } else if(cat==="attention"){
    const reasonRaw=qs&&qs.attentionReason;
    const reason=attentionReasonLabel(reasonRaw);
    // recovery-mismatch is the one attentionDetail whose message is built by
    // string-concatenating a raw filename server-side (see
    // queue/QueueEngine.js) — the one deterministic, single-call-site case
    // worth a translated template; every other reason's message mixes in
    // unpredictable raw connector text and stays an opaque fallback.
    const full=(reasonRaw==="recovery-mismatch" && qs.attentionDetail && qs.attentionDetail.filename)
      ? t("queue.attention_detail_recovery_mismatch",{filename:qs.attentionDetail.filename})
      : (qs&&qs.attentionDetail&&qs.attentionDetail.message)||"";
    items.push({ tag:t("queue.tag_attention"), now:true, name:reason, full });
  }
  (qs&&qs.queue||[]).forEach((it,i)=>{
    items.push({ tag:i===0?t("queue.tag_next"):ordinalTag(i-1), name:stripExt(it.file.name), full:it.file.name, itemId:it.id });
  });

  const rows=items.map(it=>
    `<div class="qitem${it.now?" now":""}">`+
    `<span></span>`+
    `<span class="qc-name qitem-tag">${esc(it.tag)}</span>`+
    `<span class="qc-job"><b title="${esc(it.full)}">${esc(it.name)}</b></span>`+
    `<span class="qc-pct">${esc(it.pct||"")}</span>`+
    `<span class="qc-eta">${esc(it.eta||(it.itemId?"—":""))}</span>`+
    `<span></span><span></span>`+
    `<span class="qc-menu">${it.itemId?`<button type="button" class="qitem-remove queue-remove-item" data-printer="${esc(p.id)}" data-item="${esc(it.itemId)}" title="Remove" data-i18n-title="common.remove">×</button>`:""}</span>`+
    `</div>`
  ).join("")||`<div class="settings-help" style="padding:4px 0">${t("queue.nothing_queued")}</div>`;

  // Clear Queue is the actual "abort everything" action — it cancels
  // whatever's physically printing (if anything) and wipes the rest of the
  // queue in one step. Offered anywhere there's something to abort: mid
  // attention-resolution too, as a "give up on all of it" escape hatch
  // rather than resolving one blocked item at a time.
  const hasWorkToClear=!!((qs&&qs.currentItem)||(qs&&qs.queue&&qs.queue.length));
  const clearBtn=hasWorkToClear?`<button type="button" class="btn ghost danger queue-clear" data-printer="${esc(p.id)}">${t("queue.clear_queue_button")}</button>`:"";
  // The Unassigned pool (isDefault) is where printers land by default, not a
  // pool anyone opted into queue orchestration for — Pause/Resume/Stop only
  // make sense once dispatch is actually being automated.
  const pool=PRINTER_POOLS.find(x=>x.id===p.printerPoolId);
  const isUnmanaged=!!(pool&&pool.isDefault);

  let actionsHtml;
  if(cat==="attention"){
    const actions=QUEUE_ATTENTION_RESOLUTIONS[(qs&&qs.attentionReason)]||["stop"];
    actionsHtml=actions.map(action=>`<button type="button" class="btn ghost queue-resolve" data-printer="${esc(p.id)}" data-action="${esc(action)}">${esc(queueActionLabel(action))}</button>`).join("")+clearBtn;
  } else {
    // Cancel Print is deliberately separate from Stop Queue — Stop only
    // prevents the NEXT item from auto-dispatching (the current print, if
    // any, keeps running), it never touches what's on the printer right
    // now. Cancel Print is the only control here that does; it's the same
    // /api/printctl action the printer's own Fleet card exposes, wired in
    // here too since there was previously no way to reach it from the
    // Queue view at all.
    const cancelBtn=cat==="printing"?`<button type="button" class="btn ghost danger queue-cancel-print" data-printer="${esc(p.id)}">${t("queue.cancel_print_button")}</button>`:"";
    const pauseStopHtml=isUnmanaged?"":(qs&&(qs.queueStopped||qs.queuePaused)
      ? `<button type="button" class="btn ghost queue-resume" data-printer="${esc(p.id)}">${t("queue.resume_queue_button")}</button>`
      : `<button type="button" class="btn ghost queue-pause" data-printer="${esc(p.id)}">${t("queue.pause_queue_button")}</button>`)+
      `<button type="button" class="btn danger queue-stop" data-printer="${esc(p.id)}">${queueActionLabel("stop")}</button>`;
    actionsHtml=cancelBtn+pauseStopHtml+clearBtn;
  }

  return `<div class="qexpand"><div class="qexpand-actions">${actionsHtml}</div>${rows}</div>`;
}

function wireQueueRows(root){
  root.querySelectorAll(".queue-legend-btn").forEach(btn=>btn.addEventListener("click", ()=>{
    const cat=btn.dataset.cat;
    if(QUEUE_FLEET_STATUS_FILTER.has(cat)) QUEUE_FLEET_STATUS_FILTER.delete(cat); else QUEUE_FLEET_STATUS_FILTER.add(cat);
    renderQueueDashboard();
  }));
  root.querySelectorAll(".qrow[data-printer]:not([data-noexpand])").forEach(row=>{
    const toggle=()=>{
      const pid=row.dataset.printer;
      if(QUEUE_EXPANDED_ROWS.has(pid)) QUEUE_EXPANDED_ROWS.delete(pid); else QUEUE_EXPANDED_ROWS.add(pid);
      renderQueueDashboard();
    };
    row.addEventListener("click", e=>{
      if(e.target.closest("button")) return;
      toggle();
    });
    row.addEventListener("keydown", e=>{
      if((e.key==="Enter"||e.key===" ") && !e.target.closest("button")){ e.preventDefault(); toggle(); }
    });
  });
  root.querySelectorAll('input[id^="autobalance-"]').forEach(input=>{
    input.addEventListener("change", async e=>{
      e.stopPropagation();
      const poolId=input.id.slice("autobalance-".length);
      const checked=input.checked;
      try{
        const r=checkAuthFailure(await fetch("/api/printer-pools/"+poolId,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({autoBalance:checked})}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
        const cached=PRINTER_POOLS.find(p=>p.id===poolId); if(cached) cached.autoBalance=checked;
      }catch(err){ alert(err.message); input.checked=!checked; }
    });
  });
  root.querySelectorAll(".qexpand-all").forEach(btn=>btn.addEventListener("click", e=>{
    e.stopPropagation();
    const poolPrinters=PRINTERS_CFG.filter(p=>p.printerPoolId===btn.dataset.pool);
    const allExpanded=poolPrinters.length>0 && poolPrinters.every(p=>QUEUE_EXPANDED_ROWS.has(p.id));
    poolPrinters.forEach(p=>{ if(allExpanded) QUEUE_EXPANDED_ROWS.delete(p.id); else QUEUE_EXPANDED_ROWS.add(p.id); });
    renderQueueDashboard();
  }));
  root.querySelectorAll(".queue-pause-all").forEach(btn=>btn.addEventListener("click", async e=>{
    e.stopPropagation();
    const printers=PRINTERS_CFG.filter(p=>p.printerPoolId===btn.dataset.pool);
    await Promise.allSettled(printers.map(p=>postJSON("/api/queue/"+p.id+"/pause",{})));
    refreshQueueDashboard();
  }));
  const simple=async(printerId,action)=>{ try{ await postJSON("/api/queue/"+printerId+"/"+action,{}); refreshQueueDashboard(); }catch(e){ alert(e.message); } };
  root.querySelectorAll(".qchip-actionable").forEach(b=>b.addEventListener("click", async e=>{
    e.stopPropagation();
    const cat=b.dataset.cat;
    if(cat==="stopped"||cat==="paused"){ simple(b.dataset.printer,"resume"); return; }
    if(cat==="error"){
      if(!confirm(t("queue.release_error_confirm"))) return;
      // Hardware error is a Fleet-card-level concern, not a queue one —
      // /api/printctl (the same eject action the Fleet card's own Eject
      // button uses) addresses printers by array index, not persistent id.
      const idx=PRINTERS_CFG.findIndex(x=>x.id===b.dataset.printer);
      if(idx<0){ alert(t("settings.printers.pool_error_unknown_printer")); return; }
      try{
        const r=checkAuthFailure(await postJSON("/api/printctl",{printer:idx,action:"eject"}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
        refreshQueueDashboard();
      }catch(err){ alert(err.message); }
    }
  }));
  root.querySelectorAll(".queue-pause").forEach(b=>b.addEventListener("click", e=>{ e.stopPropagation(); simple(b.dataset.printer,"pause"); }));
  root.querySelectorAll(".queue-resume").forEach(b=>b.addEventListener("click", e=>{ e.stopPropagation(); simple(b.dataset.printer,"resume"); }));
  root.querySelectorAll(".queue-stop").forEach(b=>b.addEventListener("click", e=>{
    e.stopPropagation();
    if(confirm(t("queue.stop_queue_confirm"))) simple(b.dataset.printer,"stop");
  }));
  root.querySelectorAll(".queue-clear").forEach(b=>b.addEventListener("click", e=>{
    e.stopPropagation();
    if(confirm(t("queue.clear_queue_confirm"))) simple(b.dataset.printer,"clear");
  }));
  root.querySelectorAll(".queue-confirm-bedclear").forEach(b=>b.addEventListener("click", e=>{ e.stopPropagation(); simple(b.dataset.printer,"confirm-bed-clear"); }));
  root.querySelectorAll(".queue-cancel-print").forEach(b=>b.addEventListener("click", async e=>{
    e.stopPropagation();
    if(!confirm(t("queue.cancel_print_confirm"))) return;
    // /api/printctl (the same action the printer's own Fleet card cancel
    // button uses) addresses printers by array index, not persistent id —
    // a legacy convention predating Queue Management's id-based routes.
    const idx=PRINTERS_CFG.findIndex(x=>x.id===b.dataset.printer);
    if(idx<0){ alert(t("settings.printers.pool_error_unknown_printer")); return; }
    try{
      const r=checkAuthFailure(await postJSON("/api/printctl",{printer:idx,action:"cancel"}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
      refreshQueueDashboard();
    }catch(e){ alert(e.message); }
  }));
  root.querySelectorAll(".queue-remove-item").forEach(b=>b.addEventListener("click", async e=>{
    e.stopPropagation();
    try{ const r=checkAuthFailure(await fetch("/api/queue/"+b.dataset.printer+"/items/"+b.dataset.item,{method:"DELETE"})); const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status))); refreshQueueDashboard(); }
    catch(e){ alert(e.message); }
  }));
  root.querySelectorAll(".queue-resolve").forEach(b=>b.addEventListener("click", async e=>{
    e.stopPropagation();
    try{
      const action=b.dataset.action;
      const r=checkAuthFailure(action==="accept-file-change"
        ? await fetch("/api/queue/"+b.dataset.printer+"/accept-file-change",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
        : await postJSON("/api/queue/"+b.dataset.printer+"/resolve",{action}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(queueErrorText(d,d.error||("HTTP "+r.status)));
      refreshQueueDashboard();
    }catch(e){ alert(e.message); }
  }));
}

function wireFileDrag(){
  const list=$("list");
  list.addEventListener("dragstart", e=>{
    const row=e.target.closest(".job[draggable]");
    if(!row){ e.preventDefault(); return; }
    const file=row.dataset.file;
    const files=(SELECTED_FILES.has(file)&&SELECTED_FILES.size>1) ? [...SELECTED_FILES] : [file];
    e.dataTransfer.effectAllowed="move";
    e.dataTransfer.setData("text/plain", JSON.stringify(files));
    row.classList.add("dragging");
  });
  list.addEventListener("dragend", ()=>{
    list.querySelectorAll(".job.dragging").forEach(r=>r.classList.remove("dragging"));
    list.querySelectorAll(".folder-item.drag-over").forEach(r=>r.classList.remove("drag-over"));
  });
  list.addEventListener("dragover", e=>{
    const target=e.target.closest(".folder-item");
    if(!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect="move";
    list.querySelectorAll(".folder-item.drag-over").forEach(t=>{ if(t!==target) t.classList.remove("drag-over"); });
    target.classList.add("drag-over");
  });
  list.addEventListener("drop", e=>{
    const target=e.target.closest(".folder-item");
    list.querySelectorAll(".folder-item.drag-over").forEach(t=>t.classList.remove("drag-over"));
    if(!target) return;
    e.preventDefault();
    let files;
    try{ files=JSON.parse(e.dataTransfer.getData("text/plain")); }catch{ return; }
    if(Array.isArray(files)&&files.length) moveFilesTo(files, target.dataset.folder);
  });
}
async function moveFilesTo(filePaths, targetSub){
  const files=filePaths.map(fp=>{
    const i=fp.lastIndexOf("/");
    return i===-1 ? {sub:"",name:fp} : {sub:fp.slice(0,i),name:fp.slice(i+1)};
  });
  const st=$("fileOpStatus");
  delete st.dataset.moveSuccess;
  try{
    const r=await postJSON("/api/files/move",{files,targetSub});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    const failed=(d.results||[]).filter(x=>!x.ok);
    if(failed.length){
      st.className="pstatus err";
      st.textContent=t("files.move_error",{names:failed.map(x=>x.name+" ("+x.error+")").join(", ")});
    } else {
      st.className="pstatus ok";
      st.textContent=tn("files.move_success",files.length);
      // Locale-independent flag, same fix as uploadLocalFiles()'s
      // st.dataset.uploadComplete — a comparison against the displayed
      // (translatable) text would silently stop clearing the status in any
      // non-English locale.
      st.dataset.moveSuccess="1";
      setTimeout(()=>{ if(st.dataset.moveSuccess==="1"){ st.textContent=""; delete st.dataset.moveSuccess; } },3000);
    }
  }catch(e){ st.className="pstatus err"; st.textContent=t("files.move_failed",{message:e.message}); }
  SELECTED_FILES.clear(); SELECT_ANCHOR=null;
  updateMultiSelectUI();
  loadFiles(CURRENT_SUB);
}

function openNewFolderModal(){
  $("newFolderModalInput").value="";
  $("newFolderModalStatus").textContent="";
  $("newFolderModal").classList.add("show");
  setTimeout(()=>$("newFolderModalInput").focus(),100);
}
function closeNewFolderModal(){ $("newFolderModal").classList.remove("show"); }
async function doCreateFolder(){
  const name=$("newFolderModalInput").value.trim();
  const st=$("newFolderModalStatus");
  if(!name){ st.className="pstatus err"; st.textContent=t("files.error_enter_folder_name"); return; }
  const btn=$("newFolderModalCreate"); btn.disabled=true;
  st.className="pstatus work"; st.textContent=t("files.status_creating");
  try{
    const r=await postJSON("/api/files/mkdir",{sub:CURRENT_SUB,name});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    closeNewFolderModal();
    loadFiles(CURRENT_SUB);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}

async function uploadLocalFiles(fileList){
  const files=[...fileList];
  if(!files.length) return;
  const st=$("fileOpStatus");
  // A stable, locale-independent flag rather than comparing st.textContent
  // against an English literal to decide whether the delayed clear below is
  // still valid — the old comparison would have silently stopped clearing
  // the status once "Upload complete" was translated. Reset at the start of
  // every call so an overlapping second upload can't have its own fresh
  // status wiped by a stale timeout from the first.
  delete st.dataset.uploadComplete;
  for(let i=0;i<files.length;i++){
    const f=files[i];
    st.className="pstatus work"; st.textContent=t("files.uploading_status",{name:f.name,current:i+1,total:files.length});
    try{
      const r=await fetch("/api/files/upload?sub="+encodeURIComponent(CURRENT_SUB)+"&name="+encodeURIComponent(f.name), {
        method:"POST", headers:{"Content-Type":"application/octet-stream"}, body:f
      });
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    }catch(e){
      st.className="pstatus err"; st.textContent=t("files.upload_error",{name:f.name,message:e.message});
      await new Promise(res=>setTimeout(res,1500));
    }
  }
  st.className="pstatus ok"; st.textContent=t("files.upload_complete");
  st.dataset.uploadComplete="1";
  setTimeout(()=>{ if(st.dataset.uploadComplete==="1"){ st.textContent=""; delete st.dataset.uploadComplete; } },3000);
  loadFiles(CURRENT_SUB);
}

async function selectFile(name){
  SELECTED=name; MAPSEL={}; renderList();
  // Orca mode hides this section permanently (init() sets it inline) — don't
  // fight that override here.
  if(!URL_PRINTER_FILTER) $("jobsechead").style.display="";
  $("jlname").textContent=t("files.opening_status",{name});
  $("jobloading").classList.add("show");
  $("jobcard").classList.remove("show");
  try{ const m=await getJSON("/api/map?file="+encodeURIComponent(name));
    $("jobloading").classList.remove("show");
    if(m.error){ MAP=null; if(!URL_PRINTER_FILTER) $("jobsechead").style.display="none"; return; }
    MAP=m; renderJob(); renderList(); renderFleet();
  }catch(e){ $("jobloading").classList.remove("show"); if(!URL_PRINTER_FILTER) $("jobsechead").style.display="none"; }
}

function neededColors(){ return MAP ? MAP.palette.filter(s=>s.used) : []; }
// Same as neededColors(), but a single-material file (empty palette) still
// needs a slot picked to feed it from — falls back to one unnamed slot
// standing in for the whole file instead of hiding the picker entirely.
function neededColorsOrSlot(){ const need=neededColors(); return need.length?need:[{i:0,hex:null,type:'',wt:''}]; }

// Maps a file's raw slicer-reported metadata to the connector brand it was
// actually sliced for, reusing CONNECTOR_TYPES (already loaded for the
// Settings > Printers connector picker) rather than a hardcoded brand list
// — a new connector's brand is picked up automatically, no change needed
// here.
//
// printerSettingsId (OrcaSlicer-family "Vendor@Model" system-preset id,
// e.g. "Creality@K1") is checked FIRST and preferred when it matches,
// since it explicitly names the vendor — printer_model can instead just
// describe the interface/profile chosen (e.g. "Generic Klipper Printer":
// Klipper is the protocol several different brands speak, not a brand
// itself), which is a weaker, easily-misleading signal on its own. Confirmed
// on a real file: printer_model said "Generic Klipper Printer" while
// printer_settings_id said "Creality@K1" for the same Creality-sliced file.
//
// Returns: null when the file has neither field (nothing to detect); false
// when it has at least one but neither matches any registered connector's
// brand; otherwise the matched brand string, in the same casing FLEET
// printers' own p.brand field uses (see isCompatiblePrinter).
function detectPrinterBrand(printerModel, printerSettingsId){
  if(!printerModel&&!printerSettingsId) return null;
  const brands=[...new Set(CONNECTOR_TYPES.map(c=>c.brand).filter(Boolean))];
  if(printerSettingsId){
    const vendor=String(printerSettingsId).split("@")[0].toLowerCase();
    const hit=brands.find(b=>vendor.includes(b.toLowerCase()));
    if(hit) return hit;
  }
  if(printerModel){
    const text=printerModel.toLowerCase();
    const hit=brands.find(b=>text.includes(b.toLowerCase()));
    if(hit) return hit;
  }
  return false;
}

// Send-to-printers compatibility: true/false only when both the file's
// detected brand and this printer's own recorded brand (set from the
// connector at add-printer time — see the brandEl.value assignment in the
// printer-add form) are actually known; null ("can't tell") for a
// not-detected/unmatched file brand or a printer with no recorded brand —
// deliberately never flagged incompatible on missing information, only on
// a genuine, known mismatch.
function isCompatiblePrinter(detectedBrand, printerBrand){
  if(!detectedBrand || !printerBrand) return null;
  // A generic-Klipper printer can carry a user-typed brand ("Voron"), which
  // detectPrinterBrand() can never return — it only ever matches registered
  // connector brands. Comparing the two would report a mismatch for every
  // detectable file, so an unrecognized brand is "can't tell" instead, the
  // same as a missing one above.
  if(!isKnownConnectorBrand(printerBrand)) return null;
  return detectedBrand===printerBrand;
}

function renderJob(){
  $("jobcard").classList.add("show");
  const fsFork=MAP.fsFork||t("fleet.job.fs_fork_fallback");
  $("jt").innerHTML=esc(stripExt(SELECTED))+(MAP.isFS?` <img src="/fs-badge.svg" class="fs-badge" title="${esc(t("fleet.job.full_spectrum_title",{fork:fsFork}))}">`:``);
  // meta line: time · weight · cost
  const totalGrams=MAP.palette.reduce((sum,s)=>sum+(parseFloat(s.wt)||0),0);
  const timeHours=parseTimeToHours((MAP.meta||[])[0]);
  const fCost=(FILAMENT_COST>0&&totalGrams>0)?(FILAMENT_COST/1000)*totalGrams:0;
  const eCost=(ELECTRICITY_RATE>0&&timeHours>0)?ELECTRICITY_RATE*timeHours:0;
  const totalCost=fCost+eCost;
  const metaParts=[...(MAP.meta||[])];
  if(totalCost>0) metaParts.push("$"+totalCost.toFixed(2));
  $("jmeta").textContent=metaParts.join("  ·  ");
  // detected printer brand — MAP.printerModel is raw slicer-reported data;
  // detectPrinterBrand() maps it to one of SnapCon's own connector brands
  // (or "Unknown"), which is what's actually displayed, untranslated
  // Creality/SnapMaker/FlashForge proper nouns aside.
  const compat=$("jcompat");
  const detectedBrand=detectPrinterBrand(MAP.printerModel,MAP.printerSettingsId);
  if(detectedBrand!==null){
    compat.style.display=""; compat.textContent=t("fleet.job.detected_printer",{brand:detectedBrand||t("fleet.job.brand_unknown")});
  } else { compat.style.display="none"; }
  // thumbnail
  const thumb=$("jthumb");
  thumb.style.display="none";
  thumb.onerror=()=>{ thumb.style.display="none"; };
  thumb.onload=()=>{ thumb.style.display="block"; };
  thumb.src="/api/local-thumbnail?file="+encodeURIComponent(SELECTED);
  if(thumb.complete && thumb.naturalWidth>0) thumb.style.display="block";
  const need=neededColors();
  $("needcount").textContent=tn("fleet.job.needed_colors",need.length);
  const strip=$("needstrip"); strip.innerHTML="";
  need.forEach(s=>{ const d=document.createElement("div"); d.className="need";
    d.innerHTML=`<span class="sw" style="background:${esc(s.hex||'#3a3f49')}"></span><span>${esc(s.type||'PLA')}</span><span class="nx">T${s.i+1}${s.wt?` · ${Math.ceil(parseFloat(s.wt))} g`:''}</span>`;
    strip.appendChild(d); });
  const over=need.length>(MAP.physicalHeads||4) && !MAP.isFS;
  $("nohint").innerHTML = t("fleet.job.uses_colors_prefix",{n:need.length,total:MAP.paletteCount},{html:true})+" "+
    (MAP.isFS
        ?t("fleet.job.hint_full_spectrum",{fork:fsFork},{html:true})
        :over?t("fleet.job.hint_over_toolheads",null,{html:true})
        :t("fleet.job.hint_confirm_mapping"));
  const warn=$("warn");
  if(MAP.noColors){ warn.classList.add("show"); warn.textContent=t("fleet.job.no_colors_warning"); } else warn.classList.remove("show");
}

function parseTimeToHours(s){
  if(!s) return 0;
  let h=0;
  const d=s.match(/(\d+)\s*d/i); if(d) h+=parseInt(d[1])*24;
  const hr=s.match(/(\d+)\s*h/i); if(hr) h+=parseInt(hr[1]);
  const m=s.match(/(\d+)\s*m(?!s)/i); if(m) h+=parseInt(m[1])/60;
  const sc=s.match(/(\d+)\s*s/i); if(sc) h+=parseInt(sc[1])/3600;
  return h;
}
// Shared duration formatter — elapsed/remaining/job-duration displays all
// route through this. Seconds are dropped once the total reaches an hour
// (false precision on a long estimate) but kept below that, since they
// matter on a short print.
function fmtDuration(s){
  if(s==null)return'—';
  s=Math.max(0,Math.round(s));
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  if(h)return h+'h '+String(m).padStart(2,'0')+'m';
  if(m)return m+'m '+String(sec).padStart(2,'0')+'s';
  return sec+'s';
}
// `remaining` (seconds) is the printer's own estimate, for connectors that
// report one (Bambu Lab). It wins over the elapsed/progress extrapolation,
// which on such a printer would rest on a whole-percent progress value.
// Omitted or null for every other connector, which keeps today's behavior.
function fmtRemaining(elapsed,progress,remaining){if(typeof remaining==='number'&&isFinite(remaining))return fmtDuration(Math.max(0,remaining));if(!elapsed||!progress||progress<=0)return'—';const total=elapsed/progress;const rem=Math.max(0,total-elapsed);return fmtDuration(rem);}

// Klipper's current_layer only advances when a NEW layer's gcode starts, so
// the final layer of a print never triggers a "next layer" bump — it stays
// one behind total_layer forever, even once the print is 100% done. Once we
// know the print is complete every layer is done by definition, so show
// total/total instead of the firmware's permanently-stuck N-1/total.
function layerDisplay(p){
  if(!p.layer) return null;
  return p.state==='complete' ? { current:p.layer.total, total:p.layer.total } : p.layer;
}
function fmtFinishedTime(ts){ return ts?new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):'—'; }

// Hotend/bed mini-bar: fill represents progress from a fixed ambient
// baseline to target, so sitting exactly at target reads as full (the old
// formula measured against target+N and never actually reached 100%, even
// holding steady at target). No target set means nothing to heat toward —
// the bar stays empty rather than rendering in a color.
const HEAT_BAR_AMBIENT_C=20;
// Continuous blue -> yellow -> red across the 0-100% span, built from the
// app's existing tokens (--busy blue, --signal amber/yellow, --bad red)
// rather than new hardcoded hex — color-mix() interpolates between whichever
// pair straddles the current percentage.
function heatBarColor(pct){
  if(pct<=50) return `color-mix(in srgb, var(--signal) ${(pct/50*100).toFixed(0)}%, var(--busy))`;
  return `color-mix(in srgb, var(--bad) ${((pct-50)/50*100).toFixed(0)}%, var(--signal))`;
}
function heatBarInfo(actual,target){
  if(!target||target<=0) return { pct:0, bg:null, targetTxt:'—' };
  const span=Math.max(target-HEAT_BAR_AMBIENT_C,1);
  const pct=Math.min(100,Math.max(0,((actual-HEAT_BAR_AMBIENT_C)/span)*100));
  return { pct, bg:heatBarColor(pct), targetTxt: target+'°' };
}
// Shared by the build path (heatBarFillStyle, a style string) and the live
// path (updateFleetCardLiveValues, individual properties) so the two can
// never drift apart.
function heatBarShadow(bg){ return bg?`0 0 6px ${bg}`:""; }
function heatBarFillStyle(bar){
  return `width:${bar.pct}%`+(bar.bg?`;background:${bar.bg};box-shadow:${heatBarShadow(bar.bg)}`:'');
}

function renderSkeletonFleet(){
  if(!PRINTERS_CFG||!PRINTERS_CFG.length) return;
  const wrap=$("fleet"); wrap.innerHTML="";
  $("fleetcount").textContent=t("fleet.status.connecting_short");
  PRINTERS_CFG.forEach(p=>{
    const card=document.createElement("div"); card.className="pcard";
    card.innerHTML=
      `<div class="top">`+
      `<span class="pn"><span class="printer-icon-sm" style="opacity:.35"></span>`+
      `<span><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name">${esc(p.name||'—')}</div></span></span>`+
      `<span class="status-badge" style="--status-color:var(--idle)">${esc(t("fleet.status.connecting_badge"))}</span>`+
      `</div>`+
      `<div class="prism-line" style="opacity:.2"></div>`+
      `<div class="skel-block"><div class="skel-line"></div><div class="skel-line" style="width:42%;margin-top:7px"></div></div>`;
    wrap.appendChild(card);
  });
}

// First load only: probe printers one by one so the splash can count them in
// ("connecting to printers 03/14"). Regular polling stays one bulk request.
async function initialFleetLoad(){
  const n=PRINTERS_CFG.length;
  if(!n){ await loadFleet(); return; }
  const pad=v=>String(v).padStart(2,'0');
  const sub=$("splashsub");
  let done=0;
  if(sub) sub.textContent=t("global.splash.connecting_progress",{done:pad(0),total:pad(n)});
  FLEET=await Promise.all(PRINTERS_CFG.map((cfg,i)=>
    fetch("/api/fleet?printer="+i,{signal:AbortSignal.timeout(15000)})
      .then(r=>r.json())
      .catch(()=>({ id:i, name:cfg.name||cfg.url, brand:cfg.brand||'SnapMaker', url:cfg.url, online:false, error:'unreachable' }))
      .then(r=>{ done++; if(sub) sub.textContent=t("global.splash.connecting_progress",{done:pad(done),total:pad(n)}); return r; })
  ));
  renderFleet();
}

let FLEET_INFLIGHT=false, FLEET_PREV_BODY="";
async function loadFleet(){
  if(FLEET_INFLIGHT) return; // a slow/offline printer can outlast the poll interval — don't stack requests
  FLEET_INFLIGHT=true;
  if(!FLEET.length) renderSkeletonFleet();
  try{
    // Own timeout so a hung request can never wedge the in-flight guard shut.
    const r=await fetch("/api/fleet",{signal:AbortSignal.timeout(15000)});
    // A session that expired mid-poll (401) is not "fleet unreachable" — don't
    // let an {error:...} body get parsed into FLEET, which isn't an array.
    if(checkAuthFailure(r).status===401) return;
    const body=await r.text();
    if(body!==FLEET_PREV_BODY){ // unchanged payload → the DOM already shows this state
      FLEET_PREV_BODY=body;
      FLEET=JSON.parse(body);
      // The one call site that opts into incremental rendering — see
      // reconcileFleetCards()/cardSignature(). Every other renderFleet()
      // call site (sort/filter/view-mode/etc. changes) keeps full-rebuild
      // behavior. loadFleet() itself has many callers beyond the poll timer
      // (manual refresh, post-action refreshes, tab-visibility-regain) —
      // all of them represent "refetch from server and reconcile," so all
      // of them benefit from diffing here, not just the timer tick.
      renderFleet({ incremental: true });
      updateAllPrinterRowStatuses();
      // Firmware-tab checkboxes are gated on live printer state — a printer
      // that just started printing must stop being selectable here too.
      refreshFirmwareRowEligibility();
    }
  }
  catch(e){
    FLEET_PREV_BODY=""; // force a re-render on the next successful poll
    // Transient failure: keep the last-known cards on screen and say we're
    // retrying — only show the bare message when there is nothing to show.
    if(!FLEET.length) $("fleet").innerHTML=`<p class="subnote">${esc(t("fleet.status.unreachable"))}</p>`;
    $("fleetcount").textContent=t("fleet.status.reconnecting");
  }
  finally{ FLEET_INFLIGHT=false; }
}

// Advisory match only. "redmean" is a cheap perceptual distance — it treats
// two shades of the same color (e.g. two light blues) as close, where plain
// RGB distance wrongly calls them far apart. Tune MATCH_THRESHOLD to taste:
// lower = stricter (fewer rings), higher = looser (more rings). ~165 treats
// same-family shades as a match while keeping navy/red/yellow distinct.
const MATCH_THRESHOLD = 165;
function colorDist(a,b){
  const pa=hexRGB(a), pb=hexRGB(b); if(!pa||!pb) return 1e9;
  const rm=(pa[0]+pb[0])/2, dr=pa[0]-pb[0], dg=pa[1]-pb[1], db=pa[2]-pb[2];
  return Math.sqrt((2+rm/256)*dr*dr + 4*dg*dg + (2+(255-rm)/256)*db*db);
}
function hexRGB(h){ if(!h) return null; const m=/^#?([0-9a-f]{6})$/i.exec(h.trim()); if(!m) return null;
  const n=parseInt(m[1],16); return [(n>>16)&255,(n>>8)&255,n&255]; }

// Hungarian-style optimal assignment via brute-force enumeration.
// For max 4 colors × 4 heads this is at most 4! = 24 evaluations — trivially fast.
// Unmatched colors (fewer heads than colors) fall back to palette-index = head-index.
function defaultMapping(need, heads){
  if(!SUGGEST_MATCHING){ const map={}; need.forEach(n=>{ map[n.i]=n.i; }); return map; }
  const loaded = heads.map((h,hi)=>({hi,h})).filter(x=>x.h&&x.h.loaded);
  const n=need.length, m=loaded.length, map={};
  if(!n){ return map; }

  // Helper: all k-subsets of array
  function choose(arr,k){
    if(k===0) return [[]];
    if(arr.length<k) return [];
    const [h,...t]=arr;
    return [...choose(t,k-1).map(c=>[h,...c]),...choose(t,k)];
  }
  // Helper: all permutations of array
  function perms(arr){
    if(!arr.length) return [[]];
    return arr.flatMap((x,i)=>perms([...arr.slice(0,i),...arr.slice(i+1)]).map(p=>[x,...p]));
  }

  const k=Math.min(n,m);
  const cIdxs=Array.from({length:n},(_,i)=>i); // indices into need[]
  const hIdxs=Array.from({length:m},(_,j)=>j); // indices into loaded[]

  // Cost of pairing need[ci] with loaded[hj]
  const cost=(ci,hj)=>{
    const {hex:nh}=need[ci], {h}=loaded[hj];
    return (nh&&h.hex)?colorDist(nh,h.hex):1e9;
  };

  let bestTotal=Infinity, bestCs=null, bestHp=null;
  for(const cs of choose(cIdxs,k)){
    for(const hs of choose(hIdxs,k)){
      for(const hp of perms(hs)){
        const total=cs.reduce((s,ci,idx)=>s+cost(ci,hp[idx]),0);
        if(total<bestTotal){ bestTotal=total; bestCs=cs; bestHp=hp; }
      }
    }
  }

  const matched=new Set();
  if(bestCs){
    bestCs.forEach((ci,idx)=>{ map[need[ci].i]=loaded[bestHp[idx]].hi; matched.add(ci); });
  }
  // Fallback: unmatched gcode color → extruder at same index (P1→H1, P2→H2, …)
  need.forEach((nc,ni)=>{ if(!matched.has(ni)) map[nc.i]=nc.i; });
  return map;
}

function spoolSvg(color,active,uid){
  return `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 60 60" class="spool${active?' is-active':''}" style="--spool-glow:${color}cc">
  <defs>
    <linearGradient id="frame-${uid}" x1="10" y1="6" x2="50" y2="54" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#333B4E"/><stop offset="1" stop-color="#12151C"/>
    </linearGradient>
    <radialGradient id="hub-${uid}" cx="0.35" cy="0.32" r="0.85">
      <stop offset="0" stop-color="#3A4356"/><stop offset="1" stop-color="#1A1F29"/>
    </radialGradient>
  </defs>
  <circle cx="30" cy="30" r="27" fill="url(#frame-${uid})"/>
  <path d="M30 6.5 A23.5 23.5 0 1 1 29.99 6.5 Z M30 16.5 A13.5 13.5 0 1 0 30.01 16.5 Z" fill="${color}" fill-rule="evenodd"/>
  <g stroke="#161A22" stroke-width="4.5" stroke-linecap="butt">
    <line x1="30" y1="17" x2="30" y2="43" transform="rotate(0 30 30)"/>
    <line x1="30" y1="17" x2="30" y2="43" transform="rotate(60 30 30)"/>
    <line x1="30" y1="17" x2="30" y2="43" transform="rotate(120 30 30)"/>
  </g>
  <circle cx="30" cy="30" r="9" fill="url(#hub-${uid})"/>
  <circle cx="30" cy="30" r="4" fill="#0B0D12"/>
  <path d="M6.89 19.22 A25.5 25.5 0 0 1 29.11 4.52" fill="none" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}
// An empty head is a hollow dashed ring, not a filled spool in a muted color
// — the shape itself should read "nothing here" at a glance, without having
// to compare colors against the loaded slots next to it.
function emptySpoolSvg(){
  return `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 60 60">
  <circle cx="30" cy="30" r="27" fill="none" stroke="var(--ink-faint)" stroke-width="2" stroke-dasharray="5 5" opacity="0.5"/>
  <circle cx="30" cy="30" r="9" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.4"/>
</svg>`;
}
function afcLanesHtml(heads,activeExt,printerId,canUnload,finished){
  const cards=(heads||[]).map((h,i)=>{
    const loaded=h&&h.loaded;
    const active=loaded&&activeExt===i;
    const color=esc((h&&h.hex)||'#383a4a');
    const material=h&&h.material||'—';
    const label=headLabel(i);
    // A connector can name its slots the way the printer does (Bambu's AMS
    // "A1".."D4", "HT1", "Ext-L"); everything else keeps T1..Tn.
    const laneTitle=(h&&h.label)?String(h.label):'T'+(i+1);
    const uid=`${printerId}-${i}`;
    const cardStyle=active?`style="border:2px solid ${color}bb;box-shadow:inset 0 0 20px ${color}28,inset 0 0 6px ${color}18;background:${color}14"`:'';
    const hdrStyle=active?`style="color:${color}ee;background:${color}22;border-bottom-color:${color}33"`:'';
    // Some connectors (Creality CFS so far) only report per-slot status —
    // no unloadFilament implementation exists yet, so the spool click isn't
    // wired to anything actionable; showing it anyway would just surface a
    // "does not support filament unload" error for something that's meant to
    // be read-only status.
    const spoolInner=loaded?spoolSvg(color,active,uid):emptySpoolSvg();
    // No unload support (e.g. Creality CFS, status-only), and an empty slot
    // either way: a plain, full-opacity indicator with no click affordance —
    // NOT `.inert-action`, which dims + shows a "not-allowed" cursor for a
    // temporarily blocked permission, the wrong signal for something that
    // was never clickable. An empty head has nothing to act on regardless of
    // permission — the dialog never opens for it at all.
    const spool=(canUnload&&loaded)
      ? `<span class="spool-click${canAct()?'':' inert-action'}" data-unload-printer="${printerId}" data-unload-ext="${i}" style="cursor:pointer" title="${esc(headLabel(i))}">${spoolInner}</span>`
      : `<span title="${headLabel(i)}">${spoolInner}</span>`;
    return `<div class="afc-lane-card ${active?'active':loaded?'idle':'empty'}" ${cardStyle}>
      <div class="afc-lane-hdr" ${hdrStyle}>${esc(laneTitle)}${material&&material!=='—'?' '+esc(material):''}</div>
      <div class="afc-spool-area">
        ${spool}
        ${active?`<div class="afc-active-label" style="color:${color}cc">${esc(finished?t('fleet.card.afc_last_used'):t('fleet.card.afc_active'))}</div>`:''}
        ${loaded&&!active?`<div class="afc-active-label" style="color:var(--ink-faint)">${esc(t('fleet.card.afc_loaded'))}</div>`:''}
      </div>
    </div>`;
  }).join('');
  return `<div class="afc-section"><div class="afc-lanes">${cards}</div></div>`;
}

// One thumbnail read per print job: the token is part of the /api/thumbnail
// URL (cached "immutable" by the browser), and only changes when the printer
// starts a NEW job — a different file, or the same file printed again
// (non-paused state → printing). A mid-print re-slice never swaps the image.
const THUMB_TOKENS={}; // printerId -> { file, state, token }
function thumbToken(p, stem){
  const m=THUMB_TOKENS[p.id];
  const newJob=!m || m.file!==stem ||
    (p.state==="printing" && m.state!=="printing" && m.state!=="paused");
  const token=newJob?Date.now():m.token;
  THUMB_TOKENS[p.id]={ file:stem, state:p.state, token };
  return token;
}

// A failed thumbnail load only gets a fresh <img> (and thus a fresh fetch)
// when the NEXT /api/fleet poll's body actually differs from the last one
// (renderFleet's cheap re-render guard) — for an idle/complete/cancelled
// printer that's often never, since nothing else on the card is changing
// either. Without this, one transient blip (a slow/busy printer, a dropped
// connection) leaves the card permanently showing the "—" placeholder until
// something unrelated changes or the page is reloaded. Retry a few times
// with backoff before actually giving up.
function thumbRetry(img){
  const n=parseInt(img.dataset.retry||"0",10);
  if(n<4){
    img.dataset.retry=n+1;
    const base=img.src.split("&r=")[0];
    setTimeout(()=>{ if(img.isConnected) img.src=base+"&r="+Date.now(); }, 1500*(n+1));
  } else if(img.parentNode){
    img.parentNode.innerHTML='<span class="stats-thumb-empty">—</span>';
  }
}

// /orca/<printer> mode: narrow any printer list down to just that one printer.
const urlFilterFleet = arr => URL_PRINTER_FILTER ? arr.filter(p=>(p.name||'').trim().toLowerCase()===URL_PRINTER_FILTER) : arr;

// ---- Fleet card cache + diffing (see the reviewed plan: per-card diffing
// for the fleet grid — C:\Users\ebz\.claude\plans\harmonic-mapping-treehouse.md
// at time of writing) ----
// printer id -> { sig, el }. Always represents the currently-mounted card
// set, regardless of whether the last pass was incremental or a forced full
// rebuild — reconcileFleetCards() refreshes an entry for every card it
// touches either way, so an incremental pass always starts from a state
// that matches what's actually in the DOM.
const CARD_CACHE = new Map();
// cardSignature() is a CORRECTNESS CONTRACT with buildCardHtml(), not an
// isolated optimization — read both together. Every dynamic field
// buildCardHtml() reads from `p` to produce visible output MUST also be
// represented here. A field present in the template but missing from this
// signature doesn't fail loudly: it produces silently stale UI (the card
// just never updates for that field), which is a worse failure mode than a
// crash, since nothing surfaces it short of a human noticing a card didn't
// update. If you add a field to buildCardHtml(), add it here too.
//
// The DOM rebuild buildCardHtml() performs is the expensive operation this
// whole mechanism exists to skip — comparing a signature is not a
// meaningful cost at any fleet size this app will realistically see, so
// this deliberately favors a plain, obviously-correct JSON.stringify of the
// relevant fields over hand-flattening primitives for speed.
//
// Two fields are deliberately excluded, both because calling their real
// source function here "just to check" would corrupt state:
//   - thumbToken(p, stem) (below) mutates the module-level THUMB_TOKENS map
//     on every call. Its own newJob check depends only on `stem` and
//     `state`, both already included below — signature-equality on those
//     implies thumbToken() would return the same token anyway. It's only
//     ever actually called from inside buildCardHtml(), same as before.
//   - The MAPSEL self-heal write inside buildCardHtml()'s mapHtml block is a
//     one-time default-fill side effect, not part of what a signature
//     should represent.
// Patches the four values cardSignature() deliberately ignores into a card
// reconcileFleetCards() decided to keep. Because everything else still
// invalidates the signature, this function never has to add, remove or
// re-order an element, change a class, or re-translate a string — it only
// writes text and individual style properties into nodes that already
// exist, addressed by explicit data-live hooks in buildCardHtml().
//
// Individual style properties, never the whole `style` attribute:
// .prog-fill carries a per-card animation-delay seed that holds the
// shimmer's phase steady, and rewriting the attribute would restart it on
// every poll — one of the artifacts this change exists to remove.
//
// Every lookup is null-guarded rather than assumed: an offline card, and
// an online one showing the Klipper error panel, legitimately have no
// stats bar and no progress section at all.
function updateFleetCardLiveValues(card, p){
  const setText=(sel,txt)=>{ const el=card.querySelector(sel); if(el&&el.textContent!==txt) el.textContent=txt; };
  const setBar=(sel,info)=>{
    const el=card.querySelector(sel); if(!el) return;
    el.style.width=info.pct+"%";
    el.style.background=info.bg||"";
    el.style.boxShadow=heatBarShadow(info.bg);
  };
  const pct=(p.progress*100).toFixed(1);
  setText('[data-live="pct"]', pct+"%");
  const fill=card.querySelector('[data-live="bar"]');
  if(fill) fill.style.width=pct+"%";
  setText('[data-live="elapsed"]', fmtDuration(p.elapsed));
  // Absent by design once the print completes — that cell becomes
  // "Finished <time>" instead, which is driven by completedAt and stays
  // structural. setText simply finds nothing then.
  setText('[data-live="remaining"]', fmtRemaining(p.elapsed,p.progress,p.remaining));
  // The target moves with the reading (both live on p.hotend/p.bed), so
  // setting a new bed target has to show up here too, not wait for the
  // next structural change.
  const hotA=p.hotend?Math.round(p.hotend.temp):0, hotT=p.hotend?Math.round(p.hotend.target):0;
  const bedA=p.bed?Math.round(p.bed.temp):0, bedT=p.bed?Math.round(p.bed.target):0;
  const hotBar=heatBarInfo(hotA,hotT), bedBar=heatBarInfo(bedA,bedT);
  setText('[data-live="hotend-val"]', hotA+"°");
  setText('[data-live="hotend-target"]', hotBar.targetTxt);
  setBar('[data-live="hotend-bar"]', hotBar);
  setText('[data-live="bed-val"]', bedA+"°");
  setText('[data-live="bed-target"]', bedBar.targetTxt);
  setBar('[data-live="bed-bar"]', bedBar);
}
function cardSignature(p){
  const queuedReady=p.queuedFile&&p.queuedFile.status==='ready'?p.queuedFile:null;
  const stem=queuedReady?queuedReady.name:(p.filename||"");
  return JSON.stringify({
    online:p.online, state:p.state, name:p.name, brand:p.brand, url:p.url,
    // progress/elapsed/bed/hotend (and remaining, the printer-reported
    // countdown some connectors send) are deliberately ABSENT — they are the
    // values that move on their own while a printer runs, and while
    // they were in here every actively printing card was destroyed and
    // rebuilt on every poll: a WebRTC camera renegotiated its session,
    // a .pstatus message being written by an in-flight action was wiped,
    // keyboard focus was lost, and the progress shimmer restarted. They
    // are patched into the surviving card by
    // updateFleetCardLiveValues() instead — that function and this
    // omission are one mechanism, so a field removed here MUST have a
    // data-live hook there, and nothing else may be removed without
    // giving it one.
    filename:p.filename,
    filamentUsed:p.filamentUsed, completedAt:p.completedAt,
    errorCode:p.errorCode, message:p.message, plate:p.plate,
    activeExt:p.activeExt, forceDefaults:p.forceDefaults,
    heads:p.heads, capabilities:p.capabilities, tags:p.tags,
    queuedFile:p.queuedFile, layer:p.layer, stem,
    // Temperatures used to live here for a real reason: a printer sitting
    // idle/"Loaded" with nothing else in this signature changing can still
    // have its bed/hotend genuinely drifting, and with them omitted and
    // nothing else to patch the card, the displayed temps froze at
    // whatever they were on the last real change. That failure is what
    // updateFleetCardLiveValues() now prevents — it runs on EVERY reused
    // card, not only on printing ones, which is exactly the case that bug
    // came from. Do not omit a field from this signature unless that
    // function patches it.
    // STATUS_OVERRIDE is client-only UI state, not part of `p` at all — a
    // change there needs to force a rebuild the same way a real server-
    // reported change does, or the badge would only catch up once
    // something else in this signature also happened to change.
    statusOverride:STATUS_OVERRIDE.get(String(p.id))||null
  });
}
// Builds one printer's card element. `need` (neededColors()) and
// `dragEnabled` are per-render-pass context, not per-card state — see
// reconcileFleetCards(), which computes them once and passes them down.
function buildCardHtml(p, need, dragEnabled){
    const card=document.createElement("div");
    card.className="pcard"+(p.online?"":" offline");
    card.dataset.pid=p.id;
    const tagColor=parseColorTag(p.tags);
    if(tagColor){ card.classList.add("tag-tinted"); card.style.setProperty("--tag-color",tagColor); }
    // status pill
    const {statusColor, statusTxt}=statusColorText(p);
    // heads
    const heads=(p.heads||[]);
    const headsHtml=heads.map((h,i)=>{
      if(!h || !h.loaded) return `<div class="h empty"><div class="sw"></div><div class="lab"><div class="ht">${headLabel(i)}</div><div class="hm">—</div></div></div>`;
      // advisory match: is this head close to any needed color?
      let match=false;
      if(need.length){ for(const n of need){ if(n.hex && h.hex && colorDist(n.hex,h.hex)<MATCH_THRESHOLD){ match=true; break; } } }
      return `<div class="h${match?' match':''}"><div class="sw" style="background:${esc(h.hex||'#3a3f49')}"></div>`+
             `<div class="lab"><div class="ht">${headLabel(i)}</div><div class="hm">${esc(h.material||'')}</div><div class="ht" style="margin-top:2px">${esc(h.hex||"")}</div></div></div>`;
    }).join("");
    const busy = p.online && (p.state==="printing"||p.state==="paused");
    const maintMode = p.state==="maintenance";
    const canSend = p.online && SELECTED && !busy && !maintMode;
    // per-color head picker (default: greedy nearest distinct head)
    let mapHtml="";
    if(canSend && ALLOW_MAPPING && p.capabilities?.headMapping){
      // A single-material file reports no used colors — that still means
      // "pick which loaded head feeds this print", so fall back to one
      // unnamed slot standing in for the whole file (see neededColorsOrSlot()).
      const cmapNeed=neededColorsOrSlot();
      const dft=defaultMapping(cmapNeed, heads);
      const allHeads=Array.from({length:4},(_,i)=>({hi:i,h:heads[i]||null}));
      if(allHeads.some(x=>x.h&&x.h.loaded)){
        const rows=cmapNeed.map(n=>{
          const saved=MAPSEL[p.id+":"+n.i];
          const chosen=(saved!==undefined)?String(saved):String(dft[n.i]??"");
          if(saved===undefined && dft[n.i]!==undefined) MAPSEL[p.id+":"+n.i]=String(dft[n.i]);
          const hbtns=allHeads.map(({hi,h})=>{
            const loaded=!!(h&&h.loaded);
            const isSel=chosen!==""&&chosen===String(hi);
            const bg=esc(loaded?(h.hex||'#3a3f49'):'#2a2d36');
            const hDark=needsDarkText(loaded?h.hex:null);
            return `<button class="hs-sq${isSel?' selected':''}${loaded?'':' empty'}${hDark?' light-bg':''}" style="background:${bg}" data-card="${p.id}" data-pi="${n.i}" data-hi="${hi}"${loaded?'':' disabled'}>` +
                   `<span class="hs-lbl">T${hi+1}</span>` +
                   `<span class="hs-mat">${esc(loaded&&h.material?h.material:'')}</span></button>`;
          }).join("");
          const info=[n.type, n.wt?Math.ceil(parseFloat(n.wt))+'g':''].filter(Boolean).join(', ');
          const fDark=needsDarkText(n.hex);
          const assignedH=chosen!==""?allHeads[parseInt(chosen)]?.h:null;
          const matMismatch=!!(n.type&&assignedH?.material&&n.type.trim().toLowerCase()!==assignedH.material.trim().toLowerCase());
          return `<div class="cmaprow">` +
                 `<div class="fsq${fDark?' light-bg':''}" style="background:${esc(n.hex||'#3a3f49')}"><span class="fsq-t">T${n.i+1}</span>${info?`<span class="fsq-info">${esc(info)}</span>`:''}</div>` +
                 `<span class="arrow">${matMismatch?'❌':'➜'}</span><div class="head-btns">${hbtns}</div></div>`;
        }).join("");
        mapHtml=`<div class="cmap"><div class="cmaphdr-row"><span class="cmaphdr">${esc(t("fleet.card.model_color_header"))}</span><span class="cmaphdr">${esc(t("fleet.card.printer_toolheads_header"))}</span></div>${rows}</div>`;
      }
    }
    card.innerHTML=`
      <div class="top">${gridToolbarActive()?`<label class="cam-select"><input type="checkbox" class="cam-chk checkbox-input on-surface" data-camsel="${p.id}"${CAM_SELECTED.has(p.id)?' checked':''}></label>`:''}<span class="pn"><span><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name">${esc(p.name)}</div></span></span><div class="card-right">${p.online?`<div class="card-pills">${canEject(p)&&!monitorOnly(p)?`<button class="pill-btn pill-btn-sm" ${canAct()?"":"disabled"} data-eject="${p.id}" title="${esc(t("printer.action_eject"))}"><img src="/eject-pill.svg" alt="${esc(t("printer.action_eject"))}"></button>`:''}${p.capabilities?.camera?`<button class="pill-btn pill-btn-sm" data-snap="${p.id}" title="${esc(t("printer.action_camera"))}"><img src="/camera-pill.svg" alt="${esc(t("printer.action_camera"))}"></button>`:''}${p.capabilities?.webUi?`<a class="pill-btn pill-btn-sm" href="${esc(p.url||'#')}" target="_blank" rel="noopener" title="${esc(t("printer.action_web_interface_title"))}"><img src="/fluidd-pill.svg" alt="${esc(t("printer.action_web_interface_alt"))}"></a>`:''}</div>`:''}<span class="status-badge${dragEnabled?' drag-handle':''}"${dragEnabled?` draggable="true" title="${esc(t("fleet.card.drag_title"))}"`:''} style="--status-color:${statusColor}">${statusTxt}</span></div></div>
      <div class="prism-line${p.state==='error'?' err-line':p.state==='cancelled'?' cancelled-line':p.state==='paused'?' pause-line':p.state==='complete'?' complete-line':''}"></div>
      ${VIEW_MODE==='camera'?(!p.online
          ? `<div class="cam-shot-placeholder"><span>${esc(t("printer_status.offline"))}</span></div>`
          : p.capabilities?.camera
            ? `<div class="cam-shot-slot" data-camslot="${p.id}"></div>`
            : `<div class="cam-shot-placeholder"><img class="cam-shot-placeholder-icon" src="/camera-disabled.svg" alt=""><span>${esc(t("fleet.camera.disabled_label"))}</span></div>`
        ):''}
      ${p.queuedFile?queuedFileBannerHtml(p):''}
      ${p.online&&(p.errorCode||p.message)?(()=>{
        const e=lookupKlipperError(p.errorCode, p.message);
        const listIcon=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`;
        return `<div class="klipper-err-panel"><div class="klipper-err-title">${esc(e.title)}</div>`+
          (e.code?`<div class="klipper-err-code">${listIcon}<span>${esc(t("fleet.error_panel.code_prefix",{code:e.code}))}</span></div>`:'<div style="padding-bottom:4px"></div>')+
          `<div class="klipper-err-divider"></div><div class="klipper-err-body">${esc(e.description)}`+
          (e.url?`<br><a class="klipper-err-link" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(t("fleet.error_panel.learn_more"))}</a>`:'')+
          `</div></div>`;
      })():''}
      ${p.online&&!(p.errorCode||p.message)?(()=>{
        const extA=p.hotend?Math.round(p.hotend.temp):0, extT=p.hotend?Math.round(p.hotend.target):0;
        const bedA=p.bed?Math.round(p.bed.temp):0, bedT=p.bed?Math.round(p.bed.target):0;
        const layer=layerDisplay(p);
        const hotendBar=heatBarInfo(extA,extT);
        const bedBar=heatBarInfo(bedA,bedT);
        // The real filename, unmodified — Moonraker's own thumbnail-path
        // convention (stripping the extension for its "<stem>-300x300.png"
        // cache) is a Klipper-specific detail that belongs inside that
        // connector's getThumbnail(), not baked in here, since a different
        // connector (FlashForge) needs the exact filename instead.
        // Same "Loaded" precedence as the progress-section below (see
        // statusColorText) — otherwise this thumbnail would show the
        // last-printed file's preview while everything else on the card
        // already points at the newly queued one.
        const queuedReady=p.queuedFile&&p.queuedFile.status==='ready'?p.queuedFile:null;
        const stem=queuedReady?queuedReady.name:(p.filename||"");
        const thumbCell=stem&&!noThumbs(p)
          ? `<div class="stats-cell stats-thumb-cell" data-thumb="${p.id}" tabindex="0" role="button" title="${esc(t("fleet.card.thumb_enlarge_title"))}"><img class="stats-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)"></div>`
          : `<div class="stats-cell stats-thumb-cell"><span class="stats-thumb-empty">—</span></div>`;
        return `<div class="stats-bar">`+
          `<div class="stats-cell"><div class="stats-cell-label">${esc(t("fleet.card.hotend_label"))}</div><div class="stats-cell-val"><span data-live="hotend-val">${extA}°</span><span class="stats-sep">/</span><span class="stats-inline-target" data-live="hotend-target">${hotendBar.targetTxt}</span></div><div class="stats-mini-bar"><div class="stats-mini-fill" data-live="hotend-bar" style="${heatBarFillStyle(hotendBar)}"></div></div></div>`+
          (monitorOnly(p)
            ? `<div class="stats-cell">`
            : `<div class="stats-cell${canAct()?'':' inert-action'}" data-setbed="${p.id}" style="cursor:pointer" title="${esc(t("fleet.card.bed_temp_title"))}">`)+
          `<div class="stats-cell-label">${esc(t("fleet.card.bed_label"))}</div><div class="stats-cell-val"><span data-live="bed-val">${bedA}°</span><span class="stats-sep">/</span><span class="stats-inline-target" data-live="bed-target">${bedBar.targetTxt}</span></div><div class="stats-mini-bar"><div class="stats-mini-fill" data-live="bed-bar" style="${heatBarFillStyle(bedBar)}"></div></div></div>`+
          `<div class="stats-cell"><div class="stats-cell-label">${esc(t("fleet.progress.layer_label"))}</div><div class="stats-cell-val">${layer?layer.current:'—'}<span class="stats-inline-target">${layer?'/'+layer.total:''}</span></div></div>`+
          thumbCell+
          `</div>`;
      })():""}
      ${p.online?(()=>{
        const pct=(p.progress*100).toFixed(1);
        const pctCls=p.state==='error'?'red':p.state==='paused'?'amber':p.state==='complete'?'green':'cyan';
        const trackCls=p.state==='error'?'red':p.state==='paused'?'amber':'';
        const fillCls=pctCls;
        const camView=VIEW_MODE==='camera';
        // Camera view has no room for the temps/thumbnail stats-bar (hidden
        // entirely — see body.camview CSS) and no use for filament meters
        // when the whole point of this view is watching the print happen —
        // layer progress is the one stat from that row worth keeping, and
        // the thumbnail moves up alongside the filename instead.
        const filM=p.filamentUsed!=null?(p.filamentUsed/1000).toFixed(1)+'m':'—';
        const layer=layerDisplay(p);
        const layerTxt=layer?layer.current+'/'+layer.total:'—';
        // A file loaded/queued but not yet started (see statusColorText's
        // "Loaded" state) takes over this slot instead of the printer's own
        // last-printed filename — it's the more relevant "what's up next",
        // and reusing this same spot (rather than a separate line above the
        // stats-bar) is what keeps an idle-with-something-loaded card the
        // same height as any other idle card.
        const queuedReady=p.queuedFile&&p.queuedFile.status==='ready'?p.queuedFile:null;
        const stem=queuedReady?queuedReady.name:(p.filename||"");
        // Built once, reused as-is for regular/compact (a sibling of
        // .prog-file, unchanged from before) and nested inside .cam-prog-file
        // for camera view, where the thumbnail spans both the filename row
        // and this row via CSS grid (see .cam-prog-file in style.css).
        const progRowHtml=`<div class="prog-row"><span class="prog-pct ${pctCls}" data-live="pct">${pct}%</span>`+
          `<div class="prog-track ${trackCls}"><div class="prog-fill ${fillCls}" data-live="bar" style="width:${pct}%;animation-delay:-${(Date.now()/1000%8).toFixed(2)}s"></div></div></div>`;
        // The progress bar itself always renders, error or not (unchanged
        // from before this camera-view work) — only the filename/thumbnail
        // part is hidden on error, in favor of the klipper-err-panel above
        // it. On error, camera view falls back to the bare bar too (no
        // filename to pair the thumbnail's grid span against).
        const fileSection = (p.errorCode||p.message)
          ? progRowHtml
          : camView
            ? `<div class="cam-prog-file">`+
                `<div class="prog-file-thumb"${stem&&!noThumbs(p)?` data-thumb="${p.id}" tabindex="0" role="button" title="${esc(t("fleet.card.thumb_enlarge_title"))}"`:''}>${stem&&!noThumbs(p)?`<img class="stats-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)">`:''}</div>`+
                `<span class="prog-file-name">${esc(stem||'—')}</span>`+
                progRowHtml+
              `</div>`
            : `<div class="prog-file">${esc(stem||'—')}</div>`+progRowHtml;
        return `<div class="progress-section">`+
          fileSection+
          (p.errorCode||p.message?'':`<div class="prog-times">`+
          `<div class="prog-time-cell"><span class="prog-time-label">${esc(p.state==='complete'?t("fleet.progress.total_time_label"):t("fleet.progress.elapsed_label"))}</span><span class="prog-time-val" data-live="elapsed">${fmtDuration(p.elapsed)}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          `<div class="prog-time-cell center"><span class="prog-time-label">${esc(camView?t("fleet.progress.layer_label"):t("fleet.progress.filament_label"))}</span><span class="prog-time-val">${camView?layerTxt:filM}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          (p.state==='complete'
            ? `<div class="prog-time-cell end"><span class="prog-time-label">${esc(t("fleet.progress.finished_label"))}</span><span class="prog-time-val">${fmtFinishedTime(p.completedAt)}</span></div>`
            : `<div class="prog-time-cell end"><span class="prog-time-label">${esc(t("fleet.progress.remaining_label"))}</span><span class="prog-time-val" data-live="remaining">${fmtRemaining(p.elapsed,p.progress,p.remaining)}</span></div>`)+
          `</div>`)+`</div>`;
      })():""}
      ${p.online&&!(p.errorCode||p.message)&&p.capabilities?.filamentHeads?afcLanesHtml(heads,p.activeExt,p.id,!!p.capabilities?.unloadFilament,p.state==='complete'):''}
      ${mapHtml}
      <div class="foot${busy?'':' foot-idle'}">
        ${monitorOnly(p)
          ? monitorOnlyNoteHtml()
          : busy
          ? (p.state==="paused"
                ? `<button class="btn-chip" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="resume" title="${esc(t("printer.action_resume"))}"><img src="/print-icon.svg" alt=""><span>${esc(t("printer.action_resume"))}</span></button>`
                : `<button class="btn-chip" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="pause" title="${esc(t("printer.action_pause"))}"><img src="/pause-icon.svg" alt=""><span>${esc(t("printer.action_pause"))}</span></button>`)
            // Visible label corrected from the old "Stop" to match the title,
            // the confirm() dialog's own wording, and the real action
            // (data-act="cancel", an irreversible cancel — not a pause-like
            // stop). Icon/handler unchanged, text only.
            + `<button class="btn-chip danger" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="cancel" title="${esc(t("common.cancel"))}"><img src="/stop-icon.svg" alt=""><span>${esc(t("common.cancel"))}</span></button>`
            + (p.capabilities?.excludeObject&&p.plate&&p.plate.total>1?`<button class="btn-chip" ${canAct()?"":"disabled"} data-plate="${p.id}" title="${esc(t("printer.action_plate_title",{done:p.plate.total-p.plate.excluded,total:p.plate.total}))}"><img src="/plate-icon.svg" alt=""><span>${esc(t("printer.action_plate"))}</span></button>`:"")
            + `<button class="btn-chip danger" ${canAct()&&!estopUnsupported(p)?"":"disabled"} data-estop="${p.id}" title="${esc(estopUnsupported(p)?t("printer.action_estop_unsupported_title"):t("printer.action_estop_title"))}"><img src="/estop-icon.svg" alt=""><span>${esc(t("printer.action_estop"))}</span></button>`
          : `<button class="btn-chip" ${canSend&&canAct()?"":"disabled"} data-id="${p.id}" data-start="0" title="${maintMode?esc(t("printer.action_maintenance_mode_title")):esc(t("printer.action_upload_title"))}"><img src="/upload-file.svg" alt=""><span>${esc(t("printer.action_upload"))}</span></button>`
            + `<button class="btn-chip" ${p.online&&!busy&&!maintMode&&canAct()?"":"disabled"} data-id="${p.id}" data-start="1" title="${maintMode?esc(t("printer.action_maintenance_mode_title")):SELECTED?esc(t("printer.action_print_title_selected")):esc(t("printer.action_print_title_pick"))}"><img src="/print-icon.svg" alt=""><span>${esc(t("printer.action_print"))}</span></button>`
            + `<button class="btn-chip" ${canAct()?"":"disabled"} data-preheat="${p.id}" title="${esc(t("printer.action_preheat"))}"><img src="/preheat-icon.svg" alt=""><span>${esc(t("printer.action_preheat"))}</span></button>`
            + (p.state==='complete'&&p.filename?`<button class="btn-chip" ${canAct()?"":"disabled"} data-reprint="${p.id}" title="${esc(t("printer.action_reprint_title",{filename:p.filename}))}"><img src="/reprint-icon.svg" alt=""><span>${esc(t("printer.action_reprint"))}</span></button>`:"")
        }
      </div>
      <div class="pstatus" id="pst-${p.id}"></div>`;
    return card;
}
// Replaces the old wrap.innerHTML=""+forEach full rebuild for the card-grid
// path. When `incremental` is false (every renderFleet() call except the
// poll/refresh path — see renderFleet() below), the caller has already
// cleared `wrap` and CARD_CACHE, so every card takes the "rebuild" branch
// below and behavior is identical to the old code. When `incremental` is
// true, a card whose cardSignature() matches its cached entry is reused
// untouched (no innerHTML write, no listener work — delegation in
// wireFleetCardEvents() means reused nodes don't need rebinding either);
// changed/new cards rebuild. Every card is appended unconditionally for
// ordering — appendChild on a node already in the right position is a
// cheap no-op, only actually moving nodes that changed rank (see
// wireFleetDrag's own use of the same "read order back from the DOM"
// pattern at drop time, which this keeps compatible with).
function reconcileFleetCards(camFleet, wrap, camRefreshMs, dragEnabled, incremental){
  const need=neededColors();
  const seen=new Set();
  // `cursor` is the node currently sitting where the next card belongs.
  // A card already there needs NO DOM operation: re-appending a node that
  // is already in the right place is still a remove + insert as far as the
  // DOM is concerned, and removing a focused element resets focus to
  // <body> — which is why the previous unconditional appendChild() dropped
  // keyboard focus off a card on every poll, even when the card itself was
  // successfully reused. Anything not already in place is moved before the
  // cursor: exactly one operation per genuinely misplaced card, and the
  // resulting order is camFleet's order regardless of what it started as.
  //
  // Foreign nodes (a leftover skeleton card, the "unreachable" message
  // loadFleet() writes when the very first poll fails) are never the
  // cursor's equal, so cards get inserted before them in camFleet order —
  // card order stays correct either way. Neither this nor the previous
  // appendChild() removes such a node; only cards this function owns are
  // cleaned up, in the CARD_CACHE sweep below.
  let cursor=wrap.firstChild;
  camFleet.forEach(p=>{
    seen.add(p.id);
    const sig=cardSignature(p);
    const cached=CARD_CACHE.get(p.id);
    let el, rebuilt=true;
    // The reused node keeps its camera session, its .pstatus text, its
    // focus and its shimmer phase — only the four live values are written
    // into it (see updateFleetCardLiveValues / cardSignature).
    if(incremental && cached && cached.sig===sig){ el=cached.el; rebuilt=false; updateFleetCardLiveValues(el, p); }
    else {
      el=buildCardHtml(p, need, dragEnabled);
      // A rebuild replaces the cached element with a brand-new one — the
      // previous element is still attached to `wrap` from the last render
      // pass and must be removed here, or it's silently orphaned in the DOM
      // (still visible, no longer reachable via CARD_CACHE) every time this
      // printer's card is rebuilt, i.e. on every poll its displayed data
      // changes — which for an actively-printing card is every single poll.
      if(cached){
        // Step the cursor off this node BEFORE detaching it: insertBefore()
        // against a reference node that is no longer a child throws.
        if(cursor===cached.el) cursor=cursor.nextSibling;
        cached.el.remove(); closeCamRtc(p.id);
      }
      CARD_CACHE.set(p.id, { sig, el });
    }
    if(rebuilt && VIEW_MODE==='camera' && p.online && p.capabilities?.camera){
      const slot=el.querySelector('.cam-shot-slot[data-camslot="'+p.id+'"]');
      // Two transports, one slot: a printer whose camera is WebRTC-only
      // (no server-side snapshot) gets a live <video>, everything else
      // keeps the existing JPEG path untouched.
      if(slot){
        // A relayed stream wins over snapshots when a connector offers both
        // (Bambu with ffmpeg on the host): live video costs the server nothing
        // extra, while a snapshot per tile per refresh would spawn a decoder.
        if(p.capabilities?.cameraStream) mountCamStream(slot, p.id);
        else if(p.capabilities?.cameraWebrtc && !p.capabilities?.cameraSnapshot && p.cameraWebrtcUrl) mountCamRtc(slot, p.id, p.cameraWebrtcUrl);
        else mountCamShot(slot, p.id, camRefreshMs, CAM_STAGGER);
      }
    }
    // insertBefore(el, null) is appendChild(el), so a new card at the end
    // of the fleet still lands correctly.
    if(el===cursor) cursor=cursor.nextSibling;
    else wrap.insertBefore(el, cursor);
  });
  for(const [id, entry] of [...CARD_CACHE]){
    // closeCamRtc() is a no-op for a printer that never had a session, so
    // this covers deletion, going offline and dropping out of a filter
    // without needing to know which of those happened.
    if(!seen.has(id)){ closeCamRtc(id); entry.el.remove(); CARD_CACHE.delete(id); }
  }
}
// `incremental` is only ever true from loadFleet()'s own render call — every
// other call site (view mode change, sort change, search keystroke, camera
// tab/tag filter, file selection change, camera retry click, login/role
// refresh, initial load, list-view sort) calls renderFleet() with no
// arguments and gets today's full-rebuild behavior, unchanged.
function renderFleet({incremental}={}){
  const wrap=$("fleet");
  let online=0;
  const q=($("fleetSearch")||{value:""}).value.trim().toLowerCase();
  const all=sortedFleet();
  // Reachable-but-in-maintenance shouldn't read as "online" here — it can't
  // take a job right now, which is what this count is meant to signal.
  all.forEach(p=>{ if(p.online&&p.state!=="maintenance") online++; });
  const fleet=URL_PRINTER_FILTER ? urlFilterFleet(all)
    : !q ? all : all.filter(p=>matchesFleetQuery(p,q));
  // Status tabs + tag filter are shared by camera/list view only — tab
  // counts/tag options are computed from `fleet` (respects the search box
  // above) before this stage narrows further, so switching views never
  // leaves a stale filter silently hiding printers in regular/compact.
  const camRefreshMs=(parseInt(($("setCameraRefresh")||{value:""}).value,10)||6)*1000;
  let camFleet=fleet;
  if(gridToolbarActive()){
    renderCamToolbar(fleet);
    camFleet=fleet.filter(p=>{
      if(CAM_TAB!=='all' && camBucket(p)!==CAM_TAB) return false;
      if(CAM_TAG_FILTER && !(p.tags||[]).includes(CAM_TAG_FILTER)) return false;
      return true;
    });
  }
  if(VIEW_MODE==='list'){
    // No closeAllCamRtc() here. Leaving Camera View already releases every
    // session at the view boundary (applyViewMode(), which every path into
    // List View goes through), so calling it again on each render was
    // redundant for that case — and actively harmful in another: List rows
    // mount no camera elements, so the only session that can exist while
    // List View is up is the short-lived one the Snapshot modal opens to
    // grab a frame from a WebRTC-only camera. A routine fleet refresh was
    // killing that mid-capture, so the modal timed out on "Live view is
    // still connecting" every time.
    wrap.innerHTML=""; CARD_CACHE.clear();
    renderFleetListRows(camFleet, wrap, camRefreshMs);
  } else {
  // Reordering persists via applyPrinterOrder() -> saveConfig() -> POST
  // /api/config, which is admin-only server-side — gate on isAdmin(), not
  // canAct(), or a Regular user's drag would silently 403 and revert with
  // no visible feedback (Settings, where the error would surface, is hidden
  // from them entirely).
  const camFiltered=gridToolbarActive()&&(CAM_TAB!=='all'||!!CAM_TAG_FILTER);
  const dragEnabled=SORT_MODE==='none'&&!q&&!camFiltered&&isAdmin();
  if(!incremental){ wrap.innerHTML=""; CARD_CACHE.clear(); closeAllCamRtc(); }
  reconcileFleetCards(camFleet, wrap, camRefreshMs, dragEnabled, !!incremental);
  }
  $("fleetcount").textContent=t("fleet.status.count_online",{online,total:FLEET.length});
  updateHealthBadge();
  if(gridToolbarActive()) updateCamToolbar();
}

// preTabFleet: the post-search, pre-tab/tag-filter array — tab counts and the
// tag dropdown reflect what's actually available to filter into, not just
// what's currently showing after CAM_TAB/CAM_TAG_FILTER narrow it further.
// "Printing"/"Idle"/"Offline" reuse printer_status.* (identical meaning);
// "All"/"Attention Needed" are Fleet-toolbar-owned, no existing match.
const CAM_TAB_LABEL_KEYS = { all:"fleet.toolbar.tab_all", printing:"printer_status.printing", attention:"fleet.toolbar.tab_attention", idle:"printer_status.idle", offline:"printer_status.offline" };
function renderCamToolbar(preTabFleet){
  const bar=$("camViewBar");
  if(!bar) return;
  const counts={all:preTabFleet.length, printing:0, attention:0, idle:0, offline:0};
  preTabFleet.forEach(p=>{ counts[camBucket(p)]++; });
  document.querySelectorAll("#camTabs button[data-camtab]").forEach(b=>{
    const key=b.dataset.camtab;
    b.textContent=`${t(CAM_TAB_LABEL_KEYS[key])} ${counts[key]}`;
    b.classList.toggle("active", CAM_TAB===key);
    b.classList.toggle("zero", counts[key]===0);
  });
  const sel=$("camTagFilter");
  if(sel){
    const tags=[...new Set(FLEET.flatMap(p=>p.tags||[]).filter(t=>!isColorTag(t)))].sort();
    sel.innerHTML=`<option value="">${esc(t("fleet.toolbar.all_tags"))}</option>`+tags.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join("");
    sel.value=tags.includes(CAM_TAG_FILTER)?CAM_TAG_FILTER:"";
    CAM_TAG_FILTER=sel.value;
  }
}
// Selection can outlive a printer being removed, or a printer that no longer
// matches the current filter scrolling out of the DOM — prune against the
// live fleet before computing bulk-button eligibility so a stale id never
// silently counts toward "N selected".
// Complete per-action button-label keys ("Pause (N)" etc.) rather than a
// shared verb + JS-composed "(N)" — parentheses here are UI notation, but
// the full format still comes from the translation key, not concatenation.
const BULK_ACT_DEFS=[
  { act:"pause", buttonKey:"fleet.toolbar.bulk_pause_button", test:p=>p.state==="printing"&&!monitorOnly(p), reasonKey:"fleet.toolbar.bulk_reason_pause" },
  { act:"resume", buttonKey:"fleet.toolbar.bulk_resume_button", test:p=>p.state==="paused"&&!monitorOnly(p), reasonKey:"fleet.toolbar.bulk_reason_resume" },
  { act:"cancel", buttonKey:"fleet.toolbar.bulk_cancel_button", test:p=>(p.state==="printing"||p.state==="paused")&&!monitorOnly(p), reasonKey:"fleet.toolbar.bulk_reason_cancel" },
];
function updateCamToolbar(){
  for(const id of CAM_SELECTED){ if(!FLEET.some(f=>f.id===id)) CAM_SELECTED.delete(id); }
  for(const id of CAM_SHOT_CACHE.keys()){ if(!FLEET.some(f=>f.id===id)) CAM_SHOT_CACHE.delete(id); }
  const n=CAM_SELECTED.size;
  const cnt=$("camSelCount");
  if(cnt){ cnt.textContent = n>0 ? tn("fleet.toolbar.selected_count",n) : t("fleet.toolbar.select_all"); cnt.classList.toggle("has-selection", n>0); }
  const selPrinters=[...CAM_SELECTED].map(id=>FLEET.find(f=>f.id===id)).filter(Boolean);
  // Pause/Resume/Cancel only exist in the DOM once something's selected —
  // that's where the row's vertical space comes from when nothing is picked.
  const actionsWrap=$("camBulkActions");
  if(actionsWrap){
    actionsWrap.innerHTML = n===0 ? "" : BULK_ACT_DEFS.map(d=>{
      const eligible=selPrinters.some(d.test);
      return `<button type="button" class="btn ghost" data-bulkact="${d.act}"${eligible?"":` disabled title="${esc(t(d.reasonKey))}"`}>${esc(t(d.buttonKey,{n}))}</button>`;
    }).join("");
    actionsWrap.querySelectorAll("[data-bulkact]").forEach(b=>{
      b.addEventListener("click",()=>bulkCtl(b.dataset.bulkact));
    });
  }
  const selAll=$("camSelectAll");
  if(selAll){
    const chks=[...document.querySelectorAll(".cam-chk")];
    const numChecked=chks.filter(c=>c.checked).length;
    selAll.checked = chks.length>0 && numChecked===chks.length;
    selAll.indeterminate = numChecked>0 && numChecked<chks.length;
  }
}
// Result-message base keys — each a complete tn() pair on its own ("{count}
// paused"/"{count} pausadas" etc., since Spanish adjective agreement
// genuinely depends on count here, unlike the English source). The "X
// paused, Y failed, Z not eligible" message is 1-3 of these independently-
// complete phrases joined by a locale-neutral ", " separator — same
// established pattern as Queue's group-summary fix earlier in this project
// (join complete fragments, never concatenate word-by-word).
const BULK_ACT_RESULT_KEYS = { pause:"fleet.toolbar.bulk_result_paused", resume:"fleet.toolbar.bulk_result_resumed", cancel:"fleet.toolbar.bulk_result_cancelled" };
async function bulkCtl(act){
  const eligible=[...CAM_SELECTED].filter(id=>{
    const p=FLEET.find(f=>f.id===id);
    if(!p||monitorOnly(p)) return false;
    return act==='pause' ? p.state==='printing' : act==='resume' ? p.state==='paused' : p.state==='printing'||p.state==='paused';
  });
  if(!eligible.length) return;
  if(act==='cancel'){
    const names=eligible.map(id=>{ const p=FLEET.find(f=>f.id===id); return p?p.name:id; });
    if(!confirm(tn("fleet.toolbar.bulk_cancel_confirm",eligible.length,{names:names.join("\n")}))) return;
  }
  const msg=$("camBulkMsg");
  if(msg){ msg.className="pstatus work"; msg.textContent=t("fleet.toolbar.bulk_working"); }
  const results=await Promise.allSettled(eligible.map(async id=>{
    const r=await postJSON("/api/printctl",{printer:id,action:act});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
  }));
  const okCount=results.filter(r=>r.status==='fulfilled').length;
  const skipped=CAM_SELECTED.size-eligible.length;
  if(msg){
    msg.className="pstatus "+(okCount===eligible.length?"ok":"err");
    const parts=[tn(BULK_ACT_RESULT_KEYS[act],okCount)];
    if(eligible.length-okCount>0) parts.push(tn("fleet.toolbar.bulk_failed",eligible.length-okCount));
    if(skipped>0) parts.push(tn("fleet.toolbar.bulk_not_eligible",skipped));
    msg.textContent=parts.join(", ");
  }
  loadFleet();
}

// ---- Edit Tags modal: one row per printer, comma-separated tags, only
// changed rows are POSTed (Promise.allSettled) so an untouched printer's
// tags are never re-sent/re-validated for no reason. ----
function openTagsEditor(){
  const wrap=$("tagsList");
  wrap.innerHTML=FLEET.map(p=>{
    const val=(p.tags||[]).join(", ");
    return `<div class="tags-row" data-tagsrow="${p.id}">`+
      `<span class="tags-row-name">${esc(p.name)}</span>`+
      `<input type="text" class="field tags-row-input" data-tagsorig="${esc(val)}" value="${esc(val)}" placeholder="${esc(t("fleet.modal.tags.placeholder"))}">`+
      `<span class="tags-row-swatch">${colorTagSwatchHtml(val)}</span>`+
      `</div>`;
  }).join("");
  wrap.querySelectorAll(".tags-row-input").forEach(inp=>{
    inp.addEventListener("input",()=>{
      inp.closest(".tags-row").querySelector(".tags-row-swatch").innerHTML=colorTagSwatchHtml(inp.value);
    });
  });
  $("tagsmodal").classList.add("show");
}
function closeTagsModal(){ $("tagsmodal").classList.remove("show"); }
async function saveTagsEditor(){
  const rows=[...document.querySelectorAll("#tagsList .tags-row")];
  const changed=rows.filter(r=>{
    const input=r.querySelector(".tags-row-input");
    return input.value.trim()!==(input.dataset.tagsorig||"").trim();
  });
  if(!changed.length){ closeTagsModal(); return; }
  await Promise.allSettled(changed.map(r=>{
    const id=parseInt(r.dataset.tagsrow,10);
    const tags=r.querySelector(".tags-row-input").value.split(",").map(t=>t.trim()).filter(Boolean);
    return postJSON("/api/printer-tags",{printer:id,tags});
  }));
  closeTagsModal();
  loadFleet();
}

// ---- List view: one <table> row per printer instead of a card ----
// Shares the camera view's toolbar (tabs/tag-filter/bulk-select — see
// gridToolbarActive()) but needs none of the card grid's per-printer DOM
// (renderFleet() branches to this function instead of its normal
// camFleet.forEach card-building loop). Action buttons reuse the exact same
// data-* attributes as the card footer (data-ctl/data-act, data-estop,
// data-id/data-start, data-preheat, data-plate) so the generic
// wrap.querySelectorAll(...) wiring at the end of renderFleet() covers them
// with no changes — same for the .cam-chk checkbox and [data-thumb]/
// [data-snap]. null = not sorted by name (whatever order camFleet arrived
// in); toggles asc/desc thereafter, same as any single-column table sort.
let LIST_SORT_NAME_DIR = null; // null | 'asc' | 'desc'
function renderFleetListRows(camFleet, wrap, camRefreshMs){
  const rows = LIST_SORT_NAME_DIR
    ? [...camFleet].sort((a,b)=>{
        const c=(a.name||"").localeCompare(b.name||"");
        return LIST_SORT_NAME_DIR==='asc' ? c : -c;
      })
    : camFleet;
  const sortArrow = LIST_SORT_NAME_DIR==='asc' ? '▲' : LIST_SORT_NAME_DIR==='desc' ? '▼' : '⇅';
  const table=document.createElement("table");
  table.className="fleet-list";
  // Percentage widths (rather than px) so the columns always sum to the
  // table's own width and can never overflow into — or get squeezed by —
  // one another regardless of screen size; that's what let Actions visually
  // crowd into Filament's space before. Progress is 8% here (was ~16%),
  // halved per feedback; the rest of that share went to Actions/Filament.
  // Printer's <col> is calc(25ch + cell padding) instead of a % — 25ch
  // matches the name field's own maxlength (Settings > Printers), and ch
  // resolves against the table's own inherited font (13px, --sans — the
  // same font .hdr-name renders in), so it tracks that rule instead of a
  // hardcoded px guess. The 20px is this table's actual td padding
  // (8px 10px, i.e. 10px each side) — without it, real text would truncate
  // a few characters short of the full 25 the column is sized for. Freed
  // from the % pool entirely, its old 19% share goes to File below.
  table.innerHTML=`<colgroup>`+
      `<col style="width:32px"><col style="width:calc(25ch + 20px)"><col style="width:9%">`+
      `<col style="width:34%"><col style="width:13%"><col style="width:36px">`+
      `<col style="width:8%"><col style="width:76px"><col style="width:14%"><col style="width:13%">`+
    `</colgroup>`+
    `<thead><tr>`+
    `<th class="list-th-chk"></th>`+
    `<th class="list-th-sort" data-listsort="name">${esc(t("settings.logs.col_printer"))} <span class="list-sort-arrow">${sortArrow}</span></th>`+
    `<th>${esc(t("settings.printers.field_tags"))}</th><th>${esc(t("fleet.list.col_file"))}</th><th>${esc(t("fleet.list.col_status"))}</th><th class="list-th-cam"></th><th>${esc(t("fleet.list.col_progress"))}</th><th>${esc(t("fleet.list.col_layers"))}</th><th>${esc(t("fleet.progress.filament_label"))}</th><th>${esc(t("fleet.list.col_actions"))}</th>`+
    `</tr></thead><tbody></tbody>`;
  const tbody=table.querySelector("tbody");
  rows.forEach(p=>{
    const {statusColor, statusTxt}=statusColorText(p);
    const busy=p.online&&(p.state==="printing"||p.state==="paused");
    const maintMode=p.state==="maintenance";
    const canSend=p.online&&SELECTED&&!busy&&!maintMode;
    // Same "Loaded" precedence as the card grid (see statusColorText and the
    // progress-section's own `stem`) — otherwise this column would keep
    // showing the last-printed file while the status badge next to it
    // already says "Loaded" for a different one.
    const queuedReady=p.queuedFile&&p.queuedFile.status==='ready'?p.queuedFile:null;
    const stem=queuedReady?queuedReady.name:(p.filename||"");
    const fileCell=stem&&noThumbs(p)
      ? `<div class="list-file-cell"><span class="list-file-name">${esc(stem)}</span></div>`
      : stem
      ? `<div class="list-file-cell" data-thumb="${p.id}" tabindex="0" role="button" title="${esc(t("fleet.card.thumb_enlarge_title"))}"><img class="list-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)"><span class="list-file-name">${esc(stem)}</span></div>`
      : `<span class="list-file-empty">—</span>`;
    const pct=p.online&&p.progress!=null?p.progress*100:null;
    const pctCls=p.state==='error'?'red':p.state==='paused'?'amber':p.state==='complete'?'green':'cyan';
    const trackCls=p.state==='error'?'red':p.state==='paused'?'amber':'';
    const listLayer=layerDisplay(p);
    // Second line only means something while there's an active countdown or a
    // finish time to report — idle/error/cancelled rows already say so via
    // the 0% (or frozen %) above; a "—" placeholder there just adds noise.
    const progressMeta = p.state==='complete' ? fmtFinishedTime(p.completedAt)
      : (p.state==='printing'||p.state==='paused') ? fmtRemaining(p.elapsed,p.progress,p.remaining)
      : '';
    const progressCell=pct!=null
      ? `<div class="list-progress">`+
          `<div class="list-progress-row"><span class="list-progress-pct ${pctCls}">${pct.toFixed(0)}%</span>`+
          `<div class="prog-track list-progress-track ${trackCls}"><div class="prog-fill list-progress-fill ${pctCls}" style="width:${pct}%"></div></div></div>`+
          (progressMeta?`<div class="list-progress-meta">${progressMeta}</div>`:'')+
        `</div>`
      : `<span class="list-file-empty">—</span>`;
    const layersCell = pct!=null && listLayer ? `${listLayer.current} / ${listLayer.total}` : '—';
    // Bambu-style [PLA] chip: material name on a background of its own
    // color, one per toolhead — empty heads render as a hollow chip (same
    // fixed box as a loaded one) rather than being skipped, so the row's
    // chips stay aligned against neighboring rows regardless of which heads
    // are actually loaded.
    const filamentCell=p.capabilities?.filamentHeads
      ? ((p.heads||[]).slice(0,4).map(h=>{
          if(!h||!h.loaded) return `<span class="list-filament-chip empty" title="${esc(t("fleet.list.empty_chip_title"))}"></span>`;
          const hex=h.hex||'#3a3f49';
          const dark=needsDarkText(hex);
          return `<span class="list-filament-chip" style="background:${esc(hex)};color:${dark?'#111':'#fff'}" title="${esc(h.material||'')}">${esc((h.material||'?').toUpperCase().slice(0,4))}</span>`;
        }).join("")) || `<span class="list-file-empty">—</span>`
      : `<span class="list-file-empty">—</span>`;
    const actionsCell=monitorOnly(p)
      ? monitorOnlyNoteHtml(true)
      : busy
      ? (p.state==="paused"
            ? `<button class="btn-chip icon-only" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="resume" title="${esc(t("printer.action_resume"))}"><img src="/print-icon.svg" alt=""></button>`
            : `<button class="btn-chip icon-only" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="pause" title="${esc(t("printer.action_pause"))}"><img src="/pause-icon.svg" alt=""></button>`)
        + `<button class="btn-chip icon-only danger" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="cancel" title="${esc(t("common.cancel"))}"><img src="/stop-icon.svg" alt=""></button>`
        + `<button class="btn-chip icon-only danger" ${canAct()&&!estopUnsupported(p)?"":"disabled"} data-estop="${p.id}" title="${esc(estopUnsupported(p)?t("printer.action_estop_unsupported_title"):t("printer.action_estop_title"))}"><img src="/estop-icon.svg" alt=""></button>`
      : `<button class="btn-chip icon-only" ${canSend&&canAct()?"":"disabled"} data-id="${p.id}" data-start="0" title="${maintMode?esc(t("printer.action_maintenance_mode_title")):esc(t("printer.action_upload_title"))}"><img src="/upload-file.svg" alt=""></button>`
        + `<button class="btn-chip icon-only" ${p.online&&!busy&&!maintMode&&canAct()?"":"disabled"} data-id="${p.id}" data-start="1" title="${maintMode?esc(t("printer.action_maintenance_mode_title")):SELECTED?esc(t("printer.action_print_title_selected")):esc(t("printer.action_print_title_pick"))}"><img src="/print-icon.svg" alt=""></button>`
        + `<button class="btn-chip icon-only" ${canAct()?"":"disabled"} data-preheat="${p.id}" title="${esc(t("printer.action_preheat"))}"><img src="/preheat-icon.svg" alt=""></button>`;
    const tr=document.createElement("tr");
    tr.className="list-row"+(p.online?"":" offline");
    tr.innerHTML=`<td class="list-th-chk"><label class="cam-select"><input type="checkbox" class="cam-chk checkbox-input" data-camsel="${p.id}"${CAM_SELECTED.has(p.id)?' checked':''}></label></td>`+
      `<td class="list-printer-cell"><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name" title="${esc(p.name)}">${esc(p.name)}</div></td>`+
      `<td>${(p.tags||[]).filter(t=>!isColorTag(t)).map(t=>`<span class="list-tag">${esc(t)}</span>`).join("")||'<span class="list-file-empty">—</span>'}</td>`+
      `<td>${fileCell}</td>`+
      `<td><span class="status-badge" style="--status-color:${statusColor}">${statusTxt}</span></td>`+
      `<td class="list-th-cam">${p.capabilities?.camera?`<button class="pill-btn pill-btn-sm list-status-cam" data-snap="${p.id}" title="${esc(t("fleet.list.view_camera_title",{name:p.name}))}"><img src="/camera-pill.svg" alt="${esc(t("printer.action_camera"))}"></button>`:''}</td>`+
      `<td>${progressCell}</td>`+
      `<td class="list-layers-cell">${layersCell}</td>`+
      `<td><div class="list-filament-cell">${filamentCell}</div></td>`+
      `<td><div class="list-actions-cell">${actionsCell}</div></td>`;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  table.querySelector('[data-listsort="name"]').addEventListener("click",()=>{
    LIST_SORT_NAME_DIR = LIST_SORT_NAME_DIR==='asc' ? 'desc' : 'asc';
    renderFleet();
  });
}

// A file staged by --load while nobody was watching (queuedFile, set server-side
// by /api/notify-load), or just uploaded to an idle printer via the plain
// Upload button. Only "queued"/"uploading"/"error" get this bordered banner —
// real, rare in-progress states with nothing else on the card showing them.
// "ready" gets no banner at all: the status badge already says "Loaded" (see
// statusColorText) and the filename itself shows in the same slot a printing
// job's filename would (see the progress-section's `stem`), so a second,
// separate notice here would just be redundant extra card height.
function queuedFileBannerHtml(p){
  const qf=p.queuedFile;
  if(!qf) return '';
  if(qf.status==='queued') return `<div class="queued-banner work">${t("fleet.queued.queued_banner",{name:qf.name},{html:true})}</div>`;
  if(qf.status==='uploading') return `<div class="queued-banner work">${t("fleet.queued.staging_banner",{name:qf.name},{html:true})}</div>`;
  if(qf.status==='error') return `<div class="queued-banner err">${esc(t("fleet.queued.stage_failed_banner",{name:qf.name,error:qf.error||''}))}</div>`;
  return '';
}
// /api/printfile is job-based (docs/TODO.md item 9a): the HTTP response means
// "start job accepted", NOT "printing". Head mapping and G29 happen after it
// returns, so the outcome only arrives via pollJob -- treating the 200 as
// success would report a print started that may still fail minutes later.
async function printQueuedFile(printerId, filename, prefs){
  const st=$("pst-"+printerId);
  if(st){ st.className="pstatus work"; st.textContent=t("fleet.queued.starting_print_status"); }
  let ok=false;
  try{
    const r=await postJSON("/api/printfile",{printer:printerId,filename,map:{},prefs});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    ok=await pollJob(d.jobId, st, true, d.mapped||0, null, null, prefs, printerId);
    // pollJob writes its own generic completion text. This path had its own
    // wording before 9a and keeps it: the conversion is synchronous -> async,
    // not a change to what the operator reads.
    if(ok&&st){ st.className="pstatus ok"; st.textContent=t("fleet.queued.printing_status",{filename}); }
  }catch(e){ if(st){ st.className="pstatus err"; st.textContent=e.message; } }
  loadFleet();
  return ok;
}

// Reprint: the file is already sitting on the printer from the job that just
// finished (p.filename) — same "already on the printer" path printQueuedFile
// uses for a staged queued file, just triggered from a plain completed card
// instead of a queued-file banner.
function doReprint(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.filename) return;
  if(p.forceDefaults===false&&printerSupportsAnyPrintOpt(p)) openQuickPrintModal(printerId,'queued',p.filename);
  else printQueuedFile(printerId,p.filename);
}

// ---- Quick print options popup ("Force default behavior" off) ----
// Shown instead of printing immediately when a printer's own "Force default
// behavior" switch (Settings > printer > Behavior) is off — lets this one
// print override Auto-level/Flow Calibration/Time-lapse (and, where
// supported — U1 today — which toolheads to flow-calibrate) instead of
// silently reusing the printer's configured defaults.
//
// Own switch defs (not PRINT_OPT_DEFS/printOptsHtml, which pfilemodal/
// sendmodal use deliberately WITHOUT a description line at their smaller
// size) — this dialog follows the General tab's switchHtml() convention
// instead: sentence-case label + a real .switch-desc line under each.
const QP_OPT_DEFS=[
  { key:"flowCalibrate", cap:"flowCalibration", labelKey:"fleet.modal.quickprint.opt_flow_calibrate_label", descKey:"fleet.modal.quickprint.opt_flow_calibrate_desc" },
  { key:"timelapse", cap:"timelapse", labelKey:"fleet.modal.quickprint.opt_timelapse_label", descKey:"fleet.modal.quickprint.opt_timelapse_desc" },
  { key:"autoLevel", cap:"autoLevel", labelKey:"fleet.modal.quickprint.opt_autolevel_label", descKey:"fleet.modal.quickprint.opt_autolevel_desc" }
];
let QP_PRINTER=null, QP_MODE=null, QP_QUEUED_NAME=null, QP_PREFS={}, QP_EXT_SELECTED=new Set();

function printerSupportsAnyPrintOpt(p){
  return !!(p && p.capabilities && QP_OPT_DEFS.some(o=>p.capabilities[o.cap]));
}

function openQuickPrintModal(printerId, mode, queuedName){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p) return;
  QP_PRINTER=printerId; QP_MODE=mode; QP_QUEUED_NAME=queuedName||null;
  QP_PREFS={autoLevel:!!p.autoLevel, flowCalibrate:!!p.flowCalibrate, timelapse:!!p.timelapse};
  // Default to whichever toolheads are actually loaded right now — a much
  // more useful starting point for "only one filament was just swapped"
  // than the firmware's own blanket default of calibrating all four.
  QP_EXT_SELECTED=new Set((p.heads||[]).map((h,i)=>h&&h.loaded?i:-1).filter(i=>i>=0));
  if(!QP_EXT_SELECTED.size) QP_EXT_SELECTED=new Set([0,1,2,3]);
  $("qpSubtitle").textContent=t("fleet.modal.quickprint.subtitle",{printer:p.name});
  $("qpStatus").className="pstatus"; $("qpStatus").textContent="";
  $("qpProgress").style.display="none";
  $("qpFill").className="send-row-fill"; $("qpFill").style.width="0%";
  $("qpUploadStatus").className="send-status-txt"; $("qpUploadStatus").textContent="";
  renderQuickPrintOpts();
  $("quickPrintModal").classList.add("show");
}
function closeQuickPrintModal(){
  $("quickPrintModal").classList.remove("show");
  QP_PRINTER=null; QP_MODE=null; QP_QUEUED_NAME=null;
}
function renderQuickPrintOpts(){
  const p=FLEET.find(f=>f.id===QP_PRINTER);
  const caps=p&&p.capabilities;
  $("qpOpts").innerHTML=QP_OPT_DEFS.filter(o=>caps&&caps[o.cap]).map(o=>
    switchHtml("qpopt-"+o.key, !!QP_PREFS[o.key], t(o.labelKey), t(o.descKey))
  ).join("");
  QP_OPT_DEFS.forEach(o=>{
    const el=$("qpopt-"+o.key);
    if(!el) return;
    el.addEventListener("change",()=>{
      QP_PREFS[o.key]=el.checked;
      if(o.key==="flowCalibrate") renderQuickPrintExtruders();
      syncQuickPrintButton();
    });
  });
  renderQuickPrintExtruders();
  syncQuickPrintButton();
}
// Per-toolhead flow-calibration picker, nested under the Flow calibration
// switch the same way "Auto-match colors" nests under "Head mapping" on the
// General tab (.settings-nested — indent + left border, dimmed/inert via
// .disabled rather than hidden, so the option stays visible even while it
// doesn't apply yet). The wrap itself only fully hides when this printer has
// no per-extruder support at all (nothing to nest under anything, for now
// only U1 — see flowCalibrationPerExtruder).
function renderQuickPrintExtruders(){
  const p=FLEET.find(f=>f.id===QP_PRINTER);
  const wrap=$("qpExtruderWrap");
  const supports=!!(p&&p.capabilities&&p.capabilities.flowCalibrationPerExtruder);
  wrap.style.display=supports?"":"none";
  if(!supports) return;
  wrap.classList.toggle("disabled", !QP_PREFS.flowCalibrate);
  const heads=p.heads||[];
  $("qpExtruderRow").innerHTML=Array.from({length:4},(_,i)=>{
    const h=heads[i], loaded=!!(h&&h.loaded);
    const hex=h&&h.hex?h.hex.toUpperCase():null;
    const color=esc(hex||"#3a3f49");
    // Named against the same 30-color palette the spool-color picker resolves
    // against — falls back to the raw hex when there's no exact name match,
    // since a small swatch alone is hard to identify at this size.
    const titleParts=!loaded ? [t("fleet.modal.quickprint.ext_nothing_loaded")] : [hex?(nameForHex(hex)||hex):null, h.material].filter(Boolean);
    const selected=QP_EXT_SELECTED.has(i);
    return `<button type="button" class="qp-ext-chip${selected?' selected':''}" data-ext="${i}" aria-pressed="${selected}"${loaded?'':' disabled'} title="${esc(titleParts.join(', ')||headLabel(i))}">`+
      `<span class="qp-ext-swatch" style="background:${color}"></span><span>${esc(headLabel(i))}</span></button>`;
  }).join("");
  $("qpExtruderRow").querySelectorAll("[data-ext]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const i=parseInt(btn.dataset.ext,10);
      if(QP_EXT_SELECTED.has(i)) QP_EXT_SELECTED.delete(i); else QP_EXT_SELECTED.add(i);
      const sel=QP_EXT_SELECTED.has(i);
      btn.classList.toggle("selected", sel);
      btn.setAttribute("aria-pressed", sel);
      renderQuickPrintExtruderFooter();
      syncQuickPrintButton();
    });
  });
  renderQuickPrintExtruderFooter();
}
function renderQuickPrintExtruderFooter(){
  const n=QP_EXT_SELECTED.size;
  $("qpExtruderFooter").textContent=n?tn("fleet.modal.quickprint.ext_selected_count",n,{n}):t("fleet.modal.quickprint.ext_none_selected");
}
// Nothing to calibrate is a real dead end (the printer would just run its
// default of "every extruder"), not a subtle default — block Start print
// outright rather than let it quietly do more than the user picked.
function syncQuickPrintButton(){
  const p=FLEET.find(f=>f.id===QP_PRINTER);
  const supports=!!(p&&p.capabilities&&p.capabilities.flowCalibrationPerExtruder);
  const blocked=!!(QP_PREFS.flowCalibrate&&supports&&QP_EXT_SELECTED.size===0);
  const btn=$("qpPrint");
  btn.disabled=blocked;
  btn.title=blocked?t("fleet.modal.quickprint.blocked_title"):"";
}
async function doQuickPrint(){
  const prefs={...QP_PREFS};
  if(prefs.flowCalibrate) prefs.flowCalibrateExtruders=[...QP_EXT_SELECTED];
  const printer=QP_PRINTER, mode=QP_MODE, name=QP_QUEUED_NAME;
  const btn=$("qpPrint");
  btn.disabled=true;
  let ok=false;
  try{
    if(mode==='queued'){
      // Already sitting on the printer — starting it is a single fast
      // Moonraker call, no upload bytes to track, so "Starting…" is the
      // whole story here (unlike the push path below).
      $("qpStatus").className="pstatus work"; $("qpStatus").textContent=t("fleet.queued.starting_print_status");
      ok=await printQueuedFile(printer, name, prefs);
      if(!ok){ $("qpStatus").className="pstatus err"; $("qpStatus").textContent=t("fleet.modal.quickprint.status_start_failed"); }
    } else {
      // Real upload ahead — same {fillEl,statusEl} progress hookup
      // pushTo/pollJob already drive for the send-modal's per-printer rows,
      // reused here instead of a static "Starting…" label.
      $("qpStatus").className="pstatus"; $("qpStatus").textContent="";
      $("qpProgress").style.display="";
      ok=await pushTo(printer, true, {fillEl:$("qpFill"), statusEl:$("qpUploadStatus")}, prefs);
    }
    if(ok) closeQuickPrintModal();
  } finally {
    btn.disabled=false;
  }
}

// ---- Fleet card click/change/keydown handling, delegated on #fleet ----
// Bound ONCE at startup (alongside wireFleetDrag() below, same shape: one
// listener on the container, resolved via e.target.closest() at event time)
// rather than re-bound to every card on every render. This is what makes
// per-card diffing in reconcileFleetCards() safe — a card's DOM node can now
// persist unchanged across many renders without needing to track, per node,
// whether it already has listeners attached.
function wireFleetCardEvents(){
  const wrap=$("fleet");
  wrap.addEventListener("click", e=>{
    const idBtn=e.target.closest("button[data-id]");
    if(idBtn){
      const id=parseInt(idBtn.dataset.id,10), start=idBtn.dataset.start==="1";
      const p=FLEET.find(f=>f.id===id)||{};
      const qf=p.queuedFile;
      // Print already has a file loaded/queued on the printer itself (see
      // queuedFileBannerHtml) — print THAT rather than uploading whatever
      // happens to be selected in SnapCon's own file manager, which would
      // otherwise silently replace it.
      if(start&&qf&&qf.status==='ready'){
        if(p.forceDefaults===false&&printerSupportsAnyPrintOpt(p)) openQuickPrintModal(id,'queued',qf.name);
        else printQueuedFile(id, qf.name);
        return;
      }
      // Print with no file selected in SnapCon: offer the printer's own files.
      if(start&&!SELECTED){ openPrinterFiles(id); return; }
      if(start&&p.forceDefaults===false&&printerSupportsAnyPrintOpt(p)){ openQuickPrintModal(id,'push'); return; }
      pushTo(id, start);
      return;
    }
    const hsBtn=e.target.closest(".hs-sq");
    if(hsBtn){
      const {card,pi,hi}=hsBtn.dataset;
      MAPSEL[card+":"+pi]=hi;
      wrap.querySelectorAll(`.hs-sq[data-card="${card}"][data-pi="${pi}"]`).forEach(x=>x.classList.remove("selected"));
      hsBtn.classList.add("selected");
      return;
    }
    const ctlBtn=e.target.closest("button[data-ctl]");
    if(ctlBtn){
      const ctlId=parseInt(ctlBtn.dataset.ctl,10), ctlAct=ctlBtn.dataset.act;
      if(ctlAct==="cancel") doCancelPrint(ctlId); else ctl(ctlId, ctlAct);
      return;
    }
    const plateBtn=e.target.closest("button[data-plate]");
    if(plateBtn){ openPlate(parseInt(plateBtn.dataset.plate,10)); return; }
    const thumbEl=e.target.closest("[data-thumb]");
    if(thumbEl){ openThumb(parseInt(thumbEl.dataset.thumb,10)); return; }
    const snapEl=e.target.closest("[data-snap]");
    if(snapEl){ openSnapshot(parseInt(snapEl.dataset.snap,10)); return; }
    const ejectEl=e.target.closest("[data-eject]");
    if(ejectEl){ ejectFile(parseInt(ejectEl.dataset.eject,10)); return; }
    const setbedEl=e.target.closest("[data-setbed]");
    if(setbedEl){ openBedModal(parseInt(setbedEl.dataset.setbed,10)); return; }
    const spoolEl=e.target.closest(".spool-click");
    if(spoolEl){ openUnload(parseInt(spoolEl.dataset.unloadPrinter,10), parseInt(spoolEl.dataset.unloadExt,10)); return; }
    const estopBtn=e.target.closest("button[data-estop]");
    if(estopBtn){ doEstop(parseInt(estopBtn.dataset.estop,10)); return; }
    const preheatBtn=e.target.closest("button[data-preheat]");
    if(preheatBtn){ openPreheat(parseInt(preheatBtn.dataset.preheat,10)); return; }
    const reprintBtn=e.target.closest("button[data-reprint]");
    if(reprintBtn){ doReprint(parseInt(reprintBtn.dataset.reprint,10)); return; }
    // Card selection (camera view only — the checkbox only renders there):
    // the checkbox alone is too small a target to scan/click across a grid
    // of cards, so the whole header toggles it too. Excludes the checkbox
    // itself (already toggles natively — re-toggling here would cancel it
    // back out) and anything else interactive in the header (eject/camera/
    // webUI pills, the status badge, which doubles as a drag handle).
    const top=e.target.closest(".pcard .top");
    if(top){
      if(e.target.closest(".cam-select, .pill-btn, a, .status-badge")) return;
      const chk=top.querySelector(".cam-chk");
      if(!chk) return;
      chk.checked=!chk.checked;
      chk.dispatchEvent(new Event("change"));
    }
  });
  wrap.addEventListener("keydown", e=>{
    const thumbEl=e.target.closest("[data-thumb]");
    if(thumbEl&&(e.key==="Enter"||e.key===" ")){ e.preventDefault(); openThumb(parseInt(thumbEl.dataset.thumb,10)); }
  });
  wrap.addEventListener("change", e=>{
    const chk=e.target.closest(".cam-chk");
    if(!chk) return;
    const id=parseInt(chk.dataset.camsel,10);
    if(chk.checked) CAM_SELECTED.add(id); else CAM_SELECTED.delete(id);
    updateCamToolbar();
  });
}
// ---- Fleet card reordering by drag (status pill = drag handle, "No Sort" only) ----
// Polling must not touch the DOM while a drag is live (it'd yank the dragged
// node out from under the browser's native drag and abort the gesture), and
// must stay paused through the save round-trip so a stale poll can't flash
// the pre-drop order back in before the new order lands.
let FLEET_DRAGGING=false, FLEET_DRAG_SAVING=false;
function wireFleetDrag(){
  const wrap=$("fleet");
  wrap.addEventListener("dragstart", e=>{
    const handle=e.target.closest(".drag-handle");
    const card=handle&&handle.closest(".pcard");
    if(!card){ e.preventDefault(); return; }
    FLEET_DRAGGING=true;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed="move";
    e.dataTransfer.setData("text/plain", card.dataset.pid);
  });
  wrap.addEventListener("dragover", e=>{
    const dragging=wrap.querySelector(".pcard.dragging");
    if(!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect="move";
    const over=e.target.closest(".pcard");
    wrap.querySelectorAll(".pcard.drag-over").forEach(c=>{ if(c!==over) c.classList.remove("drag-over"); });
    if(over&&over!==dragging) over.classList.add("drag-over");
  });
  wrap.addEventListener("drop", e=>{
    const dragging=wrap.querySelector(".pcard.dragging");
    wrap.querySelectorAll(".pcard.drag-over").forEach(c=>c.classList.remove("drag-over"));
    if(!dragging) return;
    e.preventDefault();
    const target=e.target.closest(".pcard");
    if(target&&target!==dragging){
      // Dropping forward (dragging was before target) must land AFTER the
      // target, not before it, or a forward drag becomes a no-op.
      const forward=!!(dragging.compareDocumentPosition(target)&Node.DOCUMENT_POSITION_FOLLOWING);
      wrap.insertBefore(dragging, forward?target.nextSibling:target);
    }
    else if(!target) wrap.appendChild(dragging);
    const order=[...wrap.querySelectorAll(".pcard[data-pid]")].map(c=>parseInt(c.dataset.pid,10));
    FLEET_DRAG_SAVING=true;
    applyPrinterOrder(order).finally(()=>{ FLEET_DRAG_SAVING=false; });
  });
  wrap.addEventListener("dragend", ()=>{
    FLEET_DRAGGING=false;
    wrap.querySelectorAll(".pcard.dragging").forEach(c=>c.classList.remove("dragging"));
    wrap.querySelectorAll(".pcard.drag-over").forEach(c=>c.classList.remove("drag-over"));
  });
}
// Settings > Printers drag-to-reorder — same shape as wireFleetDrag above,
// but purely local: reordering the DOM and marking the tab dirty rather than
// saving immediately, since every other edit in this form waits for Save.
function wirePrinterDrag(){
  const wrap=$("setPrinters");
  wrap.addEventListener("dragover", e=>{
    const dragging=wrap.querySelector(".prow.dragging");
    if(!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect="move";
    const over=e.target.closest(".prow");
    wrap.querySelectorAll(".prow.drag-over").forEach(r=>{ if(r!==over) r.classList.remove("drag-over"); });
    if(over&&over!==dragging) over.classList.add("drag-over");
  });
  wrap.addEventListener("drop", e=>{
    const dragging=wrap.querySelector(".prow.dragging");
    wrap.querySelectorAll(".prow.drag-over").forEach(r=>r.classList.remove("drag-over"));
    if(!dragging) return;
    e.preventDefault();
    const target=e.target.closest(".prow");
    if(target&&target!==dragging){
      const forward=!!(dragging.compareDocumentPosition(target)&Node.DOCUMENT_POSITION_FOLLOWING);
      wrap.insertBefore(dragging, forward?target.nextSibling:target);
    } else if(!target) wrap.appendChild(dragging);
    markPrintersDirty();
  });
}
// order = new sequence expressed in old printer ids (indices into PRINTERS_CFG)
async function applyPrinterOrder(order){
  if(order.length!==PRINTERS_CFG.length||order.some(id=>!Number.isInteger(id)||id<0||id>=PRINTERS_CFG.length)) return;
  const prows=[...$("setPrinters").children];
  PRINTERS_CFG=order.map(id=>PRINTERS_CFG[id]);
  order.forEach(id=>$("setPrinters").appendChild(prows[id]));
  await saveConfig();
}

let PUSHES=0;
// extraUI (optional): {statusEl, fillEl} — a row in the send-to-printers modal
// that should mirror this job's progress alongside the fleet card/button.
async function pushTo(printer, start, extraUI, prefs){
  if(!SELECTED){ return false; }
  const map={};
  if(ALLOW_MAPPING) neededColorsOrSlot().forEach(n=>{ const v=MAPSEL[printer+":"+n.i]; if(v!==undefined) map[n.i]=parseInt(v,10); });
  const mapped=Object.keys(map).length;
  const st=$("pst-"+printer);
  if(st){ st.className="pstatus"; st.textContent=""; }
  if(extraUI) setRowUI(extraUI, 0, "", t("fleet.print.status_uploading"));
  // Capture the clicked button to animate its background as a fill bar
  const progressBtn=document.querySelector(`button[data-id="${printer}"][data-start="${start?'1':'0'}"]`);
  const btnOrigBg=progressBtn?progressBtn.style.background:'';
  if(progressBtn) progressBtn.disabled=true;
  PUSHES++;
  let ok=false;
  try{
    const r=await postJSON("/api/print",{file:SELECTED,printer,start,map,prefs});
    const d=await r.json(); if(!r.ok||d.error||(!d.jobId&&d.mode!=="pending")) throw new Error(d.error||("HTTP "+r.status));
    if(d.mode==="pending"){
      // Printer's busy — server queued the file instead of racing an upload
      // against the active print; loadFleet() below picks up p.queuedFile
      // and renders the existing "ready to print" banner once it lands.
      if(st){ st.className="pstatus ok"; st.textContent=t("fleet.print.status_queued_will_upload"); }
      if(extraUI) setRowUI(extraUI, 100, "ok", t("fleet.print.status_queued_short"));
      if(progressBtn){ progressBtn.style.background=''; progressBtn.disabled=false; }
      ok=true;
    } else {
      ok=await pollJob(d.jobId, st, start, mapped, progressBtn, extraUI, prefs, printer);
    }
  }catch(e){
    if(st){ st.className="pstatus err"; st.textContent=e.message; }
    if(extraUI) setRowUI(extraUI, 100, "err", e.message);
    if(progressBtn){ progressBtn.style.background=btnOrigBg; progressBtn.disabled=false; }
  }
  finally{ PUSHES=Math.max(0,PUSHES-1); }
  loadFleet();
  return ok;
}
function setBtnFill(btn, pct){
  if(!btn) return;
  btn.style.background=`linear-gradient(to right, rgba(167,139,250,0.55) ${pct}%, rgba(167,139,250,0.13) ${pct}%)`;
}
// Mirrors upload/print progress onto a send-modal row: fill width + status text/color.
function setRowUI(extraUI, pct, cls, txt){
  if(extraUI.fillEl){ extraUI.fillEl.style.width=pct+"%"; extraUI.fillEl.className="send-row-fill"+(cls?" "+cls:""); }
  if(extraUI.statusEl){ extraUI.statusEl.className="send-status-txt"+(cls?" "+cls:""); extraUI.statusEl.textContent=txt; }
}
// server.js's "mapping" job phase covers everything applyHeadMapping() may
// do for the connector in use — real per-toolhead color mapping, and/or
// sending the connector's own pre-print prefs (auto-level/flow-calibrate/
// timelapse). Which of those actually applies varies by connector (e.g.
// creality-klipper has no real per-slot mapping at all — its
// applyHeadMapping only ever sends a real G29 for autoLevel, a genuine
// 1-3 minute physical wait) — decided here purely from what was actually
// requested (mapped tool count / prefs), never from connector/brand, so no
// connector needs a special case.
function mappingPhaseText(mapped, prefs){
  if(mapped) return t("fleet.print.status_setting_head_mapping");
  if(prefs&&prefs.autoLevel) return t("fleet.print.status_leveling_bed");
  if(prefs&&prefs.flowCalibrate) return t("fleet.print.status_calibrating_flow");
  if(prefs&&prefs.timelapse) return t("fleet.print.status_preparing_timelapse");
  return t("fleet.print.status_setting_head_mapping");
}
// Same decision as mappingPhaseText(), but the short, badge-appropriate
// form (see STATUS_OVERRIDE) — one or two words, matching the existing
// "Idle"/"Printing"/"Paused" badge style rather than a full sentence.
function mappingPhaseBadge(mapped, prefs){
  if(mapped) return { statusColor:"var(--busy)", statusTxt:t("printer_status.mapping_heads") };
  if(prefs&&prefs.autoLevel) return { statusColor:"var(--busy)", statusTxt:t("printer_status.leveling") };
  if(prefs&&prefs.flowCalibrate) return { statusColor:"var(--busy)", statusTxt:t("printer_status.calibrating") };
  if(prefs&&prefs.timelapse) return { statusColor:"var(--busy)", statusTxt:t("printer_status.preparing") };
  return { statusColor:"var(--busy)", statusTxt:t("printer_status.mapping_heads") };
}
// Tracks which job-phase badge is currently pinned on a card, so it FOLLOWS the
// job (Uploading -> Mapping heads -> cleared) rather than sticking at whichever
// phase happened first. Extracted from pollJob so the transitions can be tested:
// every phase badge the upload flow shows rides on this, not just Uploading.
//
// Re-setting the SAME phase is a no-op — pollJob ticks every 400ms and would
// otherwise re-render the fleet several times a second for an unchanged badge.
function makePhaseOverride(printerId, onChange){
  const key=printerId!=null?String(printerId):null;
  let phase=null;
  const changed=typeof onChange==="function"?onChange:()=>renderFleet({incremental:true});
  return {
    set(nextPhase,badge){
      if(!key||phase===nextPhase) return false;
      STATUS_OVERRIDE.set(key,badge); phase=nextPhase; changed(); return true;
    },
    clear(){
      if(!phase||!key){ phase=null; return false; }
      STATUS_OVERRIDE.delete(key); phase=null; changed(); return true;
    },
    get phase(){ return phase; }
  };
}
async function pollJob(jobId, st, start, mapped, btn, extraUI, prefs, printerId){
  const ov=makePhaseOverride(printerId);
  const setOverride=(phase,badge)=>ov.set(phase,badge);
  const clearOverride=()=>ov.clear();
  try{
    for(;;){
      await new Promise(r=>setTimeout(r,400));
      let d;
      try{ d=await getJSON("/api/print-status?job="+encodeURIComponent(jobId)); }catch(e){ continue; }
      if(d.error){
        if(st){ st.className="pstatus err"; st.textContent=d.error; }
        if(extraUI) setRowUI(extraUI, 100, "err", d.error);
        if(btn){ btn.style.background=''; btn.disabled=false; }
        return false;
      }
      // The button itself fills as the upload progress bar — no bar below.
      // The card reads "Idle" while a file is being pushed to the printer --
      // nothing in Klipper's own state changes during an upload. Same
      // client-side badge mechanism the mapping/leveling phases already use.
      if(d.phase==="upload") setOverride("upload",{statusColor:"var(--busy)",statusTxt:t("printer_status.uploading")});
      if(d.phase==="upload" && d.total){
        const pct=Math.min(100,Math.round(d.sent/d.total*100));
        setBtnFill(btn, pct);
        if(extraUI) setRowUI(extraUI, pct, "work", t("fleet.print.status_uploading_pct",{pct}));
      }
      else if(d.phase==="mapping"){
        const mapTxt=mappingPhaseText(mapped, prefs);
        if(st){ st.className="pstatus work"; st.textContent=mapTxt; } setBtnFill(btn,100);
        if(extraUI) setRowUI(extraUI, 100, "work", mapTxt);
        // Klipper's own reported state stays "standby"/idle for the whole
        // physical leveling/calibration pass (see mappingPhaseBadge's own
        // comment) — set once per phase entry, not every 400ms tick.
        setOverride("mapping", mappingPhaseBadge(mapped, prefs));
      }
      else if(d.phase==="preparing"){
        // Reserved for the CFS material-preparation stage (docs/TODO.md 9e).
        // Nothing emits this phase yet -- rendering it here now just means the
        // shared poller is ready when the connector starts reporting it, and
        // costs one branch. No 9e behaviour is implemented anywhere.
        const prepTxt=t("printer_status.preparing");
        if(st){ st.className="pstatus work"; st.textContent=prepTxt; } setBtnFill(btn,100);
        if(extraUI) setRowUI(extraUI, 100, "work", prepTxt);
        setOverride("preparing",{statusColor:"var(--busy)",statusTxt:prepTxt});
      }
      else if(d.phase==="starting"){
        clearOverride();
        if(st){ st.className="pstatus work"; st.textContent=t("fleet.queued.starting_print_status"); } setBtnFill(btn,100);
        if(extraUI) setRowUI(extraUI, 100, "work", t("fleet.queued.starting_print_status"));
      }
      if(d.done){
        clearOverride();
        const doneTxt=start
          ? t(mapped?"fleet.print.status_printing_on_mapped":"fleet.print.status_printing_on", {printer:(d.result&&d.result.printer)||""})
          : t(mapped?"fleet.print.status_uploaded_mapped":"fleet.print.status_uploaded");
        if(st){ st.className="pstatus ok"; st.textContent=doneTxt; }
        if(extraUI) setRowUI(extraUI, 100, "ok", doneTxt);
        if(btn){ btn.style.background=''; btn.disabled=false; }
        return true;
      }
    }
  } finally { clearOverride(); }
}

// ---- Eject / deselect job ----
function clearJobSelection(){
  SELECTED=null; MAP=null; MAPSEL={};
  $('jobcard').classList.remove('show');
  $('jobsechead').style.display='none';
  $('needcount').textContent='';
  document.querySelectorAll('.job.active').forEach(el=>el.classList.remove('active'));
  // mapHtml (the whole T1->color mapping row, including the swatches'
  // "selected" highlight) is baked into each card's innerHTML only when
  // that card is rebuilt (see buildCardHtml's canSend/mapHtml block, gated
  // on SELECTED). Ejecting doesn't change anything in a printer's own
  // server-reported data, so cardSignature() stays identical and
  // reconcileFleetCards() would otherwise leave every card's cached DOM
  // untouched — each one only catching up whenever ITS OWN next unrelated
  // poll-driven rebuild happens to occur, which reads as the mapping row
  // disappearing one printer at a time instead of all at once. A plain,
  // full renderFleet() (not the incremental poll variant) forces every
  // visible card to rebuild immediately, in one pass.
  renderFleet();
}

// ---- Send-to-printers modal ----
// Bulk-send is a single explicit action across possibly many printers with
// different individual defaults — there's no one target to fall back to, so
// unlike pfilemodal these always start unchecked and whatever they show is
// sent as an explicit override to every targeted printer, no per-printer
// fallback (see server.js's applyHeadMapping prefs handling).
let SEND_PREFS={autoLevel:false, flowCalibrate:false, timelapse:false};
function renderSendOpts(){
  const wrap=$("sendOpts");
  const caps={};
  urlFilterFleet(FLEET).forEach(p=>{ if(p.capabilities) Object.keys(p.capabilities).forEach(k=>{ if(p.capabilities[k]) caps[k]=true; }); });
  wrap.innerHTML=printOptsHtml(caps, SEND_PREFS, "sendopt");
  wrap.querySelectorAll("[data-popt]").forEach(el=>{
    el.addEventListener("change",()=>{ SEND_PREFS[el.dataset.popt]=el.checked; });
  });
}

function openSendModal(){
  if(!SELECTED) return;
  const name=SELECTED.split(/[/\\]/).pop();
  $('sendfilename').textContent=name;
  $('sendtitle').textContent=t("fleet.modal.send.title");
  SEND_PREFS={autoLevel:false, flowCalibrate:false, timelapse:false};
  renderSendList();
  renderSendOpts();
  $('sendFooterStatus').textContent='';
  setSendBtnsDisabled(false);
  $('sendmodal').classList.add('show');
}
function closeSendModal(){ $('sendmodal').classList.remove('show'); }

function renderSendList(){
  const detectedBrand=MAP?detectPrinterBrand(MAP.printerModel,MAP.printerSettingsId):null;
  // Monitor-only printers are left out entirely: they can never receive a
  // file, and the Select all / idle / compatible shortcuts must not be able to
  // pick them either.
  $('sendlist').innerHTML=urlFilterFleet(FLEET).filter(p=>!monitorOnly(p)).map(p=>{
    const idle=isIdle(p);
    const dot=p.online?(idle?'var(--ok)':'var(--busy)'):'var(--idle)';
    const {statusTxt}=statusColorText(p);
    const incompatible=isCompatiblePrinter(detectedBrand,p.brand)===false;
    return `<label class="send-row">
      <div class="send-row-fill" data-fill="${esc(p.id)}"></div>
      <input type="checkbox" class="send-chk checkbox-input" data-id="${esc(p.id)}" ${idle?'checked':''}>
      <span class="send-dot" style="background:${dot}"></span>
      <span class="send-name${incompatible?' incompatible':''}">${esc(p.name)}</span>
      <span class="send-status-txt" data-rst="${esc(p.id)}">${esc(statusTxt)}</span>
    </label>`;
  }).join('');
}

function setSendBtnsDisabled(dis){
  ['doUpload','doUploadPrint','sendSelectAll','sendSelectIdle','sendSelectCompatible'].forEach(id=>{ const b=$(id); if(b) b.disabled=dis; });
}

function sendRowUI(id){
  return {
    statusEl: document.querySelector(`.send-status-txt[data-rst="${id}"]`),
    fillEl: document.querySelector(`.send-row-fill[data-fill="${id}"]`)
  };
}

async function doSendUpload(start){
  const checked=[...document.querySelectorAll('.send-chk:checked')].map(c=>c.dataset.id);
  if(!checked.length){ $('sendFooterStatus').textContent=t("fleet.modal.send.select_one"); return; }
  const detectedBrand=MAP?detectPrinterBrand(MAP.printerModel,MAP.printerSettingsId):null;
  const hasIncompatible=checked.some(id=>{
    const row=FLEET.find(p=>p.id===id);
    return row && isCompatiblePrinter(detectedBrand,row.brand)===false;
  });
  if(hasIncompatible && !confirm(t("fleet.modal.send.confirm_incompatible"))) return;
  setSendBtnsDisabled(true);
  $('sendFooterStatus').textContent='';
  // Explicit values, straight from whatever's currently checked — see
  // SEND_PREFS's own comment for why this never falls back to a per-printer
  // default the way pfilemodal does.
  const results=await Promise.all(checked.map(id=>pushTo(id,start,sendRowUI(id),SEND_PREFS)));
  const ok=results.filter(Boolean).length;
  $('sendFooterStatus').textContent=t(ok===checked.length ? "fleet.modal.send.done_summary" : "fleet.modal.send.error_summary", {ok, total:checked.length});
  setSendBtnsDisabled(false);
}

// ---- Confirm dialog (hold or click) ----
// A generic component for destructive actions, in two variants:
//   - mode:"hold" — impossible to trigger by a stray click/Enter, but never
//     requires reading or typing, since the operator may want it
//     immediately (E-Stop: a real emergency).
//   - mode:"click" — friction is information, not time (Cancel print: still
//     destructive, but not an emergency) — a plain click/Enter on the
//     confirm button fires it immediately, no hold.
// Every string/duration/callback/icon comes from the caller — nothing
// action-specific belongs in this component itself.
const HOLD_CONFIRM_MS = 3000;
let HC_STATE = null;
function prefersReducedMotion(){ return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

function openHoldConfirmDialog(opts){
  HC_STATE = {
    mode: opts.mode || "hold",
    idleLabel: opts.idleLabel, countdownLabel: opts.countdownLabel,
    helperIdle: opts.helperIdle, helperHolding: opts.helperHolding,
    holdMs: opts.holdMs || HOLD_CONFIRM_MS, onConfirm: opts.onConfirm,
    sendingLabel: opts.sendingLabel, doneLabel: opts.doneLabel,
    holding:false, raf:null, start:null, sending:false, lastSecond:-1
  };
  $("hcIcon").src = opts.iconSrc || "/estop-icon.svg";
  $("hcTitle").textContent = opts.title;
  $("hcSubtitle").textContent = opts.subtitle || "";
  $("hcSubtitle").style.display = opts.subtitle ? "" : "none";
  const panel=$("hcPanel");
  panel.innerHTML = opts.panelHtml || "";
  panel.style.display = opts.panelHtml ? "" : "none";
  $("hcConsequences").innerHTML = opts.consequencesHtml || "";
  $("hcStatus").style.display="none"; $("hcStatus").className="hc-status"; $("hcStatus").textContent="";
  const btn=$("hcHoldBtn");
  btn.disabled=false;
  $("hcHoldFill").style.width="0%";
  $("hcHoldLabel").textContent=opts.idleLabel;
  $("hcHelper").textContent=HC_STATE.mode==="hold" ? (opts.helperIdle||"") : "";
  $("hcActions").className="hc-actions"+(opts.equalButtons?" equal":"");
  const cancelBtn=$("hcCancel");
  cancelBtn.textContent = opts.cancelLabel || t("common.cancel");
  cancelBtn.disabled=false;
  $("holdConfirmModal").classList.add("show");
  cancelBtn.focus();
}
function closeHoldConfirmDialog(){
  if(HC_STATE && HC_STATE.sending) return; // command already in flight — outcome must be seen, not dismissed
  if(HC_STATE && HC_STATE.raf) cancelAnimationFrame(HC_STATE.raf);
  HC_STATE=null;
  $("holdConfirmModal").classList.remove("show");
}
function hcStartHold(){
  if(!HC_STATE || HC_STATE.mode!=="hold" || HC_STATE.holding || HC_STATE.sending) return;
  HC_STATE.holding=true; HC_STATE.start=performance.now(); HC_STATE.lastSecond=-1;
  $("hcHelper").textContent=HC_STATE.helperHolding;
  const reduced=prefersReducedMotion();
  function tick(now){
    if(!HC_STATE || !HC_STATE.holding) return;
    const elapsed=now-HC_STATE.start;
    if(!reduced) $("hcHoldFill").style.width=Math.min(100, elapsed/HC_STATE.holdMs*100)+"%";
    const secondsLeft=Math.max(0, Math.ceil((HC_STATE.holdMs-elapsed)/1000));
    if(secondsLeft!==HC_STATE.lastSecond){
      HC_STATE.lastSecond=secondsLeft;
      $("hcHoldLabel").textContent=HC_STATE.countdownLabel(secondsLeft);
    }
    if(elapsed>=HC_STATE.holdMs){ hcConfirm(); return; }
    HC_STATE.raf=requestAnimationFrame(tick);
  }
  HC_STATE.raf=requestAnimationFrame(tick);
}
function hcCancelHold(){
  if(!HC_STATE || HC_STATE.mode!=="hold" || !HC_STATE.holding) return;
  HC_STATE.holding=false;
  if(HC_STATE.raf) cancelAnimationFrame(HC_STATE.raf);
  HC_STATE.raf=null;
  $("hcHoldFill").style.width="0%";
  $("hcHoldLabel").textContent=HC_STATE.idleLabel;
  $("hcHelper").textContent=HC_STATE.helperIdle;
}
async function hcConfirm(){
  if(!HC_STATE || HC_STATE.sending) return;
  HC_STATE.holding=false; HC_STATE.sending=true;
  $("hcHoldBtn").disabled=true;
  $("hcCancel").disabled=true;
  $("hcHoldFill").style.width="100%";
  $("hcHoldLabel").textContent=HC_STATE.sendingLabel;
  $("hcHelper").textContent="";
  $("hcStatus").style.display=""; $("hcStatus").className="hc-status work"; $("hcStatus").textContent=HC_STATE.sendingLabel;
  try{
    await HC_STATE.onConfirm();
    if(!HC_STATE) return; // dialog was torn down while awaiting — nothing left to update
    HC_STATE.sending=false;
    $("hcStatus").className="hc-status ok"; $("hcStatus").textContent=HC_STATE.doneLabel;
    $("hcCancel").disabled=false;
    setTimeout(closeHoldConfirmDialog, 1500);
  }catch(e){
    if(!HC_STATE) return;
    HC_STATE.sending=false;
    $("hcStatus").className="hc-status err"; $("hcStatus").textContent=e.message;
    $("hcCancel").disabled=false;
  }
}
function wireHoldConfirmDialog(){
  const btn=$("hcHoldBtn");
  btn.addEventListener("pointerdown", e=>{ if(!HC_STATE||HC_STATE.mode!=="hold") return; e.preventDefault(); hcStartHold(); });
  btn.addEventListener("pointerup", hcCancelHold);
  btn.addEventListener("pointerleave", hcCancelHold);
  btn.addEventListener("pointercancel", hcCancelHold);
  btn.addEventListener("blur", hcCancelHold);
  let keyHolding=false;
  btn.addEventListener("keydown", e=>{
    if(!HC_STATE || HC_STATE.mode!=="hold") return; // click mode: the browser's native Enter/Space-triggers-click handles it
    if((e.key===" "||e.key==="Enter") && !keyHolding){ e.preventDefault(); keyHolding=true; hcStartHold(); }
  });
  btn.addEventListener("keyup", e=>{
    if(e.key===" "||e.key==="Enter"){ keyHolding=false; hcCancelHold(); }
  });
  // Click mode's only trigger — in hold mode this is a no-op guard, since a
  // completed hold already calls hcConfirm() itself from tick() above, and
  // the pointer/keyboard interaction that finished the hold still fires a
  // trailing native "click" afterward that must NOT double-confirm.
  btn.addEventListener("click", ()=>{ if(HC_STATE && HC_STATE.mode==="click") hcConfirm(); });
  $("hcCancel").addEventListener("click", closeHoldConfirmDialog);
  $("holdConfirmModal").addEventListener("click", e=>{ if(e.target===$("holdConfirmModal")) closeHoldConfirmDialog(); });
  document.addEventListener("keydown", e=>{
    if(e.key==="Escape" && $("holdConfirmModal").classList.contains("show")) closeHoldConfirmDialog();
  });
}

async function doEstop(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  const name=(p&&p.name)||"";
  const busy=!!(p&&p.online&&(p.state==="printing"||p.state==="paused"));
  const consequences=[t("fleet.estop.consequence_halt")];
  if(busy) consequences.push(t("fleet.estop.consequence_lose_print"));
  consequences.push(t("fleet.estop.consequence_restart"));
  const consequencesHtml=
    `<div class="hc-consequences-title">${esc(t("fleet.estop.consequences_title"))}</div>`+
    `<ul class="hc-consequences-list">${consequences.map(c=>`<li>${esc(c)}</li>`).join("")}</ul>`+
    `<div class="hc-alt-note">${esc(t("fleet.estop.alternative_note"))}</div>`;
  let panelHtml="";
  if(busy){
    const pct=((p.progress||0)*100).toFixed(1);
    panelHtml=
      `<div class="hc-panel-file" title="${esc(p.filename||"")}">${esc(stripExt(p.filename||""))}</div>`+
      `<div class="hc-panel-pct">${pct}%</div>`+
      `<div class="prog-track red"><div class="prog-fill red" style="width:${pct}%"></div></div>`+
      `<div class="hc-panel-times">${esc(t("fleet.estop.progress_line",{elapsed:fmtDuration(p.elapsed),remaining:fmtRemaining(p.elapsed,p.progress,p.remaining)}))}</div>`;
  }
  const st=$("pst-"+printerId);
  openHoldConfirmDialog({
    mode: "hold",
    iconSrc: "/estop-icon.svg",
    title: t("fleet.estop.title"),
    subtitle: name,
    panelHtml, consequencesHtml,
    idleLabel: t("fleet.estop.hold_label",{printer:name}),
    countdownLabel: n=>t("fleet.estop.hold_label_countdown",{n}),
    helperIdle: t("fleet.estop.helper_idle"),
    helperHolding: t("fleet.estop.helper_holding"),
    holdMs: HOLD_CONFIRM_MS,
    sendingLabel: t("fleet.estop_status_sending"),
    doneLabel: t("fleet.estop_status_done"),
    onConfirm: async ()=>{
      if(st){ st.className="pstatus work"; st.textContent=t("fleet.estop_status_sending"); }
      try{
        const r=await postJSON("/api/printctl",{printer:printerId,action:"estop"});
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
        if(st){ st.className="pstatus err"; st.textContent=t("fleet.estop_status_done"); }
        setTimeout(loadFleet, 1500);
      }catch(e){
        if(st){ st.className="pstatus err"; st.textContent=e.message; }
        throw e;
      }
    }
  });
}

function openPreheat(printerId){
  openBedModal(printerId);
  $("bedmodalinput").value=60;
}

// "Paused"/"Cancelled" reuse the persistent printer_status.* labels (the
// same word describes the state the card ends up in); "Resuming…"/
// "Resumed" and the two other -ing working states have no equivalent
// semantic state (the printer's real state right after resume is
// "printing", not "resumed") so they're Fleet-owned transient text.
const CTL_WORKING_KEYS={pause:"fleet.ctl_status_working_pause",resume:"fleet.ctl_status_working_resume",cancel:"fleet.ctl_status_working_cancel"};
const CTL_DONE_KEYS={pause:"printer_status.paused",resume:"fleet.ctl_status_done_resume",cancel:"printer_status.cancelled"};

// Cancel is destructive but not an emergency — click-confirm (friction is
// information, not time), not the hold variant. The Cancel button only
// ever renders while `busy` (p.online && state printing/paused — see
// buildCardHtml/renderFleetListRows), so there's nothing to additionally
// guard here; if this printer weren't currently printing, the button that
// calls this wouldn't exist on the card at all.
async function doCancelPrint(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  const name=(p&&p.name)||"";
  const pct=((p&&p.progress||0)*100).toFixed(1);
  const filM=p&&p.filamentUsed!=null?(p.filamentUsed/1000).toFixed(1)+"m":"—";
  const panelHtml=
    `<div class="hc-panel-file" title="${esc((p&&p.filename)||"")}">${esc(stripExt((p&&p.filename)||""))}</div>`+
    `<div class="hc-panel-pct">${pct}%</div>`+
    `<div class="prog-track red"><div class="prog-fill red" style="width:${pct}%"></div></div>`+
    `<div class="hc-stats">`+
      `<div class="hc-stat"><span class="hc-stat-label">${esc(t("fleet.progress.elapsed_label"))}</span><span class="hc-stat-val">${esc(fmtDuration(p&&p.elapsed))}</span></div>`+
      `<div class="hc-stat-sep"></div>`+
      `<div class="hc-stat center"><span class="hc-stat-label">${esc(t("fleet.progress.filament_label"))}</span><span class="hc-stat-val">${esc(filM)}</span></div>`+
      `<div class="hc-stat-sep"></div>`+
      `<div class="hc-stat end"><span class="hc-stat-label">${esc(t("fleet.progress.remaining_label"))}</span><span class="hc-stat-val">${esc(fmtRemaining(p&&p.elapsed,p&&p.progress,p&&p.remaining))}</span></div>`+
    `</div>`;
  // Verified against queue/QueueEngine.js's actual onProbeFailedOrCancelled:
  // a printer whose queue believes it's "printing" transitions straight to
  // queue_attention_required on a detected cancel — it does NOT auto-
  // dispatch the next item, and does NOT wait for a bed-clear either. Only
  // printers with a Printer Pool assigned even carry p.queueSummary at all
  // (see /api/fleet) — a standalone printer has no queue to pause.
  const queueLine = (p&&p.queueSummary)
    ? t("fleet.cancelPrint.consequence_queue_managed")
    : t("fleet.cancelPrint.consequence_queue_standalone");
  const consequencesHtml=
    `<div class="hc-consequences-title">${esc(t("fleet.estop.consequences_title"))}</div>`+
    `<ul class="hc-consequences-list">`+
      `<li>${esc(t("fleet.cancelPrint.consequence_stops"))}</li>`+
      `<li>${esc(t("fleet.cancelPrint.consequence_lost",{elapsed:fmtDuration(p&&p.elapsed),filament:filM}))}</li>`+
      `<li>${esc(queueLine)}</li>`+
    `</ul>`+
    `<div class="hc-alt-note">${esc(t("fleet.cancelPrint.alternative_note"))}</div>`;
  const st=$("pst-"+printerId);
  openHoldConfirmDialog({
    mode: "click",
    iconSrc: "/stop-icon.svg",
    title: t("fleet.cancelPrint.title"),
    subtitle: name,
    panelHtml, consequencesHtml,
    equalButtons: true,
    cancelLabel: t("fleet.cancelPrint.keep_printing"),
    idleLabel: t("fleet.cancelPrint.confirm_button"),
    sendingLabel: t(CTL_WORKING_KEYS.cancel),
    doneLabel: t(CTL_DONE_KEYS.cancel),
    onConfirm: async ()=>{
      if(st){ st.className="pstatus work"; st.textContent=t(CTL_WORKING_KEYS.cancel); }
      try{
        const r=await postJSON("/api/printctl",{printer:printerId,action:"cancel"});
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
        if(st){ st.className="pstatus ok"; st.textContent=t(CTL_DONE_KEYS.cancel); }
        loadFleet();
      }catch(e){
        if(st){ st.className="pstatus err"; st.textContent=e.message; }
        throw e;
      }
    }
  });
}

async function ctl(printer, act){
  const st=$("pst-"+printer);
  if(st){ st.className="pstatus work"; st.textContent=t(CTL_WORKING_KEYS[act]); }
  try{
    const r=await postJSON("/api/printctl",{printer,action:act});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    if(st){ st.className="pstatus ok"; st.textContent=t(CTL_DONE_KEYS[act]); }
    loadFleet();
  }catch(e){ if(st){ st.className="pstatus err"; st.textContent=e.message; } }
}

// ---- Print a file already stored on the printer ----
let PFILE_PRINTER=null, PFILE_SELECTED=null, PFILE_META=null, PFILE_MAP={}, PFILE_FILES=[];
let PFILE_PREFS={autoLevel:false, flowCalibrate:false, timelapse:false};
function renderPfileOpts(){
  const wrap=$("pfileOpts");
  const p=FLEET.find(f=>f.id===PFILE_PRINTER);
  wrap.innerHTML=printOptsHtml(p&&p.capabilities, PFILE_PREFS, "pfileopt");
  wrap.querySelectorAll("[data-popt]").forEach(el=>{
    el.addEventListener("change",()=>{ PFILE_PREFS[el.dataset.popt]=el.checked; });
  });
}
function renderPfileInfo(){
  const wrap=$("pfileinfo");
  if(!PFILE_META||!PFILE_SELECTED){ wrap.innerHTML=""; return; }
  // Pass the filename unmodified — Moonraker connectors strip the extension
  // themselves internally (their thumbnail cache is stem-keyed), but
  // FlashForge's getThumbnail wants the exact filename and misreads a
  // pre-stripped one as "not found", falling back to a generic icon.
  const thumb=`/api/thumbnail?printer=${PFILE_PRINTER}&file=${encodeURIComponent(PFILE_SELECTED)}`;
  const totalGrams=PFILE_META.palette.reduce((sum,s)=>sum+(parseFloat(s.wt)||0),0);
  const timeSec=PFILE_META.estimatedTime||0;
  const fCost=(FILAMENT_COST>0&&totalGrams>0)?(FILAMENT_COST/1000)*totalGrams:0;
  const eCost=(ELECTRICITY_RATE>0&&timeSec>0)?ELECTRICITY_RATE*(timeSec/3600):0;
  const totalCost=fCost+eCost;
  wrap.innerHTML=`<div class="pfi-card">`+
    `<img class="pfi-thumb" src="${thumb}" onerror="this.style.display='none'" alt="">`+
    `<div class="pfi-stats">`+
    (timeSec>0?`<div class="pfi-row"><span class="pfi-lbl">${esc(t("fleet.modal.pfile.print_time_label"))}</span><span class="pfi-val">${fmtDuration(timeSec)}</span></div>`:'')+
    (totalGrams>0?`<div class="pfi-row"><span class="pfi-lbl">${esc(t("fleet.modal.pfile.filament_label"))}</span><span class="pfi-val">${totalGrams.toFixed(1)} g</span></div>`:'')+
    (totalCost>0?`<div class="pfi-row"><span class="pfi-lbl">${esc(t("fleet.modal.pfile.est_cost_label"))}</span><span class="pfi-val">$${totalCost.toFixed(2)}</span></div>`:'')+
    `</div></div>`;
}

function openPrinterFiles(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  PFILE_PRINTER=printerId; PFILE_SELECTED=null; PFILE_META=null; PFILE_MAP={}; PFILE_FILES=[];
  // All three default to this printer's own configured preference (Settings
  // > printer > Behavior) — same as they always applied before there was a
  // per-job checkbox.
  PFILE_PREFS={autoLevel:!!p.autoLevel, flowCalibrate:!!p.flowCalibrate, timelapse:!!p.timelapse};
  renderPfileOpts();
  $("pfiletitle").textContent=t("fleet.modal.pfile.title",{printer:p.name});
  $("pfileSearch").value="";
  $("pfileinfo").innerHTML="";
  $("pfilelist").innerHTML=`<div class="browse-empty">${esc(t("fleet.modal.pfile.loading"))}</div>`;
  $("pfilemap").innerHTML="";
  $("pfileStatus").textContent="";
  $("pfilego").disabled=true;
  $("pfilemodal").classList.add("show");
  loadPrinterFiles();
}
function closePrinterFiles(){ $("pfilemodal").classList.remove("show"); PFILE_PRINTER=null; PFILE_SELECTED=null; PFILE_META=null; PFILE_MAP={}; $("pfileinfo").innerHTML=""; $("pfileOpts").innerHTML=""; }
async function loadPrinterFiles(){
  if(PFILE_PRINTER===null) return;
  try{
    const d=await getJSON("/api/printer-files?printer="+PFILE_PRINTER);
    if(d.error) throw new Error(d.error);
    PFILE_FILES=d.files||[];
    renderPfileList();
  }catch(e){
    $("pfilelist").innerHTML='<div class="browse-empty" style="color:var(--bad)">'+esc(e.message)+'</div>';
  }
}
function renderPfileList(){
  if(PFILE_PRINTER===null) return;
  if(!PFILE_FILES.length){ $("pfilelist").innerHTML=`<div class="browse-empty">${esc(t("fleet.modal.pfile.no_files"))}</div>`; return; }
  const q=$("pfileSearch").value.trim().toLowerCase();
  const shown=PFILE_FILES.filter(f=>!q||f.path.toLowerCase().includes(q));
  if(!shown.length){ $("pfilelist").innerHTML=`<div class="browse-empty">${esc(t("fleet.modal.pfile.no_matches"))}</div>`; return; }
  $("pfilelist").innerHTML=shown.map(f=>{
    const bare=stripExt(f.path);
    const disp=bare.length>40?bare.slice(0,37)+"…":bare;
    const isSel=PFILE_SELECTED===f.path;
    const fsBadge=isSel&&PFILE_META&&PFILE_META.isFS?`<img src="/fs-badge.svg" class="fs-badge" title="${esc(t("files.full_spectrum_title"))}">`:``;
    return `<button class="plate-item${isSel?" sel":""}" data-f="${esc(f.path)}" title="${esc(f.path)}">`+
      `<span class="pi-check" aria-hidden="true">${isSel?"✓":""}</span><span class="pi-name">${esc(disp)}${fsBadge}</span>`+
      `<span class="pi-tag">${fmtSize(f.size)} · ${fmtTime(f.modified*1000)}</span></button>`;
  }).join("");
  $("pfilelist").querySelectorAll("[data-f]").forEach(el=>{
    el.addEventListener("click",()=>{
      PFILE_SELECTED=el.dataset.f;
      $("pfilelist").querySelectorAll(".plate-item").forEach(x=>{
        x.classList.toggle("sel", x.dataset.f===PFILE_SELECTED);
        x.querySelector(".pi-check").textContent = x.dataset.f===PFILE_SELECTED?"✓":"";
      });
      $("pfilego").disabled=false;
      loadPfileMeta(el.dataset.f);
    });
  });
}
async function loadPfileMeta(file){
  PFILE_META=null; PFILE_MAP={};
  $("pfileinfo").innerHTML="";
  $("pfilemap").innerHTML=`<div class="browse-empty">${esc(t("fleet.modal.pfile.reading_colors"))}</div>`;
  try{
    const meta=await getJSON("/api/printer-file-meta?printer="+PFILE_PRINTER+"&file="+encodeURIComponent(file));
    if(PFILE_SELECTED!==file) return; // user already clicked another file
    if(meta.error) throw new Error(meta.error);
    PFILE_META=meta;
    const p=FLEET.find(f=>f.id===PFILE_PRINTER);
    PFILE_MAP=defaultMapping(meta.palette.filter(s=>s.used), (p&&p.heads)||[]);
    renderPfileInfo();
    renderPfileList();
    renderPfileMap();
  }catch(e){
    if(PFILE_SELECTED===file) $("pfilemap").innerHTML='<div class="browse-empty" style="color:var(--bad)">'+esc(e.message)+'</div>';
  }
}
function renderPfileMap(){
  const wrap=$("pfilemap");
  const p=FLEET.find(f=>f.id===PFILE_PRINTER);
  if(!PFILE_META||!ALLOW_MAPPING||!p?.capabilities?.headMapping){ wrap.innerHTML=""; return; }
  const allHeads=Array.from({length:4},(_,i)=>{ const h=(p&&p.heads&&p.heads[i])||null; return {hi:i,h}; });
  if(!allHeads.some(x=>x.h&&x.h.loaded)){ wrap.innerHTML=`<div class="browse-empty">${esc(t("fleet.modal.pfile.no_filament_loaded"))}</div>`; return; }
  // A single-material file (or a connector, like the AD5X, whose per-color
  // metadata only exists for multi-material jobs) reports an empty palette —
  // that still means "pick which loaded slot feeds this print", not "nothing
  // to pick", so fall back to one unnamed slot standing in for the whole file.
  const paletteNeed=PFILE_META.palette.filter(s=>s.used);
  const need=paletteNeed.length?paletteNeed:[{i:0,hex:null,type:'',wt:''}];
  const rows=need.map(n=>{
    const chosen=PFILE_MAP[n.i]!==undefined?String(PFILE_MAP[n.i]):"";
    const hbtns=allHeads.map(({hi,h})=>{
      const loaded=!!(h&&h.loaded);
      const isSel=chosen!==""&&chosen===String(hi);
      const bg=esc(loaded?(h.hex||'#3a3f49'):'#2a2d36');
      const hDark=needsDarkText(loaded?h.hex:null);
      return `<button class="hs-sq${isSel?' selected':''}${loaded?'':' empty'}${hDark?' light-bg':''}" style="background:${bg}" data-pfi="${n.i}" data-phi="${hi}"${loaded?'':' disabled'}>` +
             `<span class="hs-lbl">T${hi+1}</span>` +
             `<span class="hs-mat">${esc(loaded&&h.material?h.material:'')}</span></button>`;
    }).join("");
    const info=[n.type, n.wt?Math.ceil(parseFloat(n.wt))+'g':''].filter(Boolean).join(', ');
    const fDark=needsDarkText(n.hex);
    const assignedHpf=chosen!==""?allHeads[parseInt(chosen)]?.h:null;
    const matMismatchPf=!!(n.type&&assignedHpf?.material&&n.type.trim().toLowerCase()!==assignedHpf.material.trim().toLowerCase());
    return `<div class="cmaprow">` +
           `<div class="fsq${fDark?' light-bg':''}" style="background:${esc(n.hex||'#3a3f49')}"><span class="fsq-t">T${n.i+1}</span>${info?`<span class="fsq-info">${esc(info)}</span>`:''}</div>` +
           `<span class="arrow">${matMismatchPf?'❌':'➜'}</span><div class="head-btns">${hbtns}</div></div>`;
  }).join("");
  wrap.innerHTML=`<div class="cmap"><div class="cmaphdr-row"><span class="cmaphdr">${esc(t("fleet.card.model_color_header"))}</span><span class="cmaphdr">${esc(t("fleet.card.printer_toolheads_header"))}</span></div>${rows}</div>`;
  wrap.querySelectorAll(".hs-sq").forEach(b=>{
    b.addEventListener("click",()=>{
      PFILE_MAP[parseInt(b.dataset.pfi,10)]=parseInt(b.dataset.phi,10);
      renderPfileMap();
    });
  });
}
async function doPrintFile(){
  if(PFILE_PRINTER===null||!PFILE_SELECTED) return;
  const st=$("pfileStatus");
  st.textContent=t("fleet.queued.starting_print_status");
  $("pfilego").disabled=true;
  try{
    const r=await postJSON("/api/printfile",{printer:PFILE_PRINTER,filename:PFILE_SELECTED,map:ALLOW_MAPPING?PFILE_MAP:{},prefs:PFILE_PREFS});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    // Same job-based contract as printQueuedFile: the modal must not close on
    // the 200, or it would hide a mapping/start failure that lands seconds or
    // minutes later. btn is deliberately null -- pollJob's button fill would
    // fight this modal's own disabled-button handling.
    const ok=await pollJob(d.jobId, st, true, d.mapped||0, null, null, PFILE_PREFS, PFILE_PRINTER);
    if(ok) setTimeout(()=>{ closePrinterFiles(); loadFleet(); },900);
    else $("pfilego").disabled=false;
  }catch(e){ st.textContent=e.message; $("pfilego").disabled=false; }
}

// ---- Eject file ----
async function ejectFile(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p) return;
  try{
    const r=await fetch('/api/printctl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({printer:printerId,action:'eject'})});
    if(!r.ok){ const j=await r.json().catch(()=>({})); console.error('Eject failed',j.error); }
  }catch(e){ console.error('Eject error',e.message); }
  // Refresh the card this just changed, the same way every other action does.
  // Without it the "Loaded" badge and filename sat stale until whichever poll
  // happened to come round next.
  loadFleet();
}

// ---- Camera snapshot ----
let SNAP_PRINTER=null;
function openSnapshot(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p) return;
  SNAP_PRINTER=printerId;
  $("snaptitle").textContent=t("fleet.modal.snapshot.title",{printer:p.name});
  $("snapwrap").innerHTML='<span style="color:var(--ink-dim)">'+esc(t("fleet.modal.snapshot.loading"))+'</span>';
  $("snapts").textContent='';
  $("snapmodal").classList.add("show");
  loadSnapshot();
}
function closeSnapshot(){
  $("snapmodal").classList.remove("show");
  // Only a session this modal opened — a Camera View tile's session keeps
  // running behind the modal.
  if(SNAP_RTC_OWNED!=null){ closeCamRtc(SNAP_RTC_OWNED); SNAP_RTC_OWNED=null; }
  closeCamStream("snap");
  SNAP_PRINTER=null;
}
// Gives the Snapshot modal something to capture from. In Camera View a tile
// is already streaming and that session is reused untouched; from any other
// view — the card's camera button, the list view — nothing is connected, so
// the modal opens its own short-lived session against an offscreen <video>
// and closes it when the modal closes. Without this the modal could only
// ever work while Camera View happened to be open, which is where the
// "still connecting" message came from.
let SNAP_RTC_OWNED=null; // printer id whose session this modal opened
async function camRtcFrameSource(printerId,url){
  const live=CAM_RTC.get(printerId);
  if(live&&live.video&&live.video.videoWidth) return live.video; // Camera View's, left alone
  if(!url) throw new Error(t("fleet.camera.no_feed"));
  const video=document.createElement("video");
  video.autoplay=true; video.playsInline=true; video.muted=true;
  await openCamRtc(printerId,url,video);
  SNAP_RTC_OWNED=live?null:printerId; // only ours to close if it wasn't already running
  // A frame has to actually arrive before the canvas has anything to draw:
  // the peer connection resolves before the first decoded frame.
  const deadline=Date.now()+8000;
  while(!video.videoWidth&&Date.now()<deadline) await new Promise(r=>setTimeout(r,150));
  if(!video.videoWidth) throw new Error(t("fleet.modal.snapshot.webrtc_not_ready"));
  return video;
}
// Captures the frame currently showing in a live WebRTC tile. A MediaStream
// has no origin, so unlike a cross-origin <img> it does not taint the canvas
// and toBlob() returns real JPEG bytes. Nothing is uploaded — this stays in
// the browser (no server-side frame cache in this version).
async function captureCamRtcFrame(video){
  if(!video||!video.videoWidth||!video.videoHeight) throw new Error(t("fleet.modal.snapshot.webrtc_not_ready"));
  const canvas=document.createElement("canvas");
  canvas.width=video.videoWidth; canvas.height=video.videoHeight;
  canvas.getContext("2d").drawImage(video,0,0,canvas.width,canvas.height);
  return new Promise((resolve,reject)=>{
    canvas.toBlob(b=>b?resolve(b):reject(new Error(t("fleet.modal.snapshot.webrtc_capture_failed"))),"image/jpeg",0.9);
  });
}
async function loadSnapshot(){
  if(SNAP_PRINTER===null) return;
  const wrap=$("snapwrap");
  wrap.innerHTML='<span style="color:var(--ink-dim)">'+esc(t("fleet.modal.snapshot.loading"))+'</span>';
  $("snapts").textContent='';
  // A relayed stream (Bambu Lab) is shown LIVE in the modal rather than as a
  // still: the video is already the best picture there is, and a still frame
  // would need ffmpeg on the server. Refresh reconnects it.
  const streamPrinter=FLEET.find(f=>f.id===SNAP_PRINTER);
  if(streamPrinter&&streamPrinter.capabilities?.cameraStream){
    const video=document.createElement("video");
    video.autoplay=true; video.playsInline=true; video.muted=true; video.controls=false;
    video.style.cssText='max-width:100%;max-height:65vh;border-radius:8px;display:block;margin:0 auto;background:#1b1e24;min-width:240px;min-height:135px';
    wrap.innerHTML=''; wrap.appendChild(video);
    $("snapts").textContent=t("fleet.camera.live");
    const forPrinter=SNAP_PRINTER;
    openCamStream("snap",forPrinter,video).catch(e=>{
      if(SNAP_PRINTER!==forPrinter||!video.isConnected) return;
      wrap.innerHTML='<span style="color:var(--ink-dim)">'+esc(e.message)+'</span>';
      $("snapts").textContent='';
    });
    return;
  }
  // A WebRTC-only camera has no /api/snapshot to call — the frame can only
  // come from a live session in this browser, so the modal grabs one from
  // the tile that is already streaming in Camera View.
  const rtcPrinter=FLEET.find(f=>f.id===SNAP_PRINTER);
  if(rtcPrinter&&rtcPrinter.capabilities?.cameraWebrtc&&!rtcPrinter.capabilities?.cameraSnapshot){
    try{
      if(!camRtcContextSupported()) throw new Error(t("fleet.camera.lan_only"));
      const video=await camRtcFrameSource(SNAP_PRINTER,rtcPrinter.cameraWebrtcUrl);
      const blob=await captureCamRtcFrame(video);
      const img=new Image();
      img.style.cssText='max-width:100%;max-height:65vh;border-radius:8px;display:block;margin:0 auto';
      img.onload=()=>{ wrap.innerHTML=''; wrap.appendChild(img); $("snapts").textContent=t("fleet.modal.snapshot.captured_at",{time:new Date().toLocaleTimeString()}); };
      img.src=URL.createObjectURL(blob);
    }catch(e){
      wrap.innerHTML='<span style="color:var(--ink-dim)">'+esc(e.message)+'</span>';
    }
    return;
  }
  try{
    // fresh=1: this is an explicit user action (opening the modal, clicking
    // Refresh) — always bypass the server's short-lived snapshot cache
    // (used to throttle the camera-view grid's automatic polling) so a
    // manual refresh never shows the same frame it just showed.
    const r=await fetch('/api/snapshot?printer='+SNAP_PRINTER+'&fresh=1&t='+Date.now());
    if(!r.ok){
      let msg=t("fleet.modal.snapshot.server_error",{status:r.status});
      try{ const j=await r.json(); msg=j.error||msg; }catch{}
      wrap.innerHTML='<span style="color:var(--ink-dim)">'+esc(msg)+'</span>';
      return;
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const img=new Image();
    img.style.cssText='max-width:100%;max-height:65vh;border-radius:8px;display:block;margin:0 auto';
    img.onload=()=>{ wrap.innerHTML=''; wrap.appendChild(img); $("snapts").textContent=t("fleet.modal.snapshot.captured_at",{time:new Date().toLocaleTimeString()}); };
    img.src=url;
  }catch(e){
    wrap.innerHTML='<span style="color:var(--ink-dim)">'+esc(e.message)+'</span>';
  }
}

// ---- Thumbnail preview ----
function openThumb(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  // Same "Loaded" precedence as the card/list file-name slots (see
  // statusColorText) — otherwise this would enlarge the last-printed file's
  // thumbnail instead of the one the card is actually showing right now.
  const queuedReady=p.queuedFile&&p.queuedFile.status==='ready'?p.queuedFile.name:null;
  const name=queuedReady||p.filename;
  $("thumbtitle").textContent=p.name+(name?' — '+name:'');
  const w=$("thumbwrap");
  if(!name){ w.innerHTML='<span style="color:var(--ink-dim)">No file loaded</span>'; }
  else {
    const stem=name;
    w.innerHTML='<img src="/api/thumbnail?printer='+p.id+'&file='+encodeURIComponent(stem)+'&t='+thumbToken(p,stem)+'" style="max-width:100%;border-radius:8px" onerror="this.parentNode.innerHTML=\'<span style=color:var(--ink-dim)>No thumbnail available</span>\'">';
  }
  $("thumbmodal").classList.add("show");
}
function closeThumb(){ $("thumbmodal").classList.remove("show"); }

// ---- Unload confirmation + inline color editing ----
// Clicking a loaded spool opens this dialog directly — Change Color lives
// inside it (the "Edit color" button on the spool card), not as a separate
// up-front choice. Only ever opened for a head that actually has filament —
// an empty slot has nothing to act on, so afcLanesHtml() never wires a click
// target for one.
// A general-purpose named filament-color list — unlike flashforge-ad5x.js's
// COLOR_PALETTE (which only lists exactly what THAT printer's own
// touchscreen can display), this isn't tied to any one connector's fixed
// icon set. 6 per row by design (see the picker's grid).
const SPOOL_COLOR_PALETTE=[
  {name:"White",hex:"#FFFFFF"},{name:"Natural",hex:"#F2EAD8"},{name:"Beige",hex:"#E8DCC8"},
  {name:"Silver",hex:"#C7CCD1"},{name:"Gray",hex:"#8A8F98"},{name:"Black",hex:"#161616"},
  {name:"Red",hex:"#E4332A"},{name:"Maroon",hex:"#7A1F2B"},{name:"Orange",hex:"#F07C1E"},
  {name:"Gold",hex:"#D9A441"},{name:"Yellow",hex:"#F5D629"},{name:"Olive",hex:"#7C7A34"},
  {name:"Lime",hex:"#8FD13F"},{name:"Green",hex:"#2FA84F"},{name:"Teal",hex:"#128277"},
  {name:"Cyan",hex:"#22C2D6"},{name:"Sky Blue",hex:"#4FB4E8"},{name:"Blue",hex:"#2A6FE0"},
  {name:"Navy",hex:"#1B3B77"},{name:"Purple",hex:"#6E3FA3"},{name:"Violet",hex:"#9B5FD1"},
  {name:"Magenta",hex:"#C43FA8"},{name:"Pink",hex:"#EC8FC0"},{name:"Rose",hex:"#D65A72"},
  {name:"Brown",hex:"#7A4B2E"},{name:"Tan",hex:"#C9A876"},{name:"Copper",hex:"#B5702F"},
  {name:"Bronze",hex:"#8C6B2E"},{name:"Mint",hex:"#7FE0C0"},{name:"Lavender",hex:"#C3B3EA"}
];
function nameForHex(hex){
  const m=SPOOL_COLOR_PALETTE.find(c=>c.hex.toUpperCase()===hex.toUpperCase());
  return m?m.name:null;
}

// Small inline glyphs, currentColor-based, matching the QUEUE_OFFLINE_ICON
// convention already used elsewhere — decorative alongside text that already
// says what they mean, so aria-hidden.
const UNLOAD_WARN_ICON=`<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M7 1.5 L13 12.5 L1 12.5 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><rect x="6.3" y="5" width="1.4" height="4" rx="0.4" fill="currentColor"/><circle cx="7" cy="10.3" r="0.9" fill="currentColor"/></svg>`;
const UNLOAD_LOCK_ICON=`<svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true"><rect x="3" y="6.5" width="8" height="6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 6.5 V4.5 a2.5 2.5 0 0 1 5 0 V6.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

// SPOOL_MODAL_* names are kept from when this state belonged only to the old
// standalone color-picker modal — it's now the unload dialog's own state
// (target head, current vs pending color, which palette source applies).
let SPOOL_MODAL_PRINTER=null, SPOOL_MODAL_EXT=null, SPOOL_MODAL_CURRENT=null, SPOOL_MODAL_PENDING=null,
    SPOOL_MODAL_TAB="palette", SPOOL_MODAL_FIXED_PALETTE=null, SPOOL_MODAL_DIRTY=false;
let UNLOAD_DIALOG_MODE="unload"; // "unload" | "color" — mutually exclusive views sharing one dialog

function openUnload(printerId,ext){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  const h=(p.heads&&p.heads[ext])||null;
  if(!h||!h.loaded) return; // nothing to unload — empty heads have no click target at all

  SPOOL_MODAL_PRINTER=printerId; SPOOL_MODAL_EXT=ext;
  UNLOAD_DIALOG_MODE="unload";
  $("unloadModeBody").style.display="";
  $("unloadColorMode").style.display="none";
  $("unloadYes").style.display="";
  $("unloadSaveColorBtn").style.display="none";

  $("unloadtitle").textContent=t("fleet.modal.unload.title",{head:headLabel(ext)});
  $("unloadSubtitle").textContent=p.name+".";
  $("unloadmsg").textContent=t("fleet.modal.unload.confirm_message",{head:headLabel(ext)});
  $("unloadStatus").textContent="";

  const currentHex=h.hex?h.hex.toUpperCase():null;
  const currentName=currentHex&&nameForHex(currentHex);
  $("unloadSwatch").style.background=h.hex||"#383a4a";

  // An official Snapmaker RFID spool reports its color from the tag itself —
  // firmware refuses a color write for one outright (see setFilamentColor),
  // so this dialog doesn't offer to try. isRfid overrides capabilities.setColor
  // entirely, not just the fixed-vs-arbitrary palette choice below it.
  const isRfid=!!h.official;
  const hasFixedPalette=Array.isArray(p.colorPalette)&&p.colorPalette.length;
  const canEditColor=!!(p.capabilities&&p.capabilities.setColor)&&!isRfid;
  SPOOL_MODAL_FIXED_PALETTE=hasFixedPalette?p.colorPalette:null;

  $("unloadEditColorBtn").style.display=canEditColor?"":"none";
  $("unloadRfidBadge").innerHTML=isRfid?(UNLOAD_LOCK_ICON+esc(t("fleet.modal.unload.rfid_badge"))):"";
  $("unloadRfidBadge").style.display=isRfid?"":"none";
  $("unloadColorTabs").style.display=hasFixedPalette?"none":"";

  if(isRfid){
    $("unloadLine1").textContent=(h.material||t("fleet.modal.unload.unknown_material"))+(currentHex?" · "+currentHex:"");
    $("unloadRfidNote").textContent=t("fleet.modal.unload.rfid_note");
    $("unloadRfidNote").style.display="";
  } else {
    // currentName is a user-selected/palette color name — data, not
    // SnapCon-owned prose (see section 9's "user-selected color names
    // represent data" rule) — only the "Custom"/"Unknown material"
    // fallbacks are ours to translate.
    $("unloadLine1").textContent=(currentName||t("fleet.modal.unload.custom_fallback"))+" · "+(h.material||t("fleet.modal.unload.unknown_material"));
    $("unloadRfidNote").style.display="none";
  }

  SPOOL_MODAL_CURRENT={hex:currentHex,name:currentName};
  SPOOL_MODAL_PENDING={hex:currentHex||"#FFFFFF",name:currentName};
  SPOOL_MODAL_TAB="palette";
  SPOOL_MODAL_DIRTY=false;

  renderUnloadPrintWarning(p);

  // Only worth offering "unload everything" when some OTHER head also has
  // something loaded — three empty heads alongside the target isn't a
  // decision, it's a no-op dressed up as one.
  const n=(p.heads||[]).length;
  const otherLoaded=(p.heads||[]).filter((hh,i)=>i!==ext&&hh&&hh.loaded).length;
  $("unloadAllCheck").checked=false;
  $("unloadAllRow").style.display=otherLoaded>0?"":"none";
  $("unloadAllLabel").textContent=t("fleet.modal.unload.unload_all_instead",{n});
  updateUnloadConfirmLabel();

  $("unloadYes").onclick=()=>{
    const checked=$("unloadAllCheck").checked;
    const extruders=checked?[...Array(n).keys()]:[ext];
    doUnload(printerId,extruders);
  };

  $("unloadmodal").classList.add("show");
}
function closeUnload(){ $("unloadmodal").classList.remove("show"); }
// Cancel is mode-aware: backs out of color mode (discarding any pending pick)
// rather than closing the whole dialog when a color edit is in progress.
function unloadCancelClicked(){
  if(UNLOAD_DIALOG_MODE==="color") exitColorMode();
  else closeUnload();
}

function updateUnloadConfirmLabel(){
  const p=FLEET.find(f=>f.id===SPOOL_MODAL_PRINTER);
  const n=(p&&p.heads)?p.heads.length:0;
  const checked=$("unloadAllCheck").checked;
  $("unloadYes").textContent=checked?t("fleet.modal.unload.unload_all_button",{n}):t("fleet.modal.unload.unload_one_button",{head:headLabel(SPOOL_MODAL_EXT)});
}

// p.state is only ever "printing"/"paused" here (see the guard below) — its
// RAW value still drives the guard/logic, but the sentence needs the
// TRANSLATED presentation (printer_status.*) or a Spanish sentence would
// otherwise have a bare English word ("Esta impresora está printing")
// stitched into the middle of it.
function renderUnloadPrintWarning(p){
  const el=$("unloadPrintWarning");
  if(p.state==="printing"||p.state==="paused"){
    const pct=(typeof p.progress==="number")?Math.round(p.progress*100):null;
    const state=t("printer_status."+p.state);
    const msg=pct!=null?t("fleet.modal.unload.print_warning_pct",{state,pct}):t("fleet.modal.unload.print_warning",{state});
    el.innerHTML=UNLOAD_WARN_ICON+`<span>${esc(msg)}</span>`;
    el.style.display="";
  } else {
    el.style.display="none"; el.innerHTML="";
  }
}

async function doUnload(printerId,extruders){
  // Color mode owns the only way to end up with an unsaved pending pick, and
  // both of its own exits (Apply, Cancel) resolve it before this is ever
  // reachable — Apply saves-and-closes the whole dialog, Cancel discards and
  // returns here with SPOOL_MODAL_DIRTY reset. So there's never a pending
  // change sitting around by the time Unload can be clicked.
  const st=$("unloadStatus");
  st.className="pstatus work"; st.textContent=t("fleet.modal.unload.status_unloading");
  try{
    const r=await postJSON("/api/unload",{printer:printerId,extruders});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=t("fleet.modal.unload.status_command_sent");
    setTimeout(()=>{ closeUnload(); loadFleet(); },1500);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// ---- Color mode: a full-focus view that replaces the unload body entirely
// while active — no unload confirmation, checkbox, or Unload button visible
// alongside it. Entered via "Edit color", exited via Cancel (discard, back to
// the unload view) or Apply (save, close the whole dialog). ----
function enterColorMode(){
  UNLOAD_DIALOG_MODE="color";
  const p=FLEET.find(f=>f.id===SPOOL_MODAL_PRINTER);
  $("unloadtitle").textContent=t("fleet.modal.unload.color_mode_title");
  $("unloadSubtitle").textContent=t("fleet.modal.unload.color_mode_subtitle",{head:headLabel(SPOOL_MODAL_EXT),printer:(p&&p.name)||""});
  $("unloadModeBody").style.display="none";
  $("unloadColorMode").style.display="";
  $("unloadYes").style.display="none";
  $("unloadSaveColorBtn").style.display="";
  $("unloadStatus").textContent="";

  // Always starts fresh from the last-saved value — an unsaved pick from a
  // previous visit to this mode is gone, matching "Cancel discards it".
  SPOOL_MODAL_PENDING={hex:SPOOL_MODAL_CURRENT.hex||"#FFFFFF",name:SPOOL_MODAL_CURRENT.name};
  SPOOL_MODAL_TAB="palette";
  SPOOL_MODAL_DIRTY=false;
  $("unloadSaveColorBtn").disabled=true;

  updateUnloadCompareSwatches();
  renderUnloadColorTabs();
  renderUnloadPaletteGrid();
  syncCustomFieldsFromPending();
}
function exitColorMode(){
  UNLOAD_DIALOG_MODE="unload";
  const p=FLEET.find(f=>f.id===SPOOL_MODAL_PRINTER);
  $("unloadtitle").textContent=t("fleet.modal.unload.title",{head:headLabel(SPOOL_MODAL_EXT)});
  $("unloadSubtitle").textContent=((p&&p.name)||"")+".";
  $("unloadColorMode").style.display="none";
  $("unloadModeBody").style.display="";
  $("unloadSaveColorBtn").style.display="none";
  $("unloadYes").style.display="";
  $("unloadStatus").textContent="";
}
function updateUnloadCompareSwatches(){
  $("unloadNowSwatch").style.background=SPOOL_MODAL_CURRENT.hex||"#2a2d36";
  $("unloadNowSwatch").style.opacity=SPOOL_MODAL_CURRENT.hex?"1":".5";
  $("unloadPendingSwatch").style.background=SPOOL_MODAL_PENDING.hex;
  $("unloadPendingName").textContent=SPOOL_MODAL_PENDING.name||t("fleet.modal.unload.custom_fallback");
  $("unloadPendingHex").textContent=SPOOL_MODAL_PENDING.hex;
}
function renderUnloadColorTabs(){
  $("unloadPalettePane").style.display=SPOOL_MODAL_TAB==="palette"?"":"none";
  $("unloadCustomPane").style.display=SPOOL_MODAL_TAB==="custom"?"":"none";
  document.querySelectorAll("#unloadColorTabs .scc-tab").forEach(b=>b.classList.toggle("active",b.dataset.scctab===SPOOL_MODAL_TAB));
}

// hex/name: the color to move to. opts.skip{HexField,Native,Rgb}: which
// Custom-tab field to leave alone because IT is the one the user is
// actively typing into (rewriting it mid-edit would fight their cursor).
function setPendingColor(hex,name,opts){
  opts=opts||{};
  hex=hex.toUpperCase();
  // No baked-English fallback stored here — SPOOL_MODAL_PENDING is
  // display-derived state (updateUnloadCompareSwatches applies the
  // translated "Custom" fallback at render time), never a place a
  // translated string should live persistently.
  SPOOL_MODAL_PENDING={hex,name};
  SPOOL_MODAL_DIRTY=true;
  renderUnloadPaletteGrid();
  updateUnloadCompareSwatches();
  $("unloadSaveColorBtn").disabled=false;
  if(!opts.skipHexField) $("unloadHexField").value=hex;
  if(!opts.skipNative) $("unloadColorInput").value=hex;
  if(!opts.skipRgb){ const rgb=hexRGB(hex)||[255,255,255]; $("unloadR").value=rgb[0]; $("unloadG").value=rgb[1]; $("unloadB").value=rgb[2]; }
  $("unloadHexError").style.display="none";
}
function selectSpoolColor(hex,name){ setPendingColor(hex,name); }

function swatchHtmlFor(c){
  const isLight=needsDarkText(c.hex);
  const selected=SPOOL_MODAL_PENDING&&SPOOL_MODAL_PENDING.hex===c.hex.toUpperCase();
  // c.name is real palette/data identity when present (untranslated, see
  // section 9) — the "Custom" fallback for an unnamed swatch (e.g. a
  // fleet-recent color with no known name) is translated for DISPLAY only;
  // the round-tripped data-sccname attribute stays "" so a click through
  // setPendingColor() never bakes an English (or Spanish) word into stored
  // state — see setPendingColor()'s own no-baked-fallback comment.
  const displayName=c.name||t("fleet.modal.unload.custom_fallback");
  return `<button type="button" class="color-swatch${selected?' selected':''}${isLight?' light':''}" `+
    `style="background:${esc(c.hex)}" aria-pressed="${selected}" `+
    `title="${esc(displayName)} (${esc(c.hex.toUpperCase())})" aria-label="${esc(displayName)}" data-scchex="${esc(c.hex)}" data-sccname="${esc(c.name||"")}"></button>`;
}
function wireSwatchGrid(gridEl){
  gridEl.querySelectorAll(".color-swatch").forEach(btn=>{
    btn.addEventListener("click",()=>selectSpoolColor(btn.dataset.scchex,btn.dataset.sccname));
    btn.addEventListener("keydown",e=>{
      if(e.key==="Enter"||e.key===" "){ e.preventDefault(); selectSpoolColor(btn.dataset.scchex,btn.dataset.sccname); }
    });
  });
}
function renderUnloadPaletteGrid(){
  // AD5X (so far the only connector with a fixed palette): the printer only
  // has icons for a fixed color set, so the grid only ever offers exactly
  // those — no arbitrary hex entry, nothing to snap, and no "recent" section
  // (a 6-8 icon fixed set doesn't need a shortcut to itself).
  const source=SPOOL_MODAL_FIXED_PALETTE||SPOOL_COLOR_PALETTE;
  $("unloadPaletteGrid").innerHTML=source.map(c=>swatchHtmlFor(c)).join("");
  wireSwatchGrid($("unloadPaletteGrid"));
  if(SPOOL_MODAL_FIXED_PALETTE){
    $("unloadRecentHdr").style.display="none";
    $("unloadRecentGrid").style.display="none";
    $("unloadRecentGrid").innerHTML="";
    return;
  }

  // "Recent on this fleet": distinct colors currently loaded anywhere in the
  // fleet, deduped by hex, capped at 6 — there's no persisted apply-history
  // to draw a true chronological "last used" from, so this is the closest
  // useful proxy: colors genuinely in active use fleet-wide right now.
  const seen=new Set(), recent=[];
  outer: for(const p of FLEET){
    for(const h of (p.heads||[])){
      if(h&&h.loaded&&h.hex){
        const hex=h.hex.toUpperCase();
        if(!seen.has(hex)){ seen.add(hex); recent.push({hex,name:nameForHex(hex)}); }
        if(recent.length>=6) break outer;
      }
    }
  }
  const hdr=$("unloadRecentHdr"), grid=$("unloadRecentGrid");
  if(recent.length){
    hdr.style.display=""; grid.style.display="";
    grid.innerHTML=recent.map(c=>swatchHtmlFor(c)).join("");
    wireSwatchGrid(grid);
  } else {
    hdr.style.display="none"; grid.style.display="none"; grid.innerHTML="";
  }
}

// ---- Custom tab: hex <-> RGB <-> native <input type=color>, kept in sync ----
function normalizeHexInput(raw){
  let v=(raw||"").trim();
  if(v[0]==="#") v=v.slice(1);
  if(/^[0-9a-fA-F]{3}$/.test(v)) v=v[0]+v[0]+v[1]+v[1]+v[2]+v[2];
  if(!/^[0-9a-fA-F]{6}$/.test(v)) return null;
  return "#"+v.toUpperCase();
}
function syncCustomFieldsFromPending(){
  const hex=SPOOL_MODAL_PENDING.hex;
  $("unloadHexField").value=hex;
  $("unloadColorInput").value=hex;
  $("unloadHexError").style.display="none";
  const rgb=hexRGB(hex)||[255,255,255];
  $("unloadR").value=rgb[0]; $("unloadG").value=rgb[1]; $("unloadB").value=rgb[2];
}
function applyCustomHex(raw){
  const norm=normalizeHexInput(raw);
  if(!norm){
    const err=$("unloadHexError");
    err.textContent=t("fleet.modal.unload.error_hex_format");
    err.style.display="block";
    return; // invalid input is never silently reset — it stays exactly as typed
  }
  setPendingColor(norm,null,{skipHexField:true});
}
function applyCustomRgb(){
  const clamp=v=>Math.max(0,Math.min(255,Math.round(Number(v))||0));
  const r=clamp($("unloadR").value), g=clamp($("unloadG").value), b=clamp($("unloadB").value);
  $("unloadR").value=r; $("unloadG").value=g; $("unloadB").value=b;
  const hex="#"+[r,g,b].map(n=>n.toString(16).padStart(2,"0")).join("");
  setPendingColor(hex,null,{skipRgb:true});
}
function applyNativeColor(){
  setPendingColor($("unloadColorInput").value,null,{skipNative:true});
}
async function doApplyUnloadColor(){
  const st=$("unloadStatus");
  const requestedHex=SPOOL_MODAL_PENDING.hex;
  st.className="pstatus work"; st.textContent=t("fleet.modal.unload.status_saving_color");
  try{
    // Real printer write (see connectors/snapmaker-u1-klipper.js's
    // setFilamentColor) — the same generic route AD5X's Color button used to
    // call directly. The palette/custom "name" picked here is a client-side
    // display convenience only (nameForHex()); there's no printer-side field
    // for it, so it's never sent.
    const r=await postJSON("/api/filament-color",{printer:SPOOL_MODAL_PRINTER,extruder:SPOOL_MODAL_EXT,hex:requestedHex});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    loadFleet();
    closeUnload(); // saved — exit the color picker and the unload dialog together
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// ---- Bed temperature modal ----
// Tracked purely so a live locale switch while this modal is open can
// re-derive its dynamic title (see refreshFleetModalsDynamicText()) —
// openBedModal() otherwise only ever captured printerId in its own onclick
// closures, with nothing at module scope to re-render from.
let BEDMODAL_PRINTER=null;
function openBedModal(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  BEDMODAL_PRINTER=printerId;
  $("bedmodaltitle").textContent=t("fleet.modal.bed.title",{printer:(p.brand||'SnapMaker')+" "+p.name});
  $("bedmodalinput").value="";
  $("bedmodalstatus").textContent="";
  $("bedmodalset").onclick=()=>{
    const temp=parseInt($("bedmodalinput").value,10);
    if(!Number.isFinite(temp)||temp<0||temp>100){ $("bedmodalstatus").className="pstatus err"; $("bedmodalstatus").textContent=t("fleet.modal.bed.error_temp_range"); return; }
    doBedSet(printerId,temp);
  };
  $("bedmodaloff").onclick=()=>doBedSet(printerId,0);
  $("bedmodal").classList.add("show");
  setTimeout(()=>$("bedmodalinput").focus(),100);
}
function closeBedModal(){ $("bedmodal").classList.remove("show"); BEDMODAL_PRINTER=null; }

// ---- Heat multiple printers (bed temp only — see openPreheat/doBedSet;
// there is no hotend-temperature capability anywhere in this codebase) ----
// BULKHEAT_CANCEL is checked between each printer in a staggered run, and
// set whenever the modal closes (✕, Cancel, or backdrop click via
// wireModal) — closing the modal stops any in-flight sequence rather than
// letting it keep silently heating printers in the background. It's also
// set (without closing the modal) by "Stop remaining" so the run's results
// stay visible on the rows.
let BULKHEAT_CANCEL = false;
let BULKHEAT_SELECTED = new Set();
let BULKHEAT_TEMP = 60;
// Whether a run is currently in flight — gates refreshBulkHeatDynamicText()
// below: rebuilding the row list on a locale switch is only safe while
// idle, since a rebuild recreates each checkbox in its default (enabled)
// state, which would incorrectly re-enable controls doBulkHeat() disabled
// mid-run. See that function's own comment.
let BULKHEAT_RUNNING = false;
// Per-row and footer semantic state — a live locale switch re-renders
// presentation FROM this, never by inspecting/comparing already-displayed
// text (see bulkheatApplyRowState/bulkheatApplyFooterState). id -> {cls,
// kind, params} for a translatable status, or {cls, kind:"error", message}
// for a raw, never-translated connector error.
let BULKHEAT_ROW_STATE = new Map();
let BULKHEAT_FOOTER_STATE = null; // null | {kind:"validation"} | {kind:"result", ok, total, failed}

const BULKHEAT_REASON_KEYS = {
  offline: "printer_status.offline",
  busy: "fleet.modal.bulkheat.reason_busy",
  paused: "printer_status.paused",
  error: "printer_status.error",
  maintenance: "printer_status.maintenance",
  monitor_only: "printer.monitor_only_label"
};
// A printer that's offline, mid-print, errored, or under maintenance can't
// take a bed-temp command — same states server.js's connectors would refuse
// anyway, just surfaced up front instead of failing per-row after the fact.
// Returns a semantic reason CODE, never English text — bulkheatRowHtml()
// below is the only place that turns it into a translated label; every
// other caller only ever checks it for truthiness/eligibility.
function bulkheatDisableReason(p){
  if(!p||!p.online) return "offline";
  if(monitorOnly(p)) return "monitor_only";
  if(p.state==="printing") return "busy";
  if(p.state==="paused") return "paused";
  if(p.state==="error") return "error";
  if(p.state==="maintenance") return "maintenance";
  return null;
}

// The slider/presets always clamp to the LOWEST maxBedTemp among the current
// selection (never the highest) — heating a printer past its own ceiling
// isn't an option just because another selected printer can go higher.
function bulkheatCapInfo(ids){
  const printers=ids.map(id=>FLEET.find(f=>f.id===id)).filter(Boolean);
  if(!printers.length) return { cap:120, note:t("fleet.modal.bulkheat.cap_note_default") };
  const caps=printers.map(p=>(p.capabilities&&Number.isFinite(p.capabilities.maxBedTemp))?p.capabilities.maxBedTemp:120);
  const cap=Math.min(...caps);
  if(caps.every(c=>c===cap)) return { cap, note:t("fleet.modal.bulkheat.cap_note_range",{cap}) };
  const limiter=printers[caps.indexOf(cap)];
  return { cap, note:t("fleet.modal.bulkheat.cap_note_capped",{cap,name:limiter.name}) };
}

function bulkheatRowHtml(p){
  const st=statusColorText(p);
  const reason=bulkheatDisableReason(p);
  const disabled=!!reason;
  const checked=BULKHEAT_SELECTED.has(p.id);
  const maxT=(p.capabilities&&Number.isFinite(p.capabilities.maxBedTemp))?p.capabilities.maxBedTemp:120;
  const curBed=(p.bed&&typeof p.bed.temp==="number")?p.bed.temp+"°":"—";
  return `<label class="bulkheat-row${disabled?' disabled':''}">`+
    `<input type="checkbox" class="bulkheat-chk checkbox-input" data-bulkheatid="${p.id}"${checked?' checked':''}${disabled?' disabled':''}>`+
    `<span class="bulkheat-dot" style="--status-color:${st.statusColor}"></span>`+
    `<span class="bulkheat-name">${esc(p.name)}</span>`+
    `<span class="bulkheat-model">${esc(p.brand||t("fleet.modal.bulkheat.brand_fallback"))}</span>`+
    `<span class="bulkheat-cur">${curBed}</span>`+
    `<span class="bulkheat-max">${esc(t("fleet.modal.bulkheat.max_temp_label",{temp:maxT}))}</span>`+
    (disabled?`<span class="status-badge" style="--status-color:${st.statusColor}">${esc(t(BULKHEAT_REASON_KEYS[reason]))}</span>`:``)+
    `<span class="bulkheat-row-status pstatus" id="bulkheat-st-${p.id}"></span>`+
  `</label>`;
}

function renderBulkHeatList(){
  $("bulkheatList").innerHTML = FLEET.length
    ? FLEET.map(bulkheatRowHtml).join("")
    : `<div class="hint">${esc(t("fleet.modal.bulkheat.no_printers"))}</div>`;
  $("bulkheatList").querySelectorAll(".bulkheat-chk").forEach(chk=>{
    chk.addEventListener("change",()=>{
      const id=parseInt(chk.dataset.bulkheatid,10);
      if(chk.checked) BULKHEAT_SELECTED.add(id); else BULKHEAT_SELECTED.delete(id);
      updateBulkHeatToolbar();
    });
  });
  updateBulkHeatToolbar();
}

function updateBulkHeatTemp(v){
  const cap=parseInt($("bulkheatSlider").max,10)||120;
  const temp=Math.max(0,Math.min(cap,Math.round(v)));
  BULKHEAT_TEMP=temp;
  $("bulkheatSlider").value=temp;
  $("bulkheatReadout").textContent=temp+"°C";
  $("bulkheatPresets").querySelectorAll(".btn-chip").forEach(b=>{
    b.classList.toggle("active",parseInt(b.dataset.preset,10)===temp);
  });
}

function updateBulkHeatSummary(){
  const n=BULKHEAT_SELECTED.size;
  if(!$("bulkheatStagger").checked||n<=1){ $("bulkheatSummary").textContent=t("fleet.modal.bulkheat.summary_together"); return; }
  const secs=Math.max(5,parseInt($("bulkheatStaggerSecs").value,10)||60);
  const total=(n-1)*secs;
  const time=`${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;
  $("bulkheatSummary").textContent=t("fleet.modal.bulkheat.summary_last_at",{time});
}

// Text-only half of the toolbar refresh (count, cap note, Go button label,
// stagger summary) — deliberately never touches disabled/checked attributes,
// so it's always safe to call on a locale switch even mid-run, unlike
// updateBulkHeatToolbar() below which also owns eligibility/control state.
function bulkHeatToolbarTexts(){
  const eligible=FLEET.filter(p=>!bulkheatDisableReason(p));
  const unavailable=FLEET.length-eligible.length;
  const n=BULKHEAT_SELECTED.size;
  $("bulkheatCount").textContent = unavailable
    ? t("fleet.modal.bulkheat.count_status_unavailable",{n,total:eligible.length,unavailable})
    : t("fleet.modal.bulkheat.count_status",{n,total:eligible.length});
  const { note } = bulkheatCapInfo([...BULKHEAT_SELECTED]);
  $("bulkheatCapNote").textContent = note;
  $("bulkheatGo").textContent = n ? tn("fleet.modal.bulkheat.go_button",n,{n}) : t("fleet.modal.bulkheat.go_button_none");
  updateBulkHeatSummary();
}

// Re-derives everything selection-dependent — count, select-all tri-state,
// the temp cap (and re-clamps the current value against it), and the Go
// button's label — from BULKHEAT_SELECTED. Called on every checkbox change
// rather than threading a diff through, since the full recompute is cheap
// and this only ever runs on user interaction.
function updateBulkHeatToolbar(){
  const eligible=FLEET.filter(p=>!bulkheatDisableReason(p));
  for(const id of [...BULKHEAT_SELECTED]) if(!eligible.some(p=>p.id===id)) BULKHEAT_SELECTED.delete(id);

  const selAll=$("bulkheatSelectAll");
  const n=BULKHEAT_SELECTED.size;
  selAll.checked = eligible.length>0 && n===eligible.length;
  selAll.indeterminate = n>0 && n<eligible.length;

  const { cap } = bulkheatCapInfo([...BULKHEAT_SELECTED]);
  $("bulkheatSlider").max = cap;
  updateBulkHeatTemp(BULKHEAT_TEMP);

  $("bulkheatGo").disabled = n===0;
  bulkHeatToolbarTexts();
}

function bulkheatToggleSelectAll(){
  const checked=$("bulkheatSelectAll").checked;
  const eligible=FLEET.filter(p=>!bulkheatDisableReason(p));
  if(checked) eligible.forEach(p=>BULKHEAT_SELECTED.add(p.id));
  else BULKHEAT_SELECTED.clear();
  $("bulkheatList").querySelectorAll(".bulkheat-chk:not(:disabled)").forEach(chk=>{ chk.checked=checked; });
  updateBulkHeatToolbar();
}

function openBulkHeat(){
  BULKHEAT_SELECTED=new Set();
  BULKHEAT_TEMP=60;
  BULKHEAT_ROW_STATE=new Map();
  BULKHEAT_FOOTER_STATE=null;
  BULKHEAT_RUNNING=false;
  renderBulkHeatList();
  $("bulkheatStagger").checked=true;
  $("bulkheatStaggerSecs").disabled=false;
  $("bulkheatStaggerSecs").value=60;
  $("bulkheatStatus").innerHTML="";
  $("bulkheatCancelQueue").style.display="none";
  BULKHEAT_CANCEL=false;
  $("bulkheatmodal").classList.add("show");
}
function closeBulkHeatModal(){
  BULKHEAT_CANCEL = true;
  $("bulkheatmodal").classList.remove("show");
}
// Applies (or re-applies, e.g. after a live locale switch) a row's status
// purely from BULKHEAT_ROW_STATE — never by reading back what's currently
// displayed. "error" carries a raw, never-translated connector message.
function bulkheatApplyRowState(id){
  const state=BULKHEAT_ROW_STATE.get(id);
  const el=document.getElementById("bulkheat-st-"+id);
  if(!el||!state) return;
  el.className="bulkheat-row-status pstatus "+state.cls;
  el.textContent = state.kind==="error" ? state.message : t(BULKHEAT_STATUS_KEYS[state.kind], state.params);
}
const BULKHEAT_STATUS_KEYS = {
  queued: "fleet.modal.bulkheat.status_queued",
  heating: "fleet.modal.bulkheat.status_heating",
  off: "fleet.modal.bulkheat.status_off",
  set: "fleet.modal.bulkheat.status_set",
  cancelled: "printer_status.cancelled"
};
function bulkheatSetRowStatus(id, cls, kind, params){
  BULKHEAT_ROW_STATE.set(id, {cls, kind, params});
  bulkheatApplyRowState(id);
}
function bulkheatSetRowError(id, message){
  BULKHEAT_ROW_STATE.set(id, {cls:"err", kind:"error", message});
  bulkheatApplyRowState(id);
}
function bulkheatApplyFooterState(){
  const status=$("bulkheatStatus");
  if(!BULKHEAT_FOOTER_STATE) return;
  if(BULKHEAT_FOOTER_STATE.kind==="validation"){
    status.className="pstatus err"; status.textContent=t("fleet.modal.send.select_one");
  } else {
    const {ok,total,failed}=BULKHEAT_FOOTER_STATE;
    status.className="pstatus "+(failed?"err":"ok");
    status.textContent = failed
      ? t("fleet.modal.bulkheat.result_summary_failed",{ok,total,failed})
      : t("fleet.modal.bulkheat.result_summary",{ok,total});
  }
}
async function bulkheatOne(id, temp){
  bulkheatSetRowStatus(id, "work", "heating");
  try{
    const r=await postJSON("/api/bedtemp",{printer:id,temp});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    bulkheatSetRowStatus(id, "ok", temp===0 ? "off" : "set", temp===0?undefined:{temp});
  }catch(e){ bulkheatSetRowError(id, e.message); }
}
async function doBulkHeat(){
  const ids=[...BULKHEAT_SELECTED];
  const temp=BULKHEAT_TEMP;
  if(!ids.length){
    BULKHEAT_FOOTER_STATE={kind:"validation"};
    bulkheatApplyFooterState();
    return;
  }
  const staggered=$("bulkheatStagger").checked;
  const delayMs=staggered ? Math.max(5,parseInt($("bulkheatStaggerSecs").value,10)||60)*1000 : 0;
  BULKHEAT_CANCEL=false;
  BULKHEAT_RUNNING=true;
  $("bulkheatGo").disabled=true;
  $("bulkheatSelectAll").disabled=true;
  $("bulkheatList").querySelectorAll(".bulkheat-chk").forEach(c=>c.disabled=true);
  $("bulkheatCancelQueue").style.display = staggered ? "" : "none";
  BULKHEAT_FOOTER_STATE=null;
  $("bulkheatStatus").className="pstatus"; $("bulkheatStatus").textContent="";
  ids.forEach(id=>bulkheatSetRowStatus(id,"","queued"));

  if(staggered){
    for(let i=0;i<ids.length;i++){
      if(BULKHEAT_CANCEL) break;
      await bulkheatOne(ids[i], temp);
      if(BULKHEAT_CANCEL) break;
      if(i<ids.length-1) await new Promise(r=>setTimeout(r, delayMs));
    }
    // Anything never reached (cancelled mid-sequence) is still tracked as
    // "queued" in BULKHEAT_ROW_STATE — semantic state, never a comparison
    // against the row's own (translatable, locale-dependent) displayed
    // text, which is what this used to do before Fleet Phase 3's closure
    // pass ("el.textContent==='Queued…'") and would have silently broken
    // the very first time "Queued…" was shown in a non-English locale.
    ids.forEach(id=>{
      const state=BULKHEAT_ROW_STATE.get(id);
      if(state && state.kind==="queued") bulkheatSetRowStatus(id,"err","cancelled");
    });
  } else {
    await Promise.allSettled(ids.map(id=>bulkheatOne(id, temp)));
  }

  const okCount=ids.filter(id=>{
    const el=document.getElementById("bulkheat-st-"+id);
    return el && el.classList.contains("ok");
  }).length;
  const failCount=ids.length-okCount;
  BULKHEAT_FOOTER_STATE={kind:"result", ok:okCount, total:ids.length, failed:failCount};
  bulkheatApplyFooterState();

  BULKHEAT_CANCEL=false;
  BULKHEAT_RUNNING=false;
  $("bulkheatGo").disabled=false;
  $("bulkheatSelectAll").disabled=false;
  $("bulkheatList").querySelectorAll(".bulkheat-chk").forEach(c=>{
    const id=parseInt(c.dataset.bulkheatid,10);
    c.disabled=!!bulkheatDisableReason(FLEET.find(f=>f.id===id));
  });
  $("bulkheatCancelQueue").style.display="none";
  loadFleet();
}
// Live-locale-switch refresh — mirrors refreshFleetModalsDynamicText()'s
// other per-modal blocks but is fleet-wide rather than keyed to one printer
// id. Per-row status text and the footer message are always safe to
// re-render purely from BULKHEAT_ROW_STATE/BULKHEAT_FOOTER_STATE, in-flight
// run or not. The per-row STATIC content (disabled-reason badge, brand
// fallback, max-temp label) only gets rebuilt while idle — rebuilding mid-
// run would recreate fresh checkboxes in their default enabled state,
// incorrectly re-enabling controls doBulkHeat() deliberately disabled. This
// is the same class of deliberate, minor, closes-and-reopens-cleanly gap as
// the unload modal's secondary material/RFID line elsewhere in this phase.
function refreshBulkHeatDynamicText(){
  bulkHeatToolbarTexts();
  if(!BULKHEAT_RUNNING) renderBulkHeatList();
  for(const id of BULKHEAT_ROW_STATE.keys()) bulkheatApplyRowState(id);
  bulkheatApplyFooterState();
}

// ---- Folder browser ----
// Shared by every "Browse…" button in Settings (gcode folder, and now the
// Printer sync Logs/Camera folders) — one modal, whichever field id opened
// it is where browseok writes the chosen path back to.
let BROWSE_TARGET_FIELD="setFolder";
function openBrowse(targetFieldId){ BROWSE_TARGET_FIELD=targetFieldId||"setFolder"; $("browsemodal").classList.add("show"); navigateBrowse(null); }
function closeBrowse(){ $("browsemodal").classList.remove("show"); }
async function navigateBrowse(p){
  const list=$("browselist");
  list.innerHTML=`<div class="browse-empty">${esc(t("settings.browse.loading"))}</div>`;
  try{
    const url=p?"/api/browse?path="+encodeURIComponent(p):"/api/browse";
    const d=await getJSON(url);
    $("browsepath").value=d.path||"";
    list.innerHTML="";
    // Up / drives navigation
    if(d.parent){
      const up=document.createElement("button"); up.className="browse-item browse-up";
      up.textContent="↑  .."; up.onclick=()=>navigateBrowse(d.parent); list.appendChild(up);
    } else if(d.isWin){
      const up=document.createElement("button"); up.className="browse-item browse-up";
      up.textContent="↑  "+t("settings.browse.my_computer");
      up.onclick=async()=>{
        list.innerHTML=`<div class="browse-empty">${esc(t("settings.browse.loading"))}</div>`;
        $("browsepath").value="";
        const dr=await getJSON("/api/browse?drives=1");
        list.innerHTML="";
        (dr.drives||[]).forEach(drv=>{
          const b=document.createElement("button"); b.className="browse-item";
          b.textContent="💾  "+drv; b.onclick=()=>navigateBrowse(drv); list.appendChild(b);
        });
      };
      list.appendChild(up);
    }
    if(!d.entries||!d.entries.length){
      list.insertAdjacentHTML("beforeend",`<div class="browse-empty">${esc(t("settings.browse.no_subfolders"))}</div>`);
    } else {
      d.entries.forEach(e=>{
        const b=document.createElement("button"); b.className="browse-item";
        b.textContent="📁  "+e.name; b.onclick=()=>navigateBrowse(e.path); list.appendChild(b);
      });
    }
  }catch(err){
    list.innerHTML='<div class="browse-empty" style="color:var(--bad)">'+esc(err.message)+'</div>';
  }
}

// ---- Electricity rate modal ----
function openElecModal(){ $("elecZip").value=""; $("elecResult").innerHTML=""; $("elecApply").style.display="none"; $("elecmodal").classList.add("show"); setTimeout(()=>$("elecZip").focus(),80); }
function closeElecModal(){ $("elecmodal").classList.remove("show"); }
async function doElecLookup(){
  const zip=$("elecZip").value.trim().replace(/\D/g,"");
  if(!/^\d{5}$/.test(zip)){ $("elecResult").innerHTML=`<span style="color:var(--bad)">${esc(t("settings.electricity.zip_error"))}</span>`; return; }
  const res=$("elecResult"); res.innerHTML=`<span style="color:var(--ink-dim)">${esc(t("settings.electricity.looking_up"))}</span>`;
  $("elecApply").style.display="none";
  const btn=$("elecLookup"); btn.disabled=true;
  try{
    const d=await getJSON("/api/electricity-rate?zip="+zip);
    if(d.error){ res.innerHTML=`<span style="color:var(--bad)">${esc(d.error)}</span>`+(d.location?`<br><span style="color:var(--ink-dim)">${esc(d.location)}</span>`:``); return; }
    res.innerHTML=`<b>${esc(d.location)}</b>${d.utility?`<br><span style="color:var(--ink-dim)">${esc(d.utility)}</span>`:``}<br>`+t("settings.electricity.rate_result",{cents:d.cents,rate:d.rate},{html:true});
    $("elecApply").style.display="";
    $("elecApply").onclick=()=>{ $("setElectricityRate").value=d.rate; closeElecModal(); };
  }catch(e){ res.innerHTML=`<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  finally{ btn.disabled=false; }
}
async function doBedSet(printerId,temp){
  const st=$("bedmodalstatus");
  st.className="pstatus work"; st.textContent=temp?t("fleet.modal.bed.status_setting",{temp}):t("fleet.modal.bed.status_turning_off");
  try{
    const r=await postJSON("/api/bedtemp",{printer:printerId,temp});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=temp?t("fleet.modal.bed.status_set",{temp}):t("fleet.modal.bed.status_off");
    setTimeout(()=>{ closeBedModal(); loadFleet(); },1200);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// ---- Maintenance modal ----
// Reached from one place: the Settings > Printers row's Maintenance button
// (openMaintenance — opens with that printer preselected). The topbar had a
// second entry point (a wrench opening it with no printer chosen); it was
// removed once the Health page grew its own inline maintenance surface.
// openMaintModal() still loads the picker, so switching the select calls
// loadMaintDetail() for that printer.
let MAINT_TOTAL_SEC=null, PRINTERS_CFG=[], MAINT_PRINTERS=[], MAINT_IDX=null;
let MAINT_ENTRIES=[];
// Cached purely to support a live-locale-switch refresh (renderMaintWarranty
// takes its data as a param, not a global) without a network round-trip —
// same idea as Fleet's BEDMODAL_PRINTER addition.
let MAINT_WARRANTY=null, MAINT_CURRENT_PRINTER_NAME=null;
function fmtHours(sec){ if(sec==null) return '—'; const h=Math.floor(sec/3600); const m=Math.floor((sec%3600)/60); return h+'h '+m+'m'; }
function fmtMaintDate(iso){
  if(!iso) return "—";
  const d=new Date(iso+"T00:00:00");
  return d.toLocaleDateString([],{day:"numeric",month:"short",year:"numeric"});
}
// Mirrors server.js's MAINT_FREQ_SPEC. Only "none" and the two date-based
// options are actually computable here — hours250/500 stay disabled in the
// <select> until hour-based scheduling exists server-side (see server.js
// for what that would take), so there's no client-side unit for them yet.
// labelKey feeds both this preview logic AND the <option> text in both
// forms (Health's inline form + this modal) — one source of translated
// wording instead of three independently-hardcoded copies.
const MAINT_FREQ_SPEC={
  none:null,
  weekly:{unit:"days",amount:7,labelKey:"maintenance.frequency_weekly"},
  monthly:{unit:"months",amount:1,labelKey:"maintenance.frequency_monthly"},
  quarterly:{unit:"months",amount:3,labelKey:"maintenance.frequency_quarterly"}
};
// Convenience auto-suggest only, matching the new default component
// vocabulary (server.js's DEFAULT_MAINT_COMPONENTS) — the server recomputes
// Next Due authoritatively on save regardless of what this pre-fills.
const MAINT_FREQ_MAP={"Nozzle":"monthly","Timing Belt":"quarterly","Bed Sheet":"quarterly","Hotend":"monthly","PTFE Tube":"quarterly","Extruder Gears":"quarterly","Lead Screw":"quarterly","Fans":"monthly","Lubrication":"monthly","Firmware":"monthly","Wiper":"monthly"};
function addDaysClient(dateStr,days){
  if(!dateStr) return "";
  const d=new Date(dateStr+"T00:00:00");
  d.setDate(d.getDate()+days);
  return d.toISOString().slice(0,10);
}
function addMonthsClient(dateStr,months){
  if(!dateStr) return "";
  const d=new Date(dateStr+"T00:00:00");
  d.setMonth(d.getMonth()+months);
  return d.toISOString().slice(0,10);
}
// "Next due" is a live preview of what saving THIS entry (current date +
// component + Remind me) would schedule — not a stored value — so it
// recomputes on every change to any of those three inputs instead of only
// on load.
function updateNextScheduledPreview(){
  const spec=MAINT_FREQ_SPEC[$("maintFrequency").value];
  const date=$("maintDate").value;
  const component=$("maintComponentFilter").value.trim();
  if(!spec){
    $("maintNextScheduled").textContent=t("maintenance.next_due_not_scheduled");
    $("maintNextHint").textContent=t("maintenance.next_due_no_reminder_hint");
    return;
  }
  const next=spec.unit==="days"?addDaysClient(date,spec.amount):addMonthsClient(date,spec.amount);
  $("maintNextScheduled").textContent=next?fmtMaintDate(next):"—";
  $("maintNextHint").textContent=date?(component?t("maintenance.next_due_hint_component",{date:fmtMaintDate(date),freqLabel:t(spec.labelKey),component}):t("maintenance.next_due_hint",{date:fmtMaintDate(date),freqLabel:t(spec.labelKey)})):"";
}

async function openMaintModal(preselectIdx){
  $("maintReportModal").classList.add("show");
  const sel=$("maintPrinterSel");
  sel.innerHTML=`<option>${esc(t("maintenance.loading_printers"))}</option>`;
  $("maintDetail").style.display="none";
  try{ MAINT_PRINTERS=await getJSON("/api/printers"); }catch{ MAINT_PRINTERS=[]; }
  if(!MAINT_PRINTERS.length){
    sel.innerHTML=`<option>${esc(t("maintenance.no_printers_configured"))}</option>`;
    return;
  }
  sel.innerHTML=MAINT_PRINTERS.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const idx=(preselectIdx!=null&&MAINT_PRINTERS.some(p=>p.id===preselectIdx))?preselectIdx:MAINT_PRINTERS[0].id;
  sel.value=idx;
  loadMaintDetail(idx);
}
function openMaintenance(idx){ openMaintModal(idx); }

function closeMaintReport(){ $("maintReportModal").classList.remove("show"); }

async function loadMaintDetail(idx){
  MAINT_IDX=idx;
  $("maintDetail").style.display="";
  $("maintDate").value=new Date().toISOString().slice(0,10);
  $("maintComponentFilter").value="";
  $("maintFrequency").value="monthly";
  $("maintCost").value="0.00";
  $("maintPart").value="";
  $("maintComment").value="";
  $("maintSave").disabled=true;
  updateMaintOfflineCheckbox(idx);
  $("maintStatus").textContent="";
  $("maintHours").textContent=t("maintenance.hours_loading");
  $("maintWarranty").textContent="—"; $("maintWarranty").classList.remove("warn","bad");
  $("maintLastService").textContent="—";
  $("maintHistory").innerHTML="";
  const p=MAINT_PRINTERS.find(mp=>mp.id===idx);
  MAINT_CURRENT_PRINTER_NAME=p?p.name:"printer";
  $("maintHistoryTitle").textContent=t("maintenance.history_title",{name:MAINT_CURRENT_PRINTER_NAME});
  MAINT_ENTRIES=[]; MAINT_WARRANTY=null;
  updateNextScheduledPreview();
  MAINT_TOTAL_SEC=null;
  try{
    const d=await getJSON("/api/printer-hours?printer="+idx);
    MAINT_TOTAL_SEC=d.totalSeconds!=null?d.totalSeconds:null;
    $("maintHours").textContent=MAINT_TOTAL_SEC!=null?fmtHours(MAINT_TOTAL_SEC):t("maintenance.hours_unavailable");
  }catch{ $("maintHours").textContent=t("maintenance.hours_unavailable"); }
  try{
    const d=await getJSON("/api/maintenance?printer="+idx);
    applyMaintDetailResponse(d);
  }catch{}
}
// The fleet poll already tells us if a printer is currently parked for
// maintenance (state:"maintenance", set server-side) — reuse it instead of
// fetching the flag a second way.
function updateMaintOfflineCheckbox(idx){
  const fleetEntry=FLEET.find(f=>f.id===idx);
  $("maintOfflineToggle").checked=!!(fleetEntry&&fleetEntry.state==="maintenance");
}
async function toggleMaintenanceMode(){
  const chk=$("maintOfflineToggle");
  const st=$("maintStatus");
  const offline=chk.checked;
  chk.disabled=true;
  st.className="pstatus work"; st.textContent=offline?t("maintenance.status_taking_offline"):t("maintenance.status_bringing_online");
  try{
    const r=await postJSON("/api/maintenance-mode",{printer:MAINT_IDX,offline});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=d.maintenanceMode?t("maintenance.status_taken_offline"):t("maintenance.status_back_online");
    // Use the endpoint's own response, not a re-fetched FLEET — loadFleet()
    // has an in-flight guard that silently no-ops if a periodic poll happens
    // to already be running, which would read back stale state here.
    chk.checked=!!d.maintenanceMode;
    loadFleet(); // still refresh in the background for the fleet card badge
  }catch(e){
    st.className="pstatus err"; st.textContent=e.message;
    chk.checked=!offline; // request failed — revert to reflect actual state
  }
  finally{ chk.disabled=false; }
}
function onMaintComponentChange(){
  const typed=$("maintComponentFilter").value.trim();
  const known=MAINT_FREQ_MAP[typed];
  if(known) $("maintFrequency").value=known;
  updateNextScheduledPreview();
  $("maintSave").disabled=!typed;
}
// w.status itself (server-set: unknown/expired/expiring/active) is never
// touched — only the displayed word/sentence is translated.
function renderMaintWarranty(w){
  const el=$("maintWarranty");
  el.classList.remove("warn","bad");
  if(!w||w.status==="unknown"){ el.textContent=t("maintenance.warranty_unknown"); return; }
  if(w.status==="expired"){ el.textContent=t("maintenance.warranty_expired"); el.classList.add("bad"); return; }
  if(w.status==="expiring"){ el.textContent=t("maintenance.warranty_expires",{date:fmtMaintDate(w.expiry)}); el.classList.add("warn"); return; }
  el.textContent=t("maintenance.warranty_expires",{date:fmtMaintDate(w.expiry)});
}
function renderMaintLastService(entries){
  if(!entries.length){ $("maintLastService").textContent=t("maintenance.last_service_never"); return; }
  const last=entries[entries.length-1]; // push order — last pushed is most recent
  $("maintLastService").textContent=t("maintenance.last_service_summary",{date:fmtMaintDate(last.date),component:last.component||"—"});
}
function applyMaintDetailResponse(d){
  MAINT_ENTRIES=d.entries||[];
  MAINT_WARRANTY=d.warranty||null;
  renderMaintWarranty(MAINT_WARRANTY);
  renderMaintLastService(MAINT_ENTRIES);
  renderMaintHistory(MAINT_ENTRIES);
}
async function saveMaintenance(){
  const st=$("maintStatus");
  const date=$("maintDate").value;
  if(!date){ st.className="pstatus err"; st.textContent=t("maintenance.error_pick_date"); return; }
  const component=$("maintComponentFilter").value.trim();
  if(!component){ st.className="pstatus err"; st.textContent=t("maintenance.error_pick_component"); return; }
  const idx=MAINT_IDX;
  const entry={
    date, comment:$("maintComment").value.trim(), part:$("maintPart").value.trim(),
    hours:MAINT_TOTAL_SEC!=null?fmtHours(MAINT_TOTAL_SEC):'—', totalSeconds:MAINT_TOTAL_SEC,
    component, frequency:$("maintFrequency").value,
    cost:parseFloat($("maintCost").value)||0
  };
  $("maintSave").disabled=true;
  st.className="pstatus work"; st.textContent=t("maintenance.status_saving");
  try{
    const r=await postJSON("/api/maintenance",{printer:idx,entry});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=t("maintenance.status_saved");
    $("maintComment").value="";
    applyMaintDetailResponse(d);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ $("maintSave").disabled=!$("maintComponentFilter").value.trim(); }
}
function renderMaintHistory(entries){
  if(!entries.length){ $("maintHistory").innerHTML=`<div class="empty-list">${esc(t("maintenance.history_empty"))}</div>`; return; }
  const sorted=entries.slice().sort((a,b)=>b.date.localeCompare(a.date));
  const rows=sorted.map(e=>`<tr><td>${esc(e.date)}</td><td>${esc(e.component||'—')}</td><td>${esc(e.hours||'—')}</td><td>${esc(CURRENCY)}${(Number(e.cost)||0).toFixed(2)}</td></tr>`).join('');
  $("maintHistory").innerHTML=`<div class="maint-scroll"><table class="maint-table"><thead><tr><th>${esc(t("maintenance.history_col_date"))}</th><th>${esc(t("maintenance.history_col_component"))}</th><th>${esc(t("maintenance.history_col_hours"))}</th><th>${esc(t("maintenance.history_col_cost"))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
// ---- Plate map (exclude-object) ----
// Tap objects (on the plate or in the list) to SELECT them; nothing is sent
// to the printer until the Skip button is pressed.
let PLATE_PRINTER=null, PLATE_TIMER=null, PLATE_DATA=null, PLATE_SELECTED=new Set();
function openPlate(printer){
  PLATE_PRINTER=printer; PLATE_DATA=null; PLATE_SELECTED=new Set();
  $("plateStatus").textContent="";
  $("platemodal").classList.add("show");
  refreshPlate();
  if(PLATE_TIMER) clearInterval(PLATE_TIMER);
  PLATE_TIMER=setInterval(refreshPlate,3000);
}
function closePlate(){ $("platemodal").classList.remove("show"); if(PLATE_TIMER){ clearInterval(PLATE_TIMER); PLATE_TIMER=null; } PLATE_PRINTER=null; PLATE_DATA=null; PLATE_SELECTED=new Set(); }
async function refreshPlate(){
  if(PLATE_PRINTER===null) return;
  let d;
  try{ d=await getJSON("/api/plate?printer="+PLATE_PRINTER); }catch(e){ return; }
  if(d.error){ $("platewrap").innerHTML='<div class="platenote">'+esc(d.error)+'</div>'; $("platelist").innerHTML=""; return; }
  PLATE_DATA=d;
  // Drop selections that disappeared or were skipped elsewhere.
  const valid=new Set((d.objects||[]).map(o=>o.name)), ex=new Set(d.excluded||[]);
  [...PLATE_SELECTED].forEach(n=>{ if(!valid.has(n)||ex.has(n)) PLATE_SELECTED.delete(n); });
  renderPlate();
}
// Prime/purge towers are display-only: never selectable, never in the list,
// never numbered. (Orca doesn't currently label the tower as an object —
// this is a guard in case a slicer version starts doing so.)
const isTowerObj=name=>/(prime|purge|wipe)[ _-]?tower/i.test(name);

// Stable 1-based numbering shared by the plate SVG and the list, assigned
// once per render from object order — NOT renumbered as things get excluded
// (the 3s poll would otherwise reshuffle every visible number mid-look).
function plateObjectNumbers(d){
  const map=new Map();
  (d.objects||[]).filter(o=>!isTowerObj(o.name)).forEach((o,i)=>map.set(o.name,i+1));
  return map;
}
function polyCentroid(poly){
  let x=0,y=0;
  poly.forEach(p=>{x+=p[0];y+=p[1];});
  return [x/poly.length,y/poly.length];
}
function renderPlate(){
  const d=PLATE_DATA;
  if(!d) return;
  const fp=FLEET.find(f=>f.id===PLATE_PRINTER);
  const numberOf=plateObjectNumbers(d);
  const ex=new Set(d.excluded||[]);
  const remaining=[...numberOf.keys()].filter(n=>!ex.has(n));
  $("platetitle").textContent=t("fleet.modal.plate.title",{printer:fp?fp.name:t("fleet.modal.plate.printer_fallback")});
  $("plateSubtitle").textContent=tn("fleet.modal.plate.subtitle",remaining.length);
  $("platewrap").innerHTML=plateSVG(d,numberOf);
  $("platelist").innerHTML=plateListHTML(d,numberOf);
  document.querySelectorAll("#platewrap [data-obj], #platelist [data-obj]").forEach(el=>{
    el.addEventListener("click",()=>togglePlateSel(el.dataset.obj));
    el.addEventListener("mouseenter",()=>setPlateHover(el.dataset.obj,true));
    el.addEventListener("mouseleave",()=>setPlateHover(el.dataset.obj,false));
  });
  // #platelist renders real checkbox inputs (keyboard-operable natively —
  // adding a second keydown handler there would double-toggle on Space).
  // Only the SVG <g> shapes in #platewrap need a manual keyboard equivalent,
  // since SVG groups aren't focusable/activatable by default.
  document.querySelectorAll("#platewrap [data-obj]").forEach(el=>{
    el.tabIndex=0; el.setAttribute("role","button");
    el.addEventListener("keydown",e=>{
      if(e.key==="Enter"||e.key===" "){ e.preventDefault(); togglePlateSel(el.dataset.obj); }
    });
  });
  const sel=[...PLATE_SELECTED].filter(n=>remaining.includes(n));
  const n=sel.length, left=remaining.length-n;
  $("plateSelStatus").textContent=n
    ? tn("fleet.modal.plate.selection_status",left,{n,total:remaining.length})
    : t("fleet.modal.plate.nothing_selected");
  const btn=$("plateSkip");
  btn.disabled=!n;
  btn.textContent=n?tn("fleet.modal.plate.exclude_n_button",n):t("fleet.modal.plate.exclude_button");
}
// Cross-highlights the plate shape and the list row for the same object,
// since native CSS :hover can't reach across the two separate containers.
function setPlateHover(name,on){
  if(!name) return;
  const sel='[data-obj="'+CSS.escape(name)+'"]';
  document.querySelectorAll("#platewrap "+sel+", #platelist "+sel).forEach(el=>el.classList.toggle("hover",on));
}
function plateListHTML(d,numberOf){
  const ex=new Set(d.excluded||[]);
  return (d.objects||[]).filter(o=>!isTowerObj(o.name)).map(o=>{
    const isEx=ex.has(o.name), isSel=PLATE_SELECTED.has(o.name), n=numberOf.get(o.name);
    const cls="plate-item"+(isEx?" ex":"")+(isSel?" sel":"");
    const chip=isEx?`<span class="pi-chip">${esc(t("fleet.modal.plate.chip_skipped"))}</span>`:isSel?`<span class="pi-chip stop">${esc(t("fleet.modal.plate.chip_will_stop"))}</span>`:`<span class="pi-chip">${esc(t("printer_status.printing"))}</span>`;
    return `<label class="${cls}" ${isEx?"":`data-obj="${esc(o.name)}"`}>`+
      `<input type="checkbox" class="checkbox-input" ${isEx?"disabled":""}${isSel?" checked":""}>`+
      `<span class="pi-num">${n}</span>`+
      `<span class="pi-text"><span class="pi-label">${esc(t("fleet.modal.plate.object_label",{n}))}</span><span class="pi-objid" title="${esc(o.name)}">${esc(o.name)}</span></span>`+
      chip+
      `</label>`;
  }).join("");
}
function togglePlateSel(name){
  if(PLATE_SELECTED.has(name)) PLATE_SELECTED.delete(name); else PLATE_SELECTED.add(name);
  renderPlate();
}
async function doPlateSkip(){
  const names=[...PLATE_SELECTED];
  if(!names.length||PLATE_PRINTER===null) return;
  const st=$("plateStatus");
  st.className="pstatus work"; st.textContent=tn("fleet.modal.plate.excluding_status",names.length);
  $("plateSkip").disabled=true;
  try{
    for(const n of names){
      const r=await postJSON("/api/exclude",{printer:PLATE_PRINTER,name:n});
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    }
    st.className="pstatus ok"; st.textContent=tn("fleet.modal.plate.excluded_status",names.length);
    PLATE_SELECTED.clear();
  }catch(e){ st.className="pstatus err"; st.textContent=t("fleet.modal.plate.error_exclude_failed",{message:e.message}); }
  refreshPlate();
}
function plateSVG(d,numberOf){
  const objs=(d.objects||[]).filter(o=>o.polygon&&o.polygon.length>2);
  if(!objs.length) return `<div class="platenote">${esc(t("fleet.modal.plate.no_objects"))}</div>`;
  // Full-bed view over a photo of the real plate: gcode coordinates map 1:1
  // onto the 270×270 U1 bed, so objects appear where they really sit. The
  // photo is shot with the alignment tabs at the back, matching the Y flip.
  const BED=270, pad=8, exSet=new Set(d.excluded||[]);
  const groups=objs.map(o=>{
    const pts=o.polygon.map(pt=>pt[0].toFixed(1)+","+(BED-pt[1]).toFixed(1)).join(" "); // flip Y so plate front is at the bottom
    const isCur=o.name===d.current, isEx=exSet.has(o.name), isTower=isTowerObj(o.name), isSel=PLATE_SELECTED.has(o.name);
    if(isTower) return `<polygon class="po tower" points="${pts}"></polygon>`;
    const cls="po"+(isEx?" ex":"")+(isCur?" cur":"")+(isSel?" sel":"");
    const n=numberOf.get(o.name);
    let badge="";
    if(n){
      const [cx,cyRaw]=polyCentroid(o.polygon);
      const cy=(BED-cyRaw).toFixed(1);
      badge=`<circle class="po-badge${isSel?' sel':''}${isEx?' ex':''}" cx="${cx.toFixed(1)}" cy="${cy}" r="9"></circle>`+
        `<text class="po-badge-text" x="${cx.toFixed(1)}" y="${cy}">${n}</text>`;
    }
    return `<g class="po-group"${isEx?"":' data-obj="'+esc(o.name)+'"'}>`+
      `<polygon class="${cls}" points="${pts}"></polygon>${badge}`+
      `</g>`;
  }).join("");
  return `<svg viewBox="${-pad} ${-pad} ${BED+2*pad} ${BED+2*pad}" class="platesvg">`+
    `<image href="/plate-bg.png" x="0" y="0" width="${BED}" height="${BED}" preserveAspectRatio="none"/>`+
    `${groups}</svg>`;
}


// ---- settings / discovery ----
$("gear").addEventListener("click",()=>{
  // Fleet, Settings, Queue Management, and Health are mutually exclusive —
  // opening Settings on top of either of the other two closes it first
  // (clearing its refresh timer, for Queue), never leaves it running hidden
  // underneath.
  closeQueueDashboard();
  closeHealthPage();
  const open=$("setup").classList.toggle("show");
  document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display=open?"none":"");
  $("gear").querySelector("img").src = open ? "/back.svg" : "/gear.svg";
  $("gear").title = open ? t("common.back") : t("settings.title");
  $("fleetSearch").style.display = open ? "none" : "";
  $("sortBtn").style.display = open ? "none" : "";
  $("compactBtn").style.display = open ? "none" : "";
  $("filesBtn").style.display = open ? "none" : "";
  if($("bulkHeatBtn")) $("bulkHeatBtn").style.display = open ? "none" : "";
  if($("healthBtn")) $("healthBtn").style.display = open ? "none" : "";
  if($("queueBtn")) $("queueBtn").style.display = "none"; // re-shown by applyRoleUI() below once Settings' own state is settled
  if(open){
    document.body.classList.remove("showfiles"); loadGroupsUI().then(loadUsersUI); loadQueueManagementUI();
    // showSetTab() is what actually hides #globalSaveRow for a registered
    // tab (General) in favor of its sticky dirty footer — that only ever
    // ran on a tab-button click, never on Settings simply opening onto
    // whichever tab was already marked active, so the old Save row stayed
    // visible the whole time until you clicked a tab. Re-run it for the
    // current tab (same name in, same name out — the dirty-tab confirm
    // guard only fires on an actual switch, so this is a safe no-op reassert).
    const activeTab=document.querySelector(".set-tab.active")?.dataset.tab||"general";
    showSetTab(activeTab);
  }
  else {
    applyFilesOpen(); $("sortMenu").classList.remove("open");
    if(RA_POLL_TIMER){ clearInterval(RA_POLL_TIMER); RA_POLL_TIMER=null; } // Settings closed — stop polling even if "remote" was the last-open tab
    applyRoleUI(); // correctly restores queueBtn (enablement-gated) instead of showing it unconditionally
  }
});
$("raEnabled").addEventListener("change",async function(){
  const wantOn=this.checked;
  if(!wantOn && !confirm(t("settings.remote_access.disable_confirm"))){
    this.checked=true;
    return;
  }
  await raSetEnabled(wantOn);
});
$("raGoToUsersBtn").addEventListener("click",()=>showSetTab("users"));
$("raManageUsersBtn").addEventListener("click",()=>showSetTab("users"));
$("raRemoveBtn").addEventListener("click",removeRemoteAccess);
$("raRestartBtn").addEventListener("click",restartRemoteAccessTunnel);
$("raLogBtn").addEventListener("click",viewRemoteAccessLog);
$("raCopyBtn").addEventListener("click",async ()=>{
  const url=$("raPublicUrl").textContent;
  if(!url||url==="—") return;
  try{ await navigator.clipboard.writeText(url); $("raStatus").className="pstatus ok"; $("raStatus").textContent=t("common.copied"); }
  catch{ $("raStatus").className="pstatus err"; $("raStatus").textContent=t("settings.remote_access.copy_failed"); }
});
// Same one-row-open rule as clicking a row open (see closeOtherPrinterRows):
// the new row is the one you're here to fill in.
$("addPrinter").addEventListener("click",()=>{
  const added=addPrinterRow("","",{},true);
  closeOtherPrinterRows(added.querySelector(".prow-details"));
});
// State lives in dataset.expanded, not the button's own text — matching
// against the rendered label (as this used to) breaks the instant it's
// translated, since "Expand All" never appears once the button is showing
// "Expandir todo".
function syncCollapseAllButtonLabel(){
  const btn=$("collapseAll");
  const key=btn.dataset.expanded==="1"?"settings.printers.collapse_all":"settings.printers.expand_all";
  // hasTranslation() guard: this runs once synchronously at script-parse
  // time, well before init()'s `await initI18n(...)` has resolved (English
  // isn't loaded yet) — without the guard, t() would bake the raw key
  // string into the button until refreshDynamicI18nText() gets a chance to
  // fix it moments later. Leaving the static HTML default untouched here is
  // strictly better than a visible raw-key flash on a very slow connection.
  if(hasTranslation(key)) btn.textContent=t(key);
}
$("collapseAll").dataset.expanded="0";
syncCollapseAllButtonLabel();
$("collapseAll").addEventListener("click",()=>{
  const btn=$("collapseAll");
  const expanding=btn.dataset.expanded!=="1";
  document.querySelectorAll("#setPrinters .prow-details").forEach(d=>{ if(expanding) d.setAttribute("open",""); else d.removeAttribute("open"); });
  btn.dataset.expanded=expanding?"1":"0";
  syncCollapseAllButtonLabel();
});
$("printerSearch").addEventListener("input",()=>{
  const q=$("printerSearch").value.trim().toLowerCase();
  document.querySelectorAll("#setPrinters .prow").forEach(row=>{
    const name=(row.querySelector(".pname")?.value||"").toLowerCase();
    const brand=(row.querySelector(".pbrand")?.value||"").toLowerCase();
    const loc=(row.querySelector(".ploc")?.value||"").toLowerCase();
    const serial=(row.querySelector(".pserial")?.value||"").toLowerCase();
    row.style.display=!q||name.includes(q)||brand.includes(q)||loc.includes(q)||serial.includes(q)?"":"none";
  });
});
$("addUser").addEventListener("click",()=>addUserRow(null,true));
$("userSearch").addEventListener("input",()=>{
  const q=$("userSearch").value.trim().toLowerCase();
  document.querySelectorAll("#setUsers .prow").forEach(row=>{
    const login=(row.querySelector(".ulogin")?.value||"").toLowerCase();
    const first=(row.querySelector(".ufirst")?.value||"").toLowerCase();
    const last=(row.querySelector(".ulast")?.value||"").toLowerCase();
    const role=(row.querySelector(".urole")?.value||"").toLowerCase();
    row.style.display=!q||login.includes(q)||first.includes(q)||last.includes(q)||role.includes(q)?"":"none";
  });
});
// Bootstrap-first-admin: the toggle can't be turned on until this succeeds
// (checked in saveConfig()), so no default/throwaway admin ever exists.
let BOOTSTRAPPED_ADMIN=false;
$("setUsersEnabled").addEventListener("change", async ()=>{
  const box=$("bootstrapAdmin");
  if(!$("setUsersEnabled").checked){ box.style.display="none"; return; }
  try{
    const users=await getJSON("/api/users");
    if(users.length){ BOOTSTRAPPED_ADMIN=true; box.style.display="none"; return; }
  }catch{}
  BOOTSTRAPPED_ADMIN=false;
  box.style.display="";
});
$("bootSubmit").addEventListener("click", async ()=>{
  const st=$("bootStatus");
  const loginName=$("bootLogin").value.trim(), password=$("bootPassword").value;
  if(!loginName||!password){ st.className="pstatus err"; st.textContent=t("settings.users.bootstrap_required"); return; }
  const btn=$("bootSubmit"); btn.disabled=true;
  st.className="pstatus work"; st.textContent=t("settings.users.bootstrap_creating");
  try{
    const r=await postJSON("/api/users",{firstName:$("bootFirst").value.trim(),lastName:$("bootLast").value.trim(),loginName,password,role:"admin",otpEnabled:false});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(userErrorText(d,d.error||("HTTP "+r.status)));
    st.className="pstatus ok"; st.textContent=t("settings.users.bootstrap_created");
    BOOTSTRAPPED_ADMIN=true;
    $("bootstrapAdmin").style.display="none";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
});
if($("dockerRestartBtn")) $("dockerRestartBtn").addEventListener("click", async ()=>{
  if(!confirm(t("maintenance.docker_restart_confirm"))) return;
  const st=$("dockerRestartStatus");
  st.className="pstatus work"; st.textContent=t("maintenance.docker_restarting_status");
  try{
    const r=await postJSON("/api/restart",{});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
});
// One "Discover" button opens this dialog with a scope choice — Local
// network (every subnet this host is connected to) or a specific one the
// user types in, matching the two genuinely different scans GET /api/discover
// already supports (no subnet param vs ?subnet=).
$("discover").addEventListener("click",openSubnetModal);
function applyDiscoverScope(){
  const subnet=$("discoverScopeSubnet").checked;
  $("subnetModalInput").style.display=subnet?"":"none";
  $("discoverScopeHint").textContent=subnet
    ?t("settings.printers.discover_scope_hint_subnet")
    :t("settings.printers.discover_scope_hint_local");
  if(subnet) setTimeout(()=>$("subnetModalInput").focus(),50);
}
function openSubnetModal(){
  $("discoverScopeLocal").checked=true;
  $("subnetModalInput").value="";
  $("subnetModalStatus").textContent="";
  applyDiscoverScope();
  $("subnetModal").classList.add("show");
}
function closeSubnetModal(){ $("subnetModal").classList.remove("show"); }
function doSubnetScan(){
  if($("discoverScopeLocal").checked){ closeSubnetModal(); runDiscover(); return; }
  const subnet=$("subnetModalInput").value.trim();
  if(!subnet){ $("subnetModalStatus").className="pstatus err"; $("subnetModalStatus").textContent=t("settings.printers.discover_no_subnet"); return; }
  closeSubnetModal();
  runDiscover(subnet);
}
$("discoverScopeLocal").addEventListener("change",applyDiscoverScope);
$("discoverScopeSubnet").addEventListener("change",applyDiscoverScope);
$("subnetModalInput").addEventListener("keydown",e=>{ if(e.key==="Enter") doSubnetScan(); });
$("saveCfg").addEventListener("click",saveConfig);

// Grey out and disable the entire notification body while the master switch
// is off. Re-enabling it re-asserts each nested control's OWN disabled state
// right after (milestone chips need their own switch on, each provider card
// needs its own switch on) — the blanket toggle above doesn't know about
// those, only about the master.
function applyNtfEnabled(){
  const on=$("ntfEnabled").checked;
  $("ntfBody").classList.toggle("disabled", !on);
  $("ntfBody").querySelectorAll("input,button").forEach(i=>i.disabled=!on);
  if(on){
    syncMilestoneNesting();
    syncProviderCard("ntfyEnabled","ntfyBody");
    syncProviderCard("telegramEnabled","telegramBody");
    syncProviderCard("webhookEnabled","webhookBody");
  }
}
function syncMilestoneNesting(){
  const on=$("ntfMilestones").checked;
  $("ntfMilestoneNest").classList.toggle("disabled", !on);
  document.querySelectorAll("#ntfMilestoneChips .btn-chip").forEach(b=>b.disabled=!on);
}
function syncProviderCard(switchId,bodyId){
  const on=$(switchId).checked;
  $(bodyId).classList.toggle("disabled", !on);
  $(bodyId).querySelectorAll("input,button").forEach(el=>el.disabled=!on);
}
// Selected milestone percentages — a Set so toggling a chip is O(1) and
// order in the underlying array never matters for equality checks.
let NTF_MILESTONES=new Set([25,50,75]);
// The bot token never round-trips (see setSecretFieldState) — Discard can't
// "restore" a cleared/replaced value the way it does for every other field,
// only put the secret control back to whatever visual state (Configured vs
// empty) matched what was actually on file as of the last load/save.
let NTF_HAS_TELEGRAM_TOKEN=false;
// The webhook URL is itself the credential, so like the bot token it never
// arrives from the server — only whether one is on file.
let NTF_HAS_WEBHOOK_URL=false;
function renderMilestoneChips(){
  document.querySelectorAll("#ntfMilestoneChips .btn-chip").forEach(b=>{
    b.classList.toggle("active", NTF_MILESTONES.has(parseInt(b.dataset.pct,10)));
  });
  const n=NTF_MILESTONES.size;
  $("ntfMilestoneHint").textContent = n
    ? tn("settings.notif.milestone_hint",n,{percents:[...NTF_MILESTONES].sort((a,b)=>a-b).join('%, ')})
    : t("settings.notif.milestone_hint_none");
}
// Maps /api/notify-test's stable `code` field (added alongside its existing
// `error` string — see server.js) to a translation key, for the SnapCon-
// owned validation messages only. printer_offline is handled separately
// since it needs {name}/{detail} params. Any code not in this table (or
// absent — e.g. a real network/provider failure) falls back to the raw
// `error`/exception text, same as the Printers-tab precedent.
const NOTIF_TEST_ERROR_KEYS={
  no_printers:"settings.notif.test_error_no_printers",
  missing_chat_id:"settings.notif.test_error_missing_chat_id",
  missing_bot_token:"settings.notif.test_error_missing_bot_token",
  invalid_topic:"settings.notif.test_error_invalid_topic",
  missing_webhook_url:"settings.notif.test_error_missing_webhook_url"
};
async function sendProviderTest(provider,btnId,statusId){
  const st=$(statusId), btn=$(btnId);
  st.className="pstatus work"; st.textContent=t("settings.notif.sending_test");
  btn.disabled=true;
  try{
    const body={ service:provider, includeImage:$("ntfImage").checked };
    if(provider==="ntfy") body.topic=$("ntfTopic").value.trim();
    else if(provider==="webhook"){ body.webhookUrl=secretFieldValue($("ntfWebhookUrlField")); body.webhookFormat=$("ntfWebhookFormat").value; }
    else { body.chatId=$("ntfChatId").value.trim(); body.botToken=secretFieldValue($("ntfBotTokenField")); }
    const r=await postJSON("/api/notify-test",body);
    const d=await r.json();
    if(!r.ok||d.error){
      let msg=d.error||("HTTP "+r.status);
      if(d.code==="printer_offline") msg=t("settings.notif.test_error_printer_offline",{name:d.name||"",detail:d.detail||""});
      else if(d.code && NOTIF_TEST_ERROR_KEYS[d.code]) msg=t(NOTIF_TEST_ERROR_KEYS[d.code]);
      throw new Error(msg);
    }
    st.className="pstatus ok"; st.textContent=provider==="telegram"?t("settings.notif.sent_telegram")
      :provider==="webhook"?t("settings.notif.sent_webhook"):t("settings.notif.sent_ntfy");
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}

// Shared by the Notifications-tab ntfy topic and the OTP-via-ntfy topic — a
// topic doubles as the ntfy access secret, so it needs real randomness.
function genRandomTopic(){
  const letters="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const buf=new Uint32Array(12); crypto.getRandomValues(buf);
  return [...buf].map(n=>letters[n%letters.length]).join("");
}
function otpServiceValue(){
  return $("otpSvcNtfy").checked ? "ntfy" : $("otpSvcTelegram").checked ? "telegram" : "resend";
}
function applyOtpServiceUI(){
  const svc=otpServiceValue();
  $("otpResendBody").style.display=svc==="resend"?"":"none";
  $("otpNtfyBody").style.display=svc==="ntfy"?"":"none";
  $("otpTelegramBody").style.display=svc==="telegram"?"":"none";
}
let OTP_TELEGRAM_BOT_CONFIGURED=false;
function refreshOtpTelegramBotHint(){
  const el=$("otpTelegramBotHint");
  if(!el) return;
  el.className="settings-help"+(OTP_TELEGRAM_BOT_CONFIGURED?"":" warn");
  el.textContent=OTP_TELEGRAM_BOT_CONFIGURED
    ? t("settings.users.otp_bot_configured_hint")
    : t("settings.users.otp_bot_not_configured_hint");
}
// Maps /api/otp-test's additive `code` field to a translation key — mirrors
// the /api/notify-test precedent from the Notifications phase. Any code not
// listed (or a real provider/network failure with no code) falls back to
// the raw error/exception text.
const OTP_TEST_ERROR_KEYS={
  missing_topic:"settings.users.otp_error_missing_topic",
  missing_bot_config:"settings.users.otp_error_missing_bot_config",
  missing_chat_id:"settings.users.otp_error_missing_chat_id",
  missing_api_key:"settings.users.otp_error_missing_api_key",
  missing_from_address:"settings.users.otp_error_missing_from_address",
  missing_recipient:"settings.users.otp_error_missing_recipient"
};
async function doOtpTest(){
  const st=$("otpTestStatus");
  const svc=otpServiceValue();
  const body={ service: svc };
  if(svc==="ntfy"){
    body.ntfyTopic=$("otpNtfyTopic").value.trim();
  } else if(svc==="telegram"){
    body.chatId=$("otpTelegramChatId").value.trim();
  } else {
    const to=prompt(t("settings.users.otp_test_email_prompt"));
    if(!to) return; // cancelled
    body.apiKey=$("setResendKey").value.trim();
    body.fromAddress=$("setResendFrom").value.trim();
    body.to=to.trim();
  }
  st.className="pstatus work"; st.textContent=t("settings.notif.sending_test");
  try{
    const r=await postJSON("/api/otp-test",body);
    const d=await r.json();
    if(!r.ok||d.error){
      const msg=(d.code&&OTP_TEST_ERROR_KEYS[d.code])?t(OTP_TEST_ERROR_KEYS[d.code]):(d.error||("HTTP "+r.status));
      throw new Error(msg);
    }
    st.className="pstatus ok"; st.textContent=t("settings.users.otp_sent");
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// r.reason stays the raw legacy prose string (English, from server.js's
// probeFirmware()/connectors/http-utils.js's queryFirmwareInfo() — kept for
// any other consumer), while r.reasonCode/r.detail/r.state are additive
// fields this function prefers when present, so the SnapCon-owned wrapper
// prose translates while raw connector diagnostics (r.detail) and the
// technical state identifier (r.state, e.g. "printing") stay untranslated
// params. A skip reason with no recognized reasonCode (shouldn't happen,
// but the server contract isn't a compile-time guarantee) falls back to the
// raw string rather than showing nothing.
// ---- Select Firmware ----
// The selection is deliberately transient: it lives here, not in
// config.json. Deploy does not exist yet, and until it does there is
// nothing to persist a choice FOR — when it arrives it gets the relative
// path and revalidates it server-side anyway.
let SELECTED_FIRMWARE=null;   // { name, path } — path is relative to the firmware folder
function fmtFileSize(bytes){
  if(!(bytes>=0)) return "";
  if(bytes<1024) return bytes+" B";
  if(bytes<1024*1024) return (bytes/1024).toFixed(1)+" KB";
  return (bytes/(1024*1024)).toFixed(1)+" MB";
}
function openFirmwarePicker(){
  $("fwpickmodal").classList.add("show");
  navigateFirmwarePicker("");
}
function closeFirmwarePicker(){ $("fwpickmodal").classList.remove("show"); }
// `rel` is always a path relative to the configured firmware folder — the
// route accepts nothing else, so there is no absolute path for this client
// to leak or for the server to have to second-guess.
async function navigateFirmwarePicker(rel){
  const list=$("fwpicklist"), pathEl=$("fwpickpath");
  list.innerHTML=`<div class="browse-empty">${esc(t("settings.browse.loading"))}</div>`;
  let d;
  try{
    d=await getJSON("/api/firmware-files"+(rel?"?path="+encodeURIComponent(rel):""));
  }catch{
    list.innerHTML=`<div class="browse-empty">${esc(t("settings.firmware.pick_failed"))}</div>`;
    return;
  }
  if(d&&d.error){
    // The one error worth explaining rather than reporting: nothing is
    // configured yet, and the fix is on another tab.
    const msg=d.error==="no_folder"?t("settings.firmware.pick_no_folder"):t("settings.firmware.pick_failed");
    list.innerHTML=`<div class="browse-empty">${esc(msg)}</div>`;
    pathEl.textContent="";
    return;
  }
  pathEl.textContent=d.path?"/"+d.path:"/";
  list.innerHTML="";
  // parent is null only at the root; "" is a real value meaning "the root".
  if(d.parent!==null&&d.parent!==undefined){
    const up=document.createElement("button");
    up.className="browse-item browse-up"; up.textContent="↑  ..";
    up.onclick=()=>navigateFirmwarePicker(d.parent);
    list.appendChild(up);
  }
  (d.dirs||[]).forEach(dir=>{
    const b=document.createElement("button");
    b.className="browse-item"; b.textContent="📁  "+dir.name;
    b.onclick=()=>navigateFirmwarePicker(dir.path);
    list.appendChild(b);
  });
  (d.files||[]).forEach(file=>{
    const b=document.createElement("button");
    b.className="browse-item";
    const meta=[fmtFileSize(file.size), file.mtime?new Date(file.mtime).toLocaleDateString():""].filter(Boolean).join(" · ");
    b.innerHTML=`<span>${esc(file.name)}</span><span style="color:var(--ink-faint);font-size:11px;margin-left:auto">${esc(meta)}</span>`;
    b.style.display="flex"; b.style.alignItems="center"; b.style.gap="8px";
    b.onclick=()=>selectFirmware(file);
    list.appendChild(b);
  });
  if(!(d.dirs||[]).length&&!(d.files||[]).length){
    list.innerHTML=`<div class="browse-empty">${esc(t("settings.firmware.pick_empty"))}</div>`;
  }
}
// Inspecting at selection time rather than only at deploy time is the point:
// a file that cannot be flashed should say so while the user is still
// choosing, not after they have ticked eight printers.
async function selectFirmware(file){
  SELECTED_FIRMWARE={ name:file.name, path:file.path, inspect:null };
  closeFirmwarePicker();
  const st=$("fwStatus");
  st.className="pstatus"; st.textContent="";
  renderFirmwareImageCard();
  syncFirmwareDeployButton();
  const ins=await inspectSelectedFirmware();
  if(!SELECTED_FIRMWARE||SELECTED_FIRMWARE.path!==file.path) return;   // superseded while inspecting
  // The card carries the version, the warnings and any hard failure, so the
  // status line does not repeat them.
  renderFirmwareImageCard();
  // A target version regroups the whole list into needs-update / up-to-date.
  renderFirmwareList();
}

// The two toggles are stored settings, saved through their own tiny route
// rather than the shared /api/config body — a partial post there would fall
// back to CFG for everything it omitted, which is a lot to risk for two
// booleans.
async function saveFirmwareOptions(){
  try{
    await postJSON("/api/firmware-options",{
      skipCurrent: firmwareSkipCurrentEnabled(),
      verify: firmwareVerifyEnabled() });
  }catch{ /* a failed save is not worth interrupting the page for */ }
}

async function stopFirmwareQueue(){
  const btn=$("fwStop");
  if(btn) btn.disabled=true;
  try{ await postJSON("/api/firmware-stop",{}); }
  catch{ if(btn) btn.disabled=false; return; }
  pollFirmwareStatus();
}
// Reads the firmware image server-side and reports what could be
// established from its bytes. Never throws: a failed inspection is reported
// as a hard failure, which is the safe direction.
async function inspectSelectedFirmware(){
  if(!SELECTED_FIRMWARE) return null;
  let r;
  try{ r=await fetch("/api/firmware-inspect?path="+encodeURIComponent(SELECTED_FIRMWARE.path)); }
  catch(e){ return { hardFail:[e.message], warnings:[] }; }
  checkAuthFailure(r);
  // Branch on the CONTENT TYPE, not the status. A missing route and a missing
  // file are both 404 — one answers with an HTML error page, the other with
  // {error:"Firmware file not found"} — so status alone cannot tell "this
  // SnapCon is older than this page" from "that file is gone", and guessing
  // wrong sends the user to look in entirely the wrong place.
  if(!(r.headers.get("content-type")||"").includes("application/json")){
    return { hardFail:[t("settings.firmware.inspect_http_error",{status:r.status})], warnings:[] };
  }
  let d;
  try{ d=await r.json(); }
  catch{ return { hardFail:[t("settings.firmware.inspect_http_error",{status:r.status})], warnings:[] }; }
  if(!d||d.error) return { hardFail:[(d&&d.error)||"Could not read the firmware file"], warnings:[] };
  SELECTED_FIRMWARE.inspect=d;
  return d;
}
// ---- Deploy firmware ----
// Multi-select: tick the printers to update and the SERVER runs them one at a
// time (FW_QUEUE in server.js). A failure records that printer and moves to the
// next rather than cancelling the rest.
//
// Only printers whose connector advertises firmwareDeploy can be picked; today
// that is the Snapmaker U1, whose network flashing protocol is the only one
// verified against real hardware.
//
// Eligibility is decided twice and the SERVER's answer is the one that counts:
// what is dimmed here comes from the last fleet poll, which can be seconds
// stale, while /api/firmware-deploy re-asks the printer at request time and
// again immediately before the irreversible write.
const FW_ROWS = new Map();      // printer index -> its .fwcard element
let FW_DATA = [];               // last /api/firmware rows
let FW_LAST_STATUS = null;      // last /api/firmware-status body, for redraws
let FW_SORT = "default";
let FW_LOADED = false;          // the list has been read at least once this session

// Selection lives HERE, not in the DOM. Rows move between groups as versions
// change and as filters apply, and a checkbox that gets re-rendered loses its
// state — so the set is the authority and the checkboxes are drawn from it.
const FW_SEL = new Set();

// Collapsed by default for everything that is not the thing you came here to
// do. "Needs update" is the actionable group and stays open.
const FW_COLLAPSED = { needs: false, uptodate: true, unsupported: true, unavailable: true };

// A U1 reboots in about two minutes (measured: flash to klippy-ready in ~110s).
// Used only to phrase the wait, never to decide anything.
const FW_REBOOT_EXPECTED_MS = 120 * 1000;
// How long a printer may stay away before the row calls it a failure. Well
// past the observed recovery and comfortably under the server's own 15-minute
// claim on the fleet card, so the row never contradicts the card.
const FW_REBOOT_ERROR_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

// Why this printer cannot be picked right now, as a stable CODE, or null if it
// can. Deliberately mirrors firmwareDeployBlockedBy() in server.js: a rule that
// existed here and not there would disable a control the server would have
// accepted.
//
// A code rather than a message because two callers need different things from
// the same decision — the checkbox needs a sentence, the grouping and the sort
// need something to group by. Sorting on the rendered text would order printers
// alphabetically by their translated status, which is nobody's idea of an order.
function firmwareIneligibleCode(p){
  if(!p) return "offline";
  if(!(p.capabilities&&p.capabilities.firmwareDeploy)) return "unsupported";
  if(p.state==="updating"||p.state==="rebooting") return "in_progress";
  if(!p.online) return "offline";
  if(p.state==="printing"||p.state==="paused") return "printing";
  return null;
}
const FW_INELIGIBLE_KEYS={
  unsupported:"settings.firmware.ineligible_unsupported",
  in_progress:"settings.firmware.ineligible_in_progress",
  offline:"settings.firmware.ineligible_offline",
  printing:"settings.firmware.ineligible_printing",
};
function firmwareIneligibleReason(p){
  const code=firmwareIneligibleCode(p);
  return code ? t(FW_INELIGIBLE_KEYS[code]) : null;
}

// Grouped by what the operator would do about it: ready first, then already
// updating, then blocked by a print, then unreachable, then never applicable.
const FW_STATUS_RANK={ ok:0, in_progress:1, printing:2, offline:3, unsupported:4 };
function firmwareStatusRank(r){
  return FW_STATUS_RANK[firmwareIneligibleCode(FLEET.find(p=>p.id===r.id))||"ok"];
}
const firmwareFleetOf = idx => FLEET.find(p=>p.id===idx);
const firmwareCanDeploy = idx => {
  const p=firmwareFleetOf(idx);
  return !!(p&&p.capabilities&&p.capabilities.firmwareDeploy);
};

// ---------------------------------------------------------------------------
// The image being deployed
// ---------------------------------------------------------------------------

// The version this deploy would move printers TO, or null when the image does
// not state one (pre-1.6.0 U1 images carry no build marker). Never guessed from
// the file name — see connectors/firmwareImage.js.
function firmwareTargetVersion(){
  return (SELECTED_FIRMWARE&&SELECTED_FIRMWARE.inspect&&SELECTED_FIRMWARE.inspect.version)||null;
}
// The full build identifier the image would leave on a printer, composed
// server-side so both sides compare the same string.
function firmwareTargetBuild(){
  return (SELECTED_FIRMWARE&&SELECTED_FIRMWARE.inspect&&SELECTED_FIRMWARE.inspect.buildId)||null;
}

// What this printer is ACTUALLY running.
//
// r.firmware is product_info.firmware_version, which a U1 truncates to three
// parts ("1.6.0"). r.klipper is printer/info software_version, which carries
// the whole build ("1.6.0.267_20260815150420") — the same string the image
// states. Comparing the truncated one against an image version matches
// nothing, which is why every printer already running the image was still
// being offered for a re-flash.
function firmwarePrinterBuild(r){ return r.klipper||null; }
function firmwarePrinterVersion(r){
  const k=String(r.klipper||"").split("_")[0];
  return k||r.firmware||null;
}
// With a build stamp the whole identifier must match. Without one the version
// half is the strongest reading available — still from the payload, never
// from the file name.
function firmwareIsCurrent(r){
  const build=firmwareTargetBuild();
  if(build) return firmwarePrinterBuild(r)===build;
  const ver=firmwareTargetVersion();
  return !!ver&&firmwarePrinterVersion(r)===ver;
}

// Compare two printer-reported version strings numerically, so 1.10 sorts above
// 1.9 rather than below it the way a string compare would. Splits on any
// non-digit run, which covers "1.6.0" and "1.5.2.13" alike.
function compareFirmwareVersions(a,b){
  const pa=String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb=String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for(let i=0;i<Math.max(pa.length,pb.length);i++){
    const d=(pa[i]||0)-(pb[i]||0);
    if(d) return d;
  }
  return 0;
}

// Renders the image card: a summary line once something is chosen, an
// explanation when nothing is. The printer list renders either way — hiding the
// fleet behind an image selection answers a question nobody asked first.
function renderFirmwareImageCard(){
  const box=$("fwImageText");
  if(!box) return;
  const sel=$("fwSelect");
  if(!SELECTED_FIRMWARE){
    box.innerHTML=`<div class="fwimage-name">${esc(t("settings.firmware.image_none_title"))}</div>`+
      `<div class="fwimage-help">${esc(t("settings.firmware.image_none_help"))}</div>`;
    if(sel) sel.textContent=t("settings.firmware.select_button");
    return;
  }
  const ins=SELECTED_FIRMWARE.inspect||{};
  const bits=[];
  bits.push(ins.version
    ? `<b>${esc(t("settings.firmware.image_version",{version:ins.version}))}</b>`
    : esc(t("settings.firmware.image_version_unknown")));
  if(ins.buildTime) bits.push(esc(ins.buildTime));
  if(ins.size) bits.push(esc(fmtFileSize(ins.size)));
  // A hard failure means the file cannot be used at all; warnings are things to
  // check, never a claim that the image was proven to fit this model.
  const bad=(ins.hardFail||[]).join("; ");
  const warn=(ins.warnings||[]).join(" · ");
  box.innerHTML=`<div class="fwimage-name" title="${esc(SELECTED_FIRMWARE.path)}">${esc(SELECTED_FIRMWARE.name)}</div>`+
    `<div class="fwimage-meta">${bits.join(" · ")}</div>`+
    (bad?`<div class="fwimage-warn">${esc(t("settings.firmware.inspect_failed",{error:bad}))}</div>`:"")+
    (!bad&&warn?`<div class="fwimage-warn">${esc(t("settings.firmware.inspect_warning",{warning:warn}))}</div>`:"")+
    (!firmwareVerifyEnabled()?`<div class="fwimage-warn">${esc(t("settings.firmware.confirm_no_verify"))}</div>`:"");
  if(sel) sel.textContent=t("settings.firmware.image_replace");
}

// ---------------------------------------------------------------------------
// Filtering, sorting and grouping
// ---------------------------------------------------------------------------

const connectorLabel=type=>(CONNECTOR_TYPES.find(c=>c.type===type)||{}).label||type||"";

function firmwareRowCompare(a,b){
  const byName=()=>String(a.name||"").localeCompare(String(b.name||""));
  if(FW_SORT==="name") return byName();
  if(FW_SORT==="status") return (firmwareStatusRank(a)-firmwareStatusRank(b))||byName();
  if(FW_SORT==="version"){
    // Oldest first: the printers that need updating are the reason to sort by
    // version at all. A printer that reports no version sorts last rather than
    // being treated as 0, which would put it at the top as the most out of date.
    const av=a.firmware||null, bv=b.firmware||null;
    if(av&&bv) return compareFirmwareVersions(av,bv)||byName();
    if(av) return -1;
    if(bv) return 1;
    return byName();
  }
  return 0;   // "default" — keep the order loadFirmware() built (sort is stable)
}

function firmwareRowMatches(r,q,conn){
  // Matched on the printer's real connector id, never on brand or model text:
  // brand is user-editable on generic Klipper, so it is not evidence of what a
  // printer actually speaks.
  if(conn&&r.connector!==conn) return false;
  if(!q) return true;
  return [r.name,r.machine,r.firmware,r.software,r.klipper,connectorLabel(r.connector)]
    .filter(Boolean).join(" ").toLowerCase().includes(q);
}

// True while the server is doing something to this printer. Such a printer is
// shown by its DEPLOY state, never by the version read — during a reboot the
// version read legitimately fails, and reporting that as "Offline — HTTP 502"
// is what makes an operator intervene in the one moment they must not.
function firmwareDeployActive(idx){
  const x=FW_LAST_STATUS&&FW_LAST_STATUS.printers&&FW_LAST_STATUS.printers[idx];
  return !!x&&!["updated","failed","skipped","cancelled"].includes(x.phase);
}

function firmwareGroupOf(r,target){
  if(!firmwareCanDeploy(r.id)||r.reasonCode==="not_supported") return "unsupported";
  if(firmwareDeployActive(r.id)) return "needs";
  if(r.skipped) return "unavailable";
  if(!target) return "needs";
  return firmwareIsCurrent(r) ? "uptodate" : "needs";
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

// Created once per printer and reused across renders: a card may be mid-deploy
// with a progress bar being written into it, and rebuilding it would throw
// that away along with the group it belongs to.
function firmwareRowEl(r){
  let el=FW_ROWS.get(r.id);
  if(!el){
    el=document.createElement("div");
    el.className="fwcard";
    el.dataset.fwid=String(r.id);
    el.innerHTML=`<div class="fwcard-head">`+
        `<input type="checkbox" class="fwchk checkbox-input" id="fwchk-${r.id}">`+
        `<label class="fwcard-id" for="fwchk-${r.id}">`+
          `<span class="fwcard-vendor"></span><span class="fwcard-name"></span>`+
        `</label>`+
      `</div>`+
      `<div class="fwver"></div>`+
      `<div class="fwstat"></div>`;
    el.querySelector(".fwchk").addEventListener("change",e=>{
      if(e.target.checked) FW_SEL.add(r.id); else FW_SEL.delete(r.id);
      el.classList.toggle("sel",e.target.checked);
      if(e.target.checked) el.classList.remove("dim");
      else updateFirmwareRowCells(el,r);
      syncFirmwareDeployButton();
      renderFirmwareGroupHeads();
    });
    FW_ROWS.set(r.id,el);
  }
  updateFirmwareRowCells(el,r);
  return el;
}

function updateFirmwareRowCells(el,r){
  const target=firmwareTargetVersion();
  const why=firmwareIneligibleReason(firmwareFleetOf(r.id));
  const chk=el.querySelector(".fwchk");
  chk.disabled=!!why;
  chk.checked=FW_SEL.has(r.id);
  if(why){ chk.title=why; } else chk.removeAttribute("title");
  el.classList.toggle("ineligible",!!why);
  el.classList.toggle("sel",chk.checked);
  // Nothing to do to this printer: present and readable, but out of the way.
  // Never while it is SELECTED, though — an up-to-date printer is still
  // perfectly selectable (the server just skips it), and a ticked card at
  // half opacity reads as disabled, which is exactly backwards.
  const group=firmwareGroupOf(r,firmwareTargetVersion());
  const settled=FW_LAST_STATUS&&FW_LAST_STATUS.printers&&FW_LAST_STATUS.printers[r.id];
  el.classList.toggle("dim",!chk.checked&&!settled&&(group==="uptodate"||group==="unsupported"));
  // The vendor comes from the printer's own Brand field, not from parsing its
  // name — a name is whatever someone typed.
  const fleet=firmwareFleetOf(r.id);
  el.querySelector(".fwcard-vendor").textContent=(fleet&&fleet.brand)||"";

  // The MCU detail is near-identical on every row and is not a decision input,
  // so it lives in the row's title rather than a second line. The exception is
  // a board that DISAGREES with the others: on a U1 every board shares one
  // version, so a mismatch means one missed an update — rare, actionable, and
  // worth a badge. Creality never flags: its boards are independent components.
  const mcus=r.mcus||[];
  const distinct=new Set(mcus.map(m=>m.version||"—"));
  const mismatch=r.uniformMcuVersions&&distinct.size>1;
  el.title=[mcus.map(m=>m.name+": "+(m.version||"—")).join("\n"), r.os||""].filter(Boolean).join("\n");
  el.querySelector(".fwcard-name").innerHTML=esc(r.name)+
    (mismatch?` <span class="fwwarn" title="${esc(t("settings.firmware.row_mcu_mismatch"))}">⚠</span>`:"");

  const ver=el.querySelector(".fwver");
  if(r.skipped&&!firmwareDeployActive(r.id)){
    // Unreadable version: say why instead of inventing a transition.
    ver.className="fwver fwskip";
    ver.textContent=firmwareSkipReasonText(r);
  } else if(target&&firmwareIsCurrent(r)){
    ver.className="fwver current";
    ver.textContent=firmwarePrinterVersion(r)||"";
    ver.title=firmwarePrinterBuild(r)||"";
  } else if(target&&firmwarePrinterVersion(r)){
    ver.className="fwver";
    ver.innerHTML=esc(firmwarePrinterVersion(r))+` <span class="fwver-to">→ ${esc(target)}</span>`;
    ver.title=(firmwarePrinterBuild(r)||"")+" → "+(firmwareTargetBuild()||target);
  } else {
    ver.className="fwver";
    ver.textContent=firmwarePrinterVersion(r)||t("settings.firmware.row_no_target");
    ver.title=firmwarePrinterBuild(r)||"";
  }
}

// ---------------------------------------------------------------------------
// The one status slot per row
// ---------------------------------------------------------------------------

const FW_SETTLED=["updated","failed","skipped","cancelled"];

// What a status SAYS, separately from the markup that carries it. Split out
// because these values change on every poll — the byte count each second,
// the reboot countdown every four — while the elements around them must not
// be recreated. See renderFirmwareRowStatus.
function firmwareStatusText(x,queuePos){
  switch(x.phase){
    // The position answers "when does mine start" without a separate list.
    case "queued":    return queuePos>0 ? t("settings.firmware.st_queued_nth",{n:queuePos})
                                        : t("settings.firmware.st_queued");
    case "preparing": return t("settings.firmware.st_preparing");
    case "upload":    return t("settings.firmware.st_uploading_bytes",
      {sent:fmtFileSize(x.sent||0),total:fmtFileSize(x.total||0)});
    case "verify":    return t("settings.firmware.st_verifying_image");
    case "flash":     return t("settings.firmware.st_flashing");
    case "rebooting": {
      const elapsed=x.flashStartedAt?Date.now()-x.flashStartedAt:0;
      if(elapsed>FW_REBOOT_ERROR_MS) return t("settings.firmware.st_failed");
      return elapsed<FW_REBOOT_EXPECTED_MS
        ? t("settings.firmware.st_rebooting_eta",{eta:fmtDuration((FW_REBOOT_EXPECTED_MS-elapsed)/1000)})
        : t("settings.firmware.st_rebooting")+" · "+fmtDuration(elapsed/1000);
    }
    // How long ago it finished, so a card that has been sitting there since
    // yesterday does not read like it just happened.
    case "updated":   return x.ts?t("settings.firmware.st_updated_ago",{ago:fmtTime(x.ts)})
                                 :t("settings.firmware.st_updated");
    case "skipped":   return t("settings.firmware.st_skipped");
    // Distinct from both "skipped" (already on this build — nothing needed
    // doing) and "failed" (it was attempted and went wrong). Rejected means the
    // server would not start it, and the reason is the useful part.
    case "rejected":  return t("settings.firmware.st_rejected");
    case "cancelled": return t("settings.firmware.st_cancelled");
    case "failed":    return t("settings.firmware.st_failed");
    default: return "";
  }
}
// Only the upload knows a real fraction. Everything else with a bar is
// indeterminate and sits full width, sweeping rather than claiming a
// percentage nothing reports.
function firmwareStatusPct(x){
  return x.phase==="upload" ? (x.total>0?(x.sent/x.total)*100:0) : 100;
}
// Which MARKUP a status needs. Distinct from the phase because two of them
// change shape without changing phase: a reboot that overruns becomes an
// error, and an unverified flash carries an extra line.
function firmwareStatusShape(x){
  if(!x) return "";
  switch(x.phase){
    case "rebooting": {
      const elapsed=x.flashStartedAt?Date.now()-x.flashStartedAt:0;
      return elapsed>FW_REBOOT_ERROR_MS ? "rebooting-lost" : "rebooting";
    }
    case "updated": return x.verify==="none" ? "updated-unverified" : "updated";
    case "failed":  return x.error ? "failed-reason" : "failed";
    case "rejected": return x.error ? "rejected-reason" : "rejected";
    default: return x.phase;
  }
}

// A chip for a state that simply IS, a label plus a 4px bar for one that is
// moving. Two shapes, so which kind of state a card is in is legible before
// any of the words are.
function firmwareStatusHtml(x,queuePos){
  const txt=firmwareStatusText(x,queuePos);
  const chip=cls=>`<span class="fwstat-chip ${cls}" title="${esc(txt)}">${esc(txt)}</span>`;
  const label=cls=>`<div class="fwstat-label ${cls}" title="${esc(txt)}">${esc(txt)}</div>`;
  const bar=working=>`<div class="prog-track"><div class="prog-fill ${working?"amber working":"cyan"}" `+
    `style="width:${Math.max(0,Math.min(100,firmwareStatusPct(x)))}%"></div></div>`;

  switch(x.phase){
    case "queued":    return chip("");
    case "preparing": return chip("accent");
    case "upload":    return label("")+bar(false);
    case "verify":    return label("")+bar(true);
    case "flash":     return label("")+bar(true);
    case "rebooting":
      // Past the point where waiting is still reasonable, this stops being a
      // wait and becomes something to look at.
      if(firmwareStatusShape(x)==="rebooting-lost"){
        return chip("err")+
          `<div class="fwstat-reason">${esc(t("settings.firmware.row_refresh_failed"))}</div>`;
      }
      return label("warn")+bar(true);
    case "updated":
      return chip("ok")+
        (x.verify==="none"?`<div class="fwstat-reason">${esc(t("settings.firmware.st_unverified"))}</div>`:"");
    case "skipped":   return chip("ok");
    // Same treatment as a failure, including Retry: the reasons are things an
    // operator can act on (stop the print, clear the fault, rename the file)
    // and then try that printer again without re-running the whole batch.
    case "rejected":  return chip("err")+
        (x.error?`<div class="fwstat-reason" title="${esc(x.error)}">${esc(x.error)}</div>`:"")+
        `<button type="button" class="fwstat-retry" data-fwretry="1">${esc(t("settings.firmware.st_retry"))}</button>`;
    case "cancelled": return chip("");
    case "failed":
      // The reason, not a raw HTTP code on its own, and a way to try again.
      return chip("err")+
        (x.error?`<div class="fwstat-reason" title="${esc(x.error)}">${esc(x.error)}</div>`:"")+
        `<button type="button" class="fwstat-retry" data-fwretry="1">${esc(t("settings.firmware.st_retry"))}</button>`;
    default: return "";
  }
}

const FW_CARD_STATE={ upload:"busy", verify:"busy", flash:"busy", preparing:"busy",
                      rebooting:"rebooting", updated:"done", failed:"failed",
                      // A printer the server refused reads as a failure, because
                      // that is what it is from the operator's side: they asked
                      // for it and it did not happen.
                      rejected:"failed" };
function renderFirmwareRowStatus(idx,x,queuePos){
  const el=FW_ROWS.get(idx);
  if(!el) return;
  const slot=el.querySelector(".fwstat");
  if(!slot) return;
  // The border carries the state, so the grid reads as a picture before any
  // of the words do.
  const state=(x&&FW_CARD_STATE[x.phase])||null;
  ["busy","rebooting","done","failed"].forEach(c=>el.classList.toggle(c,state===c));
  if(state) el.classList.remove("dim");
  // Rebuild only when the SHAPE changes. Keying on the rendered markup does
  // not work: the byte count changes every second and the reboot countdown
  // every four, so the markup always differs and .prog-fill would be
  // destroyed and recreated on every tick — restarting its animation from
  // zero each time, so the bar visibly stutters instead of running. Within a
  // shape only the words and the width move.
  const shape=firmwareStatusShape(x);
  if(slot.dataset.shape!==shape){
    slot.dataset.shape=shape;
    slot.innerHTML=x?firmwareStatusHtml(x,queuePos):"";
    const retry=slot.querySelector("[data-fwretry]");
    if(retry) retry.addEventListener("click",()=>retryFirmwarePrinter(idx));
  }
  if(x) updateFirmwareStatusValues(slot,x,queuePos);
}

// The per-tick update: text and width only, never structure.
function updateFirmwareStatusValues(slot,x,queuePos){
  const txt=firmwareStatusText(x,queuePos);
  const words=slot.querySelector(".fwstat-label")||slot.querySelector(".fwstat-chip");
  if(words&&words.textContent!==txt){ words.textContent=txt; words.title=txt; }
  const fill=slot.querySelector(".prog-fill");
  if(fill){
    const w=Math.max(0,Math.min(100,firmwareStatusPct(x)))+"%";
    if(fill.style.width!==w) fill.style.width=w;
  }
}

async function retryFirmwarePrinter(idx){
  if(!SELECTED_FIRMWARE) return;
  FW_SEL.add(idx);
  syncFirmwareDeployButton();
  await confirmFirmwareDeploy();
}

// ---------------------------------------------------------------------------
// The grouped list
// ---------------------------------------------------------------------------

const FW_GROUP_ORDER=["needs","uptodate","unsupported","unavailable"];
const FW_GROUP_TITLE_KEYS={
  needs:"settings.firmware.group_needs_update",
  uptodate:"settings.firmware.group_up_to_date",
  unsupported:"settings.firmware.group_not_supported",
  unavailable:"settings.firmware.group_unavailable",
};
let FW_GROUPED={ needs:[], uptodate:[], unsupported:[], unavailable:[] };

function renderFirmwareList(){
  const wrap=$("fwResults");
  if(!wrap) return;
  const target=firmwareTargetVersion();
  const q=($("fwSearch")?$("fwSearch").value:"").trim().toLowerCase();
  const conn=$("fwConnector")?$("fwConnector").value:"";

  FW_GROUPED={ needs:[], uptodate:[], unsupported:[], unavailable:[] };
  let shown=0;
  FW_DATA.slice().sort(firmwareRowCompare).forEach(r=>{
    if(!firmwareRowMatches(r,q,conn)) return;
    FW_GROUPED[firmwareGroupOf(r,target)].push(r);
    shown++;
  });

  // Group shells are cheap to rebuild; the ROWS inside them are reused, so a
  // transfer in flight keeps its bar and its place.
  wrap.innerHTML=FW_GROUP_ORDER.filter(g=>FW_GROUPED[g].length).map(g=>
    `<div class="fwgroup${FW_COLLAPSED[g]?" collapsed":""}" data-fwgroup="${g}">`+
      `<div class="fwgroup-head">`+
        (g==="needs"
          ? `<input type="checkbox" class="checkbox-input fwgroup-all" data-fwgroup-all="${g}" `+
            `data-i18n-title="settings.firmware.group_select_all" title="Select every printer in this group">`
          : `<span></span>`)+
        `<div class="fwgroup-title">${esc(t(FW_GROUP_TITLE_KEYS[g]))}`+
          `<span class="fwgroup-count" data-fwgroup-count="${g}"></span></div>`+
        `<div class="fwgroup-right"><span data-fwgroup-summary="${g}"></span>`+
          `<button type="button" class="fwgroup-toggle" data-fwgroup-toggle="${g}"></button></div>`+
      `</div>`+
      `<div class="fwgroup-body fwgrid" data-fwgroup-body="${g}"></div>`+
    `</div>`).join("");

  FW_GROUP_ORDER.forEach(g=>{
    const body=wrap.querySelector(`[data-fwgroup-body="${g}"]`);
    if(!body) return;
    FW_GROUPED[g].forEach(r=>body.appendChild(firmwareRowEl(r)));
  });

  wrap.querySelectorAll("[data-fwgroup-toggle]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const g=btn.dataset.fwgroupToggle;
      FW_COLLAPSED[g]=!FW_COLLAPSED[g];
      const sec=wrap.querySelector(`[data-fwgroup="${g}"]`);
      if(sec) sec.classList.toggle("collapsed",FW_COLLAPSED[g]);
      renderFirmwareGroupHeads();
    });
  });
  wrap.querySelectorAll("[data-fwgroup-all]").forEach(box=>{
    box.addEventListener("change",()=>{
      const rows=FW_GROUPED[box.dataset.fwgroupAll]||[];
      rows.forEach(r=>{
        if(firmwareIneligibleReason(firmwareFleetOf(r.id))) return;
        if(box.checked) FW_SEL.add(r.id); else FW_SEL.delete(r.id);
        const el=FW_ROWS.get(r.id);
        if(el) el.querySelector(".fwchk").checked=box.checked;
      });
      syncFirmwareDeployButton();
      renderFirmwareGroupHeads();
    });
  });

  if($("fwNoMatches")) $("fwNoMatches").style.display=(FW_DATA.length&&!shown)?"":"none";
  if($("fwTools")) $("fwTools").style.display=FW_DATA.length?"":"none";
  if($("fwChips")) $("fwChips").style.display=FW_DATA.length?"":"none";
  renderFirmwareGroupHeads();
  renderFirmwareChips();
  if(FW_LAST_STATUS) renderFirmwareStatus(FW_LAST_STATUS);
  syncFirmwareDeployButton();
}

function renderFirmwareGroupHeads(){
  const wrap=$("fwResults");
  if(!wrap) return;
  const target=firmwareTargetVersion();
  FW_GROUP_ORDER.forEach(g=>{
    const rows=FW_GROUPED[g]||[];
    const count=wrap.querySelector(`[data-fwgroup-count="${g}"]`);
    if(count) count.textContent=rows.length?String(rows.length):"";
    const sum=wrap.querySelector(`[data-fwgroup-summary="${g}"]`);
    if(sum){
      if(g==="needs"){
        const sel=rows.filter(r=>FW_SEL.has(r.id)).length;
        sum.textContent=target
          ? t("settings.firmware.group_selected_of",{n:sel,total:rows.length})+" · "+
            tn("settings.firmware.group_transition",rows.length,{n:rows.length,version:target})
          : t("settings.firmware.group_selected_of",{n:sel,total:rows.length});
      } else if(g==="uptodate"){
        sum.textContent=tn("settings.firmware.group_up_to_date_summary",rows.length,
          {n:rows.length,version:target||"—"});
      } else {
        sum.textContent=tn("settings.firmware.group_not_supported_summary",rows.length,{n:rows.length});
      }
    }
    const btn=wrap.querySelector(`[data-fwgroup-toggle="${g}"]`);
    if(btn) btn.textContent=t(FW_COLLAPSED[g]?"settings.firmware.group_show":"settings.firmware.group_hide");
    const all=wrap.querySelector(`[data-fwgroup-all="${g}"]`);
    if(all){
      const pickable=rows.filter(r=>!firmwareIneligibleReason(firmwareFleetOf(r.id)));
      const sel=pickable.filter(r=>FW_SEL.has(r.id)).length;
      all.checked=pickable.length>0&&sel===pickable.length;
      all.indeterminate=sel>0&&sel<pickable.length;
      all.disabled=!pickable.length;
    }
  });
}

// The fleet's version distribution, so "what state is my fleet in" is answered
// by a row of chips rather than by reading every printer.
function renderFirmwareChips(){
  const box=$("fwChips");
  if(!box) return;
  const target=firmwareTargetVersion();
  const counts=new Map();
  let unsupported=0, unknown=0;
  FW_DATA.forEach(r=>{
    if(!firmwareCanDeploy(r.id)||r.reasonCode==="not_supported"){ unsupported++; return; }
    // The same reading the rows show, so a chip and a row can never disagree
    // about what a printer is running.
    const v=firmwarePrinterVersion(r);
    if(!v){ unknown++; return; }
    counts.set(v,(counts.get(v)||0)+1);
  });
  const chips=[...counts.entries()]
    .sort((a,b)=>compareFirmwareVersions(b[0],a[0]))
    .map(([v,n])=>`<span class="fwchip${target&&v===target?" target":""}">${esc(v)} <b>${n}</b></span>`);
  if(unknown) chips.push(`<span class="fwchip muted">${esc(t("settings.firmware.chip_unknown"))} <b>${unknown}</b></span>`);
  if(unsupported) chips.push(`<span class="fwchip muted">${esc(t("settings.firmware.chip_unsupported"))} <b>${unsupported}</b></span>`);
  box.innerHTML=chips.join("");
}

// ---------------------------------------------------------------------------
// Selection, the footer and the deploy action
// ---------------------------------------------------------------------------

function selectedFirmwarePrinters(){
  // Never offer a printer the server would refuse: the set can outlive a
  // printer starting a print, and the row it came from may be filtered away.
  return [...FW_SEL].filter(idx=>!firmwareIneligibleReason(firmwareFleetOf(idx)));
}
function clearFirmwareSelection(){
  FW_SEL.clear();
  FW_ROWS.forEach(el=>{ const c=el.querySelector(".fwchk"); if(c) c.checked=false; });
  syncFirmwareDeployButton();
  renderFirmwareGroupHeads();
}

// Both default ON when the control is somehow missing — the same default the
// server applies to an absent field. For verification that is the difference
// between a check and no check, so the fallback has to be the safe one.
const firmwareSkipCurrentEnabled = () => { const el=$("fwSkipCurrent"); return el ? !!el.checked : true; };
const firmwareVerifyEnabled      = () => { const el=$("fwVerify");      return el ? !!el.checked : true; };

// The button names the scope of what it will do, and says why when it can't.
function syncFirmwareDeployButton(){
  const btn=$("fwDeploy");
  if(!btn) return;
  const n=selectedFirmwarePrinters().length;
  btn.textContent=tn("settings.firmware.deploy_n",n,{n});
  btn.disabled=!n||!SELECTED_FIRMWARE;
  const why = !SELECTED_FIRMWARE ? t("settings.firmware.deploy_no_file")
            : !n ? t("settings.firmware.deploy_no_selection") : "";
  if(why) btn.title=why; else btn.removeAttribute("title");

  // A selection survives filtering and collapsing: hiding a row must not
  // quietly change what this button will do. That means the count can exceed
  // the ticked boxes on screen, so say so rather than leaving it looking wrong.
  const info=$("fwSelInfo");
  if(info){
    const visible=new Set();
    FW_GROUP_ORDER.forEach(g=>{ if(!FW_COLLAPSED[g]) (FW_GROUPED[g]||[]).forEach(r=>visible.add(r.id)); });
    const hidden=selectedFirmwarePrinters().filter(i=>!visible.has(i)).length;
    info.textContent=hidden
      ? tn("settings.firmware.selection_selected",n,{n})+" · "+
        tn("settings.firmware.selection_hidden",hidden,{n:hidden})
      : "";
  }
}

// Batch progress, and an estimate built only from what this run has actually
// measured — no constant, and nothing shown at all until there is a real rate.
function renderFirmwareFooter(d){
  const el=$("fwFooterProgress"), stop=$("fwStop");
  if(!el) return;
  const printers=(d&&d.printers)||{};
  const keys=Object.keys(printers);
  if(!keys.length){ el.textContent=""; if(stop) stop.style.display="none"; return; }
  const phases=keys.map(k=>printers[k].phase);
  const done=phases.filter(p=>FW_SETTLED.includes(p)||p==="rebooting").length;
  const failed=phases.filter(p=>p==="failed").length;
  const parts=[t("settings.firmware.footer_progress",{done,total:phases.length})];
  if(failed) parts.push(`<span class="err">${esc(t("settings.firmware.footer_failed",{n:failed}))}</span>`);

  const eta=firmwareEtaSeconds(printers);
  if(eta!==null) parts.push(esc(t("settings.firmware.footer_eta",{eta:fmtDuration(eta)})));
  el.innerHTML=parts.join(" · ");

  const busy=phases.some(p=>!FW_SETTLED.includes(p));
  if(stop){
    stop.style.display=busy?"":"none";
    stop.disabled=!!(d&&d.stopping);
    stop.textContent=t(d&&d.stopping?"settings.firmware.footer_stopping":"settings.firmware.footer_stop");
  }
}

// Derived from the transfer actually in flight: bytes moved over seconds
// elapsed. Returns null rather than a guess when nothing has moved yet — an
// invented estimate is worse than none on an operation measured in minutes.
function firmwareEtaSeconds(printers){
  const keys=Object.keys(printers);
  const running=keys.map(k=>printers[k]).find(x=>x.phase==="upload"&&x.sent>0&&x.startedAt);
  if(!running) return null;
  const secs=(Date.now()-running.startedAt)/1000;
  if(secs<=0) return null;
  const rate=running.sent/secs;                 // bytes per second, measured
  if(!(rate>0)) return null;
  const rebootAllowance=FW_REBOOT_EXPECTED_MS/1000;
  let left=(running.total-running.sent)/rate+rebootAllowance;
  const waiting=keys.filter(k=>["queued","preparing"].includes(printers[k].phase)).length;
  left+=waiting*(running.total/rate+rebootAllowance);
  return left;
}

async function confirmFirmwareDeploy(){
  const st=$("fwStatus");
  if(!SELECTED_FIRMWARE){
    st.className="pstatus err"; st.textContent=t("settings.firmware.deploy_no_file");
    return;
  }
  const picked=selectedFirmwarePrinters();
  if(!picked.length){
    st.className="pstatus err"; st.textContent=t("settings.firmware.deploy_no_selection");
    return;
  }
  // Pre-flight the image before anything is committed. Only facts read out of
  // the file's own bytes are fatal (see connectors/firmwareImage.js); a
  // filename/model mismatch is shown as something to CHECK, because a filename
  // is not evidence about the payload and this dialog must not imply that
  // SnapCon has proven model compatibility.
  const ins=await inspectSelectedFirmware();
  renderFirmwareImageCard();
  if(ins&&ins.hardFail&&ins.hardFail.length){
    st.className="pstatus err";
    st.textContent=t("settings.firmware.inspect_failed",{error:ins.hardFail.join("; ")});
    return;
  }
  const names=picked.map(i=>{ const p=firmwareFleetOf(i); return p?p.name:("#"+i); });
  const warns=(ins&&ins.warnings)||[];
  // Choices made further up the page that change what this button does, stated
  // here rather than left to be inferred from a switch set ten minutes ago.
  const verifyOff=!firmwareVerifyEnabled();
  const skipDead=firmwareSkipCurrentEnabled()&&!(ins&&ins.version);
  // Hold-to-confirm, the same control E-Stop and Cancel use — this is more
  // destructive than either, so it does not get a lesser gate. The dialog names
  // the file, the version and every printer rather than asking "are you sure".
  openHoldConfirmDialog({
    mode:"hold",
    iconSrc:"/estop-icon.svg",
    title:tn("settings.firmware.confirm_title",picked.length,{n:picked.length}),
    subtitle:SELECTED_FIRMWARE.path,
    panelHtml:`<div class="hc-panel-file" title="${esc(SELECTED_FIRMWARE.path)}">${esc(SELECTED_FIRMWARE.name)}</div>`+
      `<div class="hc-panel-times">${esc(ins&&ins.version
        ?t("settings.firmware.confirm_version",{version:ins.version})
        :t("settings.firmware.confirm_version_unknown"))}</div>`+
      `<div class="hc-panel-times">${esc(names.join(", "))}</div>`,
    consequencesHtml:`<ul class="hc-consequences-list">`+
      `<li>${esc(t("settings.firmware.confirm_consequence_offline"))}</li>`+
      `<li>${esc(t("settings.firmware.confirm_consequence_power"))}</li>`+
      `<li>${esc(t("settings.firmware.confirm_consequence_one"))}</li>`+
      (verifyOff?`<li>${esc(t("settings.firmware.confirm_no_verify"))}</li>`:"")+
      (skipDead?`<li>${esc(t("settings.firmware.confirm_skip_no_version"))}</li>`:"")+
      warns.map(w=>`<li>${esc(t("settings.firmware.inspect_warning",{warning:w}))}</li>`).join("")+
      `</ul>`,
    idleLabel:tn("settings.firmware.confirm_hold_n",picked.length,{n:picked.length}),
    countdownLabel:n=>t("settings.firmware.confirm_hold_countdown",{n}),
    helperIdle:t("settings.firmware.confirm_helper_idle"),
    helperHolding:t("settings.firmware.confirm_helper_holding"),
    sendingLabel:t("settings.firmware.confirm_sending"),
    doneLabel:t("settings.firmware.confirm_started"),
    onConfirm:async()=>{ await startFirmwareDeploy(picked); }
  });
}

// What to tell the operator once the server has answered.
//
// The old code said "Firmware update started" unconditionally. With five
// printers selected and two printing, that sentence was simply false about two
// of them — and since a rejected printer also got no status row, they vanished
// entirely. The three outcomes are counted separately and the tone follows the
// worst of them, so a partial batch cannot read as a clean success.
function firmwareDeploySummary(d){
  const acc=(d&&d.accepted||[]).length;
  const rej=(d&&d.rejected||[]).length;
  const skip=(d&&d.skipped||[]).length;
  const parts=[];
  if(acc)  parts.push(t("settings.firmware.summary_started",{n:acc}));
  if(skip) parts.push(t("settings.firmware.summary_skipped",{n:skip}));
  if(rej)  parts.push(t("settings.firmware.summary_rejected",{n:rej}));
  // Nothing accepted at all is not a success in any reading of the word, even
  // when every printer was merely "already up to date" — the operator asked for
  // something and none of it is running.
  const tone = rej ? (acc ? "warn" : "err") : (acc || skip ? "ok" : "err");
  return { tone, text: parts.length?parts.join(" · "):t("settings.firmware.summary_nothing") };
}

async function startFirmwareDeploy(printers){
  const st=$("fwStatus");
  // Sent as STABLE ids, not the row indexes. A Settings save can reorder the
  // fleet between this list being drawn and Deploy being pressed, and the
  // server resolves whatever it is given — so handing it an index would let a
  // reorder retarget the flash. Falls back to the index only for a row with no
  // id, which the server still accepts (see firmwareTargetFor).
  const refs=printers.map(i=>{ const row=FW_DATA.find(r=>r.id===i); return row&&row.pid?row.pid:i; });
  const r=await postJSON("/api/firmware-deploy",{
    printers:refs, path:SELECTED_FIRMWARE.path,
    skipCurrent: firmwareSkipCurrentEnabled(),
    verify: firmwareVerifyEnabled() });
  const d=await r.json();
  if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
  (d.rejected||[]).forEach(x=>{ FW_REFRESHED.delete(x.printer); });
  (d.accepted||[]).forEach(x=>{
    FW_REFRESHED.delete(x.printer);   // this printer is about to change again
    FW_REFRESH_TRIES.delete(x.printer);
  });
  const sum=firmwareDeploySummary(d);
  st.className="pstatus "+sum.tone; st.textContent=sum.text;
  // Nothing is selected any more: the work is the server's now, and leaving the
  // boxes ticked invites a second identical deploy. Rejected printers keep their
  // own status row, so clearing the selection does not hide them.
  clearFirmwareSelection();
  pollFirmwareStatus();
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

// Polled rather than streamed, matching /api/print-status. The server holds the
// whole operation, so closing this tab (or the browser) does not stop a deploy —
// this only decides how often the page asks what happened.
let FW_STATUS_POLL=null, FW_POLL_MS=0;
function scheduleFirmwareStatusPoll(ms){
  if(FW_POLL_MS===ms) return;
  clearInterval(FW_STATUS_POLL);
  FW_POLL_MS=ms;
  FW_STATUS_POLL = ms ? setInterval(pollFirmwareStatus,ms) : null;
}
async function pollFirmwareStatus(){
  let d;
  try{ d=await getJSON("/api/firmware-status"); }
  catch{ return; }              // a transient poll failure is not a deploy failure
  if(!d||!d.printers) return;
  const wasActive=FW_LAST_STATUS?Object.keys(FW_LAST_STATUS.printers||{}).some(k=>
    !FW_SETTLED.includes(FW_LAST_STATUS.printers[k].phase)):false;
  FW_LAST_STATUS=d;
  renderFirmwareStatus(d);
  Object.keys(d.printers).forEach(k=>{
    if(d.printers[k].phase==="updated") refreshFirmwareRow(parseInt(k,10));
  });
  const phases=Object.keys(d.printers).map(k=>d.printers[k].phase);
  // 1 s while bytes are moving: the numbers must move continuously during a
  // multi-minute transfer or it reads as stalled. Once a printer is only
  // rebooting there is nothing to watch minute to minute, and once everything
  // has settled the poll stops entirely.
  const active=phases.some(p=>!FW_SETTLED.includes(p)&&p!=="rebooting");
  // A finished printer still owes a version re-read, and that read usually
  // fails the first time or two while the printer finishes booting.
  const owed=Object.keys(d.printers).some(k=>
    d.printers[k].phase==="updated"&&!FW_REFRESHED.has(parseInt(k,10)));
  scheduleFirmwareStatusPoll(active?1000:((phases.includes("rebooting")||owed)?4000:0));
  // A deploy that has just finished changes which group its printer belongs in.
  const nowActive=phases.some(p=>!FW_SETTLED.includes(p));
  if(wasActive&&!nowActive) renderFirmwareList();
}
function renderFirmwareStatus(d){
  const queue=(d&&d.queue)||[];
  Object.keys(d.printers||{}).forEach(k=>{
    const idx=parseInt(k,10);
    renderFirmwareRowStatus(idx,d.printers[k],queue.indexOf(idx)+1);
  });
  renderFirmwareFooter(d);
}
// A live language switch redraws off already-known state — no network call, no
// re-read of the printers.
function refreshFirmwareDynamicText(){
  if(!FW_DATA.length) return;
  renderFirmwareImageCard();
  syncFirmwareConnectorFilter();
  applyFirmwareSortUI();
  // Status slots are cached on their rendered HTML, so a language switch has to
  // invalidate that or the old language stays on screen until the phase changes.
  FW_ROWS.forEach(el=>{ const s=el.querySelector(".fwstat"); if(s) delete s.dataset.render; });
  renderFirmwareList();
}

function syncFirmwareConnectorFilter(){
  const sel=$("fwConnector");
  if(!sel) return;
  const prev=sel.value;
  // Only connectors actually present in the list — an option that can never
  // match anything is a dead end, not a filter.
  const present=[...new Set(FW_DATA.map(r=>r.connector).filter(Boolean))]
    .sort((a,b)=>connectorLabel(a).localeCompare(connectorLabel(b)));
  sel.innerHTML=`<option value="">${esc(t("settings.firmware.filter_all_connectors"))}</option>`+
    present.map(c=>`<option value="${esc(c)}">${esc(connectorLabel(c))}</option>`).join("");
  if(prev&&present.includes(prev)) sel.value=prev;
}

const FW_SORT_LABEL_KEYS={ default:"settings.firmware.sort_default", name:"settings.firmware.sort_name",
                           status:"settings.firmware.sort_status", version:"settings.firmware.sort_version" };
function applyFirmwareSortUI(){
  Object.keys(FW_SORT_LABEL_KEYS).forEach(k=>{
    const el=$("fwsc-"+k);
    if(el) el.textContent = FW_SORT===k ? "✓" : "";
  });
  // The control is an icon, so what it currently sorts by has to be readable
  // somewhere — a bare icon says nothing about the order on screen.
  const btn=$("fwSortBtn");
  if(btn) btn.title=t("settings.firmware.sort_title_current",{what:t(FW_SORT_LABEL_KEYS[FW_SORT])});
}

// ---------------------------------------------------------------------------
// Reading the fleet's versions
// ---------------------------------------------------------------------------

// A row's cells are drawn from FW_DATA, so a row redrawn after a deploy shows
// exactly what a freshly drawn one would.
function firmwareSkipReasonText(r){
  if(!r.online){
    if(r.reasonCode==="offline") return r.detail?t("settings.firmware.status_offline_detail",{detail:r.detail}):t("printer_status.offline");
    return r.reason||t("printer_status.offline");
  }
  if(r.reasonCode==="not_supported") return t("settings.firmware.status_skipped_not_supported");
  if(r.reasonCode==="busy") return t("settings.firmware.status_skipped_busy",{state:r.state||""});
  return r.reason||"";
}

// Printers whose version text has been re-read after their deploy (or whose
// re-read has been given up on), so a settled row is not re-fetched forever.
const FW_REFRESHED=new Set();
const FW_REFRESH_TRIES=new Map();
// ~2 minutes at the 4s settled cadence. A U1 answers its first probe well
// before Moonraker can serve /printer/info, so the first attempt almost always
// fails — that is expected, not an error, and it is why this retries at all
// rather than reading once and giving up.
const FW_REFRESH_MAX_TRIES=30;
const FW_REFRESH_INFLIGHT=new Set();

// After a deploy lands, the row still shows the version the printer reported
// BEFORE it was flashed — the one number someone looks at to confirm the update
// took. Re-read just that printer. Deliberately not loadFirmware(): that
// re-probes the whole fleet and rebuilds every row.
async function refreshFirmwareRow(idx){
  if(FW_REFRESHED.has(idx)||FW_REFRESH_INFLIGHT.has(idx)) return;
  if(!FW_ROWS.has(idx)) return;
  FW_REFRESH_INFLIGHT.add(idx);
  let fresh;
  try{ fresh=await getJSON("/api/firmware?printer="+encodeURIComponent(idx)); }
  catch{ fresh=null; }
  FW_REFRESH_INFLIGHT.delete(idx);
  const tries=(FW_REFRESH_TRIES.get(idx)||0)+1;
  FW_REFRESH_TRIES.set(idx,tries);
  // A printer that has only just answered its first probe is still bringing
  // Moonraker up and cannot serve /printer/info yet, so an early failure here is
  // the normal case rather than a fault. Try again on the next poll — but not
  // forever.
  if(!fresh||fresh.error||fresh.skipped){
    if(tries>=FW_REFRESH_MAX_TRIES) FW_REFRESHED.add(idx);
    return;
  }
  FW_REFRESHED.add(idx);
  const i=FW_DATA.findIndex(r=>r.id===idx);
  if(i>=0) FW_DATA[i]=fresh;
  // Its version changed, so it may belong in a different group now.
  renderFirmwareList();
}

async function loadFirmware(){
  const st=$("fwStatus"), btn=$("fwGet");
  if(btn) btn.disabled=true;
  st.className="pstatus work"; st.textContent=t("settings.firmware.reading");
  try{
    const rows=await getJSON("/api/firmware");
    FW_DATA=rows;
    FW_LOADED=true;
    FW_REFRESHED.clear();
    FW_REFRESH_TRIES.clear();
    // A printer that has gone away must not stay selected or leave a row behind.
    const live=new Set(rows.map(r=>r.id));
    [...FW_SEL].forEach(i=>{ if(!live.has(i)) FW_SEL.delete(i); });
    [...FW_ROWS.keys()].forEach(i=>{ if(!live.has(i)) FW_ROWS.delete(i); });
    syncFirmwareConnectorFilter();
    applyFirmwareSortUI();
    renderFirmwareList();
    const read=rows.filter(r=>!r.skipped).length;
    st.className="pstatus ok"; st.textContent=tn("settings.firmware.read_summary",rows.length,{read,total:rows.length});
    // Re-attach any deploy the server is still running to the fresh rows.
    pollFirmwareStatus();
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ if(btn) btn.disabled=false; }
}

// Re-run on every fleet poll: a printer that finishes its print becomes
// selectable without pressing Refresh again — and one that STARTS a print stops
// being selectable, which is the direction that matters.
function refreshFirmwareRowEligibility(){
  if(!FW_ROWS.size) return;
  FW_DATA.forEach(r=>{ const el=FW_ROWS.get(r.id); if(el) updateFirmwareRowCells(el,r); });
  renderFirmwareGroupHeads();
  syncFirmwareDeployButton();
}

// ---- Generic per-tab dirty tracking for Settings ----
// A tab opts in by calling registerSettingsTab() with a getValues()/
// setValues(v) pair. Dirtiness is always a diff against a snapshot taken at
// load/save time — never a keystroke counter — so undoing an edit clears it
// again. Only registered tabs get a sticky dirty footer and a switch-away
// prompt; tabs that haven't been reworked yet keep the plain always-visible
// Save button. Save itself still submits the one shared /api/config payload
// (see saveConfig) — this only scopes the UI's *awareness* of what changed
// to the tab the user is actually looking at.
const SETTINGS_TAB_TRACKERS={}, SETTINGS_TAB_SNAPSHOTS={};
function registerSettingsTab(name,getValues,setValues){
  SETTINGS_TAB_TRACKERS[name]={getValues,setValues};
}
function baselineSettingsTab(name){
  const t=SETTINGS_TAB_TRACKERS[name];
  if(!t) return;
  SETTINGS_TAB_SNAPSHOTS[name]=t.getValues();
  updateSettingsDirtyBar(name);
}
function baselineAllSettingsTabs(){ Object.keys(SETTINGS_TAB_TRACKERS).forEach(baselineSettingsTab); }
function settingsTabChanges(name){
  const t=SETTINGS_TAB_TRACKERS[name], base=SETTINGS_TAB_SNAPSHOTS[name];
  if(!t||!base) return 0;
  const now=t.getValues();
  return Object.keys(now).filter(k=>JSON.stringify(now[k])!==JSON.stringify(base[k])).length;
}
function updateSettingsDirtyBar(name){
  const bar=document.querySelector(`#tab-${name} .settings-dirty-bar`);
  if(!bar) return;
  const n=settingsTabChanges(name);
  bar.style.display=n?"flex":"none";
  if(n) bar.querySelector(".dirty-text").textContent=tn("settings.dirty_bar.unsaved_change",n);
}
function discardSettingsTab(name){
  const t=SETTINGS_TAB_TRACKERS[name], base=SETTINGS_TAB_SNAPSHOTS[name];
  if(!t||!base) return;
  t.setValues(base);
  updateSettingsDirtyBar(name);
}

function showSetTab(name){
  const current=document.querySelector(".set-tab.active")?.dataset.tab;
  if(current && current!==name && SETTINGS_TAB_TRACKERS[current] && settingsTabChanges(current)>0){
    if(!confirm(t("settings.dirty_bar.discard_confirm"))) return;
    discardSettingsTab(current);
  }
  document.querySelectorAll(".set-tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===name));
  document.querySelectorAll(".set-panel").forEach(p=>{ p.style.display = p.id==="tab-"+name ? "" : "none"; });
  // A registered tab (currently just General) shows its own sticky dirty
  // footer instead of the shared always-visible Save row. Remote Access and
  // Logs have no batched form to save — enabling/disabling/restarting and
  // viewing logs are both immediate actions — so neither shows a Save row.
  // Firmware is in this list because nothing on it is a saved setting: the
  // two toggles persist on change, and everything else is an action.
  if($("globalSaveRow")) $("globalSaveRow").style.display=(SETTINGS_TAB_TRACKERS[name]||name==="remote"||name==="logs"||name==="queue"||name==="firmware")?"none":"";
  // Remote Access has its own live status poller — only run it while its tab
  // is actually visible, same reasoning as the fleet poller not running
  // forever in the background for no reason.
  if(name==="remote"){ loadRemoteAccessStatus(); if(!RA_POLL_TIMER) RA_POLL_TIMER=setInterval(loadRemoteAccessStatus, 4000); }
  else if(RA_POLL_TIMER){ clearInterval(RA_POLL_TIMER); RA_POLL_TIMER=null; }
  if(name==="logs") loadAuditLogUI(true);
  // The Firmware tab has its own status poller. Entering the tab picks up a
  // deploy already running on the server (it does not belong to this page);
  // leaving stops asking. syncFirmwareDeployButton() runs regardless so the
  // button's disabled-reason title is translated before it can be hovered.
  if(name==="firmware"){
    renderFirmwareImageCard();
    syncFirmwareDeployButton();
    // The list used to stay empty until someone pressed a button, which read
    // as a broken tab. Read once per session and leave refreshing to the
    // button after that — it probes every printer, so it is not free.
    if(!FW_LOADED) loadFirmware(); else renderFirmwareList();
    pollFirmwareStatus();
  }
  else scheduleFirmwareStatusPoll(0);
}

// ---- Remote Access (Cloudflare Tunnel, managed) — Development Preview ----
// Same in-flight-guard pattern as loadFleet() — a slow/offline probe
// shouldn't let polls stack up on top of each other.
// Cached so a live locale switch can re-render the connection chain/account
// list/switch-desc off the LAST KNOWN status without an extra network round
// trip (see refreshDynamicI18nText() — locale switching must never trigger
// a backend request). Only ever set from a real status response; never used
// to fabricate state.
let RA_LAST_STATUS=null, RA_LAST_USERS=null;
async function loadRemoteAccessStatus(){
  if(RA_INFLIGHT) return;
  RA_INFLIGHT=true;
  try{
    const [s, users]=await Promise.all([getJSON("/api/remote-access/status"), getJSON("/api/users")]);
    // getJSON()'s checkAuthFailure() pops the login overlay on a 401 but
    // doesn't stop the (still-JSON) error body — e.g. {"error":"Login
    // required"} — from reaching here. Without this check, that object has
    // no .state field, and renderRemoteAccess() would render the literal
    // string "undefined" underneath the overlay.
    if(!s || typeof s.state!=="string") throw new Error((s&&s.error)||"Unexpected response");
    RA_LAST_STATUS=s; RA_LAST_USERS=Array.isArray(users)?users:[];
    renderRemoteAccess(s, RA_LAST_USERS);
  }catch(e){
    $("raStatus").className="pstatus err"; $("raStatus").textContent=e.message;
  }finally{ RA_INFLIGHT=false; }
}
// Pure re-render off the cached last status — no network call, no side
// effect on the tunnel/process itself. Safe to call from a live locale
// switch; a no-op until the first real status poll has landed.
function refreshRemoteAccessDynamicText(){
  if(RA_LAST_STATUS) renderRemoteAccess(RA_LAST_STATUS, RA_LAST_USERS||[]);
}

// The chain is built entirely from real signals already on the status
// object — no step is ever marked "failed" without an actual error behind
// it. Once a step fails, every step after it is "blocked" (not "failed"):
// there's no point calling the edge connection broken when the tunnel
// process backing it never started.
function raChainRows(s){
  const rows=[];
  if(s.localServiceReachable) rows.push({status:"healthy", name:t("settings.remote_access.chain_local_service"), detail:t("settings.remote_access.detail_reachable")});
  else if(s.state==="error" && !s.processRunning) rows.push({status:"failed", name:t("settings.remote_access.chain_local_service"), detail:s.lastError||t("settings.remote_access.detail_not_reachable")});
  else rows.push({status:"pending", name:t("settings.remote_access.chain_local_service"), detail:t("settings.remote_access.detail_checking")});

  let blocked=rows[0].status==="failed";
  if(blocked) rows.push({status:"blocked", name:t("settings.remote_access.chain_tunnel_process"), detail:t("settings.remote_access.detail_blocked")});
  else if(s.processRunning) rows.push({status:"healthy", name:t("settings.remote_access.chain_tunnel_process"), detail:s.pid?t("settings.remote_access.detail_pid",{pid:s.pid}):t("settings.remote_access.detail_running")});
  else if(s.state==="error") rows.push({status:"failed", name:t("settings.remote_access.chain_tunnel_process"), detail:s.lastError||t("settings.remote_access.detail_process_exited")});
  else rows.push({status:"pending", name:t("settings.remote_access.chain_tunnel_process"), detail:s.state==="provisioning"?t("settings.remote_access.detail_provisioning"):s.state==="downloading"?t("settings.remote_access.detail_downloading"):t("settings.remote_access.detail_starting")});

  blocked=blocked||rows[1].status==="failed";
  if(blocked) rows.push({status:"blocked", name:t("settings.remote_access.chain_cloudflare_edge"), detail:t("settings.remote_access.detail_blocked")});
  else if(s.logConnectionSeen) rows.push({status:"healthy", name:t("settings.remote_access.chain_cloudflare_edge"), detail:t("settings.remote_access.detail_connected")});
  else rows.push({status:"pending", name:t("settings.remote_access.chain_cloudflare_edge"), detail:t("settings.remote_access.detail_connecting")});

  if(blocked) rows.push({status:"blocked", name:t("settings.remote_access.public_address_label"), detail:t("settings.remote_access.detail_blocked")});
  else if(s.publicEndpointHealthy) rows.push({status:"healthy", name:t("settings.remote_access.public_address_label"), detail:t("settings.remote_access.detail_reachable")});
  else rows.push({status:"pending", name:t("settings.remote_access.public_address_label"), detail:t("settings.remote_access.detail_waiting")});

  return rows;
}
function renderRaChain(s){
  const icon={healthy:"✓", failed:"✕", blocked:"–", pending:'<span class="ra-spinner"></span>'};
  $("raChain").innerHTML=raChainRows(s).map(r=>
    `<div class="ra-chain-row ra-chain-${r.status}">`+
      `<span class="ra-chain-icon">${icon[r.status]}</span>`+
      `<span class="ra-chain-name">${esc(r.name)}</span>`+
      `<span class="ra-chain-detail">${esc(r.detail)}</span>`+
    `</div>`
  ).join("");
}
function renderRaAccounts(users){
  if(!users.length){ $("raAccountList").innerHTML=`<div class="settings-help">${t("settings.remote_access.no_accounts_yet")}</div>`; return; }
  $("raAccountList").innerHTML=users.map(u=>{
    const name=(u.firstName||u.lastName) ? esc((u.firstName+" "+u.lastName).trim()) : esc(u.loginName);
    return `<div class="ra-account-row">`+
      `<span class="ra-account-name">${name}</span>`+
      `<span class="ra-account-role">${esc(roleLabel(u.role))}</span>`+
      `<span class="ra-account-otp ${u.otpEnabled?"ok":"warn"}">${u.otpEnabled?t("settings.remote_access.otp_on"):t("settings.remote_access.password_only")}</span>`+
    `</div>`;
  }).join("");
}

// Gate condition mirrors the server's validateRemoteAccessSecurity(): user
// access management on AND at least one admin account. Building the UI
// around the same check the server enforces means Remote Access never
// looks "ready" here only to be rejected by /api/remote-access/enable.
function renderRemoteAccess(s, users){
  $("raInsecureWarning").style.display = s.usingInsecureFallback ? "" : "none";

  const gateOk = USERS_ENABLED && users.some(u=>u.role==="admin");
  const on = s.state!=="disabled";
  const sw=$("raEnabled");
  sw.disabled=!gateOk;
  $("raSwitchRow").classList.toggle("disabled", !gateOk);
  if(document.activeElement!==sw) sw.checked=on;
  $("raSwitchDesc").textContent = gateOk
    ? t("settings.remote_access.enable_desc")
    : t("settings.remote_access.enable_desc_gated");

  $("raGateSection").style.display = gateOk ? "none" : "";
  $("raOffSection").style.display = (gateOk && !on) ? "" : "none";
  $("raOnSection").style.display = (gateOk && on) ? "" : "none";
  $("raAccountsSection").style.display = (gateOk && on) ? "" : "none";

  if(gateOk && !on){
    // toLocaleString() renders in the browser's own locale, independent of
    // SnapCon's app-level i18n language — out of scope per the master
    // spec's date/number-localization exclusion; only the surrounding
    // "Last connected:"/"never" prose is translated here.
    $("raLastConnLine").textContent = t("settings.remote_access.last_connected",{when: s.lastConnectedAt ? new Date(s.lastConnectedAt).toLocaleString() : t("settings.remote_access.never")});
  }

  if(gateOk && on){
    const registering = s.state==="registering" && !!s.registerUrl;
    $("raRegisterBlock").style.display = registering ? "" : "none";
    $("raConnectedBlock").style.display = registering ? "none" : "";
    if(registering) $("raRegisterOpenBtn").href = s.registerUrl;

    $("raPublicUrl").textContent = s.publicUrl || "—";
    $("raOpenBtn").href = s.publicUrl || "#";
    $("raOpenBtn").classList.toggle("disabled", !s.publicUrl);
    $("raCopyBtn").disabled = !s.publicUrl;

    renderRaChain(s);
    renderRaAccounts(users);
  }

  $("raRestartBtn").disabled = !gateOk || !s.processRunning;
  $("raLogBtn").disabled = !gateOk || !s.processRunning;
  $("raRemoveBtn").disabled = !gateOk || !s.hostname;
}

// Maps /api/remote-access/enable and /restart's additive `code` field
// (added alongside their existing `error` string — see server.js and
// RemoteAccessService.js) to a translation key. Any code not in this table
// (or absent — e.g. a real Cloudflare/process/network failure) falls back
// to the raw `error` text, same as every other phase's precedent.
const RA_ERROR_KEYS={
  users_disabled:"settings.remote_access.error_users_disabled",
  no_admin:"settings.remote_access.error_no_admin",
  not_enabled:"settings.remote_access.error_not_enabled"
};
function raErrorText(d,fallback){
  return (d&&d.code&&RA_ERROR_KEYS[d.code])?t(RA_ERROR_KEYS[d.code]):fallback;
}
async function raSetEnabled(on){
  const st=$("raStatus"); st.className="pstatus work"; st.textContent=on?t("settings.remote_access.detail_starting"):t("settings.remote_access.stopping");
  $("raEnabled").disabled=true;
  try{
    const r=await postJSON("/api/remote-access/"+(on?"enable":"disable"),{});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(raErrorText(d,d.error||("HTTP "+r.status)));
    st.className="pstatus ok"; st.textContent="";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ loadRemoteAccessStatus(); }
}
async function removeRemoteAccess(){
  if(!confirm(t("settings.remote_access.remove_confirm"))) return;
  const st=$("raStatus"); st.className="pstatus work"; st.textContent=t("settings.remote_access.removing");
  $("raRemoveBtn").disabled=true;
  try{
    const r=await postJSON("/api/remote-access/remove",{});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(raErrorText(d,d.error||("HTTP "+r.status)));
    st.className="pstatus ok"; st.textContent="";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ loadRemoteAccessStatus(); }
}
async function restartRemoteAccessTunnel(){
  const st=$("raStatus"); st.className="pstatus work"; st.textContent=t("settings.remote_access.restarting");
  $("raRestartBtn").disabled=true;
  try{
    const r=await postJSON("/api/remote-access/restart",{});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(raErrorText(d,d.error||("HTTP "+r.status)));
    st.className="pstatus ok"; st.textContent="";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ loadRemoteAccessStatus(); }
}
async function viewRemoteAccessLog(){
  const box=$("raLogView");
  if(box.style.display!=="none"){ box.style.display="none"; return; }
  try{
    const d=await getJSON("/api/remote-access/log");
    box.textContent=(d.lines||[]).join("\n")||t("settings.remote_access.no_log_output");
  }catch(e){ box.textContent=t("settings.remote_access.log_load_failed",{message:e.message}); }
  box.style.display="block";
  box.scrollTop=box.scrollHeight;
}

// ---- General tab helpers ----
let FOLDER_CHECK_TIMER=null, FIRMWARE_FOLDER_CHECK_TIMER=null;
// Same debounce and endpoint as the G-code folder below, minus the file
// count: /api/check-folder counts SLICED files, which says nothing about a
// firmware folder. Reachable or not is the whole question here — and asking
// it in Settings is what stops the Firmware tab being where a bad path is
// first discovered.
function scheduleFirmwareFolderCheck(){
  clearTimeout(FIRMWARE_FOLDER_CHECK_TIMER);
  const el=$("firmwareFolderCheckStatus");
  if(!el) return;
  const p=$("setFirmwareFolder").value.trim();
  if(!p){ el.className="settings-help"; el.textContent=""; return; }
  el.className="settings-help"; el.textContent=t("settings.general.folder_checking");
  FIRMWARE_FOLDER_CHECK_TIMER=setTimeout(async()=>{
    try{
      const r=await getJSON("/api/check-folder?path="+encodeURIComponent(p));
      if(!r.ok){ el.className="settings-help err"; el.textContent=r.error||t("settings.general.folder_path_not_found"); return; }
      el.className="settings-help ok"; el.textContent=t("settings.files.firmware_folder_found");
    }catch{ el.className="settings-help err"; el.textContent=t("settings.general.folder_check_failed"); }
  },500);
}
// Debounced — fires 500ms after the user stops typing, not on every
// keystroke, since it's a real filesystem + file-count check server-side.
function scheduleFolderCheck(){
  clearTimeout(FOLDER_CHECK_TIMER);
  const el=$("folderCheckStatus");
  const p=$("setFolder").value.trim();
  if(!p){ el.className="settings-help"; el.textContent=""; return; }
  el.className="settings-help"; el.textContent=t("settings.general.folder_checking");
  FOLDER_CHECK_TIMER=setTimeout(async()=>{
    try{
      const r=await getJSON("/api/check-folder?path="+encodeURIComponent(p));
      if(!r.ok){ el.className="settings-help err"; el.textContent=r.error||t("settings.general.folder_path_not_found"); return; }
      if(r.count>0){ el.className="settings-help ok"; el.textContent=tn("settings.general.folder_reachable_files",r.count); }
      else { el.className="settings-help warn"; el.textContent=t("settings.general.folder_reachable_no_files"); }
    }catch{ el.className="settings-help err"; el.textContent=t("settings.general.folder_check_failed"); }
  },500);
}
function updateRefreshHelper(){
  const iv=parseInt($("setRefresh").value,10)||2;
  const n=PRINTERS_CFG.length;
  const perMin=Math.round((60/iv)*n);
  const el=$("refreshHelper");
  const tooFast=iv<2, tooBusy=perMin>300;
  if(!tooFast&&!tooBusy){
    el.className="settings-help";
    el.textContent=tn("settings.general.refresh_rate_summary",n,{perMin});
    return;
  }
  el.className="settings-help warn";
  // Smallest interval that brings the rate back to ≤300/min — 2s is the
  // floor regardless, since sub-2s is its own separate caution.
  const suggested=Math.max(2,Math.ceil((60*n)/300)||2);
  const suggestedRate=Math.round((60/suggested)*n);
  let msg=tn("settings.general.refresh_rate_summary",n,{perMin});
  if(tooFast) msg+=" "+t("settings.general.refresh_too_fast_suffix");
  msg+=" "+t("settings.general.refresh_suggested_suffix",{suggested,rate:suggestedRate});
  el.textContent=msg;
}
// The currency SYMBOL is still what's stored/used everywhere costs are
// shown (unchanged data model) — the select just replaces free-text entry
// with a fixed, labeled list of codes. This keeps every "$"-hardcoding
// label in sync with whatever's actually selected.
function updateCurrencyLabels(){
  const sym=$("setCurrency").value||"$";
  if($("filamentCostCurrency")) $("filamentCostCurrency").textContent=sym;
  if($("elecRateCurrency")) $("elecRateCurrency").textContent=sym;
  if($("maintCostCurrency")) $("maintCostCurrency").textContent=sym;
}
function syncAutoMatchNesting(){
  const on=$("setAllowMapping").checked;
  $("autoMatchNest").classList.toggle("disabled",!on);
  $("setSuggestMatching").disabled=!on;
}
function generalTabValues(){
  return {
    folder:$("setFolder").value.trim(), refresh:$("setRefresh").value, currency:$("setCurrency").value,
    filamentCost:$("setFilamentCost").value, electricityRate:$("setElectricityRate").value,
    allowMapping:$("setAllowMapping").checked, suggestMatching:$("setSuggestMatching").checked,
    logsFolder:$("setLogsFolder").value.trim(), cameraFolder:$("setCameraFolder").value.trim(),
    logsRetentionDays:$("setLogsRetentionDays").value, cameraRetentionDays:$("setCameraRetentionDays").value,
    gcodeSyncFolder:$("setGcodeSyncFolder").value.trim(), gcodeSyncRetentionDays:$("setGcodeSyncRetentionDays").value,
    firmwareFolder:$("setFirmwareFolder").value.trim()
  };
}
function setGeneralTabValues(v){
  $("setFolder").value=v.folder; scheduleFolderCheck();
  $("setFirmwareFolder").value=v.firmwareFolder||""; scheduleFirmwareFolderCheck();
  $("setRefresh").value=v.refresh; updateRefreshHelper();
  $("setCurrency").value=v.currency; updateCurrencyLabels();
  $("setFilamentCost").value=v.filamentCost;
  $("setElectricityRate").value=v.electricityRate;
  $("setAllowMapping").checked=v.allowMapping;
  $("setSuggestMatching").checked=v.suggestMatching;
  $("setLogsFolder").value=v.logsFolder||"";
  $("setCameraFolder").value=v.cameraFolder||"";
  $("setLogsRetentionDays").value=v.logsRetentionDays||"";
  $("setCameraRetentionDays").value=v.cameraRetentionDays||"";
  $("setGcodeSyncFolder").value=v.gcodeSyncFolder||"";
  $("setGcodeSyncRetentionDays").value=v.gcodeSyncRetentionDays||"";
  syncAutoMatchNesting();
}
registerSettingsTab("general",generalTabValues,setGeneralTabValues);

function notifTabValues(){
  return {
    enabled:$("ntfEnabled").checked,
    onStart:$("ntfEvStart").checked, onPause:$("ntfEvPause").checked,
    onError:$("ntfEvError").checked, onComplete:$("ntfEvComplete").checked,
    onIntervals:$("ntfMilestones").checked, milestones:[...NTF_MILESTONES].sort((a,b)=>a-b),
    includeImage:$("ntfImage").checked,
    ntfyEnabled:$("ntfyEnabled").checked, telegramEnabled:$("telegramEnabled").checked,
    ntfyTopic:$("ntfTopic").value.trim(), telegramChatId:$("ntfChatId").value.trim(),
    telegramToken:secretFieldValue($("ntfBotTokenField")),
    webhookEnabled:$("webhookEnabled").checked,
    webhookFormat:$("ntfWebhookFormat").value,
    webhookUrl:secretFieldValue($("ntfWebhookUrlField"))
  };
}
function setNotifTabValues(v){
  $("ntfEnabled").checked=v.enabled;
  $("ntfEvStart").checked=v.onStart; $("ntfEvPause").checked=v.onPause;
  $("ntfEvError").checked=v.onError; $("ntfEvComplete").checked=v.onComplete;
  $("ntfMilestones").checked=v.onIntervals;
  NTF_MILESTONES=new Set(v.milestones);
  renderMilestoneChips();
  $("ntfImage").checked=v.includeImage;
  $("ntfyEnabled").checked=v.ntfyEnabled; $("telegramEnabled").checked=v.telegramEnabled;
  $("ntfTopic").value=v.ntfyTopic; $("ntfChatId").value=v.telegramChatId;
  setSecretFieldState($("ntfBotTokenField"),NTF_HAS_TELEGRAM_TOKEN);
  $("webhookEnabled").checked=v.webhookEnabled;
  $("ntfWebhookFormat").value=v.webhookFormat||"discord";
  setSecretFieldState($("ntfWebhookUrlField"),NTF_HAS_WEBHOOK_URL);
  applyNtfEnabled();
  syncMilestoneNesting();
  syncProviderCard("ntfyEnabled","ntfyBody");
  syncProviderCard("telegramEnabled","telegramBody");
  syncProviderCard("webhookEnabled","webhookBody");
}
registerSettingsTab("notif",notifTabValues,setNotifTabValues);

// Surfaces a corrupt/unreadable config.json from the last startup (see
// CODE_AUDIT.md P0-1). CONFIG_LOAD_FAILED/CONFIG_LOAD_QUARANTINE_PATH are the
// single source of truth for "is a load failure still active in this
// session" — read by the first-run onboarding check (below) so it doesn't
// mistake a corrupt-config-caused empty fleet for a genuine first run, and
// by saveConfig()'s pre-save confirmation. Called both from loadConfigUI()
// (initial state) and from saveConfig()'s success path (POST /api/config's
// response already reflects the post-save reload server-side, so a
// successful save genuinely clears this, not just optimistically).
let CONFIG_LOAD_FAILED=false, CONFIG_LOAD_QUARANTINE_PATH=null;
function renderConfigLoadWarning(c){
  CONFIG_LOAD_FAILED=!!c.configLoadFailed;
  CONFIG_LOAD_QUARANTINE_PATH=c.configLoadQuarantinePath||null;
  const card=$("configLoadWarningCard");
  if(!card) return;
  if(!CONFIG_LOAD_FAILED){ card.style.display="none"; return; }
  card.style.display="";
  card.innerHTML=`<div class="settings-warning-title">${esc(t("global.config_load_warning.title"))}</div>`+
    `<div>${esc(t("global.config_load_warning.intro"))} `+
    (CONFIG_LOAD_QUARANTINE_PATH
      ? t("global.config_load_warning.quarantined",{path:CONFIG_LOAD_QUARANTINE_PATH},{html:true})
      : esc(t("global.config_load_warning.not_quarantined")))+
    ` ${esc(t("global.config_load_warning.footer"))}</div>`;
}
async function loadConfigUI(){
  await loadConnectorTypes();
  // Awaited before any printer row is built below — the Access checklist and
  // the Printer Pool dropdown in each row's Behavior section both read
  // GROUPS/PRINTER_POOLS synchronously at render time, so both must already
  // be populated (or a real failure, not a race) by then.
  await loadGroupsUI();
  await loadQueueManagementUI();
  try{
    const c=await getJSON("/api/config");
    renderConfigLoadWarning(c);
    SYSTEM_DEFAULT_LOCALE=c.locale||"en";
    $("setFolder").value=c.gcodeFolder||"";
    $("setFirmwareFolder").value=c.firmwareFolder||"";
    // Both default ON when absent, matching the server.
    if($("fwSkipCurrent")) $("fwSkipCurrent").checked=c.firmwareSkipCurrent!==false;
    if($("fwVerify")) $("fwVerify").checked=c.firmwareVerify!==false;
    scheduleFolderCheck();
    $("setLogsFolder").value=c.logsFolder||"";
    $("setCameraFolder").value=c.cameraFolder||"";
    $("setLogsRetentionDays").value=c.logsRetentionDays||"";
    $("setCameraRetentionDays").value=c.cameraRetentionDays||"";
    $("setGcodeSyncFolder").value=c.gcodeSyncFolder||"";
    $("setGcodeSyncRetentionDays").value=c.gcodeSyncRetentionDays||"";
    $("setRefresh").value=c.refreshInterval||2;
    CURRENCY=c.currency||"$";
    // The select is a fixed preset list — if a previously-saved currency
    // isn't one of them (e.g. set via the old free-text field), add it as a
    // one-off extra option rather than silently falling back to USD and
    // quietly changing what's on file the next time this saves.
    if(![...$("setCurrency").options].some(o=>o.value===CURRENCY)){
      $("setCurrency").add(new Option(CURRENCY,CURRENCY));
    }
    $("setCurrency").value=CURRENCY;
    updateCurrencyLabels();
    $("setFilamentCost").value=c.filamentCost||"";
    $("setElectricityRate").value=c.electricityRate||"";
    FILAMENT_COST=c.filamentCost||0; ELECTRICITY_RATE=c.electricityRate||0;
    $("setTNotation").checked=!!c.tNotation; USE_T_NOTATION=!!c.tNotation;
    $("setDefaultView").value=["regular","compact","camera","list","printfarm"].includes(c.defaultView)?c.defaultView:"regular";
    const siteName=(c.siteName||"").trim();
    $("setSiteName").value=siteName;
    if($("topbarSiteName")){ $("topbarSiteName").textContent=siteName; $("topbarSiteName").style.display=siteName?"":"none"; }
    $("setCameraRefresh").value=c.cameraViewRefreshInterval||6;
    CAM_STAGGER=c.cameraViewStagger!==false; $("setCameraStagger").checked=CAM_STAGGER;
    ALT_DISPLAY=["all","compact","camera","list","printfarm"].includes(c.alternateDisplay)?c.alternateDisplay:"all";
    $("setAltDisplay").value=ALT_DISPLAY;
    ALLOW_MAPPING=c.allowMapping!==false; $("setAllowMapping").checked=ALLOW_MAPPING;
    SUGGEST_MATCHING=c.suggestMatching!==false; $("setSuggestMatching").checked=SUGGEST_MATCHING;
    $("setUsersEnabled").checked=!!c.usersEnabled;
    $("bootstrapAdmin").style.display="none";
    if($("dockerRestartRow")) $("dockerRestartRow").style.display=c.isDocker?"flex":"none";
    $("setAuditRetention").value=c.auditRetentionDays||90;
    const rs=c.resend||{};
    $("setResendKey").value="";
    $("setResendKey").placeholder=rs.hasApiKey?t("settings.notif.resend_key_placeholder_saved"):"re_...";
    $("setResendFrom").value=rs.fromAddress||"";
    const otp=c.otp||{};
    if(otp.service==="ntfy") $("otpSvcNtfy").checked=true;
    else if(otp.service==="telegram") $("otpSvcTelegram").checked=true;
    else $("otpSvcResend").checked=true;
    $("otpNtfyTopic").value=otp.ntfyTopic||"";
    $("otpTelegramChatId").value=otp.telegramChatId||"";
    // The bot token itself lives under Notifications, not here — just warn
    // if OTP-via-Telegram is picked but no bot has been configured there yet.
    // Tracked in its own global (rather than reusing NTF_HAS_TELEGRAM_TOKEN,
    // set later in this same function for the Notifications section) so
    // refreshOtpTelegramBotHint() can re-render this hint's text on a later
    // live locale switch without an ordering dependency on that later block.
    OTP_TELEGRAM_BOT_CONFIGURED=!!otp.telegramBotConfigured;
    refreshOtpTelegramBotHint();
    applyOtpServiceUI();
    // QUEUE_MANAGEMENT_ENABLED is already known here — loadQueueManagementUI()
    // ran earlier in this same function — so launching straight into Print
    // Farm can be trusted; falls back to Regular if the feature's since been
    // turned off without the saved default being updated to match.
    if($("setDefaultView").value==="printfarm" && QUEUE_MANAGEMENT_ENABLED){ openQueueDashboard(); }
    else { VIEW_MODE=($("setDefaultView").value==="printfarm")?"regular":$("setDefaultView").value; applyViewMode(); }
    const nf=c.notifications||{};
    $("ntfEnabled").checked=!!nf.enabled;
    $("ntfEvStart").checked=!!nf.onStart;
    $("ntfEvPause").checked=!!nf.onPause;
    $("ntfEvError").checked=!!nf.onError;
    $("ntfEvComplete").checked=!!nf.onComplete;
    $("ntfMilestones").checked=!!nf.onIntervals;
    NTF_MILESTONES=new Set((Array.isArray(nf.milestonePercents)&&nf.milestonePercents.length)?nf.milestonePercents:[25,50,75]);
    renderMilestoneChips();
    $("ntfImage").checked=!!nf.includeImage;
    $("ntfyEnabled").checked=!!nf.ntfyEnabled;
    $("telegramEnabled").checked=!!nf.telegramEnabled;
    $("ntfTopic").value=nf.ntfyTopic||"";
    $("ntfChatId").value=nf.telegramChatId||"";
    // Bot token never round-trips (real secret) — shared masked-secret
    // control: a "Configured" badge when one's on file, a plain input
    // otherwise.
    NTF_HAS_TELEGRAM_TOKEN=!!nf.hasTelegramBotToken;
    NTF_HAS_WEBHOOK_URL=!!nf.hasWebhookUrl;
    setSecretFieldState($("ntfBotTokenField"), NTF_HAS_TELEGRAM_TOKEN);
    $("webhookEnabled").checked=!!nf.webhookEnabled;
    $("ntfWebhookFormat").value=nf.webhookFormat==="json"?"json":"discord";
    setSecretFieldState($("ntfWebhookUrlField"), NTF_HAS_WEBHOOK_URL);
    applyNtfEnabled();
    syncMilestoneNesting();
    syncProviderCard("ntfyEnabled","ntfyBody");
    syncProviderCard("telegramEnabled","telegramBody");
    syncProviderCard("webhookEnabled","webhookBody");
    baselineSettingsTab("notif");
    PRINTERS_CFG=c.printers||[];
    renderPrinterRowsFromConfig();
    updateRefreshHelper(); // depends on PRINTERS_CFG.length, so runs after the printer rows above
    syncAutoMatchNesting();
    baselineSettingsTab("general");
    // The onboarding "add your first printer" flow drops into the admin-only
    // Printers settings tab — never force that open for a non-Admin role,
    // who couldn't reach or complete it (Settings itself is hidden for them).
    // An empty printer list caused by a failed config load (CONFIG_LOAD_FAILED)
    // is NOT a genuine first run — it must not trigger onboarding, which would
    // hide the warning banner above (it lives on tab-general, and showSetTab
    // below hides every other .set-panel) and invite saving an empty printer
    // list over the still-recoverable original.
    if(!c.configured && !CONFIG_LOAD_FAILED && isAdmin()){ $("setup").classList.add("show"); showSetTab("printers"); $("gear").querySelector("img").src="/back.svg"; $("gear").title=t("common.back"); document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="none"); $("fleetSearch").style.display="none"; $("sortBtn").style.display="none"; $("compactBtn").style.display="none"; if($("filesBtn")) $("filesBtn").style.display="none"; $("setupmsg").textContent=t("settings.onboarding_welcome"); if(!$("setPrinters").children.length) addPrinterRow("",""); }
  }catch(e){}
}
// ---- Shared masked-secret control (printer API token, Telegram bot token) ----
// A secret's real value is never sent back from the server (see server.js's
// publicCfg) — only a hasValue boolean. So the UI shows either a "Configured"
// badge + Replace/Clear, or a plain empty input when nothing's on file.
// Reading a field's save value is a 3-state result: undefined ("don't touch
// what's on file"), "" (Clear was clicked — explicitly wipe it), or a
// non-empty string (replace with this) — the same convention server.js
// already uses for telegramBotToken/resend.apiKey, now shared by the token
// field too.
// placeholderKey is optional: when the caller's placeholder text came from
// t(), passing the same key here attaches data-i18n-placeholder so
// applyI18nToDom() re-translates it in place on a live locale switch — same
// reasoning as switchHtml()'s labelKey/descKey. Callers that don't pass it
// keep working exactly as before.
function secretFieldHtml(cls,hasValue,placeholder,placeholderKey){
  return `<div class="secret-field" data-cleared="0">`+
    `<input type="password" class="field secret-input ${cls}" style="${hasValue?"display:none":""}" placeholder="${esc(placeholder||"")}"${placeholderKey?` data-i18n-placeholder="${esc(placeholderKey)}"`:''} autocomplete="off">`+
    `<div class="secret-chip" style="${hasValue?"":"display:none"}">`+
      `<span class="status-badge" style="--status-color:var(--ok)" data-i18n="common.secret_configured">${t("common.secret_configured")}</span>`+
      `<button type="button" class="btn ghost secret-replace" data-i18n="common.secret_replace">${t("common.secret_replace")}</button>`+
      `<button type="button" class="btn ghost secret-clear" data-i18n="common.secret_clear">${t("common.secret_clear")}</button>`+
    `</div>`+
  `</div>`;
}
function wireSecretField(field){
  const input=field.querySelector(".secret-input"), chip=field.querySelector(".secret-chip");
  field.querySelector(".secret-replace")?.addEventListener("click",()=>{
    chip.style.display="none"; input.style.display=""; input.value=""; input.focus();
    field.dataset.cleared="0";
    markPrintersDirty(); // harmless no-op outside a printer row (e.g. the Telegram field)
  });
  field.querySelector(".secret-clear")?.addEventListener("click",()=>{
    chip.style.display="none"; input.style.display=""; input.value="";
    field.dataset.cleared="1";
    markPrintersDirty();
  });
}
function secretFieldValue(field){
  if(!field) return undefined;
  const v=field.querySelector(".secret-input").value.trim();
  if(v) return v;
  return field.dataset.cleared==="1" ? "" : undefined;
}

// ---- Switch: reusable boolean toggle ----
// Markup is a real <input type="checkbox" role="switch">, styled as a track
// + knob — not a div with a click handler — so form semantics, keyboard
// support (Space), and label association all come from the platform for
// free. The whole row is the <label>, so clicking the description text
// toggles it too. Because it's still a plain checkbox underneath, every
// existing `.checked` read/write call site keeps working unchanged — only
// the markup and CSS differ from a bare <input type=checkbox>.
// labelKey/descKey are optional: when the caller's label/description came
// from t(), passing the same keys here attaches data-i18n attributes so
// applyI18nToDom() can re-translate this row in place on a live locale
// switch — this markup is otherwise generated once per printer row (or
// other dynamic list) and never re-rendered on its own. Every other caller
// that doesn't pass them keeps working exactly as before.
function switchHtml(id,checked,label,description,disabled,labelKey,descKey){
  return `<label class="switch-row${disabled?' disabled':''}" for="${esc(id)}">`+
    `<input type="checkbox" role="switch" id="${esc(id)}" class="switch-input"${checked?' checked':''}${disabled?' disabled':''}>`+
    `<span class="switch-text"><span class="switch-label"${labelKey?` data-i18n="${esc(labelKey)}"`:''}>${esc(label)}</span>`+
    (description?`<span class="switch-desc"${descKey?` data-i18n="${esc(descKey)}"`:''}>${esc(description)}</span>`:'')+
    `</span>`+
  `</label>`;
}
// ---- Checkbox: reusable multi-select control ----
// Same shape as switchHtml above (real <input type="checkbox">, styled
// directly, whole row is the <label>) — a Switch means a setting that's on
// or off by itself; a Checkbox means this item is one of several being
// picked for an action. `attrs` is a raw extra-attributes string (e.g.
// `data-id="3"`) for call sites that need to identify which row this is on
// change. `indeterminate` isn't a param — there's no HTML attribute for it,
// only a DOM property — set `el.indeterminate = true` on the rendered
// element after insertion, same as any other imperative DOM write.
function checkboxHtml(id,checked,label,description,disabled,attrs){
  return `<label class="checkbox-row${disabled?' disabled':''}" for="${esc(id)}">`+
    `<input type="checkbox" id="${esc(id)}" class="checkbox-input"${checked?' checked':''}${disabled?' disabled':''}${attrs?' '+attrs:''}>`+
    `<span class="checkbox-text"><span class="checkbox-label">${esc(label)}</span>`+
    (description?`<span class="checkbox-desc">${esc(description)}</span>`:'')+
    `</span>`+
  `</label>`;
}
// ---- Number-input stepper: replaces the browser's native spinner app-wide ----
// A generic enhancement, not a per-field opt-in — enhanceNumberInputs() runs
// once at startup for whatever's already in the DOM, and a MutationObserver
// (wired in wireUI) catches every number input rendered afterward (printer
// rows, modals, anything), so no render call site needs to remember to
// invoke this itself.
function enhanceNumberInput(input){
  if(input.dataset.stepped) return;
  input.dataset.stepped="1";
  const wrap=document.createElement("span");
  wrap.className="number-field";
  // The input's own inline sizing (e.g. style="max-width:140px") described
  // its footprint as a bare field — move it to the new wrapper so attaching
  // two buttons doesn't change the control's overall width on the page.
  if(input.style.maxWidth){ wrap.style.maxWidth=input.style.maxWidth; input.style.maxWidth=""; }
  if(input.style.width){ wrap.style.width=input.style.width; input.style.width=""; }
  input.parentNode.insertBefore(wrap,input);
  const minus=document.createElement("button");
  minus.type="button"; minus.className="number-step minus"; minus.textContent="−"; minus.tabIndex=-1; minus.setAttribute("aria-label",t("common.decrease")); minus.setAttribute("data-i18n-aria-label","common.decrease");
  const plus=document.createElement("button");
  plus.type="button"; plus.className="number-step plus"; plus.textContent="+"; plus.tabIndex=-1; plus.setAttribute("aria-label",t("common.increase")); plus.setAttribute("data-i18n-aria-label","common.increase");
  wrap.appendChild(minus); wrap.appendChild(input); wrap.appendChild(plus);
  const fire=()=>{ input.dispatchEvent(new Event("input",{bubbles:true})); input.dispatchEvent(new Event("change",{bubbles:true})); };
  const step=dir=>{
    if(input.disabled) return;
    if(dir<0 && typeof input.stepDown==="function"){ try{ input.stepDown(); fire(); return; }catch{} }
    if(dir>0 && typeof input.stepUp==="function"){ try{ input.stepUp(); fire(); return; }catch{} }
    // stepDown/stepUp throw at the min/max boundary on some browsers instead
    // of clamping — fall back to plain arithmetic rather than leave the
    // button looking like it did nothing.
    const st=parseFloat(input.step)||1, cur=parseFloat(input.value)||0;
    let next=cur+dir*st;
    if(input.min!=="") next=Math.max(next,parseFloat(input.min));
    if(input.max!=="") next=Math.min(next,parseFloat(input.max));
    input.value=next; fire();
  };
  minus.addEventListener("click",()=>step(-1));
  plus.addEventListener("click",()=>step(1));
}
function enhanceNumberInputs(root){
  (root||document).querySelectorAll('input[type="number"]:not([data-stepped])').forEach(enhanceNumberInput);
}

// Resets a secret field to reflect freshly-loaded config — used for the
// Telegram bot token (a static field, unlike the printer token which is
// built fresh per row via secretFieldHtml already carrying the right state).
function setSecretFieldState(field,hasValue){
  if(!field) return;
  const input=field.querySelector(".secret-input"), chip=field.querySelector(".secret-chip");
  input.value=""; field.dataset.cleared="0";
  input.style.display=hasValue?"none":"";
  chip.style.display=hasValue?"":"none";
}

// Settings > Printers collapsed-row status — cross-referenced from the
// already-polled FLEET by URL rather than array index, since a row that's
// been drag-reordered but not yet saved no longer sits at the same index
// the server's PRINTERS array (and therefore FLEET) uses.
function updateAllPrinterRowStatuses(){
  const box=$("setPrinters");
  if(!box||!box.children.length) return;
  box.querySelectorAll(".prow").forEach(row=>{
    const url=rowAddressUrl(row).replace(/\/+$/,"");
    const f=url && FLEET.find(p=>(p.url||"").replace(/\/+$/,"")===url);
    const dot=row.querySelector(".prow-status-dot"), stateEl=row.querySelector(".prow-conn-state");
    if(!f){
      dot.style.setProperty("--status-color","var(--ink-faint)"); dot.title=t("settings.printers.status_unknown");
      stateEl.textContent="—"; stateEl.classList.remove("danger");
      return;
    }
    if(!f.online){
      dot.style.setProperty("--status-color","var(--bad)"); dot.title=t("printer_status.offline");
      stateEl.textContent=t("settings.printers.status_no_response"); stateEl.classList.add("danger");
      return;
    }
    const st=statusColorText(f);
    dot.style.setProperty("--status-color",st.statusColor); dot.title=st.statusTxt;
    stateEl.textContent=st.statusTxt; stateEl.classList.remove("danger");
  });
}

// ---- Printers tab: sticky dirty footer ----
// PRINTER_SNAPSHOTS holds each row's serialized field values as of the last
// load/save — a row with no entry is one added since then (always dirty).
// PRINTER_ORIGINAL_ORDER is the row-element order as of that same baseline,
// used only to detect a pure reorder. PRINTER_REMOVED collects the names of
// rows that existed at baseline and were removed this session.
let PRINTER_SNAPSHOTS=new WeakMap(), PRINTER_ORIGINAL_ORDER=[], PRINTER_REMOVED=[];
function serializeRowForDiff(row){
  return JSON.stringify({
    name:row.querySelector(".pname").value.trim(),
    brand:row.querySelector(".pbrand").value.trim(),
    location:row.querySelector(".ploc").value.trim(),
    ip:row.querySelector(".pip").value.trim(),
    port:row.querySelector(".pport").value.trim(),
    connector:row.querySelector(".pconnector").value,
    token:secretFieldValue(row.querySelector(".secret-field")),
    serial:row.querySelector(".pserial").value.trim(),
    verificationCode:row.querySelector(".pvcode").value.trim(),
    purchaseDate:row.querySelector(".pdate").value,
    costKwh:row.querySelector(".pkwh").value.trim(),
    autoLevel:row.querySelector('[id^="pautolevel-"]').checked,
    flowCalibrate:row.querySelector('[id^="pflowcal-"]').checked,
    timelapse:row.querySelector('[id^="ptimelapse-"]').checked,
    pushNotify:row.querySelector('[id^="ppushnotify-"]').checked,
    forceDefaults:row.querySelector('[id^="pforcedefaults-"]').checked,
    filamentMode:row.querySelector(".pfilmode").value,
    transport:row.querySelector(".ptransport").value,
    tags:row.querySelector(".ptags").value.trim(),
    allowedGroups:[...row.querySelectorAll(".pgroups-chk:checked")].map(c=>c.value).sort().join(",")
  });
}
// Rebuilds every printer row's DOM from PRINTERS_CFG. Every static
// label/section-heading/switch-description in addPrinterRow()'s template is
// baked in via t() calls at creation time rather than data-i18n attributes
// (Category B, not A — see the audit note on init()'s call site below), so
// this must be re-run once i18n is actually ready, not just once per config
// load.
function renderPrinterRowsFromConfig(){
  $("setPrinters").innerHTML="";
  PRINTERS_CFG.forEach(p=>addPrinterRow(p.name,p.url,{id:p.id,ip:p.ip,port:p.port,scheme:p.scheme,location:p.location,costKwh:p.costKwh,purchaseDate:p.purchaseDate,autoLevel:p.autoLevel,flowCalibrate:p.flowCalibrate,timelapse:p.timelapse,pushNotify:p.pushNotify,forceDefaults:p.forceDefaults,connector:p.connector,brand:p.brand,filamentMode:p.filamentMode,transport:p.transport,serial:p.serial,verificationCode:p.verificationCode,hasToken:p.hasToken,tags:p.tags,allowedGroups:p.allowedGroups,printerPoolId:p.printerPoolId}));
  baselinePrintersDirty();
}
// Settings > Printers shows at most one expanded row: opening one collapses
// the rest, so a long fleet doesn't turn into a wall of open forms. Both
// helpers only ever COLLAPSE — neither opens anything — which is what keeps
// the Expand all button (it sets `open` on every row directly) working.
function closeOtherPrinterRows(except){
  document.querySelectorAll("#setPrinters .prow-details[open]").forEach(d=>{ if(d!==except) d.removeAttribute("open"); });
}
// Drops the row's ⋮ menu upward when opening it downward would run past the
// bottom of the Settings panel (.setup is a max-height scroll container) or
// the viewport, whichever is nearer. Only flips when the space above is
// genuinely bigger than the menu — a row with no room either way keeps the
// default downward direction and stays scroll-reachable.
function flipPrinterMenuIfClipped(menuBtn,menu){
  const panel=menuBtn.closest(".setup");
  const panelRect=panel?panel.getBoundingClientRect():null;
  const limitBottom=Math.min(window.innerHeight, panelRect?panelRect.bottom:Infinity);
  const limitTop=Math.max(0, panelRect?panelRect.top:0);
  const menuRect=menu.getBoundingClientRect();
  if(menuRect.bottom<=limitBottom) return;
  const spaceAbove=menuBtn.getBoundingClientRect().top-limitTop;
  if(spaceAbove>=menuRect.height+8) menu.classList.add("up");
}
// Collapse everything and put the Expand/Collapse all button back in sync —
// called after a successful save, where the rows' contents are now exactly
// what's on file and there's nothing left to look at.
function collapseAllPrinterRows(){
  closeOtherPrinterRows(null);
  const btn=$("collapseAll");
  if(btn){ btn.dataset.expanded="0"; syncCollapseAllButtonLabel(); }
}
// Called once right after printer rows are (re)built from a fresh load or a
// successful save — establishes the "clean" state everything else diffs
// against.
function baselinePrintersDirty(){
  const rows=[...$("setPrinters").querySelectorAll(".prow")];
  PRINTER_SNAPSHOTS=new WeakMap();
  rows.forEach(row=>PRINTER_SNAPSHOTS.set(row,serializeRowForDiff(row)));
  PRINTER_ORIGINAL_ORDER=rows;
  PRINTER_REMOVED=[];
  updatePrintersDirtyFooter();
}
function computePrintersDirty(){
  const rows=[...$("setPrinters").querySelectorAll(".prow")];
  const names=[];
  let changed=0;
  rows.forEach(row=>{
    const snap=PRINTER_SNAPSHOTS.get(row);
    if(snap===undefined||serializeRowForDiff(row)!==snap){
      names.push(row.querySelector(".pname").value.trim()||t("settings.printers.new_printer_default"));
      changed++;
    }
  });
  let total=changed+PRINTER_REMOVED.length;
  const orderChanged=PRINTER_ORIGINAL_ORDER.length===rows.length&&PRINTER_ORIGINAL_ORDER.some((r,i)=>r!==rows[i]);
  const allNames=[...names,...PRINTER_REMOVED];
  if(orderChanged){ if(!allNames.length) allNames.push(t("settings.printers.reorder_fallback_label")); total++; }
  return { total, names:[...new Set(allNames)] };
}
function updatePrintersDirtyFooter(){
  const bar=$("printersDirtyBar");
  if(!bar) return;
  const {total,names}=computePrintersDirty();
  if(!total){ bar.style.display="none"; return; }
  const shown=names.slice(0,2).join(", ")+(names.length>2?t("settings.printers.dirty_bar_more_suffix",{count:names.length-2}):"");
  bar.style.display="flex";
  bar.querySelector(".dirty-text").textContent=tn("settings.printers.dirty_bar_named",total,{shown});
}
function markPrintersDirty(){ updatePrintersDirtyFooter(); }

// Warn on tab close/reload/navigate-away if either dirty-tracking system
// (Settings' registered tabs, or the Printers tab's own row-level tracker)
// has anything unsaved — reuses the existing diff logic rather than a
// separate dirty flag, so this stays correct without its own upkeep.
window.addEventListener("beforeunload", e=>{
  const settingsDirty=Object.keys(SETTINGS_TAB_TRACKERS).some(name=>settingsTabChanges(name)>0);
  const printersDirty=computePrintersDirty().total>0;
  if(settingsDirty||printersDirty){ e.preventDefault(); e.returnValue=""; }
});

let PROW_UID=0;
// Maps /api/printer-pool's stable `code` field (added alongside its
// existing `error` string — see server.js) to a translation key. Any code
// not in this table (or absent entirely) falls back to the raw `error`
// text — same as any other still-unconverted backend route.
const PRINTER_POOL_ERROR_KEYS={
  unknown_printer:"settings.printers.pool_error_unknown_printer",
  queue_not_idle:"settings.printers.pool_error_queue_not_idle",
  queue_not_empty:"settings.printers.pool_error_queue_not_empty",
  unknown_pool:"settings.printers.pool_error_unknown_pool",
  monitor_only:"settings.printers.pool_error_monitor_only"
};
// ---- Printer address: IP / hostname + port ----
// The connector owns the rules — scheme, default port, whether the port is
// the user's to set, and whether the printer has a network address at all
// (getAddress() in connectors/index.js, delivered with /api/connectors).
// These mirror the server's connectors/address.js so a row can validate and
// compose the canonical URL without a round-trip; the server re-derives it
// from the same inputs on save either way.
const DEFAULT_CONNECTOR_ADDRESS={scheme:"http",defaultPort:null,portEditable:true,required:true};
function connectorAddress(type){
  const c=CONNECTOR_TYPES.find(c=>c.type===type)||{};
  return {...DEFAULT_CONNECTOR_ADDRESS,...(c.address||{})};
}
const ADDR_HOST_RE=/^([A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])$/;
function isValidHostValue(v){ return ADDR_HOST_RE.test(String(v||"").trim()); }
// Splits a URL into scheme/host/port, or null for anything that wouldn't
// survive being recomposed (a path, a query, credentials).
function parseAddress(url){
  const raw=String(url||"").trim().replace(/\/+$/,"");
  if(!raw) return null;
  let u=null; try{ u=new URL(raw); }catch{ u=null; }
  if(u&&u.hostname){
    if((u.pathname&&u.pathname!=="/")||u.search||u.hash||u.username||u.password) return null;
    return {scheme:u.protocol.replace(/:$/,""),host:u.hostname,port:u.port||""};
  }
  const m=/^([A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(raw);
  return m?{scheme:"",host:m[1],port:m[3]||""}:null;
}
// A row's canonical URL, composed exactly the way the server composes it on
// save. Everything that used to read the old single URL field goes through
// this: the collapsed-row status lookup, Test connection, the pre-save probe
// and the post-save id backfill.
function rowAddressUrl(row){
  const spec=connectorAddress(row.querySelector(".pconnector").value);
  if(!spec.required) return row.dataset.url||"";
  const ip=(row.querySelector(".pip").value||"").trim();
  if(!isValidHostValue(ip)) return "";
  const port=(row.querySelector(".pport").value||"").trim();
  return (row.dataset.scheme||spec.scheme||"http")+"://"+ip+(port?":"+port:"");
}
function addPrinterRow(name,url,opts,autoOpen){
  opts=opts||{};
  const uid=++PROW_UID;
  // The address arrives either already split (a saved printer, since the
  // startup migration and buildPrinterRecord both store ip/port) or as a
  // plain url (discovery, a duplicated row). A url this can't split lands
  // in the IP field verbatim rather than vanishing — the value stays
  // visible, and save-time validation asks for it to be fixed.
  const addrParsed=parseAddress(url);
  const addrIp=String(opts.ip||(addrParsed?addrParsed.host:(url||""))||"");
  const addrPort=String(opts.port||(addrParsed&&addrParsed.port)||"");
  const displayIp=addrIp+(addrPort?":"+addrPort:"");
  const row=document.createElement("div"); row.className="prow";
  // Round-tripped so the server can match "this is the same printer" by a
  // stable id even if name/URL are edited — not just by URL, which broke the
  // moment someone re-IP'd a printer (maintenance history would silently
  // detach). Blank for a brand-new row; the server mints one on first save.
  row.dataset.printerId=opts.id||"";
  // The address a row persists under when it has no address fields of its
  // own — the Simulator's synthetic sim:// url.
  row.dataset.url=url||"";
  // Only a scheme that differs from the connector's own is worth carrying;
  // an https printer must still be https after a save.
  row.dataset.scheme=(opts.scheme||(addrParsed&&["http","https"].includes(addrParsed.scheme)?addrParsed.scheme:""))||"";
  // Last-resort literal only matters if /api/connectors failed entirely —
  // it mirrors DEFAULT_TYPE in connectors/index.js.
  const connType=opts.connector||(CONNECTOR_TYPES[0]&&CONNECTOR_TYPES[0].type)||"snapmaker-u1-klipper-ws";
  const connTypeInfo=CONNECTOR_TYPES.find(c=>c.type===connType)||{};
  const modelLabel=connTypeInfo.label||connType;
  // Brand is derived from the connector for every connector EXCEPT generic
  // Klipper (Moonraker), which is a protocol many different vendors speak —
  // "Klipper" is the connector's name, not the machine's maker. Only that
  // one connector accepts a typed brand; the server enforces the same rule
  // (see buildPrinterRecord) rather than trusting this field.
  const derivedBrand=connTypeInfo.brand||modelLabel;
  const brandLabel=(connType===BRAND_EDITABLE_CONNECTOR&&(opts.brand||"").trim())||derivedBrand;
  row.innerHTML=
    `<details class="prow-details"${autoOpen?" open":""}>`+
    `<summary>`+
    `<span class="prow-drag-handle" draggable="true" title="${esc(t("settings.printers.drag_handle_title"))}" data-i18n-title="settings.printers.drag_handle_title">⠿</span>`+
    `<span class="prow-chevron">▶</span>`+
    `<span class="prow-status-dot" style="--status-color:var(--ink-faint)" title="${esc(t("settings.printers.status_unknown"))}"></span>`+
    `<div class="prow-suminfo"><span class="prow-sumname">${esc(name||t("settings.printers.new_printer_default"))}</span><span class="prow-sumip">${esc(displayIp||"—")}</span></div>`+
    `<span class="prow-model-badge">${esc(modelLabel)}</span>`+
    `<span class="prow-conn-state">—</span>`+
    `<div class="prow-sumbtns"><div class="prow-menu-wrap">`+
    `<button type="button" class="prow-menu-btn" title="${esc(t("settings.printers.menu_more_actions"))}" data-i18n-title="settings.printers.menu_more_actions">⋮</button>`+
    `<div class="prow-menu">`+
    `<button type="button" class="prow-menu-item" data-act="maint" data-i18n="settings.printers.menu_maintenance">${t("settings.printers.menu_maintenance")}</button>`+
    `<button type="button" class="prow-menu-item" data-act="duplicate" data-i18n="settings.printers.menu_duplicate">${t("settings.printers.menu_duplicate")}</button>`+
    `<button type="button" class="prow-menu-item" data-act="up" data-i18n="settings.printers.menu_move_up">${t("settings.printers.menu_move_up")}</button>`+
    `<button type="button" class="prow-menu-item" data-act="down" data-i18n="settings.printers.menu_move_down">${t("settings.printers.menu_move_down")}</button>`+
    `<button type="button" class="prow-menu-item danger" data-act="remove" data-i18n="settings.printers.menu_remove">${t("settings.printers.menu_remove")}</button>`+
    `</div></div></div>`+
    `</summary>`+
    `<div class="prow-body">`+

    `<div class="prow-section"><div class="prow-section-title" data-i18n="settings.printers.section_identity">${t("settings.printers.section_identity")}</div>`+
    `<div class="maint-row2">`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_name">${t("settings.printers.field_name")}</label><input class="field pname" maxlength="25" placeholder="U1" value="${esc(name||"")}"></div>`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_location">${t("settings.printers.field_location")}</label><input class="field ploc" maxlength="30" placeholder="e.g. Office" value="${esc(opts.location||"")}"></div>`+
    `</div>`+
    `<div class="maint-row2" style="margin-top:10px">`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_brand">${t("settings.printers.field_brand")}</label><input class="field pbrand" maxlength="30" value="${esc(brandLabel)}"></div>`+
    `<div class="maint-field"><label class="fl">${t("settings.printers.field_tags")} <span class="hint" data-i18n="settings.printers.field_tags_hint">${t("settings.printers.field_tags_hint")}</span></label><div class="tags-field-row"><input class="field ptags" maxlength="200" placeholder="e.g. garage, /red/" value="${esc((opts.tags||[]).join(", "))}"><span class="tags-row-swatch">${colorTagSwatchHtml((opts.tags||[]).join(", "))}</span></div></div>`+
    `</div>`+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title" data-i18n="settings.printers.section_connection">${t("settings.printers.section_connection")}</div>`+
    `<div class="maint-row2 paddr-row">`+
    `<div class="maint-field"><label class="fl" for="pip-${uid}" data-i18n="settings.printers.field_ip">${t("settings.printers.field_ip")}</label><input id="pip-${uid}" class="field pip" placeholder="${esc(t("settings.printers.ip_placeholder"))}" data-i18n-placeholder="settings.printers.ip_placeholder" value="${esc(addrIp)}"></div>`+
    `<div class="maint-field pport-field"><label class="fl" for="pport-${uid}" data-i18n="settings.printers.field_port">${t("settings.printers.field_port")}</label><input id="pport-${uid}" class="field pport" type="number" min="1" max="65535" value="${esc(addrPort)}"></div>`+
    `</div>`+
    `<div class="settings-help err paddr-err" style="display:none" data-i18n="settings.printers.ip_invalid">${t("settings.printers.ip_invalid")}</div>`+
    `<div class="maint-row2" style="margin-top:10px">`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_connector">${t("settings.printers.field_connector")}</label><select class="field pconnector">`+
    CONNECTOR_TYPES.map(c=>`<option value="${esc(c.type)}">${esc(c.label||c.type)}</option>`).join("")+
    `</select></div>`+
    `<div class="maint-field"><label class="fl">${t("settings.printers.field_api_token")} <span class="hint" data-i18n="settings.printers.field_api_token_hint">${t("settings.printers.field_api_token_hint")}</span></label>${secretFieldHtml("ptoken",!!opts.hasToken,t("settings.printers.secret_optional_placeholder"),"settings.printers.secret_optional_placeholder")}</div>`+
    `</div>`+
    `<div class="prow-test-row">`+
    `<button type="button" class="btn ghost ptest" data-i18n="settings.printers.test_connection_button">${t("settings.printers.test_connection_button")}</button>`+
    `<span class="pstatus ptest-status"></span>`+
    `</div>`+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title" data-i18n="settings.printers.section_hardware">${t("settings.printers.section_hardware")}</div>`+
    `<div class="maint-row2">`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_serial">${t("settings.printers.field_serial")}</label><input class="field pserial" placeholder="${esc(t("settings.printers.field_serial_placeholder"))}" data-i18n-placeholder="settings.printers.field_serial_placeholder" value="${esc(opts.serial||"")}"></div>`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_access_code">${t("settings.printers.field_access_code")}</label><input class="field pvcode" placeholder="XXXX" maxlength="8" value="${esc(opts.verificationCode||"")}"></div>`+
    `</div>`+
    `<div class="maint-row2" style="margin-top:10px">`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_purchased">${t("settings.printers.field_purchased")}</label><input class="field pdate" type="date" value="${esc(opts.purchaseDate||"")}"></div>`+
    `<div class="maint-field"><label class="fl" data-i18n="settings.printers.field_power_draw">${t("settings.printers.field_power_draw")}</label><input class="field pkwh" type="number" min="0" placeholder="0" value="${esc(opts.costKwh||"")}"></div>`+
    `</div>`+
    `<div class="hint" style="margin-top:6px" data-i18n="settings.printers.power_draw_hint">${t("settings.printers.power_draw_hint")}</div>`+
    `<div class="filmode-wrap" style="display:none;margin-top:10px;max-width:320px">`+
    `<label class="fl" data-i18n="settings.printers.field_filament_system">${t("settings.printers.field_filament_system")}</label>`+
    `<select class="field pfilmode">`+
    `<option value="single" data-i18n="settings.printers.filament_option_single">${t("settings.printers.filament_option_single")}</option>`+
    `<option value="cfs" data-i18n="settings.printers.filament_option_cfs">${t("settings.printers.filament_option_cfs")}</option>`+
    `</select>`+
    `<div class="hint" style="margin-top:6px" data-i18n="settings.printers.filament_system_hint">${t("settings.printers.filament_system_hint")}</div>`+
    `</div>`+
    `<div class="transport-wrap" style="display:none;margin-top:10px;max-width:320px">`+
    `<label class="fl" data-i18n="settings.printers.field_transport">${t("settings.printers.field_transport")}</label>`+
    `<select class="field ptransport">`+
    `<option value="auto" data-i18n="settings.printers.transport_option_auto">${t("settings.printers.transport_option_auto")}</option>`+
    `<option value="native" data-i18n="settings.printers.transport_option_native">${t("settings.printers.transport_option_native")}</option>`+
    `<option value="moonraker" data-i18n="settings.printers.transport_option_moonraker">${t("settings.printers.transport_option_moonraker")}</option>`+
    `</select>`+
    `<div class="hint" style="margin-top:6px" data-i18n="settings.printers.transport_hint">${t("settings.printers.transport_hint")}</div>`+
    `</div>`+
    `<div class="monitor-only-wrap settings-help" style="display:none;margin-top:10px" data-i18n="settings.printers.monitor_only_hint">${t("settings.printers.monitor_only_hint")}</div>`+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title" data-i18n="settings.printers.section_behavior">${t("settings.printers.section_behavior")}</div>`+
    `<div style="margin-bottom:10px">`+
    switchHtml("pforcedefaults-"+uid, opts.forceDefaults!==false, t("settings.printers.force_defaults_label"), t("settings.printers.force_defaults_desc"), false, "settings.printers.force_defaults_label", "settings.printers.force_defaults_desc")+
    `</div>`+
    `<div class="autolevel-wrap" style="margin-bottom:10px">`+
    switchHtml("pautolevel-"+uid,!!opts.autoLevel,t("settings.printers.auto_level_label"),t("settings.printers.auto_level_desc"),false,"settings.printers.auto_level_label","settings.printers.auto_level_desc")+
    `</div>`+
    `<div class="flowcal-wrap" style="margin-bottom:10px">`+
    switchHtml("pflowcal-"+uid,!!opts.flowCalibrate,t("settings.printers.flow_cal_label"),t("settings.printers.flow_cal_desc"),false,"settings.printers.flow_cal_label","settings.printers.flow_cal_desc")+
    `</div>`+
    `<div class="timelapse-wrap" style="margin-bottom:10px">`+
    switchHtml("ptimelapse-"+uid,!!opts.timelapse,t("settings.printers.timelapse_label"),t("settings.printers.timelapse_desc"),false,"settings.printers.timelapse_label","settings.printers.timelapse_desc")+
    `</div>`+
    `<div class="hint" style="margin-bottom:10px" data-i18n="settings.printers.defaults_hint">${t("settings.printers.defaults_hint")}</div>`+
    switchHtml("ppushnotify-"+uid,!!opts.pushNotify,t("settings.printers.push_notify_label"),t("settings.printers.push_notify_desc"),false,"settings.printers.push_notify_label","settings.printers.push_notify_desc")+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title" data-i18n="settings.printers.section_access">${t("settings.printers.section_access")}</div>`+
    `<div class="settings-help" style="margin-bottom:8px" data-i18n="settings.printers.access_hint">${t("settings.printers.access_hint")}</div>`+
    `<div class="pgroups-list">`+groupsChecklistHtml(opts.allowedGroups)+`</div>`+
    `</div>`+

    `<div class="prow-section" style="display:${QUEUE_MANAGEMENT_ENABLED?"":"none"}" data-queue-section>`+
    `<div class="prow-section-title" data-i18n="settings.printers.section_queue">${t("settings.printers.section_queue")}</div>`+
    `<div class="settings-help" style="margin-bottom:8px" data-i18n="settings.printers.queue_hint">${t("settings.printers.queue_hint")}</div>`+
    `<select class="field pprinterpool" style="max-width:240px">`+printerPoolOptionsHtml(opts.printerPoolId)+`</select>`+
    `<span class="pstatus pqueue-status" style="margin-left:8px"></span>`+
    `</div>`+

    `</div></details>`;

  // Capability-gated per-printer defaults: same three options as the print-
  // time checkboxes (pfilemodal), keyed the same way, so a connector that
  // doesn't declare the capability hides (and force-unchecks) the matching
  // Settings switch too, not just the print-time one.
  const PRINTER_PREF_SWITCHES=[
    {cap:"autoLevel", wrap:".autolevel-wrap", input:'[id^="pautolevel-"]'},
    {cap:"flowCalibration", wrap:".flowcal-wrap", input:'[id^="pflowcal-"]'},
    {cap:"timelapse", wrap:".timelapse-wrap", input:'[id^="ptimelapse-"]'}
  ].map(s=>({...s, wrapEl:row.querySelector(s.wrap), inputEl:row.querySelector(s.input)}));
  const connectorEl=row.querySelector(".pconnector");
  const modelBadgeEl=row.querySelector(".prow-model-badge");
  connectorEl.value=connType;
  const filModeWrap=row.querySelector(".filmode-wrap"), filModeEl=row.querySelector(".pfilmode");
  filModeEl.value=(opts.filamentMode==="cfs")?"cfs":"single";
  const transportWrap=row.querySelector(".transport-wrap"), transportEl=row.querySelector(".ptransport");
  const monitorOnlyWrap=row.querySelector(".monitor-only-wrap");
  transportEl.value=(opts.transport==="native"||opts.transport==="moonraker")?opts.transport:"auto";
  const syncPrintPrefVisibility=()=>{
    const caps=connectorCaps(connectorEl.value);
    PRINTER_PREF_SWITCHES.forEach(({cap,wrapEl,inputEl})=>{
      const supported=!!caps[cap];
      wrapEl.style.display=supported?"":"none";
      if(!supported) inputEl.checked=false;
    });
    // Filament-system mode is a Creality-only config choice (see
    // connectors/creality-klipper.js's getCapabilities), not a fixed
    // capability — U1/AD5X are always one fixed mode each, so this selector
    // only makes sense for creality-klipper.
    const isCreality=connectorEl.value==="creality-klipper";
    filModeWrap.style.display=isCreality?"":"none";
    if(!isCreality) filModeEl.value="single";
    // Transport mode is a FlashForge-only choice: those printers run either
    // the stock :8898 API or a firmware mod (ZMOD, Forge-X) serving Moonraker
    // on :7125, and the connector normally detects which. Every other
    // connector speaks exactly one protocol, so offering the choice there
    // would imply a switch that does nothing.
    const isFlashForge=connectorEl.value==="flashforge-ad5x"||connectorEl.value==="flashforge-adventurer";
    transportWrap.style.display=isFlashForge?"":"none";
    if(!isFlashForge) transportEl.value="auto";
    // A monitor-only connector (Bambu Lab) needs its serial + access code and
    // gets no controls — say both where the credentials are entered.
    monitorOnlyWrap.style.display=caps.control===false?"":"none";
  };
  const brandEl=row.querySelector(".pbrand");
  // Brand is editable for generic Klipper only (see the derivedBrand comment
  // above). `reDerive` is passed only from the connector <select>'s own
  // change handler — never on first render, where the value came from the
  // saved config and must be left exactly as saved. (A Klipper printer
  // legitimately saved as "Creality" would otherwise be rewritten back to
  // "Klipper" on every render, since that string is also a connector brand.)
  const syncBrandField=(reDerive)=>{
    const ct=CONNECTOR_TYPES.find(c=>c.type===connectorEl.value)||{};
    const editable=connectorEl.value===BRAND_EDITABLE_CONNECTOR;
    brandEl.disabled=!editable;
    // Disabled controls say why they're disabled rather than leaving the
    // user to guess (a SnapCon-wide rule).
    if(editable) brandEl.removeAttribute("title");
    else brandEl.title=t("settings.printers.field_brand_locked_title");
    if(!editable){ brandEl.value=ct.brand||ct.label||connectorEl.value; return; }
    // Editable: fill in the derived brand as a starting point, but only when
    // the field is empty or still holds a derived value — switching
    // Snapmaker -> Klipper must not leave "Snapmaker" behind.
    if(reDerive&&(!brandEl.value.trim()||isKnownConnectorBrand(brandEl.value))) brandEl.value=ct.brand||ct.label||connectorEl.value;
    else if(!brandEl.value.trim()) brandEl.value=ct.brand||ct.label||connectorEl.value;
  };
  // Which address fields this row shows is the connector's call, not this
  // row's (see connectorAddress()). Three shapes exist today: an editable
  // port (Moonraker-family), a fixed port the connector applies itself (the
  // U1, FlashForge), and no address at all (the Simulator, which has no
  // hardware to reach — it persists under a synthetic sim:// url generated
  // here rather than asking the user to invent something meaningless).
  const addrRow=row.querySelector(".paddr-row"), addrErr=row.querySelector(".paddr-err");
  const ipEl=row.querySelector(".pip"), portEl=row.querySelector(".pport"), portField=row.querySelector(".pport-field");
  const syncAddressFields=(connectorChanged)=>{
    const spec=connectorAddress(connectorEl.value);
    addrRow.style.display=spec.required?"":"none";
    if(!spec.required){
      addrErr.style.display="none";
      if(!row.dataset.url) row.dataset.url="sim://"+Math.random().toString(36).slice(2,10);
      return;
    }
    portField.style.display=spec.portEditable?"":"none";
    portEl.placeholder=spec.defaultPort?String(spec.defaultPort):"";
    // Only on a deliberate connector change, never on load: switching to a
    // connector with a fixed port drops the previous brand's port (it would
    // otherwise keep being composed into the URL from a field nobody can
    // see), and switching to one with a port offers its default. A stored
    // port on a fixed-port connector — a hand-edited config pointing
    // somewhere non-standard — is left exactly as it is.
    if(connectorChanged){
      if(!spec.portEditable) portEl.value="";
      else if(!portEl.value.trim()&&spec.defaultPort) portEl.value=String(spec.defaultPort);
    }
  };
  connectorEl.addEventListener("change", ()=>{
    syncPrintPrefVisibility();
    const ct=CONNECTOR_TYPES.find(c=>c.type===connectorEl.value)||{};
    modelBadgeEl.textContent=ct.label||connectorEl.value;
    syncBrandField(true);
    syncAddressFields(true);
  });
  syncPrintPrefVisibility();
  syncBrandField(false);
  // A brand-new row (no saved printer behind it, nothing typed yet) starts
  // on its connector's default port; an existing one keeps whatever it has.
  syncAddressFields(!opts.id&&!addrIp&&!addrPort);
  // Live-update the summary header as user types
  const nameEl=row.querySelector(".pname");
  const sumName=row.querySelector(".prow-sumname"), sumIp=row.querySelector(".prow-sumip");
  nameEl.addEventListener("input",()=>{ sumName.textContent=nameEl.value.trim()||t("settings.printers.new_printer_default"); });
  const syncSummaryIp=()=>{
    const ip=ipEl.value.trim(), port=portEl.value.trim();
    sumIp.textContent=ip?(ip+(port?":"+port:"")):"—";
  };
  ipEl.addEventListener("input",()=>{ addrErr.style.display="none"; syncSummaryIp(); });
  portEl.addEventListener("input",syncSummaryIp);
  // People have a full URL on hand far more often than a bare host — a
  // pasted "http://192.168.1.50:7125" is split into the fields it belongs
  // in rather than rejected. Only a value that genuinely is not an address
  // (a path, a query) gets the error.
  ipEl.addEventListener("change",()=>{
    const raw=ipEl.value.trim();
    addrErr.style.display="none";
    if(!raw||isValidHostValue(raw)) return;
    const parsed=parseAddress(raw);
    if(!parsed||!isValidHostValue(parsed.host)){ addrErr.style.display=""; return; }
    const spec=connectorAddress(connectorEl.value);
    ipEl.value=parsed.host;
    if(parsed.port&&spec.portEditable) portEl.value=parsed.port;
    if(["http","https"].includes(parsed.scheme)) row.dataset.scheme=parsed.scheme!==spec.scheme?parsed.scheme:"";
    ipEl.dispatchEvent(new Event("input",{bubbles:true}));
  });
  wireSecretField(row.querySelector(".secret-field"));
  const tagsEl=row.querySelector(".ptags"), tagsSwatch=row.querySelector(".tags-row-swatch");
  if(tagsEl&&tagsSwatch) tagsEl.addEventListener("input",()=>{ tagsSwatch.innerHTML=colorTagSwatchHtml(tagsEl.value); });

  // One row open at a time. Hooked on the summary's click rather than the
  // <details> toggle event on purpose: toggle also fires for the Expand all
  // button's own setAttribute("open") calls, which would make expanding all
  // rows collapse all but the last one. Every control inside the summary
  // (drag handle, ⋮ button, menu items) already stops propagation, so this
  // only ever sees a genuine "open/close this row" click.
  const detailsEl=row.querySelector(".prow-details");
  detailsEl.querySelector("summary").addEventListener("click",()=>{
    if(!detailsEl.open) closeOtherPrinterRows(detailsEl);
  });

  // Overflow menu — stop the click from also toggling the <details> open/closed.
  const menuBtn=row.querySelector(".prow-menu-btn"), menu=row.querySelector(".prow-menu");
  menuBtn.addEventListener("click",e=>{
    e.stopPropagation();
    document.querySelectorAll(".prow-menu.open").forEach(m=>{ if(m!==menu) m.classList.remove("open"); });
    // Always reopen downward first, then measure: the menu has no size to
    // measure while it's display:none, and a row can be near the bottom on
    // one open and mid-panel on the next (rows reorder, the panel scrolls).
    menu.classList.remove("up");
    if(menu.classList.toggle("open")) flipPrinterMenuIfClipped(menuBtn,menu);
  });
  row.querySelector('[data-act="maint"]').addEventListener("click",e=>{
    e.stopPropagation(); menu.classList.remove("open");
    const u=rowAddressUrl(row);
    const idx=PRINTERS_CFG.findIndex(p=>p.url===u);
    if(idx>=0) openMaintenance(idx);
  });
  // Duplicate copies this row's CURRENT field values (including unsaved
  // edits — what you see is what gets copied), with three deliberate
  // exceptions:
  //   url  — cleared. POST /api/config matches an id-less row to an existing
  //          printer BY URL (server.js), so a copy carrying the original's
  //          URL would be handed the original's id: two config entries, one
  //          id, and maintenance history/group access/pool assignment all
  //          key off it. The copy is for a different machine anyway.
  //   serial + access code — cleared for the same reason: they identify one
  //          physical machine (and on FlashForge they ARE that machine's
  //          credentials), so carrying them over would just be wrong data to
  //          overwrite rather than a useful starting point.
  //   token — the Moonraker API token never leaves the server (publicCfg
  //          sends hasToken, not the value), so there's nothing to copy.
  //   printerPoolId — assigned through its own endpoint, and needs a saved
  //          printer id the copy doesn't have yet.
  row.querySelector('[data-act="duplicate"]').addEventListener("click",e=>{
    e.stopPropagation(); menu.classList.remove("open");
    const base=nameEl.value.trim()||t("settings.printers.new_printer_default");
    // .pname is maxlength=25, so the suffix has to fit inside that budget —
    // trim the name rather than the "(Copy)" marker, which is the part that
    // says what this row is.
    const NAME_MAX=25;
    let dupName=t("settings.printers.duplicate_name",{name:base});
    if(dupName.length>NAME_MAX){
      const trimmed=base.slice(0,Math.max(1,base.length-(dupName.length-NAME_MAX))).trim();
      dupName=t("settings.printers.duplicate_name",{name:trimmed});
    }
    if(dupName.length>NAME_MAX) dupName=dupName.slice(0,NAME_MAX);
    const dup=addPrinterRow(dupName,"",{
      location:row.querySelector(".ploc").value.trim(),
      costKwh:row.querySelector(".pkwh").value.trim(),
      purchaseDate:row.querySelector(".pdate").value,
      autoLevel:row.querySelector('[id^="pautolevel-"]').checked,
      flowCalibrate:row.querySelector('[id^="pflowcal-"]').checked,
      timelapse:row.querySelector('[id^="ptimelapse-"]').checked,
      pushNotify:row.querySelector('[id^="ppushnotify-"]').checked,
      forceDefaults:row.querySelector('[id^="pforcedefaults-"]').checked,
      connector:connectorEl.value,
      brand:brandEl.value.trim(),
      filamentMode:filModeEl.value,
      tags:row.querySelector(".ptags").value.split(",").map(s=>s.trim()).filter(Boolean),
      allowedGroups:[...row.querySelectorAll(".pgroups-chk:checked")].map(c=>c.value)
    },true);
    // addPrinterRow appends; a copy belongs next to its original.
    row.parentNode.insertBefore(dup,row.nextSibling);
    closeOtherPrinterRows(dup.querySelector(".prow-details"));
    markPrintersDirty();
    dup.querySelector(".pip").focus();
  });
  row.querySelector('[data-act="up"]').addEventListener("click",e=>{
    e.stopPropagation(); menu.classList.remove("open");
    const prev=row.previousElementSibling; if(prev) row.parentNode.insertBefore(row,prev);
    markPrintersDirty();
  });
  row.querySelector('[data-act="down"]').addEventListener("click",e=>{
    e.stopPropagation(); menu.classList.remove("open");
    const next=row.nextElementSibling; if(next) row.parentNode.insertBefore(next,row);
    markPrintersDirty();
  });
  row.querySelector('[data-act="remove"]').addEventListener("click",e=>{
    e.stopPropagation(); menu.classList.remove("open");
    const pname=nameEl.value.trim()||t("settings.printers.remove_confirm_fallback_name");
    if(!confirm(t("settings.printers.remove_confirm",{name:pname}))) return;
    // Only a printer that existed at load time is a real "removal" to call
    // out in the dirty footer — a never-saved new row just vanishes, since
    // there was nothing on file for it in the first place.
    if(PRINTER_SNAPSHOTS.has(row)) PRINTER_REMOVED.push(pname);
    row.remove();
    markPrintersDirty();
  });

  // Drag-to-reorder — same dataTransfer/insertBefore pattern as the fleet
  // card drag-reorder (wireFleetDrag), but purely local: it reorders the DOM
  // and marks the tab dirty rather than saving immediately, since every
  // other edit here waits for the Save button too.
  const handle=row.querySelector(".prow-drag-handle");
  handle.addEventListener("click",e=>e.stopPropagation());
  handle.addEventListener("dragstart",e=>{
    e.stopPropagation();
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed="move";
    e.dataTransfer.setData("text/plain","");
  });
  handle.addEventListener("dragend",()=>{ row.classList.remove("dragging"); });

  // Test connection — goes through the connector abstraction (works for
  // every brand, and before the printer's even been saved), unlike the
  // Klipper-only probe used to auto-fill name/serial on Save.
  row.querySelector(".ptest").addEventListener("click",async()=>{
    const st=row.querySelector(".ptest-status");
    const u=rowAddressUrl(row);
    if(!u){ st.className="pstatus err"; st.textContent=t("settings.printers.test_connection_no_ip"); return; }
    st.className="pstatus work"; st.textContent=t("settings.printers.test_connection_testing");
    try{
      // Sends the row's CURRENT field values, not the saved ones — the point
      // of Test is to check a printer before committing it. serial/
      // verificationCode are what FlashForge authenticates with; omitting
      // them made every FlashForge test fail with "SN is different".
      const r=await (await postJSON("/api/test-connection",{
        url:u, connector:connectorEl.value, name:nameEl.value.trim(),
        serial:row.querySelector(".pserial").value.trim(),
        verificationCode:row.querySelector(".pvcode").value.trim()
      })).json();
      if(r.error) throw new Error(r.error);
      const parts=[t("settings.printers.test_connection_label_state",{value:r.state||"unknown"})];
      if(r.bed&&typeof r.bed.temp==="number") parts.push(t("settings.printers.test_connection_label_bed",{value:r.bed.temp}));
      if(r.firmware&&r.firmware.firmware) parts.push(t("settings.printers.test_connection_label_firmware",{value:r.firmware.firmware}));
      st.className="pstatus ok"; st.textContent=t("settings.printers.test_connection_reachable",{details:parts.join(", ")});
    }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  });

  // Printer Pool self-saves immediately (like printer-tags' own dedicated
  // endpoint) rather than waiting for the batched Save button — it has real
  // server-side validation (the printer's queue must be idle and empty) and
  // touches QueueStore state, not just config.json.
  const printerPoolEl=row.querySelector(".pprinterpool");
  if(printerPoolEl){
    printerPoolEl.addEventListener("change",async()=>{
      const st=row.querySelector(".pqueue-status");
      if(!row.dataset.printerId){ st.className="pstatus pqueue-status err"; st.textContent=t("settings.printers.pool_save_no_id"); return; }
      st.className="pstatus pqueue-status work"; st.textContent=t("settings.printers.pool_saving");
      try{
        const r=checkAuthFailure(await postJSON("/api/printer-pool",{printerId:row.dataset.printerId,printerPoolId:printerPoolEl.value||null}));
        const d=await r.json();
        // Refused outright for a monitor-only printer: put the picker back to
        // "no pool" so it does not keep showing an assignment that never saved.
        if(d.code==="monitor_only") printerPoolEl.value="";
        if(!r.ok||d.error) throw new Error(PRINTER_POOL_ERROR_KEYS[d.code]?t(PRINTER_POOL_ERROR_KEYS[d.code]):(d.error||"HTTP "+r.status));
        // The server saved it, but PRINTERS_CFG is a snapshot fetched once at
        // page-load/gear-open — anything else that reads it (the Queue
        // Management view's per-pool grouping, chiefly) would otherwise
        // keep showing the pre-assignment state until a full reload.
        const cfgEntry=PRINTERS_CFG.find(p=>p.id===row.dataset.printerId);
        if(cfgEntry) cfgEntry.printerPoolId=d.printerPoolId||undefined;
        st.className="pstatus pqueue-status ok"; st.textContent=t("settings.printers.pool_saved");
      }catch(e){ st.className="pstatus pqueue-status err"; st.textContent=e.message; }
    });
  }

  row.querySelectorAll(".prow-body input, .prow-body select").forEach(el=>{
    el.addEventListener("input", markPrintersDirty);
    el.addEventListener("change", markPrintersDirty);
  });

  $("setPrinters").appendChild(row);
  // Returned so callers that need to place or focus the new row (Duplicate)
  // can, without re-querying for "the last one added".
  return row;
}

// ---- Logs tab: read-only, paged, admin-only (the whole Settings screen
// already is). LOG_OFFSET/LOG_TOTAL track the current filter's paging —
// reset to 0 by Filter, advanced by Load more. ----
let LOG_OFFSET=0, LOG_TOTAL=0, LOG_UNAVAILABLE=false, LOG_LOADED=false;
// Full set of currently-displayed rows (reset replaces it, Load more
// concatenates) — kept around purely so a live locale switch can re-render
// already-fetched rows via refreshLogsDynamicText() without re-fetching from
// /api/audit-log. No translated strings are stored in it: it's the same raw
// API row shape, translated fresh on every render.
let LOG_CACHED_ROWS=[];
const LOG_LIMIT=50;
// h/m duration formatting for the Logs tab — same shape as server.js's own
// fmtDur() (used in notification text), just duplicated client-side since
// there's no shared module between the two.
function fmtLogHM(sec){
  if(typeof sec!=="number"||!isFinite(sec)||sec<0) return null;
  sec=Math.round(sec);
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60);
  return h?h+"h "+String(m).padStart(2,"0")+"m":m+"m";
}
// Known numeric fields from print-completed get readable formatting (time
// as h/m, filament as an estimated gram figure — see server.js's comment on
// why it's only ever an estimate — cost with the configured currency
// symbol); anything else in a detail blob (extruder index, hex color,
// target temp, a settings diff, etc.) falls back to plain "key: value" and
// is intentionally NOT translated — it's an open-ended, ever-growing set of
// internal field names, not SnapCon UI chrome.
const LOG_DETAIL_KNOWN_KEYS=new Set(["file","elapsedSec","filamentUsedMm","filamentGramsEst","costEst"]);
function fmtLogDetail(row){
  if(!row.detail) return "";
  let d;
  try{ d=JSON.parse(row.detail); }catch{ return String(row.detail); }
  const parts=[];
  if(d.file) parts.push(d.file);
  const hm=fmtLogHM(d.elapsedSec);
  if(hm) parts.push(t("settings.logs.detail_time",{value:hm}));
  if(typeof d.filamentGramsEst==="number") parts.push(t("settings.logs.detail_filament_grams",{value:d.filamentGramsEst.toFixed(1)}));
  else if(typeof d.filamentUsedMm==="number") parts.push(t("settings.logs.detail_filament_meters",{value:(d.filamentUsedMm/1000).toFixed(2)}));
  if(typeof d.costEst==="number") parts.push(t("settings.logs.detail_cost",{value:CURRENCY+d.costEst.toFixed(2)}));
  for(const [k,v] of Object.entries(d)){
    if(LOG_DETAIL_KNOWN_KEYS.has(k)) continue;
    parts.push(k+": "+(v&&typeof v==="object"?JSON.stringify(v):v));
  }
  return parts.join(", ");
}
// category is a closed 3-value enum (auth/job/admin) — translate the display
// label using the SAME keys as the #logCategory filter's own <option>s.
// event is an open-ended, app-wide, ever-growing slug vocabulary and stays
// raw untranslated, same reasoning as the detail fallback above.
const LOG_CATEGORY_LABEL_KEYS={auth:"settings.logs.category_auth",job:"settings.logs.category_job",admin:"settings.logs.category_admin"};
function logCategoryLabel(cat){
  const key=LOG_CATEGORY_LABEL_KEYS[cat];
  return key?t(key):cat;
}
function renderLogRows(rows, append){
  const body=$("logTableBody");
  const html=rows.map(r=>`<tr><td>${esc(new Date(r.ts).toLocaleString())}</td><td>${esc(logCategoryLabel(r.category))}/${esc(r.event)}</td><td>${esc(r.userLabel||"—")}</td><td>${esc(r.printerName||"—")}</td><td>${esc(fmtLogDetail(r))}</td></tr>`).join("");
  if(append) body.insertAdjacentHTML("beforeend", html);
  else body.innerHTML=html||`<tr><td colspan="5" style="text-align:center;color:var(--ink-faint)">${esc(t("settings.logs.no_entries"))}</td></tr>`;
}
async function loadAuditLogUI(reset){
  if(reset){ LOG_OFFSET=0; LOG_CACHED_ROWS=[]; }
  const st=$("logStatus");
  st.className="pstatus work"; st.textContent=t("settings.logs.loading");
  const params=new URLSearchParams();
  const q=$("logSearch").value.trim(); if(q) params.set("q",q);
  const cat=$("logCategory").value; if(cat) params.set("category",cat);
  const from=$("logFrom").value; if(from) params.set("from", String(new Date(from+"T00:00:00").getTime()));
  const to=$("logTo").value; if(to) params.set("to", String(new Date(to+"T23:59:59").getTime()));
  params.set("limit", String(LOG_LIMIT));
  params.set("offset", String(LOG_OFFSET));
  try{
    const d=await getJSON("/api/audit-log?"+params.toString());
    LOG_LOADED=true;
    if(d.unavailable){
      LOG_UNAVAILABLE=true; LOG_CACHED_ROWS=[];
      st.className="pstatus err"; st.textContent=t("settings.logs.unavailable");
      $("logTableBody").innerHTML=""; $("logLoadMore").style.display="none";
      return;
    }
    LOG_UNAVAILABLE=false;
    LOG_TOTAL=d.total||0;
    const rows=d.rows||[];
    LOG_CACHED_ROWS=reset?rows:LOG_CACHED_ROWS.concat(rows);
    renderLogRows(rows, !reset);
    st.className="pstatus"; st.textContent=tn("settings.logs.entry_count",LOG_TOTAL);
    $("logLoadMore").style.display=(LOG_OFFSET+rows.length<LOG_TOTAL)?"":"none";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}
// Pure re-render off already-fetched rows/status — no refetch merely because
// the locale changed. Only acts once the Logs tab has actually been loaded
// at least once (LOG_LOADED), so an unvisited tab isn't force-rendered.
function refreshLogsDynamicText(){
  if(!LOG_LOADED||!$("logTableBody")) return;
  if(LOG_UNAVAILABLE){
    $("logStatus").textContent=t("settings.logs.unavailable");
    return;
  }
  renderLogRows(LOG_CACHED_ROWS, false);
  $("logStatus").textContent=tn("settings.logs.entry_count",LOG_TOTAL);
}

// ---- Users tab: each row saves itself immediately, independent of #saveCfg ----
async function loadUsersUI(){
  $("setUsers").innerHTML="";
  try{
    const users=await getJSON("/api/users");
    users.forEach(u=>addUserRow(u));
  }catch{}
}
const USER_ROLE_LABEL_KEYS={ admin:"settings.users.role_admin", regular:"settings.users.role_regular", view:"settings.users.role_view" };
function roleLabel(r){ return t(USER_ROLE_LABEL_KEYS[r]||USER_ROLE_LABEL_KEYS.view); }
// Maps /api/users and /api/groups's additive `code` field (added alongside
// their existing `error` string — see server.js) to a translation key. Any
// code not in this table (or absent) falls back to the raw `error` text,
// same as the Printers/Notifications/Firmware precedent. user_not_found is
// shared by both the PUT and DELETE routes.
const USER_ERROR_KEYS={
  invalid_login_name:"settings.users.error_invalid_login_name",
  login_name_taken:"settings.users.error_login_name_taken",
  invalid_role:"settings.users.error_invalid_role",
  password_too_short:"settings.users.error_password_too_short",
  last_admin_demote:"settings.users.error_last_admin_demote",
  last_admin_delete:"settings.users.error_last_admin_delete",
  otp_no_password:"settings.users.error_otp_no_password",
  password_or_otp_required:"settings.users.password_or_otp_required",
  user_not_found:"settings.users.error_user_not_found",
  remote_access_needs_account:"settings.users.error_remote_access_needs_account",
  group_name_required:"settings.users.error_group_name_required",
  group_not_found:"settings.users.error_group_not_found",
  group_everyone_immutable_rename:"settings.users.error_group_everyone_immutable_rename",
  group_everyone_immutable_delete:"settings.users.error_group_everyone_immutable_delete"
};
function userErrorText(d,fallback){
  return (d&&d.code&&USER_ERROR_KEYS[d.code])?t(USER_ERROR_KEYS[d.code]):fallback;
}
// Two per-row bits are computed in JS rather than declarative markup, so a
// live locale switch needs to explicitly re-render them: the blank-login
// row summary fallback ("New User"), and the password placeholder (which
// also depends on new-vs-existing-user state, so it can't be a plain
// data-i18n-placeholder either). The role summary label is included too —
// roleLabel() is JS-computed, same reasoning as every other imperative
// label in this file. All three are pure re-renders off already-known
// DOM/dataset state, no network calls or mutation.
function refreshUserRowDynamicText(){
  document.querySelectorAll("#setUsers .prow").forEach(row=>{
    const loginEl=row.querySelector(".ulogin"), sumName=row.querySelector(".prow-sumname");
    if(loginEl&&sumName&&!loginEl.value.trim()) sumName.textContent=t("settings.users.new_user_default");
    const roleSel=row.querySelector(".urole"), sumRole=row.querySelector(".prow-sumip");
    if(roleSel&&sumRole) sumRole.textContent=roleLabel(roleSel.value);
    const pwEl=row.querySelector(".upassword");
    if(pwEl) pwEl.placeholder=row.dataset.userId?t("settings.users.password_placeholder_keep"):t("settings.users.password_placeholder_required");
  });
}
let UROW_UID=0;
function addUserRow(u,autoOpen){
  const uid=++UROW_UID;
  const row=document.createElement("div"); row.className="prow";
  row.dataset.userId=u&&u.id?u.id:"";
  // Source of truth for this row's group membership between saves — the
  // Groups modal is one shared modal/DOM, not baked per-row, so it reads
  // this back out on open and writes it back here on Save.
  row.dataset.groupIds=JSON.stringify((u&&u.groupIds)||[]);
  row.innerHTML=
    `<details class="prow-details"${autoOpen?" open":""}>`+
    `<summary><span class="prow-chevron">▶</span>`+
    `<div class="prow-suminfo"><span class="prow-sumname">${esc(u&&u.loginName?u.loginName:t("settings.users.new_user_default"))}</span><span class="prow-sumip">${esc(roleLabel(u?u.role:"view"))}</span></div>`+
    `<div class="prow-sumbtns"><button class="dup" title="Duplicate" data-i18n-title="settings.users.duplicate_title">⧉</button><button class="rm" title="Remove" data-i18n-title="common.remove">×</button></div>`+
    `</summary>`+
    `<div class="prow-body"><div class="prow-rows">`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl" data-i18n="settings.users.first_label">First</span><input class="field ufirst" maxlength="40" value="${esc(u&&u.firstName||"")}" style="width:150px">`+
    `<span class="pi-lbl" data-i18n="settings.users.last_label">Last</span><input class="field ulast" maxlength="40" value="${esc(u&&u.lastName||"")}" style="width:150px">`+
    `</div>`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl" data-i18n="settings.users.login_label">Login</span><input class="field ulogin" maxlength="32" value="${esc(u&&u.loginName||"")}" style="width:150px" autocomplete="off">`+
    `<span class="pi-lbl" data-i18n="settings.users.role_label">Role</span><select class="field urole" style="width:140px">`+
    `<option value="view" data-i18n="settings.users.role_view">View Only</option><option value="regular" data-i18n="settings.users.role_regular">Regular</option><option value="admin" data-i18n="settings.users.role_admin">Admin</option>`+
    `</select>`+
    `</div>`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl" data-i18n="settings.users.email_label">Email</span><input class="field uemail" type="email" value="${esc(u&&u.email||"")}" style="flex:1;min-width:0">`+
    `<span class="pi-lbl" data-i18n="settings.users.phone_label">Phone</span><input class="field uphone" value="${esc(u&&u.phone||"")}" style="width:150px">`+
    `</div>`+
    `<div class="prow-extra">`+
    switchHtml("uotp-"+uid,!!(u&&u.otpEnabled),t("settings.users.otp_login_label"),null,false,"settings.users.otp_login_label")+
    `<label title="Password" data-i18n-title="settings.users.password_label" class="upwrap"><span class="pi-lbl" data-i18n="settings.users.password_label">Password</span> <input class="field upassword" type="password" maxlength="64" placeholder="${u?t("settings.users.password_placeholder_keep"):t("settings.users.password_placeholder_required")}" style="max-width:180px" autocomplete="new-password"></label>`+
    `<button type="button" class="btn ghost ugroups" data-i18n="settings.users.groups_button">Groups</button>`+
    `<button class="btn primary usave" data-i18n="common.save">Save</button>`+
    `<span class="pstatus usave-status"></span>`+
    `</div></div></div></details>`;
  const roleSel=row.querySelector(".urole"); roleSel.value=u?u.role:"view";
  const loginEl=row.querySelector(".ulogin"), sumName=row.querySelector(".prow-sumname"), sumRole=row.querySelector(".prow-sumip");
  loginEl.addEventListener("input",()=>{ sumName.textContent=loginEl.value.trim()||t("settings.users.new_user_default"); });
  roleSel.addEventListener("change",()=>{ sumRole.textContent=roleLabel(roleSel.value); });
  const otpEl=row.querySelector('[id^="uotp-"]'), pwEl=row.querySelector(".upassword"), pwWrap=row.querySelector(".upwrap");
  const syncPwState=()=>{
    pwWrap.style.display=otpEl.checked?"none":"";
    pwEl.disabled=otpEl.checked;
    pwEl.placeholder=row.dataset.userId?t("settings.users.password_placeholder_keep"):t("settings.users.password_placeholder_required");
    if(otpEl.checked) pwEl.value="";
  };
  otpEl.addEventListener("change", syncPwState); syncPwState();
  row.querySelectorAll(".dup,.rm").forEach(b=>b.addEventListener("click",e=>e.stopPropagation()));
  row.querySelector(".rm").addEventListener("click",async()=>{
    const id=row.dataset.userId;
    if(!id){ row.remove(); return; }
    if(!confirm(t("settings.users.remove_confirm",{name:loginEl.value||""}))) return;
    try{
      const r=checkAuthFailure(await fetch("/api/users/"+id,{method:"DELETE"}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(userErrorText(d,d.error||("HTTP "+r.status)));
      row.remove();
    }catch(e){ alert(e.message); }
  });
  // Duplicate copies only role + OTP-enabled — every identity/credential field starts blank.
  row.querySelector(".dup").addEventListener("click",()=>{
    addUserRow({ role: roleSel.value, otpEnabled: otpEl.checked }, true);
  });
  row.querySelector(".ugroups").addEventListener("click",()=>{
    openGroupsModal(row, loginEl.value.trim()||t("settings.users.groups_modal_default_name"));
  });
  row.querySelector(".usave").addEventListener("click",async()=>{
    const st=row.querySelector(".usave-status");
    const body={
      firstName: row.querySelector(".ufirst").value.trim(),
      lastName: row.querySelector(".ulast").value.trim(),
      loginName: loginEl.value.trim(),
      email: row.querySelector(".uemail").value.trim(),
      phone: row.querySelector(".uphone").value.trim(),
      role: roleSel.value,
      otpEnabled: otpEl.checked,
      groupIds: JSON.parse(row.dataset.groupIds||"[]")
    };
    if(pwEl.value) body.password=pwEl.value;
    // "usave-status" must stay in className every time — it's how this element
    // gets re-found on the *next* click (className is fully overwritten below,
    // not just toggled, since it mirrors the pstatus idiom used elsewhere).
    if(!body.loginName){ st.className="pstatus usave-status err"; st.textContent=t("settings.users.error_login_name_required"); return; }
    const id=row.dataset.userId;
    if(!id&&!otpEl.checked&&!pwEl.value){ st.className="pstatus usave-status err"; st.textContent=t("settings.users.password_or_otp_required"); return; }
    st.className="pstatus usave-status work"; st.textContent=t("settings.dirty_bar.saving");
    try{
      const r=checkAuthFailure(id
        ? await fetch("/api/users/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
        : await fetch("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(userErrorText(d,d.error||("HTTP "+r.status)));
      row.dataset.userId=d.user.id;
      row.dataset.groupIds=JSON.stringify(d.user.groupIds||[]);
      pwEl.value="";
      st.className="pstatus usave-status ok"; st.textContent=t("settings.dirty_bar.saved");
      sumName.textContent=d.user.loginName; sumRole.textContent=roleLabel(d.user.role);
      syncPwState();
    }catch(e){ st.className="pstatus usave-status err"; st.textContent=e.message; }
  });
  $("setUsers").appendChild(row);
}

// ---- Groups modal: shared between every user row (assign membership) and
// its own inline group CRUD — one DOM instance, opened against whichever
// row's Groups button was clicked. Saving here only stages the selection
// onto that row's dataset; it's not persisted until the row's own Save
// button runs, same as every other field on a user row. ----
let GROUPS_MODAL_ROW=null;
function openGroupsModal(row, displayName){
  GROUPS_MODAL_ROW=row;
  $("groupsModalUserName").textContent=displayName;
  renderGroupsCheckList(JSON.parse(row.dataset.groupIds||"[]"));
  renderGroupsManageList();
  $("newGroupName").value="";
  $("groupsManageStatus").className="pstatus"; $("groupsManageStatus").textContent="";
  $("groupsModal").classList.add("show");
}
function closeGroupsModal(){ $("groupsModal").classList.remove("show"); GROUPS_MODAL_ROW=null; }
function checkedGroupIds(){
  return [...document.querySelectorAll("#groupsCheckList .groups-chk:checked")].map(c=>c.value);
}
function renderGroupsCheckList(selected){
  const sel=new Set(selected||[]);
  $("groupsCheckList").innerHTML = GROUPS.length
    ? GROUPS.map(g=>`<label class="checkbox-row" for="groupschk-${esc(g.id)}"><input type="checkbox" id="groupschk-${esc(g.id)}" class="groups-chk checkbox-input" value="${esc(g.id)}" ${sel.has(g.id)?"checked":""}><span class="checkbox-text"><span class="checkbox-label">${esc(g.name)}</span></span></label>`).join("")
    : `<div class="settings-help">${t("settings.users.groups_modal_empty")}</div>`;
}
function renderGroupsManageList(){
  $("groupsManageList").innerHTML=GROUPS.map(g=>{
    const isEveryone=g.id===GROUP_EVERYONE_ID;
    return `<div style="display:flex;align-items:center;gap:6px" data-groupid="${esc(g.id)}">`+
      `<input class="field group-rename" value="${esc(g.name)}" maxlength="40" ${isEveryone?"disabled":""} style="flex:1">`+
      (isEveryone?"":`<button type="button" class="btn ghost group-delete" title="Delete group" data-i18n-title="settings.users.delete_group_title">×</button>`)+
      `</div>`;
  }).join("");
  $("groupsManageList").querySelectorAll(".group-rename").forEach(inp=>{
    const orig=inp.value;
    inp.addEventListener("change", async ()=>{
      const id=inp.closest("[data-groupid]").dataset.groupid;
      const name=inp.value.trim();
      if(!name || name===orig) { inp.value=name||orig; return; }
      try{
        const r=await fetch("/api/groups/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});
        const d=await r.json(); if(!r.ok||d.error) throw new Error(userErrorText(d,d.error||("HTTP "+r.status)));
        const kept=checkedGroupIds();
        await loadGroupsUI();
        renderGroupsCheckList(kept);
        renderGroupsManageList();
      }catch(e){ alert(e.message); inp.value=orig; }
    });
  });
  $("groupsManageList").querySelectorAll(".group-delete").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id=btn.closest("[data-groupid]").dataset.groupid;
      const g=GROUPS.find(x=>x.id===id);
      if(!confirm(t("settings.users.delete_group_confirm",{name:g?g.name:""}))) return;
      try{
        const r=await fetch("/api/groups/"+id,{method:"DELETE"});
        const d=await r.json(); if(!r.ok||d.error) throw new Error(userErrorText(d,d.error||("HTTP "+r.status)));
        const kept=checkedGroupIds().filter(gid=>gid!==id);
        await loadGroupsUI();
        renderGroupsCheckList(kept);
        renderGroupsManageList();
      }catch(e){ alert(e.message); }
    });
  });
}

// Printer Access checklist: which groups can see/use this printer — same
// GROUPS cache the Users tab's Groups modal reads, rendered inline (not a
// popup) since a printer only ever needs this one thing set, not a whole
// modal's worth of controls.
function groupsChecklistHtml(selected){
  const sel=new Set((selected&&selected.length)?selected:[GROUP_EVERYONE_ID]);
  if(!GROUPS.length) return `<div class="settings-help">${t("settings.printers.no_groups_yet")}</div>`;
  return GROUPS.map(g=>`<label class="checkbox-row" style="display:inline-flex;margin:2px 14px 2px 0"><input type="checkbox" class="pgroups-chk checkbox-input" value="${esc(g.id)}" ${sel.has(g.id)?"checked":""}><span class="checkbox-text"><span class="checkbox-label">${esc(g.name)}</span></span></label>`).join("");
}

function gatherPrinters(){
  return [...$("setPrinters").querySelectorAll(".prow")].map(r=>({
    id:r.dataset.printerId||undefined,
    name:r.querySelector(".pname").value.trim(),
    ip:r.querySelector(".pip").value.trim()||undefined,
    port:r.querySelector(".pport").value.trim()||undefined,
    // Composed client-side as well as server-side: a Simulator row has no
    // address fields and still needs the synthetic url it persists under,
    // and POST /api/config matches an id-less row to an existing printer
    // by url — that match has to see the same value it always has.
    url:rowAddressUrl(r)||r.dataset.url||undefined,
    location:r.querySelector(".ploc").value.trim()||undefined,
    costKwh:r.querySelector(".pkwh").value.trim()||undefined,
    purchaseDate:r.querySelector(".pdate").value||undefined,
    autoLevel:r.querySelector('[id^="pautolevel-"]').checked||undefined,
    flowCalibrate:r.querySelector('[id^="pflowcal-"]').checked||undefined,
    timelapse:r.querySelector('[id^="ptimelapse-"]').checked||undefined,
    pushNotify:r.querySelector('[id^="ppushnotify-"]').checked||undefined,
    // Real boolean, not the ||undefined pattern above — the server tells
    // "explicitly off" apart from "field never sent" by checking
    // typeof === "boolean", and collapsing false to undefined here would
    // break that (this switch defaults to true, unlike the others).
    forceDefaults:r.querySelector('[id^="pforcedefaults-"]').checked,
    connector:r.querySelector(".pconnector").value,
    // Sent for every row, honored by the server only for the connector whose
    // Brand field is editable (BRAND_EDITABLE_CONNECTOR) — for the rest it's
    // the derived value being echoed back, which the server re-derives anyway.
    brand:r.querySelector(".pbrand").value.trim()||undefined,
    filamentMode:r.querySelector(".pfilmode").value==="cfs"?"cfs":undefined,
    // Sent for every row; the server allowlists it and only the FlashForge
    // connectors ever read it. "auto" is the absence of a pin, so it is sent
    // as undefined rather than stored.
    transport:(v=>v==="native"||v==="moonraker"?v:undefined)(r.querySelector(".ptransport").value),
    serial:r.querySelector(".pserial").value.trim()||undefined,
    verificationCode:r.querySelector(".pvcode").value.trim()||undefined,
    token:secretFieldValue(r.querySelector(".secret-field")),
    tags:r.querySelector(".ptags").value.split(",").map(t=>t.trim()).filter(Boolean),
    allowedGroups:[...r.querySelectorAll(".pgroups-chk:checked")].map(c=>c.value)
  })).filter(p=>p.url);
}
async function runDiscover(subnet){
  const w=$("discwrap"); w.innerHTML='<div class="discrow"><span class="di">'+esc(t("settings.printers.discover_scanning",{subnet:subnet?subnet:t("settings.printers.discover_local_network_label")}))+'</span></div>';
  try{
    const url=subnet?"/api/discover?subnet="+encodeURIComponent(subnet):"/api/discover";
    const d=await getJSON(url);
    if(d.error){ w.innerHTML='<div class="discrow"><span class="di" style="color:var(--bad)">'+esc(d.error)+'</span></div>'; return; }
    if(!d.found.length){ w.innerHTML='<div class="discrow"><span class="di">'+esc(t("settings.printers.discover_none_found",{subnets:(d.subnets||[]).join(", ")}))+'</span></div>'; return; }
    const have=new Set(gatherPrinters().map(p=>p.url.replace(/\/+$/,"")));
    w.innerHTML="";
    const newPrinters=[];
    d.found.forEach(f=>{
      const already=have.has(f.url.replace(/\/+$/,""));
      if(!already) newPrinters.push(f);
      const row=document.createElement("div"); row.className="discrow";
      // The button's data-i18n attribute is kept in sync with its Add/Added
      // state at both points below (initial render, and the click handler)
      // so applyI18nToDom() re-translates the CURRENT state on a live locale
      // switch instead of resetting an already-clicked "Added" button back
      // to "Add" — same reasoning as #collapseAll's dataset-driven label.
      const btnKey=already?"settings.printers.discover_added_button":"settings.printers.discover_add_button";
      row.innerHTML=`<span class="di"><b>${esc(f.device_name||f.machine_type||t("settings.printers.discover_printer_fallback"))}</b> · ${esc(f.ip)}${f.mac?" · "+esc(f.mac):""}${f.serial?" · "+esc(t("settings.printers.discover_serial_label",{value:f.serial})):""}</span>`+
        `<button class="btn ghost" ${already?"disabled":""} data-i18n="${btnKey}">${t(btnKey)}</button>`;
      const btn=row.querySelector("button");
      if(!already) btn.addEventListener("click",()=>{ addPrinterRow(f.device_name||"U1", f.url, {serial:f.serial||""},true); btn.disabled=true; btn.textContent=t("settings.printers.discover_added_button"); btn.setAttribute("data-i18n","settings.printers.discover_added_button"); });
      w.appendChild(row);
    });
    const aab=$("addAllSave");
    if(newPrinters.length){
      aab.style.display="";
      aab.onclick=async()=>{
        newPrinters.forEach(f=>addPrinterRow(f.device_name||"U1",f.url,{serial:f.serial||""},true));
        w.querySelectorAll("button").forEach(b=>{b.disabled=true;b.textContent=t("settings.printers.discover_added_button");b.setAttribute("data-i18n","settings.printers.discover_added_button");});
        aab.style.display="none";
        await saveConfig();
      };
    } else { aab.style.display="none"; }
  }catch(e){
    const msg=/Unexpected token|not valid JSON|DOCTYPE/i.test(e.message)
      ? t("settings.printers.discover_needs_update") : e.message;
    w.innerHTML='<div class="discrow"><span class="di" style="color:var(--bad)">'+esc(t("settings.printers.discover_scan_failed",{message:msg}))+'</span></div>';
  }
}
let FLEET_TIMER=null;
// Metadata (temps/progress/status) always refreshes at the normal, fast
// fleet refresh interval — including in camera view, so switching views
// never slows down anything but the camera image itself. The camera <img>
// src is still recomputed on every one of these ticks (see camBust in
// renderFleet()), but that no longer means hammering real camera hardware:
// the server throttles the actual per-printer fetch to
// CFG.cameraViewRefreshInterval and serves a short-lived cached frame for
// any request inside that window (see getSnapshotThrottled() in server.js).
function startFleetRefresh(){
  if(FLEET_TIMER) clearInterval(FLEET_TIMER);
  const ms=(parseInt($("setRefresh").value,10)||2)*1000;
  FLEET_TIMER=setInterval(()=>{ if(document.hidden||PUSHES>0||FLEET_DRAGGING||FLEET_DRAG_SAVING) return; const a=document.activeElement; if(a&&a.closest&&a.closest("#fleet")&&(a.tagName==="SELECT"||a.tagName==="INPUT")) return; loadFleet(); },ms);
}
// Mirrors save status to both the shared #cfgStatus (still used by every
// not-yet-reworked tab) and General's own dirty-bar status, when present —
// General hides the shared Save row entirely, so it needs its own visible
// feedback for the exact same saveConfig() call.
function setSaveStatus(cls,text){
  ["cfgStatus","generalSaveStatus","notifSaveStatus"].forEach(id=>{
    const el=$(id);
    if(el){ el.className="pstatus"+(cls?" "+cls:""); el.textContent=text; }
  });
}
async function saveConfig(){
  // A load failure means everything currently shown (printers included) came
  // from defaults, not from disk — the original is only safe as long as
  // nothing overwrites it. Same confirm() pattern showSetTab() already uses
  // for discard-unsaved-changes, not a new modal mechanism.
  if(CONFIG_LOAD_FAILED){
    // Two complete, independent sentences rather than a shared template with
    // an injected {recoveryNote} fragment — full context in one translated
    // string, nothing for a translator to reassemble.
    const confirmMsg=CONFIG_LOAD_QUARANTINE_PATH
      ? t("global.config_load_warning.save_confirm_quarantined",{path:CONFIG_LOAD_QUARANTINE_PATH})
      : t("global.config_load_warning.save_confirm_not_quarantined");
    if(!confirm(confirmMsg)) return;
  }
  const saveBtn=$("saveCfg");
  if(saveBtn) saveBtn.disabled=true;
  setSaveStatus("work",t("settings.dirty_bar.saving"));
  // Refuse to send usersEnabled:true until the inline bootstrap-admin form
  // has succeeded — no default/throwaway admin is ever created as a fallback.
  if($("setUsersEnabled").checked && $("bootstrapAdmin").style.display!=="none" && !BOOTSTRAPPED_ADMIN){
    setSaveStatus("err",t("settings.dirty_bar.admin_required_before_users"));
    if(saveBtn) saveBtn.disabled=false;
    return;
  }
  // auto-fill empty name/serial from printer before saving
  const prows=[...$("setPrinters").querySelectorAll(".prow")];
  // An address is required by every connector that talks to real hardware.
  // Without one the server drops the printer from the saved list silently,
  // which reads as "Save did nothing" — so a row that names a printer but
  // has no usable address stops the save and says so. A row with nothing in
  // it at all (Add printer, then second thoughts) is still dropped quietly.
  const badAddr=prows.find(r=>{
    if(!connectorAddress(r.querySelector(".pconnector").value).required) return false;
    const ip=r.querySelector(".pip").value.trim();
    if(!ip) return !!r.querySelector(".pname").value.trim();
    return !isValidHostValue(ip);
  });
  if(badAddr){
    const bname=badAddr.querySelector(".pname").value.trim()||t("settings.printers.new_printer_default");
    setSaveStatus("err",t("settings.printers.save_error_missing_ip",{name:bname}));
    if(saveBtn) saveBtn.disabled=false;
    badAddr.querySelector(".prow-details").open=true;
    badAddr.querySelector(".pip").focus();
    return;
  }
  const needProbe=prows.filter(r=>{
    const url=rowAddressUrl(r);
    const noName=!r.querySelector(".pname").value.trim();
    const noSerial=!r.querySelector(".pserial").value.trim();
    return url&&(noName||noSerial);
  });
  if(needProbe.length){
    setSaveStatus("work",t("settings.dirty_bar.probing_printers"));
    await Promise.all(needProbe.map(async r=>{
      const url=rowAddressUrl(r);
      try{
        const d=await getJSON("/api/probe-printer?url="+encodeURIComponent(url));
        const nameEl=r.querySelector(".pname"), serialEl=r.querySelector(".pserial");
        if(!nameEl.value.trim()&&d.name) nameEl.value=d.name;
        if(!serialEl.value.trim()&&d.serial) serialEl.value=d.serial;
      }catch{}
    }));
    setSaveStatus("work",t("settings.dirty_bar.saving"));
  }
  const ri=parseInt($("setRefresh").value,10);
  const cr=parseInt($("setCameraRefresh").value,10);
  const fc=parseFloat($("setFilamentCost").value)||0;
  const er=parseFloat($("setElectricityRate").value)||0;
  const useTNotation=$("setTNotation").checked; USE_T_NOTATION=useTNotation;
  ALLOW_MAPPING=$("setAllowMapping").checked; SUGGEST_MATCHING=$("setSuggestMatching").checked;
  CAM_STAGGER=$("setCameraStagger").checked;
  ALT_DISPLAY=$("setAltDisplay").value;
  CURRENCY=$("setCurrency").value.trim()||"$";
  const logsRetentionDays=parseInt($("setLogsRetentionDays").value,10);
  const cameraRetentionDays=parseInt($("setCameraRetentionDays").value,10);
  const gcodeSyncRetentionDays=parseInt($("setGcodeSyncRetentionDays").value,10);
  const body={ gcodeFolder:$("setFolder").value.trim(), firmwareFolder:$("setFirmwareFolder").value.trim(), logsFolder:$("setLogsFolder").value.trim(), cameraFolder:$("setCameraFolder").value.trim(), gcodeSyncFolder:$("setGcodeSyncFolder").value.trim(), logsRetentionDays:logsRetentionDays>0?logsRetentionDays:undefined, cameraRetentionDays:cameraRetentionDays>0?cameraRetentionDays:undefined, gcodeSyncRetentionDays:gcodeSyncRetentionDays>0?gcodeSyncRetentionDays:undefined, refreshInterval:(ri>=1&&ri<=60)?ri:2, cameraViewRefreshInterval:(cr>=3&&cr<=60)?cr:6, cameraViewStagger:CAM_STAGGER, alternateDisplay:ALT_DISPLAY, currency:CURRENCY, filamentCost:fc>0?fc:undefined, electricityRate:er>0?er:undefined, tNotation:useTNotation||undefined, defaultView:$("setDefaultView").value, siteName:$("setSiteName").value.trim(), allowMapping:ALLOW_MAPPING, suggestMatching:SUGGEST_MATCHING, locale:$("setLocale")?$("setLocale").value:undefined,
    usersEnabled:$("setUsersEnabled").checked||undefined,
    resend:{ apiKey:$("setResendKey").value.trim(), fromAddress:$("setResendFrom").value.trim() },
    otp:{
      service: otpServiceValue(),
      ntfyTopic: $("otpNtfyTopic").value.trim(),
      telegramChatId: $("otpTelegramChatId").value.trim()
    },
    notifications:{
      enabled:$("ntfEnabled").checked,
      onStart:$("ntfEvStart").checked,
      onPause:$("ntfEvPause").checked,
      onError:$("ntfEvError").checked,
      onComplete:$("ntfEvComplete").checked,
      onIntervals:$("ntfMilestones").checked,
      milestonePercents:[...NTF_MILESTONES],
      includeImage:$("ntfImage").checked,
      ntfyEnabled:$("ntfyEnabled").checked,
      telegramEnabled:$("telegramEnabled").checked,
      ntfyTopic:$("ntfTopic").value.trim(),
      telegramChatId:$("ntfChatId").value.trim(),
      telegramBotToken:secretFieldValue($("ntfBotTokenField")),
      webhookEnabled:$("webhookEnabled").checked,
      webhookFormat:$("ntfWebhookFormat").value,
      webhookUrl:secretFieldValue($("ntfWebhookUrlField"))
    },
    printers:gatherPrinters() };
  try{
    const c=await (await postJSON("/api/config",body)).json();
    if(c.error) throw new Error(c.error);
    // The response already reflects server.js's post-save loadConfig() reload

    // (a real re-read of the just-written, definitely-valid file, not an
    // optimistic client-side assumption) — re-render so the warning banner
    // actually clears, matching what its own text claims.
    renderConfigLoadWarning(c);
    SYSTEM_DEFAULT_LOCALE=c.locale||"en";
    // Per-user override is a separate self-service call — same
    // saveUserLocalePreference() the compact topbar picker calls
    // immediately on change, just deferred to here (Save) for this tab.
    // Only sent when it actually changed.
    if($("setUserLocale")){
      const nextUserLocale=$("setUserLocale").value||null;
      if(nextUserLocale!==(CURRENT_USER&&CURRENT_USER.locale||null)) await saveUserLocalePreference(nextUserLocale);
      await applyAccountLocale(USERS_ENABLED?CURRENT_USER:null);
      await populateLocaleSelectors();
    }
    // A brand-new printer's row has no id yet at save time (gatherPrinters()
    // sends id:undefined for it, matched server-side by URL) — the response
    // carries the real assigned id back, but nothing previously wrote it onto
    // the row or into PRINTERS_CFG. Any self-saving per-row control that
    // gates on row.dataset.printerId (Printer Pool assignment chief among
    // them) kept claiming the printer still needed saving even immediately
    // after a successful save. Patch both from this response, matched by
    // URL for rows still missing an id.
    (c.printers||[]).forEach(cp=>{
      const idx=PRINTERS_CFG.findIndex(p=>p.id===cp.id);
      if(idx===-1) PRINTERS_CFG.push(cp); else PRINTERS_CFG[idx]=cp;
    });
    prows.forEach(r=>{
      if(r.dataset.printerId) return;
      const url=rowAddressUrl(r)||r.dataset.url;
      const matched=(c.printers||[]).find(p=>p.url===url);
      if(matched) r.dataset.printerId=matched.id;
    });
    setSaveStatus("ok",t("settings.dirty_bar.saved"));
    $("setupmsg").textContent="";
    if($("topbarSiteName")){ const sn=(c.siteName||"").trim(); $("topbarSiteName").textContent=sn; $("topbarSiteName").style.display=sn?"":"none"; }
    FILAMENT_COST=fc>0?fc:0; ELECTRICITY_RATE=er>0?er:0;
    updateCurrencyLabels();
    if(MAP) renderJob(); // refresh cost line immediately
    // Flipping usersEnabled on/off takes effect on THIS tab immediately: going
    // on with no session yet prompts login as the admin just created; going
    // off drops straight back to the fully-open UI, no reload needed either way.
    USERS_ENABLED=!!c.usersEnabled;
    if(USERS_ENABLED && !CURRENT_USER){ applyRoleUI(); showLoginOverlay(); }
    else applyRoleUI();
    applyViewMode(); // refresh the header button's icon/title if Alternate Display just changed
    loadFiles(); loadFleet(); startFleetRefresh();
    // The Health page reads the same interval, so a changed value has to
    // re-arm that timer too — it caches the interval when it starts.
    if(HEALTH_PRINTER_ID!=null) startHealthAutoRefresh();
    baselinePrintersDirty(); // current row values are now what's on file — re-baseline the dirty footer
    collapseAllPrinterRows(); // nothing left to edit in them — back to the compact list
    baselineSettingsTab("general");
    baselineSettingsTab("notif");
  }catch(e){ setSaveStatus("err",e.message); }
  finally{ if(saveBtn) saveBtn.disabled=false; }
}

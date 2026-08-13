

function lookupKlipperError(code, msg){
  if(!code&&!msg) return null;
  const entry=code?ERROR_CODES[code]:null;
  return{code, title:entry?entry.t:(code||'Unknown Error'), description:entry?entry.d:(msg||code||''), url:entry?entry.u:''};
}
const $ = id => document.getElementById(id);
const VERSION = "0.5.0";
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
const PRINT_OPT_DEFS = [
  { key: "flowCalibrate", cap: "flowCalibration", label: "Flow Calibration" },
  { key: "timelapse", cap: "timelapse", label: "Time-Lapse" },
  { key: "autoLevel", cap: "autoLevel", label: "Auto-Leveling" }
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
      `<span class="switch-text"><span class="switch-label">${esc(o.label)}</span></span>`+
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
  if(!PRINTER_POOLS.length) return `<option value="">No pools yet</option>`;
  return `<option value="">— none —</option>`+PRINTER_POOLS.map(p=>`<option value="${esc(p.id)}" ${p.id===selectedId?"selected":""}>${esc(p.name)}</option>`).join("");
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

function renderQueueStoreWarning(){
  const card=$("queueStoreWarningCard"), box=$("queueStoreWarning");
  if(!card||!box) return;
  const s=QUEUE_STORE_STATUS;
  if(!QUEUE_MANAGEMENT_ENABLED || (!s.storeDegraded && !s.storeStoppedByAdmin && !s.queueStoreRecoveryRequired)){
    card.style.display="none"; return;
  }
  card.style.display="";
  if(s.queueStoreRecoveryRequired){
    box.innerHTML=`<div class="settings-warning-title">Queue data could not be recovered</div>`+
      `<div>Both the queue state file and its backup were unreadable. All queue automation is paused, and the damaged files have been kept for inspection rather than discarded. This can't be undone — resetting starts every printer's queue empty.</div>`+
      `<div style="margin-top:10px;display:flex;gap:8px;align-items:center">`+
      `<input class="field" id="queueResetConfirm" placeholder='Type RESET to confirm' style="max-width:200px">`+
      `<button class="btn ghost danger" id="queueAckResetBtn">Reset Queue Data</button>`+
      `<span class="pstatus" id="queueAckResetStatus"></span>`+
      `</div>`;
    $("queueAckResetBtn").addEventListener("click",async()=>{
      const st=$("queueAckResetStatus");
      st.className="pstatus work"; st.textContent="Resetting…";
      try{
        const r=checkAuthFailure(await postJSON("/api/queue-store/acknowledge-reset",{confirm:$("queueResetConfirm").value}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
        await loadQueueManagementUI();
      }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
    });
    return;
  }
  const parts=[];
  if(s.storeDegraded) parts.push(`<div>Queue state is not currently durable — automatic retry in progress.</div>`);
  if(s.storeStoppedByAdmin) parts.push(`<div>Queue automation was manually stopped for every printer.</div>`);
  box.innerHTML=`<div class="settings-warning-title">Queue Management needs attention</div>`+parts.join("")+
    `<div style="margin-top:10px;display:flex;gap:8px">`+
    (s.storeDegraded?`<button class="btn ghost" id="queueRetrySaveBtn">Retry Save</button>`:"")+
    (s.storeStoppedByAdmin?`<button class="btn ghost" id="queueResumeAllBtn">Resume All Queues</button>`:`<button class="btn ghost" id="queueStopAllBtn">Stop All Queues</button>`)+
    `<span class="pstatus" id="queueStoreActionStatus"></span>`+
    `</div>`;
  if($("queueRetrySaveBtn")) $("queueRetrySaveBtn").addEventListener("click",()=>queueStoreAction("/api/queue-store/retry-save"));
  if($("queueResumeAllBtn")) $("queueResumeAllBtn").addEventListener("click",()=>queueStoreAction("/api/queue-store/resume-all"));
  if($("queueStopAllBtn")) $("queueStopAllBtn").addEventListener("click",()=>queueStoreAction("/api/queue-store/stop-all"));
}
async function queueStoreAction(url){
  const st=$("queueStoreActionStatus");
  if(st){ st.className="pstatus work"; st.textContent="Working…"; }
  try{
    const r=checkAuthFailure(await postJSON(url,{}));
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    await loadQueueManagementUI();
  }catch(e){ if(st){ st.className="pstatus err"; st.textContent=e.message; } }
}

function renderPrinterPoolsList(){
  const list=$("printerPoolsList");
  if(!list) return;
  list.innerHTML=PRINTER_POOLS.map(p=>{
    const isDefault=p.isDefault;
    return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px" data-printerpool="${esc(p.id)}">`+
      `<input class="field printerpool-rename" value="${esc(p.name)}" maxlength="40" ${isDefault?"disabled":""} style="flex:1">`+
      `<span class="pi-lbl" style="flex:none">${esc(p.type)}</span>`+
      (isDefault?"":`<button type="button" class="btn ghost printerpool-delete" title="Delete pool">×</button>`)+
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
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
        await loadQueueManagementUI();
      }catch(e){ alert(e.message); inp.value=orig; }
    });
  });
  list.querySelectorAll(".printerpool-delete").forEach(btn=>{
    btn.addEventListener("click",async()=>{
      const id=btn.closest("[data-printerpool]").dataset.printerpool;
      const p=PRINTER_POOLS.find(x=>x.id===id);
      if(!confirm('Delete pool "'+(p?p.name:"")+'"? Printers must be reassigned first if any are still using it.')) return;
      try{
        const r=checkAuthFailure(await fetch("/api/printer-pools/"+id,{method:"DELETE"}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
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

function applyFileSortUI(){
  Object.keys(FILE_SORT_LABELS).forEach(k=>{
    const el = $('fsc-'+k);
    if(el) el.textContent = FILE_SORT === k ? '✓' : '';
  });
  $('fileSortBtn').title = 'Sort: ' + (FILE_SORT_LABELS[FILE_SORT] || 'Newest');
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
function statusColorText(p){
  if(!p.online) return { statusColor:"var(--ink-faint)", statusTxt:"Offline" };
  if(p.state==="printing") return { statusColor:"var(--busy)", statusTxt:"Printing" };
  if(p.state==="paused") return { statusColor:"var(--paused)", statusTxt:"Paused" };
  if(p.state==="error") return { statusColor:"var(--bad)", statusTxt:"Error" };
  if(p.state==="maintenance") return { statusColor:"var(--violet-soft)", statusTxt:"Maintenance" };
  // A file sitting on the printer ready to print is more useful to see at a
  // glance than "Idle"/"Complete"/"Cancelled" — takes priority over those
  // (but not over Printing/Paused/Error/Maintenance, which are more urgent).
  if(p.queuedFile&&p.queuedFile.status==='ready') return { statusColor:"var(--signal)", statusTxt:"Loaded" };
  if(p.state==="complete") return { statusColor:"var(--complete)", statusTxt:"Complete" };
  if(p.state==="cancelled") return { statusColor:"var(--bad)", statusTxt:"Cancelled" };
  return { statusColor:"var(--ok)", statusTxt:"Idle" };
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
function camShotPlaceholderEl(text, onRetry){
  const div=document.createElement("div");
  div.className="cam-shot-placeholder"+(onRetry?" cam-shot-retryable":"");
  div.innerHTML=`<img class="cam-shot-placeholder-icon" src="/camera-disabled.svg" alt=""><span>${esc(text)}</span>`;
  if(onRetry){ div.title="Click to try again"; div.addEventListener("click", onRetry); }
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
  const ph=camShotPlaceholderEl("No Feed", ()=>retryCamShot(id));
  if(cached && cached.el && cached.el.parentNode) cached.el.parentNode.replaceChild(ph, cached.el);
  CAM_SHOT_CACHE.set(id, { el:ph, nextDueAt:Infinity, dead:true, refreshing:false });
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
      if(!p.online || p.state !== 'printing' || !p.progress || p.progress <= 0) return Infinity;
      return p.elapsed * (1 / p.progress - 1);
    };
    arr.sort((a,b) => rem(a) - rem(b));
  } else if(SORT_MODE === 'name'){
    // numeric:true so "U1-2" sorts before "U1-10" instead of lexicographically after it.
    arr.sort((a,b)=>(a.name||'').localeCompare(b.name||'', undefined, {numeric:true, sensitivity:'base'}));
  }
  return arr;
}

function applySortUI(){
  ['none','status','time','name'].forEach(k=>{
    const el = $('sc-'+k);
    if(el) el.textContent = SORT_MODE === k ? '✓' : '';
  });
  const btn = $('sortBtn');
  if(btn){
    const labels = { none:'none', status:'by status', time:'by time remaining', name:'by name' };
    btn.title = 'Sort printers: ' + (labels[SORT_MODE] || 'none');
  }
}

// ---- File list toggle (hidden by default) ----
let FILES_OPEN = false;
function applyFilesOpen(){
  document.body.classList.toggle('showfiles', FILES_OPEN);
  const b = $('filesBtn');
  if(b){ b.title = FILES_OPEN ? 'Hide file list' : 'Show file list'; }
  // "Selected Model" is picked FROM the file list, so it only makes sense to
  // show while that list is open — closing it hides the summary too, even
  // though the selection itself is remembered (reopening brings it right
  // back, no need to reselect). Orca mode already hides this permanently.
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
const VIEW_TITLE = { regular:'Switch to full view', compact:'Switch to compact view', camera:'Switch to camera view', list:'Switch to list view', printfarm:'Switch to Print Farm view' };
// Extracted from applyViewMode() so the printfarm path (which bypasses the
// body-class logic below — see cycleViewMode()) can still keep the header
// button's icon/title showing the correct next mode.
function syncViewModeButtonIcon(){
  const btn=$('compactBtn');
  if(btn){
    const next=nextViewMode();
    btn.querySelector('img').src=VIEW_ICON[next]; btn.title=VIEW_TITLE[next];
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
function updateTopbarViewLabel(){
  const el=$("topbarViewLabel");
  if(!el) return;
  const label=({camera:"Camera View", compact:"Compact View", list:"List View", printfarm:"Print Farm View"})[VIEW_MODE]||"";
  el.textContent=label?"("+label+")":"";
}
function applyViewMode(){
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
function showLoginOverlay(){
  if(LOGIN_PENDING) return LOGIN_PENDING;
  $("loginOverlay").style.display="flex";
  $("loginStep1").style.display="";
  $("loginStep2").style.display="none";
  $("loginPassword").value="";
  $("loginStatus").textContent="";
  LOGIN_PENDING=new Promise(resolve=>{ LOGIN_RESOLVE=resolve; });
  return LOGIN_PENDING;
}
function hideLoginOverlay(){
  $("loginOverlay").style.display="none";
  LOGIN_PENDING=null;
}
function onLoginSuccess(user){
  CURRENT_USER=user;
  LAST_LOGIN_AT=Date.now();
  hideLoginOverlay();
  if(LOGIN_RESOLVE){ const r=LOGIN_RESOLVE; LOGIN_RESOLVE=null; r(); }
  applyRoleUI();
  loadConfigUI(); loadFiles(); loadFleet();
}
async function doLoginPassword(){
  const loginName=$("loginName").value.trim(), password=$("loginPassword").value;
  const st=$("loginStatus");
  if(!loginName||!password){ st.className="pstatus err"; st.textContent="Enter a login name and password"; return; }
  const btn=$("loginSubmit"); btn.disabled=true;
  st.className="pstatus work"; st.textContent="Logging in…";
  try{
    const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName,password})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    onLoginSuccess(d.user);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}
async function doRequestOtp(){
  const loginName=$("loginName").value.trim();
  const st=$("loginStatus");
  if(!loginName){ st.className="pstatus err"; st.textContent="Enter your login name first"; return; }
  const btn=$("loginOtpBtn"); btn.disabled=true;
  st.className="pstatus work"; st.textContent="Sending code…";
  try{
    const r=await fetch("/api/login/otp/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
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
  if(!code){ st.className="pstatus err"; st.textContent="Enter the code"; return; }
  const btn=$("otpSubmit"); btn.disabled=true;
  st.className="pstatus work"; st.textContent="Verifying…";
  try{
    const r=await fetch("/api/login/otp/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName:OTP_LOGIN_NAME,code})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
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
}
async function authGate(){
  // One retry on network failure: giving up immediately would default
  // USERS_ENABLED to false and show a fully-open UI even though the server
  // still requires login, with every subsequent call silently 401ing.
  for(let attempt=0; attempt<2; attempt++){
    try{
      const s=await fetch("/api/session").then(r=>r.json());
      USERS_ENABLED=!!s.usersEnabled;
      if(USERS_ENABLED && s.authenticated) CURRENT_USER=s.user;
      break;
    }catch{
      if(attempt===0) await new Promise(r=>setTimeout(r,800));
      else USERS_ENABLED=false;
    }
  }
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
  if($("maintBtn")) $("maintBtn").disabled = !act;
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
  // hides it, same as maintBtn/bulkHeatBtn/filesBtn above.
  if($("healthBtn")) $("healthBtn").style.display = settingsOpen ? "none" : "";
  if(USERS_ENABLED && CURRENT_USER){
    // First name if set, else fall back to the login name.
    const uname=CURRENT_USER.firstName||CURRENT_USER.loginName;
    $("userBadge").style.display="flex";
    if($("logoutBtn")) $("logoutBtn").title="Logout "+uname;
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
  await checkVersion(); await loadConfigUI(); await loadFiles(); await initialFleetLoad();
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
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ loadFiles(); loadFleet(); } });
}

// Modal boilerplate: any listed button, or a click on the backdrop, closes it.
function wireModal(modalId, closeFn, buttonIds){
  buttonIds.forEach(id=>$(id).addEventListener("click", closeFn));
  $(modalId).addEventListener("click", e=>{ if(e.target===$(modalId)) closeFn(); });
}

// The icon always shows the CURRENT theme (sun = light is active, moon =
// dark is active); title/aria describe what clicking does, i.e. the switch
// TO the other theme — never the same word for both, so neither reads as
// stale after a click.
function syncThemeButton(){
  const light=document.documentElement.getAttribute("data-theme")==="light";
  $("themeBtnIcon").src=light?"/sun.svg":"/moon.svg";
  $("themeBtnIcon").alt=light?"Light theme":"Dark theme";
  $("themeBtn").title=light?"Switch to dark theme":"Switch to light theme";
  $("themeBtn").setAttribute("aria-pressed",light?"true":"false");
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
        if(result&&result.sRGBHex) setPendingColor(result.sRGBHex,"Custom");
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
  $("healthRefreshBtn").addEventListener("click", ()=>{ if(HEALTH_PRINTER_ID!=null) loadHealthData(); });
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
    if(!name){ st.className="pstatus err"; st.textContent="Enter a name"; return; }
    st.className="pstatus work"; st.textContent="Adding…";
    try{
      const r=await fetch("/api/groups",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      const kept=checkedGroupIds();
      await loadGroupsUI();
      $("newGroupName").value="";
      renderGroupsCheckList(kept);
      renderGroupsManageList();
      st.className="pstatus ok"; st.textContent="Added";
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
  $("maintBtn").addEventListener("click", openMaintReport);
  $("maintPrinterSel").addEventListener("change", ()=>loadMaintDetail(parseInt($("maintPrinterSel").value,10)));
  $("maintSave").addEventListener("click", saveMaintenance);
  $("maintOfflineToggle").addEventListener("change", toggleMaintenanceMode);
  $("maintDate").addEventListener("change", updateNextScheduledPreview);
  $("maintFrequency").addEventListener("change", updateNextScheduledPreview);
  $("maintComponentFilter").addEventListener("input", onMaintComponentChange);
  wireModal("browsemodal", closeBrowse, ["browsex","browsecancel"]);
  wireModal("elecmodal", closeElecModal, ["elecmodalx","elecmodalcancel"]);
  wireModal("sendmodal", closeSendModal, ["sendmodalx","sendmodalcancel"]);
  wireModal("pfilemodal", closePrinterFiles, ["pfilex","pfilecancel"]);
  $("pfilego").addEventListener("click", doPrintFile);
  $("pfileSearch").addEventListener("input", renderPfileList);

  $("snaprefresh").addEventListener("click", loadSnapshot);
  $("browseBtn").addEventListener("click", ()=>openBrowse("setFolder"));
  $("browseLogsBtn").addEventListener("click", ()=>openBrowse("setLogsFolder"));
  $("browseCameraBtn").addEventListener("click", ()=>openBrowse("setCameraFolder"));
  $("browseGcodeSyncBtn").addEventListener("click", ()=>openBrowse("setGcodeSyncFolder"));
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
    if($("ntfTopic").value.trim() && !confirm("Regenerate the ntfy topic? Anyone already subscribed to the current one will stop receiving notifications.")) return;
    $("ntfTopic").value=genRandomTopic();
    updateSettingsDirtyBar("notif"); // programmatic value change — no native input/change event to catch it
  });
  $("ntfTopicCopy").addEventListener("click", async ()=>{
    const v=$("ntfTopic").value.trim();
    if(!v) return;
    try{
      await navigator.clipboard.writeText(v);
      const b=$("ntfTopicCopy"), old=b.textContent;
      b.textContent="Copied"; setTimeout(()=>{ b.textContent=old; },1200);
    }catch{}
  });
  wireSecretField($("ntfBotTokenField"));
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
  $("ntfTestNtfy").addEventListener("click", ()=>sendProviderTest("ntfy","ntfTestNtfy","ntfTestNtfyStatus"));
  $("ntfTestTelegram").addEventListener("click", ()=>sendProviderTest("telegram","ntfTestTelegram","ntfTestTelegramStatus"));
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
    if(!days||days<1){ st.className="pstatus err"; st.textContent="Enter a positive number of days"; return; }
    st.className="pstatus work"; st.textContent="Saving…";
    try{
      const r=checkAuthFailure(await postJSON("/api/config",{auditRetentionDays:days}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      st.className="pstatus ok"; st.textContent="Saved";
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
    if(!name){ st.className="pstatus err"; st.textContent="Enter a name"; return; }
    st.className="pstatus work"; st.textContent="Adding…";
    try{
      const r=checkAuthFailure(await postJSON("/api/printer-pools",{name}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      $("newPrinterPoolName").value="";
      st.className="pstatus ok"; st.textContent="Added";
      await loadQueueManagementUI();
    }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  });

  $("fwGet").addEventListener("click", loadFirmware);
  $("fwSelect").addEventListener("click", ()=>{ const st=$("fwStatus"); st.className="pstatus"; st.textContent="Select Firmware — not implemented yet"; });
  $("fwDeploy").addEventListener("click", ()=>{ const st=$("fwStatus"); st.className="pstatus"; st.textContent="Deploy Firmware — not implemented yet"; });


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
      c.checked=!!(row&&row.online&&row.state==="idle");
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
  }catch(e){ $("folderline").textContent="Server unreachable"; }
}
function fmtSize(b){ return b>1048576 ? (b/1048576).toFixed(1)+" MB" : Math.max(1,Math.round(b/1024))+" KB"; }
function fmtTime(ms){ const d=new Date(ms), df=(Date.now()-ms)/1000;
  if(df<60)return"just now"; if(df<3600)return Math.floor(df/60)+"m ago"; if(df<86400)return Math.floor(df/3600)+"h ago";
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
    return (Array.isArray(ranges[0])?ranges:[ ranges]).some(r=>hue>=r[0]&&hue<=r[1]);
  });
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
  if(ok) return `<span class="tag-color-swatch" style="background:${esc(ok.color)}" title="${esc(ok.tag)} → ${esc(ok.color)}"></span>`;
  const bad=resolved[0];
  return `<span class="tag-color-swatch invalid" title="${esc(bad.tag)} doesn't resolve to a color — it won't tint the card">!</span>`;
}

function renderList(){
  const list=$("list");
  list.innerHTML="";
  if(SEARCH_RESULTS!==null){ renderSearchResults(); return; }
  if(CURRENT_SUB){
    const back=document.createElement("button"); back.className="folder-back";
    back.innerHTML="← Back";
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
  if(!FOLDERS.length&&!shown.length&&!CURRENT_SUB){ list.innerHTML='<div class="empty-list">No sliced files here yet.</div>'; return; }
  if(!shown.length){ const m=document.createElement("div"); m.className="empty-list"; m.textContent="No sliced files in this folder."; list.appendChild(m); return; }
  const shownPaths=shown.map(f=>CURRENT_SUB?CURRENT_SUB+"/"+f.name:f.name);
  shown.forEach((f,i)=>{
    const filePath=shownPaths[i];
    const b=document.createElement("div");
    b.className="job"+(SELECTED===filePath?" active":"")+(SELECTED_FILES.has(filePath)?" multi-selected":"");
    b.draggable=true; b.dataset.file=filePath;
    b.tabIndex=0; b.setAttribute("role","button");
    const fsBadge=(SELECTED===filePath&&MAP&&MAP.isFS)?` <img src="/fs-badge.svg" class="fs-badge" title="Full Spectrum">`:``;
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
  if(!shown.length){ list.innerHTML='<div class="empty-list">No sliced files match your search.</div>'; return; }
  shown.forEach(f=>{
    const filePath=f.sub?f.sub+"/"+f.name:f.name;
    const b=document.createElement("button"); b.className="job"+(SELECTED===filePath?" active":"");
    const fsBadge=(SELECTED===filePath&&MAP&&MAP.isFS)?` <img src="/fs-badge.svg" class="fs-badge" title="Full Spectrum">`:``;
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
    $("multiselectCount").textContent=n+(n===1?" file":" files")+" selected";
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
    : `<option value="">No pools yet — add one in Settings</option>`;
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
  if(!printers.length){ box.innerHTML=`<div class="settings-help">No printers are assigned to this pool yet.</div>`; return; }
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
  if(!poolId){ st.className="pstatus err"; st.textContent="Choose a Printer Pool"; return; }
  if(!SEND_QUEUE_ITEMS.length){ st.className="pstatus err"; st.textContent="No files selected"; return; }
  const modeInput=document.querySelector('input[name="sendQueueMode"]:checked');
  const mode=modeInput?modeInput.value:"print-on-all";
  st.className="pstatus work"; st.textContent="Sending…";
  try{
    const r=checkAuthFailure(await postJSON("/api/queue/send",{
      files: SEND_QUEUE_ITEMS.map(it=>({name:it.name, sub:it.sub, quantity:it.quantity})),
      poolId, mode, startImmediately
    }));
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
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
const QUEUE_ATTENTION_RESOLUTIONS={
  "print-failed": [["resume","Resume"],["retry","Retry Job"],["skip","Skip Job"],["stop","Stop Queue"]],
  "dispatch-failed": [["retry","Retry Job"],["skip","Skip Job"],["stop","Stop Queue"]],
  "bed-clear-failed": [["retry-bed-clear","Retry Bed-Clear"],["skip-bed-clear","Skip Bed-Clear & Proceed"],["stop","Stop Queue"]],
  "file-missing": [["skip","Skip Job"],["stop","Stop Queue"]],
  "file-changed": [["accept-file-change","Use Current File"],["skip","Skip Job"],["stop","Stop Queue"]],
  "pool-invalid": [["stop","Stop Queue"]],
  "recovery-mismatch": [["acknowledge","Acknowledge & Resume"],["stop","Stop Queue"]],
  "recovery-interrupted": [["retry","Retry Job"],["skip","Skip Job"],["stop","Stop Queue"]],
  "recovery-unknown-outcome": [["resume","Resume"],["retry","Retry Job"],["skip","Skip Job"],["stop","Stop Queue"]]
};
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
  $("queueBtn").title="Back to Fleet";
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
  $("queueBtn").title="Queue Management";
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
let HEALTH_LAST_LOADED_AT=null, HEALTH_UPDATED_TICK_TIMER=null;

function openHealthPage(printerId){
  closeQueueDashboard();
  $("healthPage").classList.add("show");
  document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="none");
  $("healthBtn").title="Back to Fleet";
  let id=printerId;
  if(id==null){
    const attn=FLEET.find(p=>p.needsAttention);
    id=attn?attn.id:(FLEET[0]?FLEET[0].id:null);
  }
  selectHealthPrinter(id);
  // Purely a local "Ns ago" text tick — no network call, so this doesn't
  // reintroduce the auto-polling this page deliberately avoids.
  if(!HEALTH_UPDATED_TICK_TIMER) HEALTH_UPDATED_TICK_TIMER=setInterval(updateHealthUpdatedAgo,5000);
}
function closeHealthPage(){
  if(!$("healthPage").classList.contains("show")) return;
  $("healthPage").classList.remove("show");
  document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="");
  $("healthBtn").title="Printer health";
  HEALTH_PRINTER_ID=null; HEALTH_DATA=null; HEALTH_MAINT=null; HEALTH_LAST_LOADED_AT=null;
  if(HEALTH_UPDATED_TICK_TIMER){ clearInterval(HEALTH_UPDATED_TICK_TIMER); HEALTH_UPDATED_TICK_TIMER=null; }
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
  if(!FLEET.length){ wrap.innerHTML=`<span class="settings-help">No printers configured.</span>`; return; }
  wrap.innerHTML=FLEET.map(p=>{
    const {statusColor}=statusColorText(p);
    const active=p.id===HEALTH_PRINTER_ID;
    // Rich cached result (if this printer's Health page has been opened
    // this session) wins over the cheap fleet-wide flag — see
    // HEALTH_ATTENTION_CACHE's own comment for why this never adds a fetch.
    const needsAttention=HEALTH_ATTENTION_CACHE[p.id]!==undefined?HEALTH_ATTENTION_CACHE[p.id]:!!p.needsAttention;
    return `<button type="button" class="health-chip${active?" active":""}" data-healthchip="${p.id}" style="--status-color:${statusColor}" title="${esc(p.name)}${needsAttention?" — needs attention":""}">`+
      `<span class="health-chip-dot"></span><span class="health-chip-name">${esc(p.name)}</span>`+
      (needsAttention?`<span class="health-chip-attn" aria-hidden="true"></span>`:"")+
    `</button>`;
  }).join("");
  wrap.querySelectorAll("[data-healthchip]").forEach(b=>{
    b.addEventListener("click",()=>selectHealthPrinter(parseInt(b.dataset.healthchip,10)));
  });
}

async function loadHealthData(){
  const pid=HEALTH_PRINTER_ID;
  if(pid==null){ HEALTH_DATA=null; HEALTH_MAINT=null; renderHealthBody(); return; }
  const token=++HEALTH_REQ_TOKEN;
  HEALTH_DATA=null; HEALTH_MAINT=null;
  renderHealthBody();
  let health, maint;
  try{ health=await (await fetch("/api/health?printer="+pid)).json(); }
  catch(e){ health={ skipped:true, reason:"Could not reach SnapCon: "+e.message }; }
  try{ maint=await (await fetch("/api/maintenance?printer="+pid)).json(); }
  catch(e){ maint=null; }
  if(token!==HEALTH_REQ_TOKEN||pid!==HEALTH_PRINTER_ID) return; // superseded by a newer switch/refresh
  HEALTH_DATA=health; HEALTH_MAINT=maint;
  HEALTH_LAST_LOADED_AT=Date.now();
  if(!health.skipped) HEALTH_ATTENTION_CACHE[pid]=!!health.needsAttention;
  renderHealthBody();
  updateHealthUpdatedAgo();
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
// Purely local text — recomputes "Ns/Nm ago" from the already-stored
// HEALTH_LAST_LOADED_AT, no network call. Also restates that this page
// never auto-refreshes, since "Updated Ns ago" alone could misread as "and
// climbing on its own".
function updateHealthUpdatedAgo(){
  const el=$("healthUpdatedAt");
  if(!el) return;
  if(HEALTH_LAST_LOADED_AT==null){ el.textContent=""; return; }
  const secs=Math.max(0,Math.round((Date.now()-HEALTH_LAST_LOADED_AT)/1000));
  const ago=secs<60?secs+"s ago":Math.round(secs/60)+"m ago";
  el.textContent=`Updated ${ago} · no auto-refresh`;
}

function fmtBytes(n){
  if(n==null||!isFinite(n)) return "—";
  const units=["B","KB","MB","GB","TB"];
  let v=Math.max(0,n), i=0;
  while(v>=1024&&i<units.length-1){ v/=1024; i++; }
  return (i===0?Math.round(v):v.toFixed(1))+" "+units[i];
}
function lastServiceText(maint){
  if(!maint||!maint.entries||!maint.entries.length) return "Never";
  return fmtMaintDate(maint.entries.reduce((a,b)=>(a.date>b.date?a:b)).date);
}
function renderAttentionList(d){
  const reasons=(d.attentionReasons||[]).slice().sort((a,b)=>(a.severity==="critical"?0:1)-(b.severity==="critical"?0:1));
  if(!reasons.length) return `<div class="health-card"><div class="health-card-hdr">Needs attention</div><p class="settings-help">Nothing needs attention right now.</p></div>`;
  return `<div class="health-card"><div class="health-card-hdr">Needs attention</div><div class="health-attn-list">`+
    reasons.map(r=>`<div class="health-attn-item ${esc(r.severity)}"><span class="health-attn-dot"></span><div class="health-attn-text"><div class="health-attn-title">${esc(r.title)}</div><div class="health-attn-detail">${esc(r.detail)}</div></div>`+
      (r.suggestedComponent?`<button type="button" class="btn ghost btn-sm" data-logfix="${esc(r.suggestedComponent)}">Log fix</button>`:"")+
    `</div>`).join("")+
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
// Toolheads card: compact rows, not the fleet card's big spool-icon lanes —
// this page shows several cards on one screen, so each row is head label
// (respecting the T-notation setting via the existing headLabel(), not a
// hardcoded T-prefix), a small color swatch, material, color name
// (nameForHex()), and state. Empty (loaded:false) is a hollow row, matching
// the empty-slot convention everywhere else; a loaded head with no reported
// hex is its own distinct "loaded, color unknown" state — not confused with
// empty, not guessing a color.
function renderToolheadRow(h,i,active,finished){
  const label=esc(headLabel(i));
  if(!h||!h.loaded){
    return `<div class="health-toolhead-row empty"><span class="health-toolhead-swatch empty"></span><span class="health-toolhead-label">${label}</span><span class="health-toolhead-material">Empty</span><span class="health-toolhead-state"></span></div>`;
  }
  const hex=h.hex||null;
  const colorName=hex?nameForHex(hex):"";
  const material=h.material&&h.material!=="—"?h.material:"Unknown material";
  const state=active?(finished?"Last used":"Active"):"Loaded";
  return `<div class="health-toolhead-row${active?" active":""}">`+
    `<span class="health-toolhead-swatch${hex?"":" unknown"}" style="${hex?`background:${esc(hex)}`:""}" title="${hex?esc(hex):"No color reported"}"></span>`+
    `<span class="health-toolhead-label">${label}</span>`+
    `<span class="health-toolhead-material">${esc(material)}${colorName?" · "+esc(colorName):""}</span>`+
    `<span class="health-toolhead-state">${esc(state)}</span>`+
  `</div>`;
}
function renderToolheadsCard(p){
  if(!p||!p.capabilities?.filamentHeads) return "";
  const heads=p.heads||[];
  if(!heads.length) return "";
  const rows=heads.map((h,i)=>renderToolheadRow(h,i,h&&h.loaded&&p.activeExt===i,p.state==="complete")).join("");
  return `<div class="health-card"><div class="health-card-hdr">Toolheads</div>${rows}</div>`;
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
function mcuReading(m){
  const rate=(m.bytesWrite&&m.bytesRetransmit!=null)?(m.bytesRetransmit/m.bytesWrite*1000000):null;
  const rateState=stateFor(rate,MCU_RETRANSMIT_RATE_WARN,MCU_RETRANSMIT_RATE_CRIT);
  const invalidState=stateFor(m.bytesInvalid,MCU_INVALID_BYTES_WARN,MCU_INVALID_BYTES_CRIT);
  const taskState=stateFor(m.mcuTaskAvg,MCU_TASK_AVG_WARN,MCU_TASK_AVG_CRIT);
  return { rate, rateState, invalidState, taskState, worst:worstOf(rateState,invalidState,taskState) };
}
function renderControllerCard(d){
  const mcus=d.mcus;
  if(!mcus||!mcus.available) return `<div class="health-card"><div class="health-card-hdr">Controller link</div><p class="settings-help">Controller data unavailable${mcus&&mcus.reason?": "+esc(mcus.reason):""}.</p></div>`;
  if(!mcus.list.length) return "";
  const blocks=mcus.list.map(m=>{
    const r=mcuReading(m);
    const rateTxt=r.rate!=null?r.rate.toFixed(2)+" per 1M bytes":"—";
    const explain=r.worst!=="healthy"?(r.rateState!=="healthy"?"Rising retransmits usually indicate a cable, connector, or interference problem.":r.invalidState!=="healthy"?"Invalid bytes indicate corrupted communication, not just a retry — check the connection.":"The controller's main loop is taking longer than expected to process communication."):"";
    return `<div class="health-mcu-block">`+
      `<div class="health-mcu-hdr"><span class="health-mcu-dot ${r.worst}"></span><span class="health-mcu-name">${esc(mcuLabel(m.name))}</span></div>`+
      readingRow("Retransmits",rateTxt,r.rate!=null?r.rate/MCU_RETRANSMIT_RATE_CRIT*100:0,r.rateState)+
      readingRow("Invalid bytes",m.bytesInvalid??"—",m.bytesInvalid!=null?m.bytesInvalid/MCU_INVALID_BYTES_CRIT*100:0,r.invalidState)+
      readingRow("Task load",m.mcuTaskAvg!=null?(m.mcuTaskAvg*1000).toFixed(3)+" ms":"—",m.mcuTaskAvg!=null?m.mcuTaskAvg/MCU_TASK_AVG_CRIT*100:0,r.taskState)+
      (explain?`<div class="reading-note ${r.worst}">${esc(explain)}</div>`:"")+
      `<div class="health-diag-vals">retransmit ${m.bytesRetransmit??"—"} · invalid ${m.bytesInvalid??"—"} · bytes written ${m.bytesWrite??"—"} · srtt ${m.srtt??"—"} · rttvar ${m.rttvar??"—"} · freq ${m.freq??"—"} · task avg ${m.mcuTaskAvg??"—"} · task stddev ${m.mcuTaskStddev??"—"}</div>`+
    `</div>`;
  }).join("");
  return `<div class="health-card"><div class="health-card-hdr">Controller link</div>`+
    `<p class="health-card-desc">Communication health between the mainboard and each toolhead controller. Rising retransmits, invalid bytes, or task load usually mean a cable, connector, or interference problem.</p>`+
    blocks+
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
  if(!s||!s.available) return `<div class="health-card"><div class="health-card-hdr">System utilization</div><p class="settings-help">System data unavailable${s&&s.reason?": "+esc(s.reason):""}.</p></div>`;
  const rows=[];
  if(s.cpuTemp!=null){
    rows.push(readingRow("CPU temperature",Math.round(s.cpuTemp)+" °C",s.cpuTemp/CPU_TEMP_CRIT*100,stateFor(s.cpuTemp,CPU_TEMP_WARN,CPU_TEMP_CRIT)));
  }
  if(s.cpuUsage!=null){
    rows.push(readingRow("CPU usage",Math.round(s.cpuUsage)+"%",s.cpuUsage,stateFor(s.cpuUsage,CPU_USAGE_WARN,CPU_USAGE_CRIT)));
  }
  if(s.memory&&s.memory.total){
    const pct=s.memory.used/s.memory.total*100;
    rows.push(readingRow("Memory",Math.round(pct)+"% used",pct,stateFor(pct,MEM_USAGE_WARN,MEM_USAGE_CRIT)));
  }
  if(!rows.length) return "";
  return `<div class="health-card"><div class="health-card-hdr">System utilization</div>`+
    `<p class="health-card-desc">Host load on the machine running Klipper. Sustained high CPU or memory usage can cause dropped MCU communication or a sluggish web UI.</p>`+
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
  if(name==="heater_bed") return "Bed";
  const m=/^extruder(\d*)$/.exec(name);
  if(m) return toolheadNumber(m[1]===""?0:parseInt(m[1],10))+" hotend";
  return name;
}
// Fan names carry their toolhead index as an "eN" token wherever it
// appears (e.g. "heater_fan e0_nozzle_fan", "fan_generic e1_fan") — names
// with no eN token (cavity_fan, power_fan, the plain "fan", purifier's own
// fan) have no confirmed toolhead association, so they're left as-is.
// Explicit overrides for names with no eN token to derive a toolhead number
// from — confirmed live, not guessed (no authoritative Snapmaker naming doc
// exists for these; see the earlier research on this in the session).
const FAN_NAME_OVERRIDES={ "fan":"Main Cooling Fan", "fan_generic cavity_fan":"Assist Cooling Fan", "purifier inner fan":"Recirculation Fan", "purifier exhaust fan":"Exhaust Fan" };
function fanLabel(name){
  if(FAN_NAME_OVERRIDES[name]) return FAN_NAME_OVERRIDES[name];
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
  if(name==="mainboard") return "Mainboard";
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
function heaterReadingRow(h){
  const label=heaterLabel(h.name);
  if(h.state==="idle") return readingRow(label,"Idle",null,"neutral");
  const cur=h.temperature!=null?Math.round(h.temperature):"—";
  const tgt=h.target!=null?Math.round(h.target):"—";
  const dutyPct=h.power!=null?Math.round(h.power*100):null;
  if(h.state==="heating"||h.state==="cooling"||h.state==="settling"){
    const word=h.state==="heating"?"Heating":h.state==="cooling"?"Cooling":"Settling";
    return readingRow(label,`${cur} of ${tgt} °C · ${word}`,dutyPct,"neutral");
  }
  // stable — the only state where duty is trusted enough to color-judge.
  const state=h.power!=null&&h.power>=HEATER_DUTY_CRIT?"critical":h.power!=null&&h.power>=HEATER_DUTY_WARN?"warning":"healthy";
  return readingRow(label,`${cur} of ${tgt} °C (${dutyPct!=null?dutyPct+"%":"—"})`,dutyPct,state);
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
        text:`${heaterLabel(hi.name)} is at ${Math.round(hi.power*100)}% while ${heaterLabel(lo.name)} holds the same target at ${Math.round(lo.power*100)}%. Check the sock and thermistor seating.`,
        state:hi.power>=HEATER_DUTY_CRIT?"critical":"warning"
      };
    }
  }
  return null;
}
function renderHeatersCard(d){
  const heaters=d.heaters;
  if(!heaters||!heaters.available) return `<div class="health-card"><div class="health-card-hdr">Heaters</div><p class="settings-help">Heater data unavailable${heaters&&heaters.reason?": "+esc(heaters.reason):""}.</p></div>`;
  if(!heaters.list.length) return "";
  const rows=heaters.list.map(heaterReadingRow).join("");
  const note=heaterImbalanceNote(heaters.list);
  return `<div class="health-card"><div class="health-card-hdr">Heaters</div>`+
    `<p class="health-card-desc">Duty cycle while holding target. Persistent high duty means a failing heater or thermistor.</p>`+
    rows+
    (note?`<div class="reading-note ${note.state}">${esc(note.text)}</div>`:"")+
  `</div>`;
}
// Same idea for fans: when everything reads 0, that's a summary line, not a
// wall of zero rows. Auto-expands (or expands on click) the moment any fan
// is actually running or reporting an RPM despite not being commanded on —
// both are "worth a look" states. A fan with no tachometer (rpm:null) never
// counts toward "is anything running" — it's simply not measurable, and
// belongs in the expanded list's content, not driving whether the summary
// shows at all.
function fanIsActive(f){
  return (typeof f.speed==="number"&&f.speed>0.05)||(typeof f.rpm==="number"&&f.rpm>0);
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
  const val=`${commandedPct!=null?commandedPct+"% commanded":"—"} · ${measurable?Math.round(f.rpm)+" RPM":"not measurable"}`;
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
  if(!fans||!fans.available) return `<div class="health-card"><div class="health-card-hdr">Fans</div><p class="settings-help">Fan data unavailable${fans&&fans.reason?": "+esc(fans.reason):""}.</p></div>`;
  const list=fans.list.filter(f=>!FAN_REDUNDANT_MIRROR.test(f.name));
  if(!list.length) return "";
  const desc=`<p class="health-card-desc">Cooling airflow. A fan commanded on but not spinning usually means a stuck bearing, blocked blade, or bad connector.</p>`;
  const anyActive=list.some(fanIsActive);
  const rows=list.map(fanReadingRow).join("");
  if(!anyActive){
    return `<div class="health-card"><div class="health-card-hdr">Fans</div>${desc}`+
      `<p class="settings-help" id="healthFansSummary">${list.length} fans, all stopped <button type="button" class="btn ghost btn-sm" id="healthFansExpand">Show all</button></p>`+
      `<div class="health-fans-detail" id="healthFansDetail" style="display:none">${rows}</div>`+
    `</div>`;
  }
  return `<div class="health-card"><div class="health-card-hdr">Fans</div>${desc}${rows}</div>`;
}
// Recent Faults: exception_manager's per-entry field shape was never
// confirmed live (every printer checked had zero entries) — rendered
// defensively, trying a few plausible field names before falling back to a
// raw compact dump, rather than assuming a shape that was never observed.
// The one entry whose shape IS known is the "current active error" folded
// in by fetchFaultsSection from the probe result.
function renderFaultEntry(f){
  if(f.current) return `<div class="health-fault-row"><span class="health-fault-badge">Active</span><span class="health-fault-text">${esc(f.errorCode?`[${f.errorCode}] `:"")}${esc(f.message||"Unknown error")}</span></div>`;
  const guess=["message","msg","reason","description","code"].map(k=>f[k]).find(v=>v!=null&&v!=="");
  return `<div class="health-fault-row"><span class="health-fault-text">${esc(guess!=null?String(guess):JSON.stringify(f))}</span></div>`;
}
function renderFaultsCard(d){
  const f=d.faults;
  if(!f||!f.available) return `<div class="health-card"><div class="health-card-hdr">Recent faults</div><p class="settings-help">Fault data unavailable${f&&f.reason?": "+esc(f.reason):""}.</p></div>`;
  if(!f.list.length) return `<div class="health-card"><div class="health-card-hdr">Recent faults</div><p class="settings-help">No recent faults.</p></div>`;
  return `<div class="health-card"><div class="health-card-hdr">Recent faults</div>`+f.list.map(renderFaultEntry).join("")+`</div>`;
}
function renderServiceHistoryCard(maint){
  const entries=(maint&&maint.entries)||[];
  const header=`<div class="health-card-hdr-row"><div class="health-card-hdr">Service history</div><button type="button" class="btn ghost btn-sm" id="healthAddService">Add service record</button></div>`;
  if(!entries.length) return `<div class="health-card">${header}<p class="settings-help">No service recorded yet.</p></div>`;
  const rows=entries.slice().reverse().map(e=>`<div class="health-service-row"><span class="health-service-date">${esc(fmtMaintDate(e.date))}</span><span class="health-service-component">${esc(e.component||"—")}</span><span class="health-service-comment">${esc(e.comment||"")}</span><span class="health-service-cost">${e.cost?esc(CURRENCY)+Number(e.cost).toFixed(2):""}</span></div>`).join("");
  return `<div class="health-card">${header}${rows}</div>`;
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
function renderHealthSvcChips(){
  const wrap=$("healthSvcChips");
  if(!wrap) return;
  const comps=(HEALTH_MAINT&&HEALTH_MAINT.components)||[];
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
    $("healthSvcNextDue").textContent="Not scheduled";
    $("healthSvcNextHint").textContent="No reminder will be set for this component.";
    return;
  }
  const next=spec.unit==="days"?addDaysClient(date,spec.amount):addMonthsClient(date,spec.amount);
  $("healthSvcNextDue").textContent=next?fmtMaintDate(next):"—";
  $("healthSvcNextHint").textContent=date?`Based on ${fmtMaintDate(date)} + ${spec.label}${component?` for ${component}`:""}.`:"";
}
function openHealthServiceForm(prefillComponent){
  const wrap=$("healthServiceForm");
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
  $("healthSvcHours").textContent="loading…";
  getJSON("/api/printer-hours?printer="+HEALTH_PRINTER_ID).then(d=>{
    HEALTH_SVC_HOURS_SEC=d.totalSeconds!=null?d.totalSeconds:null;
    $("healthSvcHours").textContent=HEALTH_SVC_HOURS_SEC!=null?fmtHours(HEALTH_SVC_HOURS_SEC):"unavailable";
  }).catch(()=>{ $("healthSvcHours").textContent="unavailable"; });
  wrap.scrollIntoView({behavior:"smooth",block:"nearest"});
}
function closeHealthServiceForm(){
  const wrap=$("healthServiceForm");
  if(wrap) wrap.style.display="none";
}
async function toggleHealthOffline(){
  const chk=$("healthSvcOffline");
  const st=$("healthSvcStatus");
  const offline=chk.checked;
  chk.disabled=true;
  st.className="pstatus work"; st.textContent=offline?"Taking offline…":"Bringing online…";
  try{
    const r=await postJSON("/api/maintenance-mode",{printer:HEALTH_PRINTER_ID,offline});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=d.maintenanceMode?"Printer taken offline":"Printer back online";
    chk.checked=!!d.maintenanceMode;
    loadFleet();
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; chk.checked=!offline; }
  finally{ chk.disabled=false; }
}
async function saveHealthService(){
  const st=$("healthSvcStatus");
  const date=$("healthSvcDate").value;
  if(!date){ st.className="pstatus err"; st.textContent="Pick a date"; return; }
  const component=currentHealthSvcComponent();
  if(!component){ st.className="pstatus err"; st.textContent="Pick or type a component"; return; }
  const pid=HEALTH_PRINTER_ID;
  const entry={
    date, comment:$("healthSvcComment").value.trim(), part:$("healthSvcPart").value.trim(),
    hours:HEALTH_SVC_HOURS_SEC!=null?fmtHours(HEALTH_SVC_HOURS_SEC):"—", totalSeconds:HEALTH_SVC_HOURS_SEC,
    component, frequency:$("healthSvcFrequency").value,
    cost:parseFloat($("healthSvcCost").value)||0
  };
  $("healthSvcSave").disabled=true;
  st.className="pstatus work"; st.textContent="Saving…";
  try{
    const r=await postJSON("/api/maintenance",{printer:pid,entry});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent="Saved";
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
  { key:"gcodes", label:"G-code", color:"var(--storage-gcode)" },
  { key:"logs", label:"Logs", color:"var(--storage-logs)" },
  { key:"camera", label:"Camera", color:"var(--storage-camera)" }
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
const SYNC_ROOT_LABEL={logs:"Logs",camera:"Camera",gcodes:"G-code"};
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
function syncStatusText(root,st){
  if(!st) return "";
  const label=SYNC_ROOT_LABEL[root]||root;
  if(st.phase==="listing") return `${label}: listing files…`;
  if(st.phase==="downloading") return `${label}: syncing ${st.completed} of ${st.total}${st.currentFile?" · "+st.currentFile:""}`;
  if(st.phase==="cleaning-up") return `${label}: cleaning up printer storage…`;
  if(st.phase==="error") return `${label}: sync failed — ${st.lastError||"unknown error"}`;
  if(st.phase==="idle"&&st.lastSyncAt) return `${label}: ${st.downloaded} downloaded, ${st.skipped} skipped${st.failed?`, ${st.failed} failed`:""}${st.deletedFromSource?`, ${st.deletedFromSource} removed from printer`:""}`;
  return "";
}
async function startSync(printerId,root){
  const key=syncKey(printerId,root);
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
  if(!s||!s.available) return `<div class="health-card"><div class="health-card-hdr">Storage</div><p class="settings-help">Storage data unavailable${s&&s.reason?": "+esc(s.reason):""}.</p></div>`;
  const du=s.diskUsage, total=du.total||1;
  const critical=du.free<du.total*DISK_CRITICAL_PCT||du.free<DISK_CRITICAL_BYTES;
  const segs=HEALTH_STORAGE_CATS.map(c=>({...c, bytes:(s.categories[c.key]&&s.categories[c.key].bytes)||0}));
  // Only the three named categories get a segment — the rest of the track
  // (everything else on disk, including free space) is left unfilled and
  // unlabeled on purpose, per spec: no "Other," no "Free" row here (Free
  // space already has its own metric card at the top of the page).
  const barHtml=segs.map(c=>`<span class="health-storage-seg" style="width:${Math.max(0,c.bytes/total*100).toFixed(2)}%;background:${c.color}" title="${esc(c.label)}: ${fmtBytes(c.bytes)}"></span>`).join("");
  const legendHtml=segs.map(c=>{
    if(c.key!=="gcodes"||!s.categories.gcodes) return storageLegendRow(c.label,c.color,"",fmtBytes(c.bytes));
    const gc=s.categories.gcodes;
    let extra=` · ${gc.fileCount} files`, title=null;
    if(gc.unusedCount!=null){
      extra+=` (Unused ${gc.unusedCount})`;
      title=`Not printed in the last ${gc.unusedThresholdDays} day${gc.unusedThresholdDays===1?"":"s"} — per the G-code sync retention setting.`;
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
    const label=SYNC_ROOT_LABEL[root];
    const title=!d.syncSupported?"This printer's connector doesn't support file sync."
      :!configured?`Configure a ${label} folder in Settings first.`
      :running?"A sync is already running."
      :"";
    const text=running?`Syncing ${label.toLowerCase()}…`:`Sync ${label.toLowerCase()}`;
    const pct=syncProgressPct(st);
    const fill=pct!=null?`background:linear-gradient(to right, rgba(167,139,250,0.55) ${pct}%, rgba(167,139,250,0.13) ${pct}%);`:"";
    return `<button type="button" class="btn ghost" style="${fill}" ${disabled?"disabled":""} ${title?`title="${esc(title)}"`:""} data-sync="${root}" data-syncprinter="${printerId}">${esc(text)}</button>`;
  };
  const statusText=["logs","camera","gcodes"].map(r=>syncStatusText(r,syncStates[r])).filter(Boolean).join(" · ");
  return `<div class="health-card">
    <div class="health-card-hdr">Storage</div>
    <p class="health-card-desc">Disk usage by category. Uploads and prints can fail confusingly once free space runs low.</p>
    ${critical?`<div class="health-critical-banner">Free space is critically low — uploads can fail confusingly once the disk fills.</div>`:""}
    <div class="health-storage-bar">${barHtml}</div>
    ${legendHtml}
    <div class="health-diag-vals health-storage-totals">total ${fmtBytes(du.total)} · used ${fmtBytes(du.used)} · free ${fmtBytes(du.free)}</div>
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
  if(HEALTH_PRINTER_ID==null){ body.innerHTML=`<div class="settings-help">No printer selected.</div>`; closeHealthServiceForm(); return; }
  const d=HEALTH_DATA;
  const p=FLEET.find(f=>f.id===HEALTH_PRINTER_ID);
  const name=p?p.name:"Printer";
  if(!d){ body.innerHTML=`<div class="settings-help">Loading ${esc(name)}'s health data…</div>`; closeHealthServiceForm(); return; }
  if(d.skipped){
    body.innerHTML=`<div class="health-unsupported"><h3>${esc(name)}</h3><p>Health data not available for this connector.</p>${d.reason?`<p class="settings-help">${esc(d.reason)}</p>`:""}</div>`;
    closeHealthServiceForm();
    return;
  }
  const hist=d.history&&d.history.available?d.history:null;
  const printTime=hist?fmtDuration(hist.totalPrintTime):"—";
  const recent=hist&&hist.recent;
  const recentPctTxt=recent&&recent.sampleSize?Math.round(recent.completed/recent.sampleSize*100)+"%":"—";
  const recentSub=recent&&recent.sampleSize?`${recent.completed} / ${recent.sampleSize} jobs`:"";
  const storage=d.storage&&d.storage.available?d.storage:null;
  const freeTxt=storage?fmtBytes(storage.diskUsage.free):"—";
  const metricsHtml=`<div class="health-metrics">`+
    `<div class="health-metric"><span class="health-metric-label">Print time</span><span class="health-metric-val">${printTime}</span></div>`+
    `<div class="health-metric"><span class="health-metric-label">Recent success</span><span class="health-metric-val">${recentPctTxt}</span>${recentSub?`<span class="health-metric-sub">${recentSub}</span>`:""}</div>`+
    `<div class="health-metric"><span class="health-metric-label">Free space</span><span class="health-metric-val">${freeTxt}</span></div>`+
    `<div class="health-metric"><span class="health-metric-label">Last service</span><span class="health-metric-val">${esc(lastServiceText(HEALTH_MAINT))}</span></div>`+
  `</div>`;
  const cards=[renderAttentionList(d),renderToolheadsCard(p),renderHeatersCard(d),renderControllerCard(d),renderSystemCard(d),renderFansCard(d),renderStorageCard(d,HEALTH_PRINTER_ID),renderFaultsCard(d),renderServiceHistoryCard(HEALTH_MAINT)].filter(Boolean).join("");
  body.innerHTML=`<h3 class="health-printer-name">${esc(name)}</h3>`+metricsHtml+`<div class="health-grid">${cards}</div>`;
  body.querySelectorAll("[data-sync]").forEach(b=>{
    b.addEventListener("click",()=>startSync(parseInt(b.dataset.syncprinter,10),b.dataset.sync));
  });
  body.querySelectorAll("[data-logfix]").forEach(b=>{
    b.addEventListener("click",()=>openHealthServiceForm(b.dataset.logfix));
  });
  const addBtn=$("healthAddService");
  if(addBtn) addBtn.addEventListener("click",()=>openHealthServiceForm());
  const fansExpand=$("healthFansExpand");
  if(fansExpand) fansExpand.addEventListener("click",()=>{
    $("healthFansDetail").style.display="";
    $("healthFansSummary").style.display="none";
  });
  closeHealthServiceForm(); // switching printers/refreshing always closes any open form — never leave it pointed at stale printer state
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
const QUEUE_STATUS_CATEGORY_LABEL = { offline:"Offline", error:"Error", awaiting:"Awaiting sign-off", stopped:"Stopped", paused:"Paused", printing:"Printing", idle:"Idle" };
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
      `<div class="queue-project-meta"><span class="queue-status-badge" style="color:var(--ok)">Completed</span> ${r.completedCount} today</div>`+
      `</div>`;
  }
  const brands=r.brands.length?esc(r.brands.join(", ")):"";
  return `<div class="queue-project-row">`+
    `<div class="queue-project-name">${esc(r.name)}</div>`+
    `<div class="queue-project-bar"><div class="queue-project-fill" style="width:${r.pct}%"></div></div>`+
    `<div class="queue-project-meta">${r.completedCount} completed · ${r.printingCount} printing · ${r.queuedCount} queued — ${r.pct}%</div>`+
    `<div class="queue-project-footer">So far: ${fmtElapsedSince(r.windowStart)}${brands?" · "+brands:""}</div>`+
    `</div>`;
}
function renderActiveProjectsSection(pools){
  return `<div class="fl" style="margin:16px 0 8px">Queue Status</div>`+
    pools.map(g=>{
      const rows=computeActiveProjectsForPool(g.pool);
      const body=rows.length ? rows.map(renderActiveProjectRow).join("") : `<div class="settings-help">Nothing active right now.</div>`;
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
    const msg=(qs&&qs.attentionDetail&&qs.attentionDetail.message)||(qs&&qs.attentionReason)||(fleetRow&&fleetRow.error)||"";
    // Only a real hardware error (the printer itself reporting state:error)
    // is something "eject the loaded file" can fix — a queue_attention_required
    // caused by e.g. a missing/changed file has nothing physically loaded to
    // release, and already has its own Retry/Skip/Stop resolution controls
    // in the Printers section below, so no click hint is added for that case.
    const hw=fleetRow&&fleetRow.state==="error";
    return { fillPct:0, extra:[msg, hw?"click to release":""].filter(Boolean).join(" — ") };
  }
  if(cat==="awaiting") return { fillPct:0, extra:"Waiting for bed clear" };
  if(cat==="stopped") return { fillPct:0, extra:"Queue stopped — click to release" };
  if(cat==="paused") return { fillPct:0, extra:"Queue paused — click to resume" };
  return { fillPct:0, extra:"" };
}
function renderFleetStatusSection(pools){
  const rows=pools.map(g=>{
    const cats=g.printers.map(printerQueueCategory);
    const counts={};
    cats.forEach(c=>{ counts[c]=(counts[c]||0)+1; });
    const chips=g.printers.map((p,i)=>{
      const cat=cats[i], color=QUEUE_STATUS_CATEGORY_COLOR[cat], label=QUEUE_STATUS_CATEGORY_LABEL[cat];
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
    const badges=Object.keys(QUEUE_STATUS_CATEGORY_LABEL).filter(c=>counts[c]).map(c=>
      `<span class="queue-status-badge" style="color:${QUEUE_STATUS_CATEGORY_COLOR[c]}">${counts[c]} ${esc(QUEUE_STATUS_CATEGORY_LABEL[c])}</span>`
    ).join("");
    return `<div class="queue-fleet-row">`+
      `<div class="queue-fleet-name">`+
      `<div class="queue-fleet-name-row"><b title="${esc(g.pool.name)}">${esc(g.pool.name)}</b><span class="queue-mode-badge">${esc(g.pool.type)}</span></div>`+
      `<span class="queue-fleet-count">${g.printers.length} printer${g.printers.length===1?"":"s"}</span>`+
      `</div>`+
      `<div class="queue-fleet-chips">${chips}</div>`+
      `<div class="queue-fleet-badges">${badges}</div>`+
      `</div>`;
  }).join("");
  const legend=Object.keys(QUEUE_STATUS_CATEGORY_LABEL).map(c=>
    `<button type="button" class="queue-legend-btn" data-cat="${esc(c)}" aria-pressed="${QUEUE_FLEET_STATUS_FILTER.has(c)}" style="--status-color:${QUEUE_STATUS_CATEGORY_COLOR[c]}">`+
    `<span class="queue-legend-swatch"></span>${esc(QUEUE_STATUS_CATEGORY_LABEL[c])}</button>`
  ).join("");
  return `<div class="fl" style="margin:16px 0 8px">Fleet Status</div>`+
    `<div class="setcard">${rows}<div class="queue-legend">${legend}</div></div>`;
}

function renderQueueDashboard(){
  const warnBox=$("queueViewStoreWarning");
  const s=QUEUE_STORE_STATUS;
  if(s.queueStoreRecoveryRequired||s.storeDegraded||s.storeStoppedByAdmin){
    warnBox.style.display="";
    warnBox.textContent = s.queueStoreRecoveryRequired ? "Queue data needs recovery — go to Settings → Queue Management to review it." :
      s.storeDegraded ? "Queue state is not currently durable — automatic retry in progress. New dispatches are paused until this clears." :
      "Queue automation was manually stopped for every printer — resume it from Settings → Queue Management.";
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
    body.innerHTML=`<div class="settings-help" style="padding:20px">No printers are assigned to a Printer Pool yet — assign one from Settings → Printers.</div>`;
    return;
  }
  body.innerHTML=
    renderActiveProjectsSection(pools)+
    renderFleetStatusSection(pools)+
    `<div class="fl" style="margin:16px 0 8px">Printers</div>`+
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
function ordinalTag(n){
  const pos=n+3, mod100=pos%100;
  const suf=(mod100>=11&&mod100<=13)?"th":({1:"st",2:"nd",3:"rd"}[pos%10]||"th");
  return pos+suf;
}
// Client-side only — first tick a printer is seen offline, remember when.
// No server-side tracking exists for this; resets the moment it's back online.
const QUEUE_OFFLINE_SINCE=new Map();
function offlineSinceLabel(printerId, online){
  if(online){ QUEUE_OFFLINE_SINCE.delete(printerId); return "Offline"; }
  if(!QUEUE_OFFLINE_SINCE.has(printerId)) QUEUE_OFFLINE_SINCE.set(printerId, Date.now());
  return "Offline since "+new Date(QUEUE_OFFLINE_SINCE.get(printerId)).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
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
    `<div class="qgroup-title"><span class="qgroup-name">${esc(pool.name)}</span><span class="queue-mode-badge">${esc(pool.type)}</span></div>`+
    `<div class="qgroup-summary">${counts.printing} printing · ${counts.waiting} waiting · ${counts.idle} idle · ${totalJobs} job${totalJobs===1?"":"s"} queued</div>`+
    `<div class="qgroup-actions">`+
    (pool.isDefault?"":switchHtml("autobalance-"+pool.id, !!pool.autoBalance, "Auto-balance"))+
    `<button type="button" class="btn ghost qexpand-all" data-pool="${esc(pool.id)}">${allExpanded?"Collapse all":"Expand all"}</button>`+
    (pool.isDefault?"":`<button type="button" class="btn ghost queue-pause-all" data-pool="${esc(pool.id)}">Pause All Queues</button>`)+
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
    const outsideNote=(qs&&qs.currentItem)?"":` <span class="pi-lbl">(started outside the queue)</span>`;
    jobHtml=`<b title="${esc(full)}">${esc(name)}</b>${outsideNote}`;
    pctHtml=`<span class="qc-pct">${fillPct}%</span>`;
    etaHtml=`<span class="qc-eta">${esc(fmtRemaining(fleetRow&&fleetRow.elapsed, fleetRow&&fleetRow.progress))}</span>`;
  } else if(cat==="blocked"){
    jobHtml=`Waiting for bed clear <button type="button" class="btn primary qbedclear-btn queue-confirm-bedclear" data-printer="${esc(p.id)}">Bed Clear — Print Next</button>`;
  } else if(cat==="attention"){
    const reason=(qs&&qs.attentionReason)||"attention needed";
    const msg=(qs&&qs.attentionDetail&&qs.attentionDetail.message)||reason;
    jobHtml=`<span title="${esc(msg)}">Needs attention — ${esc(reason)}</span>`;
  } else if(cat==="offline"){
    jobHtml=esc(offlineSinceLabel(p.id, false));
  } else { // idle
    if(queueLen>0) jobHtml=`Idle — ${queueLen} queued${qs&&qs.queueStopped?" · stopped":""}`;
    else jobHtml="Idle, queue empty";
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
    `<span class="qc-menu"><button type="button" class="qc-menu-btn" title="More" data-printer-menu="${esc(p.id)}">⋮</button></span>`+
    `</div>`+
    (expanded&&hasExpandable?renderQueueExpandedPanel(p, qs, cat):"");
}

function renderQueueExpandedPanel(p, qs, cat){
  const items=[];
  if(cat==="printing"){
    const full=qs&&qs.currentItem?qs.currentItem.file.name:"";
    const fleetRow=fleetRowForPrinterId(p.id);
    items.push({ tag:"Printing now", now:true,
      name:full?stripExt(full):stripExt((fleetRow&&fleetRow.filename)||"")||"—", full:full||(fleetRow&&fleetRow.filename)||"",
      pct:(fleetRow&&typeof fleetRow.progress==="number")?Math.round(fleetRow.progress*100)+"%":"",
      eta:fmtRemaining(fleetRow&&fleetRow.elapsed, fleetRow&&fleetRow.progress) });
  } else if(cat==="blocked"){
    items.push({ tag:"Blocked", now:true, name:"Waiting for bed clear", full:"" });
  } else if(cat==="attention"){
    const reason=(qs&&qs.attentionReason)||"attention needed";
    items.push({ tag:"Attention", now:true, name:reason, full:(qs&&qs.attentionDetail&&qs.attentionDetail.message)||"" });
  }
  (qs&&qs.queue||[]).forEach((it,i)=>{
    items.push({ tag:i===0?"Next":ordinalTag(i-1), name:stripExt(it.file.name), full:it.file.name, itemId:it.id });
  });

  const rows=items.map(it=>
    `<div class="qitem${it.now?" now":""}">`+
    `<span></span>`+
    `<span class="qc-name qitem-tag">${esc(it.tag)}</span>`+
    `<span class="qc-job"><b title="${esc(it.full)}">${esc(it.name)}</b></span>`+
    `<span class="qc-pct">${esc(it.pct||"")}</span>`+
    `<span class="qc-eta">${esc(it.eta||(it.itemId?"—":""))}</span>`+
    `<span></span><span></span>`+
    `<span class="qc-menu">${it.itemId?`<button type="button" class="qitem-remove queue-remove-item" data-printer="${esc(p.id)}" data-item="${esc(it.itemId)}" title="Remove">×</button>`:""}</span>`+
    `</div>`
  ).join("")||`<div class="settings-help" style="padding:4px 0">Nothing queued.</div>`;

  // Clear Queue is the actual "abort everything" action — it cancels
  // whatever's physically printing (if anything) and wipes the rest of the
  // queue in one step. Offered anywhere there's something to abort: mid
  // attention-resolution too, as a "give up on all of it" escape hatch
  // rather than resolving one blocked item at a time.
  const hasWorkToClear=!!((qs&&qs.currentItem)||(qs&&qs.queue&&qs.queue.length));
  const clearBtn=hasWorkToClear?`<button type="button" class="btn ghost danger queue-clear" data-printer="${esc(p.id)}">Clear Queue</button>`:"";
  // The Unassigned pool (isDefault) is where printers land by default, not a
  // pool anyone opted into queue orchestration for — Pause/Resume/Stop only
  // make sense once dispatch is actually being automated.
  const pool=PRINTER_POOLS.find(x=>x.id===p.printerPoolId);
  const isUnmanaged=!!(pool&&pool.isDefault);

  let actionsHtml;
  if(cat==="attention"){
    const actions=QUEUE_ATTENTION_RESOLUTIONS[(qs&&qs.attentionReason)]||[["stop","Stop Queue"]];
    actionsHtml=actions.map(([action,label])=>`<button type="button" class="btn ghost queue-resolve" data-printer="${esc(p.id)}" data-action="${esc(action)}">${esc(label)}</button>`).join("")+clearBtn;
  } else {
    // Cancel Print is deliberately separate from Stop Queue — Stop only
    // prevents the NEXT item from auto-dispatching (the current print, if
    // any, keeps running), it never touches what's on the printer right
    // now. Cancel Print is the only control here that does; it's the same
    // /api/printctl action the printer's own Fleet card exposes, wired in
    // here too since there was previously no way to reach it from the
    // Queue view at all.
    const cancelBtn=cat==="printing"?`<button type="button" class="btn ghost danger queue-cancel-print" data-printer="${esc(p.id)}">Cancel Print</button>`:"";
    const pauseStopHtml=isUnmanaged?"":(qs&&(qs.queueStopped||qs.queuePaused)
      ? `<button type="button" class="btn ghost queue-resume" data-printer="${esc(p.id)}">Resume Queue</button>`
      : `<button type="button" class="btn ghost queue-pause" data-printer="${esc(p.id)}">Pause Queue</button>`)+
      `<button type="button" class="btn danger queue-stop" data-printer="${esc(p.id)}">Stop Queue</button>`;
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
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
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
      if(!confirm("Release this printer from its error state? This ejects the currently loaded file.")) return;
      // Hardware error is a Fleet-card-level concern, not a queue one —
      // /api/printctl (the same eject action the Fleet card's own Eject
      // button uses) addresses printers by array index, not persistent id.
      const idx=PRINTERS_CFG.findIndex(x=>x.id===b.dataset.printer);
      if(idx<0){ alert("Unknown printer"); return; }
      try{
        const r=checkAuthFailure(await postJSON("/api/printctl",{printer:idx,action:"eject"}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
        refreshQueueDashboard();
      }catch(err){ alert(err.message); }
    }
  }));
  root.querySelectorAll(".queue-pause").forEach(b=>b.addEventListener("click", e=>{ e.stopPropagation(); simple(b.dataset.printer,"pause"); }));
  root.querySelectorAll(".queue-resume").forEach(b=>b.addEventListener("click", e=>{ e.stopPropagation(); simple(b.dataset.printer,"resume"); }));
  root.querySelectorAll(".queue-stop").forEach(b=>b.addEventListener("click", e=>{
    e.stopPropagation();
    if(confirm("Stop this printer's queue? Nothing further will start automatically until you resume it — the current print, if any, keeps running.")) simple(b.dataset.printer,"stop");
  }));
  root.querySelectorAll(".queue-clear").forEach(b=>b.addEventListener("click", e=>{
    e.stopPropagation();
    if(confirm("Clear this printer's entire queue? If it's currently printing, that print is cancelled immediately and any progress is lost. Every other queued item is removed too. This can't be undone.")) simple(b.dataset.printer,"clear");
  }));
  root.querySelectorAll(".queue-confirm-bedclear").forEach(b=>b.addEventListener("click", e=>{ e.stopPropagation(); simple(b.dataset.printer,"confirm-bed-clear"); }));
  root.querySelectorAll(".queue-cancel-print").forEach(b=>b.addEventListener("click", async e=>{
    e.stopPropagation();
    if(!confirm("Cancel the current print on this printer? This stops it immediately — any progress is lost.")) return;
    // /api/printctl (the same action the printer's own Fleet card cancel
    // button uses) addresses printers by array index, not persistent id —
    // a legacy convention predating Queue Management's id-based routes.
    const idx=PRINTERS_CFG.findIndex(x=>x.id===b.dataset.printer);
    if(idx<0){ alert("Unknown printer"); return; }
    try{
      const r=checkAuthFailure(await postJSON("/api/printctl",{printer:idx,action:"cancel"}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      refreshQueueDashboard();
    }catch(e){ alert(e.message); }
  }));
  root.querySelectorAll(".queue-remove-item").forEach(b=>b.addEventListener("click", async e=>{
    e.stopPropagation();
    try{ const r=checkAuthFailure(await fetch("/api/queue/"+b.dataset.printer+"/items/"+b.dataset.item,{method:"DELETE"})); const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status); refreshQueueDashboard(); }
    catch(e){ alert(e.message); }
  }));
  root.querySelectorAll(".queue-resolve").forEach(b=>b.addEventListener("click", async e=>{
    e.stopPropagation();
    try{
      const action=b.dataset.action;
      const r=checkAuthFailure(action==="accept-file-change"
        ? await fetch("/api/queue/"+b.dataset.printer+"/accept-file-change",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
        : await postJSON("/api/queue/"+b.dataset.printer+"/resolve",{action}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
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
  try{
    const r=await postJSON("/api/files/move",{files,targetSub});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    const failed=(d.results||[]).filter(x=>!x.ok);
    if(failed.length){ st.className="pstatus err"; st.textContent="Couldn't move "+failed.map(x=>x.name+" ("+x.error+")").join(", "); }
    else { st.className="pstatus ok"; st.textContent="Moved "+files.length+(files.length===1?" file":" files"); setTimeout(()=>{ if(st.textContent.startsWith("Moved")) st.textContent=""; },3000); }
  }catch(e){ st.className="pstatus err"; st.textContent="Move failed: "+e.message; }
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
  if(!name){ st.className="pstatus err"; st.textContent="Enter a folder name"; return; }
  const btn=$("newFolderModalCreate"); btn.disabled=true;
  st.className="pstatus work"; st.textContent="Creating…";
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
  for(let i=0;i<files.length;i++){
    const f=files[i];
    st.className="pstatus work"; st.textContent="Uploading "+f.name+" ("+(i+1)+"/"+files.length+")…";
    try{
      const r=await fetch("/api/files/upload?sub="+encodeURIComponent(CURRENT_SUB)+"&name="+encodeURIComponent(f.name), {
        method:"POST", headers:{"Content-Type":"application/octet-stream"}, body:f
      });
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    }catch(e){
      st.className="pstatus err"; st.textContent=f.name+": "+e.message;
      await new Promise(res=>setTimeout(res,1500));
    }
  }
  st.className="pstatus ok"; st.textContent="Upload complete";
  setTimeout(()=>{ if(st.textContent==="Upload complete") st.textContent=""; },3000);
  loadFiles(CURRENT_SUB);
}

async function selectFile(name){
  SELECTED=name; MAPSEL={}; renderList();
  // Orca mode hides this section permanently (init() sets it inline) — don't
  // fight that override here.
  if(!URL_PRINTER_FILTER) $("jobsechead").style.display="";
  $("jlname").textContent="Opening "+name+"…";
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

function renderJob(){
  $("jobcard").classList.add("show");
  $("jt").innerHTML=esc(stripExt(SELECTED))+(MAP.isFS?` <img src="/fs-badge.svg" class="fs-badge" title="Full Spectrum (${esc(MAP.fsFork||'mixed')})">`:``);
  // meta line: time · weight · cost
  const totalGrams=MAP.palette.reduce((sum,s)=>sum+(parseFloat(s.wt)||0),0);
  const timeHours=parseTimeToHours((MAP.meta||[])[0]);
  const fCost=(FILAMENT_COST>0&&totalGrams>0)?(FILAMENT_COST/1000)*totalGrams:0;
  const eCost=(ELECTRICITY_RATE>0&&timeHours>0)?ELECTRICITY_RATE*timeHours:0;
  const totalCost=fCost+eCost;
  const metaParts=[...(MAP.meta||[])];
  if(totalCost>0) metaParts.push("$"+totalCost.toFixed(2));
  $("jmeta").textContent=metaParts.join("  ·  ");
  // compatibility warning
  const compat=$("jcompat");
  if(MAP.printerModel&&!/snapmaker\s*u1/i.test(MAP.printerModel)){
    compat.style.display=""; compat.textContent=`⚠ Sliced for "${MAP.printerModel}", not Snapmaker U1 — may not print correctly`;
  } else { compat.style.display="none"; }
  // thumbnail
  const thumb=$("jthumb");
  thumb.style.display="none";
  thumb.onerror=()=>{ thumb.style.display="none"; };
  thumb.onload=()=>{ thumb.style.display="block"; };
  thumb.src="/api/local-thumbnail?file="+encodeURIComponent(SELECTED);
  if(thumb.complete && thumb.naturalWidth>0) thumb.style.display="block";
  const need=neededColors();
  $("needcount").textContent=need.length+(need.length===1?" color":" colors");
  const strip=$("needstrip"); strip.innerHTML="";
  need.forEach(s=>{ const d=document.createElement("div"); d.className="need";
    d.innerHTML=`<span class="sw" style="background:${esc(s.hex||'#3a3f49')}"></span><span>${esc(s.type||'PLA')}</span><span class="nx">T${s.i+1}${s.wt?` · ${Math.ceil(parseFloat(s.wt))} g`:''}</span>`;
    strip.appendChild(d); });
  const over=need.length>(MAP.physicalHeads||4) && !MAP.isFS;
  $("nohint").innerHTML = `Uses <b style="color:var(--ink)">${need.length}</b> of ${MAP.paletteCount} palette colors. `+
    (MAP.isFS
        ?`<b style="color:var(--ink)">Full Spectrum</b> (${esc(MAP.fsFork||'mixed')}) — colors blend across the 4 heads, no mid-print swap needed.`
        :over?`<b style="color:var(--bad)">More than the U1's 4 toolheads</b> — needs a mid-print swap or a re-slice.`
        :`Load these into any heads; confirm head mapping on the machine's screen at start.`);
  const warn=$("warn");
  if(MAP.noColors){ warn.classList.add("show"); warn.textContent="No filament_colour in this file — showing material only."; } else warn.classList.remove("show");
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
function fmtRemaining(elapsed,progress){if(!elapsed||!progress||progress<=0)return'—';const total=elapsed/progress;const rem=Math.max(0,total-elapsed);return fmtDuration(rem);}

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
function heatBarFillStyle(bar){
  return `width:${bar.pct}%`+(bar.bg?`;background:${bar.bg};box-shadow:0 0 6px ${bar.bg}`:'');
}

function renderSkeletonFleet(){
  if(!PRINTERS_CFG||!PRINTERS_CFG.length) return;
  const wrap=$("fleet"); wrap.innerHTML="";
  $("fleetcount").textContent="connecting…";
  PRINTERS_CFG.forEach(p=>{
    const card=document.createElement("div"); card.className="pcard";
    card.innerHTML=
      `<div class="top">`+
      `<span class="pn"><span class="printer-icon-sm" style="opacity:.35"></span>`+
      `<span><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name">${esc(p.name||'—')}</div></span></span>`+
      `<span class="status-badge" style="--status-color:var(--idle)">Connecting…</span>`+
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
  if(sub) sub.textContent=`connecting to printers ${pad(0)}/${pad(n)}`;
  FLEET=await Promise.all(PRINTERS_CFG.map((cfg,i)=>
    fetch("/api/fleet?printer="+i,{signal:AbortSignal.timeout(15000)})
      .then(r=>r.json())
      .catch(()=>({ id:i, name:cfg.name||cfg.url, brand:cfg.brand||'SnapMaker', url:cfg.url, online:false, error:'unreachable' }))
      .then(r=>{ done++; if(sub) sub.textContent=`connecting to printers ${pad(done)}/${pad(n)}`; return r; })
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
    }
  }
  catch(e){
    FLEET_PREV_BODY=""; // force a re-render on the next successful poll
    // Transient failure: keep the last-known cards on screen and say we're
    // retrying — only show the bare message when there is nothing to show.
    if(!FLEET.length) $("fleet").innerHTML='<p class="subnote">Fleet unreachable.</p>';
    $("fleetcount").textContent="reconnecting…";
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
      <div class="afc-lane-hdr" ${hdrStyle}>T${i+1}${material&&material!=='—'?' '+esc(material):''}</div>
      <div class="afc-spool-area">
        ${spool}
        ${active?`<div class="afc-active-label" style="color:${color}cc">${finished?'LAST USED':'ACTIVE'}</div>`:''}
        ${loaded&&!active?`<div class="afc-active-label" style="color:var(--ink-faint)">LOADED</div>`:''}
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
function cardSignature(p){
  const queuedReady=p.queuedFile&&p.queuedFile.status==='ready'?p.queuedFile:null;
  const stem=queuedReady?queuedReady.name:(p.filename||"");
  return JSON.stringify({
    online:p.online, state:p.state, name:p.name, brand:p.brand, url:p.url,
    filename:p.filename, progress:p.progress, elapsed:p.elapsed,
    filamentUsed:p.filamentUsed, completedAt:p.completedAt,
    errorCode:p.errorCode, message:p.message, plate:p.plate,
    activeExt:p.activeExt, forceDefaults:p.forceDefaults,
    heads:p.heads, capabilities:p.capabilities, tags:p.tags,
    queuedFile:p.queuedFile, layer:p.layer, stem
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
        mapHtml=`<div class="cmap"><div class="cmaphdr-row"><span class="cmaphdr">Model Color</span><span class="cmaphdr">Printer ToolHeads</span></div>${rows}</div>`;
      }
    }
    card.innerHTML=`
      <div class="top">${gridToolbarActive()?`<label class="cam-select"><input type="checkbox" class="cam-chk checkbox-input on-surface" data-camsel="${p.id}"${CAM_SELECTED.has(p.id)?' checked':''}></label>`:''}<span class="pn"><span><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name">${esc(p.name)}</div></span></span><div class="card-right">${p.online?`<div class="card-pills">${(p.state==='idle'||p.state==='complete'||p.state==='cancelled')&&p.filename?`<button class="pill-btn pill-btn-sm" ${canAct()?"":"disabled"} data-eject="${p.id}" title="Eject"><img src="/eject-pill.svg" alt="Eject"></button>`:''}${p.capabilities?.camera?`<button class="pill-btn pill-btn-sm" data-snap="${p.id}" title="Camera"><img src="/camera-pill.svg" alt="Camera"></button>`:''}${p.capabilities?.webUi?`<a class="pill-btn pill-btn-sm" href="${esc(p.url||'#')}" target="_blank" rel="noopener" title="Open Web Interface"><img src="/fluidd-pill.svg" alt="Web Interface"></a>`:''}</div>`:''}<span class="status-badge${dragEnabled?' drag-handle':''}"${dragEnabled?' draggable="true" title="Drag to reorder"':''} style="--status-color:${statusColor}">${statusTxt}</span></div></div>
      <div class="prism-line${p.state==='error'?' err-line':p.state==='cancelled'?' cancelled-line':p.state==='paused'?' pause-line':p.state==='complete'?' complete-line':''}"></div>
      ${VIEW_MODE==='camera'?(!p.online
          ? `<div class="cam-shot-placeholder"><span>Offline</span></div>`
          : p.capabilities?.camera
            ? `<div class="cam-shot-slot" data-camslot="${p.id}"></div>`
            : `<div class="cam-shot-placeholder"><img class="cam-shot-placeholder-icon" src="/camera-disabled.svg" alt=""><span>Camera Disabled</span></div>`
        ):''}
      ${p.queuedFile?queuedFileBannerHtml(p):''}
      ${p.online&&(p.errorCode||p.message)?(()=>{
        const e=lookupKlipperError(p.errorCode, p.message);
        const listIcon=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`;
        return `<div class="klipper-err-panel"><div class="klipper-err-title">${esc(e.title)}</div>`+
          (e.code?`<div class="klipper-err-code">${listIcon}<span>Error Code: ${esc(e.code)}</span></div>`:'<div style="padding-bottom:4px"></div>')+
          `<div class="klipper-err-divider"></div><div class="klipper-err-body">${esc(e.description)}`+
          (e.url?`<br><a class="klipper-err-link" href="${esc(e.url)}" target="_blank" rel="noopener">Learn more ↗</a>`:'')+
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
        const thumbCell=stem
          ? `<div class="stats-cell stats-thumb-cell" data-thumb="${p.id}" tabindex="0" role="button" title="Click to enlarge"><img class="stats-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)"></div>`
          : `<div class="stats-cell stats-thumb-cell"><span class="stats-thumb-empty">—</span></div>`;
        return `<div class="stats-bar">`+
          `<div class="stats-cell"><div class="stats-cell-label">HOTEND</div><div class="stats-cell-val">${extA}°<span class="stats-sep">/</span><span class="stats-inline-target">${hotendBar.targetTxt}</span></div><div class="stats-mini-bar"><div class="stats-mini-fill" style="${heatBarFillStyle(hotendBar)}"></div></div></div>`+
          `<div class="stats-cell${canAct()?'':' inert-action'}" data-setbed="${p.id}" style="cursor:pointer" title="Click to set bed temp"><div class="stats-cell-label">BED</div><div class="stats-cell-val">${bedA}°<span class="stats-sep">/</span><span class="stats-inline-target">${bedBar.targetTxt}</span></div><div class="stats-mini-bar"><div class="stats-mini-fill" style="${heatBarFillStyle(bedBar)}"></div></div></div>`+
          `<div class="stats-cell"><div class="stats-cell-label">LAYER</div><div class="stats-cell-val">${layer?layer.current:'—'}<span class="stats-inline-target">${layer?'/'+layer.total:''}</span></div></div>`+
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
        const progRowHtml=`<div class="prog-row"><span class="prog-pct ${pctCls}">${pct}%</span>`+
          `<div class="prog-track ${trackCls}"><div class="prog-fill ${fillCls}" style="width:${pct}%;animation-delay:-${(Date.now()/1000%8).toFixed(2)}s"></div></div></div>`;
        // The progress bar itself always renders, error or not (unchanged
        // from before this camera-view work) — only the filename/thumbnail
        // part is hidden on error, in favor of the klipper-err-panel above
        // it. On error, camera view falls back to the bare bar too (no
        // filename to pair the thumbnail's grid span against).
        const fileSection = (p.errorCode||p.message)
          ? progRowHtml
          : camView
            ? `<div class="cam-prog-file">`+
                `<div class="prog-file-thumb"${stem?` data-thumb="${p.id}" tabindex="0" role="button" title="Click to enlarge"`:''}>${stem?`<img class="stats-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)">`:''}</div>`+
                `<span class="prog-file-name">${esc(stem||'—')}</span>`+
                progRowHtml+
              `</div>`
            : `<div class="prog-file">${esc(stem||'—')}</div>`+progRowHtml;
        return `<div class="progress-section">`+
          fileSection+
          (p.errorCode||p.message?'':`<div class="prog-times">`+
          `<div class="prog-time-cell"><span class="prog-time-label">${p.state==='complete'?'Total time':'Elapsed'}</span><span class="prog-time-val">${fmtDuration(p.elapsed)}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          `<div class="prog-time-cell center"><span class="prog-time-label">${camView?'Layer':'Filament'}</span><span class="prog-time-val">${camView?layerTxt:filM}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          (p.state==='complete'
            ? `<div class="prog-time-cell end"><span class="prog-time-label">Finished</span><span class="prog-time-val">${fmtFinishedTime(p.completedAt)}</span></div>`
            : `<div class="prog-time-cell end"><span class="prog-time-label">Remaining</span><span class="prog-time-val">${fmtRemaining(p.elapsed,p.progress)}</span></div>`)+
          `</div>`)+`</div>`;
      })():""}
      ${p.online&&!(p.errorCode||p.message)&&p.capabilities?.filamentHeads?afcLanesHtml(heads,p.activeExt,p.id,!!p.capabilities?.unloadFilament,p.state==='complete'):''}
      ${mapHtml}
      <div class="foot${busy?'':' foot-idle'}">
        ${busy
          ? (p.state==="paused"
                ? `<button class="btn-chip" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="resume" title="Resume"><img src="/print-icon.svg" alt=""><span>Resume</span></button>`
                : `<button class="btn-chip" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="pause" title="Pause"><img src="/pause-icon.svg" alt=""><span>Pause</span></button>`)
            + `<button class="btn-chip danger" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="cancel" title="Cancel"><img src="/stop-icon.svg" alt=""><span>Stop</span></button>`
            + (p.capabilities?.excludeObject&&p.plate&&p.plate.total>1?`<button class="btn-chip" ${canAct()?"":"disabled"} data-plate="${p.id}" title="Plate ${p.plate.total-p.plate.excluded}/${p.plate.total}"><img src="/plate-icon.svg" alt=""><span>Plate</span></button>`:"")
            + `<button class="btn-chip danger" ${canAct()?"":"disabled"} data-estop="${p.id}" title="Emergency Stop"><img src="/estop-icon.svg" alt=""><span>E-Stop</span></button>`
          : `<button class="btn-chip" ${canSend&&canAct()?"":"disabled"} data-id="${p.id}" data-start="0" title="${maintMode?"Printer is in maintenance mode":"Upload to printer"}"><img src="/upload-file.svg" alt=""><span>Upload</span></button>`
            + `<button class="btn-chip" ${p.online&&!busy&&!maintMode&&canAct()?"":"disabled"} data-id="${p.id}" data-start="1" title="${maintMode?"Printer is in maintenance mode":SELECTED?"Print the selected file":"Pick a file already on the printer"}"><img src="/print-icon.svg" alt=""><span>Print</span></button>`
            + `<button class="btn-chip" ${canAct()?"":"disabled"} data-preheat="${p.id}" title="Preheat"><img src="/preheat-icon.svg" alt=""><span>Preheat</span></button>`
            + (p.state==='complete'&&p.filename?`<button class="btn-chip" ${canAct()?"":"disabled"} data-reprint="${p.id}" title="Reprint ${esc(p.filename)}"><img src="/reprint-icon.svg" alt=""><span>Reprint</span></button>`:"")
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
  camFleet.forEach(p=>{
    seen.add(p.id);
    const sig=cardSignature(p);
    const cached=CARD_CACHE.get(p.id);
    let el, rebuilt=true;
    if(incremental && cached && cached.sig===sig){ el=cached.el; rebuilt=false; }
    else {
      el=buildCardHtml(p, need, dragEnabled);
      // A rebuild replaces the cached element with a brand-new one — the
      // previous element is still attached to `wrap` from the last render
      // pass and must be removed here, or it's silently orphaned in the DOM
      // (still visible, no longer reachable via CARD_CACHE) every time this
      // printer's card is rebuilt, i.e. on every poll its displayed data
      // changes — which for an actively-printing card is every single poll.
      if(cached) cached.el.remove();
      CARD_CACHE.set(p.id, { sig, el });
    }
    if(rebuilt && VIEW_MODE==='camera' && p.online && p.capabilities?.camera){
      const slot=el.querySelector('.cam-shot-slot[data-camslot="'+p.id+'"]');
      if(slot) mountCamShot(slot, p.id, camRefreshMs, CAM_STAGGER);
    }
    wrap.appendChild(el);
  });
  for(const [id, entry] of [...CARD_CACHE]){
    if(!seen.has(id)){ entry.el.remove(); CARD_CACHE.delete(id); }
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
  const pctMatch=q.match(/^([<>]=?)\s*(\d+)\s*%?$/);
  const isColor=q in COLOR_FAMILIES;
  const fleet=URL_PRINTER_FILTER ? urlFilterFleet(all)
    : !q ? all : all.filter(p=>{
    if(pctMatch){
      if(!p.online||p.progress==null) return false;
      const pct=p.progress*100, val=parseFloat(pctMatch[2]), op=pctMatch[1];
      return op==='>'?pct>val:op==='>='?pct>=val:op==='<'?pct<val:pct<=val;
    }
    if(isColor) return matchesColorFamily(p.heads, q);
    const statusTxt=p.online?(p.state==='printing'?'printing':p.state==='paused'?'paused':p.state==='error'?'error':p.state==='complete'?'complete':p.state==='cancelled'?'cancelled':'idle'):'offline';
    return [p.brand||"",p.name||"",p.state||"",statusTxt].join(" ").toLowerCase().includes(q);
  });
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
  if(!incremental){ wrap.innerHTML=""; CARD_CACHE.clear(); }
  reconcileFleetCards(camFleet, wrap, camRefreshMs, dragEnabled, !!incremental);
  }
  $("fleetcount").textContent=online+"/"+FLEET.length+" online";
  updateHealthBadge();
  if(gridToolbarActive()) updateCamToolbar();
}

// preTabFleet: the post-search, pre-tab/tag-filter array — tab counts and the
// tag dropdown reflect what's actually available to filter into, not just
// what's currently showing after CAM_TAB/CAM_TAG_FILTER narrow it further.
const CAM_TAB_LABELS = { all:"All", printing:"Printing", attention:"Attention Needed", idle:"Idle", offline:"Offline" };
function renderCamToolbar(preTabFleet){
  const bar=$("camViewBar");
  if(!bar) return;
  const counts={all:preTabFleet.length, printing:0, attention:0, idle:0, offline:0};
  preTabFleet.forEach(p=>{ counts[camBucket(p)]++; });
  document.querySelectorAll("#camTabs button[data-camtab]").forEach(b=>{
    const key=b.dataset.camtab;
    b.textContent=`${CAM_TAB_LABELS[key]} ${counts[key]}`;
    b.classList.toggle("active", CAM_TAB===key);
    b.classList.toggle("zero", counts[key]===0);
  });
  const sel=$("camTagFilter");
  if(sel){
    const tags=[...new Set(FLEET.flatMap(p=>p.tags||[]).filter(t=>!isColorTag(t)))].sort();
    sel.innerHTML=`<option value="">All tags</option>`+tags.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join("");
    sel.value=tags.includes(CAM_TAG_FILTER)?CAM_TAG_FILTER:"";
    CAM_TAG_FILTER=sel.value;
  }
}
// Selection can outlive a printer being removed, or a printer that no longer
// matches the current filter scrolling out of the DOM — prune against the
// live fleet before computing bulk-button eligibility so a stale id never
// silently counts toward "N selected".
const BULK_ACT_DEFS=[
  { act:"pause", verb:"Pause", test:p=>p.state==="printing", reason:"None of the selected printers are printing" },
  { act:"resume", verb:"Resume", test:p=>p.state==="paused", reason:"None of the selected printers are paused" },
  { act:"cancel", verb:"Cancel", test:p=>p.state==="printing"||p.state==="paused", reason:"None of the selected printers are printing or paused" },
];
function updateCamToolbar(){
  for(const id of CAM_SELECTED){ if(!FLEET.some(f=>f.id===id)) CAM_SELECTED.delete(id); }
  for(const id of CAM_SHOT_CACHE.keys()){ if(!FLEET.some(f=>f.id===id)) CAM_SHOT_CACHE.delete(id); }
  const n=CAM_SELECTED.size;
  const cnt=$("camSelCount");
  if(cnt){ cnt.textContent = n>0 ? n+" selected" : "Select all"; cnt.classList.toggle("has-selection", n>0); }
  const selPrinters=[...CAM_SELECTED].map(id=>FLEET.find(f=>f.id===id)).filter(Boolean);
  // Pause/Resume/Cancel only exist in the DOM once something's selected —
  // that's where the row's vertical space comes from when nothing is picked.
  const actionsWrap=$("camBulkActions");
  if(actionsWrap){
    actionsWrap.innerHTML = n===0 ? "" : BULK_ACT_DEFS.map(d=>{
      const eligible=selPrinters.some(d.test);
      return `<button type="button" class="btn ghost" data-bulkact="${d.act}"${eligible?"":` disabled title="${esc(d.reason)}"`}>${d.verb} (${n})</button>`;
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
const BULK_ACT_LABELS = { pause:"paused", resume:"resumed", cancel:"cancelled" };
async function bulkCtl(act){
  const eligible=[...CAM_SELECTED].filter(id=>{
    const p=FLEET.find(f=>f.id===id);
    if(!p) return false;
    return act==='pause' ? p.state==='printing' : act==='resume' ? p.state==='paused' : p.state==='printing'||p.state==='paused';
  });
  if(!eligible.length) return;
  if(act==='cancel'){
    const names=eligible.map(id=>{ const p=FLEET.find(f=>f.id===id); return p?p.name:id; });
    if(!confirm(`Cancel ${eligible.length} print${eligible.length>1?'s':''}? This can't be undone.\n\n`+names.join("\n"))) return;
  }
  const msg=$("camBulkMsg");
  if(msg){ msg.className="pstatus work"; msg.textContent="Working…"; }
  const results=await Promise.allSettled(eligible.map(async id=>{
    const r=await postJSON("/api/printctl",{printer:id,action:act});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
  }));
  const okCount=results.filter(r=>r.status==='fulfilled').length;
  const skipped=CAM_SELECTED.size-eligible.length;
  if(msg){
    msg.className="pstatus "+(okCount===eligible.length?"ok":"err");
    msg.textContent=`${okCount} ${BULK_ACT_LABELS[act]}`+(eligible.length-okCount?`, ${eligible.length-okCount} failed`:'')+(skipped?`, ${skipped} not eligible`:'');
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
      `<input type="text" class="field tags-row-input" data-tagsorig="${esc(val)}" value="${esc(val)}" placeholder="comma-separated tags">`+
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
    `<th class="list-th-sort" data-listsort="name">Printer <span class="list-sort-arrow">${sortArrow}</span></th>`+
    `<th>Tags</th><th>File</th><th>Status</th><th class="list-th-cam"></th><th>Progress</th><th>Layers</th><th>Filament</th><th>Actions</th>`+
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
    const fileCell=stem
      ? `<div class="list-file-cell" data-thumb="${p.id}" tabindex="0" role="button" title="Click to enlarge"><img class="list-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)"><span class="list-file-name">${esc(stem)}</span></div>`
      : `<span class="list-file-empty">—</span>`;
    const pct=p.online&&p.progress!=null?p.progress*100:null;
    const pctCls=p.state==='error'?'red':p.state==='paused'?'amber':p.state==='complete'?'green':'cyan';
    const trackCls=p.state==='error'?'red':p.state==='paused'?'amber':'';
    const listLayer=layerDisplay(p);
    // Second line only means something while there's an active countdown or a
    // finish time to report — idle/error/cancelled rows already say so via
    // the 0% (or frozen %) above; a "—" placeholder there just adds noise.
    const progressMeta = p.state==='complete' ? fmtFinishedTime(p.completedAt)
      : (p.state==='printing'||p.state==='paused') ? fmtRemaining(p.elapsed,p.progress)
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
          if(!h||!h.loaded) return `<span class="list-filament-chip empty" title="Empty"></span>`;
          const hex=h.hex||'#3a3f49';
          const dark=needsDarkText(hex);
          return `<span class="list-filament-chip" style="background:${esc(hex)};color:${dark?'#111':'#fff'}" title="${esc(h.material||'')}">${esc((h.material||'?').toUpperCase().slice(0,4))}</span>`;
        }).join("")) || `<span class="list-file-empty">—</span>`
      : `<span class="list-file-empty">—</span>`;
    const actionsCell=busy
      ? (p.state==="paused"
            ? `<button class="btn-chip icon-only" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="resume" title="Resume"><img src="/print-icon.svg" alt=""></button>`
            : `<button class="btn-chip icon-only" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="pause" title="Pause"><img src="/pause-icon.svg" alt=""></button>`)
        + `<button class="btn-chip icon-only danger" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="cancel" title="Cancel"><img src="/stop-icon.svg" alt=""></button>`
        + `<button class="btn-chip icon-only danger" ${canAct()?"":"disabled"} data-estop="${p.id}" title="Emergency Stop"><img src="/estop-icon.svg" alt=""></button>`
      : `<button class="btn-chip icon-only" ${canSend&&canAct()?"":"disabled"} data-id="${p.id}" data-start="0" title="${maintMode?"Printer is in maintenance mode":"Upload to printer"}"><img src="/upload-file.svg" alt=""></button>`
        + `<button class="btn-chip icon-only" ${p.online&&!busy&&!maintMode&&canAct()?"":"disabled"} data-id="${p.id}" data-start="1" title="${maintMode?"Printer is in maintenance mode":SELECTED?"Print the selected file":"Pick a file already on the printer"}"><img src="/print-icon.svg" alt=""></button>`
        + `<button class="btn-chip icon-only" ${canAct()?"":"disabled"} data-preheat="${p.id}" title="Preheat"><img src="/preheat-icon.svg" alt=""></button>`;
    const tr=document.createElement("tr");
    tr.className="list-row"+(p.online?"":" offline");
    tr.innerHTML=`<td class="list-th-chk"><label class="cam-select"><input type="checkbox" class="cam-chk checkbox-input" data-camsel="${p.id}"${CAM_SELECTED.has(p.id)?' checked':''}></label></td>`+
      `<td class="list-printer-cell"><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name" title="${esc(p.name)}">${esc(p.name)}</div></td>`+
      `<td>${(p.tags||[]).filter(t=>!isColorTag(t)).map(t=>`<span class="list-tag">${esc(t)}</span>`).join("")||'<span class="list-file-empty">—</span>'}</td>`+
      `<td>${fileCell}</td>`+
      `<td><span class="status-badge" style="--status-color:${statusColor}">${statusTxt}</span></td>`+
      `<td class="list-th-cam">${p.capabilities?.camera?`<button class="pill-btn pill-btn-sm list-status-cam" data-snap="${p.id}" title="View ${esc(p.name)}'s camera"><img src="/camera-pill.svg" alt="Camera"></button>`:''}</td>`+
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
  if(qf.status==='queued') return `<div class="queued-banner work">Queued <b>${esc(qf.name)}</b> — waiting for this printer to go idle…</div>`;
  if(qf.status==='uploading') return `<div class="queued-banner work">Staging <b>${esc(qf.name)}</b> on this printer…</div>`;
  if(qf.status==='error') return `<div class="queued-banner err">Couldn't stage ${esc(qf.name)}: ${esc(qf.error||'')}</div>`;
  return '';
}
async function printQueuedFile(printerId, filename, prefs){
  const st=$("pst-"+printerId);
  if(st){ st.className="pstatus work"; st.textContent="Starting print…"; }
  let ok=false;
  try{
    const r=await postJSON("/api/printfile",{printer:printerId,filename,map:{},prefs});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    if(st){ st.className="pstatus ok"; st.textContent="Printing "+filename; }
    ok=true;
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
  { key:"flowCalibrate", cap:"flowCalibration", label:"Flow calibration", desc:"Adds a purge and test line before the print starts." },
  { key:"timelapse", cap:"timelapse", label:"Time-lapse", desc:"Capture a time-lapse video of this print." },
  { key:"autoLevel", cap:"autoLevel", label:"Auto-leveling", desc:"Home and probe the bed mesh before this print starts." }
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
  $("qpSubtitle").textContent=p.name+". These settings apply to this print only.";
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
    switchHtml("qpopt-"+o.key, !!QP_PREFS[o.key], o.label, o.desc)
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
    const titleParts=!loaded ? ["Nothing loaded"] : [hex?(nameForHex(hex)||hex):null, h.material].filter(Boolean);
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
  $("qpExtruderFooter").textContent=n?`${n} toolhead${n===1?'':'s'} selected`:"No toolheads selected";
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
  btn.title=blocked?"Select at least one toolhead to calibrate, or turn off flow calibration":"";
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
      $("qpStatus").className="pstatus work"; $("qpStatus").textContent="Starting print…";
      ok=await printQueuedFile(printer, name, prefs);
      if(!ok){ $("qpStatus").className="pstatus err"; $("qpStatus").textContent="Couldn't start the print — see the printer card for details."; }
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
    if(ctlBtn){ ctl(parseInt(ctlBtn.dataset.ctl,10), ctlBtn.dataset.act); return; }
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
  if(extraUI) setRowUI(extraUI, 0, "", "Uploading…");
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
      if(st){ st.className="pstatus ok"; st.textContent="Queued — will upload once idle"; }
      if(extraUI) setRowUI(extraUI, 100, "ok", "Queued");
      if(progressBtn){ progressBtn.style.background=''; progressBtn.disabled=false; }
      ok=true;
    } else {
      ok=await pollJob(d.jobId, st, start, mapped, progressBtn, extraUI);
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
async function pollJob(jobId, st, start, mapped, btn, extraUI){
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
    if(d.phase==="upload" && d.total){
      const pct=Math.min(100,Math.round(d.sent/d.total*100));
      setBtnFill(btn, pct);
      if(extraUI) setRowUI(extraUI, pct, "work", "Uploading "+pct+"%");
    }
    else if(d.phase==="mapping"){
      if(st){ st.className="pstatus work"; st.textContent="Setting head mapping…"; } setBtnFill(btn,100);
      if(extraUI) setRowUI(extraUI, 100, "work", "Setting head mapping…");
    }
    else if(d.phase==="starting"){
      if(st){ st.className="pstatus work"; st.textContent="Starting print…"; } setBtnFill(btn,100);
      if(extraUI) setRowUI(extraUI, 100, "work", "Starting print…");
    }
    if(d.done){
      const doneTxt=(start?"Printing on "+((d.result&&d.result.printer)||""):"Uploaded")+(mapped?" — heads mapped":"");
      if(st){ st.className="pstatus ok"; st.textContent=doneTxt; }
      if(extraUI) setRowUI(extraUI, 100, "ok", doneTxt);
      if(btn){ btn.style.background=''; btn.disabled=false; }
      return true;
    }
  }
}

// ---- Eject / deselect job ----
function clearJobSelection(){
  SELECTED=null; MAP=null;
  $('jobcard').classList.remove('show');
  $('jobsechead').style.display='none';
  $('needcount').textContent='';
  document.querySelectorAll('.job.active').forEach(el=>el.classList.remove('active'));
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
  $('sendtitle').textContent='Send to printers';
  SEND_PREFS={autoLevel:false, flowCalibrate:false, timelapse:false};
  renderSendList();
  renderSendOpts();
  $('sendFooterStatus').textContent='';
  setSendBtnsDisabled(false);
  $('sendmodal').classList.add('show');
}
function closeSendModal(){ $('sendmodal').classList.remove('show'); }

function renderSendList(){
  $('sendlist').innerHTML=urlFilterFleet(FLEET).map(p=>{
    const idle=p.online&&p.state==='idle';
    const dot=p.online?(idle?'var(--ok)':'var(--busy)'):'var(--idle)';
    const statusTxt=p.online?(p.state||'online'):'offline';
    return `<label class="send-row">
      <div class="send-row-fill" data-fill="${esc(p.id)}"></div>
      <input type="checkbox" class="send-chk checkbox-input" data-id="${esc(p.id)}" ${idle?'checked':''}>
      <span class="send-dot" style="background:${dot}"></span>
      <span class="send-name">${esc(p.name)}</span>
      <span class="send-status-txt" data-rst="${esc(p.id)}">${esc(statusTxt)}</span>
    </label>`;
  }).join('');
}

function setSendBtnsDisabled(dis){
  ['doUpload','doUploadPrint','sendSelectAll','sendSelectIdle'].forEach(id=>{ const b=$(id); if(b) b.disabled=dis; });
}

function sendRowUI(id){
  return {
    statusEl: document.querySelector(`.send-status-txt[data-rst="${id}"]`),
    fillEl: document.querySelector(`.send-row-fill[data-fill="${id}"]`)
  };
}

async function doSendUpload(start){
  const checked=[...document.querySelectorAll('.send-chk:checked')].map(c=>c.dataset.id);
  if(!checked.length){ $('sendFooterStatus').textContent='Select at least one printer.'; return; }
  setSendBtnsDisabled(true);
  $('sendFooterStatus').textContent='';
  // Explicit values, straight from whatever's currently checked — see
  // SEND_PREFS's own comment for why this never falls back to a per-printer
  // default the way pfilemodal does.
  const results=await Promise.all(checked.map(id=>pushTo(id,start,sendRowUI(id),SEND_PREFS)));
  const ok=results.filter(Boolean).length;
  $('sendFooterStatus').textContent=ok===checked.length
    ? `Done — ${ok}/${checked.length} succeeded.`
    : `Finished with errors — ${ok}/${checked.length} succeeded.`;
  setSendBtnsDisabled(false);
}

async function doEstop(printerId){
  if(!confirm("Emergency stop will immediately halt the printer and require a firmware restart to recover.\n\nAre you sure?")) return;
  const st=$("pst-"+printerId);
  if(st){ st.className="pstatus work"; st.textContent="Sending emergency stop…"; }
  try{
    const r=await postJSON("/api/printctl",{printer:printerId,action:"estop"});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    if(st){ st.className="pstatus err"; st.textContent="Emergency stopped — firmware restart required"; }
  }catch(e){ if(st){ st.className="pstatus err"; st.textContent=e.message; } }
  setTimeout(loadFleet, 1500);
}

function openPreheat(printerId){
  openBedModal(printerId);
  $("bedmodalinput").value=60;
}

async function ctl(printer, act){
  if(act==="cancel" && !confirm("Cancel this print? This can't be undone.")) return;
  const st=$("pst-"+printer);
  if(st){ st.className="pstatus work"; st.textContent={pause:"Pausing…",resume:"Resuming…",cancel:"Cancelling…"}[act]; }
  try{
    const r=await postJSON("/api/printctl",{printer,action:act});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    if(st){ st.className="pstatus ok"; st.textContent={pause:"Paused",resume:"Resumed",cancel:"Cancelled"}[act]; }
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
    (timeSec>0?`<div class="pfi-row"><span class="pfi-lbl">Print Time</span><span class="pfi-val">${fmtDuration(timeSec)}</span></div>`:'')+
    (totalGrams>0?`<div class="pfi-row"><span class="pfi-lbl">Filament</span><span class="pfi-val">${totalGrams.toFixed(1)} g</span></div>`:'')+
    (totalCost>0?`<div class="pfi-row"><span class="pfi-lbl">Est. Cost</span><span class="pfi-val">$${totalCost.toFixed(2)}</span></div>`:'')+
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
  $("pfiletitle").textContent=p.name+" — Print from printer";
  $("pfileSearch").value="";
  $("pfileinfo").innerHTML="";
  $("pfilelist").innerHTML='<div class="browse-empty">Loading…</div>';
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
  if(!PFILE_FILES.length){ $("pfilelist").innerHTML='<div class="browse-empty">No gcode files stored on this printer.</div>'; return; }
  const q=$("pfileSearch").value.trim().toLowerCase();
  const shown=PFILE_FILES.filter(f=>!q||f.path.toLowerCase().includes(q));
  if(!shown.length){ $("pfilelist").innerHTML='<div class="browse-empty">No files match.</div>'; return; }
  $("pfilelist").innerHTML=shown.map(f=>{
    const bare=stripExt(f.path);
    const disp=bare.length>40?bare.slice(0,37)+"…":bare;
    const isSel=PFILE_SELECTED===f.path;
    const fsBadge=isSel&&PFILE_META&&PFILE_META.isFS?`<img src="/fs-badge.svg" class="fs-badge" title="Full Spectrum">`:``;
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
  $("pfilemap").innerHTML='<div class="browse-empty">Reading colors…</div>';
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
  if(!allHeads.some(x=>x.h&&x.h.loaded)){ wrap.innerHTML='<div class="browse-empty">No filament loaded on this printer.</div>'; return; }
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
  wrap.innerHTML=`<div class="cmap"><div class="cmaphdr-row"><span class="cmaphdr">Model Color</span><span class="cmaphdr">Printer ToolHeads</span></div>${rows}</div>`;
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
  st.textContent="Starting print…";
  $("pfilego").disabled=true;
  try{
    const r=await postJSON("/api/printfile",{printer:PFILE_PRINTER,filename:PFILE_SELECTED,map:ALLOW_MAPPING?PFILE_MAP:{},prefs:PFILE_PREFS});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    st.textContent="Print started";
    setTimeout(()=>{ closePrinterFiles(); loadFleet(); },900);
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
}

// ---- Camera snapshot ----
let SNAP_PRINTER=null;
function openSnapshot(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p) return;
  SNAP_PRINTER=printerId;
  $("snaptitle").textContent=p.name+" — Camera";
  $("snapwrap").innerHTML='<span style="color:var(--ink-dim)">Loading…</span>';
  $("snapts").textContent='';
  $("snapmodal").classList.add("show");
  loadSnapshot();
}
function closeSnapshot(){ $("snapmodal").classList.remove("show"); SNAP_PRINTER=null; }
async function loadSnapshot(){
  if(SNAP_PRINTER===null) return;
  const wrap=$("snapwrap");
  wrap.innerHTML='<span style="color:var(--ink-dim)">Loading…</span>';
  $("snapts").textContent='';
  try{
    // fresh=1: this is an explicit user action (opening the modal, clicking
    // Refresh) — always bypass the server's short-lived snapshot cache
    // (used to throttle the camera-view grid's automatic polling) so a
    // manual refresh never shows the same frame it just showed.
    const r=await fetch('/api/snapshot?printer='+SNAP_PRINTER+'&fresh=1&t='+Date.now());
    if(!r.ok){
      let msg='Server error '+r.status;
      try{ const j=await r.json(); msg=j.error||msg; }catch{}
      wrap.innerHTML='<span style="color:var(--ink-dim)">'+esc(msg)+'</span>';
      return;
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const img=new Image();
    img.style.cssText='max-width:100%;max-height:65vh;border-radius:8px;display:block;margin:0 auto';
    img.onload=()=>{ wrap.innerHTML=''; wrap.appendChild(img); $("snapts").textContent='Captured '+new Date().toLocaleTimeString(); };
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

  $("unloadtitle").textContent="Spool on "+headLabel(ext);
  $("unloadSubtitle").textContent=p.name+".";
  $("unloadmsg").textContent="Are you sure you want to unload "+headLabel(ext)+"?";
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
  $("unloadRfidBadge").innerHTML=isRfid?(UNLOAD_LOCK_ICON+"RFID"):"";
  $("unloadRfidBadge").style.display=isRfid?"":"none";
  $("unloadColorTabs").style.display=hasFixedPalette?"none":"";

  if(isRfid){
    $("unloadLine1").textContent=(h.material||"Unknown material")+(currentHex?" · "+currentHex:"");
    $("unloadRfidNote").textContent="This is an official Snapmaker spool — its color comes from the RFID tag and can't be changed here.";
    $("unloadRfidNote").style.display="";
  } else {
    $("unloadLine1").textContent=(currentName||"Custom")+" · "+(h.material||"Unknown material");
    $("unloadRfidNote").style.display="none";
  }

  SPOOL_MODAL_CURRENT={hex:currentHex,name:currentName};
  SPOOL_MODAL_PENDING={hex:currentHex||"#FFFFFF",name:currentName||"Custom"};
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
  $("unloadAllLabel").textContent="Unload all "+n+" heads instead";
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
  $("unloadYes").textContent=checked?("Unload all "+n+" heads"):("Unload "+headLabel(SPOOL_MODAL_EXT));
}

function renderUnloadPrintWarning(p){
  const el=$("unloadPrintWarning");
  if(p.state==="printing"||p.state==="paused"){
    const pct=(typeof p.progress==="number")?Math.round(p.progress*100):null;
    const msg="This printer is "+p.state+(pct!=null?" ("+pct+"%)":"")+" — unloading will ruin the job if it uses this head.";
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
  st.className="pstatus work"; st.textContent="Unloading…";
  try{
    const r=await postJSON("/api/unload",{printer:printerId,extruders});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent="Unload command sent";
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
  $("unloadtitle").textContent="Spool color";
  $("unloadSubtitle").textContent="Head "+headLabel(SPOOL_MODAL_EXT)+" on "+((p&&p.name)||"")+".";
  $("unloadModeBody").style.display="none";
  $("unloadColorMode").style.display="";
  $("unloadYes").style.display="none";
  $("unloadSaveColorBtn").style.display="";
  $("unloadStatus").textContent="";

  // Always starts fresh from the last-saved value — an unsaved pick from a
  // previous visit to this mode is gone, matching "Cancel discards it".
  SPOOL_MODAL_PENDING={hex:SPOOL_MODAL_CURRENT.hex||"#FFFFFF",name:SPOOL_MODAL_CURRENT.name||"Custom"};
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
  $("unloadtitle").textContent="Spool on "+headLabel(SPOOL_MODAL_EXT);
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
  $("unloadPendingName").textContent=SPOOL_MODAL_PENDING.name||"Custom";
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
  SPOOL_MODAL_PENDING={hex,name:name||"Custom"};
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
  return `<button type="button" class="color-swatch${selected?' selected':''}${isLight?' light':''}" `+
    `style="background:${esc(c.hex)}" aria-pressed="${selected}" `+
    `title="${esc(c.name)} (${esc(c.hex.toUpperCase())})" aria-label="${esc(c.name)}" data-scchex="${esc(c.hex)}" data-sccname="${esc(c.name)}"></button>`;
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
        if(!seen.has(hex)){ seen.add(hex); recent.push({hex,name:nameForHex(hex)||"Custom"}); }
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
    err.textContent='Enter a 3- or 6-digit hex color, with or without "#".';
    err.style.display="block";
    return; // invalid input is never silently reset — it stays exactly as typed
  }
  setPendingColor(norm,"Custom",{skipHexField:true});
}
function applyCustomRgb(){
  const clamp=v=>Math.max(0,Math.min(255,Math.round(Number(v))||0));
  const r=clamp($("unloadR").value), g=clamp($("unloadG").value), b=clamp($("unloadB").value);
  $("unloadR").value=r; $("unloadG").value=g; $("unloadB").value=b;
  const hex="#"+[r,g,b].map(n=>n.toString(16).padStart(2,"0")).join("");
  setPendingColor(hex,"Custom",{skipRgb:true});
}
function applyNativeColor(){
  setPendingColor($("unloadColorInput").value,"Custom",{skipNative:true});
}
async function doApplyUnloadColor(){
  const st=$("unloadStatus");
  const requestedHex=SPOOL_MODAL_PENDING.hex;
  st.className="pstatus work"; st.textContent="Saving color…";
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
function openBedModal(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  $("bedmodaltitle").textContent=(p.brand||'SnapMaker')+" "+p.name+" — Set bed temperature";
  $("bedmodalinput").value="";
  $("bedmodalstatus").textContent="";
  $("bedmodalset").onclick=()=>{
    const t=parseInt($("bedmodalinput").value,10);
    if(!Number.isFinite(t)||t<0||t>100){ $("bedmodalstatus").className="pstatus err"; $("bedmodalstatus").textContent="Temperature must be 0–100°C"; return; }
    doBedSet(printerId,t);
  };
  $("bedmodaloff").onclick=()=>doBedSet(printerId,0);
  $("bedmodal").classList.add("show");
  setTimeout(()=>$("bedmodalinput").focus(),100);
}
function closeBedModal(){ $("bedmodal").classList.remove("show"); }

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

// A printer that's offline, mid-print, errored, or under maintenance can't
// take a bed-temp command — same states server.js's connectors would refuse
// anyway, just surfaced up front instead of failing per-row after the fact.
function bulkheatDisableReason(p){
  if(!p||!p.online) return "Offline";
  if(p.state==="printing") return "Busy";
  if(p.state==="paused") return "Paused";
  if(p.state==="error") return "Error";
  if(p.state==="maintenance") return "Maintenance";
  return null;
}

// The slider/presets always clamp to the LOWEST maxBedTemp among the current
// selection (never the highest) — heating a printer past its own ceiling
// isn't an option just because another selected printer can go higher.
function bulkheatCapInfo(ids){
  const printers=ids.map(id=>FLEET.find(f=>f.id===id)).filter(Boolean);
  if(!printers.length) return { cap:120, note:"Select printers to see the range" };
  const caps=printers.map(p=>(p.capabilities&&Number.isFinite(p.capabilities.maxBedTemp))?p.capabilities.maxBedTemp:120);
  const cap=Math.min(...caps);
  if(caps.every(c=>c===cap)) return { cap, note:`Range 0–${cap}°C` };
  const limiter=printers[caps.indexOf(cap)];
  return { cap, note:`Capped at ${cap}°C by ${esc(limiter.name)}` };
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
    `<span class="bulkheat-model">${esc(p.brand||'Printer')}</span>`+
    `<span class="bulkheat-cur">${curBed}</span>`+
    `<span class="bulkheat-max">${maxT}°C max</span>`+
    (disabled?`<span class="status-badge" style="--status-color:${st.statusColor}">${reason}</span>`:``)+
    `<span class="bulkheat-row-status pstatus" id="bulkheat-st-${p.id}"></span>`+
  `</label>`;
}

function renderBulkHeatList(){
  $("bulkheatList").innerHTML = FLEET.length
    ? FLEET.map(bulkheatRowHtml).join("")
    : `<div class="hint">No printers configured.</div>`;
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
  const t=Math.max(0,Math.min(cap,Math.round(v)));
  BULKHEAT_TEMP=t;
  $("bulkheatSlider").value=t;
  $("bulkheatReadout").textContent=t+"°C";
  $("bulkheatPresets").querySelectorAll(".btn-chip").forEach(b=>{
    b.classList.toggle("active",parseInt(b.dataset.preset,10)===t);
  });
}

function updateBulkHeatSummary(){
  const n=BULKHEAT_SELECTED.size;
  if(!$("bulkheatStagger").checked||n<=1){ $("bulkheatSummary").textContent="All start together"; return; }
  const secs=Math.max(5,parseInt($("bulkheatStaggerSecs").value,10)||60);
  const total=(n-1)*secs;
  $("bulkheatSummary").textContent=`Last printer starts at +${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;
}

// Re-derives everything selection-dependent — count, select-all tri-state,
// the temp cap (and re-clamps the current value against it), and the Go
// button's label — from BULKHEAT_SELECTED. Called on every checkbox change
// rather than threading a diff through, since the full recompute is cheap
// and this only ever runs on user interaction.
function updateBulkHeatToolbar(){
  const eligible=FLEET.filter(p=>!bulkheatDisableReason(p));
  const unavailable=FLEET.length-eligible.length;
  for(const id of [...BULKHEAT_SELECTED]) if(!eligible.some(p=>p.id===id)) BULKHEAT_SELECTED.delete(id);

  const selAll=$("bulkheatSelectAll");
  const n=BULKHEAT_SELECTED.size;
  selAll.checked = eligible.length>0 && n===eligible.length;
  selAll.indeterminate = n>0 && n<eligible.length;
  $("bulkheatCount").textContent = `${n} of ${eligible.length} selected`+(unavailable?` · ${unavailable} unavailable`:'');

  const { cap, note } = bulkheatCapInfo([...BULKHEAT_SELECTED]);
  $("bulkheatCapNote").textContent = note;
  $("bulkheatSlider").max = cap;
  updateBulkHeatTemp(BULKHEAT_TEMP);

  $("bulkheatGo").disabled = n===0;
  $("bulkheatGo").textContent = n ? `Heat ${n} printer${n>1?'s':''}` : "Heat";
  updateBulkHeatSummary();
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
function bulkheatSetRowStatus(id, cls, text){
  const el = document.getElementById("bulkheat-st-"+id);
  if(!el) return;
  el.className = "bulkheat-row-status pstatus "+cls;
  el.textContent = text;
}
async function bulkheatOne(id, temp){
  bulkheatSetRowStatus(id, "work", "Heating…");
  try{
    const r=await postJSON("/api/bedtemp",{printer:id,temp});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    bulkheatSetRowStatus(id, "ok", temp===0 ? "Off" : "Set to "+temp+"°");
  }catch(e){ bulkheatSetRowStatus(id, "err", e.message); }
}
async function doBulkHeat(){
  const ids=[...BULKHEAT_SELECTED];
  const temp=BULKHEAT_TEMP;
  const status=$("bulkheatStatus");
  if(!ids.length){ status.className="pstatus err"; status.textContent="Select at least one printer."; return; }
  const staggered=$("bulkheatStagger").checked;
  const delayMs=staggered ? Math.max(5,parseInt($("bulkheatStaggerSecs").value,10)||60)*1000 : 0;
  BULKHEAT_CANCEL=false;
  $("bulkheatGo").disabled=true;
  $("bulkheatSelectAll").disabled=true;
  $("bulkheatList").querySelectorAll(".bulkheat-chk").forEach(c=>c.disabled=true);
  $("bulkheatCancelQueue").style.display = staggered ? "" : "none";
  status.className="pstatus"; status.textContent="";
  ids.forEach(id=>bulkheatSetRowStatus(id,"","Queued…"));

  if(staggered){
    for(let i=0;i<ids.length;i++){
      if(BULKHEAT_CANCEL) break;
      await bulkheatOne(ids[i], temp);
      if(BULKHEAT_CANCEL) break;
      if(i<ids.length-1) await new Promise(r=>setTimeout(r, delayMs));
    }
    // Anything never reached (cancelled mid-sequence) is still showing its
    // initial "Queued…" placeholder — make that explicit rather than
    // leaving a misleading "about to happen" label behind.
    ids.forEach(id=>{
      const el=document.getElementById("bulkheat-st-"+id);
      if(el && el.textContent==="Queued…") bulkheatSetRowStatus(id,"err","Cancelled");
    });
  } else {
    await Promise.allSettled(ids.map(id=>bulkheatOne(id, temp)));
  }

  const okCount=ids.filter(id=>{
    const el=document.getElementById("bulkheat-st-"+id);
    return el && el.classList.contains("ok");
  }).length;
  const failCount=ids.length-okCount;
  status.className="pstatus "+(failCount?"err":"ok");
  status.textContent=failCount ? `${okCount} of ${ids.length} heated, ${failCount} failed` : `${okCount} of ${ids.length} heated`;

  BULKHEAT_CANCEL=false;
  $("bulkheatGo").disabled=false;
  $("bulkheatSelectAll").disabled=false;
  $("bulkheatList").querySelectorAll(".bulkheat-chk").forEach(c=>{
    const id=parseInt(c.dataset.bulkheatid,10);
    c.disabled=!!bulkheatDisableReason(FLEET.find(f=>f.id===id));
  });
  $("bulkheatCancelQueue").style.display="none";
  loadFleet();
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
  list.innerHTML='<div class="browse-empty">Loading…</div>';
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
      up.textContent="↑  My Computer";
      up.onclick=async()=>{
        list.innerHTML='<div class="browse-empty">Loading…</div>';
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
      list.insertAdjacentHTML("beforeend",'<div class="browse-empty">No subfolders</div>');
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
  if(!/^\d{5}$/.test(zip)){ $("elecResult").innerHTML='<span style="color:var(--bad)">Enter a valid 5-digit ZIP code.</span>'; return; }
  const res=$("elecResult"); res.innerHTML='<span style="color:var(--ink-dim)">Looking up…</span>';
  $("elecApply").style.display="none";
  const btn=$("elecLookup"); btn.disabled=true;
  try{
    const d=await getJSON("/api/electricity-rate?zip="+zip);
    if(d.error){ res.innerHTML=`<span style="color:var(--bad)">${esc(d.error)}</span>`+(d.location?`<br><span style="color:var(--ink-dim)">${esc(d.location)}</span>`:``); return; }
    res.innerHTML=`<b>${esc(d.location)}</b>${d.utility?`<br><span style="color:var(--ink-dim)">${esc(d.utility)}</span>`:``}<br>Base residential rate: <b>${d.cents} ¢/kWh</b> <span style="color:var(--ink-dim)">(= $${d.rate}/kWh)</span>`;
    $("elecApply").style.display="";
    $("elecApply").onclick=()=>{ $("setElectricityRate").value=d.rate; closeElecModal(); };
  }catch(e){ res.innerHTML=`<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  finally{ btn.disabled=false; }
}
async function doBedSet(printerId,temp){
  const st=$("bedmodalstatus");
  st.className="pstatus work"; st.textContent=temp?"Setting bed to "+temp+"°…":"Turning bed off…";
  try{
    const r=await postJSON("/api/bedtemp",{printer:printerId,temp});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=temp?"Bed set to "+temp+"°":"Bed off";
    setTimeout(()=>{ closeBedModal(); loadFleet(); },1200);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// ---- Maintenance modal ----
// One modal, two entry points: the topbar wrench (openMaintReport — any
// printer, picked from the select) and the Settings > Printers row's
// Maintenance button (openMaintenance — opens with that printer preselected).
// Both funnel into openMaintModal(), which loads the picker; switching the
// select (or the initial preselect) calls loadMaintDetail() for that printer.
let MAINT_TOTAL_SEC=null, PRINTERS_CFG=[], MAINT_PRINTERS=[], MAINT_IDX=null;
let MAINT_ENTRIES=[];
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
const MAINT_FREQ_SPEC={
  none:null,
  weekly:{unit:"days",amount:7,label:"Weekly"},
  monthly:{unit:"months",amount:1,label:"Monthly"},
  quarterly:{unit:"months",amount:3,label:"Quarterly"}
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
    $("maintNextScheduled").textContent="Not scheduled";
    $("maintNextHint").textContent="No reminder will be set for this component.";
    return;
  }
  const next=spec.unit==="days"?addDaysClient(date,spec.amount):addMonthsClient(date,spec.amount);
  $("maintNextScheduled").textContent=next?fmtMaintDate(next):"—";
  $("maintNextHint").textContent=date?`Based on ${fmtMaintDate(date)} + ${spec.label}${component?` for ${component}`:''}.`:"";
}

async function openMaintModal(preselectIdx){
  $("maintReportModal").classList.add("show");
  const sel=$("maintPrinterSel");
  sel.innerHTML='<option>Loading…</option>';
  $("maintDetail").style.display="none";
  try{ MAINT_PRINTERS=await getJSON("/api/printers"); }catch{ MAINT_PRINTERS=[]; }
  if(!MAINT_PRINTERS.length){
    sel.innerHTML='<option>No printers configured</option>';
    return;
  }
  sel.innerHTML=MAINT_PRINTERS.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const idx=(preselectIdx!=null&&MAINT_PRINTERS.some(p=>p.id===preselectIdx))?preselectIdx:MAINT_PRINTERS[0].id;
  sel.value=idx;
  loadMaintDetail(idx);
}
function openMaintenance(idx){ openMaintModal(idx); }
function openMaintReport(){ openMaintModal(null); }
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
  $("maintHours").textContent="loading…";
  $("maintWarranty").textContent="—"; $("maintWarranty").classList.remove("warn","bad");
  $("maintLastService").textContent="—";
  $("maintHistory").innerHTML="";
  const p=MAINT_PRINTERS.find(mp=>mp.id===idx);
  $("maintHistoryTitle").textContent="History for "+(p?p.name:"printer");
  MAINT_ENTRIES=[];
  updateNextScheduledPreview();
  MAINT_TOTAL_SEC=null;
  try{
    const d=await getJSON("/api/printer-hours?printer="+idx);
    MAINT_TOTAL_SEC=d.totalSeconds!=null?d.totalSeconds:null;
    $("maintHours").textContent=MAINT_TOTAL_SEC!=null?fmtHours(MAINT_TOTAL_SEC):'unavailable';
  }catch{ $("maintHours").textContent='unavailable'; }
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
  st.className="pstatus work"; st.textContent=offline?"Taking offline…":"Bringing online…";
  try{
    const r=await postJSON("/api/maintenance-mode",{printer:MAINT_IDX,offline});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=d.maintenanceMode?"Printer taken offline":"Printer back online";
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
function renderMaintWarranty(w){
  const el=$("maintWarranty");
  el.classList.remove("warn","bad");
  if(!w||w.status==="unknown"){ el.textContent="Unknown"; return; }
  if(w.status==="expired"){ el.textContent="Expired"; el.classList.add("bad"); return; }
  if(w.status==="expiring"){ el.textContent="Expires "+fmtMaintDate(w.expiry); el.classList.add("warn"); return; }
  el.textContent="Expires "+fmtMaintDate(w.expiry);
}
function renderMaintLastService(entries){
  if(!entries.length){ $("maintLastService").textContent="Never"; return; }
  const last=entries[entries.length-1]; // push order — last pushed is most recent
  $("maintLastService").textContent=`${fmtMaintDate(last.date)} · ${last.component||'—'}`;
}
function applyMaintDetailResponse(d){
  MAINT_ENTRIES=d.entries||[];
  renderMaintWarranty(d.warranty);
  renderMaintLastService(MAINT_ENTRIES);
  renderMaintHistory(MAINT_ENTRIES);
}
async function saveMaintenance(){
  const st=$("maintStatus");
  const date=$("maintDate").value;
  if(!date){ st.className="pstatus err"; st.textContent="Pick a date"; return; }
  const component=$("maintComponentFilter").value.trim();
  if(!component){ st.className="pstatus err"; st.textContent="Pick or type a component"; return; }
  const idx=MAINT_IDX;
  const entry={
    date, comment:$("maintComment").value.trim(), part:$("maintPart").value.trim(),
    hours:MAINT_TOTAL_SEC!=null?fmtHours(MAINT_TOTAL_SEC):'—', totalSeconds:MAINT_TOTAL_SEC,
    component, frequency:$("maintFrequency").value,
    cost:parseFloat($("maintCost").value)||0
  };
  $("maintSave").disabled=true;
  st.className="pstatus work"; st.textContent="Saving…";
  try{
    const r=await postJSON("/api/maintenance",{printer:idx,entry});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent="Saved";
    $("maintComment").value="";
    applyMaintDetailResponse(d);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ $("maintSave").disabled=!$("maintComponentFilter").value.trim(); }
}
function renderMaintHistory(entries){
  if(!entries.length){ $("maintHistory").innerHTML='<div class="empty-list">No service logged yet for this printer.</div>'; return; }
  const sorted=entries.slice().sort((a,b)=>b.date.localeCompare(a.date));
  const rows=sorted.map(e=>`<tr><td>${esc(e.date)}</td><td>${esc(e.component||'—')}</td><td>${esc(e.hours||'—')}</td><td>${esc(CURRENCY)}${(Number(e.cost)||0).toFixed(2)}</td></tr>`).join('');
  $("maintHistory").innerHTML=`<div class="maint-scroll"><table class="maint-table"><thead><tr><th>Date</th><th>Component</th><th>Hours</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
  $("platetitle").textContent="Exclude objects on "+(fp?fp.name:"printer");
  $("plateSubtitle").textContent=`${remaining.length} object${remaining.length===1?'':'s'} still printing. Excluding one stops it for the rest of the job.`;
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
    ? `${n} of ${remaining.length} selected. ${left} keep${left===1?'s':''} printing.`
    : "Nothing selected";
  const btn=$("plateSkip");
  btn.disabled=!n;
  btn.textContent=n?`Exclude ${n} object${n===1?'':'s'}`:"Exclude";
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
    const chip=isEx?'<span class="pi-chip">Skipped</span>':isSel?'<span class="pi-chip stop">Will stop</span>':'<span class="pi-chip">Printing</span>';
    return `<label class="${cls}" ${isEx?"":`data-obj="${esc(o.name)}"`}>`+
      `<input type="checkbox" class="checkbox-input" ${isEx?"disabled":""}${isSel?" checked":""}>`+
      `<span class="pi-num">${n}</span>`+
      `<span class="pi-text"><span class="pi-label">Object ${n}</span><span class="pi-objid" title="${esc(o.name)}">${esc(o.name)}</span></span>`+
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
  st.className="pstatus work"; st.textContent=`Excluding ${names.length}…`;
  $("plateSkip").disabled=true;
  try{
    for(const n of names){
      const r=await postJSON("/api/exclude",{printer:PLATE_PRINTER,name:n});
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    }
    st.className="pstatus ok"; st.textContent=`Excluded ${names.length}`;
    PLATE_SELECTED.clear();
  }catch(e){ st.className="pstatus err"; st.textContent="Couldn't exclude: "+e.message; }
  refreshPlate();
}
function plateSVG(d,numberOf){
  const objs=(d.objects||[]).filter(o=>o.polygon&&o.polygon.length>2);
  if(!objs.length) return '<div class="platenote">No objects reported for this print.</div>';
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
  $("gear").title = open ? "Back" : "Settings";
  $("fleetSearch").style.display = open ? "none" : "";
  $("sortBtn").style.display = open ? "none" : "";
  $("compactBtn").style.display = open ? "none" : "";
  $("filesBtn").style.display = open ? "none" : "";
  if($("bulkHeatBtn")) $("bulkHeatBtn").style.display = open ? "none" : "";
  if($("maintBtn")) $("maintBtn").style.display = open ? "none" : "";
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
  if(!wantOn && !confirm("Disable Remote Access? This stops remote access immediately. The tunnel identity is kept so re-enabling doesn't require setting it up again.")){
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
  try{ await navigator.clipboard.writeText(url); $("raStatus").className="pstatus ok"; $("raStatus").textContent="Copied"; }
  catch{ $("raStatus").className="pstatus err"; $("raStatus").textContent="Could not copy — copy the URL manually"; }
});
$("addPrinter").addEventListener("click",()=>addPrinterRow("","",{},true));
$("collapseAll").addEventListener("click",()=>{
  const btn=$("collapseAll");
  const expanding=btn.textContent.trim()==="Expand All";
  document.querySelectorAll("#setPrinters .prow-details").forEach(d=>{ if(expanding) d.setAttribute("open",""); else d.removeAttribute("open"); });
  btn.textContent=expanding?"Collapse All":"Expand All";
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
  if(!loginName||!password){ st.className="pstatus err"; st.textContent="Login name and password required"; return; }
  const btn=$("bootSubmit"); btn.disabled=true;
  st.className="pstatus work"; st.textContent="Creating…";
  try{
    const r=await postJSON("/api/users",{firstName:$("bootFirst").value.trim(),lastName:$("bootLast").value.trim(),loginName,password,role:"admin",otpEnabled:false});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent="Admin created";
    BOOTSTRAPPED_ADMIN=true;
    $("bootstrapAdmin").style.display="none";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
});
if($("dockerRestartBtn")) $("dockerRestartBtn").addEventListener("click", async ()=>{
  if(!confirm("Restart SnapCon now?\n\nThe dashboard will be briefly unreachable while the container restarts.")) return;
  const st=$("dockerRestartStatus");
  st.className="pstatus work"; st.textContent="Restarting…";
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
    ?"Scan one subnet you specify — e.g. 192.168.2.0, or CIDR like 192.168.22.128/25."
    :"Scans every subnet this SnapCon host is connected to.";
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
  if(!subnet){ $("subnetModalStatus").className="pstatus err"; $("subnetModalStatus").textContent="Enter a subnet first"; return; }
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
function renderMilestoneChips(){
  document.querySelectorAll("#ntfMilestoneChips .btn-chip").forEach(b=>{
    b.classList.toggle("active", NTF_MILESTONES.has(parseInt(b.dataset.pct,10)));
  });
  const n=NTF_MILESTONES.size;
  $("ntfMilestoneHint").textContent = n
    ? `${n} milestone message${n===1?'':'s'} per print, at ${[...NTF_MILESTONES].sort((a,b)=>a-b).join('%, ')}%.`
    : "No percentages selected — pick at least one below, or the switch above has nothing to send.";
}
async function sendProviderTest(provider,btnId,statusId){
  const st=$(statusId), btn=$(btnId);
  st.className="pstatus work"; st.textContent="Sending test…";
  btn.disabled=true;
  try{
    const body={ service:provider, includeImage:$("ntfImage").checked };
    if(provider==="ntfy") body.topic=$("ntfTopic").value.trim();
    else { body.chatId=$("ntfChatId").value.trim(); body.botToken=secretFieldValue($("ntfBotTokenField")); }
    const r=await postJSON("/api/notify-test",body);
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=provider==="telegram"?"Sent — check Telegram":"Sent — check your ntfy app";
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
async function doOtpTest(){
  const st=$("otpTestStatus");
  const svc=otpServiceValue();
  const body={ service: svc };
  if(svc==="ntfy"){
    body.ntfyTopic=$("otpNtfyTopic").value.trim();
  } else if(svc==="telegram"){
    body.chatId=$("otpTelegramChatId").value.trim();
  } else {
    const to=prompt("Send a test OTP email to:");
    if(!to) return; // cancelled
    body.apiKey=$("setResendKey").value.trim();
    body.fromAddress=$("setResendFrom").value.trim();
    body.to=to.trim();
  }
  st.className="pstatus work"; st.textContent="Sending…";
  try{
    const r=await postJSON("/api/otp-test",body);
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent="Sent";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

async function loadFirmware(){
  const st=$("fwStatus"), wrap=$("fwResults"), btn=$("fwGet");
  btn.disabled=true;
  st.className="pstatus work"; st.textContent="Reading firmware from idle printers…";
  wrap.innerHTML="";
  try{
    const rows=await getJSON("/api/firmware");
    // Idle (readable) printers first, then busy, then offline.
    const rank=r=>r.skipped?(r.online?1:2):0;
    rows.sort((a,b)=>rank(a)-rank(b));
    wrap.innerHTML=rows.map(r=>{
      if(r.skipped){
        const why=r.online?("skipped — "+(r.reason||"busy")):("offline"+(r.reason?" — "+r.reason:""));
        return `<div class="fwrow"><input type="checkbox" class="fwchk checkbox-input" id="fwchk-${r.id}" data-id="${r.id}" disabled>`+
               `<div><label for="fwchk-${r.id}" class="fwline1"><b>${esc(r.name)}</b></label><div class="fwskip">${esc(why)}</div></div></div>`;
      }
      // All MCUs usually share one version — collapse to one entry. If any
      // board disagrees, show the majority version plus an amber callout for
      // each outlier (that's the board that missed an update).
      const mcus=r.mcus||[];
      const byVer={};
      mcus.forEach(m=>{ const v=m.version||"—"; (byVer[v]=byVer[v]||[]).push(m); });
      const vers=Object.keys(byVer).sort((a,b)=>byVer[b].length-byVer[a].length);
      let mcuHtml="";
      if(vers.length===1){
        const heads=mcus.filter(m=>m.name!=="mainboard").length;
        mcuHtml=esc(`MCU ${vers[0]} (mainboard + ${heads} toolheads)`);
      } else if(vers.length>1){
        const majority=vers[0];
        const outliers=mcus.filter(m=>(m.version||"—")!==majority);
        mcuHtml=esc(`MCU ${majority} (${byVer[majority].length}/${mcus.length} boards)`)+
          outliers.map(m=>` · <span class="fwdiff">⚠ ${esc(m.name)}: ${esc(m.version||"—")}</span>`).join("");
      }
      const fwTxt="FW "+(r.firmware||"—")+(r.software&&r.software!==r.firmware?" / SW "+r.software:"")+" · Klipper "+(r.klipper||"—");
      return `<div class="fwrow"><input type="checkbox" class="fwchk checkbox-input" id="fwchk-${r.id}" data-id="${r.id}">`+
        `<div><label for="fwchk-${r.id}" class="fwline1"><b>${esc(r.name)}</b><span>${esc(fwTxt)}</span></label>`+
        `<div class="fwline2">${mcuHtml}${r.os?esc(" · "+r.os):""}</div></div></div>`;
    }).join("");
    const read=rows.filter(r=>!r.skipped).length;
    st.className="pstatus ok"; st.textContent=`Read ${read} of ${rows.length} printers`;
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
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
  if(n) bar.querySelector(".dirty-text").textContent=`${n} unsaved change${n===1?'':'s'} on this tab`;
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
    if(!confirm("You have unsaved changes on this tab. Discard them and switch?")) return;
    discardSettingsTab(current);
  }
  document.querySelectorAll(".set-tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===name));
  document.querySelectorAll(".set-panel").forEach(p=>{ p.style.display = p.id==="tab-"+name ? "" : "none"; });
  // A registered tab (currently just General) shows its own sticky dirty
  // footer instead of the shared always-visible Save row. Remote Access and
  // Logs have no batched form to save — enabling/disabling/restarting and
  // viewing logs are both immediate actions — so neither shows a Save row.
  if($("globalSaveRow")) $("globalSaveRow").style.display=(SETTINGS_TAB_TRACKERS[name]||name==="remote"||name==="logs"||name==="queue")?"none":"";
  // Remote Access has its own live status poller — only run it while its tab
  // is actually visible, same reasoning as the fleet poller not running
  // forever in the background for no reason.
  if(name==="remote"){ loadRemoteAccessStatus(); if(!RA_POLL_TIMER) RA_POLL_TIMER=setInterval(loadRemoteAccessStatus, 4000); }
  else if(RA_POLL_TIMER){ clearInterval(RA_POLL_TIMER); RA_POLL_TIMER=null; }
  if(name==="logs") loadAuditLogUI(true);
}

// ---- Remote Access (Cloudflare Tunnel, managed) — Development Preview ----
// Same in-flight-guard pattern as loadFleet() — a slow/offline probe
// shouldn't let polls stack up on top of each other.
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
    renderRemoteAccess(s, Array.isArray(users)?users:[]);
  }catch(e){
    $("raStatus").className="pstatus err"; $("raStatus").textContent=e.message;
  }finally{ RA_INFLIGHT=false; }
}

// The chain is built entirely from real signals already on the status
// object — no step is ever marked "failed" without an actual error behind
// it. Once a step fails, every step after it is "blocked" (not "failed"):
// there's no point calling the edge connection broken when the tunnel
// process backing it never started.
function raChainRows(s){
  const rows=[];
  if(s.localServiceReachable) rows.push({status:"healthy", name:"Local SnapCon service", detail:"Reachable"});
  else if(s.state==="error" && !s.processRunning) rows.push({status:"failed", name:"Local SnapCon service", detail:s.lastError||"Not reachable"});
  else rows.push({status:"pending", name:"Local SnapCon service", detail:"Checking…"});

  let blocked=rows[0].status==="failed";
  if(blocked) rows.push({status:"blocked", name:"Tunnel process", detail:"Blocked"});
  else if(s.processRunning) rows.push({status:"healthy", name:"Tunnel process", detail:s.pid?("pid "+s.pid):"Running"});
  else if(s.state==="error") rows.push({status:"failed", name:"Tunnel process", detail:s.lastError||"Process exited"});
  else rows.push({status:"pending", name:"Tunnel process", detail:s.state==="provisioning"?"Provisioning…":s.state==="downloading"?"Downloading cloudflared…":"Starting…"});

  blocked=blocked||rows[1].status==="failed";
  if(blocked) rows.push({status:"blocked", name:"Cloudflare edge", detail:"Blocked"});
  else if(s.logConnectionSeen) rows.push({status:"healthy", name:"Cloudflare edge", detail:"Connected"});
  else rows.push({status:"pending", name:"Cloudflare edge", detail:"Connecting…"});

  if(blocked) rows.push({status:"blocked", name:"Public address", detail:"Blocked"});
  else if(s.publicEndpointHealthy) rows.push({status:"healthy", name:"Public address", detail:"Reachable"});
  else rows.push({status:"pending", name:"Public address", detail:"Waiting…"});

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
  if(!users.length){ $("raAccountList").innerHTML=`<div class="settings-help">No accounts yet.</div>`; return; }
  $("raAccountList").innerHTML=users.map(u=>{
    const name=(u.firstName||u.lastName) ? esc((u.firstName+" "+u.lastName).trim()) : esc(u.loginName);
    return `<div class="ra-account-row">`+
      `<span class="ra-account-name">${name}</span>`+
      `<span class="ra-account-role">${esc(roleLabel(u.role))}</span>`+
      `<span class="ra-account-otp ${u.otpEnabled?"ok":"warn"}">${u.otpEnabled?"OTP on":"Password only"}</span>`+
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
    ? "Get a public HTTPS address for this SnapCon, tunnelled through Cloudflare."
    : "Requires User Access Management with at least one admin account.";

  $("raGateSection").style.display = gateOk ? "none" : "";
  $("raOffSection").style.display = (gateOk && !on) ? "" : "none";
  $("raOnSection").style.display = (gateOk && on) ? "" : "none";
  $("raAccountsSection").style.display = (gateOk && on) ? "" : "none";

  if(gateOk && !on){
    $("raLastConnLine").textContent = "Last connected: "+(s.lastConnectedAt ? new Date(s.lastConnectedAt).toLocaleString() : "never");
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

async function raSetEnabled(on){
  const st=$("raStatus"); st.className="pstatus work"; st.textContent=on?"Starting…":"Stopping…";
  $("raEnabled").disabled=true;
  try{
    const r=await postJSON("/api/remote-access/"+(on?"enable":"disable"),{});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    st.className="pstatus ok"; st.textContent="";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ loadRemoteAccessStatus(); }
}
async function removeRemoteAccess(){
  if(!confirm("Remove Remote Access? This permanently deletes this device's remote Hub. You will need to complete the verification step again to re-enable it. This cannot be undone.")) return;
  const st=$("raStatus"); st.className="pstatus work"; st.textContent="Removing…";
  $("raRemoveBtn").disabled=true;
  try{
    const r=await postJSON("/api/remote-access/remove",{});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    st.className="pstatus ok"; st.textContent="";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ loadRemoteAccessStatus(); }
}
async function restartRemoteAccessTunnel(){
  const st=$("raStatus"); st.className="pstatus work"; st.textContent="Restarting…";
  $("raRestartBtn").disabled=true;
  try{
    const r=await postJSON("/api/remote-access/restart",{});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    st.className="pstatus ok"; st.textContent="";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ loadRemoteAccessStatus(); }
}
async function viewRemoteAccessLog(){
  const box=$("raLogView");
  if(box.style.display!=="none"){ box.style.display="none"; return; }
  try{
    const d=await getJSON("/api/remote-access/log");
    box.textContent=(d.lines||[]).join("\n")||"(no log output yet)";
  }catch(e){ box.textContent="Failed to load log: "+e.message; }
  box.style.display="block";
  box.scrollTop=box.scrollHeight;
}

// ---- General tab helpers ----
let FOLDER_CHECK_TIMER=null;
// Debounced — fires 500ms after the user stops typing, not on every
// keystroke, since it's a real filesystem + file-count check server-side.
function scheduleFolderCheck(){
  clearTimeout(FOLDER_CHECK_TIMER);
  const el=$("folderCheckStatus");
  const p=$("setFolder").value.trim();
  if(!p){ el.className="settings-help"; el.textContent=""; return; }
  el.className="settings-help"; el.textContent="Checking…";
  FOLDER_CHECK_TIMER=setTimeout(async()=>{
    try{
      const r=await getJSON("/api/check-folder?path="+encodeURIComponent(p));
      if(!r.ok){ el.className="settings-help err"; el.textContent=r.error||"Path not found"; return; }
      if(r.count>0){ el.className="settings-help ok"; el.textContent=`✓ Reachable, ${r.count} file${r.count===1?'':'s'}`; }
      else { el.className="settings-help warn"; el.textContent="⚠ Reachable, but no files found. Check the path, or that it holds files SnapCon scans for (.gcode, .gco, .g, .gx, .3mf)."; }
    }catch{ el.className="settings-help err"; el.textContent="Couldn't check"; }
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
    el.textContent=`≈${perMin} printer requests/min across ${n} printer${n===1?'':'s'}.`;
    return;
  }
  el.className="settings-help warn";
  // Smallest interval that brings the rate back to ≤300/min — 2s is the
  // floor regardless, since sub-2s is its own separate caution.
  const suggested=Math.max(2,Math.ceil((60*n)/300)||2);
  const suggestedRate=Math.round((60/suggested)*n);
  let msg=`≈${perMin} printer requests/min across ${n} printer${n===1?'':'s'}.`;
  if(tooFast) msg+=" Under 2s can overwhelm slower printers.";
  msg+=` Try ${suggested}s instead (≈${suggestedRate}/min).`;
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
    gcodeSyncFolder:$("setGcodeSyncFolder").value.trim(), gcodeSyncRetentionDays:$("setGcodeSyncRetentionDays").value
  };
}
function setGeneralTabValues(v){
  $("setFolder").value=v.folder; scheduleFolderCheck();
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
    telegramToken:secretFieldValue($("ntfBotTokenField"))
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
  applyNtfEnabled();
  syncMilestoneNesting();
  syncProviderCard("ntfyEnabled","ntfyBody");
  syncProviderCard("telegramEnabled","telegramBody");
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
  card.innerHTML=`<div class="settings-warning-title">config.json could not be read on last startup</div>`+
    `<div>SnapCon started with default settings instead of your saved configuration — nothing has been overwritten yet. `+
    (CONFIG_LOAD_QUARANTINE_PATH
      ? `Your previous file was preserved as <b>${esc(CONFIG_LOAD_QUARANTINE_PATH)}</b> for recovery.`
      : `Your previous config.json was left in place, unmodified, in case it can be repaired manually.`)+
    ` Review the settings below and Save once you're ready — this clears automatically after your next save.</div>`;
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
    $("setFolder").value=c.gcodeFolder||"";
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
    $("setResendKey").placeholder=rs.hasApiKey?"•••••••• (saved — leave blank to keep)":"re_...";
    $("setResendFrom").value=rs.fromAddress||"";
    const otp=c.otp||{};
    if(otp.service==="ntfy") $("otpSvcNtfy").checked=true;
    else if(otp.service==="telegram") $("otpSvcTelegram").checked=true;
    else $("otpSvcResend").checked=true;
    $("otpNtfyTopic").value=otp.ntfyTopic||"";
    $("otpTelegramChatId").value=otp.telegramChatId||"";
    // The bot token itself lives under Notifications, not here — just warn
    // if OTP-via-Telegram is picked but no bot has been configured there yet.
    $("otpTelegramBotHint").className="settings-help"+(otp.telegramBotConfigured?"":" warn");
    $("otpTelegramBotHint").textContent=otp.telegramBotConfigured
      ? "Uses the Telegram bot configured on the Notifications tab."
      : "No Telegram bot configured yet — set one up on the Notifications tab first.";
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
    setSecretFieldState($("ntfBotTokenField"), NTF_HAS_TELEGRAM_TOKEN);
    applyNtfEnabled();
    syncMilestoneNesting();
    syncProviderCard("ntfyEnabled","ntfyBody");
    syncProviderCard("telegramEnabled","telegramBody");
    baselineSettingsTab("notif");
    $("setPrinters").innerHTML="";
    PRINTERS_CFG=c.printers||[];
    PRINTERS_CFG.forEach(p=>addPrinterRow(p.name,p.url,{id:p.id,location:p.location,costKwh:p.costKwh,purchaseDate:p.purchaseDate,autoLevel:p.autoLevel,flowCalibrate:p.flowCalibrate,timelapse:p.timelapse,pushNotify:p.pushNotify,forceDefaults:p.forceDefaults,connector:p.connector,filamentMode:p.filamentMode,serial:p.serial,verificationCode:p.verificationCode,hasToken:p.hasToken,tags:p.tags,allowedGroups:p.allowedGroups,printerPoolId:p.printerPoolId}));
    baselinePrintersDirty();
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
    if(!c.configured && !CONFIG_LOAD_FAILED && isAdmin()){ $("setup").classList.add("show"); showSetTab("printers"); $("gear").querySelector("img").src="/back.svg"; $("gear").title="Back"; document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="none"); $("fleetSearch").style.display="none"; $("sortBtn").style.display="none"; $("compactBtn").style.display="none"; if($("filesBtn")) $("filesBtn").style.display="none"; if($("maintBtn")) $("maintBtn").style.display="none"; $("setupmsg").textContent="Welcome — add your printers to get started"; if(!$("setPrinters").children.length) addPrinterRow("",""); }
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
function secretFieldHtml(cls,hasValue,placeholder){
  return `<div class="secret-field" data-cleared="0">`+
    `<input type="password" class="field secret-input ${cls}" style="${hasValue?"display:none":""}" placeholder="${esc(placeholder||"")}" autocomplete="off">`+
    `<div class="secret-chip" style="${hasValue?"":"display:none"}">`+
      `<span class="status-badge" style="--status-color:var(--ok)">Configured</span>`+
      `<button type="button" class="btn ghost secret-replace">Replace</button>`+
      `<button type="button" class="btn ghost secret-clear">Clear</button>`+
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
function switchHtml(id,checked,label,description,disabled){
  return `<label class="switch-row${disabled?' disabled':''}" for="${esc(id)}">`+
    `<input type="checkbox" role="switch" id="${esc(id)}" class="switch-input"${checked?' checked':''}${disabled?' disabled':''}>`+
    `<span class="switch-text"><span class="switch-label">${esc(label)}</span>`+
    (description?`<span class="switch-desc">${esc(description)}</span>`:'')+
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
  minus.type="button"; minus.className="number-step minus"; minus.textContent="−"; minus.tabIndex=-1; minus.setAttribute("aria-label","Decrease");
  const plus=document.createElement("button");
  plus.type="button"; plus.className="number-step plus"; plus.textContent="+"; plus.tabIndex=-1; plus.setAttribute("aria-label","Increase");
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
    const url=row.querySelector(".purl").value.trim().replace(/\/+$/,"");
    const f=url && FLEET.find(p=>(p.url||"").replace(/\/+$/,"")===url);
    const dot=row.querySelector(".prow-status-dot"), stateEl=row.querySelector(".prow-conn-state");
    if(!f){
      dot.style.setProperty("--status-color","var(--ink-faint)"); dot.title="Unknown";
      stateEl.textContent="—"; stateEl.classList.remove("danger");
      return;
    }
    if(!f.online){
      dot.style.setProperty("--status-color","var(--bad)"); dot.title="Offline";
      stateEl.textContent="No response"; stateEl.classList.add("danger");
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
    url:row.querySelector(".purl").value.trim(),
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
    tags:row.querySelector(".ptags").value.trim(),
    allowedGroups:[...row.querySelectorAll(".pgroups-chk:checked")].map(c=>c.value).sort().join(",")
  });
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
      names.push(row.querySelector(".pname").value.trim()||"New Printer");
      changed++;
    }
  });
  let total=changed+PRINTER_REMOVED.length;
  const orderChanged=PRINTER_ORIGINAL_ORDER.length===rows.length&&PRINTER_ORIGINAL_ORDER.some((r,i)=>r!==rows[i]);
  const allNames=[...names,...PRINTER_REMOVED];
  if(orderChanged){ if(!allNames.length) allNames.push("printer order"); total++; }
  return { total, names:[...new Set(allNames)] };
}
function updatePrintersDirtyFooter(){
  const bar=$("printersDirtyBar");
  if(!bar) return;
  const {total,names}=computePrintersDirty();
  if(!total){ bar.style.display="none"; return; }
  const shown=names.slice(0,2).join(", ")+(names.length>2?` +${names.length-2} more`:"");
  bar.style.display="flex";
  bar.querySelector(".dirty-text").textContent=`${total} unsaved change${total===1?'':'s'} on ${shown}`;
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
function addPrinterRow(name,url,opts,autoOpen){
  opts=opts||{};
  const uid=++PROW_UID;
  const displayIp=(url||"").replace(/^https?:\/\//,"").replace(/\/+$/,"");
  const row=document.createElement("div"); row.className="prow";
  // Round-tripped so the server can match "this is the same printer" by a
  // stable id even if name/URL are edited — not just by URL, which broke the
  // moment someone re-IP'd a printer (maintenance history would silently
  // detach). Blank for a brand-new row; the server mints one on first save.
  row.dataset.printerId=opts.id||"";
  const connType=opts.connector||(CONNECTOR_TYPES[0]&&CONNECTOR_TYPES[0].type)||"snapmaker-u1-klipper";
  const connTypeInfo=CONNECTOR_TYPES.find(c=>c.type===connType)||{};
  const modelLabel=connTypeInfo.label||connType;
  // Brand is derived from the connector, never user-typed — the server
  // re-derives it too (never trusts this field), this just keeps the
  // display in sync without a round-trip.
  const brandLabel=connTypeInfo.brand||modelLabel;
  row.innerHTML=
    `<details class="prow-details"${autoOpen?" open":""}>`+
    `<summary>`+
    `<span class="prow-drag-handle" draggable="true" title="Drag to reorder">⠿</span>`+
    `<span class="prow-chevron">▶</span>`+
    `<span class="prow-status-dot" style="--status-color:var(--ink-faint)" title="Unknown"></span>`+
    `<div class="prow-suminfo"><span class="prow-sumname">${esc(name||"New Printer")}</span><span class="prow-sumip">${esc(displayIp||"—")}</span></div>`+
    `<span class="prow-model-badge">${esc(modelLabel)}</span>`+
    `<span class="prow-conn-state">—</span>`+
    `<div class="prow-sumbtns"><div class="prow-menu-wrap">`+
    `<button type="button" class="prow-menu-btn" title="More actions">⋮</button>`+
    `<div class="prow-menu">`+
    `<button type="button" class="prow-menu-item" data-act="maint">Maintenance</button>`+
    `<button type="button" class="prow-menu-item" data-act="up">Move up</button>`+
    `<button type="button" class="prow-menu-item" data-act="down">Move down</button>`+
    `<button type="button" class="prow-menu-item danger" data-act="remove">Remove…</button>`+
    `</div></div></div>`+
    `</summary>`+
    `<div class="prow-body">`+

    `<div class="prow-section"><div class="prow-section-title">Identity</div>`+
    `<div class="maint-row2">`+
    `<div class="maint-field"><label class="fl">Name</label><input class="field pname" maxlength="25" placeholder="U1" value="${esc(name||"")}"></div>`+
    `<div class="maint-field"><label class="fl">Location</label><input class="field ploc" maxlength="30" placeholder="e.g. Office" value="${esc(opts.location||"")}"></div>`+
    `</div>`+
    `<div class="maint-row2" style="margin-top:10px">`+
    `<div class="maint-field"><label class="fl">Brand</label><input class="field pbrand" disabled value="${esc(brandLabel)}"></div>`+
    `<div class="maint-field"><label class="fl">Tags <span class="hint">comma-separated — e.g. filter Camera View, or /red/ to tint the card</span></label><div class="tags-field-row"><input class="field ptags" maxlength="200" placeholder="e.g. garage, /red/" value="${esc((opts.tags||[]).join(", "))}"><span class="tags-row-swatch">${colorTagSwatchHtml((opts.tags||[]).join(", "))}</span></div></div>`+
    `</div>`+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title">Connection</div>`+
    `<div class="maint-field"><label class="fl">URL</label><input class="field purl" placeholder="http://192.168.1.50" value="${esc(url||"")}"></div>`+
    `<div class="maint-row2" style="margin-top:10px">`+
    `<div class="maint-field"><label class="fl">Connector</label><select class="field pconnector">`+
    CONNECTOR_TYPES.map(c=>`<option value="${esc(c.type)}">${esc(c.label||c.type)}</option>`).join("")+
    `</select></div>`+
    `<div class="maint-field"><label class="fl">API token <span class="hint">Moonraker, optional</span></label>${secretFieldHtml("ptoken",!!opts.hasToken,"optional")}</div>`+
    `</div>`+
    `<div class="prow-test-row">`+
    `<button type="button" class="btn ghost ptest">Test connection</button>`+
    `<span class="pstatus ptest-status"></span>`+
    `</div>`+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title">Hardware</div>`+
    `<div class="maint-row2">`+
    `<div class="maint-field"><label class="fl">Serial</label><input class="field pserial" placeholder="optional, or auto-filled on Save" value="${esc(opts.serial||"")}"></div>`+
    `<div class="maint-field"><label class="fl">Access code</label><input class="field pvcode" placeholder="XXXX" maxlength="8" value="${esc(opts.verificationCode||"")}"></div>`+
    `</div>`+
    `<div class="maint-row2" style="margin-top:10px">`+
    `<div class="maint-field"><label class="fl">Purchased</label><input class="field pdate" type="date" value="${esc(opts.purchaseDate||"")}"></div>`+
    `<div class="maint-field"><label class="fl">Power draw, watts</label><input class="field pkwh" type="number" min="0" placeholder="0" value="${esc(opts.costKwh||"")}"></div>`+
    `</div>`+
    `<div class="hint" style="margin-top:6px">Power draw feeds the per-print energy cost estimate (Settings → General → Electricity rate).</div>`+
    `<div class="filmode-wrap" style="display:none;margin-top:10px;max-width:320px">`+
    `<label class="fl">Filament system</label>`+
    `<select class="field pfilmode">`+
    `<option value="single">Single Color</option>`+
    `<option value="cfs">Creality Filament System (CFS)</option>`+
    `</select>`+
    `<div class="hint" style="margin-top:6px">Whether this printer has a CFS multi-slot box attached. Status-only for now — SnapCon doesn't yet drive CFS slot selection at print start.</div>`+
    `</div>`+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title">Behavior</div>`+
    `<div style="margin-bottom:10px">`+
    switchHtml("pforcedefaults-"+uid, opts.forceDefaults!==false, "Force default behavior", "Print always uses the defaults below with no prompt. Turn off to confirm Auto-level / Flow Calibration / Time-lapse (and which toolheads to calibrate, on U1) before each print instead.")+
    `</div>`+
    `<div class="autolevel-wrap" style="margin-bottom:10px">`+
    switchHtml("pautolevel-"+uid,!!opts.autoLevel,"Auto-level","Home and probe the bed mesh before each print")+
    `</div>`+
    `<div class="flowcal-wrap" style="margin-bottom:10px">`+
    switchHtml("pflowcal-"+uid,!!opts.flowCalibrate,"Flow calibration","Run a flow-rate calibration pass before each print")+
    `</div>`+
    `<div class="timelapse-wrap" style="margin-bottom:10px">`+
    switchHtml("ptimelapse-"+uid,!!opts.timelapse,"Time-lapse","Capture a time-lapse video of each print")+
    `</div>`+
    `<div class="hint" style="margin-bottom:10px">These are just the defaults — Print and Send-to-Printers both let you override them per job.</div>`+
    switchHtml("ppushnotify-"+uid,!!opts.pushNotify,"Push notifications","Include this printer in start / pause / error / complete alerts")+
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title">Access</div>`+
    `<div class="settings-help" style="margin-bottom:8px">Which groups can see and use this printer — default: Everyone.</div>`+
    `<div class="pgroups-list">`+groupsChecklistHtml(opts.allowedGroups)+`</div>`+
    `</div>`+

    `<div class="prow-section" style="display:${QUEUE_MANAGEMENT_ENABLED?"":"none"}" data-queue-section>`+
    `<div class="prow-section-title">Queue</div>`+
    `<div class="settings-help" style="margin-bottom:8px">Which Printer Pool this printer belongs to — controls how the bed gets cleared between queued prints.</div>`+
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
  };
  const brandEl=row.querySelector(".pbrand");
  // The Simulator connector has no real hardware address — gatherPrinters()
  // and the server's own /api/config both drop any printer with a blank url
  // from the saved list entirely (silently, no error), so a Dummy printer
  // left with an empty URL field never actually persists no matter how many
  // times Save is clicked. Auto-fill a synthetic, stable one instead of
  // asking the user to invent something meaningless to type in.
  const syncSimulatorUrlField=()=>{
    const urlField=row.querySelector(".purl");
    const isSim=connectorEl.value==="simulator";
    urlField.readOnly=isSim;
    urlField.placeholder=isSim?"Auto-generated — Simulator has no real address":"e.g. http://192.168.1.50";
    if(isSim && !urlField.value.trim()){
      urlField.value="sim://"+Math.random().toString(36).slice(2,10);
      urlField.dispatchEvent(new Event("input",{bubbles:true}));
    }
  };
  connectorEl.addEventListener("change", ()=>{
    syncPrintPrefVisibility();
    const ct=CONNECTOR_TYPES.find(c=>c.type===connectorEl.value)||{};
    modelBadgeEl.textContent=ct.label||connectorEl.value;
    brandEl.value=ct.brand||ct.label||connectorEl.value;
    syncSimulatorUrlField();
  });
  syncPrintPrefVisibility();
  syncSimulatorUrlField();
  // Live-update the summary header as user types
  const nameEl=row.querySelector(".pname"), urlEl=row.querySelector(".purl");
  const sumName=row.querySelector(".prow-sumname"), sumIp=row.querySelector(".prow-sumip");
  nameEl.addEventListener("input",()=>{ sumName.textContent=nameEl.value.trim()||"New Printer"; });
  urlEl.addEventListener("input",()=>{ sumIp.textContent=urlEl.value.replace(/^https?:\/\//,"").replace(/\/+$/,"")||"—"; });
  wireSecretField(row.querySelector(".secret-field"));
  const tagsEl=row.querySelector(".ptags"), tagsSwatch=row.querySelector(".tags-row-swatch");
  if(tagsEl&&tagsSwatch) tagsEl.addEventListener("input",()=>{ tagsSwatch.innerHTML=colorTagSwatchHtml(tagsEl.value); });

  // Overflow menu — stop the click from also toggling the <details> open/closed.
  const menuBtn=row.querySelector(".prow-menu-btn"), menu=row.querySelector(".prow-menu");
  menuBtn.addEventListener("click",e=>{
    e.stopPropagation();
    document.querySelectorAll(".prow-menu.open").forEach(m=>{ if(m!==menu) m.classList.remove("open"); });
    menu.classList.toggle("open");
  });
  row.querySelector('[data-act="maint"]').addEventListener("click",e=>{
    e.stopPropagation(); menu.classList.remove("open");
    const u=row.querySelector(".purl").value.trim();
    const idx=PRINTERS_CFG.findIndex(p=>p.url===u);
    if(idx>=0) openMaintenance(idx);
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
    const pname=nameEl.value.trim()||"this printer";
    if(!confirm(`Remove "${pname}"? This won't take effect until you save.`)) return;
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
    const u=urlEl.value.trim();
    if(!u){ st.className="pstatus err"; st.textContent="Enter a URL first"; return; }
    st.className="pstatus work"; st.textContent="Testing…";
    try{
      const r=await getJSON("/api/test-connection?url="+encodeURIComponent(u)+"&connector="+encodeURIComponent(connectorEl.value));
      if(r.error) throw new Error(r.error);
      const parts=["state: "+(r.state||"unknown")];
      if(r.bed&&typeof r.bed.temp==="number") parts.push("bed: "+r.bed.temp+"°C");
      if(r.firmware&&r.firmware.firmware) parts.push("firmware: "+r.firmware.firmware);
      st.className="pstatus ok"; st.textContent="Reachable — "+parts.join(", ");
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
      if(!row.dataset.printerId){ st.className="pstatus pqueue-status err"; st.textContent="Save this printer first"; return; }
      st.className="pstatus pqueue-status work"; st.textContent="Saving…";
      try{
        const r=checkAuthFailure(await postJSON("/api/printer-pool",{printerId:row.dataset.printerId,printerPoolId:printerPoolEl.value||null}));
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
        // The server saved it, but PRINTERS_CFG is a snapshot fetched once at
        // page-load/gear-open — anything else that reads it (the Queue
        // Management view's per-pool grouping, chiefly) would otherwise
        // keep showing the pre-assignment state until a full reload.
        const cfgEntry=PRINTERS_CFG.find(p=>p.id===row.dataset.printerId);
        if(cfgEntry) cfgEntry.printerPoolId=d.printerPoolId||undefined;
        st.className="pstatus pqueue-status ok"; st.textContent="Saved";
      }catch(e){ st.className="pstatus pqueue-status err"; st.textContent=e.message; }
    });
  }

  row.querySelectorAll(".prow-body input, .prow-body select").forEach(el=>{
    el.addEventListener("input", markPrintersDirty);
    el.addEventListener("change", markPrintersDirty);
  });

  $("setPrinters").appendChild(row);
}

// ---- Logs tab: read-only, paged, admin-only (the whole Settings screen
// already is). LOG_OFFSET/LOG_TOTAL track the current filter's paging —
// reset to 0 by Filter, advanced by Load more. ----
let LOG_OFFSET=0, LOG_TOTAL=0;
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
// target temp, a settings diff, etc.) falls back to plain "key: value".
const LOG_DETAIL_KNOWN_KEYS=new Set(["file","elapsedSec","filamentUsedMm","filamentGramsEst","costEst"]);
function fmtLogDetail(row){
  if(!row.detail) return "";
  let d;
  try{ d=JSON.parse(row.detail); }catch{ return String(row.detail); }
  const parts=[];
  if(d.file) parts.push(d.file);
  const hm=fmtLogHM(d.elapsedSec);
  if(hm) parts.push("time: "+hm);
  if(typeof d.filamentGramsEst==="number") parts.push("filament: ~"+d.filamentGramsEst.toFixed(1)+"g");
  else if(typeof d.filamentUsedMm==="number") parts.push("filament: "+(d.filamentUsedMm/1000).toFixed(2)+"m");
  if(typeof d.costEst==="number") parts.push("est. cost: "+CURRENCY+d.costEst.toFixed(2));
  for(const [k,v] of Object.entries(d)){
    if(LOG_DETAIL_KNOWN_KEYS.has(k)) continue;
    parts.push(k+": "+(v&&typeof v==="object"?JSON.stringify(v):v));
  }
  return parts.join(", ");
}
function renderLogRows(rows, append){
  const body=$("logTableBody");
  const html=rows.map(r=>`<tr><td>${esc(new Date(r.ts).toLocaleString())}</td><td>${esc(r.category)}/${esc(r.event)}</td><td>${esc(r.userLabel||"—")}</td><td>${esc(r.printerName||"—")}</td><td>${esc(fmtLogDetail(r))}</td></tr>`).join("");
  if(append) body.insertAdjacentHTML("beforeend", html);
  else body.innerHTML=html||`<tr><td colspan="5" style="text-align:center;color:var(--ink-faint)">No log entries yet</td></tr>`;
}
async function loadAuditLogUI(reset){
  if(reset) LOG_OFFSET=0;
  const st=$("logStatus");
  st.className="pstatus work"; st.textContent="Loading…";
  const params=new URLSearchParams();
  const q=$("logSearch").value.trim(); if(q) params.set("q",q);
  const cat=$("logCategory").value; if(cat) params.set("category",cat);
  const from=$("logFrom").value; if(from) params.set("from", String(new Date(from+"T00:00:00").getTime()));
  const to=$("logTo").value; if(to) params.set("to", String(new Date(to+"T23:59:59").getTime()));
  params.set("limit", String(LOG_LIMIT));
  params.set("offset", String(LOG_OFFSET));
  try{
    const d=await getJSON("/api/audit-log?"+params.toString());
    if(d.unavailable){
      st.className="pstatus err"; st.textContent="Audit logging isn't available on this server (needs Node 22.5+)";
      $("logTableBody").innerHTML=""; $("logLoadMore").style.display="none";
      return;
    }
    LOG_TOTAL=d.total||0;
    const rows=d.rows||[];
    renderLogRows(rows, !reset);
    st.className="pstatus"; st.textContent=LOG_TOTAL+" entr"+(LOG_TOTAL===1?"y":"ies");
    $("logLoadMore").style.display=(LOG_OFFSET+rows.length<LOG_TOTAL)?"":"none";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// ---- Users tab: each row saves itself immediately, independent of #saveCfg ----
async function loadUsersUI(){
  $("setUsers").innerHTML="";
  try{
    const users=await getJSON("/api/users");
    users.forEach(u=>addUserRow(u));
  }catch{}
}
function roleLabel(r){ return r==='admin'?'Admin':r==='regular'?'Regular':'View Only'; }
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
    `<div class="prow-suminfo"><span class="prow-sumname">${esc(u&&u.loginName?u.loginName:"New User")}</span><span class="prow-sumip">${esc(roleLabel(u?u.role:"view"))}</span></div>`+
    `<div class="prow-sumbtns"><button class="dup" title="Duplicate">⧉</button><button class="rm" title="Remove">×</button></div>`+
    `</summary>`+
    `<div class="prow-body"><div class="prow-rows">`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl">First</span><input class="field ufirst" maxlength="40" value="${esc(u&&u.firstName||"")}" style="width:150px">`+
    `<span class="pi-lbl">Last</span><input class="field ulast" maxlength="40" value="${esc(u&&u.lastName||"")}" style="width:150px">`+
    `</div>`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl">Login</span><input class="field ulogin" maxlength="32" value="${esc(u&&u.loginName||"")}" style="width:150px" autocomplete="off">`+
    `<span class="pi-lbl">Role</span><select class="field urole" style="width:140px">`+
    `<option value="view">View Only</option><option value="regular">Regular</option><option value="admin">Admin</option>`+
    `</select>`+
    `</div>`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl">Email</span><input class="field uemail" type="email" value="${esc(u&&u.email||"")}" style="flex:1;min-width:0">`+
    `<span class="pi-lbl">Phone</span><input class="field uphone" value="${esc(u&&u.phone||"")}" style="width:150px">`+
    `</div>`+
    `<div class="prow-extra">`+
    switchHtml("uotp-"+uid,!!(u&&u.otpEnabled),"OTP Login")+
    `<label title="Password" class="upwrap"><span class="pi-lbl">Password</span> <input class="field upassword" type="password" maxlength="64" placeholder="${u?"leave blank to keep":"required"}" style="max-width:180px" autocomplete="new-password"></label>`+
    `<button type="button" class="btn ghost ugroups">Groups</button>`+
    `<button class="btn primary usave">Save</button>`+
    `<span class="pstatus usave-status"></span>`+
    `</div></div></div></details>`;
  const roleSel=row.querySelector(".urole"); roleSel.value=u?u.role:"view";
  const loginEl=row.querySelector(".ulogin"), sumName=row.querySelector(".prow-sumname"), sumRole=row.querySelector(".prow-sumip");
  loginEl.addEventListener("input",()=>{ sumName.textContent=loginEl.value.trim()||"New User"; });
  roleSel.addEventListener("change",()=>{ sumRole.textContent=roleLabel(roleSel.value); });
  const otpEl=row.querySelector('[id^="uotp-"]'), pwEl=row.querySelector(".upassword"), pwWrap=row.querySelector(".upwrap");
  const syncPwState=()=>{
    pwWrap.style.display=otpEl.checked?"none":"";
    pwEl.disabled=otpEl.checked;
    pwEl.placeholder=row.dataset.userId?"leave blank to keep":"required";
    if(otpEl.checked) pwEl.value="";
  };
  otpEl.addEventListener("change", syncPwState); syncPwState();
  row.querySelectorAll(".dup,.rm").forEach(b=>b.addEventListener("click",e=>e.stopPropagation()));
  row.querySelector(".rm").addEventListener("click",async()=>{
    const id=row.dataset.userId;
    if(!id){ row.remove(); return; }
    if(!confirm('Remove user "'+(loginEl.value||"")+'"? This cannot be undone.')) return;
    try{
      const r=checkAuthFailure(await fetch("/api/users/"+id,{method:"DELETE"}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      row.remove();
    }catch(e){ alert(e.message); }
  });
  // Duplicate copies only role + OTP-enabled — every identity/credential field starts blank.
  row.querySelector(".dup").addEventListener("click",()=>{
    addUserRow({ role: roleSel.value, otpEnabled: otpEl.checked }, true);
  });
  row.querySelector(".ugroups").addEventListener("click",()=>{
    openGroupsModal(row, loginEl.value.trim()||"this user");
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
    if(!body.loginName){ st.className="pstatus usave-status err"; st.textContent="Login name required"; return; }
    const id=row.dataset.userId;
    if(!id&&!otpEl.checked&&!pwEl.value){ st.className="pstatus usave-status err"; st.textContent="Set a password, or enable OTP login"; return; }
    st.className="pstatus usave-status work"; st.textContent="Saving…";
    try{
      const r=checkAuthFailure(id
        ? await fetch("/api/users/"+id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
        : await fetch("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      row.dataset.userId=d.user.id;
      row.dataset.groupIds=JSON.stringify(d.user.groupIds||[]);
      pwEl.value="";
      st.className="pstatus usave-status ok"; st.textContent="Saved";
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
    : `<div class="settings-help">No groups yet — add one below.</div>`;
}
function renderGroupsManageList(){
  $("groupsManageList").innerHTML=GROUPS.map(g=>{
    const isEveryone=g.id===GROUP_EVERYONE_ID;
    return `<div style="display:flex;align-items:center;gap:6px" data-groupid="${esc(g.id)}">`+
      `<input class="field group-rename" value="${esc(g.name)}" maxlength="40" ${isEveryone?"disabled":""} style="flex:1">`+
      (isEveryone?"":`<button type="button" class="btn ghost group-delete" title="Delete group">×</button>`)+
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
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
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
      if(!confirm('Delete group "'+(g?g.name:"")+'"? Any user or printer scoped only to this group falls back to Everyone.')) return;
      try{
        const r=await fetch("/api/groups/"+id,{method:"DELETE"});
        const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
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
  if(!GROUPS.length) return `<div class="settings-help">No groups yet — add one from the Users tab.</div>`;
  return GROUPS.map(g=>`<label class="checkbox-row" style="display:inline-flex;margin:2px 14px 2px 0"><input type="checkbox" class="pgroups-chk checkbox-input" value="${esc(g.id)}" ${sel.has(g.id)?"checked":""}><span class="checkbox-text"><span class="checkbox-label">${esc(g.name)}</span></span></label>`).join("");
}

function gatherPrinters(){
  return [...$("setPrinters").querySelectorAll(".prow")].map(r=>({
    id:r.dataset.printerId||undefined,
    name:r.querySelector(".pname").value.trim(),
    url:r.querySelector(".purl").value.trim(),
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
    filamentMode:r.querySelector(".pfilmode").value==="cfs"?"cfs":undefined,
    serial:r.querySelector(".pserial").value.trim()||undefined,
    verificationCode:r.querySelector(".pvcode").value.trim()||undefined,
    token:secretFieldValue(r.querySelector(".secret-field")),
    tags:r.querySelector(".ptags").value.split(",").map(t=>t.trim()).filter(Boolean),
    allowedGroups:[...r.querySelectorAll(".pgroups-chk:checked")].map(c=>c.value)
  })).filter(p=>p.url);
}
async function runDiscover(subnet){
  const w=$("discwrap"); w.innerHTML='<div class="discrow"><span class="di">Scanning '+(subnet?esc(subnet):'local network')+'… (~10s)</span></div>';
  try{
    const url=subnet?"/api/discover?subnet="+encodeURIComponent(subnet):"/api/discover";
    const d=await getJSON(url);
    if(d.error){ w.innerHTML='<div class="discrow"><span class="di" style="color:var(--bad)">'+esc(d.error)+'</span></div>'; return; }
    if(!d.found.length){ w.innerHTML='<div class="discrow"><span class="di">No printers found on '+esc((d.subnets||[]).join(", "))+'. Add manually instead.</span></div>'; return; }
    const have=new Set(gatherPrinters().map(p=>p.url.replace(/\/+$/,"")));
    w.innerHTML="";
    const newPrinters=[];
    d.found.forEach(f=>{
      const already=have.has(f.url.replace(/\/+$/,""));
      if(!already) newPrinters.push(f);
      const row=document.createElement("div"); row.className="discrow";
      row.innerHTML=`<span class="di"><b>${esc(f.device_name||f.machine_type||"Printer")}</b> · ${esc(f.ip)}${f.mac?" · "+esc(f.mac):""}${f.serial?" · SN: "+esc(f.serial):""}</span>`+
        `<button class="btn ghost" ${already?"disabled":""}>${already?"Added":"Add"}</button>`;
      const btn=row.querySelector("button");
      if(!already) btn.addEventListener("click",()=>{ addPrinterRow(f.device_name||"U1", f.url, {serial:f.serial||""},true); btn.disabled=true; btn.textContent="Added"; });
      w.appendChild(row);
    });
    const aab=$("addAllSave");
    if(newPrinters.length){
      aab.style.display="";
      aab.onclick=async()=>{
        newPrinters.forEach(f=>addPrinterRow(f.device_name||"U1",f.url,{serial:f.serial||""},true));
        w.querySelectorAll("button").forEach(b=>{b.disabled=true;b.textContent="Added";});
        aab.style.display="none";
        await saveConfig();
      };
    } else { aab.style.display="none"; }
  }catch(e){
    const msg=/Unexpected token|not valid JSON|DOCTYPE/i.test(e.message)
      ? "This needs the updated server.js — replace it and restart the hub." : e.message;
    w.innerHTML='<div class="discrow"><span class="di" style="color:var(--bad)">Scan failed: '+esc(msg)+'</span></div>';
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
    const recoveryNote=CONFIG_LOAD_QUARANTINE_PATH
      ? `The original configuration that failed to load has been preserved for recovery as ${CONFIG_LOAD_QUARANTINE_PATH}.`
      : `The original configuration that failed to load has been preserved for recovery.`;
    if(!confirm(`SnapCon could not load the existing configuration on last startup. Saving now will replace the active configuration with the values currently shown here. ${recoveryNote}\n\nSave anyway?`)) return;
  }
  const saveBtn=$("saveCfg");
  if(saveBtn) saveBtn.disabled=true;
  setSaveStatus("work","Saving…");
  // Refuse to send usersEnabled:true until the inline bootstrap-admin form
  // has succeeded — no default/throwaway admin is ever created as a fallback.
  if($("setUsersEnabled").checked && $("bootstrapAdmin").style.display!=="none" && !BOOTSTRAPPED_ADMIN){
    setSaveStatus("err","Create the first Admin account before enabling User Access Management");
    if(saveBtn) saveBtn.disabled=false;
    return;
  }
  // auto-fill empty name/serial from printer before saving
  const prows=[...$("setPrinters").querySelectorAll(".prow")];
  const needProbe=prows.filter(r=>{
    const url=r.querySelector(".purl").value.trim();
    const noName=!r.querySelector(".pname").value.trim();
    const noSerial=!r.querySelector(".pserial").value.trim();
    return url&&(noName||noSerial);
  });
  if(needProbe.length){
    setSaveStatus("work","Probing printers…");
    await Promise.all(needProbe.map(async r=>{
      const url=r.querySelector(".purl").value.trim();
      try{
        const d=await getJSON("/api/probe-printer?url="+encodeURIComponent(url));
        const nameEl=r.querySelector(".pname"), serialEl=r.querySelector(".pserial");
        if(!nameEl.value.trim()&&d.name) nameEl.value=d.name;
        if(!serialEl.value.trim()&&d.serial) serialEl.value=d.serial;
      }catch{}
    }));
    setSaveStatus("work","Saving…");
  }
  const ri=parseInt($("setRefresh").value,10);
  const cr=parseInt($("setCameraRefresh").value,10);
  const fc=parseFloat($("setFilamentCost").value)||0;
  const er=parseFloat($("setElectricityRate").value)||0;
  const tn=$("setTNotation").checked; USE_T_NOTATION=tn;
  ALLOW_MAPPING=$("setAllowMapping").checked; SUGGEST_MATCHING=$("setSuggestMatching").checked;
  CAM_STAGGER=$("setCameraStagger").checked;
  ALT_DISPLAY=$("setAltDisplay").value;
  CURRENCY=$("setCurrency").value.trim()||"$";
  const logsRetentionDays=parseInt($("setLogsRetentionDays").value,10);
  const cameraRetentionDays=parseInt($("setCameraRetentionDays").value,10);
  const gcodeSyncRetentionDays=parseInt($("setGcodeSyncRetentionDays").value,10);
  const body={ gcodeFolder:$("setFolder").value.trim(), logsFolder:$("setLogsFolder").value.trim(), cameraFolder:$("setCameraFolder").value.trim(), gcodeSyncFolder:$("setGcodeSyncFolder").value.trim(), logsRetentionDays:logsRetentionDays>0?logsRetentionDays:undefined, cameraRetentionDays:cameraRetentionDays>0?cameraRetentionDays:undefined, gcodeSyncRetentionDays:gcodeSyncRetentionDays>0?gcodeSyncRetentionDays:undefined, refreshInterval:(ri>=1&&ri<=60)?ri:2, cameraViewRefreshInterval:(cr>=3&&cr<=60)?cr:6, cameraViewStagger:CAM_STAGGER, alternateDisplay:ALT_DISPLAY, currency:CURRENCY, filamentCost:fc>0?fc:undefined, electricityRate:er>0?er:undefined, tNotation:tn||undefined, defaultView:$("setDefaultView").value, siteName:$("setSiteName").value.trim(), allowMapping:ALLOW_MAPPING, suggestMatching:SUGGEST_MATCHING,
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
      telegramBotToken:secretFieldValue($("ntfBotTokenField"))
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
      const url=r.querySelector(".purl").value.trim();
      const matched=(c.printers||[]).find(p=>p.url===url);
      if(matched) r.dataset.printerId=matched.id;
    });
    setSaveStatus("ok","Saved");
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
    baselinePrintersDirty(); // current row values are now what's on file — re-baseline the dirty footer
    baselineSettingsTab("general");
    baselineSettingsTab("notif");
  }catch(e){ setSaveStatus("err",e.message); }
  finally{ if(saveBtn) saveBtn.disabled=false; }
}

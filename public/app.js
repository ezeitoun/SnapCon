

function lookupKlipperError(code, msg){
  if(!code&&!msg) return null;
  const entry=code?ERROR_CODES[code]:null;
  return{code, title:entry?entry.t:(code||'Unknown Error'), description:entry?entry.d:(msg||code||''), url:entry?entry.u:''};
}
const $ = id => document.getElementById(id);
const VERSION = "0.4.1";
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
  if(p.state==="paused") return { statusColor:"#fbbf24", statusTxt:"Paused" };
  if(p.state==="error") return { statusColor:"var(--bad)", statusTxt:"Error" };
  if(p.state==="complete") return { statusColor:"#22C5BE", statusTxt:"Complete" };
  if(p.state==="cancelled") return { statusColor:"var(--bad)", statusTxt:"Cancelled" };
  if(p.state==="maintenance") return { statusColor:"var(--violet-soft)", statusTxt:"Maintenance" };
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
    const show=FILES_OPEN&&!!MAP;
    $("jobsechead").style.display=show?"":"none";
    $("jobcard").classList.toggle("show",show);
  }
}

// ---- Regular / Compact / Camera / List view cycle ----
// Launch state comes from the "Open in Compact Mode" setting (loadConfigUI);
// the header button only switches the current session. The button's icon
// always shows the NEXT mode a click will switch to (existing convention).
let VIEW_MODE = 'regular'; // 'regular' | 'compact' | 'camera' | 'list'
// Settings tab (View)'s "Alternate Display" — 'all' cycles through every
// view (the original behavior); any specific mode instead makes the header
// button a plain two-way toggle between Regular and that one view only.
let ALT_DISPLAY = 'all'; // 'all' | 'compact' | 'camera' | 'list'
const ALL_CYCLE = { regular:'compact', compact:'camera', camera:'list', list:'regular' };
const VIEW_ICON  = { regular:'/view-regular.svg', compact:'/view-compact.svg', camera:'/view-camera.svg', list:'/view-list.svg' };
const VIEW_TITLE = { regular:'Switch to full view', compact:'Switch to compact view', camera:'Switch to camera view', list:'Switch to list view' };
function nextViewMode(){
  if(ALT_DISPLAY==='all') return ALL_CYCLE[VIEW_MODE] || 'regular';
  // Two-state toggle regardless of how VIEW_MODE got here (e.g. left over
  // from a previous "All" setting) — anything that isn't already Regular
  // goes back to Regular; Regular goes to the one configured alternate.
  return VIEW_MODE==='regular' ? ALT_DISPLAY : 'regular';
}
// Camera view and list view share the same toolbar (status tabs, tag
// filter, checkbox multi-select, bulk actions, Edit Tags) — Bambu's own
// farm manager uses one toolbar for both its grid and list modes, and
// there's no reason for a printer's tag or selection state to reset just
// because the user switched between two views that both show it.
function gridToolbarActive(){ return VIEW_MODE==='camera' || VIEW_MODE==='list'; }
function applyViewMode(){
  document.body.classList.toggle('compact', VIEW_MODE==='compact');
  document.body.classList.toggle('camview', VIEW_MODE==='camera');
  document.body.classList.toggle('listview', VIEW_MODE==='list');
  // Selection/filters are grid-toolbar-only state — leaving BOTH camera and
  // list view resets them so the next visit starts clean rather than
  // silently carrying over a stale selection or filter from a previous
  // session; switching between camera and list preserves it.
  if(!gridToolbarActive()){ CAM_SELECTED.clear(); CAM_TAB='all'; CAM_TAG_FILTER=''; }
  const btn = $('compactBtn');
  if(btn){
    const next=nextViewMode();
    btn.querySelector('img').src = VIEW_ICON[next]; btn.title = VIEW_TITLE[next];
  }
  // Camera view polls each printer's snapshot on every fast metadata tick —
  // the server (not the client poll interval) is what actually throttles
  // real camera hardware (see getSnapshotThrottled() in server.js), so
  // there's nothing to re-floor here; this just realigns the fleet poll
  // timer immediately on a mode switch rather than waiting for it to
  // naturally fire next.
  if($("setRefresh")) startFleetRefresh();
}
function cycleViewMode(){
  VIEW_MODE = nextViewMode();
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
  st.className="pstatus work"; st.textContent="Logging in…";
  try{
    const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName,password})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    onLoginSuccess(d.user);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}
async function doRequestOtp(){
  const loginName=$("loginName").value.trim();
  const st=$("loginStatus");
  if(!loginName){ st.className="pstatus err"; st.textContent="Enter your login name first"; return; }
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
}
async function doVerifyOtp(){
  const code=$("otpCode").value.trim();
  const st=$("otpStatus");
  if(!code){ st.className="pstatus err"; st.textContent="Enter the code"; return; }
  st.className="pstatus work"; st.textContent="Verifying…";
  try{
    const r=await fetch("/api/login/otp/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginName:OTP_LOGIN_NAME,code})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    onLoginSuccess(d.user);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
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
  if($("filesBtn")) $("filesBtn").style.display = (act && !settingsOpen) ? "" : "none";
  if($("jobSend")) $("jobSend").style.display = act ? "" : "none";
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
    if($("gear")) $("gear").style.display="none";
    if($("jobsechead")) $("jobsechead").style.display="none";
    if($("jobloading")) $("jobloading").style.display="none";
    if($("jobcard")) $("jobcard").style.display="none";
    const fleetSechead=$("fleetcount")&&$("fleetcount").closest(".sechead");
    if(fleetSechead) fleetSechead.style.display="none";
  }
  await checkVersion(); await loadConfigUI(); await loadFiles(); await initialFleetLoad();
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

function wireUI(){
  wireModal("platemodal", closePlate, ["platex","plateCancel"]);
  $("plateSkip").addEventListener("click", doPlateSkip);
  wireModal("thumbmodal", closeThumb, ["thumbx"]);
  wireModal("snapmodal", closeSnapshot, ["snapx"]);
  wireModal("unloadmodal", closeUnload, ["unloadx","unloadNo"]);
  wireModal("tagsmodal", closeTagsModal, ["tagsx","tagsCancel"]);
  $("tagsSave").addEventListener("click", saveTagsEditor);
  $("camEditTags").addEventListener("click", openTagsEditor);
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
  $("camBulkPause").addEventListener("click",()=>bulkCtl("pause"));
  $("camBulkResume").addEventListener("click",()=>bulkCtl("resume"));
  $("camBulkCancel").addEventListener("click",()=>bulkCtl("cancel"));
  $("unloadColorSwatch").addEventListener("input",()=>{ $("unloadColorHex").value=$("unloadColorSwatch").value.toUpperCase(); });
  $("unloadColorHex").addEventListener("input",()=>{
    let v=$("unloadColorHex").value.trim();
    if(v && v[0]!=="#") v="#"+v;
    if(/^#[0-9a-fA-F]{6}$/.test(v)) $("unloadColorSwatch").value=v;
  });
  $("unloadColorHex").addEventListener("blur",()=>{
    let v=$("unloadColorHex").value.trim();
    if(v && v[0]!=="#") v="#"+v;
    if(/^#[0-9a-fA-F]{6}$/.test(v)) $("unloadColorHex").value=v.toUpperCase();
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
  $("browseBtn").addEventListener("click", openBrowse);
  $("browsego").addEventListener("click", ()=>navigateBrowse($("browsepath").value.trim()));
  $("browsepath").addEventListener("keydown", e=>{ if(e.key==="Enter") navigateBrowse($("browsepath").value.trim()); });
  $("browseok").addEventListener("click", ()=>{ const p=$("browsepath").value.trim(); if(p){ $("setFolder").value=p; scheduleFolderCheck(); updateSettingsDirtyBar("general"); } closeBrowse(); });
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
function stripExt(s){ return s.replace(/\.(gcode|gco|g)$/i,""); }
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
    const fsBadge=(SELECTED===filePath&&MAP&&MAP.isFS)?` <img src="/fs-badge.svg" class="fs-badge" title="Full Spectrum">`:``;
    b.innerHTML=`<div class="jn">${esc(stripExt(f.name))}${fsBadge}</div>`+
      `<div class="jm">${fmtTime(f.mtime)} · ${fmtSize(f.size)}</div>`;
    b.addEventListener("click",e=>fileRowClick(e,filePath,shownPaths));
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
    $("multiselectCount").textContent=n+(n===1?" file":" files")+" selected — drag onto a folder to move";
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
  st.className="pstatus work"; st.textContent="Creating…";
  try{
    const r=await postJSON("/api/files/mkdir",{sub:CURRENT_SUB,name});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    closeNewFolderModal();
    loadFiles(CURRENT_SUB);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
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
    d.innerHTML=`<span class="sw" style="background:${s.hex||'#3a3f49'}"></span><span>${esc(s.type||'PLA')}</span><span class="nx">T${s.i+1}${s.wt?` · ${Math.ceil(parseFloat(s.wt))} g`:''}</span>`;
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
function fmtClock(s){if(s==null)return'—';s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return(h?h+'h ':'')+String(m).padStart(2,'0')+'m '+String(sec).padStart(2,'0')+'s';}
function fmtRemaining(elapsed,progress){if(!elapsed||!progress||progress<=0)return'—';const total=elapsed/progress;const rem=Math.max(0,total-elapsed);return fmtClock(rem);}

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
      renderFleet();
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
  const glow=active?`filter:drop-shadow(0 0 8px ${color}cc);`:'';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 60 60" style="${glow}">
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
function afcLanesHtml(heads,activeExt,printerId){
  const cards=(heads||[]).map((h,i)=>{
    const loaded=h&&h.loaded;
    const active=loaded&&activeExt===i;
    const color=h&&h.hex||'#383a4a';
    const material=h&&h.material||'—';
    const label=headLabel(i);
    const uid=`${printerId}-${i}`;
    const cardStyle=active?`style="border:2px solid ${color}bb;box-shadow:inset 0 0 20px ${color}28,inset 0 0 6px ${color}18;background:${color}14"`:'';
    const hdrStyle=active?`style="color:${color}ee;background:${color}22;border-bottom-color:${color}33"`:'';
    return `<div class="afc-lane-card ${active?'active':'idle'}" ${cardStyle}>
      <div class="afc-lane-hdr" ${hdrStyle}>T${i+1}${material&&material!=='—'?' '+esc(material):''}</div>
      <div class="afc-spool-area">
        <span class="spool-click${canAct()?'':' inert-action'}" data-unload-printer="${printerId}" data-unload-ext="${i}" style="cursor:pointer" title="Unload ${headLabel(i)}">${spoolSvg(color,active,uid)}</span>
        ${active?`<div class="afc-active-label" style="color:${color}cc">ACTIVE</div>`:''}
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

function renderFleet(){
  const need=neededColors();
  const wrap=$("fleet"); wrap.innerHTML="";
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
    renderFleetListRows(camFleet, wrap, camRefreshMs);
  } else {
  // Reordering persists via applyPrinterOrder() -> saveConfig() -> POST
  // /api/config, which is admin-only server-side — gate on isAdmin(), not
  // canAct(), or a Regular user's drag would silently 403 and revert with
  // no visible feedback (Settings, where the error would surface, is hidden
  // from them entirely).
  const camFiltered=gridToolbarActive()&&(CAM_TAB!=='all'||!!CAM_TAG_FILTER);
  const dragEnabled=SORT_MODE==='none'&&!q&&!camFiltered&&isAdmin();
  camFleet.forEach(p=>{
    const card=document.createElement("div");
    card.className="pcard"+(p.online?"":" offline");
    card.dataset.pid=p.id;
    // status pill
    const {statusColor, statusTxt}=statusColorText(p);
    // heads
    const heads=(p.heads||[]);
    const headsHtml=heads.map((h,i)=>{
      if(!h || !h.loaded) return `<div class="h empty"><div class="sw"></div><div class="lab"><div class="ht">${headLabel(i)}</div><div class="hm">—</div></div></div>`;
      // advisory match: is this head close to any needed color?
      let match=false;
      if(need.length){ for(const n of need){ if(n.hex && h.hex && colorDist(n.hex,h.hex)<MATCH_THRESHOLD){ match=true; break; } } }
      return `<div class="h${match?' match':''}"><div class="sw" style="background:${h.hex||'#3a3f49'}"></div>`+
             `<div class="lab"><div class="ht">${headLabel(i)}</div><div class="hm">${esc(h.material||'')}</div><div class="ht" style="margin-top:2px">${h.hex||""}</div></div></div>`;
    }).join("");
    const busy = p.online && (p.state==="printing"||p.state==="paused");
    const maintMode = p.state==="maintenance";
    const canSend = p.online && SELECTED && !busy && !maintMode;
    // per-color head picker (default: greedy nearest distinct head)
    let mapHtml="";
    if(canSend && ALLOW_MAPPING && p.capabilities?.filamentHeads){
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
            const bg=loaded?(h.hex||'#3a3f49'):'#2a2d36';
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
                 `<div class="fsq${fDark?' light-bg':''}" style="background:${n.hex||'#3a3f49'}"><span class="fsq-t">T${n.i+1}</span>${info?`<span class="fsq-info">${esc(info)}</span>`:''}</div>` +
                 `<span class="arrow">${matMismatch?'❌':'➜'}</span><div class="head-btns">${hbtns}</div></div>`;
        }).join("");
        mapHtml=`<div class="cmap"><div class="cmaphdr-row"><span class="cmaphdr">Model Color</span><span class="cmaphdr">Printer ToolHeads</span></div>${rows}</div>`;
      }
    }
    card.innerHTML=`
      <div class="top">${VIEW_MODE==='camera'?`<label class="cam-select"><input type="checkbox" class="cam-chk" data-camsel="${p.id}"${CAM_SELECTED.has(p.id)?' checked':''}></label>`:''}<span class="pn"><span><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name">${esc(p.name)}</div></span></span><div class="card-right">${p.online?`<div class="card-pills">${(p.state==='idle'||p.state==='complete'||p.state==='cancelled')&&p.filename?`<button class="pill-btn pill-btn-sm" ${canAct()?"":"disabled"} data-eject="${p.id}" title="Eject"><img src="/eject-pill.svg" alt="Eject"></button>`:''}${p.capabilities?.camera?`<button class="pill-btn pill-btn-sm" data-snap="${p.id}" title="Camera"><img src="/camera-pill.svg" alt="Camera"></button>`:''}${p.capabilities?.webUi?`<a class="pill-btn pill-btn-sm" href="${esc(p.url||'#')}" target="_blank" rel="noopener" title="Open Web Interface"><img src="/fluidd-pill.svg" alt="Web Interface"></a>`:''}</div>`:''}<span class="status-badge${dragEnabled?' drag-handle':''}"${dragEnabled?' draggable="true" title="Drag to reorder"':''} style="--status-color:${statusColor}">${statusTxt}</span></div></div>
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
        const cold=extT===0&&bedT===0;
        const extPct=Math.min(100,Math.max(0,(extA/Math.max(extT+10,1))*100));
        const bedPct=Math.min(100,Math.max(0,(bedA/Math.max(bedT+5,1))*100));
        // The real filename, unmodified — Moonraker's own thumbnail-path
        // convention (stripping the extension for its "<stem>-300x300.png"
        // cache) is a Klipper-specific detail that belongs inside that
        // connector's getThumbnail(), not baked in here, since a different
        // connector (FlashForge) needs the exact filename instead.
        const stem=p.filename||"";
        const thumbCell=stem
          ? `<div class="stats-cell stats-thumb-cell" data-thumb="${p.id}" title="Click to enlarge"><img class="stats-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)"></div>`
          : `<div class="stats-cell stats-thumb-cell"><span class="stats-thumb-empty">—</span></div>`;
        return `<div class="stats-bar">`+
          `<div class="stats-cell"><div class="stats-cell-label">HOTEND</div><div class="stats-cell-val">${extA}°<span class="stats-sep">/</span><span class="stats-inline-target">${cold?'—':extT+'°'}</span></div><div class="stats-mini-bar"><div class="stats-mini-fill ${cold?'cool-fill':'hot-fill'}" style="width:${extPct}%"></div></div></div>`+
          `<div class="stats-cell${canAct()?'':' inert-action'}" data-setbed="${p.id}" style="cursor:pointer" title="Click to set bed temp"><div class="stats-cell-label">BED</div><div class="stats-cell-val">${bedA}°<span class="stats-sep">/</span><span class="stats-inline-target">${cold?'—':bedT+'°'}</span></div><div class="stats-mini-bar"><div class="stats-mini-fill ${cold?'cool-fill':'warm-fill'}" style="width:${bedPct}%"></div></div></div>`+
          `<div class="stats-cell"><div class="stats-cell-label">LAYER</div><div class="stats-cell-val">${p.layer?p.layer.current:'—'}<span class="stats-inline-target">${p.layer?'/'+p.layer.total:''}</span></div></div>`+
          thumbCell+
          `</div>`;
      })():""}
      ${p.online?(()=>{
        const pct=(p.progress*100).toFixed(1);
        const pctCls=p.state==='error'?'red':p.state==='paused'?'amber':p.state==='complete'?'green':'cyan';
        const trackCls=p.state==='error'?'red':p.state==='paused'?'amber':'';
        const fillCls=pctCls, dotCls=p.state==='paused'?'amber':'';
        const showDot=p.state!=='complete';
        const camView=VIEW_MODE==='camera';
        // Camera view has no room for the temps/thumbnail stats-bar (hidden
        // entirely — see body.camview CSS) and no use for filament meters
        // when the whole point of this view is watching the print happen —
        // layer progress is the one stat from that row worth keeping, and
        // the thumbnail moves up alongside the filename instead.
        const filM=p.filamentUsed!=null?(p.filamentUsed/1000).toFixed(1)+'m':'—';
        const layerTxt=p.layer?p.layer.current+'/'+p.layer.total:'—';
        const stem=p.filename||"";
        // Built once, reused as-is for regular/compact (a sibling of
        // .prog-file, unchanged from before) and nested inside .cam-prog-file
        // for camera view, where the thumbnail spans both the filename row
        // and this row via CSS grid (see .cam-prog-file in style.css).
        const progRowHtml=`<div class="prog-row"><span class="prog-pct ${pctCls}">${pct}%</span>`+
          `<div class="prog-track ${trackCls}"><div class="prog-fill ${fillCls}" style="width:${pct}%;animation-delay:-${(Date.now()/1000%8).toFixed(2)}s"></div>${showDot?`<div class="prog-dot ${dotCls}" style="left:${pct}%"></div>`:''}</div></div>`;
        // The progress bar itself always renders, error or not (unchanged
        // from before this camera-view work) — only the filename/thumbnail
        // part is hidden on error, in favor of the klipper-err-panel above
        // it. On error, camera view falls back to the bare bar too (no
        // filename to pair the thumbnail's grid span against).
        const fileSection = (p.errorCode||p.message)
          ? progRowHtml
          : camView
            ? `<div class="cam-prog-file">`+
                `<div class="prog-file-thumb"${stem?` data-thumb="${p.id}" title="Click to enlarge"`:''}>${stem?`<img class="stats-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)">`:''}</div>`+
                `<span class="prog-file-name">${esc(stem||'—')}</span>`+
                progRowHtml+
              `</div>`
            : `<div class="prog-file">${esc(stem||'—')}</div>`+progRowHtml;
        return `<div class="progress-section">`+
          fileSection+
          (p.errorCode||p.message?'':`<div class="prog-times">`+
          `<div class="prog-time-cell"><span class="prog-time-label">Elapsed</span><span class="prog-time-val">${fmtClock(p.elapsed)}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          `<div class="prog-time-cell center"><span class="prog-time-label">${camView?'Layer':'Filament'}</span><span class="prog-time-val">${camView?layerTxt:filM}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          `<div class="prog-time-cell end"><span class="prog-time-label">Remaining</span><span class="prog-time-val">${fmtRemaining(p.elapsed,p.progress)}</span></div>`+
          `</div>`)+`</div>`;
      })():""}
      ${p.online&&!(p.errorCode||p.message)&&p.capabilities?.filamentHeads?afcLanesHtml(heads,p.activeExt,p.id):''}
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
        }
      </div>
      <div class="pstatus" id="pst-${p.id}"></div>`;
    if(VIEW_MODE==='camera' && p.online && p.capabilities?.camera){
      const slot=card.querySelector('.cam-shot-slot[data-camslot="'+p.id+'"]');
      if(slot) mountCamShot(slot, p.id, camRefreshMs, CAM_STAGGER);
    }
    wrap.appendChild(card);
  });
  }
  $("fleetcount").textContent=online+"/"+FLEET.length+" online";
  wrap.querySelectorAll("button[data-id]").forEach(b=>{
    b.addEventListener("click",()=>{
      const id=parseInt(b.dataset.id,10), start=b.dataset.start==="1";
      // Print with no file selected in SnapCon: offer the printer's own files.
      if(start&&!SELECTED) openPrinterFiles(id);
      else pushTo(id, start);
    });
  });
  wrap.querySelectorAll(".hs-sq").forEach(b=>{
    b.addEventListener("click",()=>{
      const {card,pi,hi}=b.dataset;
      MAPSEL[card+":"+pi]=hi;
      wrap.querySelectorAll(`.hs-sq[data-card="${card}"][data-pi="${pi}"]`).forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
    });
  });
  wrap.querySelectorAll("button[data-ctl]").forEach(b=>{
    b.addEventListener("click",()=>ctl(parseInt(b.dataset.ctl,10), b.dataset.act));
  });
  wrap.querySelectorAll("button[data-plate]").forEach(b=>{
    b.addEventListener("click",()=>openPlate(parseInt(b.dataset.plate,10)));
  });
  wrap.querySelectorAll("[data-thumb]").forEach(el=>{
    el.addEventListener("click",()=>openThumb(parseInt(el.dataset.thumb,10)));
  });
  wrap.querySelectorAll("[data-snap]").forEach(el=>{
    el.addEventListener("click",()=>openSnapshot(parseInt(el.dataset.snap,10)));
  });
  wrap.querySelectorAll("[data-eject]").forEach(el=>{
    el.addEventListener("click",()=>ejectFile(parseInt(el.dataset.eject,10)));
  });
  wrap.querySelectorAll("[data-setbed]").forEach(el=>{
    el.addEventListener("click",()=>openBedModal(parseInt(el.dataset.setbed,10)));
  });
  wrap.querySelectorAll(".spool-click").forEach(el=>{
    el.addEventListener("click",()=>openUnload(parseInt(el.dataset.unloadPrinter,10), parseInt(el.dataset.unloadExt,10)));
  });
  wrap.querySelectorAll("button[data-estop]").forEach(b=>{
    b.addEventListener("click",()=>doEstop(parseInt(b.dataset.estop,10)));
  });
  wrap.querySelectorAll("button[data-preheat]").forEach(b=>{
    b.addEventListener("click",()=>openPreheat(parseInt(b.dataset.preheat,10)));
  });
  wrap.querySelectorAll("button[data-queued-print]").forEach(b=>{
    b.addEventListener("click",()=>printQueuedFile(parseInt(b.dataset.queuedPrint,10), b.dataset.queuedFile));
  });
  wrap.querySelectorAll(".cam-chk").forEach(el=>{
    el.addEventListener("change",()=>{
      const id=parseInt(el.dataset.camsel,10);
      if(el.checked) CAM_SELECTED.add(id); else CAM_SELECTED.delete(id);
      updateCamToolbar();
    });
  });
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
    b.textContent=`${CAM_TAB_LABELS[key]} (${counts[key]})`;
    b.classList.toggle("active", CAM_TAB===key);
  });
  const sel=$("camTagFilter");
  if(sel){
    const tags=[...new Set(FLEET.flatMap(p=>p.tags||[]))].sort();
    sel.innerHTML=`<option value="">All tags</option>`+tags.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join("");
    sel.value=tags.includes(CAM_TAG_FILTER)?CAM_TAG_FILTER:"";
    CAM_TAG_FILTER=sel.value;
  }
}
// Selection can outlive a printer being removed, or a printer that no longer
// matches the current filter scrolling out of the DOM — prune against the
// live fleet before computing bulk-button eligibility so a stale id never
// silently counts toward "N selected".
function updateCamToolbar(){
  for(const id of CAM_SELECTED){ if(!FLEET.some(f=>f.id===id)) CAM_SELECTED.delete(id); }
  for(const id of CAM_SHOT_CACHE.keys()){ if(!FLEET.some(f=>f.id===id)) CAM_SHOT_CACHE.delete(id); }
  const cnt=$("camSelCount"); if(cnt) cnt.textContent=CAM_SELECTED.size+" selected";
  const selPrinters=[...CAM_SELECTED].map(id=>FLEET.find(f=>f.id===id)).filter(Boolean);
  const eligibleFor=act=>selPrinters.some(p=>
    act==='pause' ? p.state==='printing' :
    act==='resume' ? p.state==='paused' :
    p.state==='printing'||p.state==='paused' // cancel
  );
  if($("camBulkPause")) $("camBulkPause").disabled=!eligibleFor('pause');
  if($("camBulkResume")) $("camBulkResume").disabled=!eligibleFor('resume');
  if($("camBulkCancel")) $("camBulkCancel").disabled=!eligibleFor('cancel');
  const selAll=$("camSelectAll");
  if(selAll){
    const chks=[...document.querySelectorAll(".cam-chk")];
    selAll.checked = chks.length>0 && chks.every(c=>c.checked);
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
  if(act==='cancel' && !confirm(`Cancel ${eligible.length} selected print${eligible.length>1?'s':''}? This can't be undone.`)) return;
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
      `</div>`;
  }).join("");
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
  table.innerHTML=`<colgroup>`+
      `<col style="width:32px"><col style="width:19%"><col style="width:9%">`+
      `<col style="width:19%"><col style="width:13%"><col style="width:8%">`+
      `<col style="width:16%"><col style="width:13%">`+
    `</colgroup>`+
    `<thead><tr>`+
    `<th class="list-th-chk"></th>`+
    `<th class="list-th-sort" data-listsort="name">Printer <span class="list-sort-arrow">${sortArrow}</span></th>`+
    `<th>Tags</th><th>File</th><th>Status</th><th>Progress</th><th>Filament</th><th>Actions</th>`+
    `</tr></thead><tbody></tbody>`;
  const tbody=table.querySelector("tbody");
  rows.forEach(p=>{
    const {statusColor, statusTxt}=statusColorText(p);
    const busy=p.online&&(p.state==="printing"||p.state==="paused");
    const maintMode=p.state==="maintenance";
    const canSend=p.online&&SELECTED&&!busy&&!maintMode;
    const stem=p.filename||"";
    const fileCell=stem
      ? `<div class="list-file-cell" data-thumb="${p.id}" title="Click to enlarge"><img class="list-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="thumbRetry(this)"><span class="list-file-name">${esc(stem)}</span></div>`
      : `<span class="list-file-empty">—</span>`;
    const pct=p.online&&p.progress!=null?p.progress*100:null;
    const pctCls=p.state==='error'?'red':p.state==='paused'?'amber':p.state==='complete'?'green':'cyan';
    const trackCls=p.state==='error'?'red':p.state==='paused'?'amber':'';
    const progressCell=pct!=null
      ? `<div class="list-progress">`+
          `<div class="list-progress-row"><span class="list-progress-pct ${pctCls}">${pct.toFixed(0)}%</span>`+
          `<div class="prog-track list-progress-track ${trackCls}"><div class="prog-fill list-progress-fill ${pctCls}" style="width:${pct}%"></div></div></div>`+
          `<div class="list-progress-meta">${fmtRemaining(p.elapsed,p.progress)}${p.layer?` <span class="list-progress-sep">·</span> L${p.layer.current}/${p.layer.total}`:''}</div>`+
        `</div>`
      : `<span class="list-file-empty">—</span>`;
    // Bambu-style [PLA] chip: material name on a background of its own
    // color, one per LOADED toolhead only (unlike the card view's full
    // head grid, an empty-slot placeholder here would just be clutter).
    const filamentCell=p.capabilities?.filamentHeads
      ? ((p.heads||[]).slice(0,4).filter(h=>h&&h.loaded).map(h=>{
          const hex=h.hex||'#3a3f49';
          const dark=needsDarkText(hex);
          return `<span class="list-filament-chip" style="background:${hex};color:${dark?'#111':'#fff'}" title="${esc(h.material||'')}">${esc((h.material||'?').toUpperCase().slice(0,6))}</span>`;
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
    tr.innerHTML=`<td class="list-th-chk"><label class="cam-select"><input type="checkbox" class="cam-chk" data-camsel="${p.id}"${CAM_SELECTED.has(p.id)?' checked':''}></label></td>`+
      `<td class="list-printer-cell"><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name">${esc(p.name)}</div></td>`+
      `<td>${(p.tags||[]).map(t=>`<span class="list-tag">${esc(t)}</span>`).join("")||'<span class="list-file-empty">—</span>'}</td>`+
      `<td>${fileCell}</td>`+
      `<td><span class="status-badge" style="--status-color:${statusColor}">${statusTxt}</span>${p.capabilities?.camera?`<button class="pill-btn pill-btn-sm list-status-cam" data-snap="${p.id}" title="Camera"><img src="/camera-pill.svg" alt="Camera"></button>`:''}</td>`+
      `<td>${progressCell}</td>`+
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
// by /api/notify-load) — a quiet banner + one-click Print, in any view mode.
function queuedFileBannerHtml(p){
  const qf=p.queuedFile;
  if(qf.status==='queued') return `<div class="queued-banner work">Queued <b>${esc(qf.name)}</b> — waiting for this printer to go idle…</div>`;
  if(qf.status==='uploading') return `<div class="queued-banner work">Staging <b>${esc(qf.name)}</b> on this printer…</div>`;
  if(qf.status==='error') return `<div class="queued-banner err">Couldn't stage ${esc(qf.name)}: ${esc(qf.error||'')}</div>`;
  return `<div class="queued-banner ok"><span>Ready to print: <b>${esc(qf.name)}</b></span><button class="btn ghost" data-queued-print="${p.id}" data-queued-file="${esc(qf.name)}">Print</button></div>`;
}
async function printQueuedFile(printerId, filename){
  const st=$("pst-"+printerId);
  if(st){ st.className="pstatus work"; st.textContent="Starting print…"; }
  try{
    const r=await postJSON("/api/printfile",{printer:printerId,filename,map:{}});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    if(st){ st.className="pstatus ok"; st.textContent="Printing "+filename; }
  }catch(e){ if(st){ st.className="pstatus err"; st.textContent=e.message; } }
  loadFleet();
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
async function pushTo(printer, start, extraUI){
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
    const r=await postJSON("/api/print",{file:SELECTED,printer,start,map});
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
function openSendModal(){
  if(!SELECTED) return;
  const name=SELECTED.split(/[/\\]/).pop();
  $('sendfilename').textContent=name;
  $('sendtitle').textContent='Send to Printers';
  renderSendList();
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
      <input type="checkbox" class="send-chk" data-id="${esc(p.id)}" ${idle?'checked':''}>
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
  const results=await Promise.all(checked.map(id=>pushTo(id,start,sendRowUI(id))));
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
    (timeSec>0?`<div class="pfi-row"><span class="pfi-lbl">Print Time</span><span class="pfi-val">${fmtClock(timeSec)}</span></div>`:'')+
    (totalGrams>0?`<div class="pfi-row"><span class="pfi-lbl">Filament</span><span class="pfi-val">${totalGrams.toFixed(1)} g</span></div>`:'')+
    (totalCost>0?`<div class="pfi-row"><span class="pfi-lbl">Est. Cost</span><span class="pfi-val">$${totalCost.toFixed(2)}</span></div>`:'')+
    `</div></div>`;
}

function openPrinterFiles(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  PFILE_PRINTER=printerId; PFILE_SELECTED=null; PFILE_META=null; PFILE_MAP={}; PFILE_FILES=[];
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
function closePrinterFiles(){ $("pfilemodal").classList.remove("show"); PFILE_PRINTER=null; PFILE_SELECTED=null; PFILE_META=null; PFILE_MAP={}; $("pfileinfo").innerHTML=""; }
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
    const disp=bare.length>40?bare.slice(0,37)+"...":bare;
    const isSel=PFILE_SELECTED===f.path;
    const fsBadge=isSel&&PFILE_META&&PFILE_META.isFS?`<img src="/fs-badge.svg" class="fs-badge" title="Full Spectrum">`:``;
    return `<button class="plate-item${isSel?" sel":""}" data-f="${esc(f.path)}" title="${esc(f.path)}">`+
      `<span class="pi-check">${isSel?"✓":""}</span><span class="pi-name">${esc(disp)}${fsBadge}</span>`+
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
  if(!PFILE_META||!ALLOW_MAPPING){ wrap.innerHTML=""; return; }
  const p=FLEET.find(f=>f.id===PFILE_PRINTER);
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
      const bg=loaded?(h.hex||'#3a3f49'):'#2a2d36';
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
           `<div class="fsq${fDark?' light-bg':''}" style="background:${n.hex||'#3a3f49'}"><span class="fsq-t">T${n.i+1}</span>${info?`<span class="fsq-info">${esc(info)}</span>`:''}</div>` +
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
    const r=await postJSON("/api/printfile",{printer:PFILE_PRINTER,filename:PFILE_SELECTED,map:ALLOW_MAPPING?PFILE_MAP:{}});
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
  $("thumbtitle").textContent=p.name+(p.filename?' — '+p.filename:'');
  const w=$("thumbwrap");
  if(!p.filename){ w.innerHTML='<span style="color:var(--ink-dim)">No file loaded</span>'; }
  else {
    const stem=p.filename;
    w.innerHTML='<img src="/api/thumbnail?printer='+p.id+'&file='+encodeURIComponent(stem)+'&t='+thumbToken(p,stem)+'" style="max-width:100%;border-radius:8px" onerror="this.parentNode.innerHTML=\'<span style=color:var(--ink-dim)>No thumbnail available</span>\'">';
  }
  $("thumbmodal").classList.add("show");
}
function closeThumb(){ $("thumbmodal").classList.remove("show"); }

// ---- Unload filament ----
function openUnload(printerId,ext){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  $("unloadtitle").textContent="Unload Filament — "+p.name;
  $("unloadmsg").textContent="Are you sure you want to unload T"+ext+"?";
  $("unloadStatus").textContent="";
  $("unloadYes").onclick=()=>doUnload(printerId,[ext]);
  $("unloadAll").onclick=()=>doUnload(printerId,[0,1,2,3]);
  // Only some connectors can write a slot's color/material label back to the
  // printer itself (currently just FlashForge's AD5X material station) — the
  // button stays hidden for everything else rather than pretending it works.
  const supportsColor=!!(p.capabilities&&p.capabilities.setColor);
  $("unloadColorPicker").style.display="none";
  $("unloadColorGrid").style.display="none";
  $("unloadColorGeneric").style.display="none";
  $("unloadColorBtn").style.display=supportsColor?"":"none";
  if(supportsColor){
    let current=((p.heads&&p.heads[ext]&&p.heads[ext].hex)||"#FFFFFF").toUpperCase();
    // <input type="color"> silently rejects anything without a leading "#"
    // (falling back to black) rather than erroring — guard here too, not
    // just at the connector, since a stray unprefixed hex anywhere upstream
    // would otherwise show as "you picked X but got black" with no clue why.
    if(current[0]!=="#") current="#"+current;
    $("unloadColorBtn").onclick=()=>{ $("unloadColorPicker").style.display="block"; };
    if(Array.isArray(p.colorPalette)&&p.colorPalette.length){
      // AD5X (so far the only connector with this): the printer only has
      // icons for a fixed color set, so the picker only ever offers exactly
      // those — no arbitrary hex entry, nothing to snap.
      const grid=$("unloadColorGrid");
      grid.innerHTML=p.colorPalette.map(c=>{
        const hex=c.hex.toUpperCase();
        return `<button class="color-swatch${hex===current?' active':''}" style="background:${esc(c.hex)}" title="${esc(c.name)}" data-hex="${esc(c.hex)}"></button>`;
      }).join("");
      grid.style.display="grid";
      grid.querySelectorAll(".color-swatch").forEach(btn=>{
        btn.addEventListener("click",()=>doSetColor(printerId,ext,btn.dataset.hex));
      });
    } else {
      $("unloadColorSwatch").value=current;
      $("unloadColorHex").value=current;
      $("unloadColorGeneric").style.display="block";
      $("unloadColorSave").onclick=()=>doSetColor(printerId,ext,$("unloadColorHex").value);
    }
  }
  $("unloadmodal").classList.add("show");
}
function closeUnload(){ $("unloadmodal").classList.remove("show"); }
async function doUnload(printerId,extruders){
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
async function doSetColor(printerId,ext,hex){
  let v=(hex||"").trim();
  if(v && v[0]!=="#") v="#"+v;
  const st=$("unloadStatus");
  if(!/^#[0-9a-fA-F]{6}$/.test(v)){ st.className="pstatus err"; st.textContent="Enter a valid color, e.g. #FF0000"; return; }
  st.className="pstatus work"; st.textContent="Saving color…";
  try{
    const r=await postJSON("/api/filament-color",{printer:printerId,extruder:ext,hex:v});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    // The printer may snap to its own supported palette (e.g. AD5X's
    // touchscreen only has icons for a fixed color set) — say so rather than
    // implying the exact pick was applied when it might not have been.
    const applied=(d.hex||v).toUpperCase();
    if(applied!==v.toUpperCase()){
      st.className="pstatus ok"; st.textContent="Closest supported color applied: "+applied;
      $("unloadColorSwatch").value=applied; $("unloadColorHex").value=applied;
    } else {
      st.className="pstatus ok"; st.textContent="Color updated";
    }
    setTimeout(()=>{ closeUnload(); loadFleet(); },applied!==v.toUpperCase()?2200:1200);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}

// ---- Bed temperature modal ----
function openBedModal(printerId){
  const p=FLEET.find(f=>f.id===printerId);
  if(!p||!p.online) return;
  $("bedmodaltitle").textContent=(p.brand||'SnapMaker')+" "+p.name+" — Set Bed Temp";
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
    `<input type="checkbox" class="bulkheat-chk" data-bulkheatid="${p.id}"${checked?' checked':''}${disabled?' disabled':''}>`+
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
function openBrowse(){ $("browsemodal").classList.add("show"); navigateBrowse(null); }
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
  try{
    const d=await getJSON("/api/electricity-rate?zip="+zip);
    if(d.error){ res.innerHTML=`<span style="color:var(--bad)">${esc(d.error)}</span>`+(d.location?`<br><span style="color:var(--ink-dim)">${esc(d.location)}</span>`:``); return; }
    res.innerHTML=`<b>${esc(d.location)}</b>${d.utility?`<br><span style="color:var(--ink-dim)">${esc(d.utility)}</span>`:``}<br>Base residential rate: <b>${d.cents} ¢/kWh</b> <span style="color:var(--ink-dim)">(= $${d.rate}/kWh)</span>`;
    $("elecApply").style.display="";
    $("elecApply").onclick=()=>{ $("setElectricityRate").value=d.rate; closeElecModal(); };
  }catch(e){ res.innerHTML=`<span style="color:var(--bad)">${esc(e.message)}</span>`; }
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
    return `<button class="${cls}" ${isEx?"disabled":`data-obj="${esc(o.name)}"`}>`+
      `<span class="pi-num">${n}</span>`+
      `<span class="pi-text"><span class="pi-label">Object ${n}</span><span class="pi-objid" title="${esc(o.name)}">${esc(o.name)}</span></span>`+
      chip+
      `</button>`;
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
  if(open){
    document.body.classList.remove("showfiles"); loadUsersUI();
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
  st.className="pstatus work"; st.textContent="Creating…";
  try{
    const r=await postJSON("/api/users",{firstName:$("bootFirst").value.trim(),lastName:$("bootLast").value.trim(),loginName,password,role:"admin",otpEnabled:false});
    const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent="Admin created";
    BOOTSTRAPPED_ADMIN=true;
    $("bootstrapAdmin").style.display="none";
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
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
        return `<div class="fwrow"><input type="checkbox" class="fwchk" id="fwchk-${r.id}" data-id="${r.id}" disabled>`+
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
      return `<div class="fwrow"><input type="checkbox" class="fwchk" id="fwchk-${r.id}" data-id="${r.id}">`+
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
  // footer instead of the shared always-visible Save row. Remote Access has
  // no saved values at all — enabling/disabling/restarting are immediate
  // actions — so it never shows a Save row either.
  if($("globalSaveRow")) $("globalSaveRow").style.display=(SETTINGS_TAB_TRACKERS[name]||name==="remote")?"none":"";
  // Remote Access has its own live status poller — only run it while its tab
  // is actually visible, same reasoning as the fleet poller not running
  // forever in the background for no reason.
  if(name==="remote"){ loadRemoteAccessStatus(); if(!RA_POLL_TIMER) RA_POLL_TIMER=setInterval(loadRemoteAccessStatus, 4000); }
  else if(RA_POLL_TIMER){ clearInterval(RA_POLL_TIMER); RA_POLL_TIMER=null; }
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
    allowMapping:$("setAllowMapping").checked, suggestMatching:$("setSuggestMatching").checked
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

async function loadConfigUI(){
  await loadConnectorTypes();
  try{
    const c=await getJSON("/api/config");
    $("setFolder").value=c.gcodeFolder||"";
    scheduleFolderCheck();
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
    $("setOpenCompact").checked=!!c.openCompact;
    $("setCameraRefresh").value=c.cameraViewRefreshInterval||6;
    CAM_STAGGER=c.cameraViewStagger!==false; $("setCameraStagger").checked=CAM_STAGGER;
    ALT_DISPLAY=["all","compact","camera","list"].includes(c.alternateDisplay)?c.alternateDisplay:"all";
    $("setAltDisplay").value=ALT_DISPLAY;
    ALLOW_MAPPING=c.allowMapping!==false; $("setAllowMapping").checked=ALLOW_MAPPING;
    SUGGEST_MATCHING=c.suggestMatching!==false; $("setSuggestMatching").checked=SUGGEST_MATCHING;
    $("setUsersEnabled").checked=!!c.usersEnabled;
    $("bootstrapAdmin").style.display="none";
    if($("dockerRestartRow")) $("dockerRestartRow").style.display=c.isDocker?"flex":"none";
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
    VIEW_MODE=c.openCompact?'compact':'regular'; applyViewMode();
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
    PRINTERS_CFG.forEach(p=>addPrinterRow(p.name,p.url,{id:p.id,brand:p.brand,location:p.location,costKwh:p.costKwh,purchaseDate:p.purchaseDate,autoLevel:p.autoLevel,pushNotify:p.pushNotify,connector:p.connector,serial:p.serial,verificationCode:p.verificationCode,hasToken:p.hasToken}));
    baselinePrintersDirty();
    updateRefreshHelper(); // depends on PRINTERS_CFG.length, so runs after the printer rows above
    syncAutoMatchNesting();
    baselineSettingsTab("general");
    // The onboarding "add your first printer" flow drops into the admin-only
    // Printers settings tab — never force that open for a non-Admin role,
    // who couldn't reach or complete it (Settings itself is hidden for them).
    if(!c.configured && isAdmin()){ $("setup").classList.add("show"); showSetTab("printers"); $("gear").querySelector("img").src="/back.svg"; $("gear").title="Back"; document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="none"); $("fleetSearch").style.display="none"; $("sortBtn").style.display="none"; $("compactBtn").style.display="none"; if($("filesBtn")) $("filesBtn").style.display="none"; if($("maintBtn")) $("maintBtn").style.display="none"; $("setupmsg").textContent="Welcome — add your printers to get started"; if(!$("setPrinters").children.length) addPrinterRow("",""); }
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
    pushNotify:row.querySelector('[id^="ppushnotify-"]').checked
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
  const modelLabel=(CONNECTOR_TYPES.find(c=>c.type===connType)||{}).label||connType;
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
    `<div class="maint-field" style="margin-top:10px;max-width:260px"><label class="fl">Brand</label><input class="field pbrand" maxlength="25" placeholder="SnapMaker" value="${esc(opts.brand||"")}"></div>`+
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
    `</div>`+

    `<div class="prow-section"><div class="prow-section-title">Behavior</div>`+
    `<div class="autolevel-wrap" style="margin-bottom:10px">`+
    switchHtml("pautolevel-"+uid,!!opts.autoLevel,"Auto-level","Home and probe the bed mesh before each print")+
    `</div>`+
    switchHtml("ppushnotify-"+uid,!!opts.pushNotify,"Push notifications","Include this printer in start / pause / error / complete alerts")+
    `</div>`+

    `</div></details>`;

  const connectorEl=row.querySelector(".pconnector"), autolevelWrap=row.querySelector(".autolevel-wrap"), autolevelEl=row.querySelector('[id^="pautolevel-"]');
  const modelBadgeEl=row.querySelector(".prow-model-badge");
  connectorEl.value=connType;
  const syncAutoLevelVisibility=()=>{
    const supported=!!connectorCaps(connectorEl.value).autoLevel;
    autolevelWrap.style.display=supported?"":"none";
    if(!supported) autolevelEl.checked=false;
  };
  connectorEl.addEventListener("change", ()=>{
    syncAutoLevelVisibility();
    modelBadgeEl.textContent=(CONNECTOR_TYPES.find(c=>c.type===connectorEl.value)||{}).label||connectorEl.value;
  });
  syncAutoLevelVisibility();
  // Live-update the summary header as user types
  const nameEl=row.querySelector(".pname"), urlEl=row.querySelector(".purl");
  const sumName=row.querySelector(".prow-sumname"), sumIp=row.querySelector(".prow-sumip");
  nameEl.addEventListener("input",()=>{ sumName.textContent=nameEl.value.trim()||"New Printer"; });
  urlEl.addEventListener("input",()=>{ sumIp.textContent=urlEl.value.replace(/^https?:\/\//,"").replace(/\/+$/,"")||"—"; });
  wireSecretField(row.querySelector(".secret-field"));

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

  row.querySelectorAll(".prow-body input, .prow-body select").forEach(el=>{
    el.addEventListener("input", markPrintersDirty);
    el.addEventListener("change", markPrintersDirty);
  });

  $("setPrinters").appendChild(row);
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
  row.querySelector(".usave").addEventListener("click",async()=>{
    const st=row.querySelector(".usave-status");
    const body={
      firstName: row.querySelector(".ufirst").value.trim(),
      lastName: row.querySelector(".ulast").value.trim(),
      loginName: loginEl.value.trim(),
      email: row.querySelector(".uemail").value.trim(),
      phone: row.querySelector(".uphone").value.trim(),
      role: roleSel.value,
      otpEnabled: otpEl.checked
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
      pwEl.value="";
      st.className="pstatus usave-status ok"; st.textContent="Saved";
      sumName.textContent=d.user.loginName; sumRole.textContent=roleLabel(d.user.role);
      syncPwState();
    }catch(e){ st.className="pstatus usave-status err"; st.textContent=e.message; }
  });
  $("setUsers").appendChild(row);
}

function gatherPrinters(){
  return [...$("setPrinters").querySelectorAll(".prow")].map(r=>({
    id:r.dataset.printerId||undefined,
    name:r.querySelector(".pname").value.trim(),
    url:r.querySelector(".purl").value.trim(),
    brand:r.querySelector(".pbrand").value.trim()||undefined,
    location:r.querySelector(".ploc").value.trim()||undefined,
    costKwh:r.querySelector(".pkwh").value.trim()||undefined,
    purchaseDate:r.querySelector(".pdate").value||undefined,
    autoLevel:r.querySelector('[id^="pautolevel-"]').checked||undefined,
    pushNotify:r.querySelector('[id^="ppushnotify-"]').checked||undefined,
    connector:r.querySelector(".pconnector").value,
    serial:r.querySelector(".pserial").value.trim()||undefined,
    verificationCode:r.querySelector(".pvcode").value.trim()||undefined,
    token:secretFieldValue(r.querySelector(".secret-field"))
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
  setSaveStatus("work","Saving…");
  // Refuse to send usersEnabled:true until the inline bootstrap-admin form
  // has succeeded — no default/throwaway admin is ever created as a fallback.
  if($("setUsersEnabled").checked && $("bootstrapAdmin").style.display!=="none" && !BOOTSTRAPPED_ADMIN){
    setSaveStatus("err","Create the first Admin account before enabling User Access Management");
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
  const body={ gcodeFolder:$("setFolder").value.trim(), refreshInterval:(ri>=1&&ri<=60)?ri:2, cameraViewRefreshInterval:(cr>=3&&cr<=60)?cr:6, cameraViewStagger:CAM_STAGGER, alternateDisplay:ALT_DISPLAY, currency:CURRENCY, filamentCost:fc>0?fc:undefined, electricityRate:er>0?er:undefined, tNotation:tn||undefined, openCompact:$("setOpenCompact").checked||undefined, allowMapping:ALLOW_MAPPING, suggestMatching:SUGGEST_MATCHING,
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
    setSaveStatus("ok","Saved");
    $("setupmsg").textContent="";
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
}

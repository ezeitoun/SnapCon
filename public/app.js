

function lookupKlipperError(code, msg){
  if(!code&&!msg) return null;
  const entry=code?ERROR_CODES[code]:null;
  return{code, title:entry?entry.t:(code||'Unknown Error'), description:entry?entry.d:(msg||code||''), url:entry?entry.u:''};
}
const $ = id => document.getElementById(id);
const VERSION = "0.1.0";
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
let USE_T_NOTATION = false, FILAMENT_COST = 0, ELECTRICITY_RATE = 0, CURRENCY = "$";
let ALLOW_MAPPING = true, SUGGEST_MATCHING = true;

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
  $('fileSortBtn').textContent = '↕ ' + (FILE_SORT_LABELS[FILE_SORT] || 'Newest');
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

// ---- Compact / Full toggle ----
// Launch state comes from the "Open in Compact Mode" setting (loadConfigUI);
// the header button only switches the current session.
let COMPACT = false;
function applyCompact(){
  document.body.classList.toggle('compact', COMPACT);
  const btn = $('compactBtn');
  if(btn){ btn.querySelector('img').src = COMPACT ? '/view-regular.svg' : '/view-compact.svg'; btn.title = COMPACT ? 'Switch to full view' : 'Switch to compact view'; }
}
function toggleCompact(){
  COMPACT = !COMPACT;
  applyCompact();
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
  $("gear").style.display = admin ? "" : "none";
  if($("maintBtn")) $("maintBtn").disabled = !act;
  if($("filesBtn")) $("filesBtn").style.display = act ? "" : "none";
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
  wireModal("platemodal", closePlate, ["platex"]);
  $("plateSkip").addEventListener("click", doPlateSkip);
  wireModal("thumbmodal", closeThumb, ["thumbx"]);
  wireModal("snapmodal", closeSnapshot, ["snapx"]);
  wireModal("unloadmodal", closeUnload, ["unloadx","unloadNo"]);
  wireModal("bedmodal", closeBedModal, ["bedmodalx","bedmodalcancel"]);
  wireModal("maintReportModal", closeMaintReport, ["maintReportX"]);
  $("maintBtn").addEventListener("click", openMaintReport);
  $("maintPrinterSel").addEventListener("change", ()=>loadMaintDetail(parseInt($("maintPrinterSel").value,10)));
  $("maintSave").addEventListener("click", saveMaintenance);
  $("maintOfflineToggle").addEventListener("click", toggleMaintenanceMode);
  $("maintDate").addEventListener("change", updateNextScheduledPreview);
  $("maintFrequency").addEventListener("change", updateNextScheduledPreview);
  $("maintComponent").addEventListener("input", ()=>{
    const known=MAINT_FREQ_MAP[$("maintComponent").value.trim()];
    if(known){ $("maintFrequency").value=known; updateNextScheduledPreview(); }
  });
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
  $("browseok").addEventListener("click", ()=>{ const p=$("browsepath").value.trim(); if(p) $("setFolder").value=p; closeBrowse(); });
  $("elecSearch").addEventListener("click", openElecModal);
  $("elecLookup").addEventListener("click", doElecLookup);
  $("elecZip").addEventListener("keydown", e=>{ if(e.key==="Enter") doElecLookup(); });
  $("elecApply").addEventListener("click", ()=>{ closeElecModal(); });

  wireFleetDrag();

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

  document.addEventListener("click", ()=>{ $("sortMenu").classList.remove("open"); $("fileSortMenu").classList.remove("open"); });

  applyCompact();
  $("compactBtn").addEventListener("click", toggleCompact);

  applyFilesOpen();
  $("filesBtn").addEventListener("click", ()=>{ FILES_OPEN=!FILES_OPEN; applyFilesOpen(); });

  $("ntfEnabled").addEventListener("change", applyNtfEnabled);
  $("ntfGenTopic").addEventListener("click", ()=>{ $("ntfTopic").value=genRandomTopic(); });

  $("otpSvcResend").addEventListener("change", applyOtpServiceUI);
  $("otpSvcNtfy").addEventListener("change", ()=>{
    // Default to whatever the Notifications tab already has, but only if the
    // OTP topic hasn't been given its own value yet — never clobber a
    // deliberately-different one.
    if(!$("otpNtfyTopic").value.trim()) $("otpNtfyTopic").value=$("ntfTopic").value.trim();
    applyOtpServiceUI();
  });
  $("otpNtfyGenTopic").addEventListener("click", ()=>{ $("otpNtfyTopic").value=genRandomTopic(); });
  $("otpTest").addEventListener("click", doOtpTest);

  document.querySelectorAll(".set-tab").forEach(btn=>{
    btn.addEventListener("click", ()=>showSetTab(btn.dataset.tab));
  });

  $("fwGet").addEventListener("click", loadFirmware);
  $("fwSelect").addEventListener("click", ()=>{ const st=$("fwStatus"); st.className="pstatus"; st.textContent="Select Firmware — not implemented yet"; });
  $("fwDeploy").addEventListener("click", ()=>{ const st=$("fwStatus"); st.className="pstatus"; st.textContent="Deploy Firmware — not implemented yet"; });

  // Test uses the values currently in the form, so it works before saving.
  $("ntfTest").addEventListener("click", async ()=>{
    const st=$("ntfTestStatus");
    st.className="pstatus work"; st.textContent="Sending test…";
    try{
      const r=await postJSON("/api/notify-test",{
        service:$("ntfSvcTelegram").checked?"telegram":"ntfy",
        topic:$("ntfTopic").value.trim(),
        includeImage:$("ntfImage").checked
      });
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
      st.className="pstatus ok"; st.textContent="Sent — check your ntfy app";
    }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
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
$("filter").addEventListener("input", renderList);
$("fleetSearch").addEventListener("input", renderFleet);

async function loadFiles(sub){
  if(sub!==undefined) CURRENT_SUB=sub;
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
  const q=$("filter").value.trim().toLowerCase(), list=$("list");
  list.innerHTML="";
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
    if(q&&!name.toLowerCase().includes(q)) return;
    const b=document.createElement("button"); b.className="folder-item";
    b.innerHTML=`📁 ${esc(name)}`;
    b.addEventListener("click",()=>loadFiles(CURRENT_SUB?CURRENT_SUB+"/"+name:name));
    list.appendChild(b);
  });
  const shown=FILES.filter(f=>!q||f.name.toLowerCase().includes(q)).sort(FILE_SORTS[FILE_SORT]||FILE_SORTS.new);
  if(!FOLDERS.length&&!shown.length&&!CURRENT_SUB){ list.innerHTML='<div class="empty-list">No <code>.gcode</code> files here yet.</div>'; return; }
  if(!shown.length){ const m=document.createElement("div"); m.className="empty-list"; m.textContent="No .gcode files in this folder."; list.appendChild(m); return; }
  shown.forEach(f=>{
    const filePath=CURRENT_SUB?CURRENT_SUB+"/"+f.name:f.name;
    const b=document.createElement("button"); b.className="job"+(SELECTED===filePath?" active":"");
    const fsBadge=(SELECTED===filePath&&MAP&&MAP.isFS)?` <img src="/fs-badge.svg" class="fs-badge" title="Full Spectrum">`:``;
    b.innerHTML=`<div class="jn">${esc(stripExt(f.name))}${fsBadge}</div><div class="jm">${fmtTime(f.mtime)} · ${fmtSize(f.size)}</div>`;
    b.addEventListener("click",()=>selectFile(filePath));
    list.appendChild(b);
  });
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
      `<span class="status-badge" style="--status-color:#545B69">Connecting…</span>`+
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
  // Reordering persists via applyPrinterOrder() -> saveConfig() -> POST
  // /api/config, which is admin-only server-side — gate on isAdmin(), not
  // canAct(), or a Regular user's drag would silently 403 and revert with
  // no visible feedback (Settings, where the error would surface, is hidden
  // from them entirely).
  const dragEnabled=SORT_MODE==='none'&&!q&&isAdmin();
  fleet.forEach(p=>{
    const card=document.createElement("div");
    card.className="pcard"+(p.online?"":" offline");
    card.dataset.pid=p.id;
    // status pill
    let statusColor="#6A7180", statusTxt="Offline";
    if(p.online){
      if(p.state==="printing"){ statusColor="#5B9BF0"; statusTxt="Printing"; }
      else if(p.state==="paused"){ statusColor="#fbbf24"; statusTxt="Paused"; }
      else if(p.state==="error"){ statusColor="#E06A5C"; statusTxt="Error"; }
      else if(p.state==="complete"){ statusColor="#22C5BE"; statusTxt="Complete"; }
      else if(p.state==="cancelled"){ statusColor="#E06A5C"; statusTxt="Cancelled"; }
      else if(p.state==="maintenance"){ statusColor="#A78BFA"; statusTxt="Maintenance"; }
      else { statusColor="#46C18C"; statusTxt="Idle"; }
    }
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
    if(canSend && need.length && ALLOW_MAPPING){
      const dft=defaultMapping(need, heads);
      const allHeads=Array.from({length:4},(_,i)=>({hi:i,h:heads[i]||null}));
      if(allHeads.some(x=>x.h&&x.h.loaded)){
        const rows=need.map(n=>{
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
      <div class="top"><span class="pn"><span><div class="hdr-brand">${esc(p.brand||'SnapMaker')}</div><div class="hdr-name">${esc(p.name)}</div></span></span><div class="card-right">${p.online?`<div class="card-pills">${(p.state==='idle'||p.state==='complete'||p.state==='cancelled')&&p.filename?`<button class="pill-btn" ${canAct()?"":"disabled"} data-eject="${p.id}" title="Eject"><img src="/eject-pill.svg" alt="Eject"></button>`:''}<button class="pill-btn" data-snap="${p.id}" title="Camera"><img src="/camera-pill.svg" alt="Camera"></button><a class="pill-btn" href="${esc(p.url||'#')}" target="_blank" rel="noopener" title="Open Fluidd"><img src="/fluidd-pill.svg" alt="Fluidd"></a></div>`:''}<span class="status-badge${dragEnabled?' drag-handle':''}"${dragEnabled?' draggable="true" title="Drag to reorder"':''} style="--status-color:${statusColor}">${statusTxt}</span></div></div>
      <div class="prism-line${p.state==='error'?' err-line':p.state==='cancelled'?' cancelled-line':p.state==='paused'?' pause-line':p.state==='complete'?' complete-line':''}"></div>
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
        const stem=p.filename?p.filename.replace(/\.gcode$/i,""):"";
        const thumbCell=stem
          ? `<div class="stats-cell stats-thumb-cell" data-thumb="${p.id}" title="Click to enlarge"><img class="stats-thumb" src="/api/thumbnail?printer=${p.id}&file=${encodeURIComponent(stem)}&t=${thumbToken(p,stem)}" alt="" onerror="this.parentNode.innerHTML='<span class=stats-thumb-empty>—</span>'"></div>`
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
        const filM=p.filamentUsed!=null?(p.filamentUsed/1000).toFixed(1)+'m':'—';
        return `<div class="progress-section">`+
          (p.errorCode||p.message?'':(`<div class="prog-file">${esc(p.filename||'—')}</div>`))+
          `<div class="prog-row"><span class="prog-pct ${pctCls}">${pct}%</span>`+
          `<div class="prog-track ${trackCls}"><div class="prog-fill ${fillCls}" style="width:${pct}%;animation-delay:-${(Date.now()/1000%8).toFixed(2)}s"></div>${showDot?`<div class="prog-dot ${dotCls}" style="left:${pct}%"></div>`:''}</div></div>`+
          (p.errorCode||p.message?'':`<div class="prog-times">`+
          `<div class="prog-time-cell"><span class="prog-time-label">Elapsed</span><span class="prog-time-val">${fmtClock(p.elapsed)}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          `<div class="prog-time-cell center"><span class="prog-time-label">Filament</span><span class="prog-time-val">${filM}</span></div>`+
          `<div class="prog-time-sep"></div>`+
          `<div class="prog-time-cell end"><span class="prog-time-label">Remaining</span><span class="prog-time-val">${fmtRemaining(p.elapsed,p.progress)}</span></div>`+
          `</div>`)+`</div>`;
      })():""}
      ${p.online&&!(p.errorCode||p.message)?afcLanesHtml(heads,p.activeExt,p.id):''}
      ${mapHtml}
      <div class="foot${busy?'':' foot-idle'}">
        ${busy
          ? (p.state==="paused"
                ? `<button class="btn-svg" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="resume" title="Resume"><img src="/b-resume.svg" alt="Resume"></button>`
                : `<button class="btn-svg" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="pause" title="Pause"><img src="/b-pause.svg" alt="Pause"></button>`)
            + `<button class="btn-svg" ${canAct()?"":"disabled"} data-ctl="${p.id}" data-act="cancel" title="Cancel"><img src="/b-cancel.svg" alt="Cancel"></button>`
            + (p.plate&&p.plate.total>1?`<button class="btn-svg" ${canAct()?"":"disabled"} data-plate="${p.id}" title="Plate"><img src="/b-plate.svg" alt="Plate ${p.plate.total-p.plate.excluded}/${p.plate.total}"></button>`:"")
            + `<button class="btn-svg" ${canAct()?"":"disabled"} data-estop="${p.id}" title="Emergency Stop"><img src="/b-estop.svg" alt="E-Stop"></button>`
          : `<button class="btn-svg" ${canSend&&canAct()?"":"disabled"} data-id="${p.id}" data-start="0" title="${maintMode?"Printer is in maintenance mode":"Upload to printer"}"><img src="/b-upload.svg" alt="Upload"></button>`
            + `<button class="btn-svg" ${p.online&&!busy&&!maintMode&&canAct()?"":"disabled"} data-id="${p.id}" data-start="1" title="${maintMode?"Printer is in maintenance mode":SELECTED?"Print the selected file":"Pick a file already on the printer"}"><img src="/b-print.svg" alt="Print"></button>`
            + `<button class="btn-svg" ${canAct()?"":"disabled"} data-preheat="${p.id}" title="Preheat"><img src="/b-preheat.svg" alt="Preheat"></button>`
        }
      </div>
      <div class="pstatus" id="pst-${p.id}"></div>`;
    wrap.appendChild(card);
  });
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
}

// A file staged by --load while nobody was watching (queuedFile, set server-side
// by /api/notify-load) — a quiet banner + one-click Print, in any view mode.
function queuedFileBannerHtml(p){
  const qf=p.queuedFile;
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
  if(ALLOW_MAPPING) neededColors().forEach(n=>{ const v=MAPSEL[printer+":"+n.i]; if(v!==undefined) map[n.i]=parseInt(v,10); });
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
    const d=await r.json(); if(!r.ok||d.error||!d.jobId) throw new Error(d.error||("HTTP "+r.status));
    ok=await pollJob(d.jobId, st, start, mapped, progressBtn, extraUI);
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
  const thumb=`/api/thumbnail?printer=${PFILE_PRINTER}&file=${encodeURIComponent(stripExt(PFILE_SELECTED))}`;
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
  const need=PFILE_META.palette.filter(s=>s.used);
  if(!need.length){ wrap.innerHTML='<div class="browse-empty">No color info in this file.</div>'; return; }
  if(!allHeads.some(x=>x.h&&x.h.loaded)){ wrap.innerHTML='<div class="browse-empty">No filament loaded on this printer.</div>'; return; }
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
    const r=await fetch('/api/snapshot?printer='+SNAP_PRINTER+'&t='+Date.now());
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
    const stem=p.filename.replace(/\.gcode$/i,"");
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
function fmtHours(sec){ if(sec==null) return '—'; const h=Math.floor(sec/3600); const m=Math.floor((sec%3600)/60); return h+'h '+m+'m'; }
// Mirrors the server's defaults (server.js) so a known component picked here
// auto-fills the same Frequency without a round-trip; the server recomputes
// Next Scheduled authoritatively on save regardless.
const MAINT_FREQ_MAP={"Linear Shaft / Linear Bearing":"monthly","X Carbon Rod Assembly":"monthly","Lead Screw / Nut":"quarterly","Steel Pin / Steel Ball":"quarterly","Timing Belt":"monthly","Pogo pin":"6months"};
const MAINT_FREQ_MONTHS={monthly:1,quarterly:3,"6months":6};
function addMonthsClient(dateStr,months){
  if(!dateStr) return "";
  const d=new Date(dateStr+"T00:00:00");
  d.setMonth(d.getMonth()+months);
  return d.toISOString().slice(0,10);
}
function updateNextScheduledPreview(){
  const months=MAINT_FREQ_MONTHS[$("maintFrequency").value]||1;
  $("maintNextScheduled").value=addMonthsClient($("maintDate").value,months);
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
  $("maintComponent").value="";
  $("maintFrequency").value="monthly";
  $("maintCost").value="0.00";
  $("maintComment").value="";
  updateNextScheduledPreview();
  updateMaintOfflineButton(idx);
  $("maintStatus").textContent="";
  $("maintHours").textContent="loading…";
  $("maintWarranty").textContent="—";
  $("maintNextWrap").style.display="none";
  $("maintHistory").innerHTML="";
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
// fetching the flag a second way. Button label is the ACTION, not the state:
// "Offline" when currently online (click to take it offline), "Online" when
// currently in maintenance (click to bring it back).
function updateMaintOfflineButton(idx){
  const fleetEntry=FLEET.find(f=>f.id===idx);
  const inMaintenance=!!(fleetEntry&&fleetEntry.state==="maintenance");
  const btn=$("maintOfflineToggle");
  btn.textContent=inMaintenance?"Online":"Offline";
  btn.dataset.next=inMaintenance?"0":"1"; // what maintenanceMode should become on click
}
async function toggleMaintenanceMode(){
  const btn=$("maintOfflineToggle");
  const st=$("maintStatus");
  const offline=btn.dataset.next==="1";
  btn.disabled=true;
  st.className="pstatus work"; st.textContent=offline?"Taking offline…":"Bringing online…";
  try{
    const r=await postJSON("/api/maintenance-mode",{printer:MAINT_IDX,offline});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent=d.maintenanceMode?"Printer taken offline":"Printer back online";
    // Use the endpoint's own response, not a re-fetched FLEET — loadFleet()
    // has an in-flight guard that silently no-ops if a periodic poll happens
    // to already be running, which would read back stale state here.
    btn.textContent=d.maintenanceMode?"Online":"Offline";
    btn.dataset.next=d.maintenanceMode?"0":"1";
    loadFleet(); // still refresh in the background for the fleet card badge
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}
function applyMaintDetailResponse(d){
  $("maintComponentList").innerHTML=(d.components||[]).map(c=>`<option value="${esc(c)}">`).join("");
  $("maintWarranty").textContent=d.warranty?"Yes":"No";
  if(d.next){
    $("maintNextWrap").style.display="";
    $("maintNextDate").textContent=d.next.date;
    $("maintNextComponent").textContent=d.next.component;
  } else {
    $("maintNextWrap").style.display="none";
  }
  renderMaintHistory(d.entries||[]);
}
async function saveMaintenance(){
  const st=$("maintStatus");
  const date=$("maintDate").value;
  if(!date){ st.className="pstatus err"; st.textContent="Pick a date"; return; }
  const idx=MAINT_IDX;
  const entry={
    date, comment:$("maintComment").value.trim(),
    hours:MAINT_TOTAL_SEC!=null?fmtHours(MAINT_TOTAL_SEC):'—', totalSeconds:MAINT_TOTAL_SEC,
    component:$("maintComponent").value.trim(), frequency:$("maintFrequency").value,
    cost:parseFloat($("maintCost").value)||0
  };
  st.className="pstatus work"; st.textContent="Saving…";
  try{
    const r=await postJSON("/api/maintenance",{printer:idx,entry});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||"HTTP "+r.status);
    st.className="pstatus ok"; st.textContent="Saved";
    $("maintComment").value="";
    applyMaintDetailResponse(d);
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
}
function renderMaintHistory(entries){
  if(!entries.length){ $("maintHistory").innerHTML='<div style="color:var(--ink-faint);font-size:12px;margin-top:6px">No maintenance records yet.</div>'; return; }
  const sorted=entries.slice().sort((a,b)=>b.date.localeCompare(a.date));
  const rows=sorted.map(e=>`<tr><td>${esc(e.date)}</td><td>${esc(e.component||'—')}</td><td>${esc(e.hours||'—')}</td><td>${esc(CURRENCY)}${(Number(e.cost)||0).toFixed(2)}</td><td>${esc(e.comment||'')}</td></tr>`).join('');
  $("maintHistory").innerHTML=`<div class="maint-scroll"><table class="maint-table"><thead><tr><th>Date</th><th>Component</th><th>Hours</th><th>Cost</th><th>Comment</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
function renderPlate(){
  const d=PLATE_DATA;
  if(!d) return;
  const fp=FLEET.find(f=>f.id===PLATE_PRINTER);
  const live=d.objects.length-(d.excluded||[]).length;
  $("platetitle").textContent=(fp?fp.name:"Plate")+" — "+live+" of "+d.objects.length+" still printing";
  $("platewrap").innerHTML=plateSVG(d);
  $("platelist").innerHTML=plateListHTML(d);
  document.querySelectorAll("#platewrap [data-obj], #platelist [data-obj]").forEach(el=>{
    el.addEventListener("click",()=>togglePlateSel(el.dataset.obj));
  });
  const btn=$("plateSkip");
  btn.disabled=!PLATE_SELECTED.size;
  btn.textContent=PLATE_SELECTED.size?`Skip (${PLATE_SELECTED.size})`:"Skip";
}
// Prime/purge towers are display-only: never selectable, never in the list.
// (Orca doesn't currently label the tower as an object — this is a guard in
// case a slicer version starts doing so.)
const isTowerObj=name=>/(prime|purge|wipe)[ _-]?tower/i.test(name);

function plateListHTML(d){
  const ex=new Set(d.excluded||[]);
  return (d.objects||[]).filter(o=>!isTowerObj(o.name)).map(o=>{
    const isEx=ex.has(o.name), isCur=o.name===d.current, isSel=PLATE_SELECTED.has(o.name);
    const disp=o.name.length>40?o.name.slice(0,37)+"...":o.name;
    const cls="plate-item"+(isEx?" ex":"")+(isSel?" sel":"");
    return `<button class="${cls}" ${isEx?"disabled":`data-obj="${esc(o.name)}"`}>`+
      `<span class="pi-check">${isSel?"✓":""}</span><span class="pi-name" title="${esc(o.name)}">${esc(disp)}</span>`+
      (isEx?'<span class="pi-tag">skipped</span>':isCur?'<span class="pi-tag cur">printing</span>':'')+
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
  st.className="pstatus work"; st.textContent=`Skipping ${names.length}…`;
  $("plateSkip").disabled=true;
  try{
    for(const n of names){
      const r=await postJSON("/api/exclude",{printer:PLATE_PRINTER,name:n});
      const d=await r.json(); if(!r.ok||d.error) throw new Error(d.error||("HTTP "+r.status));
    }
    st.className="pstatus ok"; st.textContent=`Skipped ${names.length}`;
    PLATE_SELECTED.clear();
  }catch(e){ st.className="pstatus err"; st.textContent="Couldn't skip: "+e.message; }
  refreshPlate();
}
function plateSVG(d){
  const objs=(d.objects||[]).filter(o=>o.polygon&&o.polygon.length>2);
  if(!objs.length) return '<div class="platenote">No objects reported for this print.</div>';
  // Full-bed view over a photo of the real plate: gcode coordinates map 1:1
  // onto the 270×270 U1 bed, so objects appear where they really sit. The
  // photo is shot with the alignment tabs at the back, matching the Y flip.
  const BED=270, pad=8, exSet=new Set(d.excluded||[]);
  const polys=objs.map(o=>{
    const pts=o.polygon.map(pt=>pt[0].toFixed(1)+","+(BED-pt[1]).toFixed(1)).join(" "); // flip Y so plate front is at the bottom
    const isCur=o.name===d.current, isEx=exSet.has(o.name), isTower=isTowerObj(o.name);
    const cls=isTower?"po tower":(isEx?"po ex":(isCur?"po cur":"po"))+(PLATE_SELECTED.has(o.name)?" sel":"");
    return `<polygon class="${cls}" points="${pts}"${(isEx||isTower)?"":' data-obj="'+esc(o.name)+'"'}></polygon>`;
  }).join("");
  return `<svg viewBox="${-pad} ${-pad} ${BED+2*pad} ${BED+2*pad}" class="platesvg">`+
    `<image href="/plate-bg.png" x="0" y="0" width="${BED}" height="${BED}" preserveAspectRatio="none"/>`+
    `${polys}</svg>`;
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
  if($("maintBtn")) $("maintBtn").style.display = open ? "none" : "";
  if(open){ document.body.classList.remove("showfiles"); loadUsersUI(); }
  else { applyFilesOpen(); $("sortMenu").classList.remove("open"); }
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
$("discover").addEventListener("click",()=>runDiscover());
$("discoverSubnet").addEventListener("click",()=>{
  const subnet=prompt("Enter subnet to scan (e.g. 192.168.2.0):","");
  if(!subnet) return;
  const parts=subnet.trim().split(".");
  if(parts.length!==4||parts.some(p=>isNaN(p)||+p<0||+p>255)){
    alert("Invalid subnet. Expected format: x.x.x.0"); return;
  }
  runDiscover(parts.slice(0,3).join(".")+".0");
});
$("saveCfg").addEventListener("click",saveConfig);

// Grey out and disable the notification options while the master box is off.
function applyNtfEnabled(){
  const on=$("ntfEnabled").checked;
  $("ntfBody").classList.toggle("disabled", !on);
  $("ntfBody").querySelectorAll("input,button").forEach(i=>i.disabled=!on);
}

// Shared by the Notifications-tab ntfy topic and the OTP-via-ntfy topic — a
// topic doubles as the ntfy access secret, so it needs real randomness.
function genRandomTopic(){
  const letters="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const buf=new Uint32Array(12); crypto.getRandomValues(buf);
  return [...buf].map(n=>letters[n%letters.length]).join("");
}
function applyOtpServiceUI(){
  const ntfy=$("otpSvcNtfy").checked;
  $("otpResendBody").style.display=ntfy?"none":"";
  $("otpNtfyBody").style.display=ntfy?"":"none";
}
async function doOtpTest(){
  const st=$("otpTestStatus");
  const ntfy=$("otpSvcNtfy").checked;
  const body={ service: ntfy?"ntfy":"resend" };
  if(ntfy){
    body.ntfyTopic=$("otpNtfyTopic").value.trim();
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
        return `<div class="fwrow"><input type="checkbox" class="fwchk" data-id="${r.id}" disabled>`+
               `<div><div class="fwline1"><b>${esc(r.name)}</b></div><div class="fwskip">${esc(why)}</div></div></div>`;
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
      return `<div class="fwrow"><input type="checkbox" class="fwchk" data-id="${r.id}">`+
        `<div><div class="fwline1"><b>${esc(r.name)}</b><span>${esc(fwTxt)}</span></div>`+
        `<div class="fwline2">${mcuHtml}${r.os?esc(" · "+r.os):""}</div></div></div>`;
    }).join("");
    const read=rows.filter(r=>!r.skipped).length;
    st.className="pstatus ok"; st.textContent=`Read ${read} of ${rows.length} printers`;
  }catch(e){ st.className="pstatus err"; st.textContent=e.message; }
  finally{ btn.disabled=false; }
}

function showSetTab(name){
  document.querySelectorAll(".set-tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===name));
  document.querySelectorAll(".set-panel").forEach(p=>{ p.style.display = p.id==="tab-"+name ? "" : "none"; });
}

async function loadConfigUI(){
  try{
    const c=await getJSON("/api/config");
    $("setFolder").value=c.gcodeFolder||"";
    $("setRefresh").value=c.refreshInterval||2;
    $("setCurrency").value=c.currency||"$";
    CURRENCY=c.currency||"$";
    if($("maintCostCurrency")) $("maintCostCurrency").textContent=CURRENCY;
    $("setFilamentCost").value=c.filamentCost||"";
    $("setElectricityRate").value=c.electricityRate||"";
    FILAMENT_COST=c.filamentCost||0; ELECTRICITY_RATE=c.electricityRate||0;
    $("setTNotation").checked=!!c.tNotation; USE_T_NOTATION=!!c.tNotation;
    $("setOpenCompact").checked=!!c.openCompact;
    ALLOW_MAPPING=c.allowMapping!==false; $("setAllowMapping").checked=ALLOW_MAPPING;
    SUGGEST_MATCHING=c.suggestMatching!==false; $("setSuggestMatching").checked=SUGGEST_MATCHING;
    $("setUsersEnabled").checked=!!c.usersEnabled;
    $("bootstrapAdmin").style.display="none";
    const rs=c.resend||{};
    $("setResendKey").value="";
    $("setResendKey").placeholder=rs.hasApiKey?"•••••••• (saved — leave blank to keep)":"re_...";
    $("setResendFrom").value=rs.fromAddress||"";
    const otp=c.otp||{};
    if(otp.service==="ntfy") $("otpSvcNtfy").checked=true; else $("otpSvcResend").checked=true;
    $("otpNtfyTopic").value=otp.ntfyTopic||"";
    applyOtpServiceUI();
    COMPACT=!!c.openCompact; applyCompact();
    const nf=c.notifications||{};
    $("ntfEnabled").checked=!!nf.enabled;
    $("ntfEvents").checked=!!nf.onEvents;
    $("ntfIntervals").checked=!!nf.onIntervals;
    $("ntfImage").checked=!!nf.includeImage;
    if(nf.service==="telegram") $("ntfSvcTelegram").checked=true; else $("ntfSvcNtfy").checked=true;
    $("ntfTopic").value=nf.ntfyTopic||"";
    $("ntfChatId").value=nf.telegramChatId||"";
    applyNtfEnabled();
    $("setPrinters").innerHTML="";
    PRINTERS_CFG=c.printers||[];
    PRINTERS_CFG.forEach(p=>addPrinterRow(p.name,p.url,{brand:p.brand,location:p.location,costKwh:p.costKwh,purchaseDate:p.purchaseDate,autoLevel:p.autoLevel,pushNotify:p.pushNotify,serial:p.serial,verificationCode:p.verificationCode,token:p.token}));
    // The onboarding "add your first printer" flow drops into the admin-only
    // Printers settings tab — never force that open for a non-Admin role,
    // who couldn't reach or complete it (Settings itself is hidden for them).
    if(!c.configured && isAdmin()){ $("setup").classList.add("show"); showSetTab("printers"); $("gear").querySelector("img").src="/back.svg"; $("gear").title="Back"; document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display="none"); $("fleetSearch").style.display="none"; $("setupmsg").textContent="Welcome — add your printers to get started"; if(!$("setPrinters").children.length) addPrinterRow("",""); }
  }catch(e){}
}
function addPrinterRow(name,url,opts,autoOpen){
  opts=opts||{};
  const displayIp=(url||"").replace(/^https?:\/\//,"").replace(/\/+$/,"");
  const row=document.createElement("div"); row.className="prow";
  row.innerHTML=
    `<details class="prow-details"${autoOpen?" open":""}>`+
    `<summary><span class="prow-chevron">▶</span>`+
    `<div class="prow-suminfo"><span class="prow-sumname">${esc(name||"New Printer")}</span><span class="prow-sumip">${esc(displayIp||"—")}</span></div>`+
    `<div class="prow-sumbtns"><button class="mv-up" title="Move up">▲</button><button class="mv-dn" title="Move down">▼</button><button class="rm" title="Remove">×</button></div>`+
    `</summary>`+
    `<div class="prow-body">`+
    `<div class="prow-rows">`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl">Name</span><input class="field pname" maxlength="25" placeholder="U1" value="${esc(name||"")}" style="width:160px">`+
    `<span class="pi-lbl">Brand</span><input class="field pbrand" maxlength="25" placeholder="SnapMaker" value="${esc(opts.brand||"")}" style="width:160px">`+
    `<span class="pi-lbl">Serial</span><input class="field pserial" value="${esc(opts.serial||"")}" readonly style="width:185px">`+
    `<span class="pi-lbl">Code</span><input class="field pvcode" placeholder="XXXX" maxlength="4" value="${esc(opts.verificationCode||"")}" style="width:65px">`+
    `</div>`+
    `<div class="prow-irow">`+
    `<span class="pi-lbl">URL</span><input class="field purl" placeholder="http://192.168.1.50" value="${esc(url||"")}" style="flex:2;min-width:0">`+
    `<span class="pi-lbl">Location</span><input class="field ploc" maxlength="30" placeholder="e.g. Office" value="${esc(opts.location||"")}" style="flex:1;min-width:0">`+
    `<span class="pi-lbl">Date</span><input class="field pdate" type="date" value="${esc(opts.purchaseDate||"")}" style="width:145px;flex:none">`+
    `</div>`+
    `<div class="prow-extra">`+
    `<label class="prow-wh"><input class="field pkwh" type="number" min="0" placeholder="0" value="${esc(opts.costKwh||"")}" style="max-width:72px"><span class="pi-lbl" style="text-transform:none">Wh</span></label>`+
    `<label class="prow-chk"><input type="checkbox" class="pautolevel" ${opts.autoLevel?"checked":""}><span>Auto-level</span></label>`+
    `<label class="prow-chk"><input type="checkbox" class="ppushnotify" ${opts.pushNotify?"checked":""}><span>Push notifications</span></label>`+
    `<label title="Moonraker API token">Token <input class="field ptoken" type="${opts.token?"password":"text"}" maxlength="32" placeholder="optional" value="${esc(opts.token||"")}" style="max-width:200px"></label>`+
    `<button class="btn ghost pmaint" style="white-space:nowrap">Maintenance</button>`+
    `</div></div></div></details>`;
  // Live-update the summary header as user types
  const nameEl=row.querySelector(".pname"), urlEl=row.querySelector(".purl");
  const sumName=row.querySelector(".prow-sumname"), sumIp=row.querySelector(".prow-sumip");
  nameEl.addEventListener("input",()=>{ sumName.textContent=nameEl.value.trim()||"New Printer"; });
  urlEl.addEventListener("input",()=>{ sumIp.textContent=urlEl.value.replace(/^https?:\/\//,"").replace(/\/+$/,"")||"—"; });
  // Token field: mask when blurred, reveal on focus
  const tokenEl=row.querySelector(".ptoken");
  tokenEl.addEventListener("focus",()=>{ tokenEl.type="text"; });
  tokenEl.addEventListener("blur",()=>{ if(tokenEl.value.trim()) tokenEl.type="password"; });
  // Prevent summary buttons from toggling accordion
  row.querySelectorAll(".mv-up,.mv-dn,.rm").forEach(b=>b.addEventListener("click",e=>e.stopPropagation()));
  row.querySelector(".rm").addEventListener("click",()=>row.remove());
  row.querySelector(".mv-up").addEventListener("click",()=>{ const prev=row.previousElementSibling; if(prev) row.parentNode.insertBefore(row,prev); });
  row.querySelector(".mv-dn").addEventListener("click",()=>{ const next=row.nextElementSibling; if(next) row.parentNode.insertBefore(next,row); });
  row.querySelector(".pmaint").addEventListener("click",()=>{
    const u=row.querySelector(".purl").value.trim();
    const idx=PRINTERS_CFG.findIndex(p=>p.url===u);
    if(idx>=0) openMaintenance(idx);
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
function addUserRow(u,autoOpen){
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
    `<label class="prow-chk"><input type="checkbox" class="uotp" ${u&&u.otpEnabled?"checked":""}><span>OTP Login</span></label>`+
    `<label title="Password" class="upwrap"><span class="pi-lbl">Password</span> <input class="field upassword" type="password" maxlength="64" placeholder="${u?"leave blank to keep":"required"}" style="max-width:180px" autocomplete="new-password"></label>`+
    `<button class="btn primary usave">Save</button>`+
    `<span class="pstatus usave-status"></span>`+
    `</div></div></div></details>`;
  const roleSel=row.querySelector(".urole"); roleSel.value=u?u.role:"view";
  const loginEl=row.querySelector(".ulogin"), sumName=row.querySelector(".prow-sumname"), sumRole=row.querySelector(".prow-sumip");
  loginEl.addEventListener("input",()=>{ sumName.textContent=loginEl.value.trim()||"New User"; });
  roleSel.addEventListener("change",()=>{ sumRole.textContent=roleLabel(roleSel.value); });
  const otpEl=row.querySelector(".uotp"), pwEl=row.querySelector(".upassword"), pwWrap=row.querySelector(".upwrap");
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
    name:r.querySelector(".pname").value.trim(),
    url:r.querySelector(".purl").value.trim(),
    brand:r.querySelector(".pbrand").value.trim()||undefined,
    location:r.querySelector(".ploc").value.trim()||undefined,
    costKwh:r.querySelector(".pkwh").value.trim()||undefined,
    purchaseDate:r.querySelector(".pdate").value||undefined,
    autoLevel:r.querySelector(".pautolevel").checked||undefined,
    pushNotify:r.querySelector(".ppushnotify").checked||undefined,
    serial:r.querySelector(".pserial").value.trim()||undefined,
    verificationCode:r.querySelector(".pvcode").value.trim()||undefined,
    token:r.querySelector(".ptoken").value.trim()||undefined
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
function startFleetRefresh(){
  if(FLEET_TIMER) clearInterval(FLEET_TIMER);
  const ms=(parseInt($("setRefresh").value,10)||2)*1000;
  FLEET_TIMER=setInterval(()=>{ if(document.hidden||PUSHES>0||FLEET_DRAGGING||FLEET_DRAG_SAVING) return; const a=document.activeElement; if(a&&a.closest&&a.closest("#fleet")&&(a.tagName==="SELECT"||a.tagName==="INPUT")) return; loadFleet(); },ms);
}
async function saveConfig(){
  const s=$("cfgStatus"); s.className="pstatus work"; s.textContent="Saving…";
  // Refuse to send usersEnabled:true until the inline bootstrap-admin form
  // has succeeded — no default/throwaway admin is ever created as a fallback.
  if($("setUsersEnabled").checked && $("bootstrapAdmin").style.display!=="none" && !BOOTSTRAPPED_ADMIN){
    s.className="pstatus err"; s.textContent="Create the first Admin account before enabling User Access Management";
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
    s.textContent="Probing printers…";
    await Promise.all(needProbe.map(async r=>{
      const url=r.querySelector(".purl").value.trim();
      try{
        const d=await getJSON("/api/probe-printer?url="+encodeURIComponent(url));
        const nameEl=r.querySelector(".pname"), serialEl=r.querySelector(".pserial");
        if(!nameEl.value.trim()&&d.name) nameEl.value=d.name;
        if(!serialEl.value.trim()&&d.serial) serialEl.value=d.serial;
      }catch{}
    }));
    s.textContent="Saving…";
  }
  const ri=parseInt($("setRefresh").value,10);
  const fc=parseFloat($("setFilamentCost").value)||0;
  const er=parseFloat($("setElectricityRate").value)||0;
  const tn=$("setTNotation").checked; USE_T_NOTATION=tn;
  ALLOW_MAPPING=$("setAllowMapping").checked; SUGGEST_MATCHING=$("setSuggestMatching").checked;
  CURRENCY=$("setCurrency").value.trim()||"$";
  const body={ gcodeFolder:$("setFolder").value.trim(), refreshInterval:(ri>=1&&ri<=60)?ri:2, currency:CURRENCY, filamentCost:fc>0?fc:undefined, electricityRate:er>0?er:undefined, tNotation:tn||undefined, openCompact:$("setOpenCompact").checked||undefined, allowMapping:ALLOW_MAPPING, suggestMatching:SUGGEST_MATCHING,
    usersEnabled:$("setUsersEnabled").checked||undefined,
    resend:{ apiKey:$("setResendKey").value.trim(), fromAddress:$("setResendFrom").value.trim() },
    otp:{ service:$("otpSvcNtfy").checked?"ntfy":"resend", ntfyTopic:$("otpNtfyTopic").value.trim() },
    notifications:{
      enabled:$("ntfEnabled").checked,
      onEvents:$("ntfEvents").checked,
      onIntervals:$("ntfIntervals").checked,
      includeImage:$("ntfImage").checked,
      service:$("ntfSvcTelegram").checked?"telegram":"ntfy",
      ntfyTopic:$("ntfTopic").value.trim(),
      telegramChatId:$("ntfChatId").value.trim()
    },
    printers:gatherPrinters() };
  try{
    const c=await (await postJSON("/api/config",body)).json();
    if(c.error) throw new Error(c.error);
    s.className="pstatus ok"; s.textContent="Saved";
    $("setupmsg").textContent="";
    FILAMENT_COST=fc>0?fc:0; ELECTRICITY_RATE=er>0?er:0;
    if($("maintCostCurrency")) $("maintCostCurrency").textContent=CURRENCY;
    if(MAP) renderJob(); // refresh cost line immediately
    // Flipping usersEnabled on/off takes effect on THIS tab immediately: going
    // on with no session yet prompts login as the admin just created; going
    // off drops straight back to the fully-open UI, no reload needed either way.
    USERS_ENABLED=!!c.usersEnabled;
    if(USERS_ENABLED && !CURRENT_USER){ applyRoleUI(); showLoginOverlay(); }
    else applyRoleUI();
    loadFiles(); loadFleet(); startFleetRefresh();
  }catch(e){ s.className="pstatus err"; s.textContent=e.message; }
}

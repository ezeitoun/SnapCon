// public/library.js — the Library (docs/library-design.md §13.2, M5): the
// grid of Models, search and filters, the Model page and Needs attention.
// A page inside the app like Health: /library, /library/m/<uuid>,
// /library/attention, with its own small router. Loaded after app.js and
// uses its globals ($, esc, t, tn, fmtDuration, FLEET, the role helpers, and
// the File Browser's own selection + Send/Queue dialogs for printing).
//
// Read-only: nothing here edits a Model (that is M6). Everything shown comes
// from the index (/api/library/*), so browsing never reads a file on the NAS;
// thumbnails come from the Library's local cache.
"use strict";
(function(){
  const PAGE=60;
  const L={
    open:false, view:null, uuid:null, syncing:false, req:0,
    filters:{ q:"", printer:"", location:"", type:"", material:"", attention:false, hidden:false, sort:"name" },
    models:[], next:null, total:0, facets:null, overview:null, loadingMore:false,
    // Back from a Model returns to the same cards at the same place.
    gridKept:false, gridScroll:0, gridKey:null,
    // The Folders panel: the folder chosen in it (a location id, a path in it,
    // or its loose files; root "" is "All locations"), the last good tree,
    // the folders opened by hand, and a rescan running from this page.
    sel:{ root:"", folder:"", loose:false }, tree:null, treeReq:0, expanded:new Set(), collapsed:new Set(),
    subfolders:readSubfolders(), sheetOpen:false,
    scan:{ running:false, targets:[], error:null, timer:null },
    // M6: what was just done, with its Undo; files ticked for Separate/Move.
    flash:null, selected:new Set(),
  };

  // ---- data ----
  async function api(url){
    const r=await fetch(url);
    if(typeof checkAuthFailure==="function") checkAuthFailure(r);
    const body=await r.json().catch(()=>({}));
    if(!r.ok){ const e=new Error(body.error||("HTTP "+r.status)); e.status=r.status; e.code=body.code; throw e; }
    return body;
  }
  const thumbUrl=k=>"/api/library/thumbs/"+encodeURIComponent(k);
  const stem=n=>String(n||"").replace(/(\.gcode)?\.(gcode|gco|g|bgcode|3mf|stl|obj|step|stp|png|jpe?g|webp|pdf)$/i,"");
  const fmtG=g=>g==null?null:(g>=1000?(g/1000).toFixed(2)+" kg":(g>=10?Math.round(g):g.toFixed(1))+" g");

  // Printers of the fleet that can print a family, and how many are idle
  // ("Fits my idle printers" is applied here, §14).
  const BUSY_STATES=["printing","paused","error","maintenance","updating","rebooting"];
  function fleetFit(family){
    const ps=(typeof FLEET!=="undefined"&&Array.isArray(FLEET)?FLEET:[]).filter(p=>p.printerFamily&&p.printerFamily===family);
    return { printers:ps, idle:ps.filter(p=>p.online&&!BUSY_STATES.includes(p.state)) };
  }

  // ---- page frame ----
  function hideFleet(hide){
    document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display=hide?"none":"");
  }
  function openPage(path, push){
    if(!L.open){
      if(typeof closeQueueDashboard==="function") closeQueueDashboard();
      if(typeof closeHealthPage==="function") closeHealthPage();
      L.open=true;
      $("libraryPage").classList.add("show");
      hideFleet(true);
      $("libraryBtn").title=t("global.topbar.back_to_fleet_title");
      $("libraryBtn").setAttribute("aria-pressed","true");
      if(typeof syncTopbarActive==="function") syncTopbarActive();
    }
    route(path||"/library", push);
  }
  function closePage(){
    if(!L.open) return;
    L.open=false; L.req++; L.gridKept=false;
    $("libraryPage").classList.remove("show");
    hideFleet(false);
    $("libraryBtn").title=t("library.title");
    $("libraryBtn").setAttribute("aria-pressed","false");
    if(!L.syncing && /^\/library/i.test(location.pathname)) history.pushState(null,"","/");
    if(typeof applyRoleUI==="function") applyRoleUI();
  }
  function go(path){ route(path,true); }
  function route(path, push){
    const m=/^\/library\/m\/([0-9a-f-]{36})\/?$/i.exec(path);
    const view=m?"model":/^\/library\/attention\/?$/i.test(path)?"attention":"grid";
    if(push && !L.syncing && location.pathname!==path) history.pushState(null,"",path);
    const pageEl=$("libraryPage");
    if(L.view==="grid" && view!=="grid" && L.models.length){ L.gridKept=true; L.gridScroll=pageEl?pageEl.scrollTop:0; }
    L.view=view; L.uuid=m?m[1].toLowerCase():null;
    if(view==="grid") readGridUrl();
    if(pageEl) pageEl.scrollTop=0;
    render();
  }
  window.addEventListener("popstate",()=>{
    const onLib=/^\/library/i.test(location.pathname);
    L.syncing=true;
    try{ if(!onLib){ closePage(); return; } openPage(location.pathname,false); }
    finally{ L.syncing=false; }
  });

  function render(){
    const root=$("libraryPage");
    if(!root) return;
    root.innerHTML=`<div class="lib-shell">
      <div class="lib-bars" id="libBars"></div>
      <div id="libBody"><div class="lib-loading">${esc(t("library.loading"))}</div></div></div>`;
    // What this person may change comes with the overview: the first view
    // waits for it (or tools would render as if they had none); later views
    // use the one already known and refresh it alongside.
    const first=!L.overview;
    const ready=loadOverview();
    const token=L.req;
    (first?ready:Promise.resolve()).then(()=>{
      if(token!==L.req) return;
      if(L.view==="model") renderModel(L.uuid);
      else if(L.view==="attention") renderAttention();
      else renderGrid();
    });
  }

  // Offline locations, indexing, and the way to Needs attention: shown on
  // every Library view.
  async function loadOverview(){
    const token=L.req;
    try{ L.overview=await api("/api/library/overview"); }catch(e){ L.overview=null; return renderBars(e); }
    if(token!==L.req) return;
    renderBars();
    if(L.view==="grid"){ updateScanUI(); renderFolderTools(); joinRunningScan(); }
  }
  function renderBars(err){
    const el=$("libBars"); if(!el) return;
    if(err){ el.innerHTML=err.code==="library_unavailable"||err.status===503?`<div class="lib-bar is-bad">${esc(t("library.unavailable"))}</div>`:""; return; }
    const o=L.overview; if(!o) return;
    const off=o.roots.filter(r=>r.offline);
    const fl=L.flash;
    const ix=o.indexing;
    const idx=ix&&(ix.scanning||ix.queued||ix.hashing);
    el.innerHTML=
      (fl?`<div class="lib-bar ${fl.error?"is-bad":"is-ok"}" role="status"><span>${esc(fl.text)}</span>
        ${fl.actionId?`<button type="button" class="btn ghost btn-sm" id="libFlashUndo">${esc(t("library.undo"))}</button>`:""}
        <button type="button" class="modalx" id="libFlashX" aria-label="${esc(t("library.close"))}">✕</button></div>`:"")+
      off.map(r=>`<div class="lib-bar is-warn" role="status"><span class="lib-bar-dot"></span>
        <span>${esc(t("library.offline_bar",{name:r.name}))}</span>
        ${isAdmin()?`<button type="button" class="btn ghost btn-sm lib-recheck" data-root="${esc(r.id)}">${esc(t("library.recheck"))}</button>`:""}</div>`).join("")+
      (idx?`<div class="lib-pill" role="status"><span class="lib-spin"></span>${esc(ix.scanning?t("library.indexing_scan",{name:(o.roots.find(r=>r.id===ix.scanning.rootId)||{}).name||""}):ix.hashing?t("library.indexing_hash",{n:ix.hashing.remaining??"…"}):t("library.indexing"))}</div>`:"");
    el.querySelectorAll(".lib-recheck").forEach(b=>b.addEventListener("click",async()=>{
      b.disabled=true; b.textContent=t("library.rechecking");
      try{ await fetch("/api/library/roots/"+encodeURIComponent(b.dataset.root)+"/rescan",{method:"POST"}); }catch{}
      setTimeout(loadOverview,1500);
    }));
    if($("libFlashUndo")) $("libFlashUndo").addEventListener("click",()=>undoAction(fl.actionId));
    if($("libFlashX")) $("libFlashX").addEventListener("click",()=>{ L.flash=null; renderBars(); });
    const n=$("libAttnCount");
    if(n){ const c=o.attention||{}; const k=(c.action||0)+(c.review||0); n.textContent=k?String(k):""; n.style.display=k?"":"none"; n.classList.toggle("is-bad",!!c.action); }
  }

  // ---- grid ----
  function filterQS(f, extra){
    const p=new URLSearchParams();
    if(f.q) p.set("q",f.q);
    if(f.printer) p.set("printer",f.printer);
    if(f.location) p.set("location",f.location);
    if(f.type) p.set("type",f.type);
    if(f.material) p.set("material",f.material);
    if(f.attention) p.set("attention","1");
    if(f.hidden) p.set("hidden","1");
    if(f.sort&&f.sort!=="name") p.set("sort",f.sort);
    for(const [k,v] of Object.entries(extra||{})) if(v!=null) p.set(k,v);
    return p.toString();
  }
  async function renderGrid(){
    const body=$("libBody");
    const f=L.filters;
    body.innerHTML=`
      <div class="lib-head">
        <div class="lib-title"><h1>${esc(t("library.title"))}</h1><span class="lib-count" id="libCount"></span></div>
        <a class="lib-attn-link" href="/library/attention" id="libAttnLink">${esc(t("library.needs_attention"))}<span class="lib-attn-n" id="libAttnCount" style="display:none"></span></a>
      </div>
      <div class="lib-filters" role="search">
        <div class="lib-search"><label class="fl" for="libQ">${esc(t("library.search_label"))}</label>
          <input class="field" id="libQ" type="search" autocomplete="off" placeholder="${esc(t("library.search_placeholder"))}" value="${esc(f.q)}"></div>
        <div class="lib-f"><label class="fl" for="libPrinter">${esc(t("library.f_printer"))}</label><select class="field" id="libPrinter"></select></div>
        <div class="lib-f"><label class="fl" for="libLocation">${esc(t("library.f_location"))}</label><select class="field" id="libLocation"></select></div>
        <div class="lib-f"><label class="fl" for="libType">${esc(t("library.f_type"))}</label><select class="field" id="libType"></select></div>
        <div class="lib-f"><label class="fl" for="libMaterial">${esc(t("library.f_material"))}</label><select class="field" id="libMaterial"></select></div>
        <div class="lib-f"><label class="fl" for="libSort">${esc(t("library.f_sort"))}</label><select class="field" id="libSort">
          <option value="name">${esc(t("library.sort_name"))}</option><option value="recent">${esc(t("library.sort_recent"))}</option><option value="attention">${esc(t("library.sort_attention"))}</option></select></div>
        <div class="lib-f lib-f-check" id="libSubfoldersWrap"></div>
        <div class="lib-f lib-f-tools" id="libFolderTools"></div>
        <div class="lib-f lib-f-check" id="libHiddenWrap" style="display:none">${checkboxHtml("libHidden", f.hidden, t("library.f_hidden"), "", false)}</div>
      </div>
      <div class="lib-split" id="libSplit">
        <aside class="lib-folders" id="libFolders" aria-label="${esc(t("library.folders"))}" hidden></aside>
        <div class="lib-main">
          <div class="lib-active" id="libActive"></div>
          <div class="lib-grid" id="libGrid" aria-live="polite"></div>
          <div class="lib-more" id="libMore"></div>
        </div>
      </div>`;
    $("libSort").value=f.sort;
    wireFolders();
    if(L.overview) renderBars();
    let debounce=null;
    $("libQ").addEventListener("input",()=>{ clearTimeout(debounce); debounce=setTimeout(()=>{ f.q=$("libQ").value.trim(); loadModels(true); },220); });
    for(const [id,key] of [["libPrinter","printer"],["libType","type"],["libMaterial","material"],["libSort","sort"]]){
      $(id).addEventListener("change",()=>{ f[key]=$(id).value; loadModels(true); });
    }
    // The dropdown and the tree are one choice: a new Location selects its top folder in the tree.
    $("libLocation").addEventListener("change",()=>{ selectFolder({ root:$("libLocation").value, folder:"", loose:false }); });
    $("libHidden").addEventListener("change",()=>{ f.hidden=$("libHidden").checked; loadModels(true); });
    $("libAttnLink").addEventListener("click",e=>{ e.preventDefault(); go("/library/attention"); });
    if(L.gridKept && L.models.length && L.gridKey===gridKey()){
      // Back from a Model: the same cards, the same place, no new requests.
      L.gridKept=false;
      applyFacets();
      renderFolders(); renderFolderTools();
      showCards(0, true);
      const pageEl=$("libraryPage");
      if(pageEl) requestAnimationFrame(()=>{ pageEl.scrollTop=L.gridScroll; });
      return;
    }
    await loadFacets();
    loadModels(true);
  }
  async function loadFacets(){
    try{ L.facets=await api("/api/library/facets"); }catch{ L.facets=null; }
    applyFacets();
  }
  function applyFacets(){
    const fc=L.facets||{families:[],roots:[],types:[],materials:[]}, f=L.filters;
    const opts=(sel, all, items, val)=>{ const el=$(sel); if(!el) return;
      el.innerHTML=`<option value="">${esc(all)}</option>`+items.map(i=>`<option value="${esc(i.v)}">${esc(i.l)} (${i.n})</option>`).join("");
      el.value=items.some(i=>i.v===val)?val:""; };
    opts("libPrinter", t("library.f_any_printer"), fc.families.map(x=>({v:x.key,l:x.label||x.key,n:x.count})), f.printer);
    opts("libLocation", t("library.f_any_location"), fc.roots.map(x=>({v:x.id,l:x.name,n:x.count})), f.location);
    opts("libType", t("library.f_any_type"), fc.types.map(x=>({v:x.key,l:t("library.type_"+x.key),n:x.count})), f.type);
    opts("libMaterial", t("library.f_any_material"), fc.materials.map(x=>({v:x.key,l:x.key,n:x.count})), f.material);
    // Hidden Models are only offered when there are some (M6: recoverable).
    if($("libHiddenWrap")){ $("libHiddenWrap").style.display=(fc.hidden||f.hidden)?"":"none"; const lab=$("libHiddenWrap").querySelector(".checkbox-label"); if(lab) lab.textContent=t("library.f_hidden_n",{n:fc.hidden||0}); }
  }
  // {tree:false}: only the folder changed, so the panel's counts still hold.
  async function loadModels(reset, { tree=true }={}){
    if(reset&&tree) loadTree();
    const token=++L.req;
    const grid=$("libGrid"); if(!grid) return;
    if(reset){ L.models=[]; L.next=null; L.gridKey=gridKey(); grid.setAttribute("aria-busy","true"); }
    let res;
    try{ res=await api("/api/library/models?"+gridQS({limit:PAGE, cursor:reset?null:L.next})); }
    catch(e){ if(token===L.req){ grid.removeAttribute("aria-busy"); grid.innerHTML=`<div class="lib-empty">${esc(e.status===503?t("library.unavailable"):t("library.load_failed"))}</div>`; } return; }
    if(token!==L.req||!$("libGrid")) return;
    grid.removeAttribute("aria-busy");
    L.total=res.total; L.next=res.next;
    const start=L.models.length;
    L.models=L.models.concat(res.models);
    showCards(start, reset);
  }
  function showCards(start, reset){
    const grid=$("libGrid"); if(!grid) return;
    $("libCount").textContent=tn("library.models_count",L.total);
    renderActive();
    if(reset) grid.innerHTML="";
    if(!L.models.length){ grid.innerHTML=`<div class="lib-empty">${esc(emptyText())}</div>`; }
    else grid.insertAdjacentHTML("beforeend", L.models.slice(start).map(cardHtml).join(""));
    grid.querySelectorAll(".lib-card:not([data-wired])").forEach(c=>{
      c.dataset.wired="1";
      c.addEventListener("click",e=>{
        // A type tag sets the Type filter; the card's link must not open.
        const tag=e.target.closest(".lib-type");
        if(tag){ e.preventDefault(); e.stopPropagation(); setTypeFilter(tag.dataset.type); return; }
        if(e.metaKey||e.ctrlKey||e.button===1) return; e.preventDefault(); go("/library/m/"+c.dataset.uuid);
      });
    });
    fitFolders();
    const more=$("libMore");
    more.innerHTML=L.next?`<button type="button" class="btn ghost" id="libMoreBtn">${esc(t("library.show_more",{shown:L.models.length,total:L.total}))}</button>`:"";
    if(L.next){
      $("libMoreBtn").addEventListener("click",()=>loadModels(false));
      // Next page when the button scrolls into view: still one request at a
      // time, and never for a page nobody scrolled to.
      if("IntersectionObserver" in window){
        const io=new IntersectionObserver(es=>{ if(es.some(x=>x.isIntersecting)){ io.disconnect(); if(L.next&&!L.loadingMore){ L.loadingMore=true; loadModels(false).finally(()=>{ L.loadingMore=false; }); } } },{root:$("libraryPage"),rootMargin:"400px"});
        io.observe($("libMoreBtn"));
      }
    }
  }
  // An empty folder view says what is below it, when Include subfolders is off.
  function emptyText(){
    const s=L.sel;
    if(s.root&&s.folder&&!s.loose&&!L.subfolders&&L.tree){
      const r=L.tree.roots.find(x=>x.id===s.root);
      let n=null, level=r?r.children:[];
      for(const part of s.folder.split("/")){ n=level.find(c=>c.name===part); if(!n) break; level=n.children; }
      if(n&&n.count) return tn("library.empty_own_files",n.count);
    }
    return anyFilter()?t("library.no_match"):t("library.empty");
  }
  function setTypeFilter(type){
    L.filters.type=type;
    const el=$("libType"); if(el) el.value=[...el.options].some(o=>o.value===type)?type:"";
    loadModels(true);
  }
  const anyFilter=()=>{ const f=L.filters; return !!(f.q||f.printer||f.location||f.type||f.material||f.attention||f.hidden); };
  function renderActive(){
    const el=$("libActive"); if(!el) return;
    el.innerHTML=anyFilter()?`<button type="button" class="btn ghost btn-sm" id="libClear">${esc(t("library.clear_filters"))}</button>`:"";
    if($("libClear")) $("libClear").addEventListener("click",()=>{ Object.assign(L.filters,{q:"",printer:"",location:"",type:"",material:"",attention:false,hidden:false}); L.sel={ root:"", folder:"", loose:false }; syncGridUrl(true); renderGrid(); });
  }

  // The fleet-fit chips: which printer families this Model has files for,
  // lit when the fleet has such a printer, with how many are idle now.
  function familyChips(families, max){
    const shown=families.slice(0,max);
    return shown.map(fam=>{
      const fit=fleetFit(fam.key);
      const cls=fit.idle.length?"is-fit is-idle":fit.printers.length?"is-fit":"";
      const title=fit.printers.length?tn("library.fit_title",fit.printers.length,{family:fam.label||fam.key,idle:fit.idle.length}):t("library.fit_none_title",{family:fam.label||fam.key});
      return `<span class="lib-fam ${cls}" title="${esc(title)}">${esc(shortFamily(fam.label||fam.key))}${fit.idle.length?`<b>${fit.idle.length}</b>`:""}</span>`;
    }).join("")+(families.length>max?`<span class="lib-fam is-more" title="${esc(families.slice(max).map(x=>x.label).join(", "))}">+${families.length-max}</span>`:"");
  }
  // "Creality Ender-3 V3 Plus" → "Ender-3 V3 Plus": the brand is noise on a card.
  const shortFamily=l=>String(l||"").replace(/^(Creality|Flashforge|Snapmaker|Bambu Lab|Anycubic|Prusa|Elegoo|Qidi|Sovol)\s+/i,"");

  function coverHtml(cover, name, cls){
    return cover&&cover.thumb
      ? `<img class="${cls||"lib-cover-img"}" loading="lazy" decoding="async" alt="" data-initial="${esc((name||"?").trim().charAt(0).toUpperCase())}" src="${thumbUrl(cover.thumb)}">`
      : `<span class="lib-noimg" aria-hidden="true">${esc((name||"?").trim().charAt(0).toUpperCase())}</span>`;
  }
  // The card's detail line. A single file says nothing about itself here:
  // its type tag already does ("PLA · 1 print", not "1 file · PLA · 1 print"). Pure.
  function cardMetaHtml(m){
    const what=m.variants>1?tn("library.n_variants",m.variants):m.projects&&!m.variants?tn("library.n_projects",m.projects):m.files>1?tn("library.n_files",m.files):"";
    return [what?esc(what):"", m.materials.length?esc(m.materials.slice(0,3).join(", ")):"",
      m.prints?`<span title="${esc(printsLine(m.prints))}">${esc(tn("library.n_prints",m.prints.count))}</span>`:""].filter(Boolean).join(" · ");
  }
  // One tag per file type in the Model (gcode, 3mf · sliced, 3mf, then its
  // source file's extension), bottom-left of the picture. Clicking one sets
  // the Type filter (mouse only; the Type menu is the keyboard's way). Pure.
  const TYPE_ICONS={
    gcode:`<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5h6v3H3z M4.5 4.5h3l-1 3h-1z M6 7.5v1.5 M3.5 10.5h5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
    cube:`<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 10.4 3.6 6 6 1.6 3.6z" fill="currentColor" fill-opacity=".35"/><path d="M6 1.2 10.4 3.6v4.8L6 10.8 1.6 8.4V3.6zM1.6 3.6 6 6l4.4-2.4M6 6v4.8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>`,
    cubeOutline:`<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 10.4 3.6v4.8L6 10.8 1.6 8.4V3.6zM1.6 3.6 6 6l4.4-2.4M6 6v4.8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>`,
  };
  function typeTagsHtml(types){
    if(!types||!types.length) return "";
    return `<span class="lib-types">${types.map(x=>{
      const k=x.type;
      const label=k==="3mf_sliced"?`3mf · ${t("library.tag_sliced")}`:k==="source"?x.ext:k==="gcode"?"gcode":"3mf";
      const cls=k==="gcode"?"":k==="source"?" is-source":" is-3mf";
      const icon=k==="gcode"?TYPE_ICONS.gcode:k==="source"?TYPE_ICONS.cubeOutline:TYPE_ICONS.cube;
      return `<span class="lib-type${cls}" data-type="${esc(k)}" title="${esc(t("library.tag_title_"+k))}">${icon}<span>${esc(label)}</span></span>`;
    }).join("")}</span>`;
  }
  function cardHtml(m){
    const att=m.attention&&m.attention.count?`<span class="lib-badge ${m.attention.level==="action"?"is-bad":"is-warn"}" title="${esc(tn("library.attention_title",m.attention.count))}">${esc(m.attention.level==="action"?t("library.badge_action"):t("library.badge_review"))}</span>`:"";
    const off=m.offline?`<span class="lib-badge is-off" title="${esc(m.offline==="all"?t("library.offline_card_title"):t("library.offline_some_title"))}">${esc(t("library.badge_offline"))}</span>`:
      m.missing||m.unreadable?`<span class="lib-badge is-bad" title="${esc(t("library.missing_card_title"))}">${esc(m.missing?t("library.badge_missing"):t("library.badge_unreadable"))}</span>`:"";
    return `<a class="lib-card${m.offline==="all"?" is-offline":""}" href="/library/m/${esc(m.uuid)}" data-uuid="${esc(m.uuid)}">
      <span class="lib-well">${coverHtml(m.cover,m.name)}<span class="lib-badges">${att}${off}</span>${typeTagsHtml(m.types)}</span>
      <span class="lib-card-body">
        <span class="lib-name" title="${esc(m.name)}">${esc(m.name)}</span>
        <span class="lib-meta">${cardMetaHtml(m)}</span>
        ${m.families.length?`<span class="lib-fams">${familyChips(m.families,2)}</span>`:""}${folderLineHtml(m.folder)}
      </span></a>`;
  }

  // ---- folders (the Folders panel, breadcrumb, Include subfolders, Rescan) ----
  const ICON_FOLDER=`<svg class="lib-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const ICON_FILE=`<svg class="lib-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  const ICON_RESCAN=`<svg class="lib-ico lib-rescan-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9 M13.5 2v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // Per browser. Read while L is being built, so no const declared below it.
  function readSubfolders(){ try{ return localStorage.getItem("snapcon.library.subfolders")!=="0"; }catch{ return true; } }
  function saveSubfolders(on){ try{ localStorage.setItem("snapcon.library.subfolders", on?"1":"0"); }catch{} }

  // The folder in the URL: /library?location=<id>&folder=<path> (or
  // &loose=1). The Location dropdown is the tree's selection: its location.
  // Nothing in the URL: null, and the page keeps what it had. Pure.
  function parseGridUrl(search){
    const p=new URLSearchParams(search||"");
    if(!["location","folder","loose"].some(k=>p.has(k))) return null;
    const root=p.get("location")||"";
    return { root, folder:root?String(p.get("folder")||"").split("/").filter(Boolean).join("/"):"", loose:!!root&&p.get("loose")==="1" };
  }
  function gridUrlFor(sel){
    const p=new URLSearchParams();
    if(sel.root){
      p.set("location",sel.root);
      if(sel.loose) p.set("loose","1"); else if(sel.folder) p.set("folder",sel.folder);
    }
    const q=p.toString().replace(/%2F/gi,"/");
    return "/library"+(q?"?"+q:"");
  }
  function readGridUrl(){
    const u=parseGridUrl(location.search);
    if(u){ L.sel=u; L.filters.location=u.root; }
    else syncGridUrl(false);
  }
  function syncGridUrl(push){
    if(L.syncing) return;
    const u=gridUrlFor(L.sel);
    if(location.pathname+location.search===u) return;
    history[push?"pushState":"replaceState"](null,"",u);
  }
  // What the grid shows: the Location filter, narrowed to the chosen folder.
  function folderParams(sel, subfolders){
    if(!sel.root) return {};
    if(sel.loose) return { loose:"1" };
    return { folder:sel.folder, subfolders:subfolders?null:"0" };
  }
  const gridQS=extra=>filterQS({ ...L.filters, location:L.sel.root }, { ...folderParams(L.sel, L.subfolders), ...(extra||{}) });
  const gridKey=()=>gridQS({});

  // A folder that's gone (deleted on disk, or a stale link) falls back to its
  // nearest parent that still exists; a location that's gone, to the top. Pure.
  function nearestFolder(tree, sel){
    if(!tree||!sel.root) return sel;
    const r=tree.roots.find(x=>x.id===sel.root);
    if(!r) return { root:"", folder:"", loose:false };
    if(sel.loose) return r.loose ? sel : { root:sel.root, folder:"", loose:false };
    const has=path=>{ let level=r.children; for(const part of path.split("/")){ const n=level.find(c=>c.name===part); if(!n) return false; level=n.children; } return true; };
    let f=sel.folder;
    while(f && !has(f)) f=f.includes("/")?f.slice(0,f.lastIndexOf("/")):"";
    return { root:sel.root, folder:f, loose:false };
  }
  // "Scanned 12 min ago". Pure.
  function scannedText(at, now){
    if(!at) return t("library.scanned_never");
    const s=Math.max(0, Math.floor((now-at)/1000));
    if(s<60) return t("library.scanned_just_now");
    if(s<3600) return t("library.scanned_min",{n:Math.floor(s/60)});
    if(s<86400) return t("library.scanned_hours",{n:Math.floor(s/3600)});
    return t("library.scanned_days",{n:Math.floor(s/86400)});
  }
  // Why a location couldn't be read, in plain words (the server's words never
  // carry its folder). Pure.
  function scanErrorText(name, error){
    const why=error==="folder not found"?t("library.scan_err_not_found"):error==="not a folder"?t("library.scan_err_not_folder")
      :/^not readable/.test(error||"")?t("library.scan_err_not_readable"):error==="not reachable"?t("library.scan_err_unreachable"):t("library.scan_err_unknown");
    return t("library.scan_failed",{name, reason:why});
  }
  function folderLineHtml(f){
    if(!f) return "";
    const text=f.path!=null?f.path:tn("library.n_folders",f.paths.length);
    const title=f.path!=null?f.path:f.paths.join("\n");
    return `<span class="lib-card-folder" title="${esc(title)}">${ICON_FOLDER}<span class="lib-card-folder-txt">${esc(text)}</span></span>`;
  }

  async function loadTree(){
    const token=++L.treeReq;
    let tree;
    try{ tree=await api("/api/library/folders?"+filterQS({ ...L.filters, location:"" })); }catch{ return; }   // the last good tree stays
    if(token!==L.treeReq||L.view!=="grid") return;
    L.tree=tree;
    // A folder that has gone since: its nearest parent.
    const next=nearestFolder(tree, L.sel);
    if(next.root!==L.sel.root||next.folder!==L.sel.folder||next.loose!==L.sel.loose){ L.sel=next; L.filters.location=next.root; syncLocationSelect(); syncGridUrl(false); loadModels(true,{ tree:false }); }
    renderFolders(); renderFolderTools();
  }
  const treeHasFolders=tree=>!!tree&&(tree.roots.length>1||tree.roots.some(r=>r.children.length));
  // "Any location" in the dropdown is "All locations" in the tree.
  function syncLocationSelect(){ const el=$("libLocation"); if(el&&el.value!==L.sel.root&&[...el.options].some(o=>o.value===L.sel.root)) el.value=L.sel.root; }
  const keyOf=(root,folder)=>root+"\u0001"+folder;
  const isSel=(root,folder,loose)=>L.sel.root===root&&!!L.sel.loose===!!loose&&(loose||L.sel.folder===folder);

  function treeHtml(){
    const T=L.tree; if(!T) return "";
    // The way to the chosen folder is always open.
    // (unless closed by hand since).
    const open=new Set(L.expanded);
    // The chosen folder opens too, to show what is below it.
    if(L.sel.root){ open.add(keyOf(L.sel.root,"")); const segs=L.sel.folder.split("/").filter(Boolean); segs.forEach((_,i)=>open.add(keyOf(L.sel.root,segs.slice(0,i+1).join("/")))); }
    for(const k of L.collapsed) open.delete(k);
    const pick=(root,folder,loose,icon,name,n,depth,toggle)=>{
      const sel=isSel(root,folder,loose);
      return `<div class="lib-tree-row${sel?" is-sel":""}${n?"":" is-zero"}" style="--d:${depth}">`+
        (toggle||`<span class="lib-tree-tw" aria-hidden="true"></span>`)+
        `<button type="button" class="lib-tree-pick" data-root="${esc(root)}" data-folder="${esc(folder)}"${loose?` data-loose="1"`:""}${sel?` aria-current="true"`:""} title="${esc(name)}">${icon}<span class="lib-tree-name">${esc(name)}</span><span class="lib-tree-n">${n}</span></button></div>`;
    };
    const toggleBtn=(key,name,isOpen)=>`<button type="button" class="lib-tree-tw" data-toggle="${esc(key)}" aria-expanded="${isOpen}" aria-label="${esc(t(isOpen?"library.collapse_folder":"library.expand_folder",{name}))}"><span class="lib-tree-caret"></span></button>`;
    const folderList=(root,nodes,depth)=>nodes.map(n=>{
      const k=keyOf(root,n.path), kids=n.children.length, isOpen=kids&&open.has(k);
      return `<li>${pick(root,n.path,false,ICON_FOLDER,n.name,n.count,depth,kids?toggleBtn(k,n.name,!!isOpen):null)}${isOpen?`<ul>${folderList(root,n.children,depth+1)}</ul>`:""}</li>`;
    }).join("");
    const rootBody=(r,depth)=>folderList(r.id,r.children,depth)+(r.loose?`<li>${pick(r.id,"",true,ICON_FILE,t("library.loose_files"),r.loose.count,depth,null)}</li>`:"");
    if(T.roots.length===1){
      // One location: it is the top row (All locations would be the same thing).
      const r=T.roots[0];
      return `<ul class="lib-tree"><li>${pick(r.id,"",false,ICON_FOLDER,r.name,r.count,0,null)}<ul>${rootBody(r,1)}</ul></li></ul>`;
    }
    if(!T.roots.length) return "";
    return `<ul class="lib-tree"><li>${pick("","",false,ICON_FOLDER,t("library.all_locations"),T.count,0,null)}<ul>${T.roots.map(r=>{
      const k=keyOf(r.id,""), kids=r.children.length||r.loose, isOpen=kids&&open.has(k);
      return `<li>${pick(r.id,"",false,ICON_FOLDER,r.name,r.count,1,kids?toggleBtn(k,r.name,!!isOpen):null)}${isOpen?`<ul>${rootBody(r,2)}</ul>`:""}</li>`;
    }).join("")}</ul></li></ul>`;
  }
  // Rescan, its "Scanned … ago" line and its error: the same markup in the
  // panel, the narrow-screen sheet and beside the breadcrumb.
  function scanTargets(){
    const roots=(L.overview&&L.overview.roots)||[];
    return L.sel.root ? roots.filter(r=>r.id===L.sel.root) : roots;
  }
  function rescanLabel(){ return L.sel.root||scanTargets().length===1 ? t("library.rescan") : t("library.rescan_all"); }
  function rescanBtnHtml(iconOnly){
    if(!(L.overview&&L.overview.can&&L.overview.can.rescan)) return "";
    return `<button type="button" class="lib-rescan${iconOnly?" is-icon":""}" data-rescan>${ICON_RESCAN}<span class="lib-rescan-txt">${esc(rescanLabel())}</span></button>`;
  }
  function scanInfoHtml(){ return `<div class="lib-scan-line" data-scan-line></div><div class="lib-scan-err" data-scan-err role="status"></div>`; }
  function folderHeadHtml(){
    return `<div class="lib-folders-head"><div class="lib-folders-title"><h2>${esc(t("library.folders"))}</h2>${scanInfoHtml()}</div>${rescanBtnHtml(false)}</div>`;
  }
  function renderFolders(){
    const el=$("libFolders"); if(!el) return;
    const show=treeHasFolders(L.tree);
    el.hidden=!show;
    $("libSplit").classList.toggle("has-folders", show);
    if(show){
      // Re-rendered on every count change: keep where the tree was scrolled.
      const old=el.querySelector(".lib-tree-wrap"), top=old?old.scrollTop:0;
      el.innerHTML=folderHeadHtml()+`<div class="lib-tree-wrap">${treeHtml()}</div>`;
      el.querySelector(".lib-tree-wrap").scrollTop=top;
    }
    const sh=$("libFolderSheet");
    if(sh) sh.innerHTML=folderHeadHtml()+`<div class="lib-tree-wrap">${treeHtml()}</div>`;
    updateScanUI();
    fitFolders();
  }
  // The panel reaches the bottom of what is visible, 16px above it, at any
  // scroll position: sticky keeps its top, this keeps its bottom. Run on the
  // Library's scroll and on resize, once per frame.
  function fitFolders(){
    const el=$("libFolders"), page=$("libraryPage");
    if(!el||el.hidden||!page||getComputedStyle(el).display==="none") return;
    // The page's visible bottom from its max-height, not its content: with a
    // short grid the panel itself sets the content's height, and measuring
    // that would feed back on the next fit.
    const pr=page.getBoundingClientRect(), max=parseFloat(getComputedStyle(page).maxHeight);
    const bottom=Math.min(window.innerHeight, pr.top+(Number.isFinite(max)?max:pr.height));
    el.style.height=Math.max(160, Math.floor(bottom-el.getBoundingClientRect().top-16))+"px";
  }
  function wireFit(){
    if(L.fitWired) return;
    L.fitWired=true;
    let raf=0;
    const on=()=>{ if(!raf) raf=requestAnimationFrame(()=>{ raf=0; fitFolders(); }); };
    $("libraryPage").addEventListener("scroll",on,{ passive:true });
    window.addEventListener("resize",on);
  }
  // In the filter row: Include subfolders, and — on narrow screens — the
  // Folders button with its sheet, or — when the panel is hidden because no
  // location has subfolders — Rescan with its "Scanned … ago".
  function renderFolderTools(){
    const sw=$("libSubfoldersWrap"), el=$("libFolderTools"); if(!sw||!el) return;
    const show=treeHasFolders(L.tree);
    const noSwitch=!L.sel.root||L.sel.loose;
    const why=!L.sel.root?t("library.subfolders_all_title"):t("library.subfolders_loose_title");
    sw.innerHTML=`<span${noSwitch?` title="${esc(why)}"`:""}>${switchHtml("libSubfolders", noSwitch?!L.sel.root:L.subfolders, t("library.include_subfolders"), "", noSwitch)}</span>`;
    el.innerHTML=show
      ? `<span class="lib-folders-btn-wrap"><button type="button" class="btn ghost lib-folders-btn" id="libFoldersBtn" aria-expanded="${L.sheetOpen}" aria-controls="libFolderSheet">${ICON_FOLDER}<span>${esc(t("library.folders"))}</span></button>${rescanBtnHtml(true)}
          <div class="lib-sheet" id="libFolderSheet"${L.sheetOpen?"":" hidden"}></div></span>`
      : `<span class="lib-tools-scan">${rescanBtnHtml(false)}<span class="lib-tools-scan-txt">${scanInfoHtml()}</span></span>`;
    if(L.sheetOpen) renderFolders(); else updateScanUI();
  }
  function selectFolder(sel, { tree=false }={}){
    L.sel=sel; L.filters.location=sel.root; L.sheetOpen=false; L.collapsed.clear();
    syncLocationSelect();
    syncGridUrl(true);
    renderFolders(); renderFolderTools();
    loadModels(true,{ tree });
  }
  function wireFolders(){
    const split=$("libBody"); if(!split) return;
    wireFit();
    split.addEventListener("click",e=>{
      const tw=e.target.closest("[data-toggle]");
      if(tw){ const k=tw.dataset.toggle; if(tw.getAttribute("aria-expanded")==="true"){ L.expanded.delete(k); L.collapsed.add(k); } else { L.expanded.add(k); L.collapsed.delete(k); } renderFolders(); return; }
      const pk=e.target.closest(".lib-tree-pick");
      if(pk){ selectFolder({ root:pk.dataset.root, folder:pk.dataset.folder||"", loose:pk.dataset.loose==="1" }); return; }
      if(e.target.closest("[data-rescan]")){ startRescan(); return; }
      if(e.target.closest("#libFoldersBtn")){ L.sheetOpen=!L.sheetOpen; renderFolderTools(); if(L.sheetOpen){ const first=$("libFolderSheet")&&$("libFolderSheet").querySelector(".lib-tree-pick[aria-current]")||$("libFolderSheet").querySelector(".lib-tree-pick"); if(first) first.focus(); } return; }
    });
    split.addEventListener("change",e=>{
      if(e.target.id!=="libSubfolders") return;
      L.subfolders=e.target.checked; saveSubfolders(L.subfolders);
      loadModels(true,{ tree:false });
    });
    // The sheet closes on Esc and on a click outside it.
    if(!L.sheetWired){
      L.sheetWired=true;
      document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&L.sheetOpen){ L.sheetOpen=false; renderFolderTools(); const b=$("libFoldersBtn"); if(b) b.focus(); } });
      document.addEventListener("click",e=>{ if(L.sheetOpen&&!e.target.closest(".lib-folders-btn-wrap")){ L.sheetOpen=false; renderFolderTools(); } });
    }
  }

  // ---- rescan ----
  function updateScanUI(){
    const sc=L.scan, roots=scanTargets();
    const at=roots.reduce((m,r)=>(r.lastScanAt&&(m==null||r.lastScanAt<m)?r.lastScanAt:m),null);
    const idle=t("library.rescan_title",{name:roots.length===1?roots[0].name:t("library.all_locations")});
    document.querySelectorAll("#libraryPage [data-rescan]").forEach(b=>{
      b.disabled=sc.running; b.classList.toggle("is-running",sc.running);
      b.title=sc.running?t("library.scanning"):idle;
      b.setAttribute("aria-label",sc.running?t("library.scanning"):idle);
      const tx=b.querySelector(".lib-rescan-txt"); if(tx) tx.textContent=sc.running?t("library.scanning"):rescanLabel();
    });
    document.querySelectorAll("#libraryPage [data-scan-line]").forEach(el=>{ el.textContent=sc.running?t("library.scanning"):scannedText(at, Date.now()); });
    document.querySelectorAll("#libraryPage [data-scan-err]").forEach(el=>{ el.textContent=sc.error||""; el.hidden=!sc.error; });
  }
  const busy=r=>!!(r&&(r.scanning||r.queued||r.checking));
  async function startRescan(){
    const sc=L.scan; if(sc.running) return;
    const targets=scanTargets().map(r=>r.id); if(!targets.length) return;
    sc.running=true; sc.error=null; sc.targets=targets; updateScanUI();
    const failed=[];
    await Promise.all(targets.map(async id=>{
      try{
        const r=await fetch("/api/library/roots/"+encodeURIComponent(id)+"/rescan",{method:"POST"});
        if(typeof checkAuthFailure==="function") checkAuthFailure(r);
        const v=await r.json().catch(()=>({}));
        if(!r.ok) failed.push({ name:(scanTargets().find(x=>x.id===id)||{}).name||id, error:null, message:v.error });
        else if(v.status==="error"||v.status==="offline") failed.push({ name:v.name, error:v.error||(v.status==="offline"?"not reachable":v.lastError) });
      }catch{ failed.push({ name:id, error:"not reachable" }); }
    }));
    if(failed.length===targets.length){ finishRescan(failed); return; }
    pollRescan(failed);
  }
  // While this page's rescan is queued or running: the overview every 2 s
  // (the only timer, and only then). Also joins a scan already running.
  function pollRescan(failed){
    const sc=L.scan;
    clearTimeout(sc.timer);
    sc.timer=setTimeout(async()=>{
      if(!L.open||L.view!=="grid"){ sc.running=false; return; }
      try{ L.overview=await api("/api/library/overview"); renderBars(); }catch{}
      const roots=((L.overview&&L.overview.roots)||[]).filter(r=>sc.targets.includes(r.id));
      if(roots.some(busy)) return pollRescan(failed);
      finishRescan(failed.concat(roots.filter(r=>r.error).map(r=>({ name:r.name, error:r.error })).filter(x=>!failed.some(f=>f.name===x.name))));
    },2000);
  }
  async function finishRescan(failed){
    const sc=L.scan;
    sc.running=false;
    sc.error=failed.length?failed.map(f=>f.message&&!f.error?f.message:scanErrorText(f.name,f.error)).join(" · "):null;
    updateScanUI();
    // In place: the same folder (or its nearest parent), filters and scroll.
    const pageEl=$("libraryPage"), top=pageEl?pageEl.scrollTop:0;
    await Promise.all([loadTree(), loadModels(true,{ tree:false })]);
    if(pageEl) requestAnimationFrame(()=>{ pageEl.scrollTop=top; });
  }
  // A scan already running when the page opens (another tab, the timer):
  // shown, and the page refreshes when it ends.
  function joinRunningScan(){
    const sc=L.scan; if(sc.running) return;
    const roots=scanTargets();
    if(!roots.some(busy)) return;
    sc.running=true; sc.error=null; sc.targets=roots.map(r=>r.id); updateScanUI();
    pollRescan([]);
  }

  // ---- the Model page ----
  async function renderModel(uuid){
    const token=L.req;
    let m;
    try{ m=await api("/api/library/models/"+encodeURIComponent(uuid)); }
    catch(e){ if(token===L.req) $("libBody").innerHTML=`${backHtml()}<div class="lib-empty">${esc(e.status===404?t("library.model_not_found"):t("library.load_failed"))}</div>`; wireBack(); return; }
    if(token!==L.req||!$("libBody")) return;
    // An old link to a merged Model lands on the survivor.
    if(m.mergedInto){ L.flash={text:t("library.was_merged",{name:m.name})}; history.replaceState(null,"","/library/m/"+m.mergedInto); return route("/library/m/"+m.mergedInto,false); }
    L.model=m; L.selected=new Set();
    const byFamily=new Map();
    for(const v of m.printables){ const k=v.printer.family||"~unknown"; if(!byFamily.has(k)) byFamily.set(k,[]); byFamily.get(k).push(v); }
    const famOrder=[...byFamily.keys()].sort((a,b)=>(a==="~unknown")-(b==="~unknown")||byFamily.get(b).length-byFamily.get(a).length);
    const facts=[
      m.designer?[t("library.designer"),esc(m.designer)]:null,
      m.license?[t("library.license"),esc(m.license)]:null,
      m.designModelId?[t("library.makerworld_id"),`<span class="lib-mono">${esc(m.designModelId)}</span>`]:null,
      [t("library.locations"),m.locations.map(l=>esc(l.name)+(l.offline?` <span class="lib-badge is-off">${esc(t("library.badge_offline"))}</span>`:"")).join(", ")],
    ].filter(Boolean);
    const fits=m.families.map(f=>({f,fit:fleetFit(f.key)})).filter(x=>x.fit.printers.length);
    // An unsliced project fits nothing yet, but says what it is set up for.
    const setUp=[...new Set(m.projects.map(p=>p.setUpFor&&p.setUpFor.label).filter(Boolean))];
    const fitsNone=m.printables.length?(m.families.length?t("library.fits_none"):t("library.fits_unknown"))
      :setUp.length?t("library.fits_setup",{printer:setUp.join(", ")}):t("library.fits_unsliced");
    $("libBody").innerHTML=`
      ${backHtml()}
      <div class="lib-model">
        <div class="lib-model-hero">
          <div class="lib-gallery">
            <div class="lib-well lib-well-lg" id="libHeroWell">${coverHtml(m.cover,m.name,"lib-cover-img")}</div>
            ${m.gallery.length>1?`<div class="lib-strip" role="list">${m.gallery.slice(0,12).map((g,i)=>`<button type="button" class="lib-thumb${i===0?" is-on":""}" data-thumb="${esc(g.thumb)}" title="${esc(g.label||"")}" aria-label="${esc(t("library.show_image",{n:i+1}))}"><img loading="lazy" alt="" src="${thumbUrl(g.thumb)}"></button>`).join("")}</div>`:""}
          </div>
          <div class="lib-model-facts">
            <h1 class="lib-model-name">${esc(m.name)}</h1>
            <div class="lib-model-sub">${esc(summaryLine(m))}${m.nameSource==="user"?` · <span title="${esc(t("library.named_by_person_title"))}">${esc(t("library.named_by_person"))}</span>`:""}</div>
            ${m.prints?`<div class="lib-model-sub lib-printed" title="${esc(t("library.prints_count_title"))}">${esc(printsLine(m.prints))}</div>`:""}
            ${m.hidden?`<div class="lib-bar is-warn"><span>${esc(t("library.hidden_banner"))}</span>${can("hide")?`<button type="button" class="btn ghost btn-sm" id="libUnhide">${esc(t("library.unhide_model"))}</button>`:""}</div>`:""}
            ${m.coverMissing?`<p class="settings-help lib-warn-text">${esc(t("library.cover_missing"))}</p>`:""}
            ${toolsHtml(m)}
            <dl class="lib-dl">${facts.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}
              <dt>${esc(t("library.fits"))}</dt><dd>${fits.length?fits.map(x=>fitLine(x)).join(""):`<span class="lib-dim">${esc(fitsNone)}</span>`}</dd>
            </dl>
            ${attentionBlock(m.attention)}
          </div>
        </div>
        ${m.suggestions.length?`<section class="lib-sec"><h2>${esc(t("library.sec_suggestions"))}</h2>${m.suggestions.map(suggestionHtml).join("")}</section>`:""}
        ${m.printables.length||!m.projects.length?`<section class="lib-sec"><h2>${esc(t("library.sec_printables"))} <span class="lib-sec-n">${m.printables.length}</span></h2>
          ${m.printables.length?famOrder.map(k=>familyGroupHtml(k,byFamily.get(k))).join(""):`<div class="lib-empty-sm">${esc(t("library.no_printables"))}</div>`}
        </section>`:""}
        ${m.projects.length?`<section class="lib-sec"><h2>${esc(t("library.sec_projects"))} <span class="lib-sec-n">${m.projects.length}</span></h2>${m.projects.map(projectHtml).join("")}</section>`:""}
        ${m.others.length?`<section class="lib-sec"><h2>${esc(t("library.sec_other"))} <span class="lib-sec-n">${m.others.length}</span></h2><div class="lib-others">${m.others.map(otherHtml).join("")}</div></section>`:""}
        ${m.hiddenFiles&&m.hiddenFiles.length?`<section class="lib-sec"><h2>${esc(t("library.sec_hidden_files"))} <span class="lib-sec-n">${m.hiddenFiles.length}</span></h2>
          <p class="settings-help">${esc(t("library.hidden_files_help"))}</p>
          <div class="lib-others">${m.hiddenFiles.map(f=>`<div class="lib-other"><span class="lib-var-thumb">${f.thumb?`<img loading="lazy" alt="" src="${thumbUrl(f.thumb)}">`:`<span class="lib-noimg is-sm"></span>`}</span>
            <div><div class="lib-var-title"><span class="lib-fname" title="${esc(f.name)}">${esc(stem(f.name))}</span></div><div class="lib-var-where">${esc(f.rootName)} · ${esc(f.path)}</div>
            ${can("hide")?`<button type="button" class="btn ghost btn-sm lib-unhide-file" data-ck="${esc(f.contentKey)}" data-name="${esc(stem(f.name))}">${esc(t("library.unhide_file"))}</button>`:""}</div></div>`).join("")}</div></section>`:""}
        ${printHistoryHtml(m)}
        ${historyHtml(m)}
        <div class="lib-selbar" id="libSelBar" hidden></div>
        ${isAdmin()?`<p class="settings-help lib-diag-link"><a href="/library-diagnostics.html" target="_blank" rel="noopener">${esc(t("library.diagnostics_link"))}</a></p>`:""}
      </div>`;
    wireBack();
    $("libBody").querySelectorAll(".lib-thumb").forEach(b=>b.addEventListener("click",()=>{
      $("libBody").querySelectorAll(".lib-thumb").forEach(x=>x.classList.toggle("is-on",x===b));
      $("libHeroWell").innerHTML=`<img class="lib-cover-img" alt="" src="${thumbUrl(b.dataset.thumb)}">`;
    }));
    $("libBody").querySelectorAll("[data-model]").forEach(a=>a.addEventListener("click",e=>{ e.preventDefault(); go("/library/m/"+a.dataset.model); }));
    $("libBody").querySelectorAll(".lib-print").forEach(b=>b.addEventListener("click",()=>printVia(b,"print")));
    $("libBody").querySelectorAll(".lib-queue").forEach(b=>b.addEventListener("click",()=>printVia(b,"queue")));
    const more=$("libPrintsMore");
    if(more) more.addEventListener("click",()=>{ $("libBody").querySelectorAll(".lib-print-row[hidden]").forEach(r=>{ r.hidden=false; }); more.remove(); });
    wireModelTools(m);
  }
  function fitLine(x){
    const names=x.fit.printers.slice().sort((a,b)=>(x.fit.idle.includes(b)-x.fit.idle.includes(a))).map(p=>p.name+(x.fit.idle.includes(p)?" ("+t("library.idle")+")":""));
    const shown=names.slice(0,4), rest=names.length-shown.length;
    return `<span class="lib-fit-line" title="${esc(names.join(", "))}"><span class="lib-fam is-fit${x.fit.idle.length?" is-idle":""}">${esc(shortFamily(x.f.label))}</span>
      ${esc(shown.join(", "))}${rest>0?" "+esc(tn("library.and_more",rest)):""}</span>`;
  }
  function summaryLine(m){
    const parts=[];
    if(m.counts.printables) parts.push(tn("library.n_printables",m.counts.printables));
    if(m.counts.projects) parts.push(tn("library.n_projects",m.counts.projects));
    if(m.families.length) parts.push(tn("library.n_printer_types",m.families.length));
    if(m.counts.files>1) parts.push(tn("library.n_files",m.counts.files));
    return parts.join(" · ");
  }
  function backHtml(){ return `<a class="lib-back" href="/library" id="libBack">← ${esc(t("library.back"))}</a>`; }
  function wireBack(){ const b=$("libBack"); if(b) b.addEventListener("click",e=>{ e.preventDefault(); go("/library"); }); }

  function familyGroupHtml(key, list){
    const unknown=key==="~unknown";
    const label=unknown?t("library.printer_unknown_group"):(list[0].printer.label||key);
    const fit=unknown?null:fleetFit(key);
    return `<div class="lib-famgroup">
      <div class="lib-famgroup-hd"><span class="lib-famgroup-name">${esc(label)}</span>
        <span class="lib-famgroup-n">${esc(tn("library.n_variants",list.length))}</span>
        ${fit&&fit.printers.length?`<span class="lib-fam is-fit${fit.idle.length?" is-idle":""}">${esc(tn("library.fit_short",fit.printers.length,{idle:fit.idle.length}))}</span>`:""}</div>
      ${list.map(variantHtml).join("")}</div>`;
  }
  function printerHtml(p){
    if(p.state==="decision") return `<span class="lib-conf is-decision" title="${esc(p.fileSays?t("library.pwhy_file_says",{family:p.fileSays.label||"?"}):"")}">${esc(t("library.printer_set"))}</span>`;
    if(p.state==="applied") return `<span class="lib-conf is-ok">${esc(t("library.printer_confident"))}</span>`;
    if(p.state==="suggested") return `<span class="lib-conf is-warn" title="${esc(t("library.printer_likely_title"))}">${esc(t("library.printer_likely"))}</span>`;
    return `<span class="lib-conf is-dim">${esc(t("library.printer_unknown"))}</span>`;
  }
  function availHtml(a){
    if(a==="ok") return "";
    const k={offline:"badge_offline",missing:"badge_missing",unreadable:"badge_unreadable"}[a]||"badge_missing";
    return `<span class="lib-badge ${a==="offline"?"is-off":"is-bad"}" title="${esc(t("library.avail_"+a+"_title"))}">${esc(t("library."+k))}</span>`;
  }
  function swatches(fil){
    return fil.length?`<span class="lib-swatches">${fil.slice(0,8).map(x=>`<span class="lib-sw" style="--sw:${/^#[0-9a-f]{3,8}$/i.test(x.color||"")?x.color:"transparent"}" title="${esc([x.type,x.vendor,x.color,x.grams!=null?fmtG(x.grams):null].filter(Boolean).join(" · "))}"></span>`).join("")}<span class="lib-sw-txt">${esc([...new Set(fil.map(x=>x.type).filter(Boolean))].join(", "))}</span></span>`:"";
  }
  function variantHtml(v){
    const f=v.file;
    const facts=[
      v.estSeconds?`<span title="${esc(t("library.est_time"))}">${esc(fmtDuration(v.estSeconds))}</span>`:null,
      v.weightG?`<span title="${esc(t("library.weight"))}">${esc(fmtG(v.weightG))}</span>`:null,
      v.copies>1?`<span>${esc(tn("library.copies",v.copies))}</span>`:null,
      v.layerHeight?`<span>${esc(v.layerHeight+" mm")}</span>`:null,
      v.nozzle?`<span>${esc(t("library.nozzle",{d:v.nozzle}))}</span>`:null,
    ].filter(Boolean);
    const plate=v.plate!=null?`<span class="lib-plate">${esc(t("library.plate_n",{n:v.plate}))}${v.plateName?" · "+esc(v.plateName):""}</span>`:"";
    const canAct_=canAct();
    const s=v.send;
    const why=!canAct_?t("library.print_view_only"):s.ok?"":t("library.print_unavailable_"+s.reason);
    // What the server checks before sending: this file, in this location,
    // still being the Variant shown here (M7).
    const data=s.ok&&canAct_?`data-root="${esc(s.root)}" data-path="${esc(s.path)}" data-key="${esc(v.key)}" data-plate="${v.plate==null?"":esc(v.plate)}"`:`disabled title="${esc(why)}"`;
    const pbtn=`<button type="button" class="btn primary btn-sm lib-print" ${data}>${esc(t("library.print"))}</button>`;
    const qdata=s.ok&&canAct_&&s.queue===false?`disabled title="${esc(t("library.queue_plate_title",{n:v.plate}))}"`:data;
    const qbtn=(typeof QUEUE_MANAGEMENT_ENABLED!=="undefined"&&QUEUE_MANAGEMENT_ENABLED)?`<button type="button" class="btn ghost btn-sm lib-queue" ${qdata}>${esc(t("library.queue"))}</button>`:"";
    return `<div class="lib-var${f.availability!=="ok"?" is-unavailable":""}">
      <span class="lib-var-thumb">${v.thumb?`<img loading="lazy" alt="" src="${thumbUrl(v.thumb)}">`:`<span class="lib-noimg is-sm"></span>`}</span>
      <div class="lib-var-main">
        <div class="lib-var-title"><span class="lib-fname" title="${esc(f.name)}">${esc(stem(f.name))}</span>${plate}${availHtml(f.availability)}</div>
        <div class="lib-var-where" title="${esc(f.rootName+" · "+f.path)}">${esc(f.rootName)} · ${esc(f.path)}</div>
        <div class="lib-var-facts">${printerHtml(v.printer)}${v.profile.printer?`<span class="lib-prof" title="${esc([v.profile.printer,v.profile.print].filter(Boolean).join(" · "))}">${esc(v.profile.printer)}</span>`:""}${v.slicer?`<span class="lib-dim">${esc(v.slicer)}</span>`:""}${facts.join("")}</div>
        ${swatches(v.filaments)}
        ${f.duplicates.length?`<div class="lib-var-dup">${esc(tn("library.also_at",f.duplicates.length,{where:f.duplicates.map(d=>d.rootName+" · "+d.path).join("; ")}))}</div>`:""}
        <div class="lib-explains">${whyHereHtml(f.why)}${whyPrinterHtml(v.printer)}</div>
      </div>
      <div class="lib-var-act">${pbtn}${qbtn}${fileMenuHtml(f,{plate:v.plate,printer:v.printer})}</div>
    </div>`;
  }

  // ---- explanations (§4 provenance, in plain words; Diagnostics has the rest) ----
  function evidenceLine(e){
    const v=String(e.value==null?"":e.value);
    if(e.signal==="title"&&e.strength==="weak"){ const [a,b]=v.split(" = "); return t("library.ev_title_weak",{a:a||"",b:b||""}); }
    if(e.strength==="weak") return evidenceLine({...e, strength:"medium"})+" ("+t("library.weak_not_counted")+")";
    switch(e.signal){
      case "object_names": return t("library.ev_objects",{value:v});
      case "title": return e.compare?t("library.ev_title_cmp",{a:e.compare.a,b:e.compare.b,n:e.compare.normalized}):t("library.ev_title",{value:v.split(" = ")[0]});
      case "model_folder": return t("library.ev_folder",{value:v.slice(v.indexOf(":")+1)});
      case "design_model_id": return t("library.ev_design",{value:v});
      case "plate_md5": return t("library.ev_plate_md5");
      case "source_file": return t("library.ev_source",{value:v});
      case "designer_folder": return t("library.ev_designer_folder",{value:v});
      default: return e.signal+": "+v;
    }
  }
  function whyHereHtml(w){
    if(!w) return "";
    let summary, lines=[];
    if(w.kind==="decision"){ summary=t("library.why_decision"); if(w.decision&&w.decision.reason) lines.push(w.decision.reason); }
    else if(w.kind==="automatic"){
      summary=t("library.why_auto");
      lines=w.evidence.map(evidenceLine);
      lines.push(t("library.why_auto_rule"));
    } else summary=t("library.why_single");
    return `<details class="lib-why"><summary>${esc(t("library.why_here"))}</summary><p>${esc(summary)}</p>${lines.length?`<ul>${lines.map(l=>`<li>${esc(l)}</li>`).join("")}</ul>`:""}</details>`;
  }
  const PRINTER_SIGNAL={ printer_model:"library.pev_printer_model", printer_settings_id:"library.pev_printer_settings", print_compatible_printers:"library.pev_compatible",
    default_print_profile:"library.pev_default_profile", printer_model_id:"library.pev_model_id", generator:"library.pev_generator" };
  function whyPrinterHtml(p){
    let summary;
    if(p.state==="decision") summary=t("library.pwhy_decision");
    else if(p.state==="applied") summary=t("library.pwhy_applied",{family:p.label});
    else if(p.state==="suggested") summary=t("library.pwhy_suggested",{family:p.label});
    else if(p.state==="recorded") summary=t("library.pwhy_recorded");
    else summary=t("library.pwhy_unknown");
    // A person's choice never hides what the file says (§4.1).
    const said=p.state==="decision"&&p.fileSays?[t("library.pwhy_file_says",{family:p.fileSays.label||t("library.printer_unknown")})]:[];
    const lines=said.concat((p.evidence||[]).map(e=>{
      const k=PRINTER_SIGNAL[e.signal];
      const base=k?t(k,{value:String(e.value)}):e.signal+": "+e.value;
      return base+(e.familyLabel&&e.familyLabel!==p.label?" → "+e.familyLabel:"")+(e.strength==="weak"?" ("+t("library.weak")+")":"");
    }));
    if(p.others&&p.others.length) lines.push(t("library.pwhy_others",{list:p.others.map(o=>o.label).join(", ")}));
    return `<details class="lib-why"><summary>${esc(t("library.why_printer"))}</summary><p>${esc(summary)}</p>${lines.length?`<ul>${lines.map(l=>`<li>${esc(l)}</li>`).join("")}</ul>`:""}</details>`;
  }
  function suggestionHtml(s){
    const other=s.other?`<a href="/library/m/${esc(s.other.uuid)}" data-model="${esc(s.other.uuid)}">${esc(s.other.name)}</a>`:esc(t("library.another_model"));
    const lines=s.evidence.map(evidenceLine);
    return `<div class="lib-sugg">
      <div>${esc(t("library.sugg_line",{other:"\u0000"})).replace("\u0000",other)}</div>
      <details class="lib-why"><summary>${esc(t("library.why_only_suggestion"))}</summary>
        <p>${esc(t("library.sugg_explain"))}</p>${lines.length?`<ul>${lines.map(l=>`<li>${esc(l)}</li>`).join("")}</ul>`:""}
        ${s.missing?`<p class="lib-dim">${esc(missingText(s))}</p>`:""}</details>
      ${s.review&&can("grouping")?`<div class="lib-actions"><button type="button" class="btn primary btn-sm lib-approve" data-review="${esc(s.review)}">${esc(t("library.merge_btn"))}</button>
        <button type="button" class="btn ghost btn-sm lib-reject" data-review="${esc(s.review)}">${esc(t("library.keep_apart_btn"))}</button></div>`:""}</div>`;
  }
  function missingText(s){
    const g=s.groups||[];
    if(g.length===1&&g[0]==="filename") return t("library.missing_filename");
    if(g.length===1&&g[0]==="internal-content") return t("library.missing_content");
    if(g.length===1&&g[0]==="location") return t("library.missing_location");
    return t("library.missing_generic");
  }
  function projectHtml(p){
    const f=p.file;
    return `<div class="lib-proj">
      <div class="lib-var-title"><span class="lib-fname" title="${esc(f.name)}">${esc(p.title||stem(f.name))}</span>${availHtml(f.availability)}</div>
      <div class="lib-var-where" title="${esc(f.rootName+" · "+f.path)}">${esc(f.rootName)} · ${esc(f.path)}</div>
      <div class="lib-var-facts">${p.designer?`<span>${esc(p.designer)}</span>`:""}${p.license?`<span>${esc(p.license)}</span>`:""}<span class="lib-dim">${esc(t("library.flavour_"+p.flavour))}</span>
        ${p.setUpFor&&p.setUpFor.label?`<span title="${esc(p.setUpFor.profile||"")}">${esc(t("library.set_up_for",{printer:p.setUpFor.label}))}</span>`:""}
        <span>${esc(tn("library.n_plates",p.plates.length))}${p.plates.some(x=>x.printable)?" · "+esc(tn("library.n_printable_plates",p.plates.filter(x=>x.printable).length)):""}</span></div>
      ${p.plates.length?`<div class="lib-plates">${p.plates.map(pl=>`<div class="lib-plate-card${pl.printable?" is-printable":""}" title="${esc(pl.objects.join(", "))}">
        <span class="lib-well lib-well-sm">${pl.thumb?`<img loading="lazy" alt="" src="${thumbUrl(pl.thumb)}">`:`<span class="lib-noimg is-sm">${pl.plate}</span>`}</span>
        <span class="lib-plate-name">${esc(pl.name||t("library.plate_n",{n:pl.plate}))}</span>
        <span class="lib-plate-state">${esc(pl.printable?t("library.plate_printable"):t("library.plate_not_sliced"))}</span></div>`).join("")}</div>`:""}
      <div class="lib-explains">${whyHereHtml(f.why)}</div>${fileMenuHtml(f,{})}</div>`;
  }
  function otherHtml(o){
    return `<div class="lib-other">
      <span class="lib-var-thumb">${o.thumb?`<img loading="lazy" alt="" src="${thumbUrl(o.thumb)}">`:`<span class="lib-noimg is-sm"></span>`}</span>
      <div><div class="lib-var-title"><span class="lib-fname" title="${esc(o.entry||o.name)}">${esc(o.name)}</span>${availHtml(o.availability)}</div>
      <div class="lib-var-where">${esc(o.container?t("library.inside",{name:o.container}):o.rootName+" · "+o.path)} · ${esc(t("library.role_"+o.role))}</div></div></div>`;
  }

  // Print/Queue: the File Browser's own Send and Queue dialogs, so every
  // existing check applies (brand and model, active-file, plate choice,
  // colours), from any location (§12). The request names the location and
  // the Variant; the server checks the file is still that Variant and records
  // the print as it (M7).
  async function printVia(el, how){
    const path=el.dataset.path, root=el.dataset.root||"gcode";
    if(!path) return;
    const m=L.model||{};
    const rootName=(L.overview&&(L.overview.roots.find(r=>r.id===root)||{}).name)||root;
    const library={ key:el.dataset.key, plate:el.dataset.plate===""?null:Number(el.dataset.plate) };
    if(how==="queue"){
      openSendQueueModal([{ path, root, library, modelName:m.name, rootName }]);
      return;
    }
    await selectFile(path, { root, rootName, model:m.uuid, modelName:m.name, library });
    // A project's plate: the Send dialog opens on this Variant's plate, with
    // that plate's colours (M7.1).
    if(library.plate!=null&&SELECTED===path&&MAP&&Array.isArray(MAP.plates)&&MAP.plates.includes(library.plate)&&MAP.plate!==library.plate){
      SEND_PLATE=library.plate; await loadMap(path,{plate:library.plate});
    }
    if(L.open) hideFleet(true);    // selectFile shows the job header behind the Library
    if(SELECTED===path&&MAP) openSendModal();
    else alert(t("library.print_open_failed"));
  }

  // ---- Needs attention ----
  const LEVELS=["action","review","info"];
  async function renderAttention(){
    const token=L.req;
    $("libBody").innerHTML=`${backHtml()}<div class="lib-head"><div class="lib-title"><h1>${esc(t("library.needs_attention"))}</h1><span class="lib-count" id="libAttnTotal"></span></div></div><div id="libAttnBody"><div class="lib-loading">${esc(t("library.loading"))}</div></div>`;
    wireBack();
    let a;
    try{ a=await api("/api/library/attention"); }catch(e){ if(token===L.req) $("libAttnBody").innerHTML=`<div class="lib-empty">${esc(t("library.load_failed"))}</div>`; return; }
    if(token!==L.req||!$("libAttnBody")) return;
    $("libAttnTotal").textContent=tn("library.items_count",a.items.length);
    if(!a.items.length){ $("libAttnBody").innerHTML=`<div class="lib-empty">${esc(t("library.attention_none"))}</div>`; return; }
    $("libAttnBody").innerHTML=`<p class="settings-help">${esc(t("library.attention_intro"))}</p>`+LEVELS.map(level=>{
      const items=a.items.filter(i=>i.level===level);
      if(!items.length) return "";
      const kinds=new Map();
      for(const i of items){ if(!kinds.has(i.kind)) kinds.set(i.kind,[]); kinds.get(i.kind).push(i); }
      return `<section class="lib-sec lib-level lib-level-${level}"><h2>${esc(t("library.level_"+level))} <span class="lib-sec-n">${items.length}</span></h2>
        <p class="settings-help">${esc(t("library.level_"+level+"_help"))}</p>
        ${[...kinds.entries()].map(([kind,list])=>`<details class="lib-kind"${level!=="info"||list.length<=3?" open":""}><summary><span class="lib-kind-name">${esc(t("library.kind_"+kind))}</span> <span class="lib-sec-n">${list.length}</span></summary>
          <p class="settings-help">${esc(t("library.kind_"+kind+"_help"))}</p>
          <ul class="lib-items">${list.map(itemHtml).join("")}</ul></details>`).join("")}</section>`;
    }).join("");
    if(isAdmin()) $("libAttnBody").insertAdjacentHTML("beforeend",`<p class="settings-help lib-diag-link"><a href="/library-diagnostics.html" target="_blank" rel="noopener">${esc(t("library.diagnostics_link"))}</a></p>`);
    $("libAttnBody").querySelectorAll("[data-model]").forEach(x=>x.addEventListener("click",e=>{ e.preventDefault(); go("/library/m/"+x.dataset.model); }));
    wireItemActions($("libAttnBody"), a.items);
  }
  // The Model page's own attention items: what is wrong or uncertain about
  // this Model, in the same words as Needs attention.
  function attentionBlock(items){
    L.modelItems=items;
    // Suggestions have their own section on this page.
    const sorted=items.filter(i=>i.kind!=="suggested_match").sort((a,b)=>LEVELS.indexOf(a.level)-LEVELS.indexOf(b.level));
    if(!sorted.length) return "";
    return `<div class="lib-attn"><ul class="lib-items">${sorted.map(i=>itemHtml({...i, models:[], modelCount:0})).join("")}</ul></div>`;
  }
  function where(l){ if(!l) return ""; const i=l.indexOf(":"); const root=(L.overview&&L.overview.roots.find(r=>r.id===l.slice(0,i)))||null; return (root?root.name:l.slice(0,i))+" · "+l.slice(i+1); }
  function itemHtml(i){
    const d=i.detail||{};
    const models=i.models.map(m=>`<a href="/library/m/${esc(m.uuid)}" data-model="${esc(m.uuid)}">${esc(m.name)}</a>`).join(", ")+(i.modelCount>i.models.length?" …":"");
    let text;
    switch(i.kind){
      case "folder_disagrees": text=t("library.it_folder",{file:where(i.location),folder:d.folder||"",folderFamily:(d.folderFamilies||[]).join("/"),fileFamily:d.fileFamily||""}); break;
      case "unknown_printer": text=d.likely?t("library.it_printer_likely",{file:where(i.location),family:d.likely}):t("library.it_printer_none",{file:where(i.location)}); break;
      case "possible_duplicate": text=t("library.it_duplicate",{a:where(i.location),b:where(i.otherLocation)}); break;
      case "suggested_match": text=t("library.it_suggested"); break;
      case "ambiguous_grouping":
        text=d.variant==="generic"?t("library.it_generic",{terms:(d.terms||[]).join(", "),n:d.files||0})
          :d.variant==="file"?t("library.it_ambiguous_file",{file:where(i.location),n:(d.candidates||[]).length})
          :d.variant==="nested"?t("library.it_nested",{folder:where(d.folder||i.location)})
          :t("library.it_anchor",{model:d.model||""});
        break;
      case "missing_file": text=t("library.it_missing",{file:where(i.location)}); break;
      case "unreadable_file": text=t("library.it_unreadable",{file:where(i.location)}); break;
      case "source_offline": text=t("library.it_offline",{name:(L.overview&&(L.overview.roots.find(r=>r.id===i.location)||{}).name)||i.location||""}); break;
      case "file_changed": text=t("library.it_changed",{file:where(d.lastSeenAt||i.location)}); break;
      case "decision_unmatched": text=t("library.it_unmatched",{file:where(d.lastSeenAt||i.location)}); break;
      case "empty_model": text=t("library.it_empty"); break;
      case "source_may_match": text=t("library.it_source"); break;
      case "unlinked_print": {
        const when=d.at?(typeof fmtTime==="function"?fmtTime(d.at):new Date(d.at).toLocaleString()):"";
        text=t(d.generic?"library.it_unlinked_generic":"library.it_unlinked",{file:stem(d.file||""),printer:d.printer||"",when,n:(d.candidates||[]).length});
        break;
      }
      default: text=i.kind;
    }
    return `<li class="lib-item lib-item-${i.level}"><span class="lib-item-dot" aria-hidden="true"></span><div><div>${esc(text)}</div>${models?`<div class="lib-item-models">${models}</div>`:""}${itemActionsHtml(i)}</div></li>`;
  }

  // ---- M6: changing the Library (§7) ----
  // Every change is one POST to /api/library/actions; the server checks the
  // capability and whether the request still applies (409 otherwise) and
  // records it so it can be undone after a reload. Buttons here are only
  // offered to those who may use them; that is convenience, not security.
  const can=k=>!!(L.overview&&L.overview.can&&L.overview.can[k]);
  const KIND_CAP={ merge:"grouping", split:"grouping", move:"grouping", approve:"grouping", reject:"grouping", dismiss:"review",
    hide:"hide", unhide:"hide", hide_file:"hide", unhide_file:"hide", rename:"metadata", cover:"cover", set_printer:"metadata" };
  async function post(url, body){
    const r=await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body||{}) });
    if(typeof checkAuthFailure==="function") checkAuthFailure(r);
    const b=await r.json().catch(()=>({}));
    if(!r.ok){ const e=new Error(b.error||("HTTP "+r.status)); e.status=r.status; e.code=b.code; e.body=b; throw e; }
    return b;
  }
  function errText(e){
    const k="library.err_"+(e.code||"");
    const base=(e.code&&typeof hasTranslation==="function"&&hasTranslation(k))?t(k):(e.message||t("library.load_failed"));
    return e.status===409?base+" "+t("library.reload_hint"):base;
  }
  // Do it, say what was done, offer Undo, and show the result.
  async function act(action, flashText){
    const r=await post("/api/library/actions", action);
    L.gridKept=false;
    L.flash={ text:typeof flashText==="function"?flashText(r):flashText, actionId:r.actionId };
    afterChange(r.model);
    return r;
  }
  async function undoAction(id){
    try{
      const r=await post("/api/library/actions/"+encodeURIComponent(id)+"/undo");
      L.gridKept=false;
      L.flash={ text:t("library.undone") };
      afterChange(r.model);
    }catch(e){ L.flash={ text:errText(e), error:true }; renderBars(); }
  }
  function afterChange(modelUuid){
    if(L.view==="model"&&modelUuid&&modelUuid!==L.uuid) go("/library/m/"+modelUuid);
    else render();
  }

  // A small dialog that says exactly what will happen, and shows why when it
  // can't (a 409 says the Library changed meanwhile).
  function dialog({ title, body, confirm, danger, onConfirm, wire, okEnabled=true }){
    let el=$("libDialog");
    if(!el){ el=document.createElement("div"); el.className="modal"; el.id="libDialog"; el.setAttribute("role","dialog"); el.setAttribute("aria-modal","true"); el.setAttribute("aria-labelledby","libDlgTitle"); document.body.appendChild(el); }
    el.innerHTML=`<div class="modalbox lib-dialog">
      <div class="modalhdr"><span id="libDlgTitle">${esc(title)}</span><button class="modalx" type="button" id="libDlgX" aria-label="${esc(t("library.close"))}">✕</button></div>
      <div class="lib-dlg-body">${body}</div>
      <div class="pstatus lib-dlg-status" id="libDlgStatus" role="alert"></div>
      <div class="lib-dlg-foot"><button type="button" class="btn ghost" id="libDlgCancel">${esc(t("common.cancel"))}</button>
        <button type="button" class="btn ${danger?"danger":"primary"}" id="libDlgOk" ${okEnabled?"":"disabled"}>${esc(confirm)}</button></div></div>`;
    el.classList.add("show");
    const close=()=>{ el.classList.remove("show"); el.innerHTML=""; document.removeEventListener("keydown",onKey); };
    const onKey=e=>{ if(e.key==="Escape") close(); };
    document.addEventListener("keydown",onKey);
    $("libDlgX").addEventListener("click",close); $("libDlgCancel").addEventListener("click",close);
    el.onclick=e=>{ if(e.target===el) close(); };   // the backdrop only, never a click inside
    const ok=$("libDlgOk");
    ok.addEventListener("click",async()=>{
      ok.disabled=true; $("libDlgStatus").className="pstatus work"; $("libDlgStatus").textContent=t("library.working");
      try{ await onConfirm(el); close(); }
      catch(e){ $("libDlgStatus").className="pstatus err"; $("libDlgStatus").textContent=errText(e); ok.disabled=false; }
    });
    if(wire) wire(el, ok);
    const first=el.querySelector("input:not([type=hidden]),select"); (first||ok).focus();
    return el;
  }

  // Choosing another Model: search, and enough context to tell same-named
  // Models apart (cover, printers, locations, how many files).
  function chooserHtml(){
    return `<label class="fl" for="libPickQ">${esc(t("library.pick_label"))}</label>
      <input class="field" id="libPickQ" type="search" autocomplete="off" placeholder="${esc(t("library.search_placeholder"))}">
      <div class="lib-pick" id="libPick" role="radiogroup" aria-label="${esc(t("library.pick_label"))}"></div>`;
  }
  function wireChooser(el, exclude, onPick){
    let token=0, debounce=null;
    const load=async q=>{
      const my=++token;
      let r; try{ r=await api("/api/library/models?limit=20"+(q?"&q="+encodeURIComponent(q):"")); }catch{ return; }
      if(my!==token||!$("libPick")) return;
      const list=r.models.filter(x=>!exclude.includes(x.uuid));
      $("libPick").innerHTML=list.length?list.map(x=>`<label class="lib-pick-row"><input type="radio" class="lib-pick-radio" name="libPick" value="${esc(x.uuid)}" data-name="${esc(x.name)}">
        <span class="lib-var-thumb">${x.cover?`<img loading="lazy" alt="" src="${thumbUrl(x.cover.thumb)}">`:`<span class="lib-noimg is-sm"></span>`}</span>
        <span class="lib-pick-txt"><span class="lib-fname">${esc(x.name)}</span>
        <span class="lib-var-where">${esc([x.files===1?t("library.one_file"):tn("library.n_files",x.files), x.families.map(f=>shortFamily(f.label)).join(", "), x.locations.map(l=>l.name).join(", ")].filter(Boolean).join(" · "))}</span></span></label>`).join("")
        :`<div class="lib-empty-sm">${esc(t("library.no_match"))}</div>`;
      $("libPick").querySelectorAll(".lib-pick-radio").forEach(rb=>rb.addEventListener("change",()=>onPick({ uuid:rb.value, name:rb.dataset.name })));
    };
    $("libPickQ").addEventListener("input",()=>{ clearTimeout(debounce); debounce=setTimeout(()=>load($("libPickQ").value.trim()),200); });
    load("");
  }

  // ---- the Model's own tools ----
  function toolsHtml(m){
    const b=(id,label,cap)=>can(cap)?`<button type="button" class="btn ghost btn-sm" id="${id}">${esc(label)}</button>`:"";
    const main=b("libRename",t("library.rename_btn"),"metadata")+(m.pictures&&m.pictures.length>1?b("libCover",t("library.cover_btn"),"cover"):"");
    const more=b("libMerge",t("library.merge_into_btn"),"grouping")+(m.hidden?"":b("libHide",t("library.hide_model_btn"),"hide"));
    if(!main&&!more) return "";
    // The grouping changes sit one step away, never next to Print.
    return `<div class="lib-tools">${main}${more?`<details class="lib-menu"><summary class="btn ghost btn-sm">${esc(t("library.more_btn"))}</summary><div class="lib-menu-list">${more}</div></details>`:""}</div>`;
  }
  function fileMenuHtml(f, { plate, printer }){
    const items=[];
    const key=`data-ck="${esc(f.contentKey)}" data-name="${esc(stem(f.name))}"`;
    if(can("grouping")) items.push(`<button type="button" class="lib-move" ${key}>${esc(t("library.move_btn"))}</button>`, `<button type="button" class="lib-split" ${key}>${esc(t("library.split_btn"))}</button>`);
    if(can("metadata")&&printer) items.push(`<button type="button" class="lib-setprinter" ${key} data-plate="${plate==null?"":esc(plate)}">${esc(t("library.set_printer_btn"))}</button>`);
    if(can("hide")) items.push(`<button type="button" class="lib-hidefile" ${key}>${esc(t("library.hide_file_btn"))}</button>`);
    if(!items.length) return "";
    const pick=can("grouping")?`<label class="lib-sel" title="${esc(t("library.select_title"))}"><input type="checkbox" class="checkbox-input lib-selbox" data-ck="${esc(f.contentKey)}" aria-label="${esc(t("library.select_file",{name:stem(f.name)}))}"></label>`:"";
    return `<div class="lib-act-row">${pick}<details class="lib-menu lib-file-menu"><summary class="btn ghost btn-sm" aria-label="${esc(t("library.file_actions",{name:stem(f.name)}))}">⋯</summary><div class="lib-menu-list">${items.join("")}</div></details></div>`;
  }
  const KIND_TEXT=k=>t("library.change_"+k);
  function historyHtml(m){
    const h=m.history||[];
    if(!h.length) return "";
    return `<section class="lib-sec"><h2>${esc(t("library.sec_history"))}</h2><ul class="lib-items lib-history">${h.map(a=>`<li class="lib-item">
      <span class="lib-item-dot" aria-hidden="true"></span><div><div>${esc(a.kind==="approve"&&a.summary&&a.summary.print?t("library.change_link_print"):KIND_TEXT(a.kind))}${historyDetail(a)}</div>
      <div class="lib-var-where">${esc([a.by||t("library.someone"), typeof fmtTime==="function"?fmtTime(a.at):new Date(a.at).toLocaleString()].join(" · "))}${a.undoneAt?" · "+esc(t("library.undone_by",{who:a.undoneBy||t("library.someone")})):""}</div>
      ${a.undoable&&can(KIND_CAP[a.kind])?`<button type="button" class="btn ghost btn-sm lib-undo" data-action="${esc(a.id)}">${esc(t("library.undo"))}</button>`:""}</div></li>`).join("")}</ul></section>`;
  }
  function historyDetail(a){
    const s=a.summary||{};
    const n=x=>x&&x.name?"“"+x.name+"”":"";
    if(a.kind==="approve"&&s.print) return esc(": "+t("library.hist_link_print",{file:stem(s.print.file||""),into:n({name:s.name})}));
    if(a.kind==="merge"||a.kind==="approve") return esc(": "+t("library.hist_merge",{from:n(s.from),into:n(s.into)}));
    if(a.kind==="move") return esc(": "+t("library.hist_move",{files:(s.files||[]).join(", "),to:n(s.to)}));
    if(a.kind==="split") return esc(": "+t("library.hist_split",{files:(s.files||[]).join(", "),to:n(s.to)}));
    if(a.kind==="rename") return esc(": “"+(s.before||"")+"” → “"+(s.after||"")+"”");
    if(a.kind==="set_printer") return esc(": "+(s.file||"")+" → "+(s.family?printerLabel(s.family):t("library.printer_file_says_short")));
    if(a.kind==="reject") return esc(": "+n(s.a)+" / "+n(s.b));
    if(a.kind==="hide_file"||a.kind==="unhide_file") return esc(": "+(s.file||""));
    return "";
  }
  // ---- print history (M7, §9) ----
  // "17 prints · 13 confirmed · 4 matched by filename": everyone's counts.
  function printsLine(p){
    const parts=[tn("library.n_prints",p.count)];
    if(p.confirmed) parts.push(t("library.n_confirmed",{n:p.confirmed}));
    if(p.filename) parts.push(t("library.n_by_filename",{n:p.filename}));
    return parts.join(" · ");
  }
  const PRINTS_SHOWN=20;
  // The rows: only printers this person may see (the server leaves out the
  // rest). Each says how SnapCon knows it was this Model.
  function printHistoryHtml(m){
    const h=m.printHistory||{ rows:[] };
    if(!m.prints&&!h.rows.length) return "";
    const rows=h.rows.map((p,i)=>printRowHtml(p,i>=PRINTS_SHOWN)).join("");
    return `<section class="lib-sec"><h2>${esc(t("library.sec_prints"))}${m.prints?` <span class="lib-sec-n">${m.prints.count}</span>`:""}</h2>
      ${m.prints?`<p class="settings-help">${esc(printsLine(m.prints))}</p>`:""}
      ${h.rows.length?`<ul class="lib-items lib-prints">${rows}</ul>`:""}
      ${h.rows.length>PRINTS_SHOWN?`<button type="button" class="btn ghost btn-sm" id="libPrintsMore">${esc(t("library.show_all_prints",{n:h.rows.length}))}</button>`:""}
      ${h.someNotShown?`<p class="settings-help">${esc(t("library.prints_some_hidden"))}</p>`:""}</section>`;
  }
  const OUTCOME_CLASS={ completed:"is-ok", failed:"is-bad", cancelled:"is-dim", printing:"is-warn", unknown:"is-dim" };
  function printRowHtml(p, hidden){
    const when=p.startedAt||p.endedAt;
    const how=p.via==="queue"?t("library.print_via_queue"):p.source==="external"?t("library.print_via_printer"):p.source==="printer_storage"?t("library.print_via_storage")
      :p.via==="print"?t("library.print_via_snapcon"):t("library.print_via_log");
    const confirmed=p.link.byDecision||p.link.confidence==="exact"||p.link.confidence==="high";
    const linkTitle=p.link.byDecision?t("library.print_link_decision"):t("library.print_link_"+(p.link.method||"none"));
    const link=confirmed?`<span class="lib-conf is-ok" title="${esc(linkTitle)}">${esc(t("library.print_confirmed"))}</span>`
      :`<span class="lib-conf is-warn" title="${esc(linkTitle)}">${esc(t("library.print_by_filename"))}</span>`;
    const file=p.file?stem(p.file.name)+(p.file.plate!=null?" · "+t("library.plate_n",{n:p.file.plate}):""):t("library.print_file_unknown");
    const out=`<span class="lib-conf ${OUTCOME_CLASS[p.outcome]||"is-dim"}">${esc(t("library.outcome_"+p.outcome))}</span>`;
    const facts=[p.elapsedSec?fmtDuration(p.elapsedSec):null, p.user?t("library.print_by",{who:p.user}):null].filter(Boolean);
    return `<li class="lib-item lib-print-row"${hidden?" hidden":""}><span class="lib-item-dot" aria-hidden="true"></span><div>
      <div class="lib-print-head"><span>${esc(when?(typeof fmtTime==="function"?fmtTime(when):new Date(when).toLocaleString()):t("library.print_when_unknown"))}</span>
        <span class="lib-print-printer">${esc(p.printer||"")}</span>${out}${link}</div>
      <div class="lib-var-where"><span class="lib-fname" title="${esc(p.remoteName||"")}">${esc(file)}</span> · ${esc(how)}${facts.length?" · "+esc(facts.join(" · ")):""}</div>
      ${p.wasIn?`<div class="lib-var-where">${esc(t(p.wasIn.merged?"library.print_was_in_merged":"library.print_was_in",{name:p.wasIn.name}))}</div>`:""}
    </div></li>`;
  }
  const printerLabel=k=>{ const f=(window.PrinterIdentity&&PrinterIdentity.FAMILIES||[]).find(x=>x.key===k); return f?f.label:k; };

  function wireModelTools(m){
    const body=$("libBody"), name=m.name;
    const on=(sel,fn)=>body.querySelectorAll(sel).forEach(el=>el.addEventListener("click",()=>{ const d=el.closest("details"); if(d) d.open=false; fn(el); }));
    on("#libRename",()=>dialog({ title:t("library.rename_title",{name}), confirm:t("library.rename_ok"),
      body:`<label class="fl" for="libNewName">${esc(t("library.name_label"))}</label><input class="field" id="libNewName" maxlength="120" value="${esc(name)}">
        <p class="settings-help">${esc(t("library.rename_help"))}</p>
        ${m.nameSource==="user"?`<p class="settings-help"><button type="button" class="btn ghost btn-sm" id="libAutoName">${esc(t("library.rename_auto"))}</button></p>`:""}`,
      wire:el=>{ const a=$("libAutoName"); if(a) a.addEventListener("click",async()=>{ try{ await act({ kind:"rename", model:m.uuid, auto:true }, t("library.done_rename_auto")); el.classList.remove("show"); }catch(e){ $("libDlgStatus").textContent=errText(e); } }); },
      onConfirm:()=>act({ kind:"rename", model:m.uuid, name:$("libNewName").value }, r=>t("library.done_rename",{after:r.after})) }));
    on("#libCover",()=>{
      let pick=null;
      dialog({ title:t("library.cover_title",{name}), confirm:t("library.cover_ok"), okEnabled:false,
        body:`<div class="lib-covers" role="radiogroup" aria-label="${esc(t("library.cover_title",{name}))}">${m.pictures.map((p,i)=>`<label class="lib-cover-opt"><input type="radio" name="libCoverPick" value="${i}" class="lib-pick-radio">
          <span class="lib-well lib-well-sm"><img loading="lazy" alt="" src="${thumbUrl(p.thumb)}"></span><span class="lib-plate-name" title="${esc(p.label)}">${esc(p.label)}</span></label>`).join("")}</div>
          <p class="settings-help">${esc(t("library.cover_help"))}</p>${m.coverSource==="user"?`<button type="button" class="btn ghost btn-sm" id="libCoverAuto">${esc(t("library.cover_auto"))}</button>`:""}`,
        wire:(el,ok)=>{ el.querySelectorAll("input[name=libCoverPick]").forEach(r=>r.addEventListener("change",()=>{ pick=m.pictures[Number(r.value)]; ok.disabled=false; }));
          const a=$("libCoverAuto"); if(a) a.addEventListener("click",async()=>{ try{ await act({ kind:"cover", model:m.uuid, auto:true }, t("library.done_cover_auto")); el.classList.remove("show"); }catch(e){ $("libDlgStatus").textContent=errText(e); } }); },
        onConfirm:()=>act({ kind:"cover", model:m.uuid, file:pick.contentKey, plate:pick.plate }, t("library.done_cover")) });
    });
    on("#libMerge",()=>{
      let target=null;
      dialog({ title:t("library.merge_title_pick",{name}), confirm:t("library.merge_ok_pick"), okEnabled:false,
        body:`<p>${esc(t("library.merge_help",{name}))}</p>${chooserHtml()}<div id="libMergeSummary"></div>`,
        wire:(el,ok)=>wireChooser(el,[m.uuid],x=>{ target=x; ok.disabled=false; ok.textContent=t("library.merge_ok",{into:x.name});
          $("libMergeSummary").innerHTML=mergeChoicesHtml(name, x.name); }),
        onConfirm:()=>act({ kind:"merge", from:m.uuid, into:target.uuid, keepName:radio("libKeepName"), keepCover:radio("libKeepCover") },
          r=>t("library.done_merge",{from:r.from.name,into:r.into.name})) });
    });
    on("#libHide",()=>dialog({ title:t("library.hide_title",{name}), confirm:t("library.hide_ok"), body:`<p>${esc(t("library.hide_help"))}</p>`,
      onConfirm:()=>act({ kind:"hide", model:m.uuid }, t("library.done_hide",{name})) }));
    on("#libUnhide",async()=>{ try{ await act({ kind:"unhide", model:m.uuid }, t("library.done_unhide",{name})); }catch(e){ L.flash={ text:errText(e), error:true }; renderBars(); } });
    on(".lib-unhide-file",async el=>{ try{ await act({ kind:"unhide_file", model:m.uuid, files:[el.dataset.ck] }, t("library.done_unhide_file",{file:el.dataset.name})); }catch(e){ L.flash={ text:errText(e), error:true }; renderBars(); } });
    on(".lib-hidefile",el=>dialog({ title:t("library.hide_file_title",{file:el.dataset.name}), confirm:t("library.hide_file_ok"), body:`<p>${esc(t("library.hide_file_help"))}</p>`,
      onConfirm:()=>act({ kind:"hide_file", model:m.uuid, files:[el.dataset.ck] }, t("library.done_hide_file",{file:el.dataset.name})) }));
    on(".lib-move",el=>moveDialog(m,[{ ck:el.dataset.ck, name:el.dataset.name }]));
    on(".lib-split",el=>splitDialog(m,[{ ck:el.dataset.ck, name:el.dataset.name }]));
    on(".lib-setprinter",el=>printerDialog(m, el.dataset.ck, el.dataset.name, el.dataset.plate===""?null:Number(el.dataset.plate)));
    on(".lib-undo",el=>undoAction(el.dataset.action));
    on(".lib-approve",el=>approveDialog(Number(el.dataset.review), m.uuid));
    on(".lib-reject",el=>rejectDialog(Number(el.dataset.review)));
    // Ticked files: Separate or Move them together.
    const bar=$("libSelBar");
    const sync=()=>{
      const picked=[...body.querySelectorAll(".lib-selbox:checked")].map(x=>x.dataset.ck);
      L.selected=new Set(picked);
      body.querySelectorAll(".lib-selbox").forEach(x=>{ x.checked=L.selected.has(x.dataset.ck); });
      const n=L.selected.size;
      bar.hidden=!n;
      if(!n){ bar.innerHTML=""; return; }
      const files=[...L.selected].map(ck=>({ ck, name:(body.querySelector(`.lib-selbox[data-ck="${CSS.escape(ck)}"]`)||{}).closest?.(".lib-var,.lib-proj")?.querySelector(".lib-fname")?.textContent||"" }));
      bar.innerHTML=`<span>${esc(tn("library.selected_n",n))}</span>
        <button type="button" class="btn ghost btn-sm" id="libSelSplit">${esc(tn("library.split_n_btn",n))}</button>
        <button type="button" class="btn ghost btn-sm" id="libSelMove">${esc(tn("library.move_n_btn",n))}</button>
        <button type="button" class="btn ghost btn-sm" id="libSelClear">${esc(t("library.clear_selection"))}</button>`;
      $("libSelSplit").addEventListener("click",()=>splitDialog(m,files));
      $("libSelMove").addEventListener("click",()=>moveDialog(m,files));
      $("libSelClear").addEventListener("click",()=>{ body.querySelectorAll(".lib-selbox").forEach(x=>{ x.checked=false; }); sync(); });
    };
    body.querySelectorAll(".lib-selbox").forEach(x=>x.addEventListener("change",()=>{
      // One content can show on several rows (plates): tick them all together.
      body.querySelectorAll(`.lib-selbox[data-ck="${CSS.escape(x.dataset.ck)}"]`).forEach(y=>{ y.checked=x.checked; });
      sync();
    }));
    if(L.modelItems) wireItemActions(body, L.modelItems);
  }
  const radio=name=>{ const r=document.querySelector(`input[name=${name}]:checked`); return r?r.value:undefined; };
  function mergeChoicesHtml(fromName, intoName){
    return `<p class="lib-dlg-sum">${esc(t("library.merge_summary",{from:fromName,into:intoName}))}</p>
      <fieldset class="lib-fs"><legend class="fl">${esc(t("library.keep_name"))}</legend>
        <label><input type="radio" name="libKeepName" value="into" checked> ${esc(intoName)}</label>
        <label><input type="radio" name="libKeepName" value="from"> ${esc(fromName)}</label></fieldset>
      <fieldset class="lib-fs"><legend class="fl">${esc(t("library.keep_cover"))}</legend>
        <label><input type="radio" name="libKeepCover" value="into" checked> ${esc(t("library.cover_of",{name:intoName}))}</label>
        <label><input type="radio" name="libKeepCover" value="from"> ${esc(t("library.cover_of",{name:fromName}))}</label></fieldset>`;
  }
  function moveDialog(m, files){
    let target=null;
    const n=files.length;
    dialog({ title:tn("library.move_title",n,{name:files[0].name}), confirm:tn("library.move_ok_pick",n), okEnabled:false,
      body:`<p>${esc(tn("library.move_help",n,{from:m.name}))}</p>${chooserHtml()}`,
      wire:(el,ok)=>wireChooser(el,[m.uuid],x=>{ target=x; ok.disabled=false; ok.textContent=tn("library.move_ok",n,{to:x.name}); }),
      onConfirm:()=>act({ kind:"move", model:m.uuid, files:files.map(f=>f.ck), to:target.uuid }, r=>tn("library.done_move",n,{to:r.to.name})) });
  }
  function splitDialog(m, files){
    const n=files.length;
    dialog({ title:tn("library.split_title",n), confirm:tn("library.split_ok",n),
      body:`<p>${esc(tn("library.split_help",n,{from:m.name}))}</p><ul class="lib-dlg-list">${files.map(f=>`<li>${esc(f.name)}</li>`).join("")}</ul>
        <label class="fl" for="libSplitName">${esc(t("library.new_model_name"))}</label><input class="field" id="libSplitName" maxlength="120" value="${esc(files[0].name)}">`,
      onConfirm:()=>act({ kind:"split", model:m.uuid, files:files.map(f=>f.ck), name:$("libSplitName").value }, r=>tn("library.done_split",n,{to:r.to.name})) });
  }
  function printerDialog(m, ck, name, plate){
    const v=(L.model&&L.model.printables||[]).find(x=>x.file.contentKey===ck&&(x.plate==null?plate==null:x.plate===plate));
    const said=v&&v.printer.fileSays?v.printer.fileSays.label:null;
    const fams=(window.PrinterIdentity&&PrinterIdentity.FAMILIES||[]).slice().sort((a,b)=>a.label.localeCompare(b.label));
    dialog({ title:t("library.printer_title",{file:name+(plate!=null?" · "+t("library.plate_n",{n:plate}):"")}), confirm:t("library.printer_ok"),
      body:`<p>${esc(said?t("library.printer_file_says",{family:said}):t("library.printer_file_says_none"))}</p>
        <label class="fl" for="libPrinterPick">${esc(t("library.printer_label"))}</label>
        <select class="field" id="libPrinterPick">${v&&v.printer.state==="decision"?`<option value="">${esc(t("library.printer_use_file",{family:said||t("library.printer_unknown")}))}</option>`:""}
          ${fams.map(f=>`<option value="${esc(f.key)}" ${v&&v.printer.family===f.key?"selected":""}>${esc(f.label)}</option>`).join("")}</select>
        <p class="settings-help">${esc(t("library.printer_help"))}</p>`,
      onConfirm:()=>{ const fam=$("libPrinterPick").value; return act({ kind:"set_printer", model:m.uuid, file:ck, plate, family:fam||null },
        fam?t("library.done_printer",{file:name,family:printerLabel(fam)}):t("library.done_printer_reset",{file:name})); } });
  }
  async function reviewItem(id){
    const list=(L.view==="attention"&&L.attnItems)||L.modelItems||[];
    let it=list.find(x=>x.id===id);
    if(!it){ try{ it=(await api("/api/library/attention")).items.find(x=>x.id===id); }catch{} }
    return it;
  }
  async function approveDialog(id, here){
    const it=await reviewItem(id);
    if(!it||!it.detail.a||!it.detail.b){ L.flash={ text:t("library.err_review_resolved")+" "+t("library.reload_hint"), error:true }; return render(); }
    const a=it.detail.a, b=it.detail.b;
    const keep=here===b.uuid?b:a, other=keep===a?b:a;
    dialog({ title:t("library.approve_title",{a:a.name,b:b.name}), confirm:t("library.merge_ok",{into:keep.name}),
      body:`<fieldset class="lib-fs"><legend class="fl">${esc(t("library.which_stays"))}</legend>
        <label><input type="radio" name="libSurvivor" value="${esc(keep.uuid)}" checked> ${esc(keep.name)}</label>
        <label><input type="radio" name="libSurvivor" value="${esc(other.uuid)}"> ${esc(other.name)}</label></fieldset>
        <p class="lib-dlg-sum" id="libApproveSum">${esc(t("library.merge_summary",{from:other.name,into:keep.name}))}</p>`,
      wire:(el,ok)=>el.querySelectorAll("input[name=libSurvivor]").forEach(r=>r.addEventListener("change",()=>{
        const s=r.value===keep.uuid?keep:other, f=s===keep?other:keep;
        ok.textContent=t("library.merge_ok",{into:s.name}); $("libApproveSum").textContent=t("library.merge_summary",{from:f.name,into:s.name}); })),
      onConfirm:()=>act({ kind:"approve", review:id, survivor:radio("libSurvivor") }, r=>t("library.done_merge",{from:r.from.name,into:r.into.name})) });
  }
  async function rejectDialog(id){
    const it=await reviewItem(id);
    const a=it&&it.detail.a?it.detail.a.name:"", b=it&&it.detail.b?it.detail.b.name:"";
    dialog({ title:t("library.reject_title",{a,b}), confirm:t("library.keep_apart_ok"), body:`<p>${esc(t("library.reject_help"))}</p>`,
      onConfirm:()=>act({ kind:"reject", review:id }, t("library.done_reject",{a,b})) });
  }

  // ---- Needs attention: what can be done about each item ----
  function itemActionsHtml(i){
    const out=[];
    if(i.kind==="suggested_match"&&can("grouping")) out.push(`<button type="button" class="btn primary btn-sm lib-approve" data-review="${i.id}">${esc(t("library.merge_btn"))}</button>`,
      `<button type="button" class="btn ghost btn-sm lib-reject" data-review="${i.id}">${esc(t("library.keep_apart_btn"))}</button>`);
    if(i.kind==="ambiguous_grouping"&&i.detail.variant==="file"&&i.detail.owner&&can("grouping")) out.push(`<button type="button" class="btn ghost btn-sm lib-choose" data-review="${i.id}">${esc(t("library.choose_btn"))}</button>`);
    if(i.kind==="unlinked_print"&&(i.detail.candidates||[]).some(c=>c.live)&&can("grouping")) out.push(`<button type="button" class="btn ghost btn-sm lib-link-print" data-review="${i.id}">${esc(t("library.link_print_btn"))}</button>`);
    if(i.kind==="empty_model"&&i.models[0]&&can("hide")) out.push(`<button type="button" class="btn ghost btn-sm lib-hide-empty" data-model="${esc(i.models[0].uuid)}" data-name="${esc(i.models[0].name)}">${esc(t("library.hide_model_btn"))}</button>`);
    if(can("review")) out.push(`<button type="button" class="btn ghost btn-sm lib-dismiss" data-review="${i.id}">${esc(t("library.dismiss_btn"))}</button>`);
    return out.length?`<div class="lib-actions">${out.join("")}</div>`:"";
  }
  function wireItemActions(root, items){
    L.attnItems=items;
    const on=(sel,fn)=>root.querySelectorAll(sel).forEach(el=>el.addEventListener("click",e=>{ e.preventDefault(); e.stopPropagation(); fn(el); }));
    on(".lib-actions .lib-approve",el=>approveDialog(Number(el.dataset.review), L.view==="model"?L.uuid:null));
    on(".lib-actions .lib-reject",el=>rejectDialog(Number(el.dataset.review)));
    on(".lib-dismiss",async el=>{ try{ await act({ kind:"dismiss", review:Number(el.dataset.review) }, t("library.done_dismiss")); }catch(e){ L.flash={ text:errText(e), error:true }; renderBars(); } });
    on(".lib-hide-empty",el=>dialog({ title:t("library.hide_title",{name:el.dataset.name}), confirm:t("library.hide_ok"), body:`<p>${esc(t("library.hide_help"))}</p>`,
      onConfirm:()=>act({ kind:"hide", model:el.dataset.model }, t("library.done_hide",{name:el.dataset.name})) }));
    // An unlinked print (M7): which of the Models it could be. The print
    // itself is never rewritten; the choice is a Decision, and can be undone.
    on(".lib-link-print",el=>{
      const it=items.find(x=>x.id===Number(el.dataset.review)); if(!it) return;
      const d=it.detail, cands=(d.candidates||[]).filter(c=>c.live);
      let pick=null;
      dialog({ title:t("library.link_print_title",{file:stem(d.file||"")}), confirm:t("library.link_print_ok_pick"), okEnabled:false,
        body:`<p>${esc(t("library.link_print_help",{printer:d.printer||""}))}</p><div class="lib-pick">${cands.map(c=>`<label class="lib-pick-row"><input type="radio" name="libLinkPrint" class="lib-pick-radio" value="${esc(c.uuid)}" data-name="${esc(c.name)}"><span class="lib-pick-txt"><span class="lib-fname">${esc(c.name)}</span></span></label>`).join("")}</div>`,
        wire:(dl,ok)=>dl.querySelectorAll("input[name=libLinkPrint]").forEach(r=>r.addEventListener("change",()=>{ pick={ uuid:r.value, name:r.dataset.name }; ok.disabled=false; ok.textContent=t("library.link_print_ok",{model:pick.name}); })),
        onConfirm:()=>act({ kind:"approve", review:it.id, model:pick.uuid }, r=>t("library.done_link_print",{model:r.name})) });
    });
    on(".lib-choose",el=>{
      const it=items.find(x=>x.id===Number(el.dataset.review)); if(!it) return;
      const d=it.detail, cands=(d.candidates||[]).filter(c=>c.uuid&&c.uuid!==d.owner.uuid);
      let pick=null;
      dialog({ title:t("library.choose_title"), confirm:t("library.choose_ok"), okEnabled:false,
        body:`<p>${esc(t("library.choose_help",{file:where(it.location)}))}</p><div class="lib-pick">${cands.map(c=>`<label class="lib-pick-row"><input type="radio" name="libChoose" class="lib-pick-radio" value="${esc(c.uuid)}" data-name="${esc(c.name)}"><span class="lib-pick-txt"><span class="lib-fname">${esc(c.name)}</span></span></label>`).join("")}</div>`,
        wire:(dl,ok)=>dl.querySelectorAll("input[name=libChoose]").forEach(r=>r.addEventListener("change",()=>{ pick={ uuid:r.value, name:r.dataset.name }; ok.disabled=false; ok.textContent=tn("library.move_ok",1,{to:pick.name}); })),
        onConfirm:()=>act({ kind:"move", model:d.owner.uuid, files:[d.contentKey], to:pick.uuid, review:it.id }, r=>tn("library.done_move",1,{to:r.to.name})) });
    });
  }

  // ---- wiring ----
  function init(){
    const btn=$("libraryBtn");
    if(!btn) return;
    // A thumbnail that can't be loaded (evicted from the cache, a broken
    // image) becomes the same placeholder as a Model without a cover, never
    // a broken-image icon. Image errors don't bubble: listen in capture.
    document.addEventListener("error",e=>{
      const el=e.target;
      if(!el||el.tagName!=="IMG"||!el.closest||!el.closest("#libraryPage")) return;
      const ph=document.createElement("span");
      ph.className="lib-noimg"+(el.closest(".lib-var-thumb,.lib-thumb,.lib-well-sm")?" is-sm":"");
      ph.setAttribute("aria-hidden","true");
      ph.textContent=el.dataset.initial||"";
      el.replaceWith(ph);
    },true);
    btn.addEventListener("click",()=>{ if(L.open) closePage(); else openPage("/library",true); });
  }
  // First-run onboarding (Settings opened because no printer is configured)
  // wins over a /library deep link: the two are never shown together.
  window.LibraryPage={ openFromLocation:()=>{ if($("setup")&&$("setup").classList.contains("show")) return; if(/^\/library/i.test(location.pathname)){ L.syncing=true; try{ openPage(location.pathname,false); } finally{ L.syncing=false; } } },
    close:closePage, isOpen:()=>L.open };
  init();
})();

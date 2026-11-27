// public/utilization.js — Fleet utilization (docs/fleet-utilization.md,
// Phase 4): the page that shows the Phase 3 reports. A page inside the app
// like Health and the Library: /utilization, with its own state in the query
// (?range=30&basis=farm&end=2026-11-01&virtual=1). Loaded after app.js and
// uses its globals ($, esc, t, tn, fmtDuration, uiDateLocale, switchHtml,
// checkAuthFailure).
//
// Read only: it reads /api/utilization/* and nothing else, sends nothing to a
// printer and changes nothing. Every printer, total and CSV comes from the
// API, which already leaves out what the signed-in user may not see; this
// page never adds a printer of its own (not even from FLEET).
//
// The accounting is the server's: this page never recomputes a KPI. It only
// lays out what the reports say, keeps confirmed figures apart from figures
// with estimates, and never stretches recorded time to fill a day.
"use strict";
(function(){
  // Stack order, bottom up: validated as a categorical palette in both themes
  // (dataviz validate_palette.js, adjacent pairs). The three gaps are drawn
  // as textures, not hues, above the states.
  const STACK=["printing","provisionalRunning","failed","provisionalUnknown","paused","offline","idle","error","unobserved","historicalUncertain","notRecorded"];
  const GAPS=["unobserved","historicalUncertain","notRecorded"];
  const PROV=["observed","inferred","backfilled"];
  const KPIS=["utilization","avgPrintHoursPerPrinterDay","failureLoss","pausedErrorHoursPerPrinterDay"];
  const UNKNOWN_CAUSES=["endedWithoutOutcome","interrupted","unresolved","ambiguous","other"];
  const CONFLICTS=["outcome-disagrees","ambiguous-reprint","ambiguous-merged-job","overlaps-another-job","overlaps-another-record","contradicts-observed-error","contradicts-observed","ends-after-now"];
  const U={
    open:false, syncing:false, req:0, loading:false,
    state:{ range:7, basis:"24h", end:"", virtual:false },
    data:null, error:null,
    sort:{ key:"name", dir:"asc" }, showTable:false, bar:-1,
  };

  // ---- pure helpers (tested in test/utilizationPage.test.js) ----
  // The page's state from its query; anything unknown falls back to the default.
  function parseUrl(search){
    const q=new URLSearchParams(search||"");
    const range=Number(q.get("range"));
    const end=q.get("end")||"";
    return {
      range:[7,30,90].includes(range)?range:7,
      basis:q.get("basis")==="farm"?"farm":"24h",
      end:/^\d{4}-\d{2}-\d{2}$/.test(end)?end:"",
      virtual:q.get("virtual")==="1",
    };
  }
  // The page's address for a state: defaults left out, so /utilization is the default.
  function urlFor(s){
    const q=[];
    if(s.range!==7) q.push("range="+s.range);
    if(s.basis==="farm") q.push("basis=farm");
    if(s.end) q.push("end="+s.end);
    if(s.virtual) q.push("virtual=1");
    return "/utilization"+(q.length?"?"+q.join("&"):"");
  }
  // The API query for a state: the same filters for the reports and the CSV.
  function queryFor(s){
    const q=["range="+s.range, "basis="+(s.basis==="farm"?"farm":"24h")];
    if(s.end) q.push("end="+encodeURIComponent(s.end));
    if(s.virtual) q.push("includeVirtual=1");
    return q.join("&");
  }
  function csvHref(s, view){
    return "/api/utilization/export.csv?view="+(view==="fleet"?"fleet":"printers")+"&"+queryFor(s);
  }
  // What a failed report means for the person looking at it. kind picks the
  // words; farm hours and the time zone say where they are configured.
  function errorInfo(status, code, message){
    if(code==="farm_hours_not_configured") return { kind:"farm_missing", fallback24h:true, detail:"" };
    if(code==="farm_hours_invalid") return { kind:"farm_invalid", fallback24h:true, detail:String(message||"").replace(/^[^:]*:\s*/,"") };
    if(code==="time_zone_invalid") return { kind:"time_zone", fallback24h:false, detail:"" };
    if(code==="utilization_unavailable"||status===503) return { kind:"unavailable", fallback24h:false, detail:"" };
    if(code==="bad_end") return { kind:"bad_end", fallback24h:false, detail:"" };
    if(status===0) return { kind:"network", fallback24h:false, detail:"" };
    return { kind:"generic", fallback24h:false, detail:String(message||"") };
  }
  // One stacked column: each bucket's share of eligible time, split into its
  // confirmed and estimated parts. Shares are of eligible time, so what was
  // not recorded keeps its own height and the column is never stretched to
  // fill a day. No eligible time: no segments (the column says so).
  function segmentsFor(agg){
    const el=agg&&agg.eligibleHours;
    if(!(el>0)) return [];
    const out=[];
    for(const b of STACK){
      const h=agg.hours&&agg.hours[b];
      if(!h||!(h.total>0)) continue;
      const est=Math.min(Math.max(h.estimated||0,0),h.total);
      out.push({ bucket:b, hours:h.total, share:h.total/el, confirmed:(h.total-est)/el, estimated:est/el });
    }
    return out;
  }
  // Observed, inferred and backfilled hours of an aggregate, and how much of
  // them is estimated (estimated time is inferred or backfilled time).
  function provenanceTotals(agg){
    const out={ observed:0, inferred:0, backfilled:0, estimated:0 };
    for(const b of STACK){
      const h=agg&&agg.hours&&agg.hours[b];
      if(!h) continue;
      for(const p of PROV) out[p]+=h[p]||0;
      out.estimated+=h.estimated||0;
    }
    for(const k of Object.keys(out)) out[k]=Math.round(out[k]*1000)/1000;
    return out;
  }
  function conflictTotal(recon){
    if(!recon||!recon.conflicts) return 0;
    return Object.values(recon.conflicts).reduce((a,v)=>a+(Number(v)||0),0);
  }
  // A per-printer row's value for a sort key; null sorts last either way.
  function sortValue(p, key){
    if(key==="name") return String(p.name||p.id||"").toLowerCase();
    if(key==="recorded") return p.coverage?p.coverage.telemetry:null;
    if(key==="withEstimates") return p.kpis&&p.kpis.utilization?p.kpis.utilization.withEstimates:null;
    if(key==="jobs") return p.jobs?p.jobs.completed+p.jobs.failed+p.jobs.cancelled+p.jobs.unknown.total:null;
    if(key==="conflicts") return conflictTotal(p.reconciliation);
    if(PROV.includes(key)||key==="estimated") return provenanceTotals(p)[key];
    if(KPIS.includes(key)) return p.kpis&&p.kpis[key]?p.kpis[key].value:null;
    return null;
  }
  function sortRows(rows, key, dir){
    const sign=dir==="desc"?-1:1;
    return rows.map((p,i)=>({ p, i, v:sortValue(p,key) })).sort((a,b)=>{
      if(a.v==null&&b.v==null) return a.i-b.i;
      if(a.v==null) return 1;
      if(b.v==null) return -1;
      if(a.v<b.v) return -sign;
      if(a.v>b.v) return sign;
      return a.i-b.i;
    }).map(x=>x.p);
  }
  // A date of a report ("YYYY-MM-DD", a local day of the report's time zone)
  // as a Date at noon, so formatting it never shifts it to another day.
  function dayDate(day){
    const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day||""));
    return m?new Date(+m[1],+m[2]-1,+m[3],12):null;
  }
  function fmtDay(day, opts){
    const d=dayDate(day);
    if(!d) return String(day||"");
    try{ return d.toLocaleDateString(typeof uiDateLocale==="function"?uiDateLocale():undefined, opts||{ day:"numeric", month:"short", year:"numeric" }); }
    catch{ return String(day); }
  }
  function fmtRange(from, to){
    if(from===to) return fmtDay(from);
    return t("utilization.range_dates",{ from:fmtDay(from,{ day:"numeric", month:"short" }), to:fmtDay(to) });
  }
  function fmtNum(v, digits){
    try{ return new Intl.NumberFormat(typeof uiDateLocale==="function"?uiDateLocale():undefined,{ maximumFractionDigits:digits, minimumFractionDigits:0 }).format(v); }
    catch{ return String(Math.round(v*Math.pow(10,digits))/Math.pow(10,digits)); }
  }
  // A share (0..1) as a percentage; null is unknown, never 0.
  function fmtPct(v){ return v==null?"—":fmtNum(v*100,1)+"%"; }
  // Some time, too little to show at 0.1 h, is "under 0.1 h", never "0 h".
  function fmtHours(h){ return h==null?"—":h>0&&h<0.05?t("utilization.hours_under",{ n:fmtNum(0.1,1) }):t("utilization.hours",{ n:fmtNum(h,h>=100?0:1) }); }
  function fmtPerDay(h){ return h==null?"—":fmtDuration(h*3600); }
  // A KPI's change against the previous period, as words: never colour alone.
  // pct: shares, shown in percentage points; otherwise hours per day.
  function deltaText(d, pct){
    if(!d) return null;
    const mag=Math.abs(d.change);
    const sign=d.change>0?"+":d.change<0?"−":"±";
    // A change too small to show is "under" the smallest step, never "0 better".
    const amount=pct?(mag*100<0.05?t("utilization.delta.points_under",{ n:fmtNum(0.1,1) }):t("utilization.delta.points",{ n:fmtNum(mag*100,1) }))
      :(mag*3600<0.5?t("utilization.delta.seconds_under"):fmtDuration(mag*3600));
    return { text:sign+amount, verdict:d.verdict, partial:!!d.partialCoverage };
  }
  // A schedule from config.json as words: "Mon–Fri 08:00–18:00".
  function scheduleText(s){
    if(!s||!Array.isArray(s.days)) return "";
    const names=[0,1,2,3,4,5,6].map(i=>{
      try{ return new Date(2026,10,1+i,12).toLocaleDateString(typeof uiDateLocale==="function"?uiDateLocale():undefined,{ weekday:"short" }); }
      catch{ return String(i); }
    });
    const days=[...new Set(s.days)].sort((a,b)=>a-b);
    const runs=[];
    for(const d of days){ const r=runs[runs.length-1]; if(r&&d===r[1]+1) r[1]=d; else runs.push([d,d]); }
    const dayText=runs.map(([a,b])=>a===b?names[a]:b===a+1?names[a]+", "+names[b]:names[a]+"–"+names[b]).join(", ");
    const overnight=!(s.end>s.start);
    return t(overnight?"utilization.schedule_overnight":"utilization.schedule",{ days:dayText, start:s.start, end:s.end });
  }
  // Every how many columns an axis label is shown: as many labels as fit the
  // plot (about 56 px each, the y-axis aside), never more than 10.
  function labelEvery(n, width){
    const fit=Math.max(2,Math.min(10,Math.floor((width-48)/56)));
    return n>fit?Math.ceil(n/fit):1;
  }
  // A column's label under the chart, and its full name for tooltips and the table.
  function pointLabel(pt, granularity, long){
    if(granularity==="week") return long?fmtRange(pt.from,pt.to):fmtDay(pt.from,{ day:"numeric", month:"short" });
    return long?fmtDay(pt.from,{ weekday:"long", day:"numeric", month:"long", year:"numeric" }):fmtDay(pt.from,{ weekday:"short", day:"numeric" });
  }
  // A column's description for a screen reader: every bucket with time, in
  // stack order, estimates named.
  function pointSummary(pt, granularity){
    const segs=segmentsFor(pt);
    const head=pointLabel(pt,granularity,true);
    if(!segs.length) return head+": "+t("utilization.chart.no_eligible");
    return head+": "+segs.map(s=>t("utilization.bucket."+s.bucket)+" "+fmtPct(s.share)+(s.estimated>0?" ("+t("utilization.chart.of_which_estimated",{ pct:fmtPct(s.estimated) })+")":"")).join(", ");
  }

  // ---- data ----
  async function api(url){
    let r;
    try{ r=await fetch(url,{ cache:"no-store" }); }
    catch{ const e=new Error("network"); e.status=0; throw e; }
    if(typeof checkAuthFailure==="function") checkAuthFailure(r);
    const body=await r.json().catch(()=>({}));
    if(!r.ok){ const e=new Error(body.error||("HTTP "+r.status)); e.status=r.status; e.code=body.code; throw e; }
    return body;
  }
  async function load(){
    const id=++U.req, q=queryFor(U.state);
    U.loading=true; U.error=null;
    render();
    try{
      const [summary, series, printers]=await Promise.all([
        api("/api/utilization/summary?"+q), api("/api/utilization/series?"+q), api("/api/utilization/printers?"+q),
      ]);
      if(id!==U.req||!U.open) return;
      U.data={ summary, series, printers:printers.printers||[], key:q };
      U.bar=-1;
    }catch(e){
      if(id!==U.req||!U.open) return;
      U.data=null;
      U.error=errorInfo(e.status,e.code,e.message);
    }
    U.loading=false;
    render();
  }

  // ---- page frame ----
  function hideFleet(hide){
    document.querySelectorAll(".main > .sechead, .main > .jobcard, .main > .jobloading, #fleet-wrap").forEach(el=>el.style.display=hide?"none":"");
  }
  function openPage(push){
    if(!U.open){
      if(typeof closeQueueDashboard==="function") closeQueueDashboard();
      if(typeof closeHealthPage==="function") closeHealthPage();
      if(window.LibraryPage) LibraryPage.close();
      U.open=true;
      $("utilizationPage").classList.add("show");
      hideFleet(true);
      $("utilizationBtn").title=t("global.topbar.back_to_fleet_title");
      $("utilizationBtn").setAttribute("aria-pressed","true");
      if(typeof syncTopbarActive==="function") syncTopbarActive();
    }
    U.state=parseUrl(location.pathname.match(/^\/utilization/i)?location.search:"");
    if(push && !U.syncing){ const u=urlFor(U.state); if(location.pathname+location.search!==u) history.pushState(null,"",u); }
    $("utilizationPage").scrollTop=0;
    load();
  }
  function closePage(){
    if(!U.open) return;
    U.open=false; U.req++; U.loading=false; hideTip();
    if($("uzLive")) $("uzLive").textContent="";
    lastSaid="";
    $("utilizationPage").classList.remove("show");
    hideFleet(false);
    $("utilizationBtn").title=t("utilization.title");
    $("utilizationBtn").setAttribute("aria-pressed","false");
    if(!U.syncing && /^\/utilization/i.test(location.pathname)) history.pushState(null,"","/");
    if(typeof applyRoleUI==="function") applyRoleUI();
  }
  // A filter changed: the address follows (replaced, not a new history entry
  // per click), then the reports load again.
  function setState(patch){
    U.state=Object.assign({},U.state,patch);
    const u=urlFor(U.state);
    if(location.pathname+location.search!==u) history.replaceState(null,"",u);
    load();
  }
  window.addEventListener("popstate",()=>{
    U.syncing=true;
    try{ if(/^\/utilization/i.test(location.pathname)) openPage(false); else closePage(); }
    finally{ U.syncing=false; }
  });

  // ---- render ----
  function render(){
    const root=$("utilizationPage");
    if(!root||!U.open) return;
    const keepFocus=document.activeElement&&root.contains(document.activeElement)?document.activeElement.id:null;
    root.innerHTML=`<div class="uz-shell" aria-busy="${U.loading?"true":"false"}">${headHtml()}<div class="uz-status" aria-hidden="true">${U.loading?esc(t("utilization.loading")):""}</div>${bodyHtml()}</div>`;
    wire(root);
    announce();
    if(keepFocus&&$(keepFocus)) $(keepFocus).focus();
  }
  // The live region is outside the re-rendered page (index.html), so what it
  // says is announced once per load, not lost with each re-render.
  let lastSaid="";
  function announce(){
    const live=$("uzLive");
    if(!live) return;
    const sum=U.data&&U.data.summary;
    const say=U.loading?t("utilization.loading"):U.error?t("utilization.error."+U.error.kind+"_title"):sum?t("utilization.loaded",{ range:fmtRange(sum.from,sum.to) }):"";
    if(say!==lastSaid){ live.textContent=say; lastSaid=say; }
  }
  function segHtml(name, label, opts){
    // A radio group drawn as a segmented control: real radio inputs, so the
    // arrow keys and screen readers work as they do for any radio group.
    return `<fieldset class="uz-seg"><legend class="uz-seg-legend">${esc(label)}</legend>`+opts.map(o=>
      `<label class="uz-seg-opt"><input type="radio" name="${esc(name)}" id="${esc(name+"-"+o.value)}" value="${esc(o.value)}"${o.checked?" checked":""}><span>${esc(o.label)}</span></label>`).join("")+`</fieldset>`;
  }
  function headHtml(){
    const s=U.state, sum=U.data&&U.data.summary;
    const range=sum?fmtRange(sum.from,sum.to):"";
    const meta=sum?[
      tn("utilization.days",sum.flags.days),
      sum.basis.kind==="farm"?scheduleText(sum.basis.schedule):t("utilization.basis_24h_long"),
      t("utilization.time_zone",{ zone:sum.timeZone }),
      tn("utilization.printer_count",sum.printers),
    ]:[];
    const csv=v=>`<a class="btn ghost uz-csv" id="uzCsv-${v}" href="${esc(csvHref(s,v))}" download>${esc(t("utilization.csv_"+v))}</a>`;
    return `<header class="uz-head">
      <div class="uz-title"><h1>${esc(t("utilization.title"))}</h1>
        ${sum?`<p class="uz-range"><span class="uz-range-dates">${esc(range)}</span><span class="uz-range-meta">${meta.map(esc).join(" · ")}</span></p>`:""}
      </div>
      <div class="uz-controls">
        ${segHtml("uzRange",t("utilization.period"),[7,30,90].map(n=>({ value:String(n), label:tn("utilization.days",n), checked:s.range===n })))}
        ${segHtml("uzBasis",t("utilization.basis"),[{ value:"24h", label:t("utilization.basis_24h"), checked:s.basis==="24h" },{ value:"farm", label:t("utilization.basis_farm"), checked:s.basis==="farm" }])}
        <div class="uz-end"><label class="uz-field-label" for="uzEnd">${esc(t("utilization.ending"))}</label>
          <span class="uz-end-row"><input type="date" id="uzEnd" class="uz-date" value="${esc(s.end)}" max="${esc(todayLocal())}">
          ${s.end?`<button type="button" class="btn ghost uz-small" id="uzLatest">${esc(t("utilization.latest"))}</button>`:""}</span></div>
        <div class="uz-virtual">${switchHtml("uzVirtual",s.virtual,t("utilization.include_virtual"),t("utilization.include_virtual_desc"),false)}</div>
        ${U.error?"":`<div class="uz-export"><span class="uz-field-label">${esc(t("utilization.export"))}</span><span class="uz-export-row">${csv("printers")}${csv("fleet")}</span></div>`}
      </div>
    </header>`;
  }
  function todayLocal(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
  function bodyHtml(){
    if(U.error) return errorHtml(U.error);
    if(!U.data) return `<div class="uz-panel uz-loading-panel">${esc(t("utilization.loading"))}</div>`;
    const { summary }=U.data;
    if(!summary.printers) return `<div class="uz-panel uz-empty"><h2>${esc(t("utilization.empty.no_printers_title"))}</h2><p>${esc(t(U.state.virtual?"utilization.empty.no_printers_body":"utilization.empty.no_printers_body_virtual_hidden"))}</p></div>`;
    const c=summary.current;
    const nothing=!(c.recordedHours>0);
    return `<div class="uz-body${U.loading?" is-loading":""}">
      <p class="uz-note">${esc(t("utilization.conservative_note"))}</p>
      ${historyNoteHtml(summary)}
      ${nothing?`<div class="uz-panel uz-empty uz-empty-inline"><h2>${esc(t("utilization.empty.nothing_recorded_title"))}</h2><p>${esc(t("utilization.empty.nothing_recorded_body"))}</p></div>`:""}
      ${kpisHtml(summary)}
      ${chartHtml()}
      ${breakdownHtml(c)}
      ${jobsHtml(c, summary.reconciliation)}
      ${printersHtml()}
      ${limitsHtml(summary)}
    </div>`;
  }
  // Whether the printers' own job history is read (config.json
  // utilization.readPrinterHistory, off unless set): said where the figures are.
  function historyNoteHtml(sum){
    const h=sum.printerHistory;
    if(!h||h.reading==="on") return "";
    if(h.reading==="pilot") return `<p class="uz-note uz-note-info">${esc(t("utilization.history_pilot",{ n:h.printersRead, total:sum.printers }))}</p>`;
    return `<p class="uz-note uz-note-info">${esc(t("utilization.history_off"))}</p>`;
  }
  function errorHtml(e){
    const k="utilization.error."+e.kind;
    return `<div class="uz-panel uz-error" role="alert"><h2>${esc(t(k+"_title"))}</h2><p>${esc(t(k+"_body"))}</p>
      ${e.detail?`<p class="settings-help err">${esc(e.detail)}</p>`:""}
      <div class="uz-error-actions">${e.fallback24h?`<button type="button" class="btn primary" id="uzUse24h">${esc(t("utilization.error.use_24h"))}</button>`:""}
      ${e.kind==="bad_end"?`<button type="button" class="btn primary" id="uzLatest">${esc(t("utilization.latest"))}</button>`:""}
      <button type="button" class="btn ghost" id="uzRetry">${esc(t("utilization.error.retry"))}</button></div></div>`;
  }

  // The four tiles (owner, Phase 3 closeout) and the secondary success rate.
  function kpisHtml(sum){
    const c=sum.current, d=sum.deltas||{};
    const prev=t("utilization.delta.vs",{ range:fmtRange(sum.previous.from,sum.previous.to) });
    const cov=t("utilization.kpi.coverage_recorded",{ pct:fmtPct(c.coverage.telemetry) });
    const k=c.kpis;
    const tiles=[
      { key:"utilization", value:fmtPct(k.utilization.value), est:k.utilization.withEstimates, estText:fmtPct(k.utilization.withEstimates), same:k.utilization.withEstimates===k.utilization.value, pct:true, cov,
        sub:t("utilization.kpi.utilization_sub",{ printing:fmtHours(k.utilization.numeratorHours), eligible:fmtHours(k.utilization.denominatorHours) }) },
      { key:"avgPrintHoursPerPrinterDay", value:fmtPerDay(k.avgPrintHoursPerPrinterDay.value), est:k.avgPrintHoursPerPrinterDay.withEstimates, estText:fmtPerDay(k.avgPrintHoursPerPrinterDay.withEstimates), same:k.avgPrintHoursPerPrinterDay.withEstimates===k.avgPrintHoursPerPrinterDay.value, pct:false, cov,
        sub:tn("utilization.kpi.printer_days",Math.round(k.avgPrintHoursPerPrinterDay.printerDays*10)/10,{ n:fmtNum(k.avgPrintHoursPerPrinterDay.printerDays,1) }) },
      { key:"failureLoss", value:fmtPct(k.failureLoss.value), est:k.failureLoss.withEstimates, estText:fmtPct(k.failureLoss.withEstimates), same:k.failureLoss.withEstimates===k.failureLoss.value, pct:true,
        cov:t("utilization.kpi.coverage_outcomes",{ pct:fmtPct(c.coverage.outcomes) }),
        sub:t("utilization.kpi.failure_sub",{ failed:fmtHours(k.failureLoss.failedHours), printing:fmtHours(k.failureLoss.printingHours) }) },
      { key:"pausedErrorHoursPerPrinterDay", value:fmtPerDay(k.pausedErrorHoursPerPrinterDay.value), est:null, pct:false, cov,
        sub:t("utilization.kpi.paused_error_sub",{ paused:fmtHours(k.pausedErrorHoursPerPrinterDay.pausedHours), error:fmtHours(k.pausedErrorHoursPerPrinterDay.errorHours), days:fmtNum(k.pausedErrorHoursPerPrinterDay.recordedPrinterDays,1) }) },
    ];
    const deltaHtml=(dd,pct)=>{
      const x=deltaText(dd,pct);
      if(!x) return `<span class="uz-delta is-none">${esc(t("utilization.delta.none"))}</span>`;
      // The arrow is the direction of the change; its colour says better or worse.
      const mark=x.verdict==="same"?"":dd.change>0?"▲":"▼";
      return `<span class="uz-delta is-${esc(x.verdict)}">${mark?`<span class="uz-delta-mark" aria-hidden="true">${mark}</span>`:""}<span class="uz-delta-num">${esc(x.text)}</span> <span class="uz-delta-verdict">${esc(t("utilization.delta."+x.verdict))}</span>${x.partial?` <span class="uz-delta-partial">${esc(t("utilization.delta.partial"))}</span>`:""}</span>`;
    };
    const tile=x=>`<section class="uz-kpi" aria-labelledby="uzKpi-${x.key}">
      <h2 class="uz-kpi-label" id="uzKpi-${x.key}">${esc(t("utilization.kpi."+x.key))}</h2>
      <div class="uz-kpi-value">${esc(x.value)}</div>
      ${x.est!=null&&!x.same?`<div class="uz-kpi-est"><span class="uz-est-mark" aria-hidden="true"></span>${esc(t("utilization.kpi.with_estimates",{ value:x.estText }))}</div>`:""}
      <div class="uz-kpi-sub">${esc(x.sub)}</div>
      <div class="uz-kpi-delta">${deltaHtml(d[x.key],x.pct)}<span class="uz-kpi-prev">${esc(prev)}</span></div>
      <div class="uz-kpi-cov">${esc(x.cov)}</div>
      <details class="uz-help"><summary>${esc(t("utilization.how_calculated"))}</summary><p>${esc(t("utilization.kpi."+x.key+"_how"))}</p></details>
    </section>`;
    const sr=c.secondary.successRate;
    const srDelta=deltaHtml(d.successRate,true);
    return `<div class="uz-kpis">${tiles.map(tile).join("")}</div>
      <section class="uz-secondary" aria-labelledby="uzSuccess">
        <h2 class="uz-sec-label" id="uzSuccess">${esc(t("utilization.success.title"))}</h2>
        <span class="uz-sec-value">${esc(fmtPct(sr.value))}</span>
        <span class="uz-sec-detail">${esc(t("utilization.success.detail",{ completed:sr.completed, failed:sr.failed, cancelled:sr.cancelled }))}</span>
        <span class="uz-sec-detail">${esc(t("utilization.success.coverage",{ pct:fmtPct(sr.outcomeCoverage), unknown:sr.unknown }))}</span>
        <span class="uz-sec-detail">${srDelta}</span>
        <details class="uz-help"><summary>${esc(t("utilization.how_calculated"))}</summary><p>${esc(t("utilization.success.how"))}</p></details>
      </section>
      <details class="uz-help uz-help-block"><summary>${esc(t("utilization.coverage_title"))}</summary><p>${esc(t("utilization.coverage_help"))}</p></details>`;
  }

  // Swatch for a bucket: a colour, or for a gap its texture. Estimated parts
  // carry the hatch over their bucket's colour.
  const swatch=(b,est)=>`<span class="uz-sw uz-b-${b}${est?" is-est":""}" aria-hidden="true"></span>`;
  function chartHtml(){
    const s=U.data.series, pts=s.points||[];
    const every=labelEvery(pts.length,($("utilizationPage")&&$("utilizationPage").clientWidth)||1000);
    const anyEst=pts.some(p=>segmentsFor(p).some(x=>x.estimated>0));
    const cols=pts.map((pt,i)=>{
      const segs=segmentsFor(pt);
      const inner=segs.map(x=>{
        const parts=[];
        if(x.confirmed>0) parts.push(`<span class="uz-seg-part uz-b-${x.bucket}" style="height:${(x.confirmed*100).toFixed(3)}%"></span>`);
        if(x.estimated>0) parts.push(`<span class="uz-seg-part uz-b-${x.bucket} is-est" style="height:${(x.estimated*100).toFixed(3)}%"></span>`);
        return parts.join("");
      }).join("");
      return `<div class="uz-col" role="listitem"><div class="uz-bar${segs.length?"":" is-empty"}" id="uzBar-${i}" data-i="${i}" role="img" tabindex="${i===(U.bar<0?0:U.bar)?0:-1}" aria-label="${esc(pointSummary(pt,s.granularity))}">${inner}</div>
        <span class="uz-x${i%every===0?"":" is-skip"}" aria-hidden="true">${esc(pointLabel(pt,s.granularity,false))}</span></div>`;
    }).join("");
    const legend=STACK.map(b=>`<li>${swatch(b)}${esc(t("utilization.bucket."+b))}</li>`).join("")+
      (anyEst?`<li>${swatch("printing",true)}${esc(t("utilization.chart.estimated_legend"))}</li>`:"");
    const title=t(s.granularity==="week"?"utilization.chart.title_week":"utilization.chart.title_day");
    return `<section class="uz-panel uz-chart-panel" aria-labelledby="uzChartTitle">
      <div class="uz-panel-head"><h2 id="uzChartTitle">${esc(title)}</h2>
        <button type="button" class="btn ghost uz-small" id="uzTableToggle" aria-expanded="${U.showTable?"true":"false"}" aria-controls="uzChartTable">${esc(t(U.showTable?"utilization.chart.hide_table":"utilization.chart.show_table"))}</button></div>
      <p class="settings-help">${esc(t("utilization.chart.help"))}</p>
      <ul class="uz-legend">${legend}</ul>
      <div class="uz-plot-wrap">
        <div class="uz-yaxis" aria-hidden="true"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
        <div class="uz-plot" id="uzPlot" role="list" aria-label="${esc(title)}" aria-describedby="uzChartKeys">${cols}</div>
        <div class="uz-tip" id="uzTip" hidden></div>
      </div>
      <p class="uz-sr" id="uzChartKeys">${esc(t("utilization.chart.keys"))}</p>
      <div id="uzChartTable" class="uz-table-wrap"${U.showTable?"":" hidden"}>${chartTableHtml(s)}</div>
    </section>`;
  }
  function chartTableHtml(s){
    const head=`<tr><th scope="col">${esc(t(s.granularity==="week"?"utilization.chart.col_week":"utilization.chart.col_day"))}</th><th scope="col">${esc(t("utilization.col.eligible"))}</th>`+
      STACK.map(b=>`<th scope="col">${esc(t("utilization.bucket."+b))}</th>`).join("")+`<th scope="col">${esc(t("utilization.col.estimated"))}</th></tr>`;
    const rows=(s.points||[]).map(pt=>{
      const segs=new Map(segmentsFor(pt).map(x=>[x.bucket,x]));
      const est=segmentsFor(pt).reduce((a,x)=>a+x.estimated,0);
      return `<tr><th scope="row">${esc(pointLabel(pt,s.granularity,true))}</th><td>${esc(fmtHours(pt.eligibleHours))}</td>`+
        STACK.map(b=>`<td>${segs.has(b)?esc(fmtPct(segs.get(b).share)):"—"}</td>`).join("")+`<td>${est>0?esc("≈"+fmtPct(est)):"—"}</td></tr>`;
    }).join("");
    return `<table class="uz-table"><caption class="uz-sr">${esc(t("utilization.chart.table_caption"))}</caption><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  // Where the time went, for the whole fleet: one 100% bar of eligible time and
  // the state table, with each bucket's provenance.
  function breakdownHtml(c){
    const segs=segmentsFor(c);
    const bar=segs.map(x=>{
      const parts=[];
      if(x.confirmed>0) parts.push(`<span class="uz-hseg uz-b-${x.bucket}" style="width:${(x.confirmed*100).toFixed(3)}%"></span>`);
      if(x.estimated>0) parts.push(`<span class="uz-hseg uz-b-${x.bucket} is-est" style="width:${(x.estimated*100).toFixed(3)}%"></span>`);
      return parts.join("");
    }).join("");
    const kind=b=>GAPS.includes(b)?"gap":["provisionalRunning","provisionalUnknown"].includes(b)?"provisional":"operational";
    const rows=STACK.map(b=>{
      const h=c.hours[b]||{ total:0, observed:0, inferred:0, backfilled:0, estimated:0 };
      return `<tr class="uz-kind-${kind(b)}"><th scope="row"><span class="uz-state">${swatch(b)}<span><span class="uz-state-name">${esc(t("utilization.bucket."+b))}</span><span class="uz-state-desc">${esc(t("utilization.bucket_desc."+b))}</span></span></span></th>
        <td>${esc(fmtHours(h.total))}</td><td>${esc(fmtPct(c.shares[b]))}</td><td>${esc(fmtHours(h.observed))}</td><td>${esc(fmtHours(h.inferred))}</td><td>${esc(fmtHours(h.backfilled))}</td><td>${h.estimated>0?esc("≈"+fmtHours(h.estimated)):esc(fmtHours(0))}</td></tr>`;
    }).join("");
    return `<section class="uz-panel" aria-labelledby="uzBreakTitle">
      <div class="uz-panel-head"><h2 id="uzBreakTitle">${esc(t("utilization.breakdown.title"))}</h2><span class="uz-panel-meta">${esc(t("utilization.breakdown.eligible",{ eligible:fmtHours(c.eligibleHours), recorded:fmtHours(c.recordedHours) }))}</span></div>
      <div class="uz-hbar" aria-hidden="true">${bar}</div>
      <div class="uz-table-wrap"><table class="uz-table uz-break">
        <caption class="uz-sr">${esc(t("utilization.breakdown.caption"))}</caption>
        <thead><tr><th scope="col">${esc(t("utilization.col.state"))}</th><th scope="col">${esc(t("utilization.col.hours"))}</th><th scope="col">${esc(t("utilization.col.share"))}</th><th scope="col">${esc(t("utilization.col.observed"))}</th><th scope="col">${esc(t("utilization.col.inferred"))}</th><th scope="col">${esc(t("utilization.col.backfilled"))}</th><th scope="col">${esc(t("utilization.col.of_which_estimated"))}</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <dl class="uz-defs">
        <dt>${esc(t("utilization.col.observed"))}</dt><dd>${esc(t("utilization.provenance.observed"))}</dd>
        <dt>${esc(t("utilization.col.inferred"))}</dt><dd>${esc(t("utilization.provenance.inferred"))}</dd>
        <dt>${esc(t("utilization.col.backfilled"))}</dt><dd>${esc(t("utilization.provenance.backfilled"))}</dd>
        <dt>${swatch("printing",true)}${esc(t("utilization.col.estimated"))}</dt><dd>${esc(t("utilization.provenance.estimated"))}</dd>
      </dl>
    </section>`;
  }

  // Job counts: outcomes, why outcomes are unknown, and where each job's
  // evidence came from (SnapCon's own polls or the printer's history).
  function jobsHtml(c, recon){
    const j=c.jobs, ev=j.evidence, u=j.unknown;
    const li=(k,n,desc)=>`<li><span class="uz-count">${esc(String(n))}</span><span><span class="uz-count-name">${esc(t(k))}</span>${desc?`<span class="uz-count-desc">${esc(t(desc))}</span>`:""}</span></li>`;
    const conflictRows=CONFLICTS.filter(k=>recon.conflicts&&recon.conflicts[k]>0).map(k=>li("utilization.conflict."+k,recon.conflicts[k])).join("");
    const extra=Object.keys(recon.conflicts||{}).filter(k=>!CONFLICTS.includes(k)&&recon.conflicts[k]>0).reduce((a,k)=>a+recon.conflicts[k],0);
    return `<section class="uz-panel" aria-labelledby="uzJobsTitle">
      <div class="uz-panel-head"><h2 id="uzJobsTitle">${esc(t("utilization.jobs.title"))}</h2></div>
      <div class="uz-jobs">
        <div><h3>${esc(t("utilization.jobs.outcomes"))}</h3><ul class="uz-counts">
          ${li("utilization.jobs.completed",j.completed)}${li("utilization.jobs.failed",j.failed)}${li("utilization.jobs.cancelled",j.cancelled)}
          ${li("utilization.jobs.running",j.running,"utilization.jobs.running_desc")}${li("utilization.jobs.unknown",u.total,"utilization.jobs.unknown_desc")}</ul>
          ${u.total>0?`<h4>${esc(t("utilization.jobs.unknown_why"))}</h4><ul class="uz-counts is-sub">${UNKNOWN_CAUSES.filter(k=>u[k]>0).map(k=>li("utilization.unknown."+k,u[k])).join("")}</ul>`:""}
        </div>
        <div><h3>${esc(t("utilization.jobs.evidence"))}</h3><ul class="uz-counts">
          ${li("utilization.evidence.observed",ev.observed,"utilization.evidence.observed_desc")}
          ${li("utilization.evidence.historySettled",ev.historySettled,"utilization.evidence.historySettled_desc")}
          ${li("utilization.evidence.historyCorrected",ev.historyCorrected)}
          ${li("utilization.evidence.unresolved",ev.unresolved,"utilization.evidence.unresolved_desc")}
          ${li("utilization.evidence.ambiguous",ev.ambiguous,"utilization.evidence.ambiguous_desc")}
          ${li("utilization.evidence.recoveredShort",ev.recoveredShort,"utilization.evidence.recoveredShort_desc")}
          ${li("utilization.evidence.recoveredDuringOffline",ev.recoveredDuringOffline,"utilization.evidence.recoveredDuringOffline_desc")}
          ${li("utilization.evidence.recoveredInsideMerged",ev.recoveredInsideMerged,"utilization.evidence.recoveredInsideMerged_desc")}
          ${li("utilization.evidence.backfilled",ev.backfilled,"utilization.evidence.backfilled_desc")}</ul>
        </div>
        <div><h3>${esc(t("utilization.conflicts.title"))}</h3><p class="settings-help">${esc(t("utilization.conflicts.help"))}</p>
          ${conflictRows||extra?`<ul class="uz-counts">${conflictRows}${extra?li("utilization.conflict.other",extra):""}</ul>`:`<p class="uz-none">${esc(t("utilization.conflicts.none"))}</p>`}
        </div>
      </div>
    </section>`;
  }

  // Per printer, sortable. Only the printers the API returned: the user's own.
  const PCOLS=[
    { key:"name", label:"utilization.col.printer" },
    { key:"utilization", label:"utilization.col.utilization" },
    { key:"withEstimates", label:"utilization.col.with_estimates" },
    { key:"avgPrintHoursPerPrinterDay", label:"utilization.col.avg_print" },
    { key:"failureLoss", label:"utilization.col.failure_loss" },
    { key:"pausedErrorHoursPerPrinterDay", label:"utilization.col.paused_error" },
    { key:"recorded", label:"utilization.col.recorded" },
    { key:"jobs", label:"utilization.col.jobs" },
    { key:"observed", label:"utilization.col.observed" },
    { key:"inferred", label:"utilization.col.inferred" },
    { key:"backfilled", label:"utilization.col.backfilled" },
    { key:"estimated", label:"utilization.col.of_which_estimated" },
    { key:"conflicts", label:"utilization.col.conflicts" },
  ];
  function printersHtml(){
    const rows=sortRows(U.data.printers,U.sort.key,U.sort.dir);
    const th=c=>{
      const on=U.sort.key===c.key;
      const aria=on?(U.sort.dir==="asc"?"ascending":"descending"):"none";
      return `<th scope="col" aria-sort="${aria}"><button type="button" class="uz-sort" data-sort="${c.key}" id="uzSort-${c.key}">${esc(t(c.label))}<span class="uz-sort-mark" aria-hidden="true">${on?(U.sort.dir==="asc"?"▲":"▼"):""}</span></button></th>`;
    };
    const body=rows.map(p=>{
      const k=p.kpis, pv=provenanceTotals(p), conf=conflictTotal(p.reconciliation);
      const jobs=p.jobs.completed+p.jobs.failed+p.jobs.cancelled+p.jobs.unknown.total;
      const tags=(p.removedAt?`<span class="uz-tag">${esc(t("utilization.printers.removed"))}</span>`:"")+(p.virtual?`<span class="uz-tag">${esc(t("utilization.printers.virtual"))}</span>`:"");
      const est=k.utilization.withEstimates;
      return `<tr><th scope="row"><span class="uz-pname" title="${esc(p.name||p.id)}">${esc(p.name||p.id)}</span>${tags}</th>
        <td>${esc(fmtPct(k.utilization.value))}</td>
        <td>${est!=null&&est!==k.utilization.value?esc("≈"+fmtPct(est)):esc(fmtPct(est))}</td>
        <td>${esc(fmtPerDay(k.avgPrintHoursPerPrinterDay.value))}</td>
        <td>${esc(fmtPct(k.failureLoss.value))}</td>
        <td>${esc(fmtPerDay(k.pausedErrorHoursPerPrinterDay.value))}</td>
        <td>${esc(fmtPct(p.coverage.telemetry))}</td>
        <td title="${esc(t("utilization.printers.jobs_title",{ completed:p.jobs.completed, failed:p.jobs.failed+p.jobs.cancelled, unknown:p.jobs.unknown.total }))}">${esc(String(jobs))}</td>
        <td>${esc(fmtHours(pv.observed))}</td><td>${esc(fmtHours(pv.inferred))}</td><td>${esc(fmtHours(pv.backfilled))}</td>
        <td>${pv.estimated>0?esc("≈"+fmtHours(pv.estimated)):esc(fmtHours(0))}</td>
        <td>${conf>0?`<span class="uz-conf">${esc(String(conf))}</span>`:"0"}</td></tr>`;
    }).join("");
    return `<section class="uz-panel" aria-labelledby="uzPrintersTitle">
      <div class="uz-panel-head"><h2 id="uzPrintersTitle">${esc(t("utilization.printers.title"))}</h2><span class="uz-panel-meta">${esc(tn("utilization.printer_count",rows.length))}</span></div>
      <p class="settings-help">${esc(t("utilization.printers.help"))}</p>
      <div class="uz-table-wrap"><table class="uz-table uz-printers"><caption class="uz-sr">${esc(t("utilization.printers.caption"))}</caption>
        <thead><tr>${PCOLS.map(th).join("")}</tr></thead><tbody>${body}</tbody></table></div>
    </section>`;
  }

  function limitsHtml(sum){
    const items=(sum.limitations||[]).map(k=>`<li>${esc(t("utilization.limit."+k))}</li>`).join("");
    return `<section class="uz-panel uz-limits" aria-labelledby="uzLimitsTitle">
      <h2 id="uzLimitsTitle">${esc(t("utilization.limits.title"))}</h2>
      <p>${esc(t("utilization.limits.intro"))}</p>
      <ul>${items}<li>${esc(t("utilization.limits.offline"))}</li></ul>
    </section>`;
  }

  // ---- tooltip (hover and keyboard focus) ----
  function tipHtml(pt, granularity){
    const segs=segmentsFor(pt);
    const rows=segs.slice().reverse().map(x=>{
      const h=pt.hours[x.bucket];
      const src=PROV.filter(p=>h[p]>0).map(p=>t("utilization.col."+p)+" "+fmtHours(h[p])).join(", ");
      return `<li>${swatch(x.bucket)}<span class="uz-tip-name">${esc(t("utilization.bucket."+x.bucket))}</span><span class="uz-tip-val">${esc(fmtPct(x.share))}</span>
        <span class="uz-tip-src">${esc(fmtHours(x.hours))}${src?" · "+esc(src):""}${x.estimated>0?" · "+esc(t("utilization.chart.of_which_estimated",{ pct:fmtHours(h.estimated) })):""}</span></li>`;
    }).join("");
    return `<div class="uz-tip-head">${esc(pointLabel(pt,granularity,true))}</div>
      <div class="uz-tip-meta">${esc(t("utilization.breakdown.eligible",{ eligible:fmtHours(pt.eligibleHours), recorded:fmtHours(pt.recordedHours) }))}</div>
      ${rows?`<ul>${rows}</ul>`:`<p>${esc(t("utilization.chart.no_eligible"))}</p>`}`;
  }
  function showTip(i){
    const tip=$("uzTip"), bar=$("uzBar-"+i), s=U.data&&U.data.series;
    if(!tip||!bar||!s||!s.points[i]) return;
    tip.innerHTML=tipHtml(s.points[i],s.granularity);
    tip.hidden=false;
    const wrap=tip.parentElement.getBoundingClientRect(), b=bar.getBoundingClientRect();
    const w=tip.offsetWidth;
    let left=b.left-wrap.left+b.width/2-w/2;
    left=Math.max(0,Math.min(left,wrap.width-w));
    tip.style.left=left+"px";
  }
  function hideTip(){ const tip=$("uzTip"); if(tip) tip.hidden=true; }

  function wire(root){
    root.querySelectorAll('input[name="uzRange"]').forEach(el=>el.addEventListener("change",()=>setState({ range:Number(el.value) })));
    root.querySelectorAll('input[name="uzBasis"]').forEach(el=>el.addEventListener("change",()=>setState({ basis:el.value })));
    const v=$("uzVirtual"); if(v) v.addEventListener("change",()=>setState({ virtual:v.checked }));
    const end=$("uzEnd"); if(end) end.addEventListener("change",()=>{ if(!end.value||/^\d{4}-\d{2}-\d{2}$/.test(end.value)) setState({ end:end.value }); });
    const latest=$("uzLatest"); if(latest) latest.addEventListener("click",()=>setState({ end:"" }));
    const use24=$("uzUse24h"); if(use24) use24.addEventListener("click",()=>setState({ basis:"24h" }));
    const retry=$("uzRetry"); if(retry) retry.addEventListener("click",()=>load());
    const tog=$("uzTableToggle"); if(tog) tog.addEventListener("click",()=>{ U.showTable=!U.showTable; render(); });
    root.querySelectorAll(".uz-sort").forEach(b=>b.addEventListener("click",()=>{
      const k=b.dataset.sort;
      U.sort={ key:k, dir:U.sort.key===k?(U.sort.dir==="asc"?"desc":"asc"):(k==="name"?"asc":"desc") };
      render();
    }));
    const plot=$("uzPlot");
    if(plot){
      const bars=[...plot.querySelectorAll(".uz-bar")];
      bars.forEach(b=>{
        const i=Number(b.dataset.i);
        b.addEventListener("mouseenter",()=>showTip(i));
        b.addEventListener("mouseleave",()=>{ if(document.activeElement!==b) hideTip(); });
        b.addEventListener("focus",()=>{ U.bar=i; showTip(i); });
        b.addEventListener("blur",hideTip);
        b.addEventListener("click",()=>b.focus());
      });
      // One tab stop for the chart; the arrow keys move between its columns.
      plot.addEventListener("keydown",e=>{
        const cur=bars.indexOf(document.activeElement);
        if(cur<0) return;
        let next=null;
        if(e.key==="ArrowRight"||e.key==="ArrowDown") next=Math.min(bars.length-1,cur+1);
        else if(e.key==="ArrowLeft"||e.key==="ArrowUp") next=Math.max(0,cur-1);
        else if(e.key==="Home") next=0;
        else if(e.key==="End") next=bars.length-1;
        else if(e.key==="Escape"){ hideTip(); return; }
        if(next==null) return;
        e.preventDefault();
        bars[cur].tabIndex=-1; bars[next].tabIndex=0; bars[next].focus();
      });
    }
  }

  function init(){
    const btn=$("utilizationBtn");
    if(!btn) return;
    // The chart's labels follow the page's width: drawn again (from what is
    // loaded) when a resize changes how many fit.
    let fitWas=null, rt=null;
    window.addEventListener("resize",()=>{ clearTimeout(rt); rt=setTimeout(()=>{
      const pts=U.open&&U.data?U.data.series.points.length:0;
      const fit=pts?labelEvery(pts,$("utilizationPage").clientWidth):null;
      if(fit!==fitWas){ fitWas=fit; if(pts) render(); }
    },150); });
    btn.addEventListener("click",()=>{ if(U.open) closePage(); else openPage(true); });
  }
  // First-run onboarding (Settings opened because no printer is configured)
  // wins over a /utilization deep link, as for the Library.
  window.UtilizationPage={
    openFromLocation:()=>{ if($("setup")&&$("setup").classList.contains("show")) return; if(/^\/utilization\/?$/i.test(location.pathname)){ U.syncing=true; try{ openPage(false); } finally{ U.syncing=false; } } },
    close:closePage, isOpen:()=>U.open,
    // A language change re-renders from the reports already loaded.
    rerender:()=>{ if(U.open) render(); },
  };
  init();
})();

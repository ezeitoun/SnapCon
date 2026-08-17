// public/i18n.js — frontend translation runtime.
//
// Loaded as a plain <script> before app.js, same non-module pattern
// error-codes.js already establishes (no bundler, no build step). Exposes
// t()/tn() as globals for app.js to call.
//
// Resolution: user's saved locale -> system default locale -> English ->
// raw key. A translation whose placeholder set doesn't match the English
// source is never rendered — it silently falls back to English instead
// (see t() below) rather than showing a broken interpolation.
(function(){
  const FALLBACK_LOCALE="en";
  let activeLocale=FALLBACK_LOCALE;
  let activeData={};   // flattened key -> string for the active non-English locale
  let enData={};       // flattened key -> string for English, always loaded
  const warned=new Set();

  function flatten(obj,prefix){
    const out={};
    if(!obj||typeof obj!=="object"||Array.isArray(obj)) return out;
    for(const k of Object.keys(obj)){
      if(prefix===""&&k==="_meta") continue;
      const key=prefix?prefix+"."+k:k;
      const v=obj[k];
      if(v&&typeof v==="object"&&!Array.isArray(v)) Object.assign(out,flatten(v,key));
      else out[key]=v;
    }
    return out;
  }

  function extractPlaceholders(str){
    const set=new Set();
    if(typeof str!=="string") return set;
    const re=/\{(\w+)\}/g; let m;
    while((m=re.exec(str))) set.add(m[1]);
    return set;
  }
  function placeholderSetsEqual(a,b){
    if(a.size!==b.size) return false;
    for(const x of a) if(!b.has(x)) return false;
    return true;
  }

  // Once per locale+key, not once per call — a re-rendered fleet/settings
  // panel calling t() every poll tick must never flood the console.
  function warnOnce(key,msg){
    const wk=activeLocale+":"+key;
    if(warned.has(wk)) return;
    warned.add(wk);
    console.warn("[i18n] "+msg);
  }

  // escapeHtml=true when the caller is interpolating into an innerHTML
  // sink — matches this app's existing esc() discipline (see app.js).
  // false (default) for textContent/attribute sinks, which are inherently
  // safe from HTML injection regardless.
  function interpolate(str,params,escapeHtml){
    if(!params) return str;
    return str.replace(/\{(\w+)\}/g,(m,name)=>{
      if(!(name in params)) return m;
      const v=String(params[name]);
      return (escapeHtml&&typeof window.esc==="function")?window.esc(v):v;
    });
  }

  function t(key,params,opts){
    opts=opts||{};
    let str=activeLocale!==FALLBACK_LOCALE?activeData[key]:undefined;
    if(typeof str==="string"&&str.trim()!==""){
      const enStr=enData[key];
      if(typeof enStr==="string"){
        const enPh=extractPlaceholders(enStr),trPh=extractPlaceholders(str);
        if(enPh.size>0&&!placeholderSetsEqual(enPh,trPh)){
          warnOnce(key,'"'+key+'" in '+activeLocale+" has mismatched placeholders — falling back to English");
          str=enStr;
        }
      }
    }else{
      str=enData[key];
      if(typeof str!=="string"){
        warnOnce(key,'missing translation key "'+key+'"');
        return window.I18N_DEBUG?"⟦"+key+"⟧":key;
      }
    }
    return interpolate(str,params,!!opts.html);
  }

  // Simple binary plural (spec: explicit _one/_other keys, no plural-rules
  // library). Only handles English-shaped singular/plural — languages
  // needing more forms (Slavic, Arabic) are documented as future work.
  function tn(baseKey,count,params,opts){
    const suffix=count===1?"_one":"_other";
    return t(baseKey+suffix,Object.assign({count:count},params||{}),opts);
  }

  // True only when a real translation exists somewhere (active locale or
  // English) — i.e. exactly the cases where t(key) does NOT fall back to
  // returning the raw key itself. Exists for applyI18nToDom() below: on a
  // total locale-fetch outage (English never loaded either — see the
  // pre-auth login bootstrap in app.js's authGate()), overwriting a static
  // element's already-correct English fallback text with a raw key like
  // "auth.login_button" would be worse than leaving it alone. Login must
  // never show raw keys — see server.js's public-locales comment.
  function hasTranslation(key){
    return typeof enData[key]==="string" || (activeLocale!==FALLBACK_LOCALE && typeof activeData[key]==="string");
  }

  // Public, unauthenticated endpoint — this runtime is used to render the
  // pre-auth login/OTP overlay as well as everything post-login, so it needs
  // exactly one code path that works regardless of session state rather than
  // branching on auth here. See server.js's /api/public-locales* comment.
  async function fetchLocale(locale){
    const r=await fetch("/api/public-locales/"+encodeURIComponent(locale));
    if(!r.ok) throw new Error("HTTP "+r.status);
    const d=await r.json();
    return flatten(d.data,"");
  }

  async function setLocale(locale){
    const next=locale||FALLBACK_LOCALE;
    if(next===FALLBACK_LOCALE){ activeLocale=FALLBACK_LOCALE; activeData={}; return; }
    try{
      activeData=await fetchLocale(next);
      activeLocale=next;
    }catch(e){
      console.warn('[i18n] could not load locale "'+next+'" — falling back to English:',e.message);
      activeLocale=FALLBACK_LOCALE;
      activeData={};
    }
  }

  async function initI18n(locale){
    try{ enData=await fetchLocale(FALLBACK_LOCALE); }
    catch(e){ console.warn("[i18n] could not load the English source:",e.message); }
    await setLocale(locale);
  }

  // Declarative pass over static HTML (index.html's Settings markup, not
  // JS-generated fragments — those call t()/tn() directly at render time).
  // Re-run after setLocale() so switching language re-renders without a
  // full page reload, per the "existing Settings re-render is enough"
  // decision — no application-wide reactive rendering system.
  function applyI18nToDom(root){
    const scope=root||document;
    scope.querySelectorAll("[data-i18n]").forEach(el=>{ const k=el.getAttribute("data-i18n"); if(hasTranslation(k)) el.textContent=t(k); });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(el=>{ const k=el.getAttribute("data-i18n-placeholder"); if(hasTranslation(k)) el.placeholder=t(k); });
    scope.querySelectorAll("[data-i18n-title]").forEach(el=>{ const k=el.getAttribute("data-i18n-title"); if(hasTranslation(k)) el.title=t(k); });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach(el=>{ const k=el.getAttribute("data-i18n-aria-label"); if(hasTranslation(k)) el.setAttribute("aria-label",t(k)); });
    scope.querySelectorAll("[data-i18n-alt]").forEach(el=>{ const k=el.getAttribute("data-i18n-alt"); if(hasTranslation(k)) el.alt=t(k); });
  }

  window.t=t;
  window.tn=tn;
  window.initI18n=initI18n;
  window.setI18nLocale=setLocale;
  window.i18nCurrentLocale=function(){ return activeLocale; };
  window.applyI18nToDom=applyI18nToDom;
  // Exposed so imperative call sites that have a good raw fallback in hand
  // (e.g. authErrorText() falling back to the server's own English d.error)
  // can apply the exact same "never show a raw key" guard applyI18nToDom()
  // already uses internally, instead of unconditionally calling t() and
  // risking a raw key string when even English failed to load.
  window.hasTranslation=hasTranslation;
})();

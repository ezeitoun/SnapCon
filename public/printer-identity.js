// public/printer-identity.js — which printer a sliced file was made for, which
// printer a fleet row is, and whether the two agree.
//
// The ONE place SnapCon turns slicer metadata into a printer identity. It is a
// plain script shared by both sides: the browser loads it with a <script> tag
// (global PrinterIdentity) and server.js requires it. The Send dialog, the job
// card and — later — the Model Library all ask this module rather than each
// growing their own string matching.
//
// Why it exists: brand-level checks were too coarse. A file in the real
// library under K1C/ is sliced for a Creality Ender-3 V3 Plus, and "Creality
// = Creality" passed it for any Creality printer. And printer_model can be
// generic ("Generic Klipper Printer") while printer_settings_id names the real
// machine. So a result carries a confidence and the evidence it came from:
//
//   high    Bambu's printer_model_id code, or a non-generic printer_model that
//           no other field contradicts.
//   medium  printer_model is generic or contradicted, and the settings id /
//           compatible-printers list point at one family ("likely").
//   low     the fields disagree with each other, or name no known family.
//
// Only strings seen on real files or real printers are listed. A family that
// is not here resolves to null — "can't tell" — never to the nearest guess.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrinterIdentity = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // `brand` must equal the connector's exports.brand exactly: that is what a
  // fleet row's p.brand carries, and brand comparisons are string equality.
  const FAMILIES = [
    { key: "snapmaker-u1", brand: "SnapMaker", label: "Snapmaker U1", re: /\bsnapmaker\s*u1\b/ },
    { key: "flashforge-ad5x", brand: "FlashForge", label: "Flashforge AD5X", re: /\bad5x\b/ },
    { key: "flashforge-5m-pro", brand: "FlashForge", label: "Flashforge Adventurer 5M Pro", re: /\b(?:adventurer\s*5m|ad5m)\s*pro\b/ },
    { key: "flashforge-5m", brand: "FlashForge", label: "Flashforge Adventurer 5M", re: /\b(?:adventurer\s*5m|ad5m)\b(?!\s*pro)/ },
    { key: "creality-ender3-v3-plus", brand: "Creality", label: "Creality Ender-3 V3 Plus", re: /\bender-?3\s*v3\s*plus\b/ },
    // Seen in a real library: printer_model "Creality Ender-3 V3 KE",
    // settings "PixelPrints - V3 KE (0.4)".
    { key: "creality-ender3-v3-ke", brand: "Creality", label: "Creality Ender-3 V3 KE", re: /\bender-?3\s*v3\s*ke\b/ },
    // From a real library (a "K1C" printer folder). Kept apart from the K1,
    // whose pattern already refuses "K1C".
    { key: "creality-k1c", brand: "Creality", label: "Creality K1C", re: /\bk1\s*c\b/ },
    { key: "creality-sparkx-i7", brand: "Creality", label: "Creality SPARKX i7", re: /\bsparkx\s*i7\b/ },
    // "Creality@K1" is an OrcaSlicer vendor@model system-preset id.
    { key: "creality-k1", brand: "Creality", label: "Creality K1", re: /\bk1\b(?!\s*(?:c|max|se)\b)/ },
    { key: "bambu-p2s", brand: "Bambu Lab", label: "Bambu Lab P2S", re: /\bp2s\b/ },
  ];

  // Bambu's internal printer_model_id codes — only those seen on real files.
  const BAMBU_MODEL_CODES = { "Bambu Lab P2S": "N7" };
  const BAMBU_CODE_FAMILY = { N7: "bambu-p2s" };

  // printer_model values that name an interface or a user's own profile, not
  // a machine. They are no evidence of which printer a file was made for.
  const GENERIC_MODEL_RE = /\bgeneric\b|^\s*my\s?klipper\b/;

  const byKey = Object.fromEntries(FAMILIES.map(f => [f.key, f]));
  const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[_]+/g, " ");

  // Every family named anywhere in a string. More than one is a contradiction,
  // not a choice: the caller treats it as "can't tell".
  function familiesIn(text) {
    const t = norm(text);
    if (!t) return [];
    return FAMILIES.filter(f => f.re.test(t)).map(f => f.key);
  }
  function familyOf(text) {
    const hits = familiesIn(text);
    return hits.length === 1 ? hits[0] : null;
  }
  function describe(key) {
    const f = key && byKey[key];
    return f ? { key: f.key, brand: f.brand, label: f.label } : null;
  }
  function isGenericModel(printerModel) {
    return GENERIC_MODEL_RE.test(norm(printerModel));
  }

  // Brand-only fallback for a file whose family is unknown: the vendor part of
  // a "Vendor@Model" settings id, or a registered brand named in printer_model.
  // `brands` are the connector brands SnapCon knows (CONNECTOR_TYPES on the
  // client, listConnectorTypes() on the server).
  function brandFromText(printerModel, printerSettingsId, brands) {
    const list = (brands || []).filter(Boolean);
    if (printerSettingsId) {
      const vendor = String(printerSettingsId).split("@")[0].toLowerCase();
      const hit = list.find(b => vendor.includes(String(b).toLowerCase()));
      if (hit) return hit;
    }
    if (printerModel) {
      const text = String(printerModel).toLowerCase();
      const hit = list.find(b => text.includes(String(b).toLowerCase()));
      if (hit) return hit;
    }
    return null;
  }

  // What a file says about the printer it was sliced for.
  //   meta: { printerModel, printerSettingsId, printCompatiblePrinters,
  //           defaultPrintProfile, printerModelId }  (parser / threemf fields)
  //   brands: known connector brands, for the brand-only fallback
  // Returns { hasData, family, label, brand, confidence, method, conflict, evidence[] }.
  //   hasData false  -> the file carries none of these fields (brand: null)
  //   brand false    -> it has fields, but they name no known brand
  function identifyFile(meta, brands) {
    const m = meta || {};
    const evidence = [];
    const out = { hasData: false, family: null, label: null, brand: null,
                  confidence: null, method: null, conflict: false, evidence };
    const has = v => v != null && String(v).trim() !== "";
    if (![m.printerModel, m.printerSettingsId, m.printCompatiblePrinters, m.printerModelId].some(has)) return out;
    out.hasData = true;

    const settle = (key, confidence, method) => {
      const d = describe(key);
      out.family = d.key; out.label = d.label; out.brand = d.brand;
      out.confidence = confidence; out.method = method;
      return out;
    };

    // 1. Bambu's own model code is an identity, not a description.
    if (has(m.printerModelId)) {
      const key = BAMBU_CODE_FAMILY[String(m.printerModelId).trim()] || null;
      evidence.push({ signal: "printer_model_id", value: String(m.printerModelId), family: key, strength: key ? "identity" : "none" });
      if (key) return settle(key, "high", "bambu_model_id");
    }

    // 2. The supporting fields. default_print_profile is recorded but never
    //    decides anything: a real AD5X file names "@Flashforge AD5M Pro" there,
    //    because the process preset it inherits from was written for another
    //    machine.
    const supports = [];
    const sid = familyOf(m.printerSettingsId);
    if (has(m.printerSettingsId)) evidence.push({ signal: "printer_settings_id", value: String(m.printerSettingsId), family: sid, strength: sid ? "medium" : "none" });
    if (sid) supports.push(sid);
    const cpHits = familiesIn(m.printCompatiblePrinters);
    const cp = cpHits.length === 1 ? cpHits[0] : null;
    if (has(m.printCompatiblePrinters)) evidence.push({ signal: "print_compatible_printers", value: String(m.printCompatiblePrinters), family: cp, strength: cp ? "medium" : "none" });
    if (cp) supports.push(cp);
    if (cpHits.length > 1) out.conflict = true;
    if (has(m.defaultPrintProfile)) evidence.push({ signal: "default_print_profile", value: String(m.defaultPrintProfile), family: familyOf(m.defaultPrintProfile), strength: "weak" });

    // 3. printer_model decides when it names a machine and nothing contradicts it.
    const generic = has(m.printerModel) && isGenericModel(m.printerModel);
    const pm = has(m.printerModel) && !generic ? familyOf(m.printerModel) : null;
    if (has(m.printerModel)) evidence.push({ signal: "printer_model", value: String(m.printerModel), family: pm, generic, strength: pm ? "strong" : "none" });
    const others = [...new Set(supports)];
    if (pm) {
      if (others.every(k => k === pm)) return settle(pm, "high", others.length ? "printer_model+settings" : "printer_model");
      out.conflict = true;
      return settle(pm, "medium", "printer_model_contradicted");
    }

    // 4. Generic or absent printer_model: the settings fields may still agree.
    if (others.length === 1 && !out.conflict) return settle(others[0], "medium", "settings_id");
    if (others.length > 1) out.conflict = true;

    // 5. No family. Keep the brand-level answer the Send dialog always had.
    const brand = brandFromText(m.printerModel, m.printerSettingsId, brands);
    out.brand = brand || false;
    out.confidence = "low";
    out.method = brand ? "brand_only" : "none";
    return out;
  }

  // What a fleet row / configured printer is.
  //   p: { connectorFamily, model, capabilitiesModel, brand }
  //     connectorFamily   a connector that only ever drives one machine declares
  //                       it (exports.printerFamily)
  //     model             a model the connector detected and saved (Creality)
  //     capabilitiesModel a model the printer reports about itself (Bambu)
  function identifyPrinter(p) {
    const x = p || {};
    if (x.connectorFamily && byKey[x.connectorFamily]) {
      return { ...describe(x.connectorFamily), method: "connector" };
    }
    for (const [value, method] of [[x.model, "detected_model"], [x.capabilitiesModel, "reported_model"]]) {
      const key = familyOf(value);
      if (key) return { ...describe(key), method };
    }
    return { key: null, brand: x.brand || null, label: null, method: null };
  }

  // Does a file suit a printer?
  //   status  "match"          both families known and equal
  //           "model_mismatch" same or unknown brand, different known family
  //           "brand_mismatch" both brands known and different
  //           "unknown"        not enough known to say
  //   confident  true when the file's identity is high confidence — only then
  //              may a caller act on a mismatch without asking (pre-ticking).
  // `knownBrand(b)` says whether a printer's brand is one SnapCon derives from
  // a connector; a user-typed brand ("Voron") is never a mismatch.
  function compare(fileId, printerId, knownBrand) {
    const f = fileId || {}, p = printerId || {};
    const isKnown = typeof knownBrand === "function" ? knownBrand : () => true;
    const confident = f.confidence === "high";
    if (f.brand && p.brand && isKnown(p.brand) && f.brand !== p.brand) {
      return { status: "brand_mismatch", confident: true };
    }
    if (f.family && p.key) {
      return f.family === p.key
        ? { status: "match", confident }
        : { status: "model_mismatch", confident };
    }
    return { status: "unknown", confident: false };
  }

  // Families whose name a FOLDER looks like (the Library's folder
  // classification). Derived from the labels above, never a separate list: the
  // folder name, with spaces and punctuation removed, must equal a run of
  // consecutive words of a label's model part (the label without its brand),
  // and contain both a letter and a digit — "U1", "AD5X", "5M PRO", "V3 Plus",
  // "V3Plus", "i7", "K1". "5M" alone looks like both Adventurer 5M families.
  // A folder name is NEVER evidence of which printer a file is for; this only
  // labels folders for navigation and to notice a folder that disagrees with
  // its files.
  function familiesLikeName(name) {
    const compact = String(name == null ? "" : name).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact.length < 2 || !/[a-z]/.test(compact) || !/\d/.test(compact)) return [];
    const hits = [];
    for (const f of FAMILIES) {
      const lower = f.label.toLowerCase(), brand = f.brand.toLowerCase();
      const model = lower.startsWith(brand) ? lower.slice(brand.length) : lower;
      const words = model.split(/[\s\-_]+/).filter(Boolean);
      let found = false;
      for (let i = 0; i < words.length && !found; i++) {
        for (let j = i; j < words.length && !found; j++) {
          if (words.slice(i, j + 1).join("") === compact) found = true;
        }
      }
      if (found) hits.push(f.key);
    }
    return hits;
  }

  return { FAMILIES, BAMBU_MODEL_CODES, identifyFile, identifyPrinter, compare,
           familiesIn, familyOf, isGenericModel, brandFromText, familiesLikeName };
});

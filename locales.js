// locales.js — i18n locale discovery, validation, completion/placeholder
// checking, and safe persistence for the Language Editor.
//
// Runtime locale files live under BASE_DIR/locales/ (writable, per-install,
// gitignored) — never inside the bundled ASSET_DIR/public tree, which is
// read-only once packaged by pkg (see CLAUDE.md's BASE_DIR/ASSET_DIR
// split — the same reason config.json/users.json/gcode/ all live under
// BASE_DIR instead of next to server.js). Bundled canonical originals ship
// separately under locales-default/ and are only ever copied into
// BASE_DIR/locales/ on first run by seedDefaultLocales() — never
// overwritten afterward, so an admin's or translator's edits are never
// silently discarded by a SnapCon upgrade.
//
// All filesystem-touching functions take their directory as a parameter
// (never read a module-level constant) so this file is unit-testable
// against a throwaway temp directory without requiring server.js itself —
// same rationale as configLoader.js.
const fs = require("fs");
const path = require("path");

const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---- flatten / completion / orphans ----
// Dotted-path leaves only, skipping the top-level _meta block — matches the
// spec's "Key | English | Translation" addressing (t('settings.view.title')).
function flattenKeys(obj, prefix = "") {
  const out = {};
  if (!isPlainObject(obj)) return out;
  for (const k of Object.keys(obj)) {
    if (prefix === "" && k === "_meta") continue;
    const v = obj[k];
    const key = prefix ? prefix + "." + k : k;
    if (isPlainObject(v)) Object.assign(out, flattenKeys(v, key));
    else out[key] = v;
  }
  return out;
}

// null / "" / whitespace-only are all "untranslated" for v1 — see spec 3D.
function isTranslatedValue(v) {
  return typeof v === "string" && v.trim() !== "";
}

function computeCompletion(enFlat, localeFlat) {
  const keys = Object.keys(enFlat);
  if (keys.length === 0) return { translated: 0, total: 0, percent: 100 };
  let translated = 0;
  for (const k of keys) if (isTranslatedValue(localeFlat[k])) translated++;
  return { translated, total: keys.length, percent: Math.round((translated / keys.length) * 100) };
}

// Present in the locale but not in the current English source — spec 6C.
function findOrphanedKeys(enFlat, localeFlat) {
  return Object.keys(localeFlat).filter(k => !(k in enFlat));
}

// ---- placeholders ----
// {name} tokens. Set comparison, not order — a translation may legitimately
// reorder them (spec 4C).
function extractPlaceholders(str) {
  const set = new Set();
  if (typeof str !== "string") return set;
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(str))) set.add(m[1]);
  return set;
}
function placeholderSetsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
// Returns the list of keys (present + translated in localeFlat) whose
// placeholder set doesn't match the English source's — used both by the
// editor (block Save unless overridden) and the runtime (fall back to
// English rather than render a broken translation).
function findPlaceholderMismatches(enFlat, localeFlat) {
  const bad = [];
  for (const k of Object.keys(enFlat)) {
    if (!isTranslatedValue(localeFlat[k])) continue;
    const enPh = extractPlaceholders(enFlat[k]);
    if (enPh.size === 0) continue;
    const trPh = extractPlaceholders(localeFlat[k]);
    if (!placeholderSetsEqual(enPh, trPh)) bad.push(k);
  }
  return bad;
}

// ---- single-file validation ----
// Distinguishes "unreadable/unparseable" from "valid JSON, wrong shape" from
// "valid shape, filename doesn't match _meta.locale" — every failure mode
// is skip-this-file-only, matching spec 2A: a bad locale must never stop
// other valid locales from loading.
function validateLocaleShape(filename, parsed) {
  if (!isPlainObject(parsed)) return { ok: false, error: "top-level JSON value is not an object" };
  const meta = parsed._meta;
  if (!isPlainObject(meta)) return { ok: false, error: "missing _meta" };
  const locale = meta.locale;
  if (typeof locale !== "string" || !LOCALE_RE.test(locale)) {
    return { ok: false, error: `_meta.locale "${locale}" is missing or not a valid locale code` };
  }
  const expectedFilename = locale + ".json";
  if (filename !== expectedFilename) {
    return { ok: false, error: `filename "${filename}" doesn't match _meta.locale "${locale}" (expected "${expectedFilename}")` };
  }
  return { ok: true, locale };
}

function readAndValidateLocaleFile(localesDir, filename) {
  const filePath = path.join(localesDir, filename);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, filename, error: `could not read: ${e.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, filename, error: `invalid JSON: ${e.message}` };
  }
  const shape = validateLocaleShape(filename, parsed);
  if (!shape.ok) return { ok: false, filename, error: shape.error };
  return { ok: true, filename, locale: shape.locale, data: parsed };
}

// ---- directory scan / registry ----
// Duplicate-locale policy: if two files both claim the same _meta.locale,
// neither is trusted (silently picking one could silently discard whichever
// wasn't chosen) — both are reported as errors and skipped. Every other
// valid locale still loads normally.
// Duplicate-locale handling (spec 2A) is enforced by prevention, not
// runtime detection: validateLocaleShape already requires a file's own name
// to exactly equal `<its _meta.locale>.json`, which makes two DIFFERENT
// filenames both validly claiming the SAME locale structurally impossible
// — the second file's name could only collide with the first by literally
// being named the same thing, which the filesystem itself already
// prevents within one directory. A file that claims an in-use locale under
// a different name simply fails its own filename-match check instead
// (reported as that same, single, per-file error) — one bad file, one
// clear error, every other valid locale still loads, same end guarantee
// the spec asks for, via a simpler mechanism.
function scanLocales(localesDir) {
  const errors = [];
  let filenames = [];
  try {
    filenames = fs.readdirSync(localesDir).filter(f => f.toLowerCase().endsWith(".json"));
  } catch (e) {
    if (e.code !== "ENOENT") errors.push({ filename: null, error: `could not read locales directory: ${e.message}` });
    return { locales: {}, errors };
  }

  const validated = [];
  for (const filename of filenames) {
    const result = readAndValidateLocaleFile(localesDir, filename);
    if (!result.ok) { errors.push({ filename: result.filename, error: result.error }); continue; }
    validated.push(result);
  }

  const enEntry = validated.find(e => e.locale === "en");
  const enFlat = enEntry ? flattenKeys(enEntry.data) : {};

  const locales = {};
  for (const { filename, locale, data } of validated) {
    const flat = flattenKeys(data);
    const completion = locale === "en" ? { translated: Object.keys(enFlat).length, total: Object.keys(enFlat).length, percent: 100 } : computeCompletion(enFlat, flat);
    locales[locale] = {
      filename,
      meta: data._meta,
      completion,
      orphanedKeys: locale === "en" ? [] : findOrphanedKeys(enFlat, flat),
      placeholderMismatches: locale === "en" ? [] : findPlaceholderMismatches(enFlat, flat),
    };
  }

  return { locales, errors };
}

// ---- seeding (first run only — never overwrites) ----
// Conservative by design (explicit product decision): copies bundled
// defaults into the runtime directory only if the runtime file doesn't
// exist yet. Never re-copies over an existing runtime file, even if the
// bundled version is newer — a translator's edits must never be silently
// destroyed by a SnapCon upgrade. en.json is deliberately excluded here —
// it gets its own version-gated lifecycle (see syncCanonicalEnglish below),
// since it alone is application-owned and can never be hand-edited via the
// Language Editor.
function seedDefaultLocales(localesDir, bundledDir) {
  fs.mkdirSync(localesDir, { recursive: true });
  let bundledFiles = [];
  try {
    bundledFiles = fs.readdirSync(bundledDir).filter(f => f.toLowerCase().endsWith(".json"));
  } catch {
    return; // no bundled defaults present — nothing to seed (shouldn't happen in a real install)
  }
  for (const filename of bundledFiles) {
    if (filename === "en.json") continue; // see syncCanonicalEnglish
    const dest = path.join(localesDir, filename);
    if (fs.existsSync(dest)) continue;
    try {
      fs.copyFileSync(path.join(bundledDir, filename), dest);
    } catch (e) {
      console.error(`[locales] could not seed ${filename} into ${localesDir}: ${e.message}`);
    }
  }
}

// English is the one locale this is safe for: the Language Editor
// permanently refuses to write en.json (spec 3C), so nothing legitimate
// can ever be sitting in the runtime copy other than what a previous
// SnapCon version put there — replacing a stale one is not destroying
// anyone's work, unlike every other locale (which seedDefaultLocales above
// leaves alone unconditionally).
//
// Version-gated on _meta.version only (never snapconVersion — see the
// explicit product decision). Three cases:
//   - runtime missing or unparseable -> replace (first run / self-heal)
//   - bundled version > runtime version -> replace ("upgrade")
//   - runtime version >= bundled version -> leave alone entirely
// A malformed runtime file is preserved alongside (best-effort, after the
// replacement already succeeded) purely for diagnosing how it broke —
// nothing recoverable is assumed to be in it.
function syncCanonicalEnglish(localesDir, bundledDir) {
  const bundledPath = path.join(bundledDir, "en.json");
  let bundledData;
  try {
    bundledData = JSON.parse(fs.readFileSync(bundledPath, "utf8"));
  } catch (e) {
    console.error(`[locales] could not read bundled canonical English (${bundledPath}): ${e.message} — runtime en.json left as-is`);
    return;
  }
  const bundledVersion = Number(bundledData._meta && bundledData._meta.version) || 0;

  const runtimePath = path.join(localesDir, "en.json");
  let runtimeRaw = null;
  if (fs.existsSync(runtimePath)) {
    try { runtimeRaw = fs.readFileSync(runtimePath, "utf8"); } catch { /* unreadable — treated the same as malformed below */ }
  }
  let runtimeVersion = null, runtimeMalformed = false;
  if (runtimeRaw !== null) {
    try {
      const runtimeData = JSON.parse(runtimeRaw);
      runtimeVersion = Number(runtimeData._meta && runtimeData._meta.version) || 0;
    } catch (e) {
      runtimeMalformed = true;
    }
  }

  if (!runtimeMalformed && runtimeVersion !== null && runtimeVersion >= bundledVersion) return; // already current

  // Atomic tmp+rename (writeLocaleFile) — replaces whatever was at
  // runtimePath (working, stale, or malformed) or creates it fresh. If this
  // throws, the previous file (whatever state it was in) is untouched,
  // since the rename step never runs — never a partial/corrupt write.
  try {
    writeLocaleFile(localesDir, "en", bundledData);
  } catch (e) {
    console.error(`[locales] failed to write canonical English (v${bundledVersion}): ${e.message} — the previous runtime en.json, if any, is untouched`);
    return;
  }

  if (runtimeMalformed) {
    console.error(`[locales] runtime en.json was malformed — replaced with the bundled canonical English (v${bundledVersion})`);
    try { fs.writeFileSync(runtimePath + ".corrupt-" + Date.now(), runtimeRaw); } catch { /* best-effort diagnostic copy only — the replacement above already succeeded */ }
  } else if (runtimeVersion !== null) {
    console.log(`[locales] canonical English upgraded: v${runtimeVersion} -> v${bundledVersion}`);
  }
  // runtimeVersion === null && !runtimeMalformed: the file simply didn't
  // exist yet — ordinary first-run seeding, not worth a log line.
}

// ---- fingerprint (concurrent/external edit detection) ----
// Transient only — never stored in the locale JSON itself (would conflict
// with the earlier decision not to store an en.json hash in metadata).
// Content-hash based rather than mtime/size alone: locale files are small,
// and a hash is deterministic across a save-then-immediately-reopen cycle
// where mtime granularity could otherwise collide.
function computeFingerprint(localesDir, filename) {
  const crypto = require("crypto");
  try {
    const raw = fs.readFileSync(path.join(localesDir, filename));
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null; // file doesn't exist yet (new language) — no fingerprint to compare against
  }
}

// ---- path safety ----
// locale is user input (New Language / Import / any :locale route param)
// that becomes part of a filename. Reject anything that isn't the strict
// locale pattern outright (no '/', '\', '..', separators can ever match
// LOCALE_RE), then re-verify the resolved path is still inside localesDir
// as defense in depth against a validation bug rather than relying on the
// regex alone.
function safeLocalePath(localesDir, locale) {
  if (typeof locale !== "string" || !LOCALE_RE.test(locale)) return null;
  const resolved = path.resolve(localesDir, locale + ".json");
  const dir = path.resolve(localesDir) + path.sep;
  if (!resolved.startsWith(dir)) return null;
  return resolved;
}

// ---- atomic write (mirrors QueueStore.js's tmp-then-rename sequence) ----
function writeLocaleFile(localesDir, locale, data) {
  const target = safeLocalePath(localesDir, locale);
  if (!target) throw new Error(`invalid locale code "${locale}"`);
  const json = JSON.stringify(data, null, 2);
  JSON.parse(json); // sanity round-trip before anything touches disk
  fs.mkdirSync(localesDir, { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, target);
}

module.exports = {
  LOCALE_RE,
  flattenKeys, isTranslatedValue, computeCompletion, findOrphanedKeys,
  extractPlaceholders, placeholderSetsEqual, findPlaceholderMismatches,
  validateLocaleShape, readAndValidateLocaleFile, scanLocales,
  seedDefaultLocales, syncCanonicalEnglish, computeFingerprint, safeLocalePath, writeLocaleFile,
};

// test/i18n/locales.test.js — unit tests for locales.js (discovery,
// validation, completion, placeholder checking, seeding, path safety, and
// atomic persistence for the Language Editor).
//
// Same isolation convention as test/configLoader.test.js: every filesystem
// test runs against a throwaway mkdtempSync directory, never this repo's
// own locales/ tree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const locales = require("../../locales");

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "snapcon-locales-test-"));
}

const EN = {
  _meta: { locale: "en", language: "English", nativeName: "English", version: 1, snapconVersion: "0.5.0", updated: "2026-08-14" },
  common: { save: "Save", cancel: "Cancel" },
  settings: { title: "Settings", greet: "Hello {name}" }
};

// ---- flatten / completion / orphans ----

test("flattenKeys: nests by dotted path, skips top-level _meta", () => {
  const flat = locales.flattenKeys(EN);
  assert.deepEqual(flat, { "common.save": "Save", "common.cancel": "Cancel", "settings.title": "Settings", "settings.greet": "Hello {name}" });
});

test("computeCompletion: null/empty/whitespace-only all count as untranslated", () => {
  const enFlat = locales.flattenKeys(EN);
  const partial = { "common.save": "Guardar", "common.cancel": null, "settings.title": "", "settings.greet": "   " };
  const c = locales.computeCompletion(enFlat, partial);
  assert.equal(c.translated, 1);
  assert.equal(c.total, 4);
  assert.equal(c.percent, 25);
});

test("computeCompletion: fully translated locale reports 100%", () => {
  const enFlat = locales.flattenKeys(EN);
  const full = { "common.save": "Guardar", "common.cancel": "Cancelar", "settings.title": "Configuración", "settings.greet": "Hola {name}" };
  assert.equal(locales.computeCompletion(enFlat, full).percent, 100);
});

test("findOrphanedKeys: a key present in the translation but not in English is orphaned", () => {
  const enFlat = locales.flattenKeys(EN);
  const localeFlat = { "common.save": "Guardar", "common.old_removed_key": "leftover" };
  assert.deepEqual(locales.findOrphanedKeys(enFlat, localeFlat), ["common.old_removed_key"]);
});

// ---- placeholders ----

test("extractPlaceholders / placeholderSetsEqual: order doesn't matter, membership does", () => {
  const a = locales.extractPlaceholders("Printing {file} on {printer}");
  const b = locales.extractPlaceholders("En {printer}, imprimiendo {file}");
  assert.ok(locales.placeholderSetsEqual(a, b), "reordered placeholders must still count as equal");
});

test("findPlaceholderMismatches: flags a translation missing a required placeholder", () => {
  const enFlat = { "x.msg": "Printing {file} on {printer}" };
  const localeFlat = { "x.msg": "Imprimiendo un archivo" }; // dropped both placeholders
  assert.deepEqual(locales.findPlaceholderMismatches(enFlat, localeFlat), ["x.msg"]);
});

test("findPlaceholderMismatches: an untranslated (empty) value is not flagged as a mismatch — it's just untranslated", () => {
  const enFlat = { "x.msg": "Hello {name}" };
  const localeFlat = { "x.msg": "" };
  assert.deepEqual(locales.findPlaceholderMismatches(enFlat, localeFlat), []);
});

test("findPlaceholderMismatches: a correct reordering is not flagged", () => {
  const enFlat = { "x.msg": "{a} and {b}" };
  const localeFlat = { "x.msg": "{b} y {a}" };
  assert.deepEqual(locales.findPlaceholderMismatches(enFlat, localeFlat), []);
});

// ---- single-file validation ----

test("validateLocaleShape: rejects a non-object top-level value", () => {
  assert.equal(locales.validateLocaleShape("es.json", [1, 2, 3]).ok, false);
  assert.equal(locales.validateLocaleShape("es.json", "just a string").ok, false);
  assert.equal(locales.validateLocaleShape("es.json", null).ok, false);
});

test("validateLocaleShape: rejects missing _meta", () => {
  const r = locales.validateLocaleShape("es.json", { common: { save: "Guardar" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /_meta/);
});

test("validateLocaleShape: rejects an invalid locale code", () => {
  const r = locales.validateLocaleShape("xx.json", { _meta: { locale: "not-a-locale-code!" } });
  assert.equal(r.ok, false);
});

test("validateLocaleShape: rejects a filename that doesn't match _meta.locale (spec 2A example)", () => {
  const r = locales.validateLocaleShape("es.json", { _meta: { locale: "fr" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /es\.json.*fr/);
});

test("validateLocaleShape: accepts a well-formed locale, including region-tagged codes like pt-BR", () => {
  assert.equal(locales.validateLocaleShape("es.json", { _meta: { locale: "es" } }).ok, true);
  assert.equal(locales.validateLocaleShape("pt-BR.json", { _meta: { locale: "pt-BR" } }).ok, true);
});

// ---- directory scan ----

function writeLocale(dir, filename, data) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data));
}

test("scanLocales: a missing directory returns an empty registry, not an error (legitimate first run before seeding)", () => {
  const dir = path.join(scratchDir(), "does-not-exist-yet");
  const { locales: found, errors } = locales.scanLocales(dir);
  assert.deepEqual(found, {});
  assert.deepEqual(errors, []);
});

test("scanLocales: loads every valid locale and computes completion against English", () => {
  const dir = scratchDir();
  writeLocale(dir, "en.json", EN);
  writeLocale(dir, "es.json", { _meta: { locale: "es", language: "Spanish", nativeName: "Español" }, common: { save: "Guardar", cancel: "Cancelar" }, settings: { title: "Configuración" } });
  const { locales: found, errors } = locales.scanLocales(dir);
  assert.deepEqual(errors, []);
  assert.ok(found.en);
  assert.equal(found.en.completion.percent, 100, "English is always 100% against itself");
  assert.equal(found.es.completion.translated, 3);
  assert.equal(found.es.completion.total, 4);
});

test("scanLocales: invalid JSON in one file is skipped and reported, without blocking other valid locales (spec 2A)", () => {
  const dir = scratchDir();
  writeLocale(dir, "en.json", EN);
  fs.writeFileSync(path.join(dir, "fr.json"), "{ not valid json");
  const { locales: found, errors } = locales.scanLocales(dir);
  assert.ok(found.en, "a bad fr.json must not prevent en.json from loading");
  assert.equal(found.fr, undefined);
  assert.ok(errors.some(e => e.filename === "fr.json" && /invalid JSON/.test(e.error)));
});

test("scanLocales: missing _meta is skipped and reported, other locales still load (spec 2A)", () => {
  const dir = scratchDir();
  writeLocale(dir, "en.json", EN);
  writeLocale(dir, "de.json", { common: { save: "Speichern" } });
  const { locales: found, errors } = locales.scanLocales(dir);
  assert.ok(found.en);
  assert.equal(found.de, undefined);
  assert.ok(errors.some(e => e.filename === "de.json"));
});

test("scanLocales: filename/locale mismatch is skipped and reported (spec 2A's es.json/_meta.locale=fr example)", () => {
  const dir = scratchDir();
  writeLocale(dir, "en.json", EN);
  writeLocale(dir, "es.json", { _meta: { locale: "fr" } });
  const { locales: found, errors } = locales.scanLocales(dir);
  assert.equal(found.es, undefined);
  assert.equal(found.fr, undefined, "the content claims fr but the file isn't named fr.json — must not load under either name");
  assert.ok(errors.some(e => e.filename === "es.json"));
});

test("scanLocales: a locale already claimed under its correct filename can't ALSO be claimed by a differently-named file — the second file just fails its own filename-match check (spec 2A's duplicate-locale guarantee, enforced by prevention: two different filenames can never both validly claim the same locale, since each must equal <its own locale>.json)", () => {
  const dir = scratchDir();
  writeLocale(dir, "en.json", EN);
  writeLocale(dir, "es.json", { _meta: { locale: "es", language: "Spanish A" } }); // valid — filename matches
  writeLocale(dir, "es-old.json", { _meta: { locale: "es", language: "Spanish B" } }); // invalid — its OWN name doesn't match its own claimed locale
  const { locales: found, errors } = locales.scanLocales(dir);
  assert.ok(found.es, "the correctly-named es.json still loads");
  assert.equal(found.es.meta.language, "Spanish A", "only the correctly-named file's content is used");
  assert.ok(found.en, "en.json is unaffected");
  assert.ok(errors.some(e => e.filename === "es-old.json"), "the mismatched file is reported as its own distinct error, not silently merged or silently dropped");
});

test("scanLocales: a locale with mismatched placeholders is still loaded, just flagged (spec 4C — runtime/editor decide what to do with it, not discovery)", () => {
  const dir = scratchDir();
  writeLocale(dir, "en.json", { _meta: { locale: "en" }, x: { msg: "Hello {name}" } });
  writeLocale(dir, "es.json", { _meta: { locale: "es" }, x: { msg: "Hola sin marcador" } });
  const { locales: found } = locales.scanLocales(dir);
  assert.ok(found.es);
  assert.deepEqual(found.es.placeholderMismatches, ["x.msg"]);
});

test("scanLocales: orphaned keys (present in translation, absent from English) are reported per-locale", () => {
  const dir = scratchDir();
  writeLocale(dir, "en.json", EN);
  writeLocale(dir, "es.json", { _meta: { locale: "es" }, common: { save: "Guardar" }, leftover: { old: "stale" } });
  const { locales: found } = locales.scanLocales(dir);
  assert.deepEqual(found.es.orphanedKeys, ["leftover.old"]);
});

// ---- seeding ----

test("seedDefaultLocales: copies bundled non-English defaults into an empty runtime directory, creating it if missing — but never touches en.json (that's syncCanonicalEnglish's job)", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(bundledDir);
  writeLocale(bundledDir, "en.json", EN);
  writeLocale(bundledDir, "es.json", { _meta: { locale: "es" } });

  locales.seedDefaultLocales(runtimeDir, bundledDir);

  assert.ok(fs.existsSync(path.join(runtimeDir, "es.json")));
  assert.equal(fs.existsSync(path.join(runtimeDir, "en.json")), false, "seedDefaultLocales must leave en.json alone entirely — syncCanonicalEnglish owns it");
});

test("seedDefaultLocales: NEVER overwrites an existing runtime (non-English) locale, even if the bundled version differs (the core product requirement)", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(bundledDir);
  const translatorEdited = { _meta: { locale: "es", version: 99 }, common: { save: "TRANSLATOR EDITED THIS" } };
  writeLocale(runtimeDir, "es.json", translatorEdited);
  writeLocale(bundledDir, "es.json", { _meta: { locale: "es", version: 1 }, common: { save: "Guardar" } });

  locales.seedDefaultLocales(runtimeDir, bundledDir);

  const onDisk = JSON.parse(fs.readFileSync(path.join(runtimeDir, "es.json"), "utf8"));
  assert.deepEqual(onDisk, translatorEdited, "an upgrade must never silently destroy a runtime locale file, per the explicit product decision");
});

// ---- syncCanonicalEnglish ----

test("syncCanonicalEnglish: first run (no runtime en.json) seeds it from the bundle", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(bundledDir);
  const bundled = { _meta: { locale: "en", version: 3 }, common: { save: "Save" } };
  writeLocale(bundledDir, "en.json", bundled);

  locales.syncCanonicalEnglish(runtimeDir, bundledDir);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, "en.json"), "utf8")), bundled);
});

test("syncCanonicalEnglish: same version — runtime en.json is left byte-for-byte untouched", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(bundledDir);
  // Same version, deliberately different formatting/whitespace so a
  // byte-identity check actually proves nothing was rewritten.
  const runtimeRaw = JSON.stringify({ _meta: { locale: "en", version: 5 }, common: { save: "Save" } }, null, 4);
  fs.writeFileSync(path.join(runtimeDir, "en.json"), runtimeRaw);
  writeLocale(bundledDir, "en.json", { _meta: { locale: "en", version: 5 }, common: { save: "Save (bundled)" } });

  locales.syncCanonicalEnglish(runtimeDir, bundledDir);

  assert.equal(fs.readFileSync(path.join(runtimeDir, "en.json"), "utf8"), runtimeRaw, "equal version must be a complete no-op, not just a content match");
});

test("syncCanonicalEnglish: older runtime version is upgraded to the bundled version", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(bundledDir);
  writeLocale(runtimeDir, "en.json", { _meta: { locale: "en", version: 1 }, common: { save: "Save" } });
  const bundled = { _meta: { locale: "en", version: 2 }, common: { save: "Save", cancel: "Cancel" } };
  writeLocale(bundledDir, "en.json", bundled);

  locales.syncCanonicalEnglish(runtimeDir, bundledDir);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, "en.json"), "utf8")), bundled);
});

test("syncCanonicalEnglish: newer runtime version is never downgraded to an older bundle", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(bundledDir);
  const runtimeNewer = { _meta: { locale: "en", version: 9 }, common: { save: "Save" } };
  writeLocale(runtimeDir, "en.json", runtimeNewer);
  writeLocale(bundledDir, "en.json", { _meta: { locale: "en", version: 2 }, common: { save: "Save" } });

  locales.syncCanonicalEnglish(runtimeDir, bundledDir);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, "en.json"), "utf8")), runtimeNewer);
});

test("syncCanonicalEnglish: snapconVersion is never the replacement criterion — only _meta.version", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(bundledDir);
  // Runtime claims an OLDER snapconVersion but the SAME _meta.version — must be left alone.
  const runtime = { _meta: { locale: "en", version: 5, snapconVersion: "0.1.0" }, common: { save: "Save" } };
  writeLocale(runtimeDir, "en.json", runtime);
  writeLocale(bundledDir, "en.json", { _meta: { locale: "en", version: 5, snapconVersion: "9.9.9" }, common: { save: "Save (bundled)" } });

  locales.syncCanonicalEnglish(runtimeDir, bundledDir);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, "en.json"), "utf8")), runtime);
});

test("syncCanonicalEnglish: malformed runtime en.json is replaced with the bundled canonical, and the broken original is preserved aside for diagnosis", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(bundledDir);
  const corruptBytes = "{ not valid json at all";
  fs.writeFileSync(path.join(runtimeDir, "en.json"), corruptBytes);
  const bundled = { _meta: { locale: "en", version: 1 }, common: { save: "Save" } };
  writeLocale(bundledDir, "en.json", bundled);

  locales.syncCanonicalEnglish(runtimeDir, bundledDir);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, "en.json"), "utf8")), bundled, "SnapCon must be able to fall back to canonical English even after runtime corruption");
  const quarantined = fs.readdirSync(runtimeDir).filter(f => f.startsWith("en.json.corrupt-"));
  assert.equal(quarantined.length, 1, "the broken original must be preserved aside, not silently discarded");
  assert.equal(fs.readFileSync(path.join(runtimeDir, quarantined[0]), "utf8"), corruptBytes);
});

test("syncCanonicalEnglish: Spanish (or any other locale) is never touched by an English sync", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(bundledDir);
  const es = { _meta: { locale: "es", version: 1 }, common: { save: "Guardar" } };
  writeLocale(runtimeDir, "es.json", es);
  writeLocale(runtimeDir, "en.json", { _meta: { locale: "en", version: 1 }, common: { save: "Save" } });
  writeLocale(bundledDir, "en.json", { _meta: { locale: "en", version: 2 }, common: { save: "Save", cancel: "Cancel" } });

  locales.syncCanonicalEnglish(runtimeDir, bundledDir);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, "es.json"), "utf8")), es, "an English upgrade must never touch any other locale file");
});

test("syncCanonicalEnglish: a failed replacement leaves the previous runtime en.json exactly as it was — never partial or corrupt", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "bundled");
  fs.mkdirSync(bundledDir);
  writeLocale(bundledDir, "en.json", { _meta: { locale: "en", version: 2 }, common: { save: "Save" } });
  // Force the write to fail: make the runtime "en.json" path itself an
  // existing DIRECTORY, so writeLocaleFile's rename(tmp, target) fails
  // (EISDIR/ENOTEMPTY) even though the .tmp write beside it succeeds.
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(runtimeDir, "en.json"));

  assert.doesNotThrow(() => locales.syncCanonicalEnglish(runtimeDir, bundledDir), "a write failure must be caught and logged, not thrown up to the caller");

  // The "previous file" here is the directory itself — still exactly a
  // directory, not a half-written file. Nothing valid was ever produced,
  // but nothing was destroyed or left partially-written either.
  assert.ok(fs.statSync(path.join(runtimeDir, "en.json")).isDirectory(), "the pre-existing state must be untouched after a failed write");
});

test("seedDefaultLocales: a missing bundled directory is a silent no-op, not a crash", () => {
  const base = scratchDir();
  const runtimeDir = path.join(base, "locales");
  const bundledDir = path.join(base, "does-not-exist");
  assert.doesNotThrow(() => locales.seedDefaultLocales(runtimeDir, bundledDir));
  assert.ok(fs.existsSync(runtimeDir), "the runtime directory itself is still created");
});

// ---- path safety ----

test("safeLocalePath: rejects path traversal and separators (spec 6F)", () => {
  const dir = scratchDir();
  assert.equal(locales.safeLocalePath(dir, "../../etc/passwd"), null);
  assert.equal(locales.safeLocalePath(dir, "..%2f..%2fetc"), null);
  assert.equal(locales.safeLocalePath(dir, "a/b"), null);
  assert.equal(locales.safeLocalePath(dir, "a\\b"), null);
  assert.equal(locales.safeLocalePath(dir, ""), null);
});

test("safeLocalePath: accepts a well-formed locale and resolves inside the locales directory", () => {
  const dir = scratchDir();
  const resolved = locales.safeLocalePath(dir, "pt-BR");
  assert.ok(resolved);
  assert.ok(resolved.startsWith(path.resolve(dir)));
  assert.equal(path.basename(resolved), "pt-BR.json");
});

// ---- atomic write ----

test("writeLocaleFile: writes valid JSON atomically (no .tmp left behind on success)", () => {
  const dir = scratchDir();
  locales.writeLocaleFile(dir, "es", { _meta: { locale: "es" }, common: { save: "Guardar" } });
  assert.ok(fs.existsSync(path.join(dir, "es.json")));
  assert.equal(fs.existsSync(path.join(dir, "es.json.tmp")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "es.json"), "utf8")), { _meta: { locale: "es" }, common: { save: "Guardar" } });
});

test("writeLocaleFile: rejects an invalid locale code before touching disk", () => {
  const dir = scratchDir();
  assert.throws(() => locales.writeLocaleFile(dir, "../evil", { _meta: { locale: "es" } }));
  assert.equal(fs.readdirSync(dir).length, 0);
});

// ---- fingerprint (concurrent-edit detection) ----

test("computeFingerprint: identical content produces identical fingerprints; a changed file produces a different one", () => {
  const dir = scratchDir();
  writeLocale(dir, "es.json", { _meta: { locale: "es" }, common: { save: "Guardar" } });
  const fp1 = locales.computeFingerprint(dir, "es.json");
  const fp2 = locales.computeFingerprint(dir, "es.json");
  assert.equal(fp1, fp2, "re-reading the same unchanged file must produce the same fingerprint");

  writeLocale(dir, "es.json", { _meta: { locale: "es" }, common: { save: "Guardar cambios" } });
  const fp3 = locales.computeFingerprint(dir, "es.json");
  assert.notEqual(fp1, fp3, "an externally-edited file must produce a different fingerprint — this is the conflict-detection signal");
});

test("computeFingerprint: a nonexistent file (new language) returns null, not a throw", () => {
  const dir = scratchDir();
  assert.equal(locales.computeFingerprint(dir, "xx.json"), null);
});

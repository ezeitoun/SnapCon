// test/i18n-closure.test.js — regression anchor for the final i18n v1
// closure pass's one real correctness fix: authErrorText() (public/app.js)
// previously discarded its caller-supplied English fallback whenever a
// server error `code` was present, unconditionally calling t(key) even if
// English itself had failed to load — which would show a raw translation
// key at login instead of the server's own good English error text,
// contradicting i18n.js's own "Login must never show raw keys" comment.
//
// Neither public/i18n.js nor public/app.js are Node modules (both attach to
// `window`/global scope for the browser, no module.exports, no existing
// harness in this project loads them directly — confirmed by the absence
// of any require("../public/i18n.js") anywhere in test/). A lightweight
// source-text check is the proportionate way to verify the fix landed,
// matching the same justification test/health-maintenance.test.js already
// uses for server.js's un-exported internals.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "public", "i18n.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("i18n.js exports hasTranslation() as a global, alongside t()/tn()/applyI18nToDom()", () => {
  assert.match(i18nSrc, /function hasTranslation\(key\)/);
  assert.match(i18nSrc, /window\.hasTranslation\s*=\s*hasTranslation/);
});

test("authErrorText() checks hasTranslation() before calling t(), instead of unconditionally discarding its fallback argument", () => {
  const fnMatch = appSrc.match(/function authErrorText\(d,fallback\)\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, "authErrorText(d,fallback) must exist in public/app.js");
  const body = fnMatch[0];
  assert.match(body, /hasTranslation\(/, "must call hasTranslation() to guard the t() branch");
  // The old, buggy shape unconditionally returned t(...) whenever a code
  // matched, with no hasTranslation() guard in between — assert that
  // specific pattern is gone.
  assert.doesNotMatch(body, /return \(d&&d\.code&&AUTH_ERROR_KEYS\[d\.code\]\)\?t\(AUTH_ERROR_KEYS\[d\.code\]\):fallback;/);
});

// Second closure-pass fix, found while browser-verifying this same phase
// (not by either audit agent): syncCollapseAllButtonLabel() is invoked once
// at top-level script-parse time (`$("collapseAll").dataset.expanded="0";
// syncCollapseAllButtonLabel();`), which runs synchronously well before
// init()'s `await initI18n(...)` resolves — English isn't loaded yet at
// that point. Confirmed live: this produced a real "[i18n] missing
// translation key" console warning and would bake the raw key string into
// the button (self-corrects moments later via init()'s own
// refreshDynamicI18nText() call, but only once i18n actually finishes
// loading — a slow connection could show the raw key for real).
test("syncCollapseAllButtonLabel() guards its t() call with hasTranslation(), so the pre-i18n-ready top-level call at parse time can't bake a raw key into the button", () => {
  const fnMatch = appSrc.match(/function syncCollapseAllButtonLabel\(\)\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, "syncCollapseAllButtonLabel() must exist in public/app.js");
  const body = fnMatch[0];
  assert.match(body, /hasTranslation\(/, "must call hasTranslation() to guard the t() call");
  assert.doesNotMatch(body, /btn\.textContent=btn\.dataset\.expanded==="1"\?t\("settings\.printers\.collapse_all"\):t\("settings\.printers\.expand_all"\);/);
});

// Third closure-pass fix, also found live: the Language Editor's
// "N untranslated" count (langUntranslatedCount) is set once when a locale
// chip is selected and was never re-derived on a later app-wide locale
// switch while the editor stayed open — confirmed live via a real "0
// untranslated" (English) string surviving a switch to Spanish. Fixed by
// extracting the count into its own pure function and wiring a dedicated
// refresh into the master dispatcher, WITHOUT touching renderLangMeta()'s
// or renderLangKeyList()'s editable <input> fields (which must never be
// rebuilt out from under an admin mid-edit).
test("the Language Editor has its own live-refresh hook wired into the master dispatcher, and it never rebuilds the editable meta/translation <input> fields", () => {
  assert.match(appSrc, /function updateLangUntranslatedCount\(\)/, "the untranslated count must be its own standalone, re-callable function");
  const refreshFnMatch = appSrc.match(/function refreshLangEditorDynamicText\(\)\{[\s\S]*?\n\}/);
  assert.ok(refreshFnMatch, "refreshLangEditorDynamicText() must exist");
  const body = refreshFnMatch[0];
  assert.match(body, /updateLangUntranslatedCount\(\)/);
  assert.match(body, /renderLangChips\(\)/);
  // Must NOT call the two functions that rebuild admin-editable <input>s.
  assert.doesNotMatch(body, /renderLangMeta\(\)/);
  assert.doesNotMatch(body, /renderLangKeyList\(\)/);
  assert.match(appSrc, /refreshLangEditorDynamicText\(\);\s*\n\}/, "must be wired into refreshDynamicI18nText()'s dispatcher");
});

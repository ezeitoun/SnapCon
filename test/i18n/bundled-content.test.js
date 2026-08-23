// test/i18n/bundled-content.test.js — content-integrity regression tests
// against the REAL shipped locales-default/en.json and es.json (not
// synthetic fixtures, unlike locales.test.js's registry-mechanism tests).
//
// Exists specifically so a future phase that adds English keys without
// updating the Spanish translation — the exact mistake this suite is
// designed to catch — fails CI instead of shipping a partially-translated
// "100% Spanish" locale.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const locales = require("../../locales");

const ROOT = path.join(__dirname, "..", "..");
const EN_PATH = path.join(ROOT, "locales-default", "en.json");
const ES_PATH = path.join(ROOT, "locales-default", "es.json");

const en = JSON.parse(fs.readFileSync(EN_PATH, "utf8"));
const es = JSON.parse(fs.readFileSync(ES_PATH, "utf8"));
const enFlat = locales.flattenKeys(en);
const esFlat = locales.flattenKeys(es);

test("bundled en.json and es.json both pass validateLocaleShape", () => {
  assert.equal(locales.validateLocaleShape("en.json", en).ok, true);
  assert.equal(locales.validateLocaleShape("es.json", es).ok, true);
});

test("bundled es.json has zero missing/untranslated keys — 100% coverage of en.json", () => {
  const completion = locales.computeCompletion(enFlat, esFlat);
  const missing = Object.keys(enFlat).filter(k => !locales.isTranslatedValue(esFlat[k]));
  assert.deepEqual(missing, [], "every English key must have a non-empty Spanish translation");
  assert.equal(completion.percent, 100);
});

test("bundled es.json has zero orphaned keys (nothing left over from a removed English key)", () => {
  assert.deepEqual(locales.findOrphanedKeys(enFlat, esFlat), []);
});

test("bundled es.json has zero placeholder mismatches against en.json", () => {
  assert.deepEqual(locales.findPlaceholderMismatches(enFlat, esFlat), []);
});

test("bundled en.json has no empty/whitespace-only values — the canonical source must be fully authored", () => {
  const blank = Object.keys(enFlat).filter(k => !locales.isTranslatedValue(enFlat[k]));
  assert.deepEqual(blank, []);
});

test("the settings.notif.* section exists with the milestone plural pair and no stray fragments (Phase 2 regression anchor)", () => {
  assert.ok("settings.notif.enable_label" in enFlat);
  assert.ok("settings.notif.milestone_hint_one" in enFlat);
  assert.ok("settings.notif.milestone_hint_other" in enFlat);
  assert.ok("settings.notif.milestone_hint_none" in enFlat);
  // "milestone_hint" alone (no _one/_other) would mean someone called t()
  // instead of tn() and the base key doesn't exist — catches that class of
  // mistake directly rather than relying on eyeballing app.js.
  assert.equal("settings.notif.milestone_hint" in enFlat, false);
});

test("the settings.printers.* section exists with the dirty-bar plural pair, status labels, and discovery keys (Phase 3 regression anchor)", () => {
  assert.ok("settings.printers.add_button" in enFlat);
  assert.ok("settings.printers.remove_confirm" in enFlat);
  assert.ok("settings.printers.dirty_bar_named_one" in enFlat);
  assert.ok("settings.printers.dirty_bar_named_other" in enFlat);
  // Base plural key must NOT exist directly — only tn() consumers, never t().
  assert.equal("settings.printers.dirty_bar_named" in enFlat, false);
  assert.ok("settings.printers.discover_scanning" in enFlat);
  assert.ok("settings.printers.discover_none_found" in enFlat);
  assert.ok("settings.printers.discover_scan_failed" in enFlat);
  ["offline", "printing", "paused", "error", "maintenance", "loaded", "complete", "cancelled", "idle"]
    .forEach(k => assert.ok(`printer_status.${k}` in enFlat, `printer_status.${k} must exist`));
});

test("Notifications retrofit: shared save/dirty-bar status text and test-error codes exist (Phase 4 regression anchor)", () => {
  // setSaveStatus()'s callers and showSetTab()'s discard-confirm mirror
  // directly into #notifSaveStatus/#notifDirtyBar — these must exist even
  // though the keys live under the shared settings.dirty_bar.* namespace,
  // not settings.notif.*.
  ["saving", "saved", "probing_printers", "admin_required_before_users", "discard_confirm"]
    .forEach(k => assert.ok(`settings.dirty_bar.${k}` in enFlat, `settings.dirty_bar.${k} must exist`));
  // /api/notify-test's additive `code` field maps to these — printer_offline
  // uses {name}/{detail} params instead of a flat lookup key.
  ["test_error_no_printers", "test_error_missing_chat_id", "test_error_missing_bot_token", "test_error_invalid_topic"]
    .forEach(k => assert.ok(`settings.notif.${k}` in enFlat, `settings.notif.${k} must exist`));
  assert.ok("settings.notif.test_error_printer_offline" in enFlat);
  assert.ok(enFlat["settings.notif.test_error_printer_offline"].includes("{name}"));
  assert.ok(enFlat["settings.notif.test_error_printer_offline"].includes("{detail}"));
});

test("the settings.firmware.* section exists with plural pairs and no stray fragments (Phase 5 regression anchor)", () => {
  ["get_button", "select_button", "deploy_button", "idle_only_hint", "reading",
    "status_offline_detail", "status_skipped_not_supported", "status_skipped_busy", "mcu_majority"]
    .forEach(k => assert.ok(`settings.firmware.${k}` in enFlat, `settings.firmware.${k} must exist`));
  assert.ok("settings.firmware.read_summary_one" in enFlat);
  assert.ok("settings.firmware.read_summary_other" in enFlat);
  assert.ok("settings.firmware.mcu_single_one" in enFlat);
  assert.ok("settings.firmware.mcu_single_other" in enFlat);
  // Base plural keys must NOT exist directly — only tn() consumers, never t().
  assert.equal("settings.firmware.read_summary" in enFlat, false);
  assert.equal("settings.firmware.mcu_single" in enFlat, false);
  // r.state (a raw connector state identifier like "printing") and r.detail
  // (raw connector diagnostic text) must stay untranslated params, never
  // baked into the translated string itself.
  assert.ok(enFlat["settings.firmware.status_skipped_busy"].includes("{state}"));
  assert.ok(enFlat["settings.firmware.status_offline_detail"].includes("{detail}"));
});

test("the settings.users.* section exists — role labels, last-admin protection text, group CRUD, and OTP test codes (Phase 6 regression anchor)", () => {
  // Role display labels must exist, but the STABLE stored role identifiers
  // ("view"/"regular"/"admin", checked in server.js's ROLES array and used
  // as <option> value= attributes) are never translated — only these
  // display-label keys are.
  ["role_view", "role_regular", "role_admin"].forEach(k => assert.ok(`settings.users.${k}` in enFlat, `settings.users.${k} must exist`));
  // Security-critical: the last-admin demote/delete protection messages
  // must exist as translatable text — this test only checks the KEYS exist,
  // never the enforcement logic itself (that stays in server.js, untouched
  // by this phase).
  ["error_last_admin_demote", "error_last_admin_delete"].forEach(k => assert.ok(`settings.users.${k}` in enFlat, `settings.users.${k} must exist`));
  // /api/users, /api/groups, and /api/otp-test's additive `code` fields all
  // map into this one namespace.
  ["error_invalid_login_name", "error_login_name_taken", "error_invalid_role", "error_password_too_short",
    "error_otp_no_password", "error_user_not_found", "error_remote_access_needs_account",
    "error_group_name_required", "error_group_not_found", "error_group_everyone_immutable_rename", "error_group_everyone_immutable_delete",
    "otp_error_missing_topic", "otp_error_missing_bot_config", "otp_error_missing_chat_id",
    "otp_error_missing_api_key", "otp_error_missing_from_address", "otp_error_missing_recipient"]
    .forEach(k => assert.ok(`settings.users.${k}` in enFlat, `settings.users.${k} must exist`));
  // Destructive confirmations must be complete parameterized sentences, not
  // built from concatenated fragments.
  assert.ok(enFlat["settings.users.remove_confirm"].includes("{name}"));
  assert.ok(enFlat["settings.users.delete_group_confirm"].includes("{name}"));
});

test("the settings.remote_access.* section exists — connection-chain states, security-sensitive confirmations, and additive error codes (Phase 7 regression anchor)", () => {
  // Connection-chain step names/details — pure frontend presentation over
  // real booleans on the status object, no stable enum values to preserve.
  ["chain_local_service", "chain_tunnel_process", "chain_cloudflare_edge", "public_address_label",
    "detail_reachable", "detail_blocked", "detail_connected", "detail_connecting", "detail_pid"]
    .forEach(k => assert.ok(`settings.remote_access.${k}` in enFlat, `settings.remote_access.${k} must exist`));
  assert.ok(enFlat["settings.remote_access.detail_pid"].includes("{pid}"));
  // Security-sensitive destructive confirmations must exist as complete,
  // parameter-free (no interpolated identifiers to leak) full sentences —
  // this test only checks the translation exists, never weakens or alters
  // the underlying enable/disable/remove behavior itself.
  ["disable_confirm", "remove_confirm", "insecure_warning", "gate_title", "gate_body"]
    .forEach(k => assert.ok(`settings.remote_access.${k}` in enFlat, `settings.remote_access.${k} must exist`));
  // /api/remote-access/enable and /restart's additive `code` fields.
  ["error_users_disabled", "error_no_admin", "error_not_enabled"]
    .forEach(k => assert.ok(`settings.remote_access.${k}` in enFlat, `settings.remote_access.${k} must exist`));
  // "Last connected: {when}" and "Failed to load log: {message}" must stay
  // single complete parameterized keys, never concatenated fragments.
  assert.ok(enFlat["settings.remote_access.last_connected"].includes("{when}"));
  assert.ok(enFlat["settings.remote_access.log_load_failed"].includes("{message}"));
});

test("the queue.* and settings.queue.* sections exist — attention reason labels, action labels, plural pairs, and additive error codes (Phase 8 regression anchor)", () => {
  // Every ATTENTION_REASONS slug from queue/QueueEngine.js must have a
  // translated label — this is the fix for the pre-existing gap where
  // qs.attentionReason was shown to the user completely raw.
  ["print-failed", "dispatch-failed", "bed-clear-failed", "file-missing", "file-changed",
    "pool-invalid", "recovery-mismatch", "recovery-interrupted", "recovery-unknown-outcome"]
    .forEach(reason => {
      const key = "attention_" + reason.replace(/-/g, "_");
      assert.ok(`queue.${key}` in enFlat, `queue.${key} must exist for attentionReason "${reason}"`);
    });
  // Every action id from QueueEngine.js's RESOLUTIONS_BY_REASON must have a
  // translated label (QUEUE_ACTION_LABEL_KEYS in app.js).
  ["action_resume", "action_retry_job", "action_skip_job", "action_stop_queue",
    "action_retry_bed_clear", "action_skip_bed_clear", "action_use_current_file", "action_acknowledge_resume"]
    .forEach(k => assert.ok(`queue.${k}` in enFlat, `queue.${k} must exist`));
  // Plural pairs — base keys must NOT exist directly (tn() consumers only).
  ["printer_count", "jobs_queued", "idle_with_queue", "idle_with_queue_stopped"].forEach(base => {
    assert.ok(`queue.${base}_one` in enFlat, `queue.${base}_one must exist`);
    assert.ok(`queue.${base}_other` in enFlat, `queue.${base}_other must exist`);
    assert.equal(`queue.${base}` in enFlat, false, `queue.${base} (no suffix) must not exist`);
  });
  // Destructive confirmations must be complete sentences.
  ["release_error_confirm", "stop_queue_confirm", "clear_queue_confirm", "cancel_print_confirm", "delete_pool_confirm"]
    .forEach(k => assert.ok(`queue.${k}` in enFlat, `queue.${k} must exist`));
  assert.ok(enFlat["queue.delete_pool_confirm"].includes("{name}"));
  // /api/queue*, /api/printer-pools*, and /api/queue-store's additive codes.
  ["error_no_printer_access", "error_pool_not_found", "error_pool_name_required",
    "error_queue_save_failed", "error_queue_save_failed_detail", "error_reset_confirm_mismatch"]
    .forEach(k => assert.ok(`queue.${k}` in enFlat, `queue.${k} must exist`));
  assert.ok(enFlat["queue.error_queue_save_failed_detail"].includes("{detail}"));
  // recovery-mismatch's translated template, replacing the server's
  // concatenated "...didn't dispatch: " + filename string.
  assert.ok(enFlat["queue.attention_detail_recovery_mismatch"].includes("{filename}"));
  // Settings > Queue Management tab.
  ["enable_label", "enable_desc", "mode_label", "mode_per_printer", "mode_shared_queue",
    "printer_pools_title", "printer_pools_desc", "new_pool_placeholder", "add_pool_button"]
    .forEach(k => assert.ok(`settings.queue.${k}` in enFlat, `settings.queue.${k} must exist`));
});

test("the settings.logs.* section exists — filter/table chrome, the category-label enum, structured detail templates, and retention controls (Phase 9 regression anchor)", () => {
  // UI chrome: search, category filter, date range, table headers, paging,
  // status/empty/unavailable states.
  ["search_placeholder", "search_aria", "from_title", "to_title", "filter_button",
    "col_time", "col_event", "col_user", "col_printer", "col_detail",
    "load_more", "loading", "no_entries", "unavailable"]
    .forEach(k => assert.ok(`settings.logs.${k}` in enFlat, `settings.logs.${k} must exist`));
  // category is a closed 3-value enum (auth/job/admin) shared verbatim
  // between the #logCategory filter's own <option>s and the table's
  // per-row category label (logCategoryLabel() in app.js) — the stored
  // r.category API value itself is never translated.
  ["category_all", "category_auth", "category_job", "category_admin"]
    .forEach(k => assert.ok(`settings.logs.${k}` in enFlat, `settings.logs.${k} must exist`));
  // Plural pair for the result count — base key must NOT exist directly.
  assert.ok("settings.logs.entry_count_one" in enFlat);
  assert.ok("settings.logs.entry_count_other" in enFlat);
  assert.equal("settings.logs.entry_count" in enFlat, false);
  // fmtLogDetail()'s structured-field templates — label translated, numeric
  // VALUE substituted via {value}, never baked into the translated string.
  ["detail_time", "detail_filament_grams", "detail_filament_meters", "detail_cost"].forEach(k => {
    assert.ok(`settings.logs.${k}` in enFlat, `settings.logs.${k} must exist`);
    assert.ok(enFlat[`settings.logs.${k}`].includes("{value}"), `settings.logs.${k} must contain {value}`);
  });
  // Audit retention controls (#setAuditRetention / #saveAuditRetention) —
  // a distinct feature from settings.printer_sync's unrelated per-printer
  // sync retention fields, which already have their own keys.
  ["retention_label", "retention_placeholder", "retention_invalid"]
    .forEach(k => assert.ok(`settings.logs.${k}` in enFlat, `settings.logs.${k} must exist`));
});

test("the global.* namespace exists — topbar chrome, both sort menus, the splash progress counter, and the config-load warning (Phase 10 regression anchor)", () => {
  // Static topbar button titles/alts/aria-labels, plus the ones this phase
  // deliberately REUSES from settings.* rather than duplicating (settings.title
  // for the gear button, settings.tabs.queue for the queue button) — those
  // two are asserted against settings.*, not global.topbar.*, on purpose.
  ["files_show_title", "files_hide_title", "files_alt", "fleet_search_placeholder",
    "fleet_search_aria", "sort_button_title", "sort_alt", "compact_alt",
    "bulk_heat_title", "heat_alt", "maintenance_title", "health_title", "logout_title",
    "theme_alt_light", "theme_alt_dark", "theme_title_to_dark", "theme_title_to_light"]
    .forEach(k => assert.ok(`global.topbar.${k}` in enFlat, `global.topbar.${k} must exist`));
  // logoutBtn's title carries the current user's display name (applyRoleUI()
  // sets it dynamically on login) — a SEPARATE {name}-templated key from the
  // static logout_title above, which only backs the icon's generic alt text.
  // Regression: the button itself must NOT carry a plain data-i18n-title, or
  // a live locale switch's applyI18nToDom() pass would stomp the
  // username-suffixed title back to the generic translation on every switch.
  assert.ok("global.topbar.logout_title_named" in enFlat);
  assert.ok(enFlat["global.topbar.logout_title_named"].includes("{name}"));
  assert.ok("settings.title" in enFlat, "gear button title/alt reuses settings.title, not a new key");
  assert.ok("settings.tabs.queue" in enFlat, "queue button title reuses settings.tabs.queue, not a new key");
  // Every VIEW_MODE / stable view id (regular/compact/camera/list/printfarm)
  // needs its own full-sentence title key — never assembled from a shared
  // prefix + a per-mode word, so a translation never has to reassemble a
  // sentence out of fragments.
  ["regular", "compact", "camera", "list", "printfarm"].forEach(mode => {
    assert.ok(`global.topbar.view_title_${mode}` in enFlat, `global.topbar.view_title_${mode} must exist`);
  });
  ["camera", "compact", "list", "printfarm"].forEach(mode => {
    assert.ok(`global.topbar.view_label_${mode}` in enFlat, `global.topbar.view_label_${mode} must exist`);
  });
  // Printer sort (#sortMenu, stable ids none/status/time/name) and file sort
  // (#fileSortMenu, stable ids new/old/az/za/big/small) are DELIBERATELY
  // separate key groups — the audit confirmed their option sets don't
  // overlap semantically, so nothing is shared between them.
  ["option_none", "option_status", "option_time", "option_name",
    "title_none", "title_status", "title_time", "title_name"]
    .forEach(k => assert.ok(`global.sort.${k}` in enFlat, `global.sort.${k} must exist`));
  ["option_new", "option_old", "option_az", "option_za", "option_big", "option_small",
    "title_new", "title_old", "title_az", "title_za", "title_big", "title_small"]
    .forEach(k => assert.ok(`global.file_sort.${k}` in enFlat, `global.file_sort.${k} must exist`));
  // Splash boot-progress counter — two placeholders, both required.
  assert.ok("global.splash.connecting_progress" in enFlat);
  assert.ok(enFlat["global.splash.connecting_progress"].includes("{done}"));
  assert.ok(enFlat["global.splash.connecting_progress"].includes("{total}"));
  // configLoadWarningCard + its saveConfig() confirm — the quarantined
  // variant carries {path} (raw filesystem path, never translated as
  // content); the two save-confirm keys are complete independent sentences,
  // not a shared template with an injected fragment.
  ["title", "intro", "quarantined", "not_quarantined", "footer",
    "save_confirm_quarantined", "save_confirm_not_quarantined"]
    .forEach(k => assert.ok(`global.config_load_warning.${k}` in enFlat, `global.config_load_warning.${k} must exist`));
  assert.ok(enFlat["global.config_load_warning.quarantined"].includes("{path}"));
  assert.ok(enFlat["global.config_load_warning.quarantined"].includes("<b>"), "quarantined path must stay wrapped in <b> for the html:true interpolation path");
  assert.ok(enFlat["global.config_load_warning.save_confirm_quarantined"].includes("{path}"));
  assert.ok(!("global.config_load_warning.save_confirm" in enFlat), "no shared save_confirm template with an injected recoveryNote fragment");
});

test("the auth.* namespace exists — login/OTP UI, status text, and additive auth error codes, with anti-enumeration codes preserved (Phase 11 regression anchor)", () => {
  // UI chrome unique to the login/OTP overlay. password_label and the
  // pre-auth language-selector title are DELIBERATE REUSES of
  // settings.users.password_label / settings.view.system_default_locale_section_title
  // (exact English-text matches) — asserted there, not duplicated here.
  ["login_name_label", "login_button", "request_otp_button", "otp_hint",
    "otp_code_label", "otp_verify_button", "status_logging_in", "status_sending_code",
    "status_verifying", "error_missing_login_fields", "error_missing_login_name",
    "error_missing_otp_code"]
    .forEach(k => assert.ok(`auth.${k}` in enFlat, `auth.${k} must exist`));
  assert.ok("settings.users.password_label" in enFlat, "login screen reuses this key rather than duplicating it");
  assert.ok("settings.view.system_default_locale_section_title" in enFlat, "pre-auth language selector reuses this key rather than duplicating it");
  assert.ok("common.back" in enFlat, "the OTP screen's Back button reuses the new shared common.back key");

  // Additive backend auth codes (server.js /api/login*, auth.js
  // verifyOtpCode()) — every code AUTH_ERROR_KEYS (app.js) can receive must
  // have a translation key.
  ["error_users_disabled", "error_invalid_credentials", "error_otp_required",
    "error_otp_not_configured", "error_otp_request_generic_fail", "error_otp_delivery_failed",
    "error_otp_verify_incorrect", "error_otp_verify_request_new", "error_otp_verify_expired",
    "error_otp_verify_too_many_attempts"]
    .forEach(k => assert.ok(`auth.${k}` in enFlat, `auth.${k} must exist`));
  assert.ok(enFlat["auth.error_otp_delivery_failed"].includes("{detail}"), "raw delivery diagnostic must be interpolated, never baked into the translated string");

  // SECURITY — anti-enumeration: each of these three codes is intentionally
  // shared across multiple distinct backend conditions (see server.js's
  // comments at each call site). A regression here — splitting one of these
  // into per-condition codes/keys — would let a translated response leak
  // which condition actually occurred, defeating the whole point.
  assert.equal(enFlat["auth.error_invalid_credentials"], "Invalid login name or password");
  assert.equal(enFlat["auth.error_otp_request_generic_fail"], "Could not send a code for that login name");
  assert.equal(enFlat["auth.error_otp_verify_incorrect"], "Incorrect code");
  // The four otp-verify codes must stay pairwise distinct keys (today's
  // real, pre-existing distinguishability between "wrong code" and "no
  // pending code"/"expired"/"too many attempts" — not something this phase
  // changes, just translates faithfully).
  const verifyKeys = ["error_otp_verify_incorrect", "error_otp_verify_request_new", "error_otp_verify_expired", "error_otp_verify_too_many_attempts"];
  const verifyValues = new Set(verifyKeys.map(k => enFlat[`auth.${k}`]));
  assert.equal(verifyValues.size, 4, "all four otp-verify outcomes must remain distinguishable, matching auth.js's actual behavior");
});

test("the printer.* and fleet.* namespaces exist — Regular/Compact/Camera card chrome, status mapping through printer_status.*, the corrected Cancel tooltip, and the error-panel wrapper (Fleet Phase 1 regression anchor)", () => {
  // Shared action vocabulary (printer.*) — genuinely reusable, meant for
  // List view to pick up later without duplication.
  ["action_resume", "action_pause", "action_estop", "action_estop_title",
    "action_upload", "action_upload_title", "action_print", "action_print_title_selected",
    "action_print_title_pick", "action_maintenance_mode_title", "action_preheat",
    "action_reprint", "action_reprint_title", "action_eject", "action_camera",
    "action_web_interface_title", "action_web_interface_alt", "action_plate", "action_plate_title"]
    .forEach(k => assert.ok(`printer.${k}` in enFlat, `printer.${k} must exist`));
  assert.ok(enFlat["printer.action_reprint_title"].includes("{filename}"));
  assert.ok(enFlat["printer.action_plate_title"].includes("{done}") && enFlat["printer.action_plate_title"].includes("{total}"));

  // Card/progress/camera/error-panel/queued-banner/connectivity chrome.
  ["fleet.card.model_color_header", "fleet.card.printer_toolheads_header", "fleet.card.drag_title",
    "fleet.card.thumb_enlarge_title", "fleet.card.bed_temp_title", "fleet.card.hotend_label", "fleet.card.bed_label",
    "fleet.progress.total_time_label", "fleet.progress.elapsed_label", "fleet.progress.filament_label",
    "fleet.progress.layer_label", "fleet.progress.finished_label", "fleet.progress.remaining_label",
    "fleet.camera.disabled_label", "fleet.camera.no_feed", "fleet.camera.retry_title",
    "fleet.error_panel.code_prefix", "fleet.error_panel.learn_more", "fleet.error_panel.unknown_error_title",
    "fleet.queued.queued_banner", "fleet.queued.staging_banner", "fleet.queued.stage_failed_banner",
    "fleet.queued.starting_print_status", "fleet.queued.printing_status",
    "fleet.status.connecting_short", "fleet.status.connecting_badge", "fleet.status.reconnecting",
    "fleet.status.unreachable", "fleet.status.count_online",
    "fleet.estop_status_sending", "fleet.estop_status_done",
    "fleet.ctl_status_working_pause", "fleet.ctl_status_working_resume", "fleet.ctl_status_working_cancel",
    "fleet.ctl_status_done_resume"]
    .forEach(k => assert.ok(k in enFlat, `${k} must exist`));
  // The E-Stop confirmation moved from a native confirm() (fleet.confirm_estop,
  // now removed) to the hold-to-confirm dialog — every string it needs lives
  // under fleet.estop.*, translatable (the native dialog's OK/Cancel never
  // could be) and reused by the generic openHoldConfirmDialog() component.
  assert.equal("fleet.confirm_estop" in enFlat, false, "replaced by the fleet.estop.* hold-to-confirm dialog");
  ["title", "consequences_title", "consequence_halt", "consequence_lose_print", "consequence_restart",
    "alternative_note", "progress_line", "hold_label", "hold_label_countdown", "helper_idle", "helper_holding"]
    .forEach(k => assert.ok(`fleet.estop.${k}` in enFlat, `fleet.estop.${k} must exist`));
  assert.ok(enFlat["fleet.estop.progress_line"].includes("{elapsed}") && enFlat["fleet.estop.progress_line"].includes("{remaining}"));
  assert.ok(enFlat["fleet.estop.hold_label"].includes("{printer}"));
  assert.ok(enFlat["fleet.estop.hold_label_countdown"].includes("{n}"));

  // Cancel print also moved off a native confirm() (fleet.confirm_cancel_print,
  // now removed) onto the SAME generic dialog component, in its click (not
  // hold) variant — reuses fleet.estop.consequences_title ("This will:")
  // rather than duplicating it, and fleet.progress.elapsed_label/
  // filament_label/remaining_label for its stats strip (see doCancelPrint).
  assert.equal("fleet.confirm_cancel_print" in enFlat, false, "replaced by the fleet.cancelPrint.* click-confirm dialog");
  ["title", "consequence_stops", "consequence_lost", "consequence_queue_managed",
    "consequence_queue_standalone", "alternative_note", "keep_printing", "confirm_button"]
    .forEach(k => assert.ok(`fleet.cancelPrint.${k}` in enFlat, `fleet.cancelPrint.${k} must exist`));
  assert.ok(enFlat["fleet.cancelPrint.consequence_lost"].includes("{elapsed}") && enFlat["fleet.cancelPrint.consequence_lost"].includes("{filament}"));
  // The dismiss button deliberately does NOT reuse common.cancel — the
  // action itself is also called "cancel," so a button labeled "Cancel"
  // would be ambiguous about which of the two opposite meanings it has.
  assert.notEqual(enFlat["fleet.cancelPrint.keep_printing"], enFlat["common.cancel"]);

  // Camera offline placeholder deliberately REUSES printer_status.offline
  // (identical meaning) rather than a duplicate fleet.camera key.
  assert.equal("fleet.camera.offline_label" in enFlat, false, "camera offline placeholder reuses printer_status.offline instead");

  // Placeholder-bearing templates.
  assert.ok(enFlat["fleet.error_panel.code_prefix"].includes("{code}"));
  assert.ok(enFlat["fleet.status.count_online"].includes("{online}") && enFlat["fleet.status.count_online"].includes("{total}"));
  assert.ok(enFlat["fleet.queued.queued_banner"].includes("{name}") && enFlat["fleet.queued.queued_banner"].includes("<b>"));
  assert.ok(enFlat["fleet.queued.staging_banner"].includes("{name}") && enFlat["fleet.queued.staging_banner"].includes("<b>"));
  assert.ok(enFlat["fleet.queued.stage_failed_banner"].includes("{name}") && enFlat["fleet.queued.stage_failed_banner"].includes("{error}"));
  assert.ok(enFlat["fleet.queued.printing_status"].includes("{filename}"));

  // statusColorText() now returns already-translated text sourced from
  // printer_status.* — no duplicate fleet-specific status keys were created.
  ["offline", "printing", "paused", "error", "maintenance", "loaded", "complete", "cancelled", "idle"]
    .forEach(k => assert.ok(`printer_status.${k}` in enFlat, `printer_status.${k} must exist`));
  assert.equal("fleet.status.offline" in enFlat, false, "no duplicate Fleet-specific status key — printer_status.offline is reused");

  // ctl()'s done-state for pause/cancel reuse printer_status.paused/cancelled
  // (same word, same meaning) — only "Resumed" (no matching persistent
  // state — the real state after resume is "printing") gets its own key.
  assert.equal("fleet.ctl_status_done_pause" in enFlat, false, "reuses printer_status.paused instead");
  assert.equal("fleet.ctl_status_done_cancel" in enFlat, false, "reuses printer_status.cancelled instead");

  // The corrected Cancel/Stop tooltip mismatch: the footer's cancel button
  // now uses common.cancel for BOTH title and visible label (previously
  // title="Cancel" but visible text was the mismatched "Stop") — no new
  // fleet-specific "Cancel" key was created, common.cancel is reused.
  assert.equal(enFlat["common.cancel"], "Cancel");
  assert.equal("fleet.action_cancel" in enFlat, false);
  assert.equal("printer.action_cancel" in enFlat, false);

  // error-codes.js itself must remain completely untouched by this phase —
  // no key here may claim to translate Snapmaker catalog title/description/
  // url/code content, only the SnapCon-owned wrapper around it.
  assert.equal("fleet.error_panel.title" in enFlat, false, "the Snapmaker title itself is never translated");
  assert.equal("fleet.error_panel.description" in enFlat, false, "the Snapmaker description itself is never translated");
});

test("the fleet.list.* namespace exists — List-view-specific column headers, plus confirmed reuse of Fleet Phase 1 and cross-phase vocabulary rather than duplicate keys (Fleet Phase 2 regression anchor)", () => {
  // Genuinely List-specific — no existing key means the same thing.
  ["col_file", "col_status", "col_progress", "col_layers", "col_actions", "empty_chip_title", "view_camera_title"]
    .forEach(k => assert.ok(`fleet.list.${k}` in enFlat, `fleet.list.${k} must exist`));
  assert.ok(enFlat["fleet.list.view_camera_title"].includes("{name}"), "the printer name is a placeholder, never baked into the translated string");

  // Reuse, not duplication — these column headers/titles share exact
  // semantics with an already-existing key from a different phase/namespace,
  // so no fleet.list.col_printer / fleet.list.col_tags / fleet.list.col_filament
  // / fleet.list.thumb_enlarge_title / fleet.list.cancel etc. should exist.
  assert.ok("settings.logs.col_printer" in enFlat, "List's Printer column header reuses the Logs table's column header key");
  assert.ok("settings.printers.field_tags" in enFlat, "List's Tags column header reuses the Printers tab's tags field label");
  assert.ok("fleet.progress.filament_label" in enFlat, "List's Filament column header reuses Phase 1's card progress-row label");
  assert.ok("fleet.card.thumb_enlarge_title" in enFlat, "List's thumbnail title reuses Phase 1's card thumbnail title");
  assert.equal("fleet.list.col_printer" in enFlat, false);
  assert.equal("fleet.list.col_tags" in enFlat, false);
  assert.equal("fleet.list.col_filament" in enFlat, false);
  assert.equal("fleet.list.thumb_enlarge_title" in enFlat, false);
  assert.equal("fleet.list.cancel" in enFlat, false);
  assert.equal("fleet.list.pause" in enFlat, false);
  assert.equal("fleet.list.resume" in enFlat, false);
  assert.equal("fleet.list.estop" in enFlat, false);

  // No second status-label mapping was created for List — it must still
  // consume printer_status.* via the same shared statusColorText().
  assert.equal("fleet.list.status_offline" in enFlat, false);
  assert.equal("fleet.list.status_printing" in enFlat, false);
});

test("fleet toolbar, printer-detail modals, file sidebar, and file/send/print workflows are fully covered, with aggressive reuse confirmed by absence of duplicate keys (Fleet Phase 3 regression anchor)", () => {
  // Bulk toolbar — tn() plural bases exist WITHOUT a bare non-suffixed key
  // (that would mean a stray t() call against a tn()-only base).
  ["selected_count", "bulk_cancel_confirm", "bulk_result_paused", "bulk_result_resumed",
    "bulk_result_cancelled", "bulk_failed", "bulk_not_eligible"]
    .forEach(base => {
      assert.ok(`fleet.toolbar.${base}_one` in enFlat, `fleet.toolbar.${base}_one must exist`);
      assert.ok(`fleet.toolbar.${base}_other` in enFlat, `fleet.toolbar.${base}_other must exist`);
      assert.equal(`fleet.toolbar.${base}` in enFlat, false, `fleet.toolbar.${base} must not exist bare — only via tn()`);
    });
  ["tab_all", "tab_attention", "all_tags", "select_all", "bulk_pause_button", "bulk_resume_button",
    "bulk_cancel_button", "bulk_reason_pause", "bulk_reason_resume", "bulk_reason_cancel",
    "bulk_working", "edit_tags"]
    .forEach(k => assert.ok(`fleet.toolbar.${k}` in enFlat, `fleet.toolbar.${k} must exist`));
  // Complete per-action templates, not verb + JS-composed "(N)".
  assert.ok(enFlat["fleet.toolbar.bulk_pause_button"].includes("{n}"));
  assert.ok(enFlat["fleet.toolbar.bulk_cancel_confirm_one"].includes("{names}"));

  // pushTo()/pollJob()/setRowUI() — SnapCon-owned transient upload/print
  // status vocabulary, distinct complete templates rather than a suffix
  // concatenated onto a translated base.
  ["status_uploading", "status_uploading_pct", "status_queued_will_upload", "status_queued_short",
    "status_setting_head_mapping", "status_leveling_bed", "status_calibrating_flow", "status_preparing_timelapse",
    "status_printing_on", "status_printing_on_mapped",
    "status_uploaded", "status_uploaded_mapped"]
    .forEach(k => assert.ok(`fleet.print.${k}` in enFlat, `fleet.print.${k} must exist`));
  assert.ok(enFlat["fleet.print.status_printing_on"].includes("{printer}"));
  assert.ok(enFlat["fleet.print.status_uploading_pct"].includes("{pct}"));
  // "Starting print…" is reused from Phase 1's fleet.queued.starting_print_status
  // by pushTo/pollJob, Quick Print's queued-mode start, and pfilemodal's
  // doPrintFile — no duplicate per-surface "starting" key exists.
  assert.equal("fleet.print.status_starting" in enFlat, false);
  assert.equal("fleet.modal.quickprint.status_starting" in enFlat, false);
  assert.equal("fleet.modal.pfile.status_starting" in enFlat, false);

  // Bed / plate / unload / snapshot control modals.
  ["title_default", "title", "helper", "set_button", "off_button", "error_temp_range",
    "status_setting", "status_turning_off", "status_set", "status_off"]
    .forEach(k => assert.ok(`fleet.modal.bed.${k}` in enFlat, `fleet.modal.bed.${k} must exist`));
  assert.ok(enFlat["fleet.modal.bed.title"].includes("{printer}"));
  assert.ok(enFlat["fleet.modal.bed.status_setting"].includes("{temp}"));

  ["title_default", "title", "printer_fallback", "nothing_selected", "exclude_button",
    "chip_skipped", "chip_will_stop", "object_label", "error_exclude_failed", "no_objects"]
    .forEach(k => assert.ok(`fleet.modal.plate.${k}` in enFlat, `fleet.modal.plate.${k} must exist`));
  ["subtitle", "selection_status", "exclude_n_button", "excluding_status", "excluded_status"]
    .forEach(base => {
      assert.ok(`fleet.modal.plate.${base}_one` in enFlat, `fleet.modal.plate.${base}_one must exist`);
      assert.ok(`fleet.modal.plate.${base}_other` in enFlat, `fleet.modal.plate.${base}_other must exist`);
    });
  // Object/exclusion identifiers themselves are never baked into a
  // translated sentence — only the surrounding count/label prose is a key.
  assert.ok(enFlat["fleet.modal.plate.object_label"].includes("{n}"));
  assert.ok(enFlat["fleet.modal.plate.error_exclude_failed"].includes("{message}"));

  ["edit_color_button", "rfid_badge", "color_helper", "now_label", "palette_tab", "custom_tab",
    "recent_header", "hex_label", "rgb_label", "os_picker_title", "eyedropper_title", "apply_button",
    "title", "confirm_message", "unload_all_instead", "unload_all_button", "unload_one_button",
    "rfid_note", "unknown_material", "custom_fallback", "print_warning_pct", "print_warning",
    "status_unloading", "status_command_sent", "color_mode_title", "color_mode_subtitle",
    "status_saving_color", "error_hex_format"]
    .forEach(k => assert.ok(`fleet.modal.unload.${k}` in enFlat, `fleet.modal.unload.${k} must exist`));
  // The unload/color-swatch "Custom" fallback is a real key, never a baked
  // English literal in state (SPOOL_MODAL_PENDING.name) — see app.js.
  assert.equal(enFlat["fleet.modal.unload.custom_fallback"], "Custom");
  // p.state is routed through printer_status.* before being embedded — no
  // second raw-state-to-English mapping exists for the unload print warning.
  assert.ok(enFlat["fleet.modal.unload.print_warning"].includes("{state}"));
  assert.ok(enFlat["fleet.modal.unload.print_warning_pct"].includes("{state}") && enFlat["fleet.modal.unload.print_warning_pct"].includes("{pct}"));

  ["title_default", "title", "loading", "server_error", "captured_at"]
    .forEach(k => assert.ok(`fleet.modal.snapshot.${k}` in enFlat, `fleet.modal.snapshot.${k} must exist`));
  assert.ok(enFlat["fleet.modal.snapshot.captured_at"].includes("{time}"));

  // Send / Quick Print / pfile workflow modals.
  ["title", "select_one", "done_summary", "error_summary", "idle_only", "compatible_only", "confirm_incompatible", "upload_and_print"]
    .forEach(k => assert.ok(`fleet.modal.send.${k}` in enFlat, `fleet.modal.send.${k} must exist`));
  assert.ok(enFlat["fleet.modal.send.done_summary"].includes("{ok}") && enFlat["fleet.modal.send.done_summary"].includes("{total}"));

  ["title", "subtitle", "calibrate_flow_on", "opt_flow_calibrate_label", "opt_flow_calibrate_desc",
    "opt_timelapse_label", "opt_timelapse_desc", "opt_autolevel_label", "opt_autolevel_desc",
    "ext_nothing_loaded", "ext_none_selected", "blocked_title", "status_start_failed", "start_print_button"]
    .forEach(k => assert.ok(`fleet.modal.quickprint.${k}` in enFlat, `fleet.modal.quickprint.${k} must exist`));
  assert.ok("fleet.modal.quickprint.ext_selected_count_one" in enFlat);
  assert.ok("fleet.modal.quickprint.ext_selected_count_other" in enFlat);

  ["title", "print_time_label", "filament_label", "est_cost_label", "loading", "no_files",
    "no_matches", "reading_colors", "no_filament_loaded", "print_started", "search_placeholder", "search_aria"]
    .forEach(k => assert.ok(`fleet.modal.pfile.${k}` in enFlat, `fleet.modal.pfile.${k} must exist`));

  ["flow_calibration", "timelapse", "auto_leveling"]
    .forEach(k => assert.ok(`fleet.modal.print_opts.${k}` in enFlat, `fleet.modal.print_opts.${k} must exist`));
  // PRINT_OPT_DEFS (Send/pfile) and QP_OPT_DEFS (Quick Print) deliberately
  // keep their own pre-existing, slightly inconsistent wording/casing —
  // not unified into one shared key set, since that would be a visible
  // copy change beyond pure localization.
  assert.equal(enFlat["fleet.modal.print_opts.flow_calibration"], "Flow Calibration");
  assert.equal(enFlat["fleet.modal.quickprint.opt_flow_calibrate_label"], "Flow calibration");

  // File sidebar.
  ["new_folder_title", "new_folder_alt", "upload_title", "upload_alt", "multiselect_clear",
    "search_placeholder", "search_aria", "new_folder_modal_title", "new_folder_name_placeholder",
    "create_button", "empty_no_files_yet", "empty_no_files_in_folder", "empty_no_search_matches",
    "full_spectrum_title", "error_enter_folder_name", "status_creating", "uploading_status",
    "upload_error", "upload_complete", "opening_status"]
    .forEach(k => assert.ok(`files.${k}` in enFlat, `files.${k} must exist`));
  assert.ok("files.multiselect_count_one" in enFlat);
  assert.ok("files.multiselect_count_other" in enFlat);
  assert.ok(enFlat["files.uploading_status"].includes("{name}") && enFlat["files.uploading_status"].includes("{current}") && enFlat["files.uploading_status"].includes("{total}"));
  // files.upload_alt is deliberately its own key, NOT a reuse of
  // printer.action_upload — uploading a local file into the gcode library
  // is a different action from uploading a selected file to a printer,
  // despite sharing the English word "Upload".
  assert.notEqual(enFlat["files.upload_alt"], undefined);

  // Reuse across namespaces/phases — no duplicate keys were created where
  // an existing key already carries the same meaning.
  assert.ok("settings.tabs.printers" in enFlat, "Send modal's Printers label reuses the Settings tab label");
  assert.ok("fleet.toolbar.select_all" in enFlat, "Send modal's Select all reuses the toolbar's Select all");
  assert.ok("printer.action_upload" in enFlat, "Send modal's Upload button reuses the fleet card's Upload action");
  assert.ok("printer.action_print" in enFlat, "pfilemodal's Print button reuses the fleet card's Print action");
  assert.ok("common.cancel" in enFlat, "bed/plate/unload/send/quickprint/pfile/new-folder modals all reuse common.cancel");
  assert.ok("fleet.card.model_color_header" in enFlat && "fleet.card.printer_toolheads_header" in enFlat,
    "pfilemodal's color-mapping headers reuse Phase 1's card headers");
  assert.equal("fleet.modal.pfile.model_color_header" in enFlat, false);
  assert.equal("fleet.modal.pfile.printer_toolheads_header" in enFlat, false);
  assert.equal("fleet.modal.send.cancel" in enFlat, false);
  assert.equal("fleet.modal.bed.cancel" in enFlat, false);
  assert.equal("fleet.modal.plate.cancel" in enFlat, false);
  assert.equal("fleet.modal.quickprint.cancel" in enFlat, false);
  assert.equal("fleet.modal.pfile.cancel" in enFlat, false);

  // error-codes.js remains untouched by this phase too.
  assert.equal("fleet.modal.pfile.error_code" in enFlat, false);
});

test("the fleet.modal.bulkheat.* namespace exists, reuses vocabulary across phases, and go_button follows the tn()-plus-explicit-none pattern (Fleet Phase 3 closure — Bulk Heat regression anchor)", () => {
  ["reason_busy", "cap_note_default", "cap_note_range", "cap_note_capped", "brand_fallback",
    "max_temp_label", "no_printers", "bed_temp_label", "staggered_heating_label",
    "staggered_heating_helper", "staggered_seconds_suffix", "summary_together", "summary_last_at",
    "stop_remaining_button", "go_button_none", "count_status", "count_status_unavailable",
    "status_queued", "status_heating", "status_off", "status_set",
    "result_summary", "result_summary_failed"]
    .forEach(k => assert.ok(`fleet.modal.bulkheat.${k}` in enFlat, `fleet.modal.bulkheat.${k} must exist`));

  // go_button is a tn() pair (1 vs many printers) PLUS a separate, explicit
  // "_none" key for zero-selected — not something tn()'s _one/_other split
  // covers on its own, same established pattern as settings.notif's
  // milestone_hint_none.
  assert.ok("fleet.modal.bulkheat.go_button_one" in enFlat);
  assert.ok("fleet.modal.bulkheat.go_button_other" in enFlat);
  assert.equal("fleet.modal.bulkheat.go_button" in enFlat, false, "go_button must not exist bare — only _one/_other/_none");
  assert.ok(enFlat["fleet.modal.bulkheat.go_button_one"].includes("{n}"));

  // Placeholder-bearing templates.
  assert.ok(enFlat["fleet.modal.bulkheat.max_temp_label"].includes("{temp}"));
  assert.ok(enFlat["fleet.modal.bulkheat.status_set"].includes("{temp}"));
  assert.ok(enFlat["fleet.modal.bulkheat.cap_note_capped"].includes("{cap}") && enFlat["fleet.modal.bulkheat.cap_note_capped"].includes("{name}"));
  assert.ok(enFlat["fleet.modal.bulkheat.count_status_unavailable"].includes("{unavailable}"));
  assert.ok(enFlat["fleet.modal.bulkheat.result_summary_failed"].includes("{failed}"));
  assert.ok(enFlat["fleet.modal.bulkheat.summary_last_at"].includes("{time}"));

  // Reuse — no duplicate keys were created where an existing one (from this
  // phase or an earlier one) already carries the identical meaning.
  assert.ok("global.topbar.bulk_heat_title" in enFlat, "Bulk Heat's modal heading reuses the topbar button's own title");
  assert.ok("fleet.toolbar.select_all" in enFlat, "Bulk Heat's Select all reuses the camera toolbar's Select all");
  assert.ok("fleet.modal.bed.off_button" in enFlat, "Bulk Heat's Off preset reuses the Bed modal's Off button");
  assert.ok("common.cancel" in enFlat, "Bulk Heat's Cancel reuses common.cancel like every other Fleet modal");
  assert.ok("fleet.modal.send.select_one" in enFlat, "Bulk Heat's zero-selected validation reuses Send modal's select_one");
  assert.ok("printer_status.offline" in enFlat && "printer_status.paused" in enFlat && "printer_status.error" in enFlat
    && "printer_status.maintenance" in enFlat && "printer_status.cancelled" in enFlat,
    "Bulk Heat's disabled-reason badges and cancelled-row status reuse printer_status.*");
  assert.equal("fleet.modal.bulkheat.title" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.select_all" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.cancel" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.reason_offline" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.reason_paused" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.reason_error" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.reason_maintenance" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.status_cancelled" in enFlat, false);
  assert.equal("fleet.modal.bulkheat.select_one" in enFlat, false);

  // "Busy" is deliberately its OWN word, not a reuse of printer_status.printing
  // ("Printing") — the app already chose different wording for this specific
  // disabled-reason badge before this phase touched it, and preserving
  // existing behavior means preserving that wording choice, not merging it.
  assert.equal(enFlat["fleet.modal.bulkheat.reason_busy"], "Busy");
  assert.notEqual(enFlat["fleet.modal.bulkheat.reason_busy"], enFlat["printer_status.printing"]);
});

test("final Fleet hardcoded-string scan fixes exist — AFC lane labels, Edit Tags modal, file-sidebar relative-time/move-status text (Fleet Phase 3 closure — final scan regression anchor)", () => {
  // AFC spool-lane state labels — rendered on every card with filamentHeads
  // capability (Regular/Compact/Camera), missed by every earlier pass.
  ["afc_active", "afc_last_used", "afc_loaded"].forEach(k => assert.ok(`fleet.card.${k}` in enFlat, `fleet.card.${k} must exist`));

  // Edit Tags modal (opened from the camera/list toolbar's Edit Tags
  // button) — the button itself was translated in the toolbar pass, but the
  // modal it opens was missed entirely.
  ["title", "placeholder", "swatch_match_title", "swatch_invalid_title"]
    .forEach(k => assert.ok(`fleet.modal.tags.${k}` in enFlat, `fleet.modal.tags.${k} must exist`));
  assert.ok(enFlat["fleet.modal.tags.swatch_match_title"].includes("{tag}") && enFlat["fleet.modal.tags.swatch_match_title"].includes("{color}"));
  assert.ok("common.cancel" in enFlat && "common.save" in enFlat, "Edit Tags modal's Cancel/Save reuse common.cancel/common.save");
  assert.equal("fleet.modal.tags.cancel" in enFlat, false);
  assert.equal("fleet.modal.tags.save" in enFlat, false);

  // fmtTime()'s relative-time strings — used by the file sidebar, search
  // results, and pfilemodal's file list, all three in scope.
  ["server_unreachable", "time_just_now", "time_minutes_ago", "time_hours_ago",
    "move_error", "move_failed"]
    .forEach(k => assert.ok(`files.${k}` in enFlat, `files.${k} must exist`));
  assert.ok("files.move_success_one" in enFlat && "files.move_success_other" in enFlat);
  assert.equal("files.move_success" in enFlat, false, "move_success must not exist bare — only via tn()");
  assert.ok(enFlat["files.time_minutes_ago"].includes("{n}"));
  assert.ok(enFlat["files.time_hours_ago"].includes("{n}"));
  assert.ok(enFlat["files.move_error"].includes("{names}"));
  assert.ok(enFlat["files.move_failed"].includes("{message}"));

  // pfilemodal's Full Spectrum badge now reuses the file-sidebar's existing
  // key instead of carrying its own duplicate literal.
  assert.equal(enFlat["files.full_spectrum_title"], "Full Spectrum");
});

test("the health.* namespace exists — page chrome, the Needs Attention code-keyed reason map, every card, and the sync workflow, with raw diagnostics deliberately left out (Health+Maintenance regression anchor)", () => {
  // No "updated_*_ago" or "refresh_title": the page auto-refreshes on the
  // configured interval while a print is running, so it no longer carries a
  // manual Refresh button or a "last updated" readout.
  ["chip_title_attention", "no_printer_selected", "loading", "unsupported", "could_not_reach",
    "printer_fallback",
    "recent_success_jobs", "metric_print_time", "metric_recent_success", "metric_free_space",
    "metric_last_service", "data_unavailable", "data_unavailable_reason"]
    .forEach(k => assert.ok(`health.${k}` in enFlat, `health.${k} must exist`));
  assert.ok(enFlat["health.loading"].includes("{name}"));
  assert.ok(enFlat["health.could_not_reach"].includes("{message}"));
  assert.ok(enFlat["health.data_unavailable_reason"].includes("{section}") && enFlat["health.data_unavailable_reason"].includes("{reason}"));

  // Needs Attention — every server-side deterministic reason (see
  // server.js's computeHealthAttention/computeMaintenanceAttention/
  // checkFanMismatch, and test/health-maintenance.test.js for the additive
  // code-field regression anchor on the server side) has a matching
  // title+detail key pair, addressed by CODE, never by re-parsing the raw
  // English title/detail server still sends for backward compatibility.
  ["fan_not_spinning", "undervoltage", "throttled", "low_disk_space", "recent_fault",
    "maintenance_overdue", "maintenance_due_soon"].forEach(base => {
    assert.ok(`health.attention.${base}_title` in enFlat, `health.attention.${base}_title must exist`);
    assert.ok(`health.attention.${base}_detail` in enFlat, `health.attention.${base}_detail must exist`);
  });
  assert.ok(enFlat["health.attention.fan_not_spinning_detail"].includes("{name}") && enFlat["health.attention.fan_not_spinning_detail"].includes("{rpm}"));
  assert.ok(enFlat["health.attention.maintenance_overdue_detail"].includes("{component}") && enFlat["health.attention.maintenance_overdue_detail"].includes("{date}"));
  ["card_title", "nothing", "log_fix_button"].forEach(k => assert.ok(`health.attention.${k}` in enFlat));

  // Toolheads — deliberately its OWN wording/casing, not a reuse of Fleet's
  // ALL-CAPS fleet.card.afc_active/afc_last_used/afc_loaded (same three
  // concepts, but this card already used different, pre-existing casing
  // before this phase touched it).
  ["card_title", "empty", "unknown_material", "state_active", "state_last_used", "state_loaded", "no_color_title"]
    .forEach(k => assert.ok(`health.toolheads.${k}` in enFlat, `health.toolheads.${k} must exist`));
  assert.notEqual(enFlat["health.toolheads.state_active"], enFlat["fleet.card.afc_active"]);

  // Controller/System/Heaters/Fans/Faults/Storage cards.
  // Controller link is a table now: no "desc" paragraph, and no "rate_unit"
  // — the per-1M-bytes unit moved into the column header, where it's stated
  // once instead of on every value.
  ["card_title", "col_controller", "reading_retransmits", "reading_invalid_bytes", "reading_task_load",
    "unit_per_million", "unit_bytes", "unit_ms", "warn_line",
    "explain_retransmits", "explain_invalid", "explain_task_load"]
    .forEach(k => assert.ok(`health.controller.${k}` in enFlat, `health.controller.${k} must exist`));
  assert.ok("health.controller.warn_more_one" in enFlat && "health.controller.warn_more_other" in enFlat);
  // No "desc" here either: System, like Storage, dropped its description
  // paragraph when it moved under the metrics row at one tile wide.
  ["card_title", "reading_cpu_temp", "reading_cpu_usage", "reading_memory"]
    .forEach(k => assert.ok(`health.system.${k}` in enFlat, `health.system.${k} must exist`));
  // No "desc": Heaters dropped its description paragraph along with the other
  // cards that moved into the one-tile-wide metrics columns.
  ["card_title", "state_idle", "state_heating", "state_cooling", "state_settling",
    "reading_transit", "reading_stable", "imbalance_note"]
    .forEach(k => assert.ok(`health.heaters.${k}` in enFlat, `health.heaters.${k} must exist`));
  // No "desc", "show_all_button" or summary_all_stopped_*: the Fans card
  // dropped its description and now always lists every fan, so there is no
  // collapsed summary to expand.
  ["card_title", "reading_commanded", "reading_rpm", "reading_not_measurable"]
    .forEach(k => assert.ok(`health.fans.${k}` in enFlat, `health.fans.${k} must exist`));
  ["card_title", "none", "active_badge", "unknown_error"].forEach(k => assert.ok(`health.faults.${k}` in enFlat, `health.faults.${k} must exist`));
  // No "desc": the Storage card dropped its description paragraph when it
  // moved under the Print time metric at one tile wide.
  ["card_title", "critical_banner", "cat_gcode", "sync_root_gcodes", "unused_suffix", "totals",
    "sync_title_unsupported", "sync_title_not_configured", "sync_title_running",
    "sync_button_syncing", "sync_button_idle", "sync_status_listing", "sync_status_downloading",
    "sync_status_downloading_file", "sync_status_cleaning", "sync_status_error", "unknown_error",
    "sync_status_result", "sync_status_result_failed_suffix", "sync_status_result_removed_suffix"]
    .forEach(k => assert.ok(`health.storage.${k}` in enFlat, `health.storage.${k} must exist`));
  assert.ok("health.storage.files_count_one" in enFlat && "health.storage.files_count_other" in enFlat);
  assert.ok("health.storage.unused_title_one" in enFlat && "health.storage.unused_title_other" in enFlat);

  // Storage's G-code sync-root label is its OWN key, not a reuse of
  // settings.printer_sync.gcode_archive ("G-code archive" — a different
  // phrase) — while Logs/Camera DO reuse settings.printer_sync.logs/.camera
  // (exact wording match confirmed against current source).
  assert.notEqual(enFlat["health.storage.sync_root_gcodes"], enFlat["settings.printer_sync.gcode_archive"]);
  // Two labels for one root, on purpose: the legend names the disk-usage
  // CATEGORY, the sync button names what's being synced. Collapsing them
  // back into one key would silently rename whichever side loses.
  assert.equal(enFlat["health.storage.cat_gcode"], "G-code");
  assert.equal(enFlat["health.storage.sync_root_gcodes"], "Jobs");
  assert.notEqual(enFlat["health.storage.cat_gcode"], enFlat["health.storage.sync_root_gcodes"]);

  ["card_title", "hours_prefix"].forEach(k => assert.ok(`health.service.${k}` in enFlat));
  ["card_title", "add_button", "none"].forEach(k => assert.ok(`health.service_history.${k}` in enFlat));

  // healthBtn's title bug: "Back to Fleet"/"Printer health" were previously
  // hardcoded imperative literals bypassing data-i18n-title entirely.
  assert.ok("global.topbar.back_to_fleet_title" in enFlat);
  assert.ok("global.topbar.health_title" in enFlat);
});

test("the maintenance.* namespace exists — shared field vocabulary reused by BOTH Health's inline service form and the Maintenance modal, the Docker restart confirmation, and stable frequency/warranty state mapped to translated presentation (Health+Maintenance regression anchor)", () => {
  ["application_section_title", "docker_restart_button", "docker_restart_help",
    "docker_restart_confirm", "docker_restarting_status"]
    .forEach(k => assert.ok(`maintenance.${k}` in enFlat, `maintenance.${k} must exist`));
  assert.ok(enFlat["maintenance.docker_restart_confirm"].toLowerCase().includes("restart"));

  // Shared field labels — used by BOTH surfaces (Health inline form +
  // Maintenance modal), confirming aggressive reuse rather than two
  // independent copies of "Component"/"Date"/etc.
  ["field_printer", "field_component", "field_date", "field_remind_me", "field_next_due",
    "field_cost", "field_part", "field_optional_hint", "field_notes", "take_offline_label",
    "frequency_none", "frequency_weekly", "frequency_monthly", "frequency_quarterly",
    "frequency_hours250", "frequency_hours500", "frequency_hours_disabled_title",
    "next_due_not_scheduled", "next_due_no_reminder_hint", "next_due_hint", "next_due_hint_component",
    "hours_loading", "hours_unavailable", "error_pick_date", "error_pick_component",
    "status_saving", "status_saved", "status_taking_offline", "status_bringing_online",
    "status_taken_offline", "status_back_online", "warranty_unknown", "warranty_expired",
    "warranty_expires", "last_service_never", "last_service_summary", "no_printers_configured"]
    .forEach(k => assert.ok(`maintenance.${k}` in enFlat, `maintenance.${k} must exist`));

  // Two deliberately DIFFERENT component-field placeholders (Health's plain
  // "type a new component" vs the modal's "Filter or type..." — the modal's
  // field also filters a picker, Health's doesn't) — preserved as separate
  // keys rather than force-unified, matching each surface's pre-existing
  // wording.
  assert.notEqual(enFlat["maintenance.health_component_placeholder"], enFlat["maintenance.modal_component_placeholder"]);

  // Reuse — no duplicate "Maintenance" modal-title key; reuses the same
  // key the topbar wrench button's own title already used.
  assert.ok("global.topbar.maintenance_title" in enFlat);
  assert.equal("maintenance.modal_title" in enFlat, false);
  assert.equal("maintenance.title" in enFlat, false);
  assert.ok("common.cancel" in enFlat && "common.save" in enFlat, "both forms' Cancel/Save reuse common.cancel/common.save");

  // warranty status (unknown/expired/expiring/active) and maintenance
  // component names/frequency VALUES themselves are never translated —
  // only frequency labelKey text and warranty display text are. Component
  // names are free-text, persisted/matched data (server.js's
  // DEFAULT_MAINT_COMPONENTS / CFG.maintenanceComponents) and are
  // deliberately NOT part of this namespace.
  assert.equal("maintenance.component_nozzle" in enFlat, false);
  assert.equal("maintenance.component_timing_belt" in enFlat, false);
});

test("final i18n v1 closure fixes exist — queueBtn's imperative title bug (same class as healthBtn's), and the Fleet 'Selected Model' preview card (final closure regression anchor)", () => {
  // queueBtn.title had the exact same bug already fixed for healthBtn.title
  // in the Health+Maintenance phase: an imperative assignment bypassing its
  // own data-i18n-title. Both reuse the same "Back to Fleet" key rather than
  // each carrying a duplicate literal.
  assert.ok("global.topbar.back_to_fleet_title" in enFlat);
  assert.ok("settings.tabs.queue" in enFlat, "queueBtn's closed-state title reuses the existing Queue Management tab label");

  // Fleet's "Selected Model" preview card (renderJob()) — deferred out of
  // Fleet Phase 3's named scope, now converted.
  ["section_title", "preview_alt", "deselect_title", "deselect_alt", "fs_fork_fallback",
    "full_spectrum_title", "detected_printer", "brand_unknown", "uses_colors_prefix", "hint_full_spectrum",
    "hint_over_toolheads", "hint_confirm_mapping", "no_colors_warning"]
    .forEach(k => assert.ok(`fleet.job.${k}` in enFlat, `fleet.job.${k} must exist`));
  assert.ok("fleet.job.needed_colors_one" in enFlat && "fleet.job.needed_colors_other" in enFlat);
  assert.ok(enFlat["fleet.job.detected_printer"].includes("{brand}"), "the detected connector brand stays a parameter, never baked into the sentence");
  assert.ok(enFlat["fleet.job.full_spectrum_title"].includes("{fork}"));
  // The card's own "Send to printers" button reuses the Send modal's title —
  // no duplicate fleet.job.send_title.
  assert.ok("fleet.modal.send.title" in enFlat);
  assert.equal("fleet.job.send_title" in enFlat, false);

  // The Fleet page's own "Fleet" section heading — never had a key at all
  // before this closure pass (the literal word was hardcoded in index.html
  // since the very first phase).
  assert.equal(enFlat["fleet.section_title"], "Fleet");
});

test("final i18n v1 closure sweep — General tab's Fleet polling/Costs/Sending prints sections, the Browse-for-folder and Electricity-rate modals, first-run onboarding, and accessibility strings, all previously untranslated (v1 closure regression anchor)", () => {
  ["fleet_polling_title", "fleet_polling_desc", "refresh_interval_label",
    "folder_path_not_found", "folder_reachable_no_files", "folder_check_failed",
    "refresh_too_fast_suffix", "refresh_suggested_suffix",
    "costs_title", "costs_desc", "currency_label", "filament_cost_label", "per_spool_suffix",
    "electricity_rate_label", "elec_search_title", "per_kwh_suffix",
    "sending_prints_title", "sending_prints_desc", "head_mapping_label", "head_mapping_desc",
    "auto_match_label", "auto_match_desc"]
    .forEach(k => assert.ok(`settings.general.${k}` in enFlat, `settings.general.${k} must exist`));
  assert.ok("settings.general.folder_checking" in enFlat);
  assert.ok("settings.general.folder_reachable_files_one" in enFlat && "settings.general.folder_reachable_files_other" in enFlat);
  assert.ok("settings.general.refresh_rate_summary_one" in enFlat && "settings.general.refresh_rate_summary_other" in enFlat);
  assert.ok(enFlat["settings.general.refresh_suggested_suffix"].includes("{suggested}") && enFlat["settings.general.refresh_suggested_suffix"].includes("{rate}"));

  ["title", "path_placeholder", "open_button", "network_hint", "select_button", "loading", "my_computer", "no_subfolders"]
    .forEach(k => assert.ok(`settings.browse.${k}` in enFlat, `settings.browse.${k} must exist`));
  ["title", "zip_label", "lookup_button", "apply_button", "zip_error", "looking_up", "rate_result"]
    .forEach(k => assert.ok(`settings.electricity.${k}` in enFlat, `settings.electricity.${k} must exist`));
  assert.ok(enFlat["settings.electricity.rate_result"].includes("{cents}") && enFlat["settings.electricity.rate_result"].includes("{rate}"));

  assert.ok("settings.onboarding_welcome" in enFlat);
  assert.ok("common.decrease" in enFlat && "common.increase" in enFlat, "the number-input step buttons' aria-labels, applied fleet-wide across every numeric Settings field");
  assert.ok("common.skip_to_main_content" in enFlat);
  assert.ok("settings.language_editor.import_error_no_locale" in enFlat);
  assert.ok("settings.notif.resend_key_placeholder_saved" in enFlat);

  // Printer-pools' "Add pool" flow reuses the groups modal's identical
  // enter-a-name/adding/added vocabulary instead of duplicating it.
  assert.ok("settings.users.enter_a_name" in enFlat && "settings.users.adding_group" in enFlat && "settings.users.group_added" in enFlat);

  // queueBtn's imperative-title bug (same class as healthBtn's) reuses the
  // key already introduced for healthBtn, not a duplicate.
  assert.ok("global.topbar.back_to_fleet_title" in enFlat);

  // Genuinely dead keys removed this pass — confirmed zero references
  // anywhere in public/app.js or public/index.html before removal.
  assert.equal("common.close" in enFlat, false);
  assert.equal("common.search" in enFlat, false);
  assert.equal("settings.language_editor.col_key" in enFlat, false);
  assert.equal("settings.language_editor.col_english" in enFlat, false);
  assert.equal("settings.language_editor.col_translation" in enFlat, false);
  assert.equal("settings.language_editor.import_title" in enFlat, false);
  assert.equal("settings.language_editor.import_choose_file" in enFlat, false);
});

test("printer_status has short badge labels for the mapping-phase status override (leveling/calibrating/mapping heads/preparing)", () => {
  // STATUS_OVERRIDE (public/app.js) shows one of these on the fleet card's
  // status badge itself while a job's applyHeadMapping step is actually
  // running — a real, multi-minute physical operation (e.g. Creality's G29)
  // that Klipper's own reported state doesn't reflect (stays "standby").
  ["leveling", "calibrating", "mapping_heads", "preparing"]
    .forEach(k => assert.ok(`printer_status.${k}` in enFlat, `printer_status.${k} must exist`));
});


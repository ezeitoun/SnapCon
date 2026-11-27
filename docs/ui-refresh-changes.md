# Design refresh (preview): every change, and its old equivalent

The design refresh is built beside the current design, behind one switch, so that either can be removed later. This file lists every file and function the refresh touched: what was added, where, and what the classic equivalent is. Every addition in the code is also tagged `UI-REFRESH` (CSS, JS, HTML and server comments; JSON locale files cannot carry comments, so their keys are listed here).

- **Remove the refresh:** delete what is listed here (search `UI-REFRESH`), `public/refresh.css` and its `<link>`, and the locale keys below.
- **Keep the refresh, remove the classic design:** fold `public/refresh.css` into `style.css` without the `html.ui-refresh` prefix, replace each classic function with its refresh twin, then remove the switch.

## The switch

Owner decisions, 2026-11-05: a per-browser preference (not a system setting, so there is never a first-paint flash), applied at once from Settings > View, outside the tab's Save row; `?ui=refresh` / `?ui=classic` overrides it for one page load.

| Where | Added | Classic equivalent |
|---|---|---|
| `public/index.html`, first-paint `<script>` in `<head>` | Reads `?ui=` (then `localStorage` `snapcon-ui`) and adds `ui-refresh` to `<html>`, next to `data-theme`, before any stylesheet | None: `data-theme` only |
| `public/index.html`, `<head>` | `<link rel="stylesheet" href="/refresh.css">` after `style.css` | — |
| `public/index.html`, Settings > View (`#tab-prefs`) | `#uiRefreshCard`: the switch `#setUiRefresh` (real `role="switch"` checkbox, `switch-row` markup as `switchHtml()` makes it), in its own card above the tab's settings | — |
| `public/refresh.css` | New file. Every selector scoped under `html.ui-refresh` (a test enforces this) | `public/style.css`, unchanged |
| `public/app.js`, beside `cardLayoutV2()`/`applyCardLayout()` | `uiRefresh()` (true when `<html>` has `ui-refresh`), `applyUiRefresh(on)` (saves `snapcon-ui`, toggles the class, rebuilds the cards), `syncUiRefreshSwitch()` | — |
| `public/app.js`, init, after `syncThemeButton()` | Sets the switch from `uiRefresh()` and wires its `change` to `applyUiRefresh()` | — |
| `locales-default/en.json`, `es.json` | `settings.view.ui_refresh_label`, `settings.view.ui_refresh_desc`; `_meta.version` 113 → 114 | — |
| `test/uiRefreshSwitch.test.js` | The first-paint script, the switch, the scope rule for `refresh.css` | — |

## Part 1: colour tokens

Owner decisions, 2026-11-05: the token values from the spec; `--ink-faint` stays a text colour at `#8C859A` / `#766E52` / `#7F5C66` (4.5:1 or better); the top-bar tokens are derived from each theme's new tokens; `--offline` = `--idle`; Awareness starts from Light's set for every token not listed (`--rr-*`, `--storage-*`, `--type-*`, `--violet*`, `--uz-*`); the chart colours are not changed.

| Where | Added | Classic equivalent |
|---|---|---|
| `public/refresh.css`, `html.ui-refresh, html.ui-refresh[data-theme="dark"]` | Dark tokens (also the fallback): the listed values, `--brand`, `--brand-ink`, derived `--tb-*`, `--offline` | `style.css` `:root` and `[data-theme="dark"]` |
| `public/refresh.css`, `html.ui-refresh[data-theme="light"]` | Light tokens, same set | `style.css` `[data-theme="light"]` |
| `public/refresh.css`, Awareness copies | A generated copy of each of `style.css`'s 45 `[data-theme="light"]` rules (both token blocks included), selector `html.ui-refresh[data-theme="awareness"]`, unchanged bodies | The light rules themselves; Awareness has no classic equivalent |
| `public/refresh.css`, `html.ui-refresh[data-theme="awareness"]` | Awareness's own tokens, after the copies so they win | — |
| `test/uiRefreshTokens.test.js` | The owner's values, the derived tokens, 4.5:1 text contrast, Awareness has every token Light has, and the copies stay identical to `style.css` | — |
| `public/refresh.css`, after Awareness's tokens | Owner decisions after the contrast review: Awareness `--violet-soft` = `#5B3FC4` (its `--violet`; the Maintenance badge reaches 5.39:1 on its tint); Awareness G-code tags tinted from `--type-gcode-ink` instead of `--busy` (`.lib-type:not(.is-3mf):not(.is-source)`, 5.49:1); `.lib-fam.is-fit` semibold in all three themes | `style.css` `.lib-type` (`--c:var(--busy)`), `.lib-fam.is-fit` (weight from `.lib-fam`) |

Awareness is not selectable until Part 2 (the first-paint script still accepts only light and dark).

**On "keep" (owner, 2026-11-05):** the 45 copied light rules do not stay as two copies. Each `[data-theme="light"]` rule in `style.css` and its `html.ui-refresh[data-theme="awareness"]` copy collapse into one rule, `:is([data-theme="light"],[data-theme="awareness"]) …`, in `style.css` (the light token block likewise becomes the shared base for both, with Awareness's own values after it). The copies in `refresh.css` and the copy check in `test/uiRefreshTokens.test.js` are then removed. **On "remove":** the copies go with `refresh.css`.

Not reached by the tokens (hard-coded in `style.css`, left as they are): the dark `.prism-line` gradient (blues), the progress fills `.prog-fill.cyan` / `.amber` / `.red`, the card action button colours (Part 3), and about 190 other literal colours.

## Part 2: the theme cycle (Day, Night, Awareness)

While the refresh is on, the theme button cycles light (Day) → dark (Night) → awareness → light. While it is off, the button is exactly the classic light/dark toggle, and a saved `"awareness"` shows as dark without being overwritten by that (an explicit click then saves light or dark, as the classic toggle always does). The OS light/dark listener is unchanged: Awareness is only ever an explicit choice.

| Where | Added | Classic equivalent |
|---|---|---|
| `public/index.html`, first-paint `<script>` | The preview is decided first; a stored `"awareness"` becomes `awareness` with it on, `dark` with it off | The same script without the `awareness` branch |
| `public/index.html`, sprite | `<symbol id="tb-ribbon">` (Lucide "ribbon", stroke-width 1.75) | `#tb-theme` |
| `public/app.js`, `syncThemeButton()` | Now chooses: `syncThemeButtonRefresh()` with the refresh, otherwise restores the `#tb-theme` glyph and calls `syncThemeButtonClassic()` | `syncThemeButtonClassic()` is the previous `syncThemeButton()`, unchanged |
| `public/app.js`, beside it | `THEME_CYCLE`, `nextThemeRefresh()`, `themeName()`, `setThemeGlyph()`, `syncThemeButtonRefresh()` (no `aria-pressed`; label "Theme: X. Switch to Y", title "Switch to Y", sheet label "X", the ribbon for Awareness), `shownTheme()` | — |
| `public/app.js`, `#themeBtn` click | `next` is `nextThemeRefresh(cur)` with the refresh, the classic toggle otherwise (one branch) | The classic toggle |
| `public/app.js`, `applyAccountTheme()` | Accepts `"awareness"`; shows it through `shownTheme()` | Accepted light and dark only |
| `public/app.js`, `applyUiRefresh()` | Switching on brings a saved Awareness back; switching off shows dark; then re-syncs the button | — |
| `server.js`, `POST /api/session/theme` | Accepts `"awareness"` (whatever the preview, so a saved value is never rejected) | Light and dark only |
| `locales-default/en.json`, `es.json` | `global.topbar.theme_name_light` / `_dark` / `_awareness` (Day, Night, Awareness; Día, Noche, Concienciación), `theme_switch_to`, `theme_current_next`; `_meta.version` 114 → 115. The classic `theme_alt_*` / `theme_title_to_*` keys stay: the classic button still uses them | — |
| `THIRD_PARTY_NOTICES.md` | New: Lucide (ISC, current licence text), and the existing JetBrains Mono (OFL) | — |
| `test/uiRefreshTheme.test.js` | First paint, the cycle, both buttons, Awareness kept and restored, account themes, the server | — |

Part 3 addition (owner, 2026-11-05): the refresh's glyph is the current theme's own, all Lucide line icons at stroke-width 1.75: `#tb-sun` (Day), `#tb-moon` (Night), `#tb-ribbon` (Awareness), chosen through `THEME_GLYPH` in `syncThemeButtonRefresh()`. The classic `#tb-theme` (a sun and a moon together) stays for the classic button. `THIRD_PARTY_NOTICES.md` credits all three; the moon is one of Lucide's Feather-derived icons, so Feather's MIT notice is included.

## Part 3: buttons

Owner decisions, 2026-11-05: the mapping from the survey, with destructive actions keeping the danger role; two danger levels, outlined `danger` (Stop, cancel print, delete, clear queue) and filled `danger-strong` only for E-Stop and its hold-to-confirm button; no 44px minimum on card chips (~33px) or compact pills (28px); the hero glow only on each dialog's main action. Every rule is CSS in `refresh.css` on the existing classes: no markup changed.

| Role | Applied to (under `html.ui-refresh`) | Classic look |
|---|---|---|
| Primary | `.btn.primary`, `.btn.purple`, `#pfilego`, card/compact/camera chips `[data-start="1"]` (Print) and `[data-act="resume"]` (Resume) | `.btn.primary` flat `--accent`; `.btn.purple` violet; chips grey |
| Hero glow | the main action of each dialog, by id: `#groupsModalSave`, `#tagsSave`, `#langEditorSave`, `#bedmodalset`, `#bulkheatGo`, `#subnetModalScan`, `#rediscoverAll`, `#newFolderModalCreate`, `#maintSave`, `#browseok`, `#elecApply`, `#pfilego`, `#doUploadPrint`, `#sendQueueAddStart`, `#qpPrint` (not on destructive dialogs, not on cards) | — |
| Secondary | every other `.btn-chip`, `.btn.ghost` (except the small ones), `#libSelMove`, `#libSelSplit`, `#pfilecancel`, `#plateSkip` | `.btn.ghost` bordered transparent; chips grey |
| Ghost | `.modalx`, the small `.btn.ghost.btn-sm` inline actions (More, ⋯, Clear filters, Undo…) | `.modalx` text only; `.btn-sm` bordered |
| Danger, outlined | `.btn-chip.danger:not([data-estop])` (card Stop), `.btn.danger`, `.btn.ghost.danger`, `.btn.danger-filled:not(.hc-hold-btn)` (Unload, the delete dialog's permanent button) | `.btn-chip.danger` red text and faint border (E-Stop identical); `.btn.danger-filled` filled red |
| Danger-strong | `.btn-chip[data-estop]`, `.hc-hold-btn` | the same as Stop (chip), filled red (hold button) |
| All | focus ring `2px solid var(--brand)`, offset 2px; disabled at 45% with no shadow or press; presses by `translate` only, never a box-shadow transition; 44px minimum for `.btn` except `.btn-sm`, `.uz-small`, `.jcard-del` and buttons inside a printer card, the multi-select bar or a card note | style.css's own focus and disabled rules |

New tokens per theme: `--btn-p-top/bottom/ink/hi/glow` (the owner's values), `--btn-ds-top/bottom/ink/border`, `--btn-s-hi`, `--btn-s-hover`.

Progress bars (owner, 2026-11-05, part of Part 3): `.prog-fill.cyan::after` sheen in shades of `--busy`, `.prog-fill.amber` = `--paused`, `.prog-fill.red` = `--bad`; the glow only in Night (the light themes keep classic's flat bars). Classic: fixed violet/cyan/purple, amber and red gradients.

`test/uiRefreshButtons.test.js` pins all of the above.

Seen while checking, present in the classic design too: a completed card's fourth chip (Reprint) overflowed the card by about 53px at the default card width; the heat dialog's seconds field was too narrow for its value. Both were fixed afterwards in `style.css` for both designs ("Fix: four card actions…", not part of the refresh, so not tagged): they stay when either design is removed.

Integration with the File Browser's delete dialog (reviewed 2026-11-05): with the refresh on, the Delete dialog's Move to Trash (`btn danger`) and Delete permanently (`btn danger-filled`) both become outlined danger, so the permanent action no longer looks stronger than the trash one, as it does in classic (filled red). Owner's decision, 2026-11-05: Delete permanently stays outlined red; E-Stop remains the only filled danger-strong action; the second confirmation stays. No warning icon was added: SnapCon has no warning glyph, Lucide's could not be fetched verbatim, and the option already carries a red warning line and a named action.

The Delete dialog's method radios take the theme accent in both designs (owner, 2026-11-05): `accent-color:var(--accent)` in `style.css` (classic, like the heat dialog's slider), `var(--brand)` under the refresh (`html.ui-refresh .delete-mode-row input[type=radio]`). Not changed: the focus ring around a focused radio follows style.css's input focus rule (`--accent`), which in Awareness is plum rather than the brand rose.

## Part 4: printer cards in Error

Owner decisions, 2026-11-05: only a printer whose state is `error` (and is not shown offline) is marked; Printing, Paused, Offline and Maintenance are never marked for an error code or message. An unacknowledged error sweeps; an acknowledged one keeps a static red outline. A new code or message re-arms it, and so does the printer leaving Error and entering it again while the page is open. Only an explicit choice acknowledges: a click anywhere on the card, or choosing that printer on the Health page (its printer chips, `/health/<id>`, back/forward) — never the Health page's automatic pick. Client-side only, at most one record per printer. Reduced motion: outline only. Full (classic and v2 card layouts), Compact and Camera; not List view.

| Where | Added | Classic equivalent |
|---|---|---|
| `public/app.js`, after `syncUiRefreshSwitch()` | `ERROR_ACKS` (localStorage `snapcon-error-acks`: `{printerId: "errorCode\u0001message"}`), `ERROR_SEEN`, `errorInstanceKey()`, `cardInError()`, `errorSweepState()`, `syncErrorSweep(card, p)` (classes `is-error-active` / `is-error-ack`, and the `.err-sweep` element), `acknowledgePrinterError(id)` | — |
| `public/app.js`, `reconcileFleetCards()` | `if(uiRefresh()) syncErrorSweep(el, p)` for every card, reused or rebuilt (the card builders are not changed) | — |
| `public/app.js`, the `#fleet` click listener | A click on a card acknowledges its error, then the click goes on as before | — |
| `public/app.js`, `openHealthPage()`, the `popstate` listener, the Health printer chips | Acknowledge when a printer was named or chosen; `selectHealthPrinter()` itself does not (the automatic pick goes through it) | — |
| `public/refresh.css`, Part 4 | The static outline on both classes, plus a static glow (`0 0 24px -8px var(--bad)`) on unacknowledged cards only; `.err-sweep`, a 3px ring (mask) that ignores the pointer, with a full-brightness rotating `::before` (transform, 2.5s per turn; owner, 2026-11-06), sized from the card (twice its width: 653×653 CSS px for a 327px card, 1.6 MB of graphics memory per Error card, 6.5 MB on a 2× display), hidden under `prefers-reduced-motion` | — |
| `test/uiRefreshErrorSweep.test.js` | Acknowledging, re-arming, persistence, the state rule, the hooks, the CSS | — |
| `test/fleet-card-ordering.test.js` | Its sandbox now has `uiRefresh: () => false` | — |

Known limit (client-side by decision): if a printer leaves Error and enters it again with the same code and message while no SnapCon page is open in this browser, the stored acknowledgement still matches when the page next opens, so it is not re-armed.

## Part 5 — equal rows and spool lanes

Owner decisions (decision 7, 2026-11-06). Refresh-only; with the switch off the classic markup is unchanged (the card golden tests pass untouched).

| Change | Where | Notes |
|---|---|---|
| Full view action bar pinned to the bottom | `refresh.css` `html.ui-refresh .pcard .foot{margin-top:auto}` | Every card's buttons share a baseline. |
| Full-view lanes horizontal | `afcLanesHtmlRefresh()` beside `afcLanesHtml()`, chosen at the card's lane line | Spool (the same `spoolSvg` / `emptySpoolSvg`, 40 px) left; label + material beside it; state under it. Keeps `.spool-click` unload, the active lane's inline border and glow, the dashed `.empty` lane. |
| Compact chips | `compactSpoolTilesHtmlRefresh()` beside `compactSpoolTilesHtml()` | Colour swatch, label, whole material; empty slots dashed; full detail in `title`; click to unload. Radius 10 px. |
| 2-column grid | `laneGridAttrs(n, family)` | Column-first (T1/T2 left, T3/T4 right) when the fleet row's `printerFamily` is `snapmaker-u1` and there are ≤4 lanes; row-first otherwise; one lane full width. The fleet row carries `printerFamily`, not the connector, so the family is the test. |
| Camera view: no lanes | `refresh.css` `html.ui-refresh body.camview .rf-lanes{display:none}` | As in classic, which hides `.afc-lanes` in Camera view. Full and Compact keep the lanes. |
| No ellipsis | `.rf-lane-name`, `.rf-chip-text` | `overflow-wrap:anywhere`; material wraps inside the chip. |
| Labels | unchanged | `h.label` or `headLabel(i)`. |
| Strings | `fleet.card.lane_active/lane_loaded/lane_last_used/lane_empty` (en, es; locale version 116) | Sentence case ("Active", "Loaded", "Empty") rather than the brief's ACTIVE/LOADED/EMPTY: CLAUDE.md forbids all-caps labels. The classic `afc_*` strings are untouched. |

Test harness: `test/helpers/cardHarness.js` gains a `documentElement` whose class list never contains `ui-refresh`, so the golden tests read the classic markup.

## Remediation after Part 6 (owner, 2026-11-06)

| Change | Where | Notes |
|---|---|---|
| Error light only on screen, at most 4 | `app.js`: `ERROR_SWEEP_MAX`, `ERROR_SWEEP_CARDS`, `errorSweepObserver()`, `placeErrorSweeps()`, `pruneErrorSweeps()`, `forgetErrorSweepCard()`, `setErrorSweepEl()`; `syncErrorSweep()` now uses them | One `IntersectionObserver` for the page, made on first use, watching only unacknowledged Error cards. The `.err-sweep` element exists only for on-screen cards, top of the page first, up to 4. Other Error cards keep the static outline (and glow while unacknowledged). Visibility never acknowledges. Reduced motion: no light element (CSS also hides it). `pruneErrorSweeps()` runs once at the end of `renderFleet()` and releases removed or rebuilt cards, and every card when the switch is off. Without `IntersectionObserver` every active card counts as on screen (still capped). |
| One focus-ring colour per theme | `refresh.css`, generated rule | Each `style.css` focus rule that colours its ring (`--accent`, `--signal`, `--tb-accent`, `--status-color`; 26 selectors), prefixed with `html.ui-refresh`, gets `outline-color:var(--brand)`. Width, offset and shape unchanged. `test/uiRefreshReadability.test.js` fails if `style.css` gains a coloured focus rule that is not listed. |
| Lane words in theme ink | `afcLanesHtmlRefresh()` (no inline colour on `.rf-lane-state`); `refresh.css` | The filament colour stays on the active lane's border, glow, tint and spool. Active state text `--ink`, 700. |
| Readable empty lanes | `refresh.css` | `.rf-lane.empty` opacity 1 (classic `.afc-lane-card.empty` is 0.55); only its spool graphic stays at 0.55; the slot number in `--ink-dim`. |
| `(Virtual)` | `refresh.css` `.hdr-transport` | `--ink-faint` at full opacity instead of 62% opacity. |
| Awareness "Con" | `refresh.css` | `color-mix(in srgb, var(--tb-accent) 72%, var(--ink))`. |

Measured with 20 printers in Error (1920×1080, headless Chrome without a hardware GPU, so frame rate and CPU are relative): Part 6 had 42 layers / 57.2 MB / 30 fps at 1× and 43 / 269 MB / 30 fps at 2×; now 10 / 17.8 MB / 60 fps and 11 / 112 MB / 60 fps (switch off: 2 / 7.9 MB and 3 / 72 MB, 60 fps). On screen only without a cap was still 30 fps (15 lights), hence the cap of 4.

Camera view's missing-thumbnail placeholder (owner, 2026-11-06): `refresh.css` `html.ui-refresh body.camview .stats-thumb-empty{ opacity:1; color:var(--ink-faint); }` over classic's 30% opacity (`style.css` `.stats-thumb-empty`). Measured 4.94 / 4.92 / 5.45:1 (Night / Day / Awareness); switch off unchanged (2.46 / 1.94).

## Status

Preview. Off by default; each browser switches it on in Settings > View. Some screens are only recoloured, and details may change.

Recorded separately, not fixed here: `docs/TODO.md` §43, the `probeCached()` offline-cache key shared by printers without a url.

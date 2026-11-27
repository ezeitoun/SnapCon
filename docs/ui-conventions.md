# SnapCon UI conventions reference

Moved out of `CLAUDE.md` (the "Named shared things" table of its Section 0, and the detailed
subsections of its Section 5) so that it is read when relevant instead of being loaded into every
session. **Everything here is still a project rule with the same force as `CLAUDE.md`.** Read it
before adding or changing any UI control, label, dialog, setting, file-name display, toolhead label,
secret field or duration display. The text below is unchanged. "Section N" means that numbered section
of `CLAUDE.md`; "Section 0's Named shared things table" is the table directly below.

The general rules of Section 5 (reuse the established pattern; call out a deliberate deviation) and
all of Section 4 (framework-free frontend, frontend lifecycle) remain in `CLAUDE.md`. The frontend's
file layout, CSS tokens, `statusColorText()` and the `body.<mode>` classes are described in
`docs/architecture.md`, "Frontend: `public/`, no build step".

## Named shared things

Verified against source. Where something is marked NOT CURRENTLY SHARED, that means the *behavior* is a required convention but no shared helper/component implements it — don't invent one; apply the convention directly at the call site the way existing code already does.

| Item | Status | Exact reference | Use when |
|---|---|---|---|
| Helper text | EXISTS | `.settings-help` — `public/style.css:841-844`. 12px, `var(--ink-faint)`, with `.warn`/`.ok`/`.err` color-state variants. Used 24× across `public/app.js`. | Any helper text below a field or control. |
| Switch | EXISTS | `switchHtml(id, checked, label, description, disabled)` — `public/app.js:6420-6427`. Real `<input type="checkbox" role="switch" class="switch-input">`. CSS: `.switch-row`/`.switch-input`/`.switch-label`/`.switch-desc` (`public/style.css:921-932`). | A setting that is on or off and takes effect by itself. |
| Checkbox | EXISTS | `checkboxHtml(id, checked, label, description, disabled, attrs)` — `public/app.js:6437-6444`. CSS: `.checkbox-row`/`.checkbox-input`/`.checkbox-label`/`.checkbox-desc`. Several call sites (list-view row-select, bulk-heat, camera multi-select, groups picker) apply `.checkbox-input` to a raw `<input>` directly without calling `checkboxHtml()` — the CSS class is the consistently-shared part even where the generator function isn't always used. | One of several items being selected for an action. |
| Masked-secret control | EXISTS | `secretFieldHtml(cls, hasValue, placeholder)` (`public/app.js:6382-6388`) + `wireSecretField()` + `setSecretFieldState(field, hasValue)` (`public/app.js:6491-6497`) + `secretFieldValue()`. CSS: `.secret-field`/`.secret-chip` (`public/style.css:962-964`). | Any stored secret (tokens, API keys, bot tokens). |
| Toolhead mapping | EXISTS — **two, deliberately different, see Section 5** | `toolheadNumber(i)` (`public/app.js:1849`) and `headLabel(i)` (`public/app.js:594`). | See Section 5, "Toolhead naming," before using either. |
| Duration formatter | EXISTS | `fmtDuration(s)` — `public/app.js:3031-3037`. | Any elapsed/remaining/job-duration display. |
| Filename display | NOT CURRENTLY SHARED | No helper ties truncation + `title` attribute together; each is done ad hoc per call site today. See Section 5, "Filenames," for the required convention (file names keep their extension). There is no extension-stripping helper for file names; `stripExt()` was removed on 2026-10-20. | — |
| Settings dirty-state footer | NOT CURRENTLY SHARED — **two real implementations** | The generic per-tab system: `registerSettingsTab(name, getValues, setValues)` (`public/app.js`), `.settings-dirty-bar` (`public/style.css`); registered tabs are **General** and **Notifications**. Printers tab: its own `baselinePrintersDirty()`, `.printers-dirty-bar`. Other tabs (View among them) still save through the shared `#globalSaveRow` with no dirty footer. See Section 5. | — |

# 5. UI conventions (detail)

## Controls

Switch = a setting that is on or off and takes effect by itself.

Checkbox = one of several items being selected for an action.

Both are real semantic inputs:

- `input type="checkbox"` for checkboxes;
- `input type="checkbox" role="switch"` for switches.

Never implement switches or checkboxes as `div` elements with click handlers.

Every visible label must be correctly associated with its control using `htmlFor`/`for`.

Preserve native keyboard interaction and focus behavior whenever possible.

See Section 0's Named shared things table for the exact Switch and Checkbox implementations (function signatures, file paths, CSS classes, and current usage-consistency notes).

## Labels and helper text

Labels use sentence case.

No ALL CAPS labels anywhere.

Labels appear above the field.

Helper text appears below it.

Helper text uses SnapCon's established helper-text style — see Section 0's Named shared things table for the exact class.

Do not introduce a new typography treatment when it already serves the purpose.

## Destructive actions

Destructive actions use the danger role.

They must never visually resemble the safe adjacent action.

Irreversible actions require confirmation.

The confirmation must name what will be affected rather than using a generic "Are you sure?"

Prefer:

`Remove 3 printers?`

over:

`Are you sure?`

## Action scope

Buttons name the scope of an action whenever multiple items are affected.

Examples:

- `Heat 3 printers`
- `Exclude 2 objects`
- `Unload all 4 heads`

Do not use ambiguous labels such as `Heat`, `Exclude`, or `Unload` when the action applies to multiple targets.

## Disabled controls

Disabled controls carry a `title` attribute explaining why the action is unavailable.

Do not require the user to infer why a control is disabled.

## Settings

Settings tabs use the shared dirty-state behavior described below. **Two separate, real implementations currently exist — not one shared component** (see Section 0's Named shared things table for the exact references); do not consolidate them as a side effect of an unrelated task, and do not pretend a single shared helper spans both. The General and Notifications tabs are registered onto the generic per-tab system (`registerSettingsTab()`); the Printers tab has its own separate implementation; the remaining tabs (View among them) still use the shared Save row and have no dirty footer yet.

Whichever implementation applies to the tab you're working on, the required behavior is the same:

- When settings differ from their last successfully saved values, show the sticky settings footer containing: change count; Discard; Save.
- The footer appears only while dirty.
- Dirty state is a diff against the last successfully saved values, not merely evidence that an input event occurred.
- After successful save, update the saved baseline.
- Discard restores the last successfully saved values.

## Filenames

**No shared helper currently implements this** — truncation and the `title` attribute are done ad hoc per call site today. The required convention, regardless:

- show an actual print file's name **with its extension**, wherever it is displayed (fleet cards in every view, file lists, upload strips, queue, dialogs). SnapCon handles several formats (`.gcode`, `.3mf`, `.gx` and others), and the extension tells them apart;
- retain the complete original filename in a `title` attribute when the visible name is truncated;
- truncate the visible filename when necessary;
- place filenames in flexible columns so they do not force layouts wider.

This applies to actual file names only. User-defined display names and job or model titles that are not file names are shown as they are.

Never modify the actual filename merely for display purposes.

Do not invent a shared filename-display helper/component name that doesn't exist — apply the convention above directly at the call site, the way existing code already does.

This rule replaced "strip the extension" on 2026-10-20, and every display site was moved over the same day (`stripExt()` was deleted). Do not strip a file name's extension for display. A title derived from a file name (for example the Library's suggested model name when splitting) may leave it out, since it is a title, not a file name.

## Toolhead naming

SnapCon has **two real, deliberately different** toolhead-numbering conventions. Do not collapse them into a single "always T1–T4" rule, and do not substitute one for the other without first verifying which convention the feature you're touching is supposed to use — they produce different labels for the same index once T-notation is on, and swapping them silently mislabels a toolhead.

- **`toolheadNumber(i)`** — `public/app.js:1849` — `"T"+(i+1)`. Maps Klipper's 0-based extruder/eN indexing to 1-based T1–T4 (`extruder`/index 0 → T1, `extruder1`/index 1 → T2, `extruder2` → T3, `extruder3` → T4). Documented in-code as the single source of truth for "which physical toolhead does this Klipper object refer to," shared by every Health-page card that references a toolhead: heaters via `heaterLabel()`, fans via `fanLabel()` (example: `e0_nozzle_fan` → T1's cooling fan), and MCUs.
- **`headLabel(i)`** — `public/app.js:594` — `USE_T_NOTATION ? 'T'+i : String(i+1)`. A separate numbering (0-based when T-notation is on — G-code `Tn`-command style) used by the fleet-card Toolheads/spool-lane UI and the Quick Print extruder picker. Explicitly documented in-code as not interchangeable with `toolheadNumber()`.
- MCU names are relabeled server-side, through neither function: `connectors/http-utils.js` maps `mcu` → `"mainboard"` and `mcu e0`.."mcu e3"` → `"toolhead e0"`.."toolhead e3"` (0-based, no T-notation).

Rules:

- Use the mapping appropriate to the UI context you're working in. Check which one the surrounding code already uses before adding new output.
- Never independently derive a user-facing toolhead number from a Klipper object name (`extruder2`, `e1_fan`, etc.) in UI or feature-specific code — always go through one of the two existing functions.
- If a newly encountered object name doesn't fit either existing mapping, investigate and extend the appropriate one rather than inventing a third.

## Empty toolheads

An empty toolhead renders as an empty slot.

Never render a spool graphic merely because the toolhead exists.

A spool graphic implies filament is actually present and must only be shown when printer state supports that conclusion.

## Secrets

Secrets use the shared masked-secret control — see Section 0's Named shared things table for the exact implementation.

Configured secrets display:

- Configured badge;
- Replace;
- Clear.

Never place an existing secret back into the DOM merely to display it.

Never use a placeholder that resembles an actual secret value.

A placeholder must not imply a secret was retrieved when only configured/not-configured state is known.

## Durations

Use `fmtDuration(s)` (`public/app.js:3031-3037`) whenever displaying durations — elapsed/remaining/job-duration displays all route through it (seconds are dropped once the total reaches an hour, kept below that).

Do not create locally different duration formatting for a new feature when this shared implementation already exists.

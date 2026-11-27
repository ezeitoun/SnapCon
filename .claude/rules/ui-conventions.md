---
paths:
  - "public/**"
---

# UI rules for files under `public/`

You are working on SnapCon's frontend. The rules below are the ones that must never be missed; they are a
checklist, not the full text. **Before adding or changing any control, label, dialog, setting, file-name
display, toolhead label, secret field or duration display, read `docs/ui-conventions.md`** (exact helpers,
classes and file references), and `docs/architecture.md` → "Frontend: `public/`, no build step". `CLAUDE.md`
Sections 4 and 5 govern.

- **No framework, no component library, no build step.** Localized changes with the existing JS, DOM and CSS patterns only.
- **Reuse the established pattern.** Search the existing UI for the same interaction first; call out any deliberate deviation during planning.
- **Switch** = a setting that is on or off and takes effect by itself; **checkbox** = one of several items selected for an action. Both are real `<input type="checkbox">` elements (`role="switch"` for switches), never `div`s with click handlers; every visible label is associated with its control.
- **Labels** in sentence case, above the field; no ALL CAPS anywhere. **Helper text** below the field, in the established helper-text style.
- **Destructive actions** use the danger role and never look like the safe action beside them. Irreversible actions need a confirmation that names what is affected (`Remove 3 printers?`, not `Are you sure?`).
- **Buttons name their scope** when several items are affected (`Heat 3 printers`).
- **Disabled controls carry a `title`** saying why.
- **Settings:** a sticky footer (change count, Discard, Save) only while values differ from the last saved ones. Two real implementations exist; do not consolidate them as a side effect.
- **File names** are shown with their extension; the full name goes in `title` when truncated; never alter the real name for display.
- **Toolheads:** two deliberately different numbering functions exist (`toolheadNumber(i)` and `headLabel(i)`); use the one the surrounding code uses and never derive a toolhead number from a Klipper object name yourself.
- **An empty toolhead renders as an empty slot**, never a spool.
- **Secrets** use the shared masked-secret control; an existing secret is never put back into the DOM, and no placeholder may look like one.
- **Durations** go through `fmtDuration(s)`.
- **Lifecycle:** a DOM element captured before an `await` may no longer be mounted afterwards; take care with listeners, polling, camera refresh and visibility changes.
- **Styling:** extend the `:root` CSS tokens instead of hard-coding colours; `statusColorText()` is the single source for status colour and label; display modes are `body.<mode>` classes; fonts stay self-hosted.
- **Text:** a reworded shipped string gets a new key; installed translations keep the values of keys they already have.
- **Golden files:** `test/compactCard.test.js` pins the Full, Camera and List card HTML. Run `npm run test:update-golden` only when a change to those views is intended, and say so in the commit message.

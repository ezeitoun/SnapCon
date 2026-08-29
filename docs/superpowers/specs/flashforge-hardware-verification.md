# FlashForge dual-transport — hardware verification record

Companion to `flashforge-dual-transport-design.md` §11. Each item below gates a
capability that currently ships **off**. A gate lifts only on a recorded
observation here — never on inference from macro source, from the native path's
behaviour, or from an idle API query.

**Record for each attempt:** date, printer, firmware version, the exact request
or macro sent, the exact response, and the observed physical behaviour.

---

## Status

| # | Item | Gated behaviour | Status |
|---|---|---|---|
| 1 | Print-start macro | Moonraker `startPrintFile`; `headMapping` | **NOT VERIFIED** |
| 2 | `assigned_tools` | `applyHeadMapping` completeness | **NOT VERIFIED** |
| 3 | `activeExt` tool→slot mapping | `activeExt` in Moonraker mode | **NOT VERIFIED** |
| 4 | `setColor` | `setColor` capability | **NOT VERIFIED** |
| 5 | `unloadFilament` | `unloadFilament` capability | **NOT VERIFIED** |
| 6 | `autoLevel` | `autoLevel` capability | **NOT VERIFIED** |

None of the six gates above has been verified: `printer-ad5x-a` (the ZMOD AD5X)
went unreachable during the session before any controlled test could be run, and
all six require that machine.

One **separate** item — the camera trust rule — *was* verified on `printer-adventurer-a`
and did change the spec. See "Camera trust rule" below.

---

## 1. Print-start macro — HIGH RISK

**Question.** Which of `SDCARD_PRINT_FILE` or `BASE_SDCARD_PRINT_FILE` starts a
print on ZMOD **without** requiring confirmation on the printer's touchscreen?

**Why it is gated rather than attempted.** ZMOD overrides `SDCARD_PRINT_FILE`,
and its own `_IFS_COLORS_PRINT` calls `BASE_SDCARD_PRINT_FILE` instead — which
implies the override opens a dialog. If it does, an unattended queue start would
hang waiting for a human. A runtime "try one, fall back to the other" strategy
could only detect that by observing a print fail to start: a hung job on real
hardware, possibly overnight. So the connector refuses instead of guessing.

**Procedure**
1. Printer idle, filament loaded, someone watching the touchscreen.
2. Upload a small single-colour file.
3. Send `SDCARD_PRINT_FILE FILENAME="<name>"` via `/printer/gcode/script`.
4. Record: did motion start unattended, or did the touchscreen prompt?
5. If it prompted: cancel, then repeat with `BASE_SDCARD_PRINT_FILE`.

**Result:** _not yet run._ **Narrowed by evidence 2026-08-29:** the risk is now
known to apply only where the firmware *replaces* the command. ZMOD does
(`lesswaste.cfg:1862-1863`, `[gcode_macro SDCARD_PRINT_FILE]` with
`rename_existing: BASE_SDCARD_PRINT_FILE`). Forge-X does not — `printer-adventurer-a`'s
object list has no such macro, leaving Klipper's built-in `virtual_sdcard`
command. The gate is therefore keyed on the live object list
(`printStartOverridden`), not on the model, which also covers a **5M Pro running
ZMOD** — that machine uses the Adventurer connector and would otherwise have
been left ungated.

---

## 2. `assigned_tools`

**Question.** Must `_IFS_COLORS_ASSIGN`'s `variable_assigned_tools` be populated
alongside `_IFS_VARS.tools[]`, or does the touchscreen re-prompt for a mapping
SnapCon has already set?

**Procedure**
1. Send `_IFS_COLORS_ASSIGN TOOL=n PORT=s DIALOG=0` for each tool.
2. Read back `_IFS_VARS.tools` and `_IFS_COLORS_ASSIGN.assigned_tools`.
3. Start a multi-colour print and record whether the touchscreen re-prompts.

**Result:** _not yet run_

---

## 3. `activeExt` tool→slot mapping

**Question.** Confirm the active slot is `tools[current_tool] - 1`, not
`current_tool`.

Status reporting only — no motion, no unattended risk — so this is separable
from items 1–2, but verify it during the same controlled print if possible.

**Procedure**
1. During a multi-colour print, sample `_IFS_VARS.current_tool` and
   `_IFS_VARS.tools` at each colour change.
2. Record which physical slot the printer is actually feeding from.
3. Confirm the mapping holds where `tools[]` is not the identity — on
   `printer-ad5x-a` it was `[2,1,3,4]`, so an identity assumption would be
   silently wrong for the first two tools.

**Result:** _not yet run_

---

## 4–6. `setColor`, `unloadFilament`, `autoLevel`

Verified **individually** — confirming one does not enable another.

| Item | Candidate macro | What to confirm |
|---|---|---|
| `setColor` | ZMOD `COLOR` | Does it change the stored slot colour, and does SnapCon read the change back? |
| `unloadFilament` | `UNLOAD_FILAMENT` / `_IFS_UNLOAD` | Does it unload the named slot, and does it need the printer hot? |
| `autoLevel` | `AUTO_FULL_BED_LEVEL` | Full level routine or a bare mesh calibrate? How long does it take? |

**Results:** _not yet run_

---

## Camera trust rule — VERIFIED 2026-08-29 (`printer-adventurer-a`, Forge-X 1.4.1-25)

The one item here that **is** resolved, and the only one that changed the spec.

| | |
|---|---|
| Advertised by printer | `http://advertised-foreign-host/webcam/?action=snapshot` |
| That host | different subnet; `Destination host unreachable` |
| Rebuilt against printer | `http://printer-adventurer-a/webcam/?action=snapshot` |
| Result | **HTTP 200, `image/jpeg`, 76,648 bytes** (re-confirmed through the connector: 76,837 bytes) |
| Requests to `advertised-foreign-host` | **zero** |

**Conclusion — a design assumption was falsified.** The spec previously stated
that a cross-host entry yields `camera: false`, and predicted `printer-adventurer-a → camera:
false` on the assumption that the printer had no camera of its own. It has one;
the operator simply typed the wrong host into the webcam config. Rejecting the
entry for its host would have disabled a camera that demonstrably works, while
buying no security — the foreign host is never contacted either way.

The rule is now **rebuild-then-verify**: discard the supplied host, rebuild onto
the printer, and advertise `camera: true` only after the candidate returns a
real image. Verified end to end through `flashforge-adventurer.probe()`:
transport `moonraker`, `cameraUrl` rebuilt onto `printer-adventurer-a`, snapshot retrieved.

---

## Reachability notes

- `printer-ad5x-a` — ZMOD 1.7.1-53 AD5X. Reachable at the start of the design
  session, unreachable later.
- `printer-adventurer-b` — Forge-X 1.4.1-0 5M Pro. Observed serving **Moonraker** early
  in the session and the **stock 8898 API** later, with the other port closed
  each time. The cause was not observed. This is the observation that made cache
  invalidation and anti-flap mandatory rather than optional.
- `printer-adventurer-a` — Forge-X 1.4.1-25 5M Pro. Reachable; supplied the
  Adventurer-side evidence (no IFS objects, `exclude_object` present, webcam
  configured on another host).

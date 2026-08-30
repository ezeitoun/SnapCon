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
| 1 | Print-start macro | Moonraker `startPrintFile`; `headMapping` | **PARTIALLY VERIFIED 2026-08-30** — direct single-colour start confirmed unattended; multi-colour path untested. Capability stays gated |
| 2 | `assigned_tools` | `applyHeadMapping` completeness | **NOT VERIFIED** |
| 3 | `activeExt` tool→slot mapping | `activeExt` in Moonraker mode | **NOT VERIFIED** |
| 4 | `setColor` | `setColor` capability | **NO MECHANISM IDENTIFIED** — open design question, not a pending test |
| 5 | `unloadFilament` | `unloadFilament` capability | **VERIFIED NEGATIVE 2026-08-30** — no equivalent mechanism exists; stays `false` |
| 6 | `autoLevel` | `autoLevel` capability | **BLOCKED BY GATE 1** — a print-start preference with no executable path; not independently testable |

Gate 5 has been **verified negative** (see below): the investigation completed
and its answer is that no equivalent mechanism exists, so the capability stays
`false` permanently unless upstream ZMOD documentation changes that. Gate 6 is
**blocked by gate 1** rather than awaiting its own hardware run. Gate 1 is
**partially verified** — the direct start path is confirmed, the multi-colour
path is not — and gates 2–3 remain genuinely open, all requiring
`printer-ad5x-a`.

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

## 1a. Direct start path — VERIFIED POSITIVE 2026-08-30 (`printer-ad5x-a`, ZMOD 1.7.1-53)

**`SDCARD_PRINT_FILE` starts a virtual-SD job unattended. No touchscreen
confirmation is required.**

### The hypothesis this refuted

The gate was written on the reasoning: *"ZMOD overrides `SDCARD_PRINT_FILE`, and
`_IFS_COLORS_PRINT` calls `BASE_SDCARD_PRINT_FILE` instead, therefore the
override probably prompts."* That inferred behaviour from the **existence** of an
override rather than its contents — the mistake this document exists to prevent.

Klipper's own resolved config (`/printer/objects/query?configfile`, not the
include files) shows the override is a bare pass-through:

```
[gcode_macro sdcard_print_file]
  rename_existing: BASE_SDCARD_PRINT_FILE
  gcode: BASE_SDCARD_PRINT_FILE {rawparams}
```

The MD5 check, the `action:prompt_*` dialogs and the IFS colour flow all live in
a **separately named** macro, `_ZSDCARD_PRINT_FILE`, which nothing in the config
calls — it is invoked by the touchscreen/Fluidd UI. The two paths are distinct.

### Test performed

A purpose-built probe was uploaded, run, and deleted. Contents — no extrusion, no
heating, no leveling, no tool change:

```gcode
G90 / M83 / G28 / G1 Z10 F600 / M400 / G4 P2000 / M84
```

573 bytes, sha256 `c41bd4015b0c1506a28925614bbd8c260a05114d22646ec5b3e85d7fc8b276c4`,
uploaded to `gcodes` root with `print=false` (Moonraker confirmed
`print_started: false`), content verified byte-identical after round-trip.

**Command sent (this one only — no `BASE_SDCARD_PRINT_FILE`, no fallback):**

```
POST /printer/gcode/script?script=SDCARD_PRINT_FILE FILENAME="snapcon-gate1-probe.gcode"
```

**Observed:**

```
t= 0.1s  HTTP 200 {"result":"ok"}
t= 1.4s  print_stats=printing  virtual_sdcard.is_active=true  homed_axes="xyz"
         nozzle 24.6C target 0   bed 23.4C target 0
t=23.7s  print_stats=complete   progress=1.00   heaters still target 0
```

**Touchscreen (operator at the machine):** no dialog or confirmation at start;
the panel showed "print complete" at the end — the normal end-of-job message.

**Cleanup:** probe deleted (`http=200`), file count returned to 16, printer left
`complete` / `Ready`, axes unhomed, heaters off.

### What this establishes — and what it does not

**Establishes:** `SDCARD_PRINT_FILE` reaches `BASE_SDCARD_PRINT_FILE` and starts
a job without invoking `_ZSDCARD_PRINT_FILE` or any confirmation. `G28` ran, so
motion began unattended. Heaters were never commanded.

**Does not establish** that a real sliced multi-colour job behaves the same. Such
files go through `_ZSDCARD_PRINT_FILE` with `CHECK_MD5` and `_IFS_COLORS`, which
this probe never reached. The probe also carried **no slicer metadata**, so it
cannot speak for files that do.

### Why the capability still ships gated

`printStartOverridden` refuses whenever `gcode_macro SDCARD_PRINT_FILE` exists in
the object list. On this firmware that is now demonstrably **over-broad for a
plain single-colour start** — but it is deliberately left in place:

- the probe carried no metadata, so a real file may route differently;
- the check is coarse and cannot distinguish a pass-through override from a
  genuinely prompting one on some other ZMOD build;
- an AD5X's realistic use is multi-colour, which is precisely the untested path.

Loosening this needs a narrower signal than "is the macro present", designed
deliberately, and gates 2–3 resolved first. **No capability was changed as a
result of this verification.**

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

## 4. `setColor` — NO IDENTIFIED MECHANISM (open design question)

**Status: not a pending test.** An earlier draft named ZMOD's `COLOR` macro as
the candidate for changing a stored slot colour. Live inspection of
`printer-ad5x-a` (ZMOD 1.7.1-53) on 2026-08-30 showed that is wrong:

```
[gcode_macro COLOR]        # mod/ff5.cfg
gcode:
    GET_ZCOLOR
```

`COLOR` resolves to `GET_ZCOLOR` — a **getter**. It does not set a slot's
colour. Related macros were checked and none is a slot-colour setter either:

- `SET_ZCOLOR` exists, but is invoked internally at print start with a
  `FILENAME` argument — it is part of per-file colour handling, not a persistent
  per-slot setter.
- `SET_ACTIVE_SPOOL` is **SpoolMan integration** (`action_call_remote_method
  "spoolman_set_active_spool"`), unrelated to the IFS material station.

So there is **no identified, let alone verified, mechanism** for `setColor` over
Moonraker. This cannot be resolved by running a test — it needs a design
decision. The plausible options, none investigated:

1. leave `setColor: false` in Moonraker mode permanently (colours remain
   read-only there, edited on the touchscreen or in the stock UI);
2. write `FFMInfo.ffmColorN` in `Adventurer5M.json` directly — a config-file
   write, with all the risk that implies, and unknown effect on the running
   firmware.

Worth noting the native path's own comment already records that even
FlashForge's `msConfig_cmd` does not reliably refresh the touchscreen, so the
native equivalent is itself imperfect.

**Capability ships `false`. Do not enable it without a design decision.**

---

## 5. `unloadFilament` — VERIFIED NEGATIVE 2026-08-30 (`printer-ad5x-a`, ZMOD 1.7.1-53)

**Completed investigation with a negative result.** This is not a pending test:
the question was answered, and the answer is that no equivalent exists.
**No command was sent to the printer during this verification** — it was
resolved entirely from the live object list and the machine's own config files.

### The semantic that must be matched

SnapCon's native implementation (`connectors/flashforge-ad5x.js`) is
**arbitrary-slot**:

```js
async function unloadFilament(p, extruders) {
  for (const e of extruders) await ff.ffControl(p, "ms_cmd", { action: 1, slot: parseInt(e,10)+1 });
}
```

It takes a list of slot indices and unloads each named slot, whether or not that
slot is the one currently threaded to the nozzle. Any Moonraker equivalent has
to do the same.

### Candidates, evaluated from their actual bodies

| Candidate | What it actually is | Verdict |
|---|---|---|
| `UNLOAD_FILAMENT` | Defined **twice** — `mod/base.cfg` and the lesswaste plugin, which loads last and therefore wins. The effective body takes `SPEED` / `EXTRUDER_TEMP=255` / `EXTRUDE_LEN=120` and **has no slot or port parameter**; it sets `_IFS_VARS extruder_port=0`, heats to 255 °C and retracts 120 mm from the **toolhead**. | Toolhead-only. **Not equivalent.** |
| `_IFS_UNLOAD PORT=n` | Guarded by `{% if extruder_port > 0 %}`, cuts the filament (`_REZGEM_PRUTOK`), moves the toolhead to the trash area (`_GOTO_TRASH`), then calls the primitives below. Operates on the **currently threaded / active** filament path. | **Not equivalent** — see the caveat below. |
| `IFS_F24` / `IFS_F11` / `IFS_F39 PRUTOK=n` | The only genuinely per-port primitives. **Undocumented opaque function codes** from ZMOD's `zmod_ifs` Python module: zero `gcode_macro` definitions in any config, absent from `/printer/objects/list`, no entry in `/printer/gcode/help`, module not readable through Moonraker, and no documentation anywhere in the mod tree. Their only use is inside `_CHECK_FILAMENT` as a recovery nudge — *"We pulled each slot a little bit in case one of them was just activating the sensor without being gripped by the extruder."* | **Not executed blindly.** Semantics unknown. |

### Why nothing was run

Two independent reasons:

1. **A toolhead-unload test would have carried no evidential value.** Live state
   at the time of verification: `head_switch_sensor.filament_detected = false`
   and `_IFS_VARS.extruder_port = 0` — **no filament in the toolhead**. Running
   `UNLOAD_FILAMENT` would have heated the nozzle to 255 °C and retracted 120 mm
   of nothing, proving only that the macro executes, which was never in question.
2. **Executing `IFS_F24` / `IFS_F11` blind is precisely what this document
   forbids.** They are undocumented commands driving a filament-gripping
   mechanism, with no way to predict the outcome. A jam is a worse result than
   an unavailable capability.

### Important caveat if this is revisited

`_IFS_UNLOAD` may at best represent an **active-filament unload** — returning
whatever is currently threaded to the nozzle back to its port. That is **not
automatically the same capability** as SnapCon's existing arbitrary-slot unload
API, which can unload any slot regardless of what is loaded. Even a fully
successful test of `_IFS_UNLOAD` would therefore not, by itself, justify
enabling `unloadFilament`: it would demonstrate a *different, narrower*
operation. Enabling the capability on that basis would misrepresent to the UI
and to the queue what the printer can actually be asked to do.

### Conclusion

**There is currently no verified Moonraker mechanism matching the native
per-slot semantic. `unloadFilament` remains `false`.** No production code or
capability was changed as a result of this verification, because the correct
behaviour is already the shipped behaviour.

**Future resolution requires either:**

- upstream ZMOD documentation or source for `IFS_F24` / `IFS_F11` / `IFS_F39`
  (`ghzserg/zmod`, the `zmod_ifs` module), establishing whether any of them is a
  per-slot unload; **or**
- a controlled hardware test with the relevant filament path **actually loaded**,
  which can only settle the active-filament case — and would still leave the
  arbitrary-slot case open per the caveat above.

---

## 6. `autoLevel` — BLOCKED BY GATE 1 (inspected read-only 2026-08-30)

**Reclassified.** This is not an item awaiting a hardware run: it cannot be
meaningfully verified until Moonraker print-start is resolved, because that is
the only place the preference is ever consumed. **No leveling command was sent
during this inspection.**

### `autoLevel` is a preference, not an operation

Tracing how SnapCon actually uses the capability:

```
public/app.js:36-40      PRINT_OPT_DEFS → { key:"autoLevel", cap:"autoLevel", … }   a print-dialog option
public/app.js:5656       the same option in Quick Print
server.js:1285,1371      passed as `prefs` into applyHeadMapping on /api/print and /api/printfile
creality-klipper.js:360  if (autoLevel) await sendG29WithRecovery(p)      inside startPrintFile
snapmaker-u1-klipper.js:204  withPrefFallback(prefs.autoLevel, p.autoLevel)  inside applyHeadMapping
```

Confirmed absent:

- **no** standalone `/api/*level*` route in `server.js`
- **no** connector exports an `autoLevel` / `bedLevel` / `level` function

The capability's only effect is whether the print dialog offers an
"Auto leveling" toggle. It is a **per-print preference**, never a standalone
connector operation.

### Why it is blocked

On a FlashForge printer in Moonraker mode, `startPrintFile` **refuses** (gate 1)
and `applyHeadMapping` is inert (`headMapping: false`). The preference therefore
has **no executable path to the printer**. Setting `autoLevel: true` today would
put a control in the print dialog for a print that cannot start — a UI control
that provably does nothing. That is worse than an absent option.

### What the macro does (read-only inspection)

```
[gcode_macro AUTO_FULL_BED_LEVEL]          # mod/base.cfg
  EXTRUDER_TEMP=240, BED_TEMP=80, PROFILE="auto"
  _FULL_BED_LEVEL …
  _STOP                                    turns the heaters off afterwards

[gcode_macro _FULL_BED_LEVEL]
  BED_MESH_CLEAR FROM=_FULL_BED_LEVEL      clears the existing bed mesh
  _ORIG_CLEAR_NOZZLE EXTRUDER_TEMP=240 BED_TEMP=80   heats and nozzle-cleans
  _BED_MESH_CALIBRATE PROFILE="auto"       full mesh calibration
  _UGOL_PARK                               parks
```

So it is a **full routine**, not a bare mesh calibrate: clear mesh → heat →
nozzle clean → full calibration → park → heaters off. Several minutes of motion.

**Because it begins with `BED_MESH_CLEAR`, an interrupted or failed standalone
test leaves the printer with no mesh profile at all** — a worse state than before
the test. That is a real cost for evidence that cannot lift the gate.

### Additional reason not to run it now

`printer-ad5x-a` showed **intermittent reachability** during this inspection —
two of three state queries returned nothing, the same flakiness observed earlier
in the day. Starting a multi-minute heated, mesh-destroying routine on a printer
whose network connection drops in and out is an unnecessary risk.

### Conclusion

**`autoLevel` remains `false`.** Verification becomes meaningful only once the
Moonraker print-start path is resolved, because that is where the preference must
actually be consumed. Until then this is a dependency, not a pending test.

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

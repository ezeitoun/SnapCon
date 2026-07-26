# Printer Card — Interface Guide
## Top icons

Shown top-right on the card, only when the printer is online. Each one only appears if the printer actually supports it.

| Icon | Name | Shown when | What it does |
|---|---|---|---|
| <img src="public/eject-pill.svg" width="24"> | **Eject** | Printer is Idle / Complete / Cancelled **and** a file is loaded | Immediately clears the loaded file from the printer. **No confirmation dialog** one click and it's gone. |
| <img src="public/camera-pill.svg" width="24"> | **Camera** | Printer's connector supports a camera | Opens a live snapshot modal, fetches a fresh frame from the printer and displays it, with a "captured at" timestamp. Available to view-only users too. |
| <img src="public/fluidd-pill.svg" width="24"> | **Web Interface** | Printer's connector exposes a web UI (e.g. Fluidd/Mainsail) | A plain link opens the printer's own web interface in a new browser tab. Not a SnapCon feature, just a shortcut. |

## Thumbnail
Click the gcode preview thumbnail on the card (only shown once a file is loaded) to open it enlarged in a modal.  
if the printer is offline, clicking does nothing.  
If the thumbnail itself fails to load on the card,  
SnapCon auto-retries a few times before giving up and showing a blank placeholder.

## Filament / spool lanes (T1–T4)
Each toolhead lane shows the loaded spool as a colored icon.

- **Click any single spool** → opens the Unload dialog, pre-scoped to that one toolhead.
- That same dialog has two buttons:
  - **Unload**: unloads just that one toolhead.
  - **Unload All**: unloads all four toolheads at once, regardless of which spool you clicked to get there.
- **Set Color**: only appears for printers whose connector reports color-setting support.  
Depending on the printer, you get either a palette of preset swatches to pick from, or a free color picker + hex input. If the printer can only match to its own fixed set of colors, SnapCon tells you it applied the *closest supported color*, not necessarily an exact match.

### Color-to-Spool Mapping
When you load or select a file on a printer card, it lets you perform Filament Mapping — assigning each color in the file to a physical spool. Depending on your configuration, this happens either by direct index (T1→T1, T2→T2, ...) or automatically, matching file colors to the closest available spools using a Hungarian-style matching algorithm.
You can always override this and assign colors to spools manually.
Note: if the file requires different materials than what's currently loaded, an ✕ will appear on the affected mapping(s). Printing is still possible in this case — but proceed at your own risk.
![Spools](./docs/Spools.png)


## Bottom buttons (footer)
The footer's button set depends entirely on whether the printer is currently printing/paused or not.

### Idle
| Icon | Button | What it does |
|---|---|---|
| <img src="public/upload-file.svg" width="20"> | **Upload** | Sends the currently-selected file to this printer, but doesn't start it, just loads it onto the printer. |
| <img src="public/print-icon.svg" width="20"> | **Print** | If you have a file selected in the file browser, uploads *and* starts it right away. If nothing's selected, instead opens a browser of files already sitting on the printer so you can pick one to print. If the printer's still finishing something else, the print is queued to start automatically once it goes idle. |
| <img src="public/preheat-icon.svg" width="20"> | **Preheat** | Opens the Set Bed Temp dialog pre-filled at 60°C, just a shortcut into the same dialog you'd get by setting a custom temperature; you can still change the number before applying, or hit Off. |

### Printing / Paused
| Icon | Button | What it does |
|---|---|---|
| <img src="public/print-icon.svg" width="20"> | **Resume** | Shown only while paused. Resumes the print immediately, no confirmation. |
| <img src="public/pause-icon.svg" width="20"> | **Pause** | Shown only while actively printing. Pauses immediately, no confirmation. |
| <img src="public/stop-icon.svg" width="20"> | **Stop** (Cancel) | Always available while busy. **Asks you to confirm** ("Cancel this print? This can't be undone.") before cancelling. |
| <img src="public/plate-icon.svg" width="20"> | **Plate** | Only shown for multi-object prints on a connector that supports it. Opens the exclude-object map, click objects on the plate (or in the list) to select them, then hit **Skip (N)** to drop them from the rest of the print. |
| <img src="public/estop-icon.svg" width="20"> | **E-Stop** | Always available while busy. **Asks you to confirm** ("Emergency stop will immediately halt the printer and require a firmware restart to recover.")  this is a hard stop, not a graceful cancel. |

## Notes
- Every action that can't be undone (Cancel, E-Stop) requires a confirmation click. Everything else (Pause, Resume, Eject, spool unload after the dialog) fires immediately.
- Buttons that act on the printer are disabled for View-only accounts; Camera stays available to everyone since it's read-only.

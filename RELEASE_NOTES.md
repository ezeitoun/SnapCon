0.1.0
### User Management
A new option under General Settings lets you enable "Enable User Access Management."   
Once turned on, logging in becomes required to use SnapCon.

### Improved Printer Maintenance
Printer Maintenance has been improved.

### Experimental Orca "Plugin"
For those who prefer working with Orca Slicer instead of Snapmaker Orca (Snorca), an option was added to "connect" Orca to SnapCon.

0.2.0
### Telegram Notifications Support
### Improved Subnets Support
- The old bare x.x.x.0 format, unchanged.
- CIDR notation: 192.168.22.0/25 (hosts .0–.127),    192.168.22.128/25 (hosts .128–.255) — exactly your examples.
- A dotted subnet mask instead of a prefix length: 192.168.22.128/255.255.255.128.
- An unaligned IP anywhere in the block (e.g. 192.168.22.5/25) — normalizes to the containing block automatically rather than requiring you to type the exact boundary address.
- Also added a floor at /20 (max 4096 addresses) — a typo'd /8 or /16 would otherwise kick off a scan that takes forever; it returns a clear error instead.
### Improved File Manager
- **New Folder**, a "+ Folder" button opens a styled modal   
- **Search**, not just filter — the search box now does a recursive search from the gcode root down through every subfolder
- **Upload from your PC**, an "Upload" button opens a native file picker (multi-file)
- **Multi-select → drag-to-move**, select files Explorer/Finder-style (Shift+click (range-select from the last-clicked anchor) and Ctrl+click (toggle individual files))

### Connectors Architecture Introduced
Although SnapCon was developed primarly for SnapMaker (and will be kept like that), I have added connectors architecture to support other printers.
- First fully developed/connectors is for AD5X (Native, No need for any special firmware deployment)
- - Scanning a subnet will find the AD5X, But you wont be able to use the printer until the Serial Number (SNXXXX) will be configured alone with the Printer ID
- - you can switch filemanets colors on the interface, due to a limitation on the AD5X GUI, It will always be displayed as black in the GUI (but the configured colors will be used for the poop calculations)
- - If a print was canceled, you will need to "Eject" the file via the printer card (otherwise it will stay busy due to the GUI popup window)

### Remote Access
Check on your prints from anywhere — no port forwarding, no VPN, no messing with your router.
One click in Settings, a quick one-time verification in your browser, and SnapCon gives your
print farm its own secure private link you can open from your phone, at work, wherever.
Fully opt-in, and reversible any time you want to turn it off.

### Fixes
- Compact-mode bug: the folder icon didn't open the file list at all while in compact view
- "Folder button appears out of the blue" in Settings 
Visual polish

Bug Fixes:
- When printer cards are reduced in size, file manager does not open. Only opens if cards are full size.
- 




Alain du Toit
 ·

1) From file manager, when new print is selected and "print" is clicked, an upload progress bar should appear.
2) Docker restart button would be nice 😁💪 (to refresh running config)
- Detection: IS_DOCKER in server.js checks fs.existsSync("/.dockerenv") — the standard marker every Docker Engine container has, no extra permissions needed.


3) When print uploads from file manager, offer 2 tick boxes that instructs the U1 to do flow rate calibration and bed leveling before the print starts.

5) File manager should support folder creation from the interface as opposed to manually in the gcode folder. Also, once folders are created, search must be able to read into folder structures.
Keep going Dude, this is great work 👌💯😎
Reply
Edited

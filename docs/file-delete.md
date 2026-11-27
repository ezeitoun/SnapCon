# File Browser delete: trash, permanent delete, restore

The reference for deleting files from the G-code folder. Code: `fileTrash.js` (both methods, trash listing, restore), `netfs/moveNoReplace.js` and the `unlinkFile` op in `netfs/netfs-worker.js` (the file operations), `server.js` (`/api/files/delete`, `/api/files/trash`, `/api/files/trash/restore`, `gcodeFileInUse`, the delete reservations and send holds), `public/app.js` (the delete dialog). Owner decisions are dated where they were made.

## Principles

1. **Move to Trash is the default and is recoverable.** A deleted file is moved, never removed, and kept 30 days. Nothing purges the trash yet (owner, 2026-11-05: not until restore and retention are proven).
2. **Nothing is ever overwritten.** Neither a delete nor a restore can replace another file, including one another program creates at the same moment.
3. **A file SnapCon still needs is not deleted.** An upload reading it, a waiting send that will read it, or a queue item naming it keeps it, and so does a send that is still being prepared.
4. **Uncertain is never reported as done.** When the share stops answering mid-operation, the file is reported as possibly done or not done, and audited as unconfirmed.

## The two methods

| | Move to Trash | Delete permanently |
|---|---|---|
| Who | Regular and Admin | A signed-in Admin, and only while user accounts are switched on (owner, 2026-11-05). Refused with 403 for anyone else, and for every request while accounts are off, when everyone is an implicit admin. |
| What happens | One rename on the same share, into `<G-code folder>/.snapcon-trash/<batch>/files/<original path>` | netfs `unlinkFile`: the file is removed only if it is still the file that was checked (below) |
| Recoverable | 30 days, through the trash routes | Not through SnapCon |
| Audit | `file-deleted`, `method: "trash"`, with the batch | `file-deleted`, `method: "permanent"` |

Both go through the same pipeline: the G-code folder boundary and path rules, print files only (`.gcode`, `.gco`, `.g`, `.gx`, `.3mf`), no folders, nothing already in the trash, the in-use check, the reservation, the netfs worker with its timeouts, and a result for every file. One failing file never stops the others. If the share stops answering, every later file is left untouched (`not_attempted`) and the file in progress is `unknown` (audited `file-delete-unconfirmed`).

In the File Browser, Delete (one file) and "Delete N files" (a multi-selection) open one dialog: the files, then the method. Move to Trash is selected every time it opens; the choice is never remembered. Delete permanently is shown only to a signed-in Admin, warns that it can't be undone through SnapCon, and asks once more in the browser's confirmation.

## The trash

- One folder per delete request (`<UTC time>-<random>`), created without `recursive` so two requests never share one. Each file keeps its own path under `files/`, so where it came from survives even without the manifest.
- `manifest.json` per batch: who, when, `expiresAt` (30 days), each file's path and size. Written after the moves; a manifest that could not be written loses only that detail.
- What is in `files/` is the truth: the listing (`GET /api/files/trash`) shows what is actually there, lists a batch with a missing or cut-short manifest, and leaves out empty batches (a delete interrupted before its first move). `expired` is informational only.
- The trash is out of reach of everything else: `safePath()` refuses any path in it (so no route that names a G-code folder file can read, send, queue, move or overwrite a trashed file), the listing hides it, folder creation, upload and move refuse it, search skips dot-folders, and the Library's scanner skips dot-folders. The name is matched ignoring case and the trailing dots and spaces Windows drops.

## Restore

`POST /api/files/trash/restore` puts one file back where it was deleted from, creating its folder if it is gone.

- **Only by hard link** (`netfs/moveNoReplace.js`): `link()` refuses an existing name atomically (`EEXIST`), then the trash name is dropped. Nothing is copied, so no crash can leave a partial file; at worst the file is in both places. A file now at the original place is refused (409), never overwritten.
- Storage without hard links is refused (501 `restore_unsupported`) and the file stays in the trash. There is deliberately no copy or check-then-rename fallback (owner, 2026-11-05): `rename()` replaces an existing file, on POSIX and on the SMB share alike.
- A full disk is 507 `no_space`; a share that stopped answering is 503 `unknown`. In both, the file stays in the trash.
- "Restored" is decided by the link. `visible` is reported separately: up to three looks at the restored file, 250 ms apart, waiting only on `EINVAL` (see the probe findings).

## Races

- **Delete against a send.** Every send path (`/api/print`, both queue-add routes, the slicer's file-path send) takes a per-file hold on its file synchronously, before its first file-dependent await (the existence check, the hash), and keeps it until its request handler has finished (`withGcodeHolds`). By then it has recorded itself as an upload job, a waiting send or a queue item, which `gcodeFileInUse` sees for as long as the file is needed. A delete takes its reservation in the same synchronous step as its last in-use check. A delete refuses a held file; a send refuses a file being deleted. The hold is released when the handler finishes, never when the HTTP response closes: a client that hangs up mid-hash leaves the handler running. A test follows every hold to its route and requires the wrapper.
- **A reservation whose rename timed out** is kept for 10 minutes: the rename may still happen on the share.
- **Waiting sends or queue unreadable:** every delete is refused, since a reference that can't be seen may exist.
- **Permanent delete against another program.** The worker removes the file only if its identity is unchanged: size, modified and change times in nanoseconds, inode and device (`netfs.identity`, BigInt-exact).

## NAS findings (2026-11-05)

Probed on a NAS share, an SMB 3.0 mount without Unix extensions, in a temporary folder that was removed afterwards:

- Hard links work. Linking onto an existing name is refused with `EEXIST` and leaves that file untouched. In 40 rounds of two processes linking onto one new name, exactly one won each time and its content stayed.
- Exclusive create works. Rename onto an existing name replaces it.
- 40 ordinary restores (link, then unlink, in one worker thread) were readable at once from another thread, another process and a listing. `EINVAL` on the first read appeared only right after a link that lost a race for the same name, and cleared within about 1.5 s.
- A file replaced by another of the same size and modified time kept both; only its inode changed. The share's inodes are 64-bit server file ids, beyond JavaScript's exact integer range: compared as strings, never as numbers.
- `open()` then `fstat()` agreed with `lstat()`. From a single client, opening could not be shown to bypass the mount's 1-second attribute cache, so nothing relies on it.

## Remaining risks

Inherent to other SMB clients using the share at the same time:

1. A change another client made within about the last second may not be visible to any check on this mount (its attribute cache).
2. A change in the instant between permanent delete's identity check and the removal: the removal is by path, and Linux user space has no "delete only if it is still this file".
3. A file open in another program: a permanent delete either removes it (that program keeps its open copy) or fails with a sharing error, which is reported.
4. The no-overwrite refusal was tested from one client only. Two different SMB clients creating the same name at the same instant were not tested.

Not checked: whether the NAS keeps permanently deleted files in its own recycle bin. The wording only promises "can't be restored through SnapCon".

SnapCon's own writers: Upload never overwrites (exclusive create). Sync downloads rename over their target; if a Sync folder is inside the G-code folder, a permanent delete's identity check catches a file Sync replaced.

## Follow-ups

1. **Restore screen.** A trash view: deletions newest first, who and when, days left, per-file Restore and "Restore all from this deletion". It uses the existing routes and their answers (409, 501, 503, 507), and refreshes after a restore whose `visible` is false. Restore is audited `file-restored`.
2. **30-day purge, only after the restore screen and retention are proven.** Purge whole deletions whose `expiresAt` has passed (from the manifest, or the batch name's time when the manifest is missing), files first, then the empty folders; never anything outside `.snapcon-trash/`. Through netfs's background lane, one deletion at a time, stopping when the share stops answering; audited. Consider an Admin "Empty trash now" with a named confirmation.
3. **Smaller.**
   - Server refusal reasons are English only, like Move's.
   - The trash takes NAS space until the purge exists; the trash view could show its size.
   - On Windows with 8.3 short names enabled, a short-name spelling of the trash folder is not recognised.
   - The path rules are lexical (`pathSafety.js`): a link planted in the G-code folder from outside SnapCon is not followed or blocked.
   - Text built in code (the dialog's title and buttons, "Delete N files") changes language at the next open after a language switch.

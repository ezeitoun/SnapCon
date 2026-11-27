# Queue store: recovery, reset and rollback

How SnapCon's queue file (`data/queue-data.json`) behaves when it cannot be
loaded, what a reset does, and how to roll back or forward without losing
queue data. Applies from the queue durability fix onward.

Three things to keep in mind throughout:

- **A reset is destructive and is the owner's decision.** It starts every
  printer's queue empty. Nothing here requires a reset as a routine step —
  not a rollback, not a roll-forward.
- **Queue Management being off does not make the queue read-only.** The
  switch only stops automatic dispatch. Adding, moving and removing queue
  items, pause/resume/stop, clearing a queue, confirming a cleared bed and
  changing a printer's pool all still work and all save the queue file.
  What blocks them is the queue store itself refusing — while recovery is
  required, while a save is failing (degraded) and while an admin has
  stopped all queues (see the table below) — never the switch.
- **Files set aside are never deleted or written over.** Each keeps its bytes
  under a new name in `data/`; removing them is always a manual act. The one
  file SnapCon does delete is `queue-data.json.tmp` (an interrupted save)
  when it starts and finds a valid `queue-data.json` beside it; older builds
  delete it at every start.

## Files in `data/`

| Name | What it is |
|---|---|
| `queue-data.json` | The queue (primary). |
| `queue-data.json.bak` | The previous generation, copied before each save. |
| `queue-data.json.tmp` | A save in progress. Left behind only by an interrupted save. Deleted at start-up when `queue-data.json` is valid and there is no recovery marker. Left untouched when a queue file could not be read and there is no recovery marker. Otherwise kept as `.tmp.leftover-<time>`. |
| `queue-data.json.recovery-required` | The **recovery marker**. While it exists, SnapCon loads no queue file and saves none. |
| `queue-data.json.corrupt-<time>`, `queue-data.json.bak.corrupt-<time>` | Files that were not valid queue files, kept as found. |
| `queue-data.json.before-reset-<time>`, `queue-data.json.bak.before-reset-<time>` | Files that were in place when a reset was acknowledged. |
| `queue-data.json.tmp.leftover-<time>` | An interrupted save found while the primary was missing or not valid: kept, never loaded. |

A `-1`, `-2`… suffix means a file of that name already existed; nothing is
ever written over a kept file.

## States, and what clears each

`GET /api/queue-store/status` (and Settings → Queue Management) reports them.

| State | Meaning | What still works | How it clears |
|---|---|---|---|
| Recovery required (`queueStoreRecoveryRequired`) | No valid queue file could be loaded, or the marker is present. Memory holds an empty placeholder. | Reading. Every queue change is refused; nothing is saved; G-code files a queue might reference cannot be deleted. | An acknowledged reset, or the manual adoption below. Survives restarts. |
| Unreadable (`saveBlocked: "unreadable"`) | A queue file exists but could not be read (permissions, I/O). It is not known to be damaged. | As above. Reset is refused. | Fix the permissions or the disk, then restart SnapCon. |
| Degraded (`storeDegraded`) | A save failed. Memory is ahead of the file. | Reading. Every manual queue change is refused until a save succeeds. | Automatically (retry every 15 s) or Settings → Retry save. |
| Stopped (`storeStoppedByAdmin`) | An admin stopped all queues. | Reading. No dispatch, and every manual queue change is refused. | Settings → Resume all queues, or a restart. |

Switching Queue Management on and changing a printer's pool are refused
(503) in every one of these states.

## What a reset does

Typing RESET in Settings → Queue Management (or `POST
/api/queue-store/acknowledge-reset`) runs four steps, each flushed to disk
before the next:

1. The recovery marker is made durable (written now, if there was none).
2. `queue-data.json.bak`, then `queue-data.json`, are moved to
   `…before-reset-<time>`.
3. An empty `queue-data.json` is written.
4. The marker is removed.

If a step fails, the answer is an error (`queue_reset_incomplete`), never
success; recovery is required in the running SnapCon from that moment, no
file has been written over, and the reset can be asked for again once the
cause is fixed. What a restart then finds depends on the step:

| Failed or stopped at | After a restart |
|---|---|
| Step 1, marker file never created (ordinary reset only) | Refused as "nothing was changed" (`queue_store_save_blocked`): the queue is as it was, also after a restart. |
| Step 1, marker written but not confirmed on disk | Recovery required if the marker survived; otherwise the queue as it was before the reset (the current one, never an older one). The answer says so. |
| Steps 2 and 3 | Recovery required. No queue file is loaded. |
| Step 4, marker could not be removed, or SnapCon stopped before it | Recovery required, with the empty queue file in place: the reset has to be acknowledged once more. |
| Step 4, marker removed but the removal not confirmed on disk | Recovery required (marker survived) or an empty queue (it did not). |

In none of these is an older queue — the one being reset after the reset
began, or the backup's — loaded as live.

A reset is refused outright, with nothing changed, while a queue file is
unreadable, while a corrupt `queue-data.json` is still in place beside the
good backup it was recovered from, or while an interrupted save cannot be
moved aside.

## Using a queue file that is in place instead of resetting ("adoption")

There is no button for this; it is a manual procedure because it decides
which queue becomes live. Use it when a valid queue file is in `data/`
beside the marker — restored from a backup, or written by an older SnapCon
during a rollback — and that queue should be kept.

1. Stop SnapCon.
2. Copy every `data/queue-data.json*` file somewhere outside `data/`, and
   record checksums. This copy is the way back.
3. Validate the candidate `data/queue-data.json`:
   - it parses as JSON and its top level is an object keyed by printer id;
   - every id is a printer in `config.json`;
   - each entry has a `queueState` and a `queue` list;
   - you know which run wrote it and when. A file older than the last
     prints can list jobs that have already been printed: compare each
     printer's current and queued items with what was actually printed, and
     with the printer itself, before trusting it.
4. Move `data/queue-data.json.bak` out of `data/` unless you have checked
   that it is the generation just before the candidate (the next save
   writes a fresh one). This matters: if the candidate turns out not to be
   valid and a valid backup is in place, SnapCon loads the **backup** as the
   live queue and rewrites the primary from it, without asking.
5. Move the marker out of `data/` (keep it with the copy from step 2).
6. Start SnapCon with Queue Management **off** (it is off if it was off
   when SnapCon stopped; otherwise set `queueManagement.enabled` to `false`
   in `config.json` before starting). Check the status: recovery
   not required, not degraded, `saveBlocked` null. Look at every printer's
   queue. Remember that manual queue actions already save from this point.
7. Only then decide whether to switch Queue Management on.

If the candidate is not a valid queue file and no valid backup is in place
(step 4), SnapCon re-enters recovery by itself at step 6: new marker, files
kept under `.corrupt-` names. If validation in step 3 fails, do not adopt:
leave the marker, and treat a reset as the separate decision it is.

## Rolling back to a SnapCon from before this fix

Older builds do not know the marker or the `.before-reset-` / `.leftover-`
names, and behave as before the fix:

- no marker awareness: with the marker present and no queue file, an older
  build sees a first run and starts with an **empty queue**, without that
  having been acknowledged by anyone;
- with the marker present and a **valid** `queue-data.json` (or a valid
  backup) in place, it loads that file as the live queue. That is the case
  after a reset that stopped at its first step, after a file was restored by
  hand, and on a second rollback (the file the first one wrote);
- with invalid queue files still in place, it sets them aside under
  `.corrupt-<time>` names and requires its own (in-memory) recovery, which
  a second restart silently drops;
- any manual queue action, and any observed print event on a managed
  printer, then writes `queue-data.json` — with Queue Management off as
  well;
- it deletes `queue-data.json.tmp` at every start.

So, when the marker exists (or a reset is half-done), roll back like this:

1. Before stopping, if Queue Management is on and should not dispatch
   under the older build, switch it off in Settings (it is the
   `queueManagement.enabled` setting in `config.json`; the older build reads
   the same setting). Switching it on is refused while recovery is required,
   so it is normally off already. Then stop SnapCon.
2. Copy every `data/queue-data.json*` file, marker included, outside
   `data/`, with checksums. The older build deletes a `queue-data.json.tmp`
   it finds, and its names for kept files can sit beside the newer ones.
3. Leave the marker in `data/`. The older build ignores it; the newer one
   needs it on the way back.
4. Do **not** reset first. A reset is not a prerequisite for rolling back.
5. Start the older build and know what it is doing. Look at `data/` first:
   with no `queue-data.json` and no valid backup it runs with an empty
   queue; with a valid one in place it runs with **that** queue. Either
   way, whatever is done to queues in that time (manually or by print
   events) is saved to `queue-data.json`, Queue Management on or off. If
   the queue it would load is not one you want live, move those files out
   of `data/` (they are in the copy from step 2) before starting.

When there is no marker and the store is healthy, rolling back needs
nothing special: the queue file format is unchanged.

## Rolling forward again

With the marker still in `data/`, the newer build starts in recovery
required and does not use the queue file the older build wrote. That is
deliberate: nobody has yet decided which queue is the real one. Then either

- adopt the older build's file with the procedure above, if the work done
  during the rollback should be kept; or
- acknowledge a reset, if it should not. The file is kept as
  `queue-data.json.before-reset-<time>`.

## Settings saved together with the queue

Changing a printer's pool and switching Queue Management on or off change
`config.json` and (except switching off) the queue file. `config.json` is
replaced as a whole for these three actions (temporary file, flush, rename,
folder flush), and they are refused with 409 while `config.json` could not
be read at start-up.

| Answer | What happened |
|---|---|
| `config_save_failed` | `config.json` on disk is unchanged; memory and the queue were put back. |
| `config_save_not_durable` | The change **was made** everywhere, but the file could not be confirmed as safely stored. Check it after the next restart. |
| `pool_change_incomplete`, `queue_enable_incomplete` | The settings were put back but the queue could not be: the queue file has the change, `config.json` does not. Repeat the action once the disk works. |

### Where `config.json` is a single mounted file (Docker)

These three actions never write `config.json` where it is; they only ever
replace it with a complete new file. Where that replacement is refused —
`config.json` is itself a mount point, as with the single-file bind mount
older `docker-compose.yml` files used (`./config.json:/app/config.json`) —
**the action fails every time** with `config_save_failed` and the file is
untouched. On Docker Engine on Linux the refusal is `EBUSY` (observed);
`EXDEV` is treated the same way, and for those two the message also says
that `config.json` cannot be replaced where it is and names the migration
guide. With any other code the action fails the same way without that
explanation. SnapCon also says so once in the log at start-up.

**The supported layout mounts the folder that holds `config.json`** and
names it with `SNAPCON_CONFIG_DIR`, as the current `docker-compose.yml`
does. There the three actions save normally. Moving an existing
installation, and the cases in which SnapCon refuses to start rather than
run on default settings: `docs/docker-config-migration.md`.

Until an installation is moved:

- changing a printer's pool, and switching Queue Management on or off,
  cannot be done from SnapCon;
- that includes switching Queue Management **off**. Switching it off is
  the one change that can be made fully by hand: stop SnapCon, set
  `queueManagement.enabled` to `false` in `config.json`, and start it
  again. Wherever this document says to switch Queue Management off in
  Settings (rollback step 1) or to start with it off (adoption step 6), do
  it this way;
- switching it **on**, and changing a printer's pool, cannot be done by
  editing `config.json` alone. Each also changes the printer's state in the
  queue file, nothing brings the two into line at start-up, and a pool id
  added by hand skips the checks SnapCon makes (a printer given a pool by
  hand accepts queue items that are then never dispatched). Move to the
  settings folder to make these two changes;
- a `pool_change_incomplete` or `queue_enable_incomplete` answer cannot be
  put right by repeating the action there: the queue file has the change and
  `config.json` does not, until `config.json` is edited by hand to match;
- every other setting saves as before (those are still written in place);
- nothing is changed automatically to work around it: SnapCon never falls
  back to writing `config.json` in place for these actions.

Other side effects of replacing the file, for these three actions only: the
folder holding `config.json` must be writable, not just the file; the new
file keeps the old one's permissions, and its owner and group where SnapCon
is allowed to set them (otherwise it belongs to the user SnapCon runs as);
and a read-only `config.json` is not replaced.

## What has not been verified

- A real power loss. The ordering is tested against a filesystem *model*
  (including name changes that survive out of order), not against hardware.
- Storage that ignores flush requests.
- Windows and macOS (not run). On Windows a folder cannot be flushed, so a
  completed save, the marker and a reset's steps are not guaranteed to
  survive a sudden power loss — there, and on any filesystem that does not
  support a folder flush, the guarantee that an old queue cannot come back
  after a reset does not hold across a power loss. On Windows a
  `config.json` briefly held open by another program makes these three
  actions fail (file unchanged) rather than wait.
- Docker Desktop, rootless Docker, a container run as a non-root user, and
  NFS, CIFS and FUSE volumes. (Docker Engine on Linux with a local bind
  mount was tested for real, both layouts: `docs/docker-config-migration.md`.)

# Docker: `config.json` now lives in a mounted settings folder

Applies to SnapCon run with Docker only. Installations run with `npm start`
or a packaged executable are not affected: `config.json` stays beside the
application, as before.

## What changed, and why

Older `docker-compose.yml` files mounted `config.json` into the container as
a single file:

```yaml
- ./config.json:/app/config.json
```

Three actions — switching Queue Management on, switching it off, and
changing a printer's pool — save `config.json` by writing a complete new
file and renaming it into place, so that a crash or power cut in the middle
cannot leave a half-written settings file. A file that is itself a mount
point cannot be replaced that way, so on the old layout those three actions
fail every time ("the settings could not be saved … cannot be replaced where
it is"), and `config.json` is left exactly as it was. Every other setting
still saves on the old layout.

The current `docker-compose.yml` mounts a **folder** instead and tells
SnapCon where it is:

```yaml
environment:
  SNAPCON_CONFIG_DIR: /app/config
volumes:
  - ./config:/app/config
```

`config.json` is then `./config/config.json` on the host. Only `config.json`
moves. `users.json`, `data/`, `gcode/` and every other mount are unchanged.

## Do I have to migrate?

- **You do not use Queue Management or printer pools:** nothing breaks if
  you stay on the old compose file. SnapCon logs one line at start-up saying
  that `config.json` is mounted as a single file.
- **You do:** migrate, or those three actions cannot be saved from SnapCon.

An image update alone changes nothing: the image does not set
`SNAPCON_CONFIG_DIR`, so a container started from the old compose file keeps
reading `/app/config.json`.

## Migrating an existing installation

Run these in the folder that holds your `docker-compose.yml`.

1. Stop SnapCon:
   ```bash
   docker compose down
   ```
2. Copy the settings into a new folder (a copy: the original stays where it
   is as your backup; `-p` keeps its owner and permissions):
   ```bash
   mkdir -p config
   cp -p config.json config/config.json
   ```
3. Update `docker-compose.yml`: replace the line
   `- ./config.json:/app/config.json` with `- ./config:/app/config`, and add
   the `environment:` block shown above. (Or take the new file from the
   repository and re-apply your own changes, such as extra Library mounts.)
4. Start SnapCon:
   ```bash
   docker compose up -d
   docker compose logs snapcon
   ```
   The start-up lines show `Config:   /app/config/config.json`.
5. Check that your printers are listed and, if you use user accounts, that
   SnapCon still asks you to sign in. Then, when you are satisfied, you can
   remove the old `./config.json`. Nothing reads it any more.

To go back: `docker compose down`, restore the old compose file, start
again. The old `./config.json` is as you left it at step 2; changes made
after the migration are in `./config/config.json` only.

## If SnapCon refuses to start

With a settings folder, SnapCon stops at start-up (exit code 78, with the
reason in `docker compose logs`) rather than run on default settings, in
these cases. Default settings have user accounts switched off, so starting
anyway could open an installation that required sign-in.

| The log says | Cause | What to do |
|---|---|---|
| "The settings file … cannot be used: …" | `config/config.json` is there but is not a usable settings file: cut short or otherwise not valid JSON, empty, not a settings object, a folder (Docker makes one when the file it was told to mount does not exist), a link to nothing, or not readable. | See "Recovering from an unusable `config.json`" below. SnapCon leaves the file exactly as it found it. |
| "…there is one at the old place" | The folder has no `config.json`, and the old single-file mount is still there. | Step 2 above, and remove the old mount line. |
| "…this installation has been used before: found …" | The folder has no `config.json`, but there are user accounts, a queue file or a Remote Access identity. | Step 2 above. |
| "…that folder cannot be used" | `SNAPCON_CONFIG_DIR` is set but the folder is not mounted. | Add the `./config:/app/config` mount. SnapCon never creates the folder itself: a folder made inside the container is lost with the container. |
| "…is not writable" | The folder cannot be written by the container. | Fix its permissions on the host. |

With `restart: unless-stopped`, Docker starts the container again each time
it stops, so `docker compose ps` shows it restarting until this is fixed.

**Starting from scratch on purpose** on an installation that has been used:
put a `config.json` containing `{}` in the folder. That is an explicit
"start with defaults".

### Recovering from an unusable `config.json`

On the settings-folder layout SnapCon never starts on a `config.json` it
cannot use, and never renames, moves or rewrites it: what you find in
`./config` is what was there.

1. `docker compose down` (otherwise the container keeps restarting).
2. Keep the broken file for reference:
   `mv config/config.json config/config.json.broken` (for a folder or a
   link of that name, the same command works).
3. Put a good file in its place, whichever you have:
   - the original from before the move, still at `./config.json` if you
     have not removed it: `cp -p config.json config/config.json`;
   - a backup of your own;
   - a copy SnapCon set aside earlier on the old layout
     (`config.json.corrupt-<time>` is a *broken* file kept as found, so it
     helps only as something to repair by hand).
4. Check it is valid before starting, for example
   `python3 -m json.tool config/config.json > /dev/null && echo ok`.
5. `docker compose up -d`, then check the log, your printers and that
   sign-in is still required.

If no good copy exists, the choices are repairing the file by hand (it is
plain JSON) or starting from scratch with `{}`. Starting from scratch
switches user accounts off until you switch them on again in Settings; your
accounts in `users.json` are not deleted.

## A new installation

Follow the quick start at the top of `docker-compose.yml`. An empty `config`
folder on an installation with no user accounts, no queue file and no Remote
Access identity is a normal first run: SnapCon starts with defaults and
creates `config/config.json`.

## Good to know

- SnapCon needs to write in the settings folder, not only to `config.json`:
  a new file is written beside it (`config.json.tmp`) and renamed.
- When `config.json` is replaced, the new file keeps the old one's
  permissions, and its owner and group where SnapCon is allowed to set them
  (it is when the container runs as root, the image's default).
- This is stricter than an installation without a settings folder, which
  starts on default settings with a warning when `config.json` cannot be
  read and sets the broken file aside as `config.json.corrupt-<time>`. That
  behaviour is unchanged there.
- While SnapCon is running, if `config.json` cannot be read back after a
  save, SnapCon keeps the settings it has in memory instead of taking
  defaults, does not set the file aside, logs the reason, and shows the
  "settings could not be read" warning in Settings. This is not a write
  lock. Queue Management on and off, pool changes and the automatic
  settings upgrades refuse to write in that state, but most Settings saves
  still write the file, and the save that hit the problem can still report
  success. If you see the warning, check the log and `config.json` before
  changing anything else.
- The command-line mode (`node server.js --load …`, including through
  `docker exec`) reads the same folder and refuses to run in the same cases.
- `SNAPCON_CONFIG_DIR` also works outside Docker, but nothing needs it
  there.

## What was tested, and what was not

Tested on Docker Engine on Linux with a local bind mount, synthetic settings
and placeholder printers: the old layout failing safely; the refusals above,
including an installation with sign-in switched on whose copied
`config.json` was cut short, empty, not a settings object, a folder or a
link to nothing (never started, file untouched, recovered as described); a
migrated installation keeping its printers, pools and sign-in; Queue
Management on and off and a pool change saving and surviving the container
being removed and created again; a new installation.

Not tested: Docker Desktop on macOS or Windows, settings folders on NFS, CIFS
or FUSE volumes, rootless Docker, a container run as a non-root user, and a
real power loss.

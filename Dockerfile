# SnapCon — small runtime image for always-on hosts (Raspberry Pi, NAS,
# homelab boxes). Runs the same Node/Express server as the desktop builds.
FROM node:22-alpine

WORKDIR /app

# The container only needs the runtime dependency (express). @yao-pkg/pkg is a
# build-time-only tool CI uses to make the desktop binaries, so drop it here to
# keep the image small.
COPY package.json ./
RUN npm pkg delete devDependencies \
 && npm install --omit=dev \
 && npm cache clean --force

# App source. server.js requires all of these at startup (auth.js,
# connectors/, remote-access/) — a COPY list that only covers server.js/
# parser.js/public/ builds fine but crashes immediately on
# `Error: Cannot find module './auth'` the moment the container actually
# runs. Keep this in sync with server.js's top-of-file require() list as new
# top-level modules are added.
COPY server.js parser.js threemf.js auth.js groupAccess.js configLoader.js notifyToken.js notifyCli.js pathSafety.js fileTrash.js fleetProbe.js locales.js webhookNotify.js updateCheck.js ./
COPY connectors ./connectors
COPY remote-access ./remote-access
COPY audit ./audit
COPY utilization ./utilization
COPY sync ./sync
COPY queue ./queue
COPY transfers ./transfers
COPY library ./library
COPY netfs ./netfs
COPY routes ./routes
# The Virtual U1 printer type's simulator (connectors/virtual-u1.js).
COPY fixtures/virtual-u1 ./fixtures/virtual-u1
COPY public ./public
# Bundled canonical locale originals (en.json + the shipped sample) — read
# via fs, not require(), so docker.test.js's require()-graph check can't
# catch a missing COPY here the way it does for locales.js above; seeded
# into the writable runtime locales/ directory on first run (see
# locales.seedDefaultLocales in server.js) and never overwritten after that.
COPY locales-default ./locales-default
# Third-party notices (the theme icons, the bundled font). Their licences ask
# for the notice to go with every copy, so it is in the image, and server.js
# serves it at /THIRD_PARTY_NOTICES.md.
COPY THIRD_PARTY_NOTICES.md ./

# The settings folder (config/, holding config.json — SNAPCON_CONFIG_DIR) and
# gcode/ are expected to be mounted as volumes (see docker-compose.yml). The
# server creates sane defaults on a first run. SNAPCON_CONFIG_DIR is set in
# docker-compose.yml and deliberately NOT here: an installation still using
# an older compose file (config.json mounted as a single file at
# /app/config.json) must keep reading that file after an image update.
EXPOSE 4545
CMD ["node", "server.js"]

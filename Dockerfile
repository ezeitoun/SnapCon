# SnapCon — small runtime image for always-on hosts (Raspberry Pi, NAS,
# homelab boxes). Runs the same Node/Express server as the desktop builds.
#
#   docker build -t snapcon .                               # with ffmpeg
#   docker build -t snapcon --build-arg WITH_FFMPEG=false . # smaller, no ffmpeg
FROM node:22-alpine

# tzdata: log and audit timestamps in local time when TZ is set (e.g.
# TZ=Europe/Berlin). ffmpeg (optional, on by default): turns the relayed
# camera of Bambu Lab printers into still frames for the camera snapshot and
# notification images — the live view itself plays without it. Everything
# else in SnapCon works the same with WITH_FFMPEG=false (a much smaller image).
ARG WITH_FFMPEG=true
RUN apk add --no-cache tzdata \
 && if [ "$WITH_FFMPEG" = "true" ]; then apk add --no-cache ffmpeg; fi

ENV NODE_ENV=production

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
COPY server.js parser.js auth.js groupAccess.js configLoader.js notifyToken.js pathSafety.js locales.js webhookNotify.js ./
COPY connectors ./connectors
COPY remote-access ./remote-access
COPY audit ./audit
COPY sync ./sync
COPY queue ./queue
COPY public ./public
# Bundled canonical locale originals (en.json + the shipped sample) — read
# via fs, not require(), so docker.test.js's require()-graph check can't
# catch a missing COPY here the way it does for locales.js above; seeded
# into the writable runtime locales/ directory on first run (see
# locales.seedDefaultLocales in server.js) and never overwritten after that.
COPY locales-default ./locales-default
COPY docker/healthcheck.js ./docker/healthcheck.js

# config.json and gcode/ are expected to be mounted as volumes (see
# docker-compose.yml). The server creates sane defaults if they're absent.
# Alternatively set SNAPCON_DATA_DIR=/data and mount a single volume there:
# every writable file then lives in that one directory.
EXPOSE 4545

# "healthy" once the dashboard answers on the port config.json sets.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "docker/healthcheck.js"]

CMD ["node", "server.js"]

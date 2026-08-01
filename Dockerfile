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
COPY server.js parser.js auth.js ./
COPY connectors ./connectors
COPY remote-access ./remote-access
COPY public ./public

# config.json and gcode/ are expected to be mounted as volumes (see
# docker-compose.yml). The server creates sane defaults if they're absent.
EXPOSE 4545
CMD ["node", "server.js"]

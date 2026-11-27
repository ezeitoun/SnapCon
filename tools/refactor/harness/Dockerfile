# tools/refactor/harness/Dockerfile — the isolated contract-harness image.
# Base pinned by digest (node:22-alpine, the production Dockerfile's base).
# The ONLY step with network is the build's `npm ci` of the app's own lock
# file (express); every harness run uses --network none.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /deps
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm
COPY harness/ /harness/
USER node

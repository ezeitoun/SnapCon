# SnapCon Home Assistant add-on image. The Supervisor builds it on the Home
# Assistant host, with this folder as the build context.
ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM}

ARG SNAPCON_REPO=https://github.com/jschallmayer78/SnapCon.git
ARG SNAPCON_REF=main

# tzdata: the Supervisor passes Home Assistant's time zone as TZ.
# ffmpeg: still frames from Bambu Lab cameras (snapshots, notification images).
RUN apk add --no-cache tzdata ffmpeg

COPY . /addon

# The app comes from app/ when this is a prepared local add-on, otherwise
# from the GitHub repository at SNAPCON_REF.
RUN set -e; \
    if [ -f /addon/app/server.js ]; then \
      cp -a /addon/app /app; \
    else \
      apk add --no-cache --virtual .fetch git; \
      git clone --depth 1 --branch "$SNAPCON_REF" "$SNAPCON_REPO" /app; \
      apk del .fetch; \
    fi; \
    cd /app; \
    rm -rf .git .github test docs fixtures ha-addon node_modules; \
    npm pkg delete devDependencies; \
    npm install --omit=dev; \
    npm cache clean --force; \
    install -m 755 /addon/run.sh /run.sh; \
    rm -rf /addon

ENV NODE_ENV=production \
    SNAPCON_DATA_DIR=/data

WORKDIR /app
CMD ["/run.sh"]

LABEL io.hass.type="addon" \
      io.hass.name="SnapCon" \
      io.hass.description="Fleet dashboard for Snapmaker U1 and Bambu Lab H2 3D printers"

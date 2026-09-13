# The Sprint 1 probe. Workshop issue #14.
#
# Replaces the nginx placeholder because a static server cannot hold a
# connection, and issues #15 and #16 are about what happens to connections.
# Still serves web/ so the uptime check and the placeholder page keep working.
#
# DISPOSABLE. Not a decision about the runtime -- see server/index.js.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a change to the source does not reinstall them.
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY web/ ./web/

ENV PORT=80 WEB_ROOT=/app/web
EXPOSE 80

# wget is in busybox on alpine, so the healthcheck needs nothing installed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz | grep -q ok || exit 1

CMD ["node", "server/index.js"]

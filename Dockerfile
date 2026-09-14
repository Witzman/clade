# The game server. Workshop issues #25, #27; technical plan §8.3.
#
# One image, one Node process: static files for every page, /healthz, and the
# WebSocket at /ws. The server runs its TypeScript unbuilt (Node 22 strips
# types); only browser code is bundled.

# ---- web: esbuild turns every web/**/main.ts (with core/, render/ and the
# server's shared test-room rules) into main.js beside it, and copies the
# credited assets under web/ so the static server can reach them. A separate
# stage, so the dev dependencies never reach the running image.
FROM node:22-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:web

# ---- runtime: `ws` is the only dependency
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY core/ ./core/
COPY server/ ./server/
COPY --from=web /build/web/ ./web/

ENV PORT=80 WEB_ROOT=/app/web MAX_WS=100
EXPOSE 80

# wget is in busybox on alpine, so the healthcheck needs nothing installed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz | grep -q ok || exit 1

# exec form, so node is PID 1 and receives Docker's SIGTERM on a redeploy.
CMD ["node", "server/main.ts"]

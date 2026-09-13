# Placeholder image. It exists to prove the deployment chain end to end
# before any game code is written: push -> webhook -> Dokploy build -> live.
#
# It commits to no runtime. The server language is still an open question in
# notes/specs/2026-09-13-foundation-design.md, and nothing here presumes it.
FROM nginx:1.27-alpine

COPY web/ /usr/share/nginx/html/

# /healthz answers 200 with a body of "ok" so a container healthcheck and an
# uptime probe have something cheap to hit that does not render the page.
RUN printf '%s\n' \
    'server {' \
    '  listen 80;' \
    '  root /usr/share/nginx/html;' \
    '  location = /healthz { default_type text/plain; }' \
    '}' > /etc/nginx/conf.d/default.conf

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz | grep -q ok || exit 1

EXPOSE 80

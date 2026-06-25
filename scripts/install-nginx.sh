#!/usr/bin/env bash
# Install nginx as the front door for Remi (port 80 → 127.0.0.1:6120).
#
# Idempotent — safe to re-run. Does the minimum:
#   1. Install nginx if missing (Debian/Ubuntu)
#   2. Drop scripts/nginx-remi.conf into /etc/nginx/sites-available/remi
#   3. Symlink into sites-enabled, disable the default site
#   4. Validate config, reload nginx
#   5. Smoke-test: curl http://localhost/ and ensure it reaches Remi
#
# Run as root:   sudo bash scripts/install-nginx.sh
# Uninstall:     sudo bash scripts/uninstall-nginx.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_SRC="${SCRIPT_DIR}/nginx-remi.conf"
CONF_DST="/etc/nginx/sites-available/remi"
LINK_DST="/etc/nginx/sites-enabled/remi"
DEFAULT_LINK="/etc/nginx/sites-enabled/default"

REMI_PORT="${REMI_WEB_PORT:-6120}"

log()  { printf "\033[1;34m[install-nginx]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ok]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "must be run as root (try: sudo bash $0)"
[[ -f "$CONF_SRC" ]]   || die "config not found: $CONF_SRC"

# ── 1. Install nginx ──────────────────────────────────────────
if ! command -v nginx >/dev/null 2>&1; then
    log "nginx not installed — installing via apt"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
    ok "nginx installed: $(nginx -v 2>&1)"
else
    ok "nginx already installed: $(nginx -v 2>&1)"
fi

# ── 2. Sanity-check Remi is listening (warn only, don't block) ──
if ss -lnt 2>/dev/null | grep -q ":${REMI_PORT} "; then
    ok "Remi web detected on :${REMI_PORT}"
else
    warn "nothing listening on :${REMI_PORT} — nginx will install anyway,"
    warn "but you'll get 502 until Remi is started."
fi

# ── 3. Drop config ───────────────────────────────────────────
log "writing $CONF_DST"
install -m 644 "$CONF_SRC" "$CONF_DST"

if [[ ! -L "$LINK_DST" ]]; then
    ln -s "$CONF_DST" "$LINK_DST"
    ok  "enabled site → $LINK_DST"
else
    ok  "site already enabled"
fi

if [[ -L "$DEFAULT_LINK" ]]; then
    rm -f "$DEFAULT_LINK"
    ok  "disabled default site"
fi

# ── 4. Validate + reload ─────────────────────────────────────
log "validating nginx config"
nginx -t

log "reloading nginx"
if systemctl is-active --quiet nginx; then
    systemctl reload nginx
else
    systemctl enable --now nginx
fi
ok "nginx reloaded"

# ── 5. Smoke test ────────────────────────────────────────────
log "smoke test: curl http://localhost/"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost/ || true)"
case "$HTTP_CODE" in
    200|301|302|401)
        ok "HTTP $HTTP_CODE — nginx is forwarding to Remi"
        ;;
    502)
        warn "HTTP 502 — nginx running, but Remi (:${REMI_PORT}) not responding"
        warn "  start Remi:  bun run src/remi/admin/server.ts"
        ;;
    000)
        die "HTTP 000 — nginx didn't respond. Check: systemctl status nginx"
        ;;
    *)
        warn "unexpected HTTP $HTTP_CODE — investigate"
        ;;
esac

# ── 6. Next steps ────────────────────────────────────────────
cat <<EOF

╭──────────────────────────────────────────────────────────────╮
│ nginx installed. Remi reachable at:                          │
│   http://$(hostname)/                                        │
│                                                              │
│ One-time SSO chore: register the new callback URL in your    │
│ identity provider (Google Cloud Console for Google):         │
│   http://$(hostname)/api/auth/sso/google/callback           │
│                                                              │
│ Files installed:                                             │
│   $CONF_DST                          │
│   $LINK_DST                              │
│                                                              │
│ To remove: sudo bash scripts/uninstall-nginx.sh              │
╰──────────────────────────────────────────────────────────────╯
EOF

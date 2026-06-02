#!/usr/bin/env bash
# Reverse of install-nginx.sh — removes Remi's nginx config.
# Leaves nginx itself installed; user can `apt remove nginx` if desired.
#
# Run as root:   sudo bash scripts/uninstall-nginx.sh

set -euo pipefail

CONF_DST="/etc/nginx/sites-available/remi"
LINK_DST="/etc/nginx/sites-enabled/remi"
DEFAULT_AVAIL="/etc/nginx/sites-available/default"
DEFAULT_LINK="/etc/nginx/sites-enabled/default"

log()  { printf "\033[1;34m[uninstall-nginx]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ok]\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "must be run as root (try: sudo bash $0)"

if [[ -L "$LINK_DST" ]]; then
    rm -f "$LINK_DST"
    ok "removed $LINK_DST"
fi

if [[ -f "$CONF_DST" ]]; then
    rm -f "$CONF_DST"
    ok "removed $CONF_DST"
fi

# Re-enable default site if it existed
if [[ -f "$DEFAULT_AVAIL" && ! -L "$DEFAULT_LINK" ]]; then
    ln -s "$DEFAULT_AVAIL" "$DEFAULT_LINK"
    ok "restored default site"
fi

if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    log "validating + reloading nginx"
    nginx -t
    systemctl reload nginx
    ok "nginx reloaded"
fi

cat <<EOF

╭───────────────────────────────────────────────────────────╮
│ Remi nginx config removed.                                │
│ nginx itself is still installed. If you want to remove    │
│ it entirely:                                              │
│   sudo systemctl disable --now nginx                      │
│   sudo apt remove --purge nginx                           │
╰───────────────────────────────────────────────────────────╯
EOF

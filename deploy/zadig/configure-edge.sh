#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${SCRIPT_DIR}/versions.env"

ZADIG_SITE="/etc/nginx/sites-available/zadig-ci"
ZADIG_SITE_LINK="/etc/nginx/sites-enabled/zadig-ci"
REDIRECT_SNIPPET="/etc/nginx/snippets/zadig-ci-redirect.conf"
MULTIREMI_SITE="/etc/nginx/sites-available/remi"
BACKUP_DIR="${ZADIG_ROOT}/backups"

log() { printf '[zadig-edge] %s\n' "$*"; }
die() { printf '[zadig-edge] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "run as root: sudo bash ${SCRIPT_DIR}/configure-edge.sh"
[[ "${ZADIG_ROOT}" == /data00/multiremi/zadig ]] || die "unexpected ZADIG_ROOT: ${ZADIG_ROOT}"
[[ "${ZADIG_PUBLIC_HOST}" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid public host"
[[ "${ZADIG_PUBLIC_PORT}" =~ ^[0-9]+$ ]] || die "invalid public port"
[[ -f "${MULTIREMI_SITE}" && ! -L "${MULTIREMI_SITE}" ]] || die "unexpected Multiremi Nginx site"

install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/snippets "${BACKUP_DIR}"

site_tmp="$(mktemp "${ZADIG_ROOT}/zadig-site.XXXXXX")"
redirect_tmp="$(mktemp "${ZADIG_ROOT}/zadig-redirect.XXXXXX")"
remi_tmp="$(mktemp "${ZADIG_ROOT}/remi-site.XXXXXX")"
trap 'find "${site_tmp}" "${redirect_tmp}" "${remi_tmp}" -xdev -delete 2>/dev/null || true' EXIT

cat > "${site_tmp}" <<NGINX
upstream multiremi_zadig {
    server 127.0.0.1:${ZADIG_NODE_PORT};
    keepalive 16;
}

server {
    listen ${ZADIG_PUBLIC_PORT};
    listen [::]:${ZADIG_PUBLIC_PORT};
    server_name ${ZADIG_PUBLIC_HOST};

    client_max_body_size 1g;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;

    location / {
        proxy_pass http://multiremi_zadig;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

cat > "${redirect_tmp}" <<NGINX
location = /ci {
    return 302 http://${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}/;
}

location = /ci/ {
    return 302 http://${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT}/;
}
NGINX

redirect_include='    include /etc/nginx/snippets/zadig-ci-redirect.conf;'
existing_include_count="$(grep -Fxc "${redirect_include}" "${MULTIREMI_SITE}" || true)"
case "${existing_include_count}" in
  2) cp "${MULTIREMI_SITE}" "${remi_tmp}" ;;
  0)
    openviking_include='    include /etc/nginx/snippets/openviking-locations.conf;'
    [[ "$(grep -Fxc "${openviking_include}" "${MULTIREMI_SITE}" || true)" == "2" ]] || \
      die "cannot locate both HTTP and HTTPS insertion points in ${MULTIREMI_SITE}"
    sed "/^[[:space:]]*include \/etc\/nginx\/snippets\/openviking-locations\.conf;$/a\\${redirect_include}" \
      "${MULTIREMI_SITE}" > "${remi_tmp}"
    ;;
  *) die "unexpected Zadig redirect include count: ${existing_include_count}" ;;
esac

edge_backup="$(mktemp -d "${BACKUP_DIR}/nginx-edge.XXXXXX")"
cp -a "${MULTIREMI_SITE}" "${edge_backup}/remi"
site_existed=0
snippet_existed=0
link_existed=0
link_target=""
if [[ -f "${ZADIG_SITE}" && ! -L "${ZADIG_SITE}" ]]; then
  cp -a "${ZADIG_SITE}" "${edge_backup}/zadig-ci"
  site_existed=1
fi
if [[ -f "${REDIRECT_SNIPPET}" && ! -L "${REDIRECT_SNIPPET}" ]]; then
  cp -a "${REDIRECT_SNIPPET}" "${edge_backup}/zadig-ci-redirect.conf"
  snippet_existed=1
fi
if [[ -L "${ZADIG_SITE_LINK}" ]]; then
  link_target="$(readlink "${ZADIG_SITE_LINK}")"
  link_existed=1
fi

install -m 0644 "${site_tmp}" "${ZADIG_SITE}"
install -m 0644 "${redirect_tmp}" "${REDIRECT_SNIPPET}"
install -m 0644 "${remi_tmp}" "${MULTIREMI_SITE}"
if [[ -e "${ZADIG_SITE_LINK}" && ! -L "${ZADIG_SITE_LINK}" ]]; then
  die "${ZADIG_SITE_LINK} exists and is not a symlink"
fi
ln -sfn "${ZADIG_SITE}" "${ZADIG_SITE_LINK}"

if ! nginx -t; then
  cp -a "${edge_backup}/remi" "${MULTIREMI_SITE}"
  if [[ "${site_existed}" == "1" ]]; then
    cp -a "${edge_backup}/zadig-ci" "${ZADIG_SITE}"
  else
    unlink "${ZADIG_SITE}"
  fi
  if [[ "${snippet_existed}" == "1" ]]; then
    cp -a "${edge_backup}/zadig-ci-redirect.conf" "${REDIRECT_SNIPPET}"
  else
    unlink "${REDIRECT_SNIPPET}"
  fi
  if [[ "${link_existed}" == "1" ]]; then
    ln -sfn "${link_target}" "${ZADIG_SITE_LINK}"
  else
    unlink "${ZADIG_SITE_LINK}"
  fi
  nginx -t || true
  die "Nginx validation failed; restored the previous edge configuration"
fi
systemctl reload nginx
log "public URL http://${ZADIG_PUBLIC_HOST}:${ZADIG_PUBLIC_PORT} and /ci redirect are ready"

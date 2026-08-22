#!/bin/sh
set -eu

runtime_uid="${REMI_RUNTIME_UID:-1000}"
runtime_gid="${REMI_RUNTIME_GID:-1000}"

case "$runtime_uid" in
  ''|*[!0-9]*)
    echo "REMI_RUNTIME_UID and REMI_RUNTIME_GID must be numeric" >&2
    exit 64
    ;;
esac
case "$runtime_gid" in
  ''|*[!0-9]*)
    echo "REMI_RUNTIME_UID and REMI_RUNTIME_GID must be numeric" >&2
    exit 64
    ;;
esac

if ! getent group "$runtime_gid" >/dev/null 2>&1; then
  groupadd --gid "$runtime_gid" multiremi-runtime
fi

if ! getent passwd "$runtime_uid" >/dev/null 2>&1; then
  useradd \
    --uid "$runtime_uid" \
    --gid "$runtime_gid" \
    --home-dir "${HOME:-/srv/multiremi}" \
    --no-create-home \
    --shell /usr/sbin/nologin \
    multiremi-runtime
fi

exec gosu "$runtime_uid:$runtime_gid" "$@"

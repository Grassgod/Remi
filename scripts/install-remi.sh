#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible alias for the old Remi runtime daemon installer.
# The runtime daemon package is now branded and released as `multiremi`.

REPO="${MULTIREMI_REPO:-${REMI_REPO:-Grassgod/remi}}"
VERSION="${MULTIREMI_VERSION:-${REMI_VERSION:-latest}}"

export MULTIREMI_REPO="$REPO"
export MULTIREMI_VERSION="$VERSION"
if [ -n "${REMI_BASE_URL:-}" ] && [ -z "${MULTIREMI_BASE_URL:-}" ]; then
  export MULTIREMI_BASE_URL="$REMI_BASE_URL"
fi
if [ -n "${REMI_BIN_DIR:-}" ] && [ -z "${MULTIREMI_BIN_DIR:-}" ]; then
  export MULTIREMI_BIN_DIR="$REMI_BIN_DIR"
fi

if [ -f "$(dirname "$0")/install-multiremi.sh" ]; then
  exec bash "$(dirname "$0")/install-multiremi.sh"
fi

case "$VERSION" in
  latest)
    installer_url="https://github.com/${REPO}/releases/latest/download/install-multiremi.sh"
    ;;
  v*)
    installer_url="https://github.com/${REPO}/releases/download/${VERSION}/install-multiremi.sh"
    ;;
  *)
    installer_url="https://github.com/${REPO}/releases/download/v${VERSION}/install-multiremi.sh"
    ;;
esac

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$installer_url" -o "$tmp"
exec bash "$tmp"

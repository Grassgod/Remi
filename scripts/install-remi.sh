#!/usr/bin/env bash
set -euo pipefail

# Remi agent installer.
#
# Usage:
#   curl -fsSL https://github.com/Grassgod/remi/releases/latest/download/install-remi.sh | bash
#
# Environment:
#   MULTIREMI_VERSION  Specific version to install, with or without leading "v".
#   MULTIREMI_BASE_URL Download from a self-hosted Remi server instead of GitHub.
#   MULTIREMI_BIN_DIR  Directory for the remi binary. Defaults to
#                      /usr/local/bin, falling back to ~/.local/bin when sudo
#                      is unavailable.

REPO="${MULTIREMI_REPO:-Grassgod/remi}"
VERSION="${MULTIREMI_VERSION:-latest}"
BIN_DIR="${MULTIREMI_BIN_DIR:-/usr/local/bin}"

info() { printf "==> %s\n" "$*"; }
ok() { printf "OK: %s\n" "$*"; }
fail() { printf "ERROR: %s\n" "$*" >&2; exit 1; }

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    *) fail "Unsupported OS: $(uname -s). Multiremi supports macOS and Linux." ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) fail "Unsupported architecture: $(uname -m)." ;;
  esac
}

latest_tag() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1
}

selfhost_latest_version() {
  curl -fsSL "${MULTIREMI_BASE_URL%/}/api/remi/releases/latest/version" \
    | tr -d '[:space:]' \
    | sed 's/^v//'
}

install_binary() {
  local tag version url tmp

  if [ "$VERSION" = "latest" ]; then
    if [ -n "${MULTIREMI_BASE_URL:-}" ]; then
      version="$(selfhost_latest_version)"
      [ -n "$version" ] || fail "Could not determine latest Multiremi version from ${MULTIREMI_BASE_URL}."
      tag="v${version}"
    else
      tag="$(latest_tag)"
      [ -n "$tag" ] || fail "Could not determine latest release for ${REPO}."
    fi
  else
    tag="$VERSION"
    case "$tag" in v*) ;; *) tag="v${tag}" ;; esac
  fi
  version="${tag#v}"
  if [ -n "${MULTIREMI_BASE_URL:-}" ]; then
    url="${MULTIREMI_BASE_URL%/}/api/remi/releases/download/${tag}/remi-${version}-${OS}-${ARCH}.tar.gz"
  else
    url="https://github.com/${REPO}/releases/download/${tag}/remi-${version}-${OS}-${ARCH}.tar.gz"
  fi
  tmp="$(mktemp -d)"

  info "Downloading ${url}"
  curl -fsSL "$url" -o "$tmp/remi.tar.gz"
  tar -xzf "$tmp/remi.tar.gz" -C "$tmp"
  chmod +x "$tmp/remi"
  if [ -f "$tmp/remi-claude-agent-acp" ]; then
    chmod +x "$tmp/remi-claude-agent-acp"
  fi

  install_file "$tmp/remi" "remi"
  if [ -f "$tmp/remi-claude-agent-acp" ]; then
    install_file "$tmp/remi-claude-agent-acp" "remi-claude-agent-acp"
  fi
  rm -rf "$tmp"
  ok "Installed remi to ${BIN_DIR}/remi"
  if command -v remi-claude-agent-acp >/dev/null 2>&1 || [ -x "${BIN_DIR}/remi-claude-agent-acp" ]; then
    ok "Installed Remi Claude ACP wrapper to ${BIN_DIR}/remi-claude-agent-acp"
  fi

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) printf "Note: add %s to PATH if your shell cannot find remi.\n" "$BIN_DIR" ;;
  esac
}

install_file() {
  local src="$1"
  local name="$2"

  if [ -w "$BIN_DIR" ]; then
    mv "$src" "$BIN_DIR/$name"
  elif command -v sudo >/dev/null 2>&1; then
    sudo mv "$src" "$BIN_DIR/$name"
  else
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
    mv "$src" "$BIN_DIR/$name"
  fi
}

detect_platform
install_binary

printf "\nNext step:\n"
printf "  remi setup --server <SERVER_URL> --workspace <WORKSPACE_ID> --token <YOUR_TOKEN> --start\n"
printf "\nAgent controls:\n"
printf "  remi status\n"
printf "  remi logs --follow\n"
printf "  remi stop\n"

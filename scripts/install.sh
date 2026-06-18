#!/usr/bin/env bash
set -euo pipefail

# ── Remi One-Click Installer ─────────────────────────────────
#
# Usage: curl -fsSL https://github.com/Grassgod/remi/releases/latest/download/install.sh | bash
#
# Environment variables:
#   REMI_VERSION  — Specific version to install (default: latest)
#   REMI_HOME     — Installation directory (default: ~/.remi)
#   REMI_BIN_DIR  — Directory for the `remi` symlink (default: ~/.local/bin)

REMI_VERSION="${REMI_VERSION:-latest}"
REMI_HOME="${REMI_HOME:-$HOME/.remi}"
REMI_BIN_DIR="${REMI_BIN_DIR:-$HOME/.local/bin}"
GITHUB_REPO="Grassgod/remi"

# ── Colors ────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

# ── Detect OS & Arch ─────────────────────────────────────────

detect_platform() {
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"

  case "$OS" in
    linux)  OS="linux" ;;
    darwin) OS="darwin" ;;
    *)      fail "Unsupported OS: $OS (only Linux and macOS are supported)" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)    ARCH="x64" ;;
    aarch64|arm64)   ARCH="arm64" ;;
    *)               fail "Unsupported architecture: $ARCH" ;;
  esac

  ok "Platform: ${OS}-${ARCH}"
}

# ── Install Dependencies ─────────────────────────────────────

install_bun() {
  if command -v bun &>/dev/null; then
    ok "Bun $(bun --version) already installed"
    return
  fi
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  ok "Bun installed: $(bun --version)"
}

install_pm2() {
  if command -v pm2 &>/dev/null; then
    ok "PM2 $(pm2 --version 2>/dev/null) already installed"
    return
  fi
  info "Installing PM2..."
  bun add -g pm2
  ok "PM2 installed"
}

check_claude_cli() {
  if command -v claude &>/dev/null; then
    ok "Claude CLI installed"
  else
    warn "Claude CLI not found."
    echo "  Install from: https://docs.anthropic.com/en/docs/claude-code"
    echo "  After installing, run: claude  (to complete login)"
    echo ""
  fi
}

# ── Download & Install Remi ──────────────────────────────────

download_remi() {
  local download_url
  local tmp_file="/tmp/remi-install-$$.tar.gz"

  if [ "$REMI_VERSION" = "latest" ]; then
    info "Fetching latest release from GitHub..."
    download_url=$(curl -sL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
      | grep "browser_download_url" \
      | grep "${OS}-${ARCH}" \
      | head -1 \
      | cut -d '"' -f 4)

    if [ -z "$download_url" ]; then
      fail "Could not find a release for ${OS}-${ARCH}. Check https://github.com/${GITHUB_REPO}/releases"
    fi
  else
    download_url="https://github.com/${GITHUB_REPO}/releases/download/v${REMI_VERSION}/remi-v${REMI_VERSION}-${OS}-${ARCH}.tar.gz"
  fi

  info "Downloading: $download_url"
  curl -fsSL "$download_url" -o "$tmp_file" || fail "Download failed"
  ok "Downloaded successfully"

  # Create install directory
  mkdir -p "$REMI_HOME"

  # Extract (preserve existing user data)
  info "Installing to $REMI_HOME..."
  tar xzf "$tmp_file" -C "$REMI_HOME"
  rm -f "$tmp_file"

  ok "Remi installed to $REMI_HOME"
}

install_deps() {
  if [ -f "$REMI_HOME/package.json" ]; then
    info "Installing dependencies..."
    cd "$REMI_HOME" && bun install --production 2>/dev/null
    ok "Dependencies installed"
  fi
}

# ── Setup ─────────────────────────────────────────────────────

setup_bin() {
  mkdir -p "$REMI_BIN_DIR"
  ln -sf "$REMI_HOME/bin/remi" "$REMI_BIN_DIR/remi"
  ok "Linked remi → $REMI_BIN_DIR/remi"

  # Check if bin dir is in PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -q "^${REMI_BIN_DIR}$"; then
    warn "$REMI_BIN_DIR is not in your PATH."
    echo "  Add to your shell profile (~/.bashrc or ~/.zshrc):"
    echo "    export PATH=\"$REMI_BIN_DIR:\$PATH\""
    echo ""
  fi
}

setup_config() {
  if [ ! -f "$REMI_HOME/remi.toml" ]; then
    if [ -f "$REMI_HOME/dist/template.toml" ]; then
      cp "$REMI_HOME/dist/template.toml" "$REMI_HOME/remi.toml"
      ok "Generated default remi.toml"
    fi
  else
    ok "Existing remi.toml preserved"
  fi
}

# ── Main ──────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Remi Installer${NC}"
echo "────────────────────────────────────────"
echo ""

detect_platform
echo ""

info "Installing dependencies..."
install_bun
install_pm2
check_claude_cli
echo ""

info "Installing Remi..."
download_remi
install_deps
echo ""

info "Setting up..."
setup_bin
setup_config
echo ""

# Run doctor if remi is accessible
if command -v remi &>/dev/null || [ -x "$REMI_BIN_DIR/remi" ]; then
  echo "────────────────────────────────────────"
  "$REMI_BIN_DIR/remi" doctor 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}${BOLD}Installation complete!${NC}"
echo ""
echo "  Next steps:"
echo "    remi login   — Configure Feishu Bot + API keys"
echo "    remi start   — Start Remi services"
echo "    remi doctor  — Check system health"
echo ""

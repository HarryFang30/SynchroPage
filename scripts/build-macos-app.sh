#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="PagePair Reader.app"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
BUILT_APP="$DESKTOP_DIR/release/mac-arm64/$APP_NAME"
INSTALL_DIR="/Applications"
RUN_INSTALL=0
RUN_USER_INSTALL=0
RUN_OPEN=0
RUN_DMG=0
SKIP_DEPS=0

usage() {
  cat <<'EOF'
Usage: scripts/build-macos-app.sh [options]

Build the PagePair Reader macOS app in one command.

Options:
  --install       Copy the built app to /Applications
  --user-install  Copy the built app to ~/Applications
  --open          Open the app after build/install
  --dmg           Build dmg/zip artifacts instead of only the .app directory
  --skip-deps     Do not auto-install missing npm/PyInstaller dependencies
  -h, --help      Show this help

Examples:
  ./scripts/build-macos-app.sh
  ./scripts/build-macos-app.sh --install --open
  ./scripts/build-macos-app.sh --user-install --open
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      RUN_INSTALL=1
      ;;
    --user-install)
      RUN_USER_INSTALL=1
      ;;
    --open)
      RUN_OPEN=1
      ;;
    --dmg)
      RUN_DMG=1
      ;;
    --skip-deps)
      SKIP_DEPS=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

cd "$ROOT_DIR"

log() {
  printf '\n==> %s\n' "$*"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script builds a macOS .app and must run on macOS." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 20+ first." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required. Install Python 3.11+ first." >&2
  exit 1
fi

if [[ "$SKIP_DEPS" -eq 0 ]]; then
  if [[ ! -d "$ROOT_DIR/apps/web/node_modules" ]]; then
    log "Installing web dependencies"
    npm --prefix apps/web install
  fi

  if [[ ! -d "$ROOT_DIR/apps/desktop/node_modules" ]]; then
    log "Installing desktop dependencies"
    npm --prefix apps/desktop install
  fi

  if ! python3 -c "import PyInstaller" >/dev/null 2>&1; then
    log "Installing PyInstaller"
    python3 -m pip install pyinstaller
  fi
fi

log "Building PagePair Reader.app"
if [[ "$RUN_DMG" -eq 1 ]]; then
  npm --prefix apps/desktop run dist
else
  npm --prefix apps/desktop run pack
fi

if [[ ! -d "$BUILT_APP" ]]; then
  echo "Build finished but app was not found at: $BUILT_APP" >&2
  exit 1
fi

APP_TO_OPEN="$BUILT_APP"

install_app() {
  local destination_dir="$1"
  local destination_app="$destination_dir/$APP_NAME"
  log "Installing to $destination_app"
  osascript -e 'tell application "PagePair Reader" to quit' >/dev/null 2>&1 || true
  mkdir -p "$destination_dir"
  rm -rf "$destination_app"
  ditto "$BUILT_APP" "$destination_app"
  xattr -dr com.apple.quarantine "$destination_app" >/dev/null 2>&1 || true
  APP_TO_OPEN="$destination_app"
}

if [[ "$RUN_INSTALL" -eq 1 ]]; then
  install_app "$INSTALL_DIR"
fi

if [[ "$RUN_USER_INSTALL" -eq 1 ]]; then
  install_app "$HOME/Applications"
fi

log "Built app"
du -sh "$BUILT_APP"
echo "$BUILT_APP"

if [[ "$RUN_DMG" -eq 1 ]]; then
  log "Distribution artifacts"
  find "$DESKTOP_DIR/release" -maxdepth 1 \( -name "*.dmg" -o -name "*.zip" \) -print
fi

if [[ "$RUN_OPEN" -eq 1 ]]; then
  log "Opening $APP_TO_OPEN"
  open "$APP_TO_OPEN"
fi

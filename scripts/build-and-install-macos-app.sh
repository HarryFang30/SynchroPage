#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HAS_INSTALL_TARGET=0
HAS_OPEN=0

usage() {
  cat <<'EOF'
Usage: scripts/build-and-install-macos-app.sh [build-macos-app options]

One-click local macOS install for SynchroPage.

Default behavior:
  1. Build the web app.
  2. Build the Python backend sidecar.
  3. Package SynchroPage.app.
  4. Install it to /Applications.
  5. Open the installed app.

Examples:
  ./scripts/build-and-install-macos-app.sh
  ./scripts/build-and-install-macos-app.sh --user-install
  ./scripts/build-and-install-macos-app.sh --dmg

All options are forwarded to scripts/build-macos-app.sh.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --install|--user-install)
      HAS_INSTALL_TARGET=1
      ;;
    --open)
      HAS_OPEN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
  esac
done

if [[ -z "${PYTHON:-}" ]]; then
  if python3 -c "import PyInstaller" >/dev/null 2>&1; then
    export PYTHON="python3"
  elif [[ -x "/opt/anaconda3/bin/python3" ]] && /opt/anaconda3/bin/python3 -c "import PyInstaller" >/dev/null 2>&1; then
    export PYTHON="/opt/anaconda3/bin/python3"
  else
    export PYTHON="python3"
  fi
fi

if [[ "$HAS_INSTALL_TARGET" -eq 0 ]]; then
  set -- --install "$@"
fi

if [[ "$HAS_OPEN" -eq 0 ]]; then
  set -- --open "$@"
fi

cd "$ROOT_DIR"
exec ./scripts/build-macos-app.sh "$@"

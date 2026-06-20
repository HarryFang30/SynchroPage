#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
DIST_DIR="$ROOT_DIR/apps/desktop/bin"
BUILD_DIR="$ROOT_DIR/build/pyinstaller"
ENTRYPOINT="$ROOT_DIR/src/pdf_agent/web_app.py"

cd "$ROOT_DIR"

if ! "$PYTHON_BIN" -c "import PyInstaller" >/dev/null 2>&1; then
  cat >&2 <<'EOF'
PyInstaller is required to build the bundled desktop backend.

Install it with:
  python3 -m pip install pyinstaller

Then rerun:
  npm --prefix apps/desktop run build:backend
EOF
  exit 1
fi

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR" "$BUILD_DIR"

PYTHONPATH="$ROOT_DIR/src" "$PYTHON_BIN" -m PyInstaller \
  --clean \
  --noconfirm \
  --onefile \
  --name pagepair-backend \
  --paths "$ROOT_DIR/src" \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_DIR/work" \
  --specpath "$BUILD_DIR/spec" \
  "$ENTRYPOINT"

chmod +x "$DIST_DIR/pagepair-backend"
echo "Built backend sidecar: $DIST_DIR/pagepair-backend"

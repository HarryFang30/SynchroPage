#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHONPATH=src python3 -m compileall -q src tests
PYTHONPATH=src python3 -m unittest discover -s tests
python3 scripts/validate_project_files.py
python3 -m ruff check src tests scripts
npm --prefix apps/web run check
npm --prefix apps/web run build
npm --prefix apps/web audit --audit-level=high --omit=dev

echo "checks ok"

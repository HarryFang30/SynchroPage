#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHONPATH=src python3 -m compileall -q src tests
PYTHONPATH=src python3 -m unittest discover -s tests
npm run build

if command -v ruby >/dev/null 2>&1; then
  ruby -e 'require "yaml"; YAML.load_file("config/auth/openai_oauth.yaml"); YAML.load_file("config/harness/course_pdf_harness.yaml"); YAML.load_file("config/prompts/course_agent.prompt.yaml")'
else
  echo "ruby not found; skipped YAML syntax check"
fi

python3 - <<'PY'
import json
from pathlib import Path

for path in Path("contracts/schemas").rglob("*.json"):
    json.loads(path.read_text())

print("checks ok")
PY

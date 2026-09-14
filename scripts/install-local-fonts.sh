#!/usr/bin/env bash
# Copy Anthropic Sans out of the locally installed Claude desktop app into
# apps/web/public/fonts so SynchroPage's UI and explanations render Latin text
# with it. The folder is git-ignored: Anthropic Sans is Anthropic's proprietary
# typeface, it must not be committed or redistributed with the repository. If
# the files are absent the app silently falls back to the next font in the stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/apps/web/public/fonts"
CLAUDE_APP="${CLAUDE_APP:-/Applications/Claude.app}"
RUNTIME="$CLAUDE_APP/Contents/Resources/ion-dist/_frame-rt/_runtime"

roman="$(ls "$RUNTIME"/AnthropicSans-Roman-Web.*.woff2 2>/dev/null | head -n 1 || true)"
italic="$(ls "$RUNTIME"/AnthropicSans-Italic-Web.*.woff2 2>/dev/null | head -n 1 || true)"
if [[ -z "$roman" ]]; then
  echo "Anthropic Sans not found under $RUNTIME (set CLAUDE_APP to the Claude.app path)." >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$roman" "$DEST/AnthropicSans-Roman.woff2"
if [[ -n "$italic" ]]; then cp "$italic" "$DEST/AnthropicSans-Italic.woff2"; fi
echo "Installed into $DEST:"
ls -1 "$DEST"
echo "This folder is git-ignored; do not commit these files."

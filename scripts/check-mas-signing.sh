#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---dist}"
APP_STORE_PROFILE="${SYNCHROPAGE_MAS_PROFILE:-$ROOT_DIR/apps/desktop/profiles/SynchroPage_AppStore.provisionprofile}"
DEV_PROFILE="${SYNCHROPAGE_MAS_DEV_PROFILE:-$ROOT_DIR/apps/desktop/profiles/SynchroPage_Development.provisionprofile}"

if [[ "$MODE" != "--dist" && "$MODE" != "--dev" ]]; then
  echo "Usage: $0 [--dist|--dev]" >&2
  exit 2
fi

if ! command -v security >/dev/null 2>&1; then
  echo "macOS security tool is required for signing checks." >&2
  exit 1
fi

identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"

has_identity() {
  local pattern="$1"
  grep -Eq "$pattern" <<<"$identities"
}

require_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    echo "Missing $label: $path" >&2
    return 1
  fi
}

failures=0

if [[ "$MODE" == "--dev" ]]; then
  require_file "$DEV_PROFILE" "development provisioning profile" || failures=$((failures + 1))
  if ! has_identity '"(Apple Development|Mac Developer):'; then
    echo "Missing Apple Development / Mac Developer signing identity in Keychain." >&2
    failures=$((failures + 1))
  fi
else
  require_file "$APP_STORE_PROFILE" "App Store provisioning profile" || failures=$((failures + 1))
  if ! has_identity '"(Apple Distribution|3rd Party Mac Developer Application):'; then
    echo "Missing Apple Distribution / 3rd Party Mac Developer Application identity in Keychain." >&2
    failures=$((failures + 1))
  fi
  if ! has_identity '"(3rd Party Mac Developer Installer|Mac Installer Distribution):'; then
    echo "Missing Mac App Store installer identity in Keychain." >&2
    echo "electron-builder currently searches for the legacy installer identity name during MAS packaging." >&2
    failures=$((failures + 1))
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  cat >&2 <<'EOF'

Prepare signing assets:
  1. Register explicit App ID / bundle ID: com.synchropage.reader
  2. Install the required Apple Developer certificates in Keychain.
  3. Download the matching provisioning profile into apps/desktop/profiles/.
  4. Re-run the MAS command.

For a custom profile path, set:
  SYNCHROPAGE_MAS_PROFILE=/path/to/AppStore.provisionprofile
  SYNCHROPAGE_MAS_DEV_PROFILE=/path/to/Development.provisionprofile
EOF
  exit 1
fi

echo "MAS signing prerequisites look available for $MODE."

#!/bin/bash
# Applies staged observed-domain edits. It can be run manually with sudo;
# auto-apply uses the same wrapper from a root-owned support directory.
# Paths are derived from this script's own location.
set -euo pipefail
if [ "$(id -u)" -ne 0 ] && [ "${DOCKMASTER_AUTO_TEST_MODE:-0}" != "1" ]; then
  echo "Run with sudo." >&2
  exit 1
fi
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /opt/homebrew/bin/node "$DEPLOY/apply-edits.mjs" "$@"

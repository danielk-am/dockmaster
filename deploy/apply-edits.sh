#!/bin/bash
# Dockmaster: apply the staged observed-domain edits (hosts file, dnsmasq
# rules, resolver files) queued by the Ingress & Domains screen.
# Run with sudo; the UI prints the exact copyable command.
# Paths are derived from this script's own location, so the repo can move
# without stranding the deploy kit (the hardcoded ~/ai path broke once).
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo." >&2
  exit 1
fi
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /opt/homebrew/bin/node "$DEPLOY/apply-edits.mjs"

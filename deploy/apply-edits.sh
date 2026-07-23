#!/bin/bash
# Dockmaster: apply the staged observed-domain edits (hosts file, dnsmasq
# rules, resolver files) queued by the Ingress & Domains screen.
# Run: sudo bash ~/ai/repos/dockmaster/deploy/apply-edits.sh
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo." >&2
  exit 1
fi
exec /opt/homebrew/bin/node /Users/danielkam/ai/repos/dockmaster/deploy/apply-edits.mjs

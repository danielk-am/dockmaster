#!/bin/bash
# One-time install of the Local Ingress daemon (supersedes the espanso-ui
# deploy kit / am.danielk.snippets-proxy). Idempotent — safe to re-run.
# Run: sudo bash ~/ai/repos/portside/deploy/install.sh
#
# The daemon creates the loopback aliases (127.0.49.49 + fd49::4949) and runs
# a root Caddy with --watch on the USER-OWNED config in
# ~/.local/share/local-ingress/ — so after this one run, the Local Ingress UI
# (http://127.0.0.1:4950 (Ingress view)) manages domains with no further privileges. Only
# NEW dnsmasq lines still need deploy/apply-dns.sh (this script applies any
# already staged).
set -euo pipefail

DEPLOY=/Users/danielkam/ai/repos/portside/deploy
LABEL=am.danielk.local-ingress
PLIST=/Library/LaunchDaemons/$LABEL.plist

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }

# Waits for a system-domain label to fully unregister: `bootout` is async,
# and bootstrapping while the old instance tears down is the
# "Bootstrap failed: 5: Input/output error" we hit twice.
bootout_and_wait() {
	launchctl bootout "system/$1" 2>/dev/null || true
	for _ in $(seq 1 30); do
		launchctl print "system/$1" >/dev/null 2>&1 || return 0
		sleep 0.5
	done
	echo "  warning: $1 still registered after 15s; continuing"
}

echo "1/5 seed config (registry → Caddyfile/sites/certs as danielkam)"
sudo -u danielkam /opt/homebrew/bin/node /Users/danielkam/ai/repos/portside/deploy/seed.mjs

echo "2/5 retire old daemons (snippets-proxy, lo-alias)"
bootout_and_wait am.danielk.snippets-proxy
bootout_and_wait am.danielk.lo-alias
rm -f /Library/LaunchDaemons/am.danielk.snippets-proxy.plist /Library/LaunchDaemons/am.danielk.lo-alias.plist

echo "3/5 install + bootstrap $LABEL"
install -m 644 -o root -g wheel "$DEPLOY/$LABEL.plist" "$PLIST"
bootout_and_wait "$LABEL"
if ! launchctl bootstrap system "$PLIST"; then
	# Even a failed-looking bootstrap sometimes registers the job — kickstart
	# it; only report failure if the service really is not there.
	sleep 1
	launchctl kickstart "system/$LABEL" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
fi

echo "4/5 dnsmasq — apply staged lines (if any) + restart"
bash "$DEPLOY/apply-dns.sh" --from-install

echo "5/5 verify"
sleep 2
launchctl print "system/$LABEL" >/dev/null 2>&1 && echo "  daemon: registered" || echo "  daemon: NOT registered"
echo -n "  HTTPS: "
curl -s -o /dev/null -w "https://snippets.test -> HTTP %{http_code}\n" --max-time 5 https://snippets.test/ || true
echo "Done. UI: http://127.0.0.1:4950 (Ingress view) — logs: /Library/Logs/$LABEL.log"

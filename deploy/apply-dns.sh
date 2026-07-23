#!/bin/bash
# Applies resolution lines staged by the Local Ingress UI — dnsmasq
# address= rules AND /etc/hosts entries — then restarts dnsmasq via
# launchd (brew-as-root silently no-ops, which once left a restarted-never
# dnsmasq serving a stale /test/::1 AAAA) and flushes caches.
#
# The hosts entries matter for browsers: Chrome's Secure DNS (DoH) bypasses
# scoped resolvers and dnsmasq entirely (.test is guaranteed-NXDOMAIN at
# any public resolver) but the hosts file is consulted first.
# Run: sudo bash ~/ai/repos/dockmaster/deploy/apply-dns.sh
set -euo pipefail

STATE=/Users/danielkam/.local/share/local-ingress
CONF=/opt/homebrew/etc/dnsmasq.conf
HOSTS=/etc/hosts
DNSMASQ_LABEL=homebrew.mxcl.dnsmasq

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }

apply_pending() { # $1 = staging file, $2 = target file, $3 = description
	local staged="$1" target="$2" what="$3"
	if [ -s "$staged" ]; then
		local count
		count=$(grep -c . "$staged")
		{
			echo ""
			echo "# Local Ingress ($(date '+%Y-%m-%d %H:%M') apply-dns.sh)"
			cat "$staged"
		} >> "$target"
		: > "$staged"
		echo "  $what: applied $count line(s)"
	else
		echo "  $what: nothing staged"
	fi
}

apply_pending "$STATE/dns-pending.conf" "$CONF" "dnsmasq"
apply_pending "$STATE/hosts-pending.conf" "$HOSTS" "/etc/hosts"

# Deterministic restart: kickstart the root launchd job directly.
if launchctl print "system/$DNSMASQ_LABEL" >/dev/null 2>&1; then
	launchctl kickstart -k "system/$DNSMASQ_LABEL"
	echo "  dnsmasq: kickstarted ($DNSMASQ_LABEL)"
else
	/opt/homebrew/bin/brew services restart dnsmasq
	echo "  dnsmasq: restarted via brew (label not in system domain)"
fi
dscacheutil -flushcache
killall -HUP mDNSResponder
echo "  caches flushed"

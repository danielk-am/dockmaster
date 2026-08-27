#!/bin/bash
# Applies generated ingress resolution lines to dnsmasq and /etc/hosts.
# The root auto-apply job runs an installed, root-owned copy of this file.
# Queue content is data only: every line must match one of the two fixed
# alias addresses plus a valid hostname before it can reach a privileged file.
set -euo pipefail

STATE="${DOCKMASTER_AUTO_STATE_DIR:-/Users/danielkam/.local/share/local-ingress}"
CONF="${DOCKMASTER_AUTO_DNSMASQ_CONF:-/opt/homebrew/etc/dnsmasq.conf}"
HOSTS="${DOCKMASTER_AUTO_HOSTS_FILE:-/etc/hosts}"
DNSMASQ_LABEL=homebrew.mxcl.dnsmasq
TEST_MODE="${DOCKMASTER_AUTO_TEST_MODE:-0}"

if [ "$(id -u)" -ne 0 ] && [ "$TEST_MODE" != "1" ]; then
	echo "Run with sudo." >&2
	exit 1
fi
if [ ! -d "$STATE" ]; then
	echo "State directory missing: $STATE" >&2
	exit 1
fi

state_uid=$(stat -f %u "$STATE")
state_gid=$(stat -f %g "$STATE")
work_dir=$(mktemp -d /tmp/dockmaster-auto-apply.XXXXXX)
dns_claim=
hosts_claim=
dns_sources=("")
hosts_sources=("")

cleanup() {
	exit_status=$?
	trap - EXIT
	if [ "$exit_status" -ne 0 ]; then
		local stamp
		stamp=$(date +%s)
		if [ -n "$dns_claim" ] && [ -e "$dns_claim" ]; then
			mv "$dns_claim" "${STATE}/dns-pending.conf.failed-${stamp}" || true
		fi
		if [ -n "$hosts_claim" ] && [ -e "$hosts_claim" ]; then
			mv "$hosts_claim" "${STATE}/hosts-pending.conf.failed-${stamp}" || true
		fi
	fi
	rm -rf "$work_dir"
	exit "$exit_status"
}
trap cleanup EXIT

restore_queue() {
	local queue="$1"
	if [ ! -e "$queue" ]; then
		: > "$queue"
		chown "$state_uid:$state_gid" "$queue"
		chmod 644 "$queue"
	fi
}

# Atomically hand one queue generation to the root process. If Localhost Manager
# writes a replacement while this copy is applying, that new file remains
# untouched and launchd wakes the helper again.
CLAIMED=
claim_queue() {
	local queue="$1"
	CLAIMED=
	[ -s "$queue" ] || return 1
	CLAIMED="${queue}.applying.$$"
	mv "$queue" "$CLAIMED"
	restore_queue "$queue"
	if [ "$(stat -f %z "$CLAIMED")" -gt 65536 ]; then
		local rejected="${queue}.rejected-$(date +%s)"
		mv "$CLAIMED" "$rejected"
		CLAIMED=
		echo "Queue exceeds 64 KiB; retained at $rejected" >&2
		return 1
	fi
}

valid_hostname() {
	local hostname="$1"
	local label
	[ "${#hostname}" -le 253 ] || return 1
	[[ "$hostname" =~ ^[a-z0-9.-]+$ ]] || return 1
	IFS='.' read -r -a labels <<< "$hostname"
	for label in "${labels[@]}"; do
		[ "${#label}" -ge 1 ] && [ "${#label}" -le 63 ] || return 1
		[[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
	done
}

dns_clean="$work_dir/dns"
hosts_clean="$work_dir/hosts"
: > "$dns_clean"
: > "$hosts_clean"
rejected=0
dns_stale_count=0
hosts_stale_count=0
dns_processed=0
hosts_processed=0

for stale in "$STATE"/dns-pending.conf.applying.*; do
	[ -e "$stale" ] || continue
	if [[ "$(basename "$stale")" =~ ^dns-pending\.conf\.applying\.[0-9]+$ ]] && [ -f "$stale" ] && [ ! -L "$stale" ]; then
		dns_sources+=("$stale")
		dns_stale_count=$((dns_stale_count + 1))
	fi
done
for stale in "$STATE"/hosts-pending.conf.applying.*; do
	[ -e "$stale" ] || continue
	if [[ "$(basename "$stale")" =~ ^hosts-pending\.conf\.applying\.[0-9]+$ ]] && [ -f "$stale" ] && [ ! -L "$stale" ]; then
		hosts_sources+=("$stale")
		hosts_stale_count=$((hosts_stale_count + 1))
	fi
done

if [ -f "$CONF" ]; then
	dns_processed=1
	if claim_queue "$STATE/dns-pending.conf"; then
		dns_claim="$CLAIMED"
		dns_sources+=("$dns_claim")
	fi
	for source_file in "${dns_sources[@]}"; do
		[ -n "$source_file" ] || continue
		while IFS= read -r line || [ -n "$line" ]; do
			[ -n "$line" ] || continue
			if [[ "$line" =~ ^address=/([^/]+)/(127\.0\.49\.49|fd49::4949)$ ]] && valid_hostname "${BASH_REMATCH[1]}"; then
				if ! grep -Fqx "$line" "$CONF" && ! grep -Fqx "$line" "$dns_clean"; then
					printf '%s\n' "$line" >> "$dns_clean"
				fi
			else
				echo "  rejected dnsmasq queue line: $line" >&2
				rejected=$((rejected + 1))
			fi
		done < "$source_file"
	done
elif [ -s "$STATE/dns-pending.conf" ] || [ "$dns_stale_count" -gt 0 ]; then
	echo "dnsmasq config missing; DNS queue left pending: $CONF" >&2
fi

if [ -f "$HOSTS" ]; then
	hosts_processed=1
	if claim_queue "$STATE/hosts-pending.conf"; then
		hosts_claim="$CLAIMED"
		hosts_sources+=("$hosts_claim")
	fi
	for source_file in "${hosts_sources[@]}"; do
		[ -n "$source_file" ] || continue
		while IFS= read -r line || [ -n "$line" ]; do
			[ -n "$line" ] || continue
			if [[ "$line" =~ ^(127\.0\.49\.49|fd49::4949)[[:space:]]+([^[:space:]]+)$ ]] && valid_hostname "${BASH_REMATCH[2]}"; then
				if ! grep -Fqx "$line" "$HOSTS" && ! grep -Fqx "$line" "$hosts_clean"; then
					printf '%s\n' "$line" >> "$hosts_clean"
				fi
			else
				echo "  rejected hosts queue line: $line" >&2
				rejected=$((rejected + 1))
			fi
		done < "$source_file"
	done
elif [ -s "$STATE/hosts-pending.conf" ] || [ "$hosts_stale_count" -gt 0 ]; then
	echo "hosts file missing; hosts queue left pending: $HOSTS" >&2
fi

dns_count=$(awk 'END { print NR }' "$dns_clean")
hosts_count=$(awk 'END { print NR }' "$hosts_clean")

if [ "$dns_count" -gt 0 ]; then
	cp "$CONF" "$CONF.dockmaster.bak"
	{
		echo ""
		echo "# Local Ingress ($(date '+%Y-%m-%d %H:%M') auto-apply)"
		cat "$dns_clean"
	} >> "$CONF"
	echo "  dnsmasq: applied $dns_count line(s)"
fi

if [ "$hosts_count" -gt 0 ]; then
	cp "$HOSTS" "$HOSTS.dockmaster.bak"
	{
		echo ""
		echo "# Local Ingress ($(date '+%Y-%m-%d %H:%M') auto-apply)"
		cat "$hosts_clean"
	} >> "$HOSTS"
	echo "  /etc/hosts: applied $hosts_count line(s)"
fi

if [ "$TEST_MODE" != "1" ] && [ "$dns_count" -gt 0 ]; then
	if launchctl print "system/$DNSMASQ_LABEL" >/dev/null 2>&1; then
		launchctl kickstart -k "system/$DNSMASQ_LABEL"
		echo "  dnsmasq: kickstarted ($DNSMASQ_LABEL)"
	else
		/opt/homebrew/bin/brew services restart dnsmasq
		echo "  dnsmasq: restarted via brew (label not in system domain)"
	fi
fi

if [ "$TEST_MODE" != "1" ] && { [ "$dns_count" -gt 0 ] || [ "$hosts_count" -gt 0 ]; }; then
	dscacheutil -flushcache || true
	killall -HUP mDNSResponder || true
	echo "  caches flushed"
fi

if [ "$dns_count" -eq 0 ] && [ "$hosts_count" -eq 0 ] && [ "$rejected" -eq 0 ]; then
	echo "No staged DNS or hosts lines."
fi
if [ "$rejected" -gt 0 ]; then
	echo "Rejected $rejected invalid queue line(s)." >&2
fi
if [ "$dns_stale_count" -gt 0 ] || [ "$hosts_stale_count" -gt 0 ]; then
	echo "Recovered $((dns_stale_count + hosts_stale_count)) stale queue claim(s)."
fi

if [ "$dns_processed" -eq 1 ]; then
	for source_file in "${dns_sources[@]}"; do [ -n "$source_file" ] && rm -f "$source_file"; done
fi
if [ "$hosts_processed" -eq 1 ]; then
	for source_file in "${hosts_sources[@]}"; do [ -n "$source_file" ] && rm -f "$source_file"; done
fi
exit 0

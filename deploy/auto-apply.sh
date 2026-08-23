#!/bin/bash
# Persistent queue worker for the root auto-apply LaunchDaemon. The installer
# copies this file and its appliers into a root-owned support directory.
# Polling avoids a WatchPaths feedback loop: claiming a watched queue must
# rename and recreate it, which can otherwise interrupt the active apply.
set -u

AUTO_APPLY_WORKER_VERSION=2
TEST_MODE="${DOCKMASTER_AUTO_TEST_MODE:-0}"
STATE="${DOCKMASTER_AUTO_STATE_DIR:-/Users/danielkam/.local/share/local-ingress}"
POLL_SECONDS="${DOCKMASTER_AUTO_POLL_SECONDS:-2}"
RUN_ONCE="${DOCKMASTER_AUTO_RUN_ONCE:-0}"
SUPPORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEARTBEAT_FILE="${DOCKMASTER_AUTO_HEARTBEAT_FILE:-$SUPPORT_DIR/.last-idle-log}"
EDITS_FILE="${DOCKMASTER_AUTO_EDITS_FILE:-$STATE/observed-edits.json}"
ACTIVITY_LOG="${DOCKMASTER_AUTO_ACTIVITY_LOG:-/Library/Logs/am.danielk.local-ingress-auto-apply.log}"
LOCK_FILE="${DOCKMASTER_AUTO_LOCK_FILE:-/var/run/am.danielk.local-ingress-auto-apply.lock}"

if [ "$(id -u)" -ne 0 ] && [ "$TEST_MODE" != "1" ]; then
	echo "Run as root." >&2
	exit 1
fi

running=1
trap 'running=0' TERM INT

log() {
	local entry
	entry="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
	if ! printf '%s\n' "$entry" >> "$ACTIVITY_LOG"; then
		printf '%s\n' "$entry" >&2
	fi
}

exec 9>"$LOCK_FILE"
if ! /usr/bin/lockf -s -t 0 9; then
	log "worker start skipped: another worker holds the lock"
	exit 0
fi

edits_pending() {
	[ -s "$EDITS_FILE" ] || return 1
	/usr/bin/grep -Eq '^[[:space:]]*\[[[:space:]]*\][[:space:]]*$' "$EDITS_FILE" && return 1
	return 0
}

stale_claims_pending() {
	local candidate
	local name
	for candidate in \
		"$STATE"/dns-pending.conf.applying.* \
		"$STATE"/hosts-pending.conf.applying.* \
		"$STATE"/observed-edits.json.applying.*; do
		name="${candidate##*/}"
		if [[ "$name" =~ ^(dns-pending\.conf|hosts-pending\.conf|observed-edits\.json)\.applying\.[0-9]+$ ]] \
			&& [ -f "$candidate" ] \
			&& [ ! -L "$candidate" ]; then
			return 0
		fi
	done
	return 1
}

has_work() {
	[ -s "$STATE/dns-pending.conf" ] \
		|| [ -s "$STATE/hosts-pending.conf" ] \
		|| edits_pending \
		|| stale_claims_pending
}

queue_bytes() {
	local file="$1"
	if [ -e "$file" ]; then
		stat -f %z "$file"
	else
		printf '0'
	fi
}

log_output() {
	local component="$1"
	local output="$2"
	[ -n "$output" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		log "$component: $line"
	done <<< "$output"
}

run_apply() {
	local status=0
	local output
	log "run start: dns=$(queue_bytes "$STATE/dns-pending.conf")B hosts=$(queue_bytes "$STATE/hosts-pending.conf")B edits=$(queue_bytes "$EDITS_FILE")B"

	output=$(/bin/bash "$SUPPORT_DIR/apply-dns.sh" --auto 2>&1) || status=$?
	log_output "dns" "$output"

	local edits_status=0
	output=$(/bin/bash "$SUPPORT_DIR/apply-edits.sh" --auto 2>&1) || edits_status=$?
	log_output "edits" "$output"
	if [ "$edits_status" -ne 0 ]; then
		status="$edits_status"
	fi

	if [ "$status" -eq 0 ]; then
		log "run finish: success"
	else
		log "run finish: failed (status $status); claimed work was retained"
	fi
}

log_idle_once_daily() {
	local today
	local previous=
	today=$(date '+%Y-%m-%d')
	if [ -r "$HEARTBEAT_FILE" ]; then
		IFS= read -r previous < "$HEARTBEAT_FILE" || true
	fi
	if [ "$previous" != "$today" ]; then
		log "idle: no queued changes (worker v$AUTO_APPLY_WORKER_VERSION)"
		printf '%s\n' "$today" > "$HEARTBEAT_FILE"
		chmod 644 "$HEARTBEAT_FILE"
	fi
}

while [ "$running" -eq 1 ]; do
	if has_work; then
		run_apply
	else
		log_idle_once_daily
	fi
	if [ "$RUN_ONCE" = "1" ]; then
		break
	fi
	sleep "$POLL_SECONDS" &
	wait $! || true
done

log "worker stopped"

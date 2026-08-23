#!/bin/bash
# One-time install of the Local Ingress daemon and its auto-apply worker
# (supersedes the espanso-ui deploy kit / am.danielk.snippets-proxy).
# Idempotent: safe to re-run.
# Run with sudo; the UI prints the exact copyable command.
#
# The daemon creates the loopback aliases (127.0.49.49 + fd49::4949) and runs
# a root Caddy with --watch on the USER-OWNED config in
# ~/.local/share/local-ingress/ — so after this one run, the Local Ingress UI
# manages domains with no further prompts. A second root LaunchDaemon watches
# three fixed queue files and applies strictly validated DNS, hosts, and
# resolver changes through root-owned script copies.
set -euo pipefail

# Derived from this script's own location, so a repo move can't strand it.
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL=am.danielk.local-ingress
PLIST=/Library/LaunchDaemons/$LABEL.plist
AUTO_LABEL=am.danielk.local-ingress-auto-apply
AUTO_PLIST=/Library/LaunchDaemons/$AUTO_LABEL.plist
AUTO_LOG=/Library/Logs/$AUTO_LABEL.log
AUTO_NEWSYSLOG=/etc/newsyslog.d/$AUTO_LABEL.conf
SUPPORT_DIR="/Library/Application Support/Dockmaster"

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

echo "1/7 seed config (registry → Caddyfile/sites/certs as danielkam)"
/usr/bin/sudo -u danielkam /opt/homebrew/bin/node "$DEPLOY/seed.mjs"

echo "2/7 retire old daemons (snippets-proxy, lo-alias)"
bootout_and_wait am.danielk.snippets-proxy
bootout_and_wait am.danielk.lo-alias
rm -f /Library/LaunchDaemons/am.danielk.snippets-proxy.plist /Library/LaunchDaemons/am.danielk.lo-alias.plist

echo "3/7 install + bootstrap $LABEL"
install -m 644 -o root -g wheel "$DEPLOY/$LABEL.plist" "$PLIST"
bootout_and_wait "$LABEL"
if ! launchctl bootstrap system "$PLIST"; then
	# Even a failed-looking bootstrap sometimes registers the job — kickstart
	# it; only report failure if the service really is not there.
	sleep 1
	launchctl kickstart "system/$LABEL" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
fi

echo "4/7 install root-owned auto-apply helpers"
bootout_and_wait "$AUTO_LABEL"
install -d -m 755 -o root -g wheel "$SUPPORT_DIR"
install -d -m 755 -o root -g wheel /etc/newsyslog.d
install -m 755 -o root -g wheel "$DEPLOY/auto-apply.sh" "$SUPPORT_DIR/auto-apply.sh"
install -m 755 -o root -g wheel "$DEPLOY/apply-dns.sh" "$SUPPORT_DIR/apply-dns.sh"
install -m 755 -o root -g wheel "$DEPLOY/apply-edits.sh" "$SUPPORT_DIR/apply-edits.sh"
install -m 644 -o root -g wheel "$DEPLOY/apply-edits.mjs" "$SUPPORT_DIR/apply-edits.mjs"
install -m 644 -o root -g wheel "$DEPLOY/$AUTO_LABEL.newsyslog.conf" "$AUTO_NEWSYSLOG"
touch "$AUTO_LOG"
chown root:wheel "$AUTO_LOG"
chmod 644 "$AUTO_LOG"

echo "5/7 apply anything already staged"
/bin/bash "$SUPPORT_DIR/apply-dns.sh" --from-install
/bin/bash "$SUPPORT_DIR/apply-edits.sh" --from-install

echo "6/7 install + bootstrap $AUTO_LABEL"
install -m 644 -o root -g wheel "$DEPLOY/$AUTO_LABEL.plist" "$AUTO_PLIST"
bootout_and_wait "$AUTO_LABEL"
if ! launchctl bootstrap system "$AUTO_PLIST"; then
	sleep 1
	launchctl kickstart "system/$AUTO_LABEL" 2>/dev/null || launchctl load -w "$AUTO_PLIST" 2>/dev/null || true
fi

echo "7/7 verify"
sleep 2
verified=1
if launchctl print "system/$LABEL" >/dev/null 2>&1; then
	echo "  daemon: registered"
else
	echo "  daemon: NOT registered"
	verified=0
fi
if launchctl print "system/$AUTO_LABEL" >/dev/null 2>&1; then
	echo "  auto-apply: registered"
else
	echo "  auto-apply: NOT registered"
	verified=0
fi
/usr/sbin/newsyslog -n -f "$AUTO_NEWSYSLOG" >/dev/null 2>&1 && echo "  activity retention: 30 daily archives" || { echo "  activity retention: invalid configuration"; verified=0; }
/usr/bin/nc -z -w 5 127.0.49.49 443 >/dev/null 2>&1 && echo "  HTTPS listener: reachable" || echo "  HTTPS listener: not reachable yet"
[ "$verified" -eq 1 ] || { echo "Install incomplete; inspect the logs above." >&2; exit 1; }
echo "Done. UI: http://127.0.0.1:4950/ingress"
echo "Logs: /Library/Logs/$LABEL.log and /Library/Logs/$AUTO_LABEL.log"

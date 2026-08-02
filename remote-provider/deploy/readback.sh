#!/bin/sh
set -eu

provider_user=dockmaster-provider
provider_home=/var/lib/dockmaster-provider-user

id "$provider_user" >/dev/null
if id -nG "$provider_user" | tr ' ' '\n' | grep -Fx docker >/dev/null 2>&1; then
  echo "provider user must not belong to docker" >&2
  exit 1
fi
test "$(stat -c %U:%G /usr/local/libexec/dockmaster-provider/remote_provider.py)" = root:root
test "$(stat -c %a /etc/dockmaster-provider/manifest.json)" = 600
test "$(stat -c %a /var/log/dockmaster-provider/audit.jsonl)" = 600
grep -F 'restrict,command="/usr/local/bin/dockmaster-provider-ssh"' "$provider_home/.ssh/authorized_keys" >/dev/null
visudo -cf /etc/sudoers.d/dockmaster-provider >/dev/null
sudo -u "$provider_user" sudo -n -l | grep -F '/usr/local/sbin/dockmaster-provider-root ""' >/dev/null

echo "dockmaster provider readback passed"

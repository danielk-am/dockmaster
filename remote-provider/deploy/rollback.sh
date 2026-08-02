#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "rollback must run as root" >&2
  exit 1
fi

rm -f /etc/sudoers.d/dockmaster-provider
rm -f /usr/local/bin/dockmaster-provider-ssh
rm -f /usr/local/sbin/dockmaster-provider-root
rm -rf /usr/local/libexec/dockmaster-provider
rm -rf /etc/dockmaster-provider
rm -rf /var/lib/dockmaster-provider
if id dockmaster-provider >/dev/null 2>&1; then
  userdel --remove dockmaster-provider >/dev/null 2>&1 || userdel dockmaster-provider
fi

echo "dockmaster provider rolled back; audit records were preserved in /var/log/dockmaster-provider"

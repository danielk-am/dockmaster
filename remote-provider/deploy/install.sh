#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install must run as root" >&2
  exit 1
fi

stage_dir=${1:?usage: install.sh STAGE_DIR AUTHORIZED_KEY_FILE MANIFEST_FILE}
key_file=${2:?usage: install.sh STAGE_DIR AUTHORIZED_KEY_FILE MANIFEST_FILE}
manifest_file=${3:?usage: install.sh STAGE_DIR AUTHORIZED_KEY_FILE MANIFEST_FILE}
provider_user=dockmaster-provider
provider_home=/var/lib/dockmaster-provider-user
library_dir=/usr/local/libexec/dockmaster-provider

test -f "$stage_dir/remote_provider.py"
test -f "$key_file"
test -f "$manifest_file"
ssh-keygen -l -f "$key_file" >/dev/null
key_type=$(awk 'NR == 1 {print $1}' "$key_file")
key_body=$(awk 'NR == 1 {print $2}' "$key_file")
key_lines=$(wc -l < "$key_file" | tr -d ' ')
case "$key_type" in
  ssh-ed25519|sk-ssh-ed25519@openssh.com) ;;
  *) echo "provider key must be Ed25519" >&2; exit 1 ;;
esac
if [ -z "$key_body" ] || [ "$key_lines" -ne 1 ]; then
  echo "provider key file must contain one public key" >&2
  exit 1
fi

/usr/bin/python3 -m py_compile "$stage_dir/remote_provider.py"

if ! id "$provider_user" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$provider_home" --shell /bin/sh \
    --comment "Dockmaster forced-command provider" "$provider_user"
fi
usermod --lock "$provider_user"
if id -nG "$provider_user" | tr ' ' '\n' | grep -Fx docker >/dev/null 2>&1; then
  gpasswd --delete "$provider_user" docker >/dev/null
fi

install -d -o root -g root -m 0755 "$library_dir"
install -o root -g root -m 0755 "$stage_dir/remote_provider.py" "$library_dir/remote_provider.py"
install -o root -g root -m 0755 "$stage_dir/dockmaster-provider-ssh" /usr/local/bin/dockmaster-provider-ssh
install -o root -g root -m 0755 "$stage_dir/dockmaster-provider-root" /usr/local/sbin/dockmaster-provider-root
install -d -o root -g root -m 0700 /etc/dockmaster-provider
install -o root -g root -m 0600 "$manifest_file" /etc/dockmaster-provider/manifest.json
install -d -o root -g root -m 0700 /var/lib/dockmaster-provider
install -d -o root -g root -m 0700 /var/log/dockmaster-provider
touch /var/log/dockmaster-provider/audit.jsonl
chown root:root /var/log/dockmaster-provider/audit.jsonl
chmod 0600 /var/log/dockmaster-provider/audit.jsonl

install -d -o "$provider_user" -g "$provider_user" -m 0700 "$provider_home/.ssh"
printf 'restrict,command="/usr/local/bin/dockmaster-provider-ssh" %s %s dockmaster-provider\n' \
  "$key_type" "$key_body" > "$provider_home/.ssh/authorized_keys"
chown "$provider_user:$provider_user" "$provider_home/.ssh/authorized_keys"
chmod 0600 "$provider_home/.ssh/authorized_keys"

install -o root -g root -m 0440 "$stage_dir/dockmaster-provider.sudoers" /etc/sudoers.d/dockmaster-provider
visudo -cf /etc/sudoers.d/dockmaster-provider >/dev/null

/usr/bin/python3 "$library_dir/remote_provider.py" \
  --manifest /etc/dockmaster-provider/manifest.json \
  --forced-command 'dockmaster-provider inventory' >/dev/null

echo "dockmaster provider installed"

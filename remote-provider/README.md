# Restricted remote provider

This provider lets Localhost Manager inventory and operate only explicitly listed
Docker Compose services on a remote Linux host. It uses a forced SSH command,
a locked system account without Docker group membership, and a root helper
whose request grammar, manifest targets, actions, paths, and output are
validated before use.

## Configure the server

Localhost Manager enables the adapter only when all three variables are present:

```sh
export DOCKMASTER_REMOTE_PROVIDER_HOST=provider.example
export DOCKMASTER_REMOTE_PROVIDER_IDENTITY_FILE=/absolute/path/to/provider-key
export DOCKMASTER_REMOTE_PROVIDER_ALLOWLIST='{"example-mcp":{"example-mcp":["start","stop","restart","pull"]}}'
```

The SSH path and remote user are fixed in code. The identity file must be an
absolute path outside temporary directories. The allowlist must exactly match
the private manifest installed on the remote host. An empty action list makes
a service inventory-only.

## Install the remote side

Copy `manifest.example.json` to a private path, replace every example value,
pin the validation image by its local SHA-256 image ID, and keep that private
manifest out of this repository. Then run:

```sh
sudo ./install.sh STAGE_DIR AUTHORIZED_KEY_FILE PRIVATE_MANIFEST_FILE
sudo ./readback.sh
```

The installer accepts one Ed25519 public key. It installs a forced command,
root-owned code and manifest, a narrow sudoers entry, private state, and an
append-only audit log. The example blocks standard Coolify-managed roots so a
Localhost Manager manifest cannot take ownership of Coolify services.

`rollback.sh` removes the provider account, command wrappers, manifest, and
state. It preserves the audit log.

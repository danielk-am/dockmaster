# Node MCP fixture

A minimal, modern-only Streamable HTTP fixture for Dockmaster validation. It
serves MCP at `/mcp`, readiness at `/healthz`, and keeps all tool state in
memory so the write journey can be undone without an external effect.

## Contract

- MCP protocol `2026-07-28` only; legacy `initialize` is rejected.
- `fixture_state_read` reads the current value and revision.
- `fixture_state_change` sets a bounded string or undoes the most recent set.
- Bearer authentication comes from `NODE_MCP_BEARER_SECRET`.
- `NODE_MCP_ALLOWED_HOSTS` is a comma-separated hostname allowlist.
- `NODE_MCP_ALLOWED_ORIGINS` is a comma-separated list of exact HTTP(S)
  origins. Requests without `Origin` remain valid for non-browser MCP clients.
- Logs contain request metadata only, never headers, bodies, bearer values, or
  tool arguments.

## Local verification

```sh
npm ci --ignore-scripts
npm test
npm run build

export NODE_MCP_BEARER_SECRET="$(openssl rand -hex 32)"
export NODE_MCP_ALLOWED_ORIGINS=https://fixture.test
export NODE_MCP_HOST_PORT=18787
docker compose -p node-mcp-fixture-local up --build --wait
docker compose -p node-mcp-fixture-local down --remove-orphans
```

Use a unique Compose project and host port for concurrent sandboxes. The
Compose network is project-scoped, the published port is loopback-only, and
the container runs as UID/GID 1000 with a read-only root filesystem, no Linux
capabilities, and `no-new-privileges`.

The environment variable is a runtime injection mechanism, not a secret
manager. Production delivery must supply it through the authorized secret
source and must not place the value in Compose files, Plane, or logs.

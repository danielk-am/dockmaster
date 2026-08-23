#!/usr/bin/env bash
set -euo pipefail

compose=/opt/gdrive-mcp/docker-compose.yml
project_dir=/opt/gdrive-mcp
dynamic=/data/coolify/proxy/dynamic/dockmaster-gdrive-auth.yaml
backup=/root/orch26-gdrive-auth-backup-20260802T1015Z/docker-compose.yml
container=gdrive-mcp

if [ ! -f "$backup" ] || [ "$(stat -c '%U:%G:%a' "$backup")" != root:root:600 ]; then
  echo 'root-only ORCH-26 rollback copy is unavailable' >&2
  exit 1
fi

restore_tmp=$(mktemp "$project_dir/.docker-compose.orch26-rollback.XXXXXX")
install -o root -g root -m 0644 "$backup" "$restore_tmp"
mv -f "$restore_tmp" "$compose"
if [ -e "$dynamic" ]; then
  unlink "$dynamic"
fi
docker compose --project-directory "$project_dir" -f "$compose" -p gdrive-mcp \
  up -d --force-recreate --no-deps gdrive-mcp >/dev/null

count=0
while [ "$count" -lt 30 ]; do
  if [ "$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || true)" = running ]; then
    break
  fi
  sleep 1
  count=$((count + 1))
done
if [ "$(docker inspect "$container" --format '{{.State.Status}}')" != running ]; then
  echo 'gdrive rollback container did not become running' >&2
  exit 1
fi
if [ -z "$(docker inspect "$container" --format '{{ index .Config.Labels "traefik.http.middlewares.gdrive-auth.basicauth.users" }}')" ]; then
  echo 'gdrive rollback label readback failed' >&2
  exit 1
fi
if [ "$(docker inspect "$container" --format '{{ index .Config.Labels "traefik.http.routers.gdrivemcp-https.middlewares" }}')" != gdrive-auth ]; then
  echo 'gdrive rollback middleware readback failed' >&2
  exit 1
fi
echo 'ORCH-26 gdrive auth rollback passed'

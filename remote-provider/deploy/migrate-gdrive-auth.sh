#!/usr/bin/env bash
set -euo pipefail

compose=/opt/gdrive-mcp/docker-compose.yml
project_dir=/opt/gdrive-mcp
dynamic=/data/coolify/proxy/dynamic/dockmaster-gdrive-auth.yaml
backup=/root/orch26-gdrive-auth-backup-20260802T1015Z
container=gdrive-mcp
service=gdrive-mcp
domain=gdrive-mcp.danielk.am
label_key=traefik.http.middlewares.gdrive-auth.basicauth.users
router_key=traefik.http.routers.gdrivemcp-https.middlewares
new_middleware=dockmaster-gdrive-auth@file
validation_container=orch26-gdrive-traefik-validate
changed=0
success=0

compose_up() {
  docker compose --project-directory "$project_dir" -f "$compose" -p gdrive-mcp \
    up -d --force-recreate --no-deps "$service" >/dev/null
}

wait_running() {
  local count status
  count=0
  while [ "$count" -lt 30 ]; do
    status=$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || true)
    if [ "$status" = running ]; then
      return 0
    fi
    sleep 1
    count=$((count + 1))
  done
  return 1
}

direct_health_code() {
  local address
  address=$(docker inspect "$container" --format '{{with index .NetworkSettings.Networks "coolify"}}{{.IPAddress}}{{end}}')
  case "$address" in
    ""|*[!0-9a-fA-F:.]*) return 1 ;;
  esac
  curl --connect-timeout 3 --max-time 8 --silent --show-error \
    --output /dev/null --write-out '%{http_code}' "http://$address:8000/healthz"
}

wait_direct_health_code() {
  local code count
  count=0
  while [ "$count" -lt 30 ]; do
    code=$(direct_health_code 2>/dev/null || true)
    if [ "$code" = 200 ]; then
      printf '%s' "$code"
      return 0
    fi
    sleep 1
    count=$((count + 1))
  done
  return 1
}

public_auth_probe() {
  local headers=$1
  : >"$headers"
  chmod 0600 "$headers"
  curl --connect-timeout 5 --max-time 12 --silent --show-error --insecure \
    --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
    "https://$domain/healthz"
}

auth_challenge() {
  local headers=$1
  awk 'tolower($0) ~ /^www-authenticate:/ {
    sub(/\r$/, "");
    print tolower($0);
  }' "$headers"
}

rollback_on_error() {
  local result=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$success" -ne 1 ] && [ "$changed" -eq 1 ]; then
    restore_tmp=$(mktemp "$project_dir/.docker-compose.orch26-rollback.XXXXXX")
    install -o root -g root -m 0644 "$backup/docker-compose.yml" "$restore_tmp"
    mv -f "$restore_tmp" "$compose"
    if [ -e "$dynamic" ]; then
      unlink "$dynamic"
    fi
    compose_up
    wait_running
    echo 'ORCH-26 automatic rollback completed' >&2
  fi
  docker rm -f "$validation_container" >/dev/null 2>&1 || true
  exit "$result"
}
trap rollback_on_error EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -f "$compose" ] || [ -e "$dynamic" ] || [ -e "$backup" ]; then
  echo 'ORCH-26 precondition failed' >&2
  exit 1
fi
if [ "$(stat -c '%U:%G' "$compose")" != root:root ]; then
  echo 'gdrive Compose ownership is unexpected' >&2
  exit 1
fi
if [ "$(docker inspect coolify-proxy --format '{{if .Config.User}}{{.Config.User}}{{else}}root-default{{end}}')" != root-default ]; then
  echo 'Coolify proxy is not running with root file access' >&2
  exit 1
fi

auth_value=$(docker inspect "$container" --format "{{ index .Config.Labels \"$label_key\" }}")
case "$auth_value" in
  ""|*[!A-Za-z0-9_.@+:$/-]*)
    echo 'existing Basic Auth label shape is unsupported' >&2
    exit 1
    ;;
esac
if [[ "$auth_value" != *:* ]] || [ "${#auth_value}" -gt 256 ]; then
  echo 'existing Basic Auth label shape is unsupported' >&2
  exit 1
fi
if [ "$(docker inspect "$container" --format "{{ index .Config.Labels \"$router_key\" }}")" != gdrive-auth ]; then
  echo 'existing gdrive router middleware is unexpected' >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$backup"
install -o root -g root -m 0600 "$compose" "$backup/docker-compose.yml"
before_headers="$backup/public-before.headers"
after_headers="$backup/public-after.headers"
before_code=$(public_auth_probe "$before_headers")
before_direct=$(direct_health_code)
before_challenge=$(auth_challenge "$before_headers")
if [ "$before_code" != 401 ] || [ "$before_direct" != 200 ] || [[ "$before_challenge" != www-authenticate:*basic* ]]; then
  echo 'pre-migration service/auth baseline failed' >&2
  exit 1
fi
if [ "$(curl --connect-timeout 5 --max-time 12 --silent --show-error --insecure \
  --user invalid:invalid --output /dev/null --write-out '%{http_code}' \
  "https://$domain/healthz")" != 401 ]; then
  echo 'pre-migration invalid-auth baseline failed' >&2
  exit 1
fi

dynamic_tmp=$(mktemp /data/coolify/proxy/dynamic/.dockmaster-gdrive-auth.XXXXXX)
chmod 0600 "$dynamic_tmp"
{
  printf '%s\n' 'http:'
  printf '%s\n' '  middlewares:'
  printf '%s\n' '    dockmaster-gdrive-auth:'
  printf '%s\n' '      basicAuth:'
  printf '%s\n' '        users:'
  printf "          - '%s'\n" "$auth_value"
} >"$dynamic_tmp"
chown root:root "$dynamic_tmp"
mv -f "$dynamic_tmp" "$dynamic"

compose_tmp=$(mktemp "$project_dir/.docker-compose.orch26.XXXXXX")
python3 - "$compose" "$compose_tmp" "$new_middleware" <<'PY'
from pathlib import Path
import sys

source, target, middleware = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
lines = source.read_text(encoding="utf-8").splitlines()
auth_lines = [line for line in lines if "traefik.http.middlewares.gdrive-auth.basicauth.users=" in line]
router_lines = [line for line in lines if "traefik.http.routers.gdrivemcp-https.middlewares=" in line]
if len(auth_lines) != 1 or len(router_lines) != 1:
    raise SystemExit("unexpected gdrive label shape")
result = []
for line in lines:
    if "traefik.http.middlewares.gdrive-auth.basicauth.users=" in line:
        continue
    if "traefik.http.routers.gdrivemcp-https.middlewares=" in line:
        prefix = line.split("traefik.http.routers.gdrivemcp-https.middlewares=", 1)[0]
        line = prefix + "traefik.http.routers.gdrivemcp-https.middlewares=" + middleware
    result.append(line)
target.write_text("\n".join(result) + "\n", encoding="utf-8")
PY
chown root:root "$compose_tmp"
chmod 0644 "$compose_tmp"
mv -f "$compose_tmp" "$compose"
changed=1

docker compose --project-directory "$project_dir" -f "$compose" -p gdrive-mcp config --quiet
if grep -q 'basicauth.users' "$compose"; then
  echo 'Basic Auth secret remains in Compose' >&2
  exit 1
fi
if [ "$(stat -c '%U:%G:%a' "$dynamic")" != root:root:600 ]; then
  echo 'dynamic auth file permissions are not root-only' >&2
  exit 1
fi
found=0
while IFS= read -r line; do
  if [ "$line" = "          - '$auth_value'" ]; then
    found=$((found + 1))
  fi
done <"$dynamic"
if [ "$found" -ne 1 ]; then
  echo 'moved Basic Auth hash readback failed' >&2
  exit 1
fi

validation_dir=$(mktemp -d "$backup/validation.XXXXXX")
chmod 0700 "$validation_dir"
{
  printf '%s\n' 'entryPoints:'
  printf '%s\n' '  validation:'
  printf '%s\n' '    address: ":8088"'
  printf '%s\n' 'providers:'
  printf '%s\n' '  file:'
  printf '%s\n' '    filename: /dynamic/dockmaster-gdrive-auth.yaml'
  printf '%s\n' 'log:'
  printf '%s\n' '  level: ERROR'
} >"$validation_dir/traefik.yaml"
chmod 0600 "$validation_dir/traefik.yaml"
proxy_image=$(docker inspect coolify-proxy --format '{{.Image}}')
case "$proxy_image" in sha256:[0-9a-f][0-9a-f]*) ;; *) echo 'proxy image is not digest-addressed' >&2; exit 1;; esac
set +e
timeout 5 docker run --rm --name "$validation_container" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 128m --cpus 0.25 --pids-limit 64 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
  -v "$validation_dir/traefik.yaml:/etc/traefik/traefik.yaml:ro" \
  -v "$dynamic:/dynamic/dockmaster-gdrive-auth.yaml:ro" \
  "$proxy_image" --configFile=/etc/traefik/traefik.yaml \
  >"$backup/traefik-validation.log" 2>&1
validation_status=$?
set -e
if [ "$validation_status" -ne 124 ] || grep -Eiq '(^|[[:space:]])ERR(OR)?([[:space:]]|$)|failed|invalid' "$backup/traefik-validation.log"; then
  echo 'isolated Traefik validation failed' >&2
  exit 1
fi

# Force a second file-provider event and allow Traefik's provider throttle window
# to settle before the Docker router starts referencing the new middleware.
touch "$dynamic"
sleep 3
proxy_check_since=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
compose_up
wait_running
count=0
while [ "$count" -lt 20 ]; do
  after_code=$(public_auth_probe "$after_headers" || true)
  if [ "$after_code" = 401 ]; then
    break
  fi
  sleep 1
  count=$((count + 1))
done
after_direct=$(wait_direct_health_code)
after_challenge=$(auth_challenge "$after_headers")
if [ "$after_code" != 401 ] || [ "$after_direct" != 200 ] || [ "$after_challenge" != "$before_challenge" ]; then
  echo 'post-migration service/auth readback failed' >&2
  exit 1
fi
if [ "$(curl --connect-timeout 5 --max-time 12 --silent --show-error --insecure \
  --user invalid:invalid --output /dev/null --write-out '%{http_code}' \
  "https://$domain/healthz")" != 401 ]; then
  echo 'post-migration invalid-auth readback failed' >&2
  exit 1
fi
if [ -n "$(docker inspect "$container" --format "{{ index .Config.Labels \"$label_key\" }}")" ]; then
  echo 'Basic Auth secret remains in the container label' >&2
  exit 1
fi
if [ "$(docker inspect "$container" --format "{{ index .Config.Labels \"$router_key\" }}")" != "$new_middleware" ]; then
  echo 'gdrive router does not reference the file middleware' >&2
  exit 1
fi
if docker logs --since "$proxy_check_since" coolify-proxy 2>&1 \
  | grep -Fq 'middleware "dockmaster-gdrive-auth@file" does not exist'; then
  echo 'Traefik observed the Docker router before the file middleware' >&2
  exit 1
fi

success=1
trap - EXIT HUP INT TERM
echo 'ORCH-26 gdrive auth migration passed'
echo 'old-location-compose-secret|absent'
echo 'old-location-container-label-secret|absent'
echo 'new-location|root:root:600'
echo 'public-auth-gate|401-basic-before-and-after'
echo 'invalid-auth|401-before-and-after'
echo 'direct-service-health|200-before-and-after'
echo 'rollback-copy|root-only'

#!/usr/bin/env python3
"""Restricted remote Docker provider used by Dockmaster's forced SSH command."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from typing import Callable, Iterable


MANIFEST_SCHEMA = "dockmaster-provider/v1"
PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
SERVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
HOST_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$"
)
ALLOWED_ACTIONS = {"start", "stop", "restart", "pull"}
ALLOWED_ENTRYPOINTS = {"http", "https"}
IMAGE_DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")


class ManifestError(ValueError):
    pass


def _under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _has_symlink(path: Path) -> bool:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            return True
    return False


def _secret_keys(value: object, prefix: str = "") -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key).lower()
            current = f"{prefix}.{key}" if prefix else str(key)
            if any(word in key_text for word in ("authorization", "bearer", "password", "secret", "token", "users")):
                yield current
            yield from _secret_keys(child, current)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _secret_keys(child, f"{prefix}[{index}]")


def validate_manifest(manifest: dict) -> dict:
    if not isinstance(manifest, dict) or manifest.get("schema") != MANIFEST_SCHEMA:
        raise ManifestError(f"manifest schema must be {MANIFEST_SCHEMA}")
    blocked = [Path(item).resolve(strict=False) for item in manifest.get("blocked_roots", [])]
    if not blocked or not all(path.is_absolute() for path in blocked):
        raise ManifestError("blocked roots must be absolute and non-empty")
    route_file = Path(str(manifest.get("route_file") or ""))
    if not route_file.is_absolute() or route_file.name != "dockmaster-managed.yaml":
        raise ManifestError("route file must be the dedicated dockmaster-managed.yaml path")
    if not IMAGE_DIGEST_RE.fullmatch(str(manifest.get("traefik_validation_image") or "")):
        raise ManifestError("Traefik validation image must be pinned by sha256 digest")

    projects = manifest.get("projects")
    if not isinstance(projects, list):
        raise ManifestError("projects must be a list")
    seen_projects: set[str] = set()
    for project in projects:
        if not isinstance(project, dict):
            raise ManifestError("project must be an object")
        project_id = str(project.get("id") or "")
        compose_project = str(project.get("project") or "")
        if not PROJECT_RE.fullmatch(project_id) or not PROJECT_RE.fullmatch(compose_project):
            raise ManifestError("project identifiers must be lowercase kebab case")
        if project_id in seen_projects:
            raise ManifestError(f"duplicate project {project_id}")
        seen_projects.add(project_id)

        compose_dir_input = Path(str(project.get("compose_dir") or ""))
        compose_file_input = Path(str(project.get("compose_file") or ""))
        if not compose_dir_input.is_absolute() or not compose_file_input.is_absolute():
            raise ManifestError(f"{project_id}: Compose paths must be absolute")
        if _has_symlink(compose_dir_input) or _has_symlink(compose_file_input):
            raise ManifestError(f"{project_id}: Compose paths may not traverse a symlink")
        compose_dir = compose_dir_input.resolve(strict=False)
        compose_file = compose_file_input.resolve(strict=False)
        if not _under(compose_file, compose_dir) or compose_file == compose_dir:
            raise ManifestError(f"{project_id}: Compose file must be inside its directory")
        if any(_under(compose_dir, root) for root in blocked):
            raise ManifestError(f"{project_id}: Compose path is inside a blocked root")
        if not compose_dir.is_dir() or not compose_file.is_file():
            raise ManifestError(f"{project_id}: Compose path does not exist")
        ownership = (
            (compose_dir, "compose_dir_uid", "compose_dir_gid"),
            (compose_file, "compose_file_uid", "compose_file_gid"),
        )
        for owned_path, uid_key, gid_key in ownership:
            expected_uid = project.get(uid_key)
            expected_gid = project.get(gid_key)
            if not isinstance(expected_uid, int) or expected_uid < 0:
                raise ManifestError(f"{project_id}: expected ownership is required")
            if not isinstance(expected_gid, int) or expected_gid < 0:
                raise ManifestError(f"{project_id}: expected ownership is required")
            observed = owned_path.stat()
            if observed.st_uid != expected_uid or observed.st_gid != expected_gid:
                raise ManifestError(f"{project_id}: Compose path ownership mismatch")
            if observed.st_mode & 0o022:
                raise ManifestError(f"{project_id}: Compose paths may not be group or world writable")
        if project.get("owner") not in {"dockmaster", "manual"}:
            raise ManifestError(f"{project_id}: owner must be dockmaster or manual")
        if not str(project.get("rollback") or "").strip():
            raise ManifestError(f"{project_id}: rollback is required")

        services = project.get("services")
        if not isinstance(services, list) or not services:
            raise ManifestError(f"{project_id}: at least one service is required")
        seen_services: set[str] = set()
        services_by_name: dict[str, dict] = {}
        for service in services:
            name = str((service or {}).get("name") or "")
            if not SERVICE_RE.fullmatch(name) or "*" in name:
                raise ManifestError(f"{project_id}: invalid service name")
            if name in seen_services:
                raise ManifestError(f"{project_id}: duplicate service {name}")
            seen_services.add(name)
            services_by_name[name] = service
            actions = service.get("actions")
            if not isinstance(actions, list) or len(actions) != len(set(actions)):
                raise ManifestError(f"{project_id}/{name}: actions must be a unique list")
            if not set(actions).issubset(ALLOWED_ACTIONS):
                raise ManifestError(f"{project_id}/{name}: unsupported action")
            port = service.get("internal_port")
            if port is not None and (not isinstance(port, int) or not 1 <= port <= 65535):
                raise ManifestError(f"{project_id}/{name}: internal port must be 1-65535")

        route = project.get("route")
        if route is not None:
            if not isinstance(route, dict):
                raise ManifestError(f"{project_id}: route must be an object")
            secret_fields = list(_secret_keys(route))
            if secret_fields:
                raise ManifestError(f"{project_id}: route contains a secret field")
            if not HOST_RE.fullmatch(str(route.get("hostname") or "")):
                raise ManifestError(f"{project_id}: route hostname is invalid")
            if route.get("entrypoint") not in ALLOWED_ENTRYPOINTS:
                raise ManifestError(f"{project_id}: route entrypoint is invalid")
            if route.get("service") not in seen_services:
                raise ManifestError(f"{project_id}: route service is not declared")
            routed_service = services_by_name[route["service"]]
            if not isinstance(routed_service.get("internal_port"), int):
                raise ManifestError(f"{project_id}: routed service requires an internal port")
    return manifest


def default_runner(argv: list[str], *, input_text: str | None = None, timeout: int = 30):
    completed = subprocess.run(
        argv,
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
        env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
    )
    return completed.returncode, completed.stdout, completed.stderr


def make_traefik_validator(
    runner: Callable,
    image_digest: str,
    *,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> Callable[[Path], tuple[bool, str]]:
    """Validate a generated dynamic file in a disposable, isolated Traefik."""
    if not IMAGE_DIGEST_RE.fullmatch(image_digest):
        raise ValueError("Traefik validation image must be pinned by sha256 digest")

    def validate(candidate: Path) -> tuple[bool, str]:
        candidate = candidate.resolve(strict=True)
        if not candidate.is_file():
            return False, "candidate is not a regular file"
        name = f"dockmaster-traefik-validate-{uuid.uuid4().hex[:12]}"
        mount = f"type=bind,src={candidate},dst=/dynamic/dockmaster-managed.yaml,readonly"
        started = False
        try:
            rc, stdout, _stderr = runner(
                [
                    "docker",
                    "run",
                    "--detach",
                    "--rm",
                    "--name",
                    name,
                    "--network=none",
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "--pids-limit=64",
                    "--memory=128m",
                    "--cpus=0.25",
                    "--user=65532:65532",
                    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
                    "--mount",
                    mount,
                    image_digest,
                    "--providers.file.filename=/dynamic/dockmaster-managed.yaml",
                    "--providers.file.watch=false",
                    "--entrypoints.http.address=:8080",
                    "--entrypoints.https.address=:8443",
                    "--api=false",
                    "--log.level=ERROR",
                ],
                timeout=30,
            )
            if rc:
                return False, "Traefik validation container did not start"
            started = bool(stdout.strip())
            sleep_fn(1.0)
            rc, running, _stderr = runner(
                ["docker", "inspect", "--format", "{{.State.Running}}", name], timeout=10
            )
            if rc or running.strip().lower() != "true":
                return False, "Traefik validation container exited"
            rc, logs, _stderr = runner(["docker", "logs", "--tail", "200", name], timeout=10)
            if rc:
                return False, "Traefik validation logs were unavailable"
            if re.search(r"(?:level=error|\"level\"\s*:\s*\"error\"|\bERR\b)", logs[:65536], re.IGNORECASE):
                return False, "Traefik reported a dynamic configuration error"
            return True, "isolated Traefik parser remained healthy"
        finally:
            if started:
                runner(["docker", "rm", "--force", name], timeout=20)

    return validate


class Provider:
    def __init__(
        self,
        manifest: dict,
        *,
        runner: Callable = default_runner,
        audit_file: Path | str = "/var/log/dockmaster-provider/audit.jsonl",
        cache_file: Path | str = "/var/lib/dockmaster-provider/inventory.json",
        route_validator: Callable[[Path], tuple[bool, str]] | None = None,
    ):
        self.manifest = validate_manifest(manifest)
        self.runner = runner
        self.audit_file = Path(audit_file)
        self.cache_file = Path(cache_file)
        self.route_file = Path(self.manifest["route_file"])
        self.route_validator = route_validator
        self.projects = {project["id"]: project for project in self.manifest["projects"]}

    @staticmethod
    def _write_private_json(path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _audit(self, *, actor: str, action: str, target: str, result: str, **fields) -> None:
        self.audit_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        record = {
            "request_id": uuid.uuid4().hex,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "actor": actor,
            "action": action,
            "target": target,
            "result": result,
            **fields,
        }
        descriptor = os.open(self.audit_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            os.write(descriptor, (json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n").encode())
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _service(self, project_id: str, service_name: str):
        project = self.projects.get(project_id)
        if project is None:
            raise KeyError(f"unknown project {project_id}")
        service = next((item for item in project["services"] if item["name"] == service_name), None)
        if service is None:
            raise KeyError(f"unknown service {project_id}/{service_name}")
        return project, service

    def _inspect(self, project: dict, service: dict) -> list[dict]:
        rc, stdout, stderr = self.runner(
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                f"label=com.docker.compose.project={project['project']}",
                "--filter",
                f"label=com.docker.compose.service={service['name']}",
                "-q",
            ],
            timeout=15,
        )
        if rc:
            raise RuntimeError(f"Docker discovery failed: {stderr.strip()[:200]}")
        ids = stdout.split()
        if not ids:
            return []
        rc, stdout, stderr = self.runner(["docker", "inspect", *ids], timeout=20)
        if rc:
            raise RuntimeError(f"Docker inspect failed: {stderr.strip()[:200]}")
        containers = json.loads(stdout)
        expected_dir = str(Path(project["compose_dir"]).resolve(strict=False))
        for container in containers:
            labels = (container.get("Config") or {}).get("Labels") or {}
            observed_dir = str(Path(labels.get("com.docker.compose.project.working_dir") or "").resolve(strict=False))
            if observed_dir != expected_dir:
                raise RuntimeError(f"Compose ownership mismatch for {project['id']}/{service['name']}")
        return containers

    @staticmethod
    def _summary(project: dict, service: dict, containers: list[dict]) -> dict:
        rows = []
        for container in containers:
            state = container.get("State") or {}
            ports = []
            for socket, bindings in ((container.get("NetworkSettings") or {}).get("Ports") or {}).items():
                for binding in bindings or []:
                    ports.append(
                        {
                            "container": socket,
                            "host_ip": binding.get("HostIp") or "",
                            "host_port": binding.get("HostPort") or "",
                        }
                    )
            rows.append(
                {
                    "id": str(container.get("Id") or "")[:12],
                    "container": str(container.get("Name") or "").lstrip("/"),
                    "image": (container.get("Config") or {}).get("Image") or "",
                    "state": state.get("Status") or "missing",
                    "health": (state.get("Health") or {}).get("Status"),
                    "ports": ports,
                }
            )
        if not rows:
            state, health, image = "missing", None, None
        else:
            states = {row["state"] for row in rows}
            healths = {row["health"] for row in rows if row["health"]}
            state = rows[0]["state"] if len(states) == 1 else "mixed"
            health = rows[0]["health"] if len(healths) <= 1 else "mixed"
            image = rows[0]["image"] if len({row["image"] for row in rows}) == 1 else "mixed"
        return {
            "name": service["name"],
            "state": state,
            "health": health,
            "image": image,
            "ports": [port for row in rows for port in row["ports"]],
            "containers": rows,
            "actions": list(service["actions"]),
            "internal_port": service["internal_port"],
            "health_path": service.get("health_path"),
            "owner": project["owner"],
        }

    def inventory(self) -> dict:
        projects = []
        for project in self.manifest["projects"]:
            services = [self._summary(project, service, self._inspect(project, service)) for service in project["services"]]
            projects.append(
                {
                    "id": project["id"],
                    "project": project["project"],
                    "owner": project["owner"],
                    "route": project.get("route"),
                    "services": services,
                }
            )
        result = {
            "schema": "dockmaster-provider-inventory/v1",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "projects": projects,
        }
        self._write_private_json(self.cache_file, result)
        return result

    def action(self, project_id: str, service_name: str, action: str, *, actor: str) -> dict:
        target = f"{project_id}/{service_name}"
        try:
            project, service = self._service(project_id, service_name)
        except KeyError:
            self._audit(actor=actor, action=action, target=target, result="refused", reason="unknown target")
            raise PermissionError("target is not allowlisted")
        if action not in service["actions"] or action not in ALLOWED_ACTIONS:
            self._audit(actor=actor, action=action, target=target, result="refused", reason="action not allowlisted")
            raise PermissionError("action is not allowlisted")
        before = self._summary(project, service, self._inspect(project, service))
        argv = [
            "docker",
            "compose",
            "--project-directory",
            project["compose_dir"],
            "--file",
            project["compose_file"],
            "--project-name",
            project["project"],
            action,
            service_name,
        ]
        rc, _stdout, stderr = self.runner(argv, timeout=300 if action == "pull" else 90)
        if rc:
            self._audit(
                actor=actor,
                action=action,
                target=target,
                result="failed",
                previous_state=before["state"],
                exit_status=rc,
                error=stderr.strip()[:200],
            )
            raise RuntimeError(f"provider action failed: {stderr.strip()[:200]}")
        after = self._summary(project, service, self._inspect(project, service))
        self._audit(
            actor=actor,
            action=action,
            target=target,
            result="ok",
            previous_state=before["state"],
            state=after["state"],
            exit_status=0,
        )
        return {**after, "previous_state": before["state"], "rollback": project["rollback"]}

    def _routes_payload(self) -> dict:
        routers = {}
        services = {}
        for project in self.manifest["projects"]:
            route = project.get("route")
            if not route:
                continue
            name = f"dockmaster-{project['id']}"
            service = next(item for item in project["services"] if item["name"] == route["service"])
            router = {
                "entryPoints": [route["entrypoint"]],
                "rule": f"Host(`{route['hostname']}`)",
                "service": name,
            }
            if route["entrypoint"] == "https":
                router["tls"] = {"certResolver": "letsencrypt"}
            routers[name] = router
            services[name] = {
                "loadBalancer": {
                    "servers": [{"url": f"http://{route['service']}:{service['internal_port']}"}]
                }
            }
        return {"http": {"routers": routers, "services": services}}

    def apply_routes(self, *, actor: str) -> dict:
        if self.route_validator is None:
            raise RuntimeError("route validator is required")
        payload = self._routes_payload()
        self.route_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, candidate_name = tempfile.mkstemp(
            prefix=f".{self.route_file.name}.", suffix=".tmp", dir=self.route_file.parent
        )
        candidate = Path(candidate_name)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            valid, evidence = self.route_validator(candidate)
            if not valid:
                self._audit(actor=actor, action="routes-apply", target=str(self.route_file), result="failed", reason=evidence[:200])
                raise RuntimeError(f"route validation failed: {evidence}")
            os.replace(candidate, self.route_file)
            os.chmod(self.route_file, 0o600)
            routers = sorted(payload["http"]["routers"])
            self._audit(actor=actor, action="routes-apply", target=str(self.route_file), result="ok", routers=routers)
            return {"route_file": str(self.route_file), "routers": routers, "validation": evidence}
        finally:
            try:
                candidate.unlink()
            except FileNotFoundError:
                pass

    def remove_routes(self, *, actor: str) -> dict:
        removed = self.route_file.exists()
        if removed:
            self.route_file.unlink()
        self._audit(actor=actor, action="routes-remove", target=str(self.route_file), result="ok", removed=removed)
        return {"route_file": str(self.route_file), "removed": removed}

    def audit(self, limit: int = 50) -> dict:
        try:
            lines = self.audit_file.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            lines = []
        return {"records": [json.loads(line) for line in lines[-max(1, min(limit, 200)) :]]}


def parse_forced_command(command: str) -> dict:
    if not command or any(character in command for character in ";&|`$<>()\\\n\r"):
        raise ValueError("invalid forced command")
    try:
        parts = shlex.split(command)
    except ValueError as error:
        raise ValueError("invalid forced command") from error
    if parts == ["dockmaster-provider", "inventory"]:
        return {"op": "inventory"}
    if parts == ["dockmaster-provider", "routes", "apply"]:
        return {"op": "routes-apply"}
    if parts == ["dockmaster-provider", "routes", "remove"]:
        return {"op": "routes-remove"}
    if parts == ["dockmaster-provider", "audit"]:
        return {"op": "audit"}
    if len(parts) == 5 and parts[:2] == ["dockmaster-provider", "action"]:
        project, service, action = parts[2:]
        if PROJECT_RE.fullmatch(project) and SERVICE_RE.fullmatch(service) and action in ALLOWED_ACTIONS:
            return {"op": "action", "project": project, "service": service, "action": action}
    raise ValueError("unsupported forced command")


def run_ssh_wrapper(command: str, *, runner: Callable = default_runner) -> tuple[int, str, str]:
    """Translate an SSH original command into one bounded request to the root helper."""
    request = parse_forced_command(command)
    rc, stdout, stderr = runner(
        ["sudo", "-n", "/usr/local/sbin/dockmaster-provider-root"],
        input_text=json.dumps(request, separators=(",", ":")),
        timeout=330,
    )
    if len(stdout.encode("utf-8")) > 1024 * 1024:
        return 1, "", "provider response exceeded limit"
    return rc, stdout, stderr[:512]


def execute(provider: Provider, request: dict, *, actor: str) -> dict:
    operation = request.get("op")
    if operation == "inventory":
        return provider.inventory()
    if operation == "action":
        return provider.action(request["project"], request["service"], request["action"], actor=actor)
    if operation == "routes-apply":
        return provider.apply_routes(actor=actor)
    if operation == "routes-remove":
        return provider.remove_routes(actor=actor)
    if operation == "audit":
        return provider.audit()
    raise ValueError("unsupported provider operation")


def load_manifest(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        return validate_manifest(json.load(handle))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dockmaster-provider-root")
    parser.add_argument("--manifest", default=os.environ.get("DOCKMASTER_PROVIDER_MANIFEST", "/etc/dockmaster-provider/manifest.json"))
    parser.add_argument("--request-stdin", action="store_true")
    parser.add_argument("--forced-command", default=None)
    parser.add_argument("--ssh-wrapper", action="store_true")
    args = parser.parse_args(argv)
    if args.ssh_wrapper:
        try:
            rc, stdout, stderr = run_ssh_wrapper(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
        except ValueError:
            sys.stderr.write("unsupported provider request\n")
            return 64
        sys.stdout.write(stdout)
        if stderr:
            sys.stderr.write(stderr.rstrip() + "\n")
        return rc
    manifest = load_manifest(args.manifest)
    provider = Provider(
        manifest,
        route_validator=make_traefik_validator(default_runner, manifest["traefik_validation_image"]),
    )
    if args.request_stdin:
        raw_request = sys.stdin.read(65537)
        if len(raw_request.encode("utf-8")) > 65536:
            raise ValueError("provider request exceeded limit")
        request = json.loads(raw_request)
    elif args.forced_command is not None:
        request = parse_forced_command(args.forced_command)
    else:
        parser.error("one request input is required")
    result = execute(provider, request, actor=os.environ.get("DOCKMASTER_PROVIDER_ACTOR", "dockmaster-local"))
    json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

from remote_provider import (
    ManifestError,
    Provider,
    make_traefik_validator,
    parse_forced_command,
    run_ssh_wrapper,
    validate_manifest,
)


def manifest_for(compose_dir: Path, route_file: Path) -> dict:
    compose_file = compose_dir / "compose.yaml"
    compose_file.write_text("services:\n  mcp:\n    image: fixture:1\n", encoding="utf-8")
    return {
        "schema": "dockmaster-provider/v1",
        "blocked_roots": ["/data/coolify/services", "/data/coolify/proxy"],
        "route_file": str(route_file),
        "traefik_validation_image": f"sha256:{'a' * 64}",
        "projects": [
            {
                "id": "node-fixture",
                "owner": "dockmaster",
                "compose_dir": str(compose_dir),
                "compose_file": str(compose_file),
                "compose_dir_uid": compose_dir.stat().st_uid,
                "compose_dir_gid": compose_dir.stat().st_gid,
                "compose_file_uid": compose_file.stat().st_uid,
                "compose_file_gid": compose_file.stat().st_gid,
                "project": "dockmaster-node-fixture",
                "services": [
                    {
                        "name": "mcp",
                        "actions": ["start", "stop", "restart", "pull"],
                        "internal_port": 3000,
                        "health_path": "/healthz",
                    }
                ],
                "route": {
                    "hostname": "dockmaster-node-fixture.internal",
                    "entrypoint": "http",
                    "service": "mcp",
                },
                "rollback": "docker compose up -d mcp",
            }
        ],
    }


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.state = "running"

    def __call__(self, argv, *, input_text=None, timeout=30):
        self.calls.append(list(argv))
        if argv[:2] == ["docker", "ps"]:
            return 0, "abc123\n", ""
        if argv[:2] == ["docker", "inspect"]:
            payload = [
                {
                    "Id": "abc123",
                    "Name": "/dockmaster-node-fixture-mcp-1",
                    "Config": {
                        "Image": "fixture:1",
                        "Labels": {
                            "com.docker.compose.project": "dockmaster-node-fixture",
                            "com.docker.compose.project.working_dir": self.compose_dir,
                            "com.docker.compose.service": "mcp",
                        },
                    },
                    "State": {
                        "Status": self.state,
                        "Health": {"Status": "healthy"},
                    },
                    "NetworkSettings": {
                        "Ports": {"3000/tcp": None},
                    },
                }
            ]
            return 0, json.dumps(payload), ""
        if argv[:2] == ["docker", "compose"]:
            if "stop" in argv:
                self.state = "exited"
            elif any(action in argv for action in ("start", "restart")):
                self.state = "running"
            return 0, "", ""
        raise AssertionError(f"unexpected command: {argv}")


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # macOS exposes /var as a symlink to /private/var. Resolve the
        # TemporaryDirectory root so the normal fixture does not accidentally
        # exercise the symlink-refusal path.
        self.root = Path(self.temp.name).resolve()
        self.compose_dir = self.root / "services" / "node-fixture"
        self.compose_dir.mkdir(parents=True)
        self.route_file = self.root / "dynamic" / "dockmaster-managed.json"
        self.audit_file = self.root / "audit" / "audit.jsonl"
        self.cache_file = self.root / "cache" / "inventory.json"
        self.manifest = manifest_for(self.compose_dir, self.route_file)
        self.runner = FakeRunner()
        self.runner.compose_dir = str(self.compose_dir.resolve())
        self.provider = Provider(
            self.manifest,
            runner=self.runner,
            audit_file=self.audit_file,
            cache_file=self.cache_file,
            route_validator=lambda _: (True, "validated"),
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_manifest_rejects_coolify_managed_roots(self):
        bad = manifest_for(self.compose_dir, self.route_file)
        bad["projects"][0]["compose_dir"] = "/data/coolify/services/owned"
        bad["projects"][0]["compose_file"] = "/data/coolify/services/owned/compose.yaml"
        with self.assertRaisesRegex(ManifestError, "blocked root"):
            validate_manifest(bad)

    def test_manifest_rejects_symlink_escape(self):
        outside = self.root / "outside"
        outside.mkdir()
        linked = self.root / "services" / "linked"
        linked.symlink_to(outside, target_is_directory=True)
        compose = outside / "compose.yaml"
        compose.write_text("services: {}\n", encoding="utf-8")
        bad = manifest_for(self.compose_dir, self.route_file)
        bad["projects"][0]["compose_dir"] = str(linked)
        bad["projects"][0]["compose_file"] = str(linked / "compose.yaml")
        with self.assertRaisesRegex(ManifestError, "symlink"):
            validate_manifest(bad)

    def test_manifest_rejects_wildcard_service_and_route_secret(self):
        bad = manifest_for(self.compose_dir, self.route_file)
        bad["projects"][0]["services"][0]["name"] = "*"
        with self.assertRaisesRegex(ManifestError, "service"):
            validate_manifest(bad)
        bad = manifest_for(self.compose_dir, self.route_file)
        bad["projects"][0]["route"]["authorization"] = "Bearer secret"
        with self.assertRaisesRegex(ManifestError, "secret"):
            validate_manifest(bad)

    def test_manifest_rejects_writable_or_wrongly_owned_compose_inputs(self):
        compose_file = self.compose_dir / "compose.yaml"
        os.chmod(compose_file, 0o666)
        with self.assertRaisesRegex(ManifestError, "writable"):
            validate_manifest(self.manifest)

        os.chmod(compose_file, 0o644)
        bad = manifest_for(self.compose_dir, self.route_file)
        bad["projects"][0]["compose_file_uid"] += 1
        with self.assertRaisesRegex(ManifestError, "ownership"):
            validate_manifest(bad)

    def test_read_only_inventory_service_may_omit_an_internal_port(self):
        manifest = manifest_for(self.compose_dir, self.route_file)
        manifest["projects"][0]["route"] = None
        manifest["projects"][0]["services"][0]["actions"] = []
        manifest["projects"][0]["services"][0]["internal_port"] = None
        self.assertEqual(validate_manifest(manifest)["projects"][0]["services"][0]["actions"], [])

    def test_route_apply_fails_closed_without_a_validator(self):
        provider = Provider(
            self.manifest,
            runner=self.runner,
            audit_file=self.audit_file,
            cache_file=self.cache_file,
        )
        with self.assertRaisesRegex(RuntimeError, "validator"):
            provider.apply_routes(actor="dockmaster-local")
        self.assertFalse(self.route_file.exists())

    def test_inventory_matches_exact_compose_ownership_and_caches_mode_600(self):
        result = self.provider.inventory()
        service = result["projects"][0]["services"][0]
        self.assertEqual(service["state"], "running")
        self.assertEqual(service["health"], "healthy")
        self.assertEqual(service["image"], "fixture:1")
        self.assertEqual(service["actions"], ["start", "stop", "restart", "pull"])
        self.assertEqual(stat.S_IMODE(self.cache_file.stat().st_mode), 0o600)
        self.assertNotIn("compose_dir", result["projects"][0])

    def test_inventory_rejects_container_with_mismatched_working_directory(self):
        self.runner.compose_dir = str(self.root / "different")
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            self.provider.inventory()

    def test_allowlisted_restart_records_previous_state_and_readback(self):
        result = self.provider.action("node-fixture", "mcp", "restart", actor="dockmaster-local")
        self.assertEqual(result["previous_state"], "running")
        self.assertEqual(result["state"], "running")
        compose_call = next(call for call in self.runner.calls if call[:2] == ["docker", "compose"])
        self.assertIn(str(self.compose_dir / "compose.yaml"), compose_call)
        self.assertIn("dockmaster-node-fixture", compose_call)
        self.assertEqual(stat.S_IMODE(self.audit_file.stat().st_mode), 0o600)
        record = json.loads(self.audit_file.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(record["action"], "restart")
        self.assertEqual(record["previous_state"], "running")
        self.assertEqual(record["result"], "ok")

    def test_non_allowlisted_action_is_refused_and_audited(self):
        with self.assertRaisesRegex(PermissionError, "allowlisted"):
            self.provider.action("node-fixture", "mcp", "delete", actor="dockmaster-local")
        record = json.loads(self.audit_file.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(record["result"], "refused")
        self.assertEqual(record["action"], "delete")

    def test_route_generation_is_namespaced_secret_free_atomic_and_mode_600(self):
        result = self.provider.apply_routes(actor="dockmaster-local")
        self.assertEqual(result["routers"], ["dockmaster-node-fixture"])
        payload = json.loads(self.route_file.read_text(encoding="utf-8"))
        router = payload["http"]["routers"]["dockmaster-node-fixture"]
        self.assertEqual(router["rule"], "Host(`dockmaster-node-fixture.internal`)")
        self.assertEqual(router["entryPoints"], ["http"])
        serialized = json.dumps(payload).lower()
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("bearer", serialized)
        self.assertEqual(stat.S_IMODE(self.route_file.stat().st_mode), 0o600)
        self.assertFalse(list(self.route_file.parent.glob("*.tmp")))

    def test_route_validation_failure_preserves_previous_file(self):
        self.route_file.parent.mkdir(parents=True)
        self.route_file.write_text('{"previous":true}\n', encoding="utf-8")
        os.chmod(self.route_file, 0o600)
        provider = Provider(
            self.manifest,
            runner=self.runner,
            audit_file=self.audit_file,
            cache_file=self.cache_file,
            route_validator=lambda _: (False, "bad route"),
        )
        with self.assertRaisesRegex(RuntimeError, "bad route"):
            provider.apply_routes(actor="dockmaster-local")
        self.assertEqual(json.loads(self.route_file.read_text(encoding="utf-8")), {"previous": True})


class ForcedCommandTests(unittest.TestCase):
    def test_accepts_only_fixed_protocol(self):
        self.assertEqual(parse_forced_command("dockmaster-provider inventory"), {"op": "inventory"})
        self.assertEqual(
            parse_forced_command("dockmaster-provider action node-fixture mcp restart"),
            {"op": "action", "project": "node-fixture", "service": "mcp", "action": "restart"},
        )
        self.assertEqual(parse_forced_command("dockmaster-provider routes apply"), {"op": "routes-apply"})
        self.assertEqual(parse_forced_command("dockmaster-provider audit"), {"op": "audit"})

    def test_rejects_shell_metacharacters_and_unknown_verbs(self):
        for command in (
            "dockmaster-provider inventory; id",
            "dockmaster-provider inventory && id",
            "dockmaster-provider shell",
            "docker ps",
            "",
        ):
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    parse_forced_command(command)

    def test_wrapper_passes_only_parsed_json_to_the_exact_no_argument_helper(self):
        calls = []

        def runner(argv, *, input_text=None, timeout=30):
            calls.append((list(argv), input_text, timeout))
            return 0, '{"schema":"dockmaster-provider-inventory/v1"}\n', ""

        rc, stdout, stderr = run_ssh_wrapper("dockmaster-provider inventory", runner=runner)
        self.assertEqual(rc, 0)
        self.assertEqual(stderr, "")
        self.assertIn("dockmaster-provider-inventory/v1", stdout)
        self.assertEqual(calls[0][0], ["sudo", "-n", "/usr/local/sbin/dockmaster-provider-root"])
        self.assertEqual(json.loads(calls[0][1]), {"op": "inventory"})

    def test_wrapper_refuses_unparsed_commands_without_invoking_sudo(self):
        calls = []

        def runner(argv, *, input_text=None, timeout=30):
            calls.append(argv)
            return 0, "", ""

        with self.assertRaisesRegex(ValueError, "invalid forced command"):
            run_ssh_wrapper("dockmaster-provider inventory; id", runner=runner)
        self.assertEqual(calls, [])


class TraefikValidatorTests(unittest.TestCase):
    def test_validator_uses_an_isolated_pinned_container_and_always_removes_it(self):
        calls = []

        def runner(argv, *, input_text=None, timeout=30):
            calls.append(list(argv))
            if argv[:3] == ["docker", "run", "--detach"]:
                return 0, "validator-id\n", ""
            if argv[:2] == ["docker", "inspect"]:
                return 0, "true\n", ""
            if argv[:2] == ["docker", "logs"]:
                return 0, "", ""
            if argv[:3] == ["docker", "rm", "--force"]:
                return 0, "", ""
            raise AssertionError(argv)

        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory).resolve() / "candidate.json"
            candidate.write_text('{"http":{"routers":{},"services":{}}}\n', encoding="utf-8")
            validator = make_traefik_validator(
                runner,
                f"sha256:{'b' * 64}",
                sleep_fn=lambda _: None,
            )
            valid, evidence = validator(candidate)

        self.assertTrue(valid, evidence)
        run = calls[0]
        self.assertIn("--network=none", run)
        self.assertIn("--read-only", run)
        self.assertIn("--cap-drop=ALL", run)
        self.assertIn("no-new-privileges", run)
        self.assertIn(f"sha256:{'b' * 64}", run)
        self.assertEqual(calls[-1][:3], ["docker", "rm", "--force"])

    def test_validator_rejects_error_logs_and_removes_the_container(self):
        calls = []

        def runner(argv, *, input_text=None, timeout=30):
            calls.append(list(argv))
            if argv[:3] == ["docker", "run", "--detach"]:
                return 0, "validator-id\n", ""
            if argv[:2] == ["docker", "inspect"]:
                return 0, "true\n", ""
            if argv[:2] == ["docker", "logs"]:
                return 0, "level=error msg=bad-dynamic-config\n", ""
            if argv[:3] == ["docker", "rm", "--force"]:
                return 0, "", ""
            raise AssertionError(argv)

        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory).resolve() / "candidate.json"
            candidate.write_text("{}\n", encoding="utf-8")
            valid, evidence = make_traefik_validator(
                runner,
                f"sha256:{'c' * 64}",
                sleep_fn=lambda _: None,
            )(candidate)

        self.assertFalse(valid)
        self.assertNotIn("bad-dynamic-config", evidence)
        self.assertEqual(calls[-1][:3], ["docker", "rm", "--force"])


if __name__ == "__main__":
    unittest.main()

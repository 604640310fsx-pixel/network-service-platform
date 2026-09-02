#!/usr/bin/env python3

from __future__ import annotations

import base64
import copy
import importlib.util
import json
import os
import re
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEPLOY_ROOT = REPOSITORY_ROOT / "monitoring" / "gateway" / "deploy"
RENDER_PATH = DEPLOY_ROOT / "render.py"
PREFLIGHT_PATH = DEPLOY_ROOT / "preflight.py"
RELEASE_SHA = "1" * 40

spec = importlib.util.spec_from_file_location("monitor_gateway_deploy_render", RENDER_PATH)
assert spec is not None and spec.loader is not None
render_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = render_module
spec.loader.exec_module(render_module)

preflight_spec = importlib.util.spec_from_file_location(
    "monitor_gateway_deploy_preflight", PREFLIGHT_PATH
)
assert preflight_spec is not None and preflight_spec.loader is not None
preflight_module = importlib.util.module_from_spec(preflight_spec)
sys.modules[preflight_spec.name] = preflight_module
preflight_spec.loader.exec_module(preflight_module)


def sanitized_manifest(backup_root: Path) -> dict:
    return {
        "schemaVersion": "MGW-PRIVATE-STAGING-MANIFEST-V1",
        "authority": {
            "manifestFingerprint": render_module.MANIFEST_FINGERPRINT,
            "candidateSetFingerprint": render_module.CANDIDATE_SET_FINGERPRINT,
            "collisionChecked": True,
        },
        "release": {
            "sha": RELEASE_SHA,
            "installDirectory": (
                "/opt/network-service-platform/monitor-gateway/releases/" + RELEASE_SHA
            ),
        },
        "service": {
            "user": "monitor-gateway",
            "group": "monitor-gateway",
            "envDirectory": "/etc/monitor-gateway",
            "releaseRoot": "/opt/network-service-platform/monitor-gateway/releases",
            "currentLink": "/opt/network-service-platform/monitor-gateway/current",
            "python": "/usr/bin/python3",
        },
        "network": {
            "privateListener": {
                "stableId": "MGW-PRIVATE-LOOPBACK-LISTENER-V1",
                "host": "127.0.0.1",
                "port": 16443,
            },
            "publicListener": {
                "stableId": "MGW-PUBLIC-LOOPBACK-LISTENER-V1",
                "host": "127.0.0.1",
                "port": 15443,
            },
            "wireguard": {
                "interfaceStableId": "MGW-WG-INTERFACE-V1",
                "interfaceName": "mgwtest0",
                "prefixStableId": "MGW-WG-PREFIX-V1",
                "prefix": "10.254.0.0/30",
                "webAddressStableId": "MGW-WG-WEB-ADDRESS-V1",
                "webAddress": "10.254.0.1",
                "fnosAddressStableId": "MGW-WG-FNOS-ADDRESS-V1",
                "fnosAddress": "10.254.0.2",
                "webEndpointStableId": "MGW-WG-WEB-UDP-ENDPOINT-V1",
                "webEndpointHost": "192.0.2.123",
                "webEndpointPort": 18443,
                "webPrivateKeySourceId": "MGW-CREDENTIAL-WG-WEB-PRIVATE-V1",
                "fnosPublicKeySourceId": "MGW-CREDENTIAL-WG-FNOS-PUBLIC-V1",
                "webPeerAllowedIp": "10.254.0.2/32",
                "fnosPeerAllowedIp": "10.254.0.1/32",
                "persistentKeepalive": 25,
                "webIsUdpReceiver": True,
                "fnosInitiatesOutbound": True,
                "fnosOutputChainDeltaRequired": False,
            },
        },
        "origins": {
            "rawMonitorApi": {
                "stableId": "MGW-RAW-MONITOR-ORIGIN-V1",
                "value": "http://10.254.0.2:18444",
            },
            "privateMonitorApi": {
                "stableId": "MGW-PRIVATE-MONITOR-ORIGIN-V1",
                "value": "https://127.0.0.1:16443",
            },
            "canonicalWebsite": {
                "stableId": "MGW-NGINX-CANONICAL-ORIGIN-V1",
                "value": "https://website.example",
            },
        },
        "pki": {
            "runtimeDirectory": "/etc/monitor-gateway/pki",
            "leafValidityDays": 90,
            "rotationStartsDaysRemaining": 30,
            "readinessClosesHoursRemaining": 24,
            "publicCa": {
                "credentialSourceId": "MGW-CREDENTIAL-PUBLIC-CA-V1",
                "targetFile": "/etc/monitor-gateway/pki/public-ca.pem",
            },
            "publicServer": {
                "credentialSourceId": "MGW-CREDENTIAL-PUBLIC-SERVER-LEAF-V1",
                "targetFile": "/etc/monitor-gateway/pki/public-server.crt",
                "targetKeyFile": "/etc/monitor-gateway/pki/public-server.key",
                "expectedSan": "public-gateway.example",
            },
            "privateCa": {
                "credentialSourceId": "MGW-CREDENTIAL-PRIVATE-CA-V1",
                "targetFile": "/etc/monitor-gateway/pki/private-ca.pem",
            },
            "privateServer": {
                "credentialSourceId": "MGW-CREDENTIAL-PRIVATE-SERVER-LEAF-V1",
                "targetFile": "/etc/monitor-gateway/pki/private-server.crt",
                "targetKeyFile": "/etc/monitor-gateway/pki/private-server.key",
                "expectedSan": "127.0.0.1",
            },
            "publicBffClient": {
                "credentialSourceId": "MGW-CREDENTIAL-PUBLIC-BFF-CLIENT-LEAF-V1",
                "targetFile": "/etc/monitor-gateway/pki/public-bff-client.crt",
                "targetKeyFile": "/etc/monitor-gateway/pki/public-bff-client.key",
            },
        },
        "nginx": {
            "listen": "127.0.0.1:17443 ssl",
            "serverName": "monitor.example",
            "edgeCertificateFile": "/etc/monitor-gateway/edge/edge.crt",
            "edgeKeyFile": "/etc/monitor-gateway/edge/edge.key",
            "publicGatewayTlsName": "public-gateway.example",
            "publicGatewayCaFile": "/etc/monitor-gateway/pki/public-ca.pem",
        },
        "anchors": {
            "nginxHttpInclude": {
                "stableId": "MGW-NGINX-HTTP-INCLUDE-V1",
                "value": "/etc/nginx/conf.d/monitor-gateway-http.conf",
            },
            "nginxVhost": {
                "stableId": "MGW-NGINX-PUBLIC-VHOST-V1",
                "value": "/etc/nginx/sites-enabled/monitor-gateway.conf",
            },
            "webFirewall": {
                "stableId": "MGW-WEB-FIREWALL-ANCHOR-V1",
                "value": "mgw-web-input",
            },
            "fnosOutputChain": {
                "stableId": "MGW-FNOS-OUTPUT-CHAIN-V1",
                "value": "mgw-fnos-output",
            },
        },
        "baselines": {
            "dns": "a" * 64,
            "ntp": "b" * 64,
            "time": "c" * 64,
            "defaultRoute": "d" * 64,
            "packageDatabase": "e" * 64,
        },
        "backup": {
            "root": str(backup_root),
            "destinationUnused": True,
            "rollbackReady": True,
        },
        "residue": {
            "generatedConfigInRepository": False,
            "issuerPrivateKeysOnRuntimeHosts": False,
            "defaultRouteTakeover": False,
            "subnetForwarding": False,
            "homeInbound": False,
            "persistentReverseSsh": False,
        },
    }


class ManifestAndRendererTests(unittest.TestCase):
    def test_schema_is_closed_and_contains_no_examples_or_defaults(self):
        schema = json.loads((DEPLOY_ROOT / "manifest.schema.json").read_text())
        self.assertFalse(schema["additionalProperties"])
        encoded = json.dumps(schema)
        self.assertNotIn('"default"', encoded)
        self.assertNotIn('"examples"', encoded)
        self.assertEqual(
            schema["properties"]["authority"]["properties"]["manifestFingerprint"][
                "const"
            ],
            render_module.MANIFEST_FINGERPRINT,
        )

    def test_manifest_rejects_missing_extra_and_route_takeover_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = sanitized_manifest(Path(temporary) / "backup")
            render_module.validate_manifest(manifest, expected_release_sha=RELEASE_SHA)

            missing = copy.deepcopy(manifest)
            del missing["network"]["privateListener"]["host"]
            with self.assertRaisesRegex(render_module.ManifestError, "missing_field"):
                render_module.validate_manifest(missing)

            extra = copy.deepcopy(manifest)
            extra["network"]["wireguard"]["sharedSecret"] = "must-never-echo"
            with self.assertRaisesRegex(render_module.ManifestError, "extra_field") as error:
                render_module.validate_manifest(extra)
            self.assertNotIn("must-never-echo", str(error.exception))

            takeover = copy.deepcopy(manifest)
            takeover["network"]["wireguard"]["webPeerAllowedIp"] = "0.0.0.0/0"
            with self.assertRaisesRegex(
                render_module.ManifestError, "single_host_route_required"
            ):
                render_module.validate_manifest(takeover)

    def test_renderer_is_private_idempotent_and_never_echoes_runtime_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = root / "manifest.json"
            output = root / "rendered"
            manifest = sanitized_manifest(root / "backup")
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            command = [
                sys.executable,
                str(RENDER_PATH),
                "--manifest",
                str(manifest_path),
                "--expected-release-sha",
                RELEASE_SHA,
                "--output-dir",
                str(output),
            ]
            first = subprocess.run(command, capture_output=True, text=True, check=False)
            second = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertNotIn("website.example", first.stdout + first.stderr)
            self.assertNotIn("10.254.0.2", first.stdout + first.stderr)
            self.assertEqual({path.name for path in output.iterdir()}, {
                "private.env",
                "public.env",
                "monitor-gateway-server.conf",
                "nginx-candidate-root.conf",
                "render-report.json",
            })
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            self.assertTrue(
                all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in output.iterdir())
            )
            self.assertIn("PUBLIC_MONITOR_BIND_HOST=127.0.0.1", (output / "public.env").read_text())
            self.assertNotIn("@@", (output / "monitor-gateway-server.conf").read_text())

            manifest["origins"]["canonicalWebsite"]["value"] = "https://changed.example"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            conflict = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertNotEqual(conflict.returncode, 0)
            self.assertNotIn("changed.example", conflict.stdout + conflict.stderr)

            manifest_link = root / "manifest-link.json"
            manifest_link.symlink_to(manifest_path)
            symlink_command = command.copy()
            symlink_command[symlink_command.index(str(manifest_path))] = str(manifest_link)
            symlink_result = subprocess.run(
                symlink_command, capture_output=True, text=True, check=False
            )
            self.assertNotEqual(symlink_result.returncode, 0)
            self.assertIn("manifest_file_required", symlink_result.stderr)

    def test_renderer_refuses_repository_output_without_creating_it(self):
        output = DEPLOY_ROOT / "generated-test-output"
        self.assertFalse(output.exists())
        with tempfile.TemporaryDirectory() as temporary:
            manifest = sanitized_manifest(Path(temporary) / "backup")
            with self.assertRaisesRegex(
                render_module.ManifestError, "repository_output_forbidden"
            ):
                render_module.render(manifest, output)
        self.assertFalse(output.exists())


class PreflightAndTemplateTests(unittest.TestCase):
    def test_private_probe_classifies_refusal_timeout_and_not_ready(self):
        probe_arguments = (
            "loopback-listener",
            1,
            mock.Mock(),
            "private-listener",
            "/healthz",
        )
        probe_keywords = {
            "failure_check": "private_postcheck",
            "refused_code": "private_runtime_probe_refused",
            "timeout_code": "private_runtime_probe_timeout",
            "failure_code": "private_runtime_probe_failed",
            "timeout_seconds": 3,
        }
        for exception, expected_code in (
            (ConnectionRefusedError(), "private_runtime_probe_refused"),
            (TimeoutError(), "private_runtime_probe_timeout"),
        ):
            with self.subTest(code=expected_code), mock.patch.object(
                preflight_module.socket,
                "create_connection",
                side_effect=exception,
            ), self.assertRaises(preflight_module.PreflightError) as raised:
                preflight_module._http_probe(*probe_arguments, **probe_keywords)
            self.assertEqual(raised.exception.code, expected_code)
            self.assertEqual(raised.exception.check, "private_postcheck")

        context = mock.Mock()
        with mock.patch.object(
            preflight_module.ssl, "create_default_context", return_value=context
        ), mock.patch.object(
            preflight_module,
            "_http_probe",
            side_effect=(
                (200, {"cache-control": "private, no-store"}, b'{"status":"ok"}'),
                (503, {"cache-control": "private, no-store"}, b'{"status":"starting"}'),
            ),
        ), self.assertRaises(preflight_module.PreflightError) as raised:
            preflight_module.validate_private_postcheck(
                sanitized_manifest(Path("/tmp/monitor-gateway-test-backup")),
                Path("/tmp/monitor-gateway-test-pki"),
            )
        self.assertEqual(raised.exception.code, "private_readiness_rejected")
        self.assertEqual(raised.exception.check, "private_postcheck")

    def test_private_postcheck_retry_exit_codes_are_stable(self):
        manifest = sanitized_manifest(Path("/tmp/monitor-gateway-test-backup"))
        arguments = [
            "--manifest",
            "/tmp/monitor-gateway-test-manifest",
            "--expected-release-sha",
            RELEASE_SHA,
            "--artifact-dir",
            f"/tmp/{RELEASE_SHA}",
            "--rendered-dir",
            "/tmp/monitor-gateway-test-rendered",
            "--pki-dir",
            "/tmp/monitor-gateway-test-pki",
            "--wireguard-config",
            "/tmp/monitor-gateway-test-wireguard",
            "--backup-dir",
            "/tmp/monitor-gateway-test-backup",
            "--phase",
            "private-postcheck",
        ]
        validators = (
            mock.patch.object(preflight_module, "validate_schema_asset"),
            mock.patch.object(preflight_module, "load_manifest", return_value=manifest),
            mock.patch.object(preflight_module, "validate_artifact"),
            mock.patch.object(preflight_module, "validate_rendered"),
            mock.patch.object(preflight_module, "validate_pki"),
            mock.patch.object(preflight_module, "validate_wireguard"),
            mock.patch.object(preflight_module, "validate_backup"),
        )
        for validator in validators:
            validator.start()
            self.addCleanup(validator.stop)

        cases = (
            ("private_runtime_probe_refused", 10),
            ("private_runtime_probe_timeout", 11),
            ("private_readiness_rejected", 12),
            ("private_runtime_probe_failed", 1),
        )
        for code, expected_status in cases:
            with self.subTest(code=code), mock.patch.object(
                preflight_module,
                "validate_private_postcheck",
                side_effect=preflight_module.PreflightError(code, "private_postcheck"),
            ), mock.patch("builtins.print"):
                self.assertEqual(preflight_module.main(arguments), expected_status)

    def test_activate_private_execution_classifies_and_waits_for_readiness(self):
        install = (DEPLOY_ROOT / "install-root.sh").read_text()
        constants_start = install.index("readonly PRIVATE_READINESS_TIMEOUT_SECONDS=")
        constants_end = install.index("\n\nscript_root=", constants_start)
        fail_start = install.index("fail_code() {")
        fail_end = install.index("\n}\n", fail_start) + 3
        helpers_start = install.index('private_service_state=""')
        helpers_end = install.index('\n\nif [[ "$phase" == "install" ]]', helpers_start)
        harness_source = (
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            + install[constants_start:constants_end]
            + "\n"
            + install[fail_start:fail_end]
            + "\n"
            + install[helpers_start:helpers_end]
            + "\nfake_epoch=0\n"
            + "probe_count=0\n"
            + "read_readiness_clock() { readiness_clock=\"$fake_epoch\"; }\n"
            + "readiness_sleep() { fake_epoch=$((fake_epoch + $1)); }\n"
            + "run_installed_preflight() {\n"
            + "  [[ \"$1\" == private-postcheck ]] || return 1\n"
            + "  probe_count=$((probe_count + 1))\n"
            + "  case \"$HARNESS_SCENARIO\" in\n"
            + "    delayed-start) ((probe_count < 3)) && return \"$PRIVATE_POSTCHECK_REFUSED_EXIT\" || return 0 ;;\n"
            + "    readiness-race) ((probe_count < 2)) && return \"$PRIVATE_POSTCHECK_NOT_READY_EXIT\" || return 0 ;;\n"
            + "    readiness-timeout|process-exit) return \"$PRIVATE_POSTCHECK_NOT_READY_EXIT\" ;;\n"
            + "    readiness-refused) return \"$PRIVATE_POSTCHECK_REFUSED_EXIT\" ;;\n"
            + "    readiness-probe-timeout) return \"$PRIVATE_POSTCHECK_TIMEOUT_EXIT\" ;;\n"
            + "    *) return 1 ;;\n"
            + "  esac\n"
            + "}\n"
            + "start_private_service\n"
            + "require_private_service_active private_service_not_active_after_start\n"
            + "wait_for_private_readiness\n"
            + "printf '%s\\n' PRIVATE_READINESS_PASS\n"
        )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = root / "harness.sh"
            systemctl = root / "systemctl"
            active_checks = root / "active-checks"
            harness.write_text(harness_source, encoding="utf-8")
            systemctl.write_text(
                "#!/usr/bin/env bash\n"
                "set -eu\n"
                "case \"$1\" in\n"
                "  start) [[ \"$HARNESS_SCENARIO\" != service-start-failure ]]; exit $? ;;\n"
                "  is-active)\n"
                "    count=$(<\"$ACTIVE_CHECK_FILE\")\n"
                "    count=$((count + 1))\n"
                "    printf '%s' \"$count\" >\"$ACTIVE_CHECK_FILE\"\n"
                "    case \"$HARNESS_SCENARIO\" in\n"
                "      active-check-failure) exit 1 ;;\n"
                "      not-active-after-start) exit 3 ;;\n"
                "      process-exit) ((count <= 2)) && exit 0 || exit 3 ;;\n"
                "      *) exit 0 ;;\n"
                "    esac\n"
                "    ;;\n"
                "esac\n"
                "exit 1\n",
                encoding="utf-8",
            )
            os.chmod(harness, 0o755)
            os.chmod(systemctl, 0o755)
            environment = os.environ.copy()
            environment["PATH"] = str(root) + os.pathsep + environment["PATH"]
            environment["ACTIVE_CHECK_FILE"] = str(active_checks)

            cases = (
                ("delayed-start", 0, "PRIVATE_READINESS_PASS"),
                ("readiness-race", 0, "PRIVATE_READINESS_PASS"),
                (
                    "service-start-failure",
                    1,
                    "INSTALL_BLOCKED code=private_service_start_failed check=activate_private",
                ),
                (
                    "active-check-failure",
                    1,
                    "INSTALL_BLOCKED code=private_service_active_check_failed check=activate_private",
                ),
                (
                    "not-active-after-start",
                    1,
                    "INSTALL_BLOCKED code=private_service_not_active_after_start check=activate_private",
                ),
                (
                    "readiness-timeout",
                    1,
                    "INSTALL_BLOCKED code=private_readiness_timeout check=private_readiness",
                ),
                (
                    "readiness-refused",
                    1,
                    "INSTALL_BLOCKED code=private_readiness_refused check=private_readiness",
                ),
                (
                    "readiness-probe-timeout",
                    1,
                    "INSTALL_BLOCKED code=private_readiness_probe_timeout check=private_readiness",
                ),
                (
                    "process-exit",
                    1,
                    "INSTALL_BLOCKED code=private_service_exited_during_readiness check=activate_private",
                ),
            )
            for scenario, expected_status, expected_output in cases:
                with self.subTest(scenario=scenario):
                    active_checks.write_text("0", encoding="ascii")
                    environment["HARNESS_SCENARIO"] = scenario
                    result = subprocess.run(
                        ["bash", str(harness)],
                        capture_output=True,
                        text=True,
                        check=False,
                        env=environment,
                    )
                    output = result.stdout + result.stderr
                    self.assertEqual(result.returncode, expected_status, output)
                    self.assertIn(expected_output, output)
                    self.assertLessEqual(int(active_checks.read_text(encoding="ascii")), 33)

    def test_private_negative_gate_distinguishes_required_cert_from_silent_close(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ca_certificate = root / "private-ca.pem"
            ca_key = root / "private-ca.key"
            server_certificate = root / "server.crt"
            server_key = root / "server.key"
            request = root / "server.csr"
            extensions = root / "server.ext"
            extensions.write_text(
                "[leaf]\n"
                "basicConstraints=critical,CA:FALSE\n"
                "keyUsage=critical,digitalSignature,keyEncipherment\n"
                "extendedKeyUsage=serverAuth\n"
                "subjectAltName=IP:127.0.0.1\n",
                encoding="ascii",
            )
            commands = (
                [
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-days",
                    "30",
                    "-subj",
                    "/CN=private-ca",
                    "-addext",
                    "basicConstraints=critical,CA:TRUE",
                    "-addext",
                    "keyUsage=critical,keyCertSign,cRLSign",
                    "-keyout",
                    str(ca_key),
                    "-out",
                    str(ca_certificate),
                ],
                [
                    "req",
                    "-new",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    "/CN=private-server",
                    "-keyout",
                    str(server_key),
                    "-out",
                    str(request),
                ],
                [
                    "x509",
                    "-req",
                    "-in",
                    str(request),
                    "-CA",
                    str(ca_certificate),
                    "-CAkey",
                    str(ca_key),
                    "-CAcreateserial",
                    "-days",
                    "30",
                    "-extfile",
                    str(extensions),
                    "-extensions",
                    "leaf",
                    "-out",
                    str(server_certificate),
                ],
            )
            for arguments in commands:
                result = subprocess.run(
                    ["openssl", *arguments],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

            manifest = sanitized_manifest(root / "backup")
            manifest["pki"]["privateServer"]["expectedSan"] = "127.0.0.1"

            def run_gate(verify_mode: ssl.VerifyMode) -> tuple[str | None, bool]:
                server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                server_context.minimum_version = ssl.TLSVersion.TLSv1_3
                server_context.maximum_version = ssl.TLSVersion.TLSv1_3
                server_context.load_cert_chain(server_certificate, server_key)
                server_context.verify_mode = verify_mode
                if verify_mode == ssl.CERT_REQUIRED:
                    server_context.load_verify_locations(cafile=ca_certificate)
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.settimeout(5)
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                port = listener.getsockname()[1]
                server_errors: list[BaseException] = []
                certificate_rejected = threading.Event()

                def serve_once() -> None:
                    try:
                        connection, _ = listener.accept()
                        connection.settimeout(5)
                        with server_context.wrap_socket(connection, server_side=True):
                            pass
                    except ssl.SSLError as error:
                        reason = str(getattr(error, "reason", "")).upper()
                        if (
                            verify_mode == ssl.CERT_REQUIRED
                            and reason == "PEER_DID_NOT_RETURN_A_CERTIFICATE"
                        ):
                            certificate_rejected.set()
                        else:
                            server_errors.append(error)
                    except Exception as error:  # pragma: no cover - assertion below
                        server_errors.append(error)
                    finally:
                        listener.close()

                server_thread = threading.Thread(target=serve_once, daemon=True)
                server_thread.start()
                manifest["network"]["privateListener"]["port"] = port
                error_code = None
                try:
                    preflight_module._validate_private_negative_gate(manifest, root)
                except preflight_module.PreflightError as error:
                    error_code = error.code
                    self.assertEqual(error.check, "runtime_postcheck")
                finally:
                    listener.close()
                    server_thread.join(timeout=6)
                self.assertFalse(server_thread.is_alive())
                self.assertEqual(server_errors, [])
                return error_code, certificate_rejected.is_set()

            error_code, certificate_rejected = run_gate(ssl.CERT_REQUIRED)
            self.assertIn(
                error_code,
                {None, "private_mtls_negative_gate_inconclusive"},
            )
            self.assertTrue(certificate_rejected)

            error_code, certificate_rejected = run_gate(ssl.CERT_NONE)
            self.assertIn(
                error_code,
                {
                    "private_mtls_negative_gate_failed",
                    "private_mtls_negative_gate_inconclusive",
                },
            )
            self.assertFalse(certificate_rejected)

    def test_leaf_rejects_extra_extended_key_usage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            certificate = root / "server.crt"
            key = root / "server.key"
            result = subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-days",
                    "30",
                    "-subj",
                    "/CN=server-leaf",
                    "-addext",
                    "basicConstraints=critical,CA:FALSE",
                    "-addext",
                    "keyUsage=critical,digitalSignature,keyEncipherment",
                    "-addext",
                    "extendedKeyUsage=serverAuth,codeSigning",
                    "-addext",
                    "subjectAltName=DNS:server.example",
                    "-keyout",
                    str(key),
                    "-out",
                    str(certificate),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            with self.assertRaises(preflight_module.PreflightError) as raised:
                preflight_module._validate_leaf(
                    certificate,
                    key,
                    expected_eku="TLS Web Server Authentication",
                    forbidden_eku="TLS Web Client Authentication",
                    expected_san="server.example",
                    check="server_leaf",
                )
            self.assertEqual(raised.exception.code, "certificate_eku_mismatch")
            self.assertEqual(
                str(raised.exception), "certificate_eku_mismatch at server_leaf"
            )

    def test_complete_sanitized_precheck_validates_artifact_pki_render_and_network(self):
        def run_openssl(arguments: list[str]) -> None:
            result = subprocess.run(
                ["openssl", *arguments], capture_output=True, text=True, check=False
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        def issue_leaf(
            working: Path,
            *,
            ca: Path,
            ca_key: Path,
            name: str,
            eku: str,
            san: str | None,
        ) -> tuple[Path, Path]:
            key = working / f"{name}.key"
            request = working / f"{name}.csr"
            certificate = working / f"{name}.crt"
            extensions = working / f"{name}.ext"
            extension_lines = [
                "[leaf]",
                "basicConstraints=critical,CA:FALSE",
                "keyUsage=critical,digitalSignature,keyEncipherment",
                f"extendedKeyUsage={eku}",
            ]
            if san is not None:
                extension_lines.append(f"subjectAltName={san}")
            extensions.write_text("\n".join(extension_lines) + "\n", encoding="ascii")
            run_openssl(
                [
                    "req",
                    "-new",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-subj",
                    f"/CN={name}",
                    "-keyout",
                    str(key),
                    "-out",
                    str(request),
                ]
            )
            run_openssl(
                [
                    "x509",
                    "-req",
                    "-in",
                    str(request),
                    "-CA",
                    str(ca),
                    "-CAkey",
                    str(ca_key),
                    "-CAcreateserial",
                    "-days",
                    "30",
                    "-extfile",
                    str(extensions),
                    "-extensions",
                    "leaf",
                    "-out",
                    str(certificate),
                ]
            )
            return certificate, key

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = sanitized_manifest(root / "backup")
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            artifact = root / RELEASE_SHA
            entrypoint = artifact / "monitoring" / "gateway" / "server.py"
            entrypoint.parent.mkdir(parents=True)
            entrypoint.write_text("raise SystemExit('fixture only')\n", encoding="utf-8")
            (artifact / ".monitor-gateway-release-sha").write_text(
                RELEASE_SHA + "\n", encoding="ascii"
            )
            for candidate in artifact.rglob("*"):
                os.chmod(candidate, 0o555 if candidate.is_dir() else 0o444)

            issuers = root / "issuers"
            issuers.mkdir(mode=0o700)
            public_ca = issuers / "public-ca.pem"
            public_ca_key = issuers / "public-ca.key"
            private_ca = issuers / "private-ca.pem"
            private_ca_key = issuers / "private-ca.key"
            for name, certificate, key in (
                ("public-ca", public_ca, public_ca_key),
                ("private-ca", private_ca, private_ca_key),
            ):
                run_openssl(
                    [
                        "req",
                        "-x509",
                        "-newkey",
                        "rsa:2048",
                        "-nodes",
                        "-days",
                        "30",
                        "-subj",
                        f"/CN={name}",
                        "-keyout",
                        str(key),
                        "-out",
                        str(certificate),
                    ]
                )
            public_server = issue_leaf(
                issuers,
                ca=public_ca,
                ca_key=public_ca_key,
                name="public-server",
                eku="serverAuth",
                san="DNS:public-gateway.example",
            )
            private_server = issue_leaf(
                issuers,
                ca=private_ca,
                ca_key=private_ca_key,
                name="private-server",
                eku="serverAuth",
                san="IP:127.0.0.1",
            )
            public_client = issue_leaf(
                issuers,
                ca=private_ca,
                ca_key=private_ca_key,
                name="public-bff-client",
                eku="clientAuth",
                san=None,
            )
            pki = root / "pki"
            pki.mkdir(mode=0o750)
            sources = {
                "public-ca.pem": public_ca,
                "private-ca.pem": private_ca,
                "public-server.crt": public_server[0],
                "public-server.key": public_server[1],
                "private-server.crt": private_server[0],
                "private-server.key": private_server[1],
                "public-bff-client.crt": public_client[0],
                "public-bff-client.key": public_client[1],
            }
            for name, source in sources.items():
                destination = pki / name
                destination.write_bytes(source.read_bytes())
                os.chmod(destination, 0o640)

            rendered = root / "rendered"
            render_result = subprocess.run(
                [
                    sys.executable,
                    str(RENDER_PATH),
                    "--manifest",
                    str(manifest_path),
                    "--expected-release-sha",
                    RELEASE_SHA,
                    "--output-dir",
                    str(rendered),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(render_result.returncode, 0, render_result.stderr)
            wireguard = root / "wireguard.conf"
            private_key = base64.b64encode(bytes(range(32))).decode("ascii")
            peer_key = base64.b64encode(bytes(range(1, 33))).decode("ascii")
            wireguard.write_text(
                "[Interface]\n"
                "Address = 10.254.0.1/30\n"
                "ListenPort = 18443\n"
                f"PrivateKey = {private_key}\n\n"
                "[Peer]\n"
                f"PublicKey = {peer_key}\n"
                "AllowedIPs = 10.254.0.2/32\n",
                encoding="ascii",
            )
            os.chmod(wireguard, 0o600)

            before = sorted(
                (str(path.relative_to(root)), stat.S_IMODE(path.stat().st_mode))
                for path in root.rglob("*")
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(PREFLIGHT_PATH),
                    "--manifest",
                    str(manifest_path),
                    "--expected-release-sha",
                    RELEASE_SHA,
                    "--artifact-dir",
                    str(artifact),
                    "--rendered-dir",
                    str(rendered),
                    "--pki-dir",
                    str(pki),
                    "--wireguard-config",
                    str(wireguard),
                    "--backup-dir",
                    str(root / "backup"),
                    "--phase",
                    "precheck",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            after = sorted(
                (str(path.relative_to(root)), stat.S_IMODE(path.stat().st_mode))
                for path in root.rglob("*")
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("RESULT: PASS", result.stdout)
            self.assertIn("RAW_VALUES_EMITTED: NO", result.stdout)
            self.assertNotIn("10.254.0.2", result.stdout + result.stderr)
            self.assertNotIn("public-gateway.example", result.stdout + result.stderr)
            self.assertEqual(after, before)

    def test_manifest_only_preflight_is_read_only_and_redacted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = root / "manifest.json"
            manifest = sanitized_manifest(root / "backup")
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            before = manifest_path.read_bytes()
            result = subprocess.run(
                [
                    sys.executable,
                    str(PREFLIGHT_PATH),
                    "--manifest",
                    str(manifest_path),
                    "--expected-release-sha",
                    RELEASE_SHA,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("PREFLIGHT_MODE: READ_ONLY", result.stdout)
            self.assertIn("WORKTREE_MUTATED: NO", result.stdout)
            self.assertNotIn("website.example", result.stdout + result.stderr)
            self.assertEqual(manifest_path.read_bytes(), before)

    def test_backup_precheck_requires_private_current_user_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            backup = parent / "backup"
            manifest = sanitized_manifest(backup)
            manifest_path = parent / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            operator_uid = 4242

            def matching_owner(path: Path, check: str) -> int:
                self.assertIn(path, {parent, manifest_path})
                self.assertIn(check, {"backup_parent", "manifest"})
                return operator_uid

            os.chmod(parent, 0o777)
            with mock.patch.object(
                preflight_module, "_owner_uid", side_effect=matching_owner
            ), mock.patch.object(
                preflight_module.os, "geteuid", return_value=operator_uid
            ), self.assertRaises(preflight_module.PreflightError) as raised:
                preflight_module.validate_backup(
                    backup,
                    manifest,
                    manifest_path=manifest_path,
                    phase="precheck",
                )
            self.assertEqual(raised.exception.code, "mode_mismatch")
            self.assertEqual(raised.exception.check, "backup_parent")

            os.chmod(parent, 0o700)
            with mock.patch.object(
                preflight_module, "_owner_uid", side_effect=matching_owner
            ), mock.patch.object(
                preflight_module.os, "geteuid", return_value=operator_uid
            ):
                preflight_module.validate_backup(
                    backup,
                    manifest,
                    manifest_path=manifest_path,
                    phase="precheck",
                )

            with mock.patch.object(
                preflight_module, "_owner_uid", side_effect=matching_owner
            ), mock.patch.object(preflight_module.os, "geteuid", return_value=0):
                preflight_module.validate_backup(
                    backup,
                    manifest,
                    manifest_path=manifest_path,
                    phase="precheck",
                )

            def mismatched_owner(path: Path, check: str) -> int:
                return operator_uid + 1 if path == manifest_path else operator_uid

            with mock.patch.object(
                preflight_module, "_owner_uid", side_effect=mismatched_owner
            ), mock.patch.object(
                preflight_module.os, "geteuid", return_value=operator_uid
            ), self.assertRaises(preflight_module.PreflightError) as raised:
                preflight_module.validate_backup(
                    backup,
                    manifest,
                    manifest_path=manifest_path,
                    phase="precheck",
                )
            self.assertEqual(raised.exception.code, "backup_parent_owner_mismatch")
            self.assertEqual(raised.exception.check, "backup_parent")

    def test_systemd_units_lock_order_identity_and_hardening(self):
        private = (DEPLOY_ROOT / "systemd" / "monitor-gateway-private.service").read_text()
        public = (DEPLOY_ROOT / "systemd" / "monitor-gateway-public.service").read_text()
        self.assertIn("Wants=network-online.target", private)
        self.assertIn("After=network-online.target", private)
        self.assertIn("Requires=monitor-gateway-private.service", public)
        self.assertIn("After=monitor-gateway-private.service", public)
        for mode, unit in (("private", private), ("public", public)):
            with self.subTest(mode=mode):
                for directive in (
                    "Type=simple",
                    "User=monitor-gateway",
                    "Group=monitor-gateway",
                    "Restart=on-failure",
                    "RestartSec=5s",
                    "KillSignal=SIGTERM",
                    "TimeoutStartSec=75s",
                    "TimeoutStopSec=65s",
                    "NoNewPrivileges=true",
                    "PrivateTmp=true",
                    "PrivateDevices=true",
                    "ProtectSystem=strict",
                    "ProtectHome=true",
                    "CapabilityBoundingSet=",
                    "AmbientCapabilities=",
                    "RestrictSUIDSGID=true",
                    "LockPersonality=true",
                    "MemoryDenyWriteExecute=true",
                    "RestrictRealtime=true",
                    "RestrictAddressFamilies=AF_UNIX AF_INET",
                    "UMask=0077",
                    "StandardOutput=journal",
                    "StandardError=journal",
                    f"ExecStart=/usr/bin/python3 -m monitoring.gateway.server {mode}",
                ):
                    self.assertIn(directive, unit)
                self.assertNotIn("AF_INET6", unit)

    def test_nginx_templates_enforce_frozen_security_boundary(self):
        http_template = (DEPLOY_ROOT / "nginx" / "monitor-gateway-http.conf").read_text()
        server = (DEPLOY_ROOT / "nginx" / "monitor-gateway-server.conf").read_text()
        self.assertIn("rate=30r/m", http_template)
        for directive in (
            "burst=10 nodelay",
            "limit_req_status 429",
            "proxy_ssl_verify on",
            "proxy_ssl_name $monitor_gateway_tls_name",
            "proxy_set_header X-Monitor-Client-IP $remote_addr",
            'proxy_set_header X-Forwarded-For ""',
            'proxy_set_header X-Real-IP ""',
            'proxy_set_header Forwarded ""',
            "proxy_connect_timeout 3s",
            "proxy_read_timeout 50s",
            "proxy_send_timeout 50s",
            "proxy_next_upstream off",
            "proxy_cache off",
            "return 503 '{\"error\":\"monitor_unavailable\"}'",
            "location = /healthz",
            "location = /readyz",
            "return 404",
            "Cache-Control \"no-store\"",
            "access_log off",
        ):
            self.assertIn(directive, server)
        self.assertNotIn("Access-Control-Allow-Origin", server.replace("proxy_hide_header Access-Control-Allow-Origin", ""))
        self.assertNotIn("proxy_set_header X-Forwarded-For $", server)
        self.assertEqual(server.count("@@PUBLIC_"), 7)

    def test_shell_guardrails_and_syntax(self):
        for name in ("install-root.sh", "rollback-root.sh"):
            path = DEPLOY_ROOT / name
            result = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            content = path.read_text()
            self.assertIn("set -euo pipefail", content)
            self.assertIn("confirmation token mismatch", content)
            self.assertIn("all paths must be absolute", content)
            self.assertIn("preflight.py", content)
            self.assertNotIn("sudo ", content)
            self.assertNotIn("NOPASSWD", content)
            self.assertNotIn("rm -rf", content)
            self.assertNotIn("git ", content)
        install = (DEPLOY_ROOT / "install-root.sh").read_text()
        rollback = (DEPLOY_ROOT / "rollback-root.sh").read_text()
        self.assertIn("CURRENT_LINK_SWITCHED: NO", install)
        self.assertIn("NGINX_ROUTE_ACTIVATED: NO", install)
        self.assertIn("nginx -t -c", install)
        self.assertIn("readonly PRIVATE_READINESS_TIMEOUT_SECONDS=30", install)
        self.assertIn("readonly PRIVATE_READINESS_RETRY_INTERVAL_SECONDS=1", install)
        self.assertIn("start_private_service", install)
        self.assertIn(
            "require_private_service_active private_service_not_active_after_start",
            install,
        )
        self.assertIn("wait_for_private_readiness", install)
        self.assertNotIn("systemctl reload nginx", install)
        validation = install.index("validate_managed_file_target() {")
        backup_creation = install.index('install -d -m 0700 -- "$backup_dir"')
        self.assertLess(validation, backup_creation)
        self.assertIn(
            '[[ ! -L "$target_path" ]] || fail "managed file target is a symlink"',
            install,
        )
        backup_function_start = install.index("  backup_one() {")
        backup_function_end = install.index(
            "\n  }\n\n  backup_one current-link", backup_function_start
        )
        backup_function = install[backup_function_start:backup_function_end]
        self.assertIn(
            'if [[ "$target_id" == "current-link" ]]; then', backup_function
        )
        self.assertEqual(backup_function.count(' symlink "$backup_name"'), 1)
        self.assertIn("classify_service_state() {", rollback)
        self.assertIn("stop_service_if_active() {", rollback)
        self.assertIn('3) service_state="inactive"', rollback)
        self.assertIn('4) service_state="not-found"', rollback)
        self.assertLess(
            rollback.index("stop_service_if_active monitor-gateway-public.service"),
            rollback.index("stop_service_if_active monitor-gateway-private.service"),
        )
        self.assertNotIn("systemctl stop monitor-gateway-public.service", rollback)
        self.assertNotIn("systemctl stop monitor-gateway-private.service", rollback)
        self.assertLess(rollback.index("restore_current_link"), rollback.index("wg-quick down"))
        self.assertIn("BACKUP_EVIDENCE_PRESERVED: YES", rollback)

    def test_rollback_service_gate_classifies_systemctl_results(self):
        rollback = (DEPLOY_ROOT / "rollback-root.sh").read_text()
        fail_start = rollback.index("fail() {")
        fail_end = rollback.index("\n}\n", fail_start) + 3
        state_start = rollback.index('service_state=""')
        state_end = rollback.index('\n\nif [[ "$phase" == "rollback" ]]', state_start)
        functions = rollback[fail_start:fail_end] + "\n" + rollback[state_start:state_end]

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            systemctl = root / "systemctl"
            state_file = root / "state"
            harness = root / "harness.sh"
            systemctl.write_text(
                "#!/usr/bin/env bash\n"
                "set -eu\n"
                "case \"$1\" in\n"
                "  is-active)\n"
                "    case \"$SYSTEMCTL_SCENARIO\" in\n"
                "      active) [[ \"$(<\"$SYSTEMCTL_STATE_FILE\")\" == active ]] && exit 0 || exit 3 ;;\n"
                "      not-found) exit 4 ;;\n"
                "      manager-error) exit 1 ;;\n"
                "    esac\n"
                "    ;;\n"
                "  stop) printf inactive >\"$SYSTEMCTL_STATE_FILE\"; exit 0 ;;\n"
                "esac\n"
                "exit 1\n",
                encoding="utf-8",
            )
            os.chmod(systemctl, 0o755)
            harness.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                + functions
                + "\nstop_service_if_active test.service 'service remains active'\n"
                + "printf '%s\\n' SERVICE_GATE_PASS\n",
                encoding="utf-8",
            )
            os.chmod(harness, 0o755)
            environment = os.environ.copy()
            environment["PATH"] = str(root) + os.pathsep + environment["PATH"]
            environment["SYSTEMCTL_STATE_FILE"] = str(state_file)

            cases = (
                ("active", 0, "SERVICE_GATE_PASS"),
                ("not-found", 0, "SERVICE_GATE_PASS"),
                ("manager-error", 1, "ROLLBACK_BLOCKED: service state check failed"),
            )
            for scenario, expected_status, expected_output in cases:
                with self.subTest(scenario=scenario):
                    state_file.write_text("active", encoding="ascii")
                    environment["SYSTEMCTL_SCENARIO"] = scenario
                    result = subprocess.run(
                        ["bash", str(harness)],
                        capture_output=True,
                        text=True,
                        check=False,
                        env=environment,
                    )
                    self.assertEqual(result.returncode, expected_status)
                    self.assertIn(expected_output, result.stdout + result.stderr)
                    if scenario == "active":
                        self.assertEqual(state_file.read_text(encoding="ascii"), "inactive")

    def test_rollback_identity_cleanup_restores_recorded_result(self):
        rollback = (DEPLOY_ROOT / "rollback-root.sh").read_text()
        identity_start = rollback.index(
            '  if [[ "$(record_boolean serviceUserExisted)" == "false" ]]'
        )
        identity_end = rollback.index('  printf \'%s\\n\' "ROLLBACK: PASS"', identity_start)
        identity_cleanup = rollback[identity_start:identity_end]

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = root / "harness.sh"
            pgrep = root / "pgrep"
            userdel = root / "userdel"
            groupdel = root / "groupdel"
            harness.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "SERVICE_USER=isolated-service-user\n"
                "SERVICE_GROUP=isolated-service-group\n"
                "fail() { printf '%s\\n' \"ROLLBACK_BLOCKED: $1\" >&2; exit 1; }\n"
                "record_boolean() {\n"
                "  case \"$1\" in\n"
                "    serviceUserExisted) printf '%s' \"$USER_PREEXISTED\" ;;\n"
                "    serviceGroupExisted) printf '%s' \"$GROUP_PREEXISTED\" ;;\n"
                "    *) exit 1 ;;\n"
                "  esac\n"
                "}\n"
                + identity_cleanup
                + "printf '%s\\n' IDENTITY_CLEANUP_PASS\n",
                encoding="utf-8",
            )
            pgrep.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
            userdel.write_text(
                "#!/usr/bin/env bash\n"
                "set -eu\n"
                "[[ -f \"$IDENTITY_STATE/user\" ]] || exit 6\n"
                "rm \"$IDENTITY_STATE/user\"\n",
                encoding="utf-8",
            )
            groupdel.write_text(
                "#!/usr/bin/env bash\n"
                "set -eu\n"
                "[[ ! -f \"$IDENTITY_STATE/user\" ]] || exit 8\n"
                "[[ -f \"$IDENTITY_STATE/group\" ]] || exit 6\n"
                "rm \"$IDENTITY_STATE/group\"\n",
                encoding="utf-8",
            )
            for path in (harness, pgrep, userdel, groupdel):
                os.chmod(path, 0o755)

            environment = os.environ.copy()
            environment["PATH"] = str(root) + os.pathsep + environment["PATH"]
            cases = (
                ("created-by-install", "false", "false", False),
                ("preexisting", "true", "true", True),
            )
            for scenario, user_preexisted, group_preexisted, should_remain in cases:
                with self.subTest(scenario=scenario):
                    state = root / scenario
                    state.mkdir()
                    (state / "user").touch()
                    (state / "group").touch()
                    environment["IDENTITY_STATE"] = str(state)
                    environment["USER_PREEXISTED"] = user_preexisted
                    environment["GROUP_PREEXISTED"] = group_preexisted
                    result = subprocess.run(
                        ["bash", str(harness)],
                        capture_output=True,
                        text=True,
                        check=False,
                        env=environment,
                    )
                    output = result.stdout + result.stderr
                    self.assertEqual(result.returncode, 0, output)
                    self.assertIn("IDENTITY_CLEANUP_PASS", output)
                    self.assertEqual((state / "user").exists(), should_remain)
                    self.assertEqual((state / "group").exists(), should_remain)

    def test_repository_assets_contain_no_generated_or_credential_material(self):
        excluded = {"test_deployment_assets.py", "README.md"}
        candidates = [
            path
            for path in DEPLOY_ROOT.rglob("*")
            if path.is_file() and path.name not in excluded and "__pycache__" not in path.parts
        ]
        combined = "\n".join(path.read_text(errors="replace") for path in candidates)
        self.assertNotIn("-----BEGIN", combined)
        self.assertNotRegex(combined, re.compile(r"(?i)(password|token|secret)\s*="))
        addresses = set(re.findall(r"(?<![0-9])(?:\d{1,3}\.){3}\d{1,3}(?![0-9])", combined))
        self.assertEqual(
            addresses,
            {
                "10.0.0.0",
                "127.0.0.0",
                "127.0.0.1",
                "172.16.0.0",
                "192.0.2.0",
                "192.0.2.123",
                "192.168.0.0",
            },
        )
        self.assertNotIn("website.example", combined)
        self.assertNotIn("monitor.example", combined)


if __name__ == "__main__":
    unittest.main()

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
    def test_private_negative_gate_rejects_successful_tls_handshake(self):
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

            server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server_context.load_cert_chain(server_certificate, server_key)
            self.assertEqual(server_context.verify_mode, ssl.CERT_NONE)
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            server_errors: list[BaseException] = []

            def serve_once() -> None:
                try:
                    connection, _ = listener.accept()
                    with server_context.wrap_socket(connection, server_side=True):
                        pass
                except Exception as error:  # pragma: no cover - assertion below
                    server_errors.append(error)
                finally:
                    listener.close()

            server_thread = threading.Thread(target=serve_once)
            server_thread.start()
            manifest = sanitized_manifest(root / "backup")
            manifest["network"]["privateListener"]["port"] = listener.getsockname()[1]
            manifest["pki"]["privateServer"]["expectedSan"] = "127.0.0.1"

            with self.assertRaises(preflight_module.PreflightError) as raised:
                preflight_module._validate_private_negative_gate(manifest, root)
            server_thread.join(timeout=5)
            self.assertFalse(server_thread.is_alive())
            self.assertEqual(server_errors, [])
            self.assertEqual(raised.exception.code, "private_mtls_negative_gate_failed")
            self.assertEqual(
                str(raised.exception),
                "private_mtls_negative_gate_failed at runtime_postcheck",
            )

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

            os.chmod(parent, 0o777)
            with self.assertRaises(preflight_module.PreflightError) as raised:
                preflight_module.validate_backup(backup, manifest, phase="precheck")
            self.assertEqual(raised.exception.code, "mode_mismatch")
            self.assertEqual(raised.exception.check, "backup_parent")

            os.chmod(parent, 0o700)
            preflight_module.validate_backup(backup, manifest, phase="precheck")

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
        self.assertIn("stop_service_if_active() {", rollback)
        self.assertIn('systemctl stop "$service_name" || :', rollback)
        self.assertEqual(
            rollback.count('systemctl is-active --quiet "$service_name"'), 2
        )
        self.assertLess(
            rollback.index("stop_service_if_active monitor-gateway-public.service"),
            rollback.index("stop_service_if_active monitor-gateway-private.service"),
        )
        self.assertNotIn("systemctl stop monitor-gateway-public.service", rollback)
        self.assertNotIn("systemctl stop monitor-gateway-private.service", rollback)
        self.assertLess(rollback.index("restore_current_link"), rollback.index("wg-quick down"))
        self.assertIn("BACKUP_EVIDENCE_PRESERVED: YES", rollback)

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

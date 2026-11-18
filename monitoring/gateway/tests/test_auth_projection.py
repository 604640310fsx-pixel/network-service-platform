#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import http.client
import json
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

from monitoring.gateway.auth_projection import (
    AuthProjectionError,
    project_target_catalog,
    project_target_status,
)
from monitoring.gateway.client import (
    AUTH_SERVICE_IDENTITY,
    OPERATOR_IDENTITY,
    PUBLIC_BFF_IDENTITY,
    RAW_CATALOG_MAX_BYTES,
    RAW_STATUS_MAX_BYTES,
    IdentityRegistry,
    RawMonitorClient,
    UpstreamNotFound,
    UpstreamSchemaInvalid,
    UpstreamTimeout,
    UpstreamUnavailable,
    build_mtls_client_context,
    build_mtls_server_context,
)
from monitoring.gateway.security import SafeEventLogger
from monitoring.gateway.server import PrivateDependencies, make_private_handler
from monitoring.gateway.tests.test_gateway import raw_latency, raw_overview


NOW = datetime(2030, 1, 1, 0, 2, tzinfo=timezone.utc)


def raw_catalog():
    return {
        "targets": [
            {
                "target_name": "Target A",
                "display_name": "账户服务器 A",
                "target_host": "192.0.2.10",
                "tcp_port": 443,
                "collector_enabled": True,
                "customer_state": "active",
                "has_data": True,
                "samples": 4,
                "latest_timestamp": "2030-01-01T00:01:00Z",
            },
            {
                "target_name": "Paused B",
                "display_name": "维护中的服务器 B",
                "target_host": "192.0.2.11",
                "tcp_port": 8443,
                "collector_enabled": False,
                "customer_state": "disabled",
                "has_data": False,
                "samples": 0,
                "latest_timestamp": None,
            },
            {
                "target_name": "Retired C",
                "display_name": "已退役服务器 C",
                "target_host": "192.0.2.12",
                "tcp_port": None,
                "collector_enabled": False,
                "customer_state": "retired",
                "has_data": False,
                "samples": 0,
                "latest_timestamp": None,
            },
        ]
    }


def raw_status(*, online=True, source_status="ok", fresh=True, item=True):
    return {
        "source": "nezha-public",
        "source_status": source_status,
        "customer_state": "active",
        "fresh": fresh,
        "updated_at": "2030-01-01T00:01:00Z",
        "snapshot_age_seconds": 1.2,
        "target": "Target A",
        "target_host": "192.0.2.10",
        "item": (
            {
                "target_name": "Target A",
                "target_host": "192.0.2.10",
                "online": online,
                "uptime_seconds": 100,
                "cpu_percent": 10.5,
                "memory_percent": 20.5,
                "storage_percent": 30.5,
                "upload_bytes_per_second": 1000,
                "download_bytes_per_second": 2000,
                "last_active": "2030-01-01T00:01:00Z",
            }
            if item
            else None
        ),
    }


class _RawReader:
    def __init__(self):
        self.catalog = raw_catalog()
        self.status = raw_status()
        self.catalog_error = None
        self.status_error = None
        self.status_calls = []

    def read_projection_inputs(self):
        return raw_overview(), raw_latency()

    def read_target_catalog(self):
        if self.catalog_error is not None:
            raise self.catalog_error
        return deepcopy(self.catalog)

    def read_target_status(self, target):
        self.status_calls.append(target)
        if self.status_error is not None:
            raise self.status_error
        payload = deepcopy(self.status)
        payload["target"] = target
        if isinstance(payload.get("item"), dict):
            payload["item"]["target_name"] = target
        return payload


def registry():
    values = {
        PUBLIC_BFF_IDENTITY: b"public",
        AUTH_SERVICE_IDENTITY: b"auth",
        OPERATOR_IDENTITY: b"operator",
    }
    return IdentityRegistry(
        {role: hashlib.sha256(value).hexdigest() for role, value in values.items()}
    )


class _RunningServer:
    def __init__(self, handler):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, _type, _value, _traceback):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, method, path, *, body=None, headers=None):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=2
        )
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        return response.status, response_headers, payload


class ProjectionTests(unittest.TestCase):
    def test_catalog_is_a_new_exact_projection_without_private_fields(self):
        projection = project_target_catalog(raw_catalog())
        self.assertEqual(
            projection,
            (
                {"key": "Target A", "label": "账户服务器 A", "state": "active"},
                {"key": "Paused B", "label": "维护中的服务器 B", "state": "disabled"},
                {"key": "Retired C", "label": "已退役服务器 C", "state": "retired"},
            ),
        )
        encoded = json.dumps(projection, ensure_ascii=False)
        self.assertNotIn("target_host", encoded)
        self.assertNotIn("collector_enabled", encoded)
        self.assertNotIn("192.0.2.", encoded)

    def test_catalog_rejects_unknown_fields_duplicates_and_lifecycle_drift(self):
        cases = []
        extra = raw_catalog()
        extra["targets"][0]["secret"] = "hidden"
        cases.append(extra)
        duplicate = raw_catalog()
        duplicate["targets"][1]["target_name"] = "Target A"
        cases.append(duplicate)
        bad_state = raw_catalog()
        bad_state["targets"][0]["customer_state"] = "paused"
        cases.append(bad_state)
        bad_count = raw_catalog()
        bad_count["targets"][0]["samples"] = True
        cases.append(bad_count)
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(AuthProjectionError):
                project_target_catalog(payload)

    def test_status_maps_online_offline_stale_and_rejects_private_schema_drift(self):
        catalog_with_native_timestamp = raw_catalog()
        catalog_with_native_timestamp["targets"][0]["latest_timestamp"] = (
            "2030-01-01T00:01:00.123456+00:00"
        )
        self.assertEqual(
            project_target_catalog(catalog_with_native_timestamp)[0]["key"],
            "Target A",
        )
        status_with_native_timestamp = raw_status()
        status_with_native_timestamp["item"]["last_active"] = (
            "2030-01-01T00:01:00.123Z"
        )
        self.assertEqual(
            project_target_status(status_with_native_timestamp, "Target A"),
            {
                "status": "online",
                "updatedAt": "2030-01-01T00:01:00Z",
                "stale": False,
            },
        )
        self.assertEqual(
            project_target_status(raw_status(online=False), "Target A")["status"],
            "offline",
        )
        self.assertEqual(
            project_target_status(
                raw_status(source_status="stale", fresh=False), "Target A"
            ),
            {
                "status": "stale",
                "updatedAt": "2030-01-01T00:01:00Z",
                "stale": True,
            },
        )
        invalid = raw_status()
        invalid["private_extra"] = "hidden"
        with self.assertRaises(AuthProjectionError):
            project_target_status(invalid, "Target A")
        with self.assertRaisesRegex(AuthProjectionError, "monitor_unavailable"):
            project_target_status(
                raw_status(source_status="connecting", fresh=False, item=False),
                "Target A",
            )


class HttpTests(unittest.TestCase):
    def dependencies(self, reader, logs=None):
        lines = [] if logs is None else logs
        return PrivateDependencies(
            raw_reader=reader,
            identities=registry(),
            logger=SafeEventLogger(lines.append),
            now=lambda: NOW,
        )

    def test_identity_acl_matrix_and_exact_auth_projections(self):
        reader = _RawReader()
        logs = []
        handler = make_private_handler(self.dependencies(reader, logs))
        current = [AUTH_SERVICE_IDENTITY]
        handler._identity = lambda _self: current[0]
        with _RunningServer(handler) as server:
            status, headers, body = server.request(
                "GET", "/api/auth-service/targets"
            )
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            self.assertEqual(
                json.loads(body),
                {
                    "items": [
                        {"key": "Target A", "label": "账户服务器 A", "state": "active"},
                        {"key": "Paused B", "label": "维护中的服务器 B", "state": "disabled"},
                        {"key": "Retired C", "label": "已退役服务器 C", "state": "retired"},
                    ]
                },
            )
            self.assertNotIn(b"target_host", body)

            status, _, body = server.request(
                "GET", "/api/auth-service/status?target=Target%20A"
            )
            self.assertEqual(status, 200)
            self.assertEqual(
                json.loads(body),
                {
                    "status": "online",
                    "updatedAt": "2030-01-01T00:01:00Z",
                    "stale": False,
                },
            )
            self.assertNotIn(b"target", body)
            status, _, _ = server.request("GET", "/api/public-summary")
            self.assertEqual(status, 403)

            current[0] = PUBLIC_BFF_IDENTITY
            status, _, _ = server.request("GET", "/api/public-summary")
            self.assertEqual(status, 200)
            for path in (
                "/api/auth-service/targets",
                "/api/auth-service/status?target=Target%20A",
            ):
                self.assertEqual(server.request("GET", path)[0], 403)

            for identity in (OPERATOR_IDENTITY, None):
                current[0] = identity
                for path in (
                    "/api/public-summary",
                    "/api/auth-service/targets",
                    "/api/auth-service/status?target=Target%20A",
                ):
                    self.assertEqual(server.request("GET", path)[0], 403)

        self.assertTrue(logs)
        self.assertTrue(all("Target A" not in line for line in logs))
        self.assertTrue(all("/api/" not in line for line in logs))

    def test_query_body_and_method_gates_are_exact(self):
        reader = _RawReader()
        handler = make_private_handler(self.dependencies(reader))
        handler._identity = lambda _self: AUTH_SERVICE_IDENTITY
        invalid_paths = (
            "/api/auth-service/targets?extra=",
            "/api/auth-service/status",
            "/api/auth-service/status?target=",
            "/api/auth-service/status?target=Target%20A&extra=",
            "/api/auth-service/status?target=Target%20A&target=Paused%20B",
            "/api/auth-service/status?target=%20Target%20A",
            "/api/auth-service/status?target=bad%00key",
            "/api/auth-service/status?target=%FF",
            "/api/auth-service/status?target=%",
        )
        with _RunningServer(handler) as server:
            for path in invalid_paths:
                with self.subTest(path=path):
                    status, _, body = server.request("GET", path)
                    self.assertEqual(status, 400)
                    self.assertEqual(
                        json.loads(body), {"error": {"code": "invalid_request"}}
                    )

            for path in (
                "/api/auth-service/targets",
                "/api/auth-service/status?target=Target%20A",
            ):
                status, _, body = server.request("GET", path, body=b"{}")
                self.assertEqual(status, 400)
                self.assertEqual(
                    json.loads(body), {"error": {"code": "invalid_request"}}
                )
                for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"):
                    status, headers, body = server.request(method, path)
                    self.assertEqual(status, 405)
                    self.assertEqual(headers.get("Allow"), "GET")
                    self.assertEqual(
                        json.loads(body),
                        {"error": {"code": "method_not_allowed"}},
                    )
                status, headers, body = server.request("HEAD", path)
                self.assertEqual(status, 405)
                self.assertEqual(headers.get("Allow"), "GET")
                self.assertEqual(body, b"")

    def test_inactive_missing_and_upstream_failures_map_without_fallback(self):
        reader = _RawReader()
        handler = make_private_handler(self.dependencies(reader))
        handler._identity = lambda _self: AUTH_SERVICE_IDENTITY
        with _RunningServer(handler) as server:
            for target, expected in (("Paused%20B", 409), ("Retired%20C", 409), ("Missing", 404)):
                status, _, body = server.request(
                    "GET", f"/api/auth-service/status?target={target}"
                )
                self.assertEqual(status, expected)
                self.assertEqual(reader.status_calls, [])
                self.assertIn(
                    json.loads(body)["error"]["code"],
                    ("target_unavailable", "target_not_found"),
                )

            for error, expected_status, expected_code in (
                (UpstreamNotFound("missing"), 404, "target_not_found"),
                (UpstreamTimeout("timeout"), 504, "monitor_unavailable"),
                (UpstreamSchemaInvalid("schema"), 502, "monitor_invalid_response"),
                (UpstreamUnavailable("down"), 503, "monitor_unavailable"),
            ):
                reader.status_error = error
                status, _, body = server.request(
                    "GET", "/api/auth-service/status?target=Target%20A"
                )
                self.assertEqual(status, expected_status)
                self.assertEqual(
                    json.loads(body), {"error": {"code": expected_code}}
                )

            reader.status_error = None
            reader.status = raw_status(
                source_status="not_connected", fresh=False, item=False
            )
            status, _, body = server.request(
                "GET", "/api/auth-service/status?target=Target%20A"
            )
            self.assertEqual(status, 503)
            self.assertEqual(
                json.loads(body), {"error": {"code": "monitor_unavailable"}}
            )


class RawClientBoundsTests(unittest.TestCase):
    def test_raw_client_uses_only_fixed_paths_and_per_route_bounds(self):
        class FakeClient:
            def __init__(self):
                self.calls = []

            def get(self, path, *, max_bytes=None):
                self.calls.append((path, max_bytes))
                return {}

        fixed = FakeClient()
        client = RawMonitorClient(fixed)
        client.read_target_catalog()
        client.read_target_status("香港 Target A")
        self.assertEqual(
            fixed.calls,
            [
                ("/api/vps-targets", RAW_CATALOG_MAX_BYTES),
                (
                    "/api/vps-status?target=%E9%A6%99%E6%B8%AF%20Target%20A",
                    RAW_STATUS_MAX_BYTES,
                ),
            ],
        )
        with self.assertRaises(Exception):
            client.read_target_status(" bad")


@unittest.skipUnless(shutil.which("openssl"), "openssl is required for local mTLS proof")
class MutualTlsAclTests(unittest.TestCase):
    def run_openssl(self, *arguments):
        subprocess.run(
            ["openssl", *arguments],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def issue(self, root, name, common_name, extension, *, first=False):
        self.run_openssl(
            "req", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-keyout", str(root / f"{name}.key"),
            "-out", str(root / f"{name}.csr"),
            "-subj", f"/CN={common_name}",
        )
        serial = ["-CAcreateserial"] if first else ["-CAserial", str(root / "ca.srl")]
        self.run_openssl(
            "x509", "-req", "-in", str(root / f"{name}.csr"),
            "-CA", str(root / "ca.crt"), "-CAkey", str(root / "ca.key"),
            *serial,
            "-out", str(root / f"{name}.crt"), "-days", "1", "-sha256",
            "-extfile", str(root / extension),
        )

    def test_two_clients_are_path_scoped_rotation_revokes_old_auth_and_hostname_is_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.run_openssl(
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
                "-keyout", str(root / "ca.key"), "-out", str(root / "ca.crt"),
                "-days", "1", "-subj", "/CN=gateway-auth-test-ca",
                "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign",
            )
            (root / "server.ext").write_text(
                "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n",
                encoding="ascii",
            )
            (root / "client.ext").write_text(
                "extendedKeyUsage=clientAuth\n", encoding="ascii"
            )
            self.issue(root, "server", "localhost", "server.ext", first=True)
            for name in ("public", "auth-old", "auth-new", "operator"):
                self.issue(root, name, name, "client.ext")

            identities = IdentityRegistry.from_certificate_files(
                {
                    PUBLIC_BFF_IDENTITY: root / "public.crt",
                    AUTH_SERVICE_IDENTITY: root / "auth-new.crt",
                    OPERATOR_IDENTITY: root / "operator.crt",
                }
            )
            dependencies = PrivateDependencies(
                raw_reader=_RawReader(),
                identities=identities,
                logger=SafeEventLogger(lambda _line: None),
                now=lambda: NOW,
            )
            server = ThreadingHTTPServer(
                ("localhost", 0), make_private_handler(dependencies)
            )
            server_context = build_mtls_server_context(
                ca_file=root / "ca.crt",
                certificate_file=root / "server.crt",
                key_file=root / "server.key",
            )
            server.socket = server_context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def request(client_name, host, path):
                context = build_mtls_client_context(
                    ca_file=root / "ca.crt",
                    certificate_file=root / f"{client_name}.crt",
                    key_file=root / f"{client_name}.key",
                )
                connection = http.client.HTTPSConnection(
                    host, server.server_address[1], timeout=3, context=context
                )
                try:
                    connection.request("GET", path)
                    response = connection.getresponse()
                    return response.status, response.read()
                finally:
                    connection.close()

            try:
                self.assertEqual(request("public", "localhost", "/api/public-summary")[0], 200)
                self.assertEqual(request("public", "localhost", "/api/auth-service/targets")[0], 403)
                self.assertEqual(request("auth-new", "localhost", "/api/auth-service/targets")[0], 200)
                self.assertEqual(request("auth-new", "localhost", "/api/public-summary")[0], 403)
                self.assertEqual(request("operator", "localhost", "/api/public-summary")[0], 403)
                self.assertEqual(request("operator", "localhost", "/api/auth-service/targets")[0], 403)
                self.assertEqual(request("auth-old", "localhost", "/api/auth-service/targets")[0], 403)
                with self.assertRaises((ssl.SSLError, OSError)):
                    request("auth-new", "127.0.0.1", "/api/auth-service/targets")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()

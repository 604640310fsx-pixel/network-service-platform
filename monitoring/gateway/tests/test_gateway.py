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
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from monitoring.gateway.client import (
    AUTH_SERVICE_IDENTITY,
    PUBLIC_BFF_IDENTITY,
    FixedJsonClient,
    IdentityRegistry,
    Origin,
    UpstreamSchemaInvalid,
    UpstreamTimeout,
    UpstreamUnavailable,
    build_mtls_client_context,
    build_mtls_server_context,
)
from monitoring.gateway.projection import (
    PUBLIC_WAN_FIELDS,
    ProjectionError,
    project_public_summary,
    validate_public_summary,
)
from monitoring.gateway.security import (
    SafeEventLogger,
    SecurityBoundaryError,
    TokenBucketLimiter,
    scan_public_files,
    scan_public_value,
    validate_origin,
    validate_private_bind_host,
    validate_public_parent_origin,
)
from monitoring.gateway.server import (
    PrivateDependencies,
    PublicDependencies,
    make_private_handler,
    make_public_handler,
)


NOW = datetime(2030, 1, 1, 0, 2, tzinfo=timezone.utc)
FRESH = "2030-01-01T00:01:00Z"
STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


def raw_overview():
    return {
        "generated_at": "2030-01-01T00:02:00Z",
        "latest_update": FRESH,
        "overall": {"status": "down", "label": "private label"},
        "wans": {
            "telecom": {
                "display_name": "private carrier label",
                "interface": "private-interface-value",
                "source_ip": "private-source-value",
                "status": "normal",
                "latest_timestamp": FRESH,
                "current_ms": 12.34,
                "alidns_loss_percent": 0,
                "target_host": "private-target-value",
                "cpu": 20,
            },
            "mobile": {
                "display_name": "private carrier label",
                "interface": "private-interface-value",
                "source_ip": "private-source-value",
                "status": "degraded",
                "latest_timestamp": FRESH,
                "current_ms": None,
                "alidns_loss_percent": 12.5,
                "target_host": "private-target-value",
            },
            "unicom": {
                "display_name": "private carrier label",
                "interface": "private-interface-value",
                "source_ip": "private-source-value",
                "status": "down",
                "latest_timestamp": FRESH,
                "current_ms": None,
                "alidns_loss_percent": 100,
                "target_host": "private-target-value",
            },
        },
        "runtime": {"memory": 50, "storage": 70},
        "database": {"bytes": 123},
    }


def raw_latency():
    return {
        "range": "6h",
        "type": "icmp",
        "target": "AliDNS",
        "samples": [
            {
                "timestamp": "2030-01-01T00:00:00Z",
                "wan": "telecom",
                "target_name": "AliDNS",
                "test_type": "icmp",
                "success": 1,
                "avg_ms": 11.2,
                "source_ip": "private-source-value",
                "target_host": "private-target-value",
            },
            {
                "timestamp": FRESH,
                "wan": "telecom",
                "target_name": "AliDNS",
                "test_type": "icmp",
                "success": 1,
                "avg_ms": 12.34,
            },
            {
                "timestamp": "2030-01-01T00:00:00Z",
                "wan": "mobile",
                "target_name": "AliDNS",
                "test_type": "icmp",
                "success": 1,
                "avg_ms": 25,
            },
            {
                "timestamp": FRESH,
                "wan": "mobile",
                "target_name": "AliDNS",
                "test_type": "icmp",
                "success": 0,
                "avg_ms": None,
            },
            {
                "timestamp": FRESH,
                "wan": "unicom",
                "target_name": "AliDNS",
                "test_type": "icmp",
                "success": 0,
                "avg_ms": None,
            },
        ],
    }


def public_summary():
    return project_public_summary(raw_overview(), raw_latency(), now=NOW)


class ProjectionTests(unittest.TestCase):
    def test_constructs_a_new_exact_allowlist_and_drops_private_identity(self):
        payload = public_summary()
        self.assertEqual([item["wanId"] for item in payload["wans"]], ["telecom", "mobile", "unicom"])
        self.assertTrue(all(set(item).issubset(PUBLIC_WAN_FIELDS) for item in payload["wans"]))
        self.assertEqual(payload["wans"][0]["displayName"], "电信")
        self.assertEqual(payload["wans"][0]["latestLatencyMs"], 12.34)
        self.assertNotIn("latestLatencyMs", payload["wans"][1])
        self.assertEqual(payload["wans"][1]["trend"], [25.0, None])
        self.assertEqual(payload["wans"][2]["status"], "unavailable")
        self.assertEqual(scan_public_value(payload), [])
        encoded = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("private-source-value", encoded)
        self.assertNotIn("private-target-value", encoded)
        self.assertNotIn("private-interface-value", encoded)

    def test_stale_and_no_data_never_return_old_metrics_as_current(self):
        overview = raw_overview()
        overview["wans"]["telecom"]["latest_timestamp"] = (
            NOW - timedelta(minutes=10)
        ).isoformat().replace("+00:00", "Z")
        overview["wans"]["mobile"].update(
            {
                "status": "stale",
                "latest_timestamp": None,
                "current_ms": None,
                "alidns_loss_percent": None,
            }
        )
        latency = raw_latency()
        old_timestamp = (NOW - timedelta(minutes=10)).isoformat().replace(
            "+00:00", "Z"
        )
        for sample in latency["samples"]:
            if sample["wan"] == "telecom":
                sample["timestamp"] = old_timestamp
        latency["samples"] = [
            sample for sample in latency["samples"] if sample["wan"] != "mobile"
        ]
        payload = project_public_summary(overview, latency, now=NOW)
        telecom, mobile, _ = payload["wans"]
        self.assertEqual(telecom["status"], "stale")
        self.assertTrue(telecom["stale"])
        self.assertNotIn("latestLatencyMs", telecom)
        self.assertIsNone(telecom["packetLossSummary"])
        self.assertEqual(telecom["trend"], [])
        self.assertEqual(mobile["status"], "no_data")
        self.assertFalse(mobile["stale"])
        self.assertIsNone(mobile["updatedAt"])
        self.assertIsNone(mobile["packetLossSummary"])
        self.assertEqual(mobile["trend"], [])

    def test_projection_fails_closed_on_missing_wan_invalid_status_or_bad_probe(self):
        overview = raw_overview()
        del overview["wans"]["mobile"]
        with self.assertRaises(ProjectionError):
            project_public_summary(overview, raw_latency(), now=NOW)

        overview = raw_overview()
        overview["wans"]["mobile"]["status"] = "unknown-private-state"
        with self.assertRaises(ProjectionError):
            project_public_summary(overview, raw_latency(), now=NOW)

        latency = raw_latency()
        latency["samples"][0]["success"] = "yes"
        with self.assertRaises(ProjectionError):
            project_public_summary(raw_overview(), latency, now=NOW)

    def test_public_validator_rejects_extra_fields_and_inconsistent_stale_metrics(self):
        payload = public_summary()
        payload["wans"][0]["source_ip"] = "hidden"
        with self.assertRaises(ProjectionError):
            validate_public_summary(payload)

        payload = public_summary()
        payload["wans"][0].update({"status": "stale", "stale": True})
        with self.assertRaises(ProjectionError):
            validate_public_summary(payload)


class SecurityTests(unittest.TestCase):
    def test_static_assets_and_projected_payload_have_zero_negative_scan_findings(self):
        files = [STATIC_ROOT / name for name in ("index.html", "master.css", "app.js")]
        self.assertEqual(scan_public_files(files), [])
        self.assertEqual(scan_public_value(public_summary()), [])

    def test_origin_and_listener_validation_enforce_private_boundaries(self):
        self.assertEqual(
            validate_origin("https://10.0.0.2:8443", require_https=True, private_only=True),
            ("https", "10.0.0.2", 8443),
        )
        self.assertEqual(
            validate_origin("http://127.0.0.1:3002", require_https=False, private_only=True),
            ("http", "127.0.0.1", 3002),
        )
        for value in (
            "https://8.8.8.8",
            "https://name.example",
            "https://user:pass@10.0.0.2",
            "https://10.0.0.2/path",
            "https://10.0.0.2?query=value",
        ):
            with self.subTest(value=value), self.assertRaises(SecurityBoundaryError):
                validate_origin(value, require_https=True, private_only=True)
        with self.assertRaises(SecurityBoundaryError):
            validate_private_bind_host("0.0.0.0")
        self.assertEqual(validate_private_bind_host("127.0.0.1"), "127.0.0.1")
        self.assertEqual(
            validate_public_parent_origin("https://website.example"),
            "https://website.example",
        )
        with self.assertRaises(SecurityBoundaryError):
            validate_public_parent_origin("https://*.example")

    def test_rate_limit_is_thirty_per_minute_with_burst_ten(self):
        clock = [0.0]
        limiter = TokenBucketLimiter(clock=lambda: clock[0])
        self.assertTrue(all(limiter.consume("client") for _ in range(10)))
        self.assertFalse(limiter.consume("client"))
        clock[0] += 2
        self.assertTrue(limiter.consume("client"))
        self.assertFalse(limiter.consume("client"))
        clock[0] += 60
        self.assertTrue(all(limiter.consume("client") for _ in range(10)))

    def test_rate_limit_state_is_bounded_and_fails_closed(self):
        clock = [0.0]
        limiter = TokenBucketLimiter(max_clients=1, clock=lambda: clock[0])
        self.assertTrue(limiter.consume("first"))
        self.assertFalse(limiter.consume("second"))
        clock[0] += 81
        self.assertTrue(limiter.consume("second"))

    def test_safe_logger_never_records_ip_url_query_or_body(self):
        lines: list[str] = []
        logger = SafeEventLogger(lines.append)
        client_id = logger.client_id("sensitive-client-address")
        logger.write("public_request", status=200, client_id=client_id)
        self.assertEqual(len(lines), 1)
        self.assertNotIn("sensitive-client-address", lines[0])
        self.assertNotIn("/api/", lines[0])
        self.assertEqual(json.loads(lines[0])["event"], "public_request")

    def test_service_certificates_map_to_distinct_revocable_roles(self):
        public_certificate = b"public certificate"
        auth_certificate = b"auth certificate"
        registry = IdentityRegistry(
            {
                PUBLIC_BFF_IDENTITY: hashlib.sha256(public_certificate).hexdigest(),
                AUTH_SERVICE_IDENTITY: hashlib.sha256(auth_certificate).hexdigest(),
            }
        )
        self.assertEqual(
            registry.resolve_der_certificate(public_certificate), PUBLIC_BFF_IDENTITY
        )
        self.assertEqual(
            registry.resolve_der_certificate(auth_certificate), AUTH_SERVICE_IDENTITY
        )
        self.assertIsNone(registry.resolve_der_certificate(b"revoked certificate"))
        duplicate = hashlib.sha256(public_certificate).hexdigest()
        with self.assertRaises(SecurityBoundaryError):
            IdentityRegistry(
                {PUBLIC_BFF_IDENTITY: duplicate, AUTH_SERVICE_IDENTITY: duplicate}
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

    def request(self, method: str, path: str):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=2
        )
        connection.request(method, path)
        response = connection.getresponse()
        body = response.read()
        headers = dict(response.getheaders())
        connection.close()
        return response.status, headers, body


class _SummaryReader:
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result if result is not None else public_summary()
        self.error = error

    def read_public_summary(self):
        if self.error is not None:
            raise self.error
        return deepcopy(self.result)


class _RawReader:
    def __init__(self, error: Exception | None = None):
        self.error = error

    def read_projection_inputs(self):
        if self.error is not None:
            raise self.error
        return raw_overview(), raw_latency()


def public_dependencies(reader=None, *, limiter=None, logs=None, static_root=STATIC_ROOT):
    lines = logs if logs is not None else []
    return PublicDependencies(
        summary_reader=reader or _SummaryReader(),
        parent_origin="https://website.example",
        limiter=limiter or TokenBucketLimiter(),
        logger=SafeEventLogger(lines.append),
        static_root=static_root,
    )


def registry_for(certificate=b"test certificate"):
    return IdentityRegistry(
        {PUBLIC_BFF_IDENTITY: hashlib.sha256(certificate).hexdigest()}
    )


class HttpBoundaryTests(unittest.TestCase):
    def test_public_summary_static_headers_and_method_gate(self):
        logs: list[str] = []
        handler = make_public_handler(public_dependencies(logs=logs))
        with _RunningServer(handler) as server:
            status, headers, body = server.request("GET", "/api/summary")
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            self.assertIn("frame-ancestors https://website.example", headers.get("Content-Security-Policy", ""))
            self.assertNotIn("X-Frame-Options", headers)
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertNotIn("Set-Cookie", headers)
            self.assertEqual(scan_public_value(json.loads(body)), [])

            status, headers, body = server.request("HEAD", "/")
            self.assertEqual(status, 200)
            self.assertGreater(int(headers["Content-Length"]), 0)
            self.assertEqual(body, b"")

            status, _, body = server.request("GET", "/")
            self.assertEqual(status, 200)
            self.assertIn(
                b'<meta name="monitor-parent-origin" content="https://website.example">',
                body,
            )
            self.assertNotIn(b"__MONITOR_PARENT_ORIGIN__", body)

            status, headers, body = server.request("POST", "/api/summary")
            self.assertEqual(status, 405)
            self.assertEqual(headers.get("Allow"), "GET")
            self.assertEqual(json.loads(body)["error"]["code"], "method_not_allowed")

            status, _, _ = server.request("GET", "/api/summary?hidden=value")
            self.assertEqual(status, 404)
            status, _, body = server.request("TRACE", "/api/summary")
            self.assertEqual(status, 501)
            self.assertEqual(json.loads(body)["error"]["code"], "monitor_unavailable")
            self.assertNotIn(b"TRACE", body)
        self.assertTrue(logs)
        self.assertTrue(all("hidden=value" not in line for line in logs))

    def test_public_index_fails_closed_when_parent_origin_placeholder_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text("<!doctype html><title>invalid</title>")
            handler = make_public_handler(public_dependencies(static_root=root))
            with _RunningServer(handler) as server:
                status, _, body = server.request("GET", "/")
            self.assertEqual(status, 503)
            self.assertEqual(
                json.loads(body),
                {"error": {"code": "monitor_unavailable"}},
            )

    def test_public_failure_mapping_never_returns_old_metrics(self):
        cases = (
            (UpstreamTimeout("timeout"), 504),
            (UpstreamUnavailable("down"), 503),
            (UpstreamSchemaInvalid("schema"), 502),
        )
        for error, expected in cases:
            with self.subTest(error=type(error).__name__):
                handler = make_public_handler(
                    public_dependencies(reader=_SummaryReader(error=error))
                )
                with _RunningServer(handler) as server:
                    status, _, body = server.request("GET", "/api/summary")
                self.assertEqual(status, expected)
                self.assertEqual(json.loads(body), {"error": {"code": "monitor_unavailable"}})
                self.assertNotIn(b"wans", body)

        handler = make_public_handler(
            public_dependencies(reader=_SummaryReader(error=RuntimeError("private detail")))
        )
        with _RunningServer(handler) as server:
            status, _, body = server.request("GET", "/api/summary")
        self.assertEqual(status, 503)
        self.assertNotIn(b"private detail", body)

    def test_public_rate_limit_enforces_the_frozen_burst(self):
        clock = [0.0]
        limiter = TokenBucketLimiter(clock=lambda: clock[0])
        handler = make_public_handler(public_dependencies(limiter=limiter))
        with _RunningServer(handler) as server:
            statuses = [server.request("GET", "/api/summary")[0] for _ in range(11)]
        self.assertEqual(statuses[:10], [200] * 10)
        self.assertEqual(statuses[10], 429)

    def test_private_route_is_get_only_private_no_store_and_identity_scoped(self):
        certificate = b"test certificate"
        dependencies = PrivateDependencies(
            raw_reader=_RawReader(),
            identities=registry_for(certificate),
            logger=SafeEventLogger(lambda _line: None),
            now=lambda: NOW,
        )
        handler = make_private_handler(dependencies)
        # The production path resolves an actual TLS peer certificate. This
        # local-only HTTP harness replaces only that transport lookup.
        handler._identity = lambda _self: PUBLIC_BFF_IDENTITY
        with _RunningServer(handler) as server:
            status, headers, body = server.request("GET", "/api/public-summary")
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertEqual(scan_public_value(json.loads(body)), [])
            status, headers, _ = server.request("POST", "/api/public-summary")
            self.assertEqual(status, 405)
            self.assertEqual(headers.get("Allow"), "GET")
            handler._identity = lambda _self: AUTH_SERVICE_IDENTITY
            status, _, body = server.request("GET", "/api/public-summary")
            self.assertEqual(status, 403)
            self.assertEqual(json.loads(body)["error"]["code"], "forbidden")

    def test_private_route_denies_missing_identity_and_maps_bad_schema(self):
        dependencies = PrivateDependencies(
            raw_reader=_RawReader(),
            identities=registry_for(),
            logger=SafeEventLogger(lambda _line: None),
            now=lambda: NOW,
        )
        handler = make_private_handler(dependencies)
        with _RunningServer(handler) as server:
            status, _, body = server.request("GET", "/api/public-summary")
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"]["code"], "forbidden")

        bad = raw_overview()
        del bad["wans"]["mobile"]

        class BadRawReader:
            def read_projection_inputs(self):
                return bad, raw_latency()

        dependencies = PrivateDependencies(
            raw_reader=BadRawReader(),
            identities=registry_for(),
            logger=SafeEventLogger(lambda _line: None),
            now=lambda: NOW,
        )
        handler = make_private_handler(dependencies)
        handler._identity = lambda _self: PUBLIC_BFF_IDENTITY
        with _RunningServer(handler) as server:
            status, _, body = server.request("GET", "/api/public-summary")
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body), {"error": {"code": "monitor_unavailable"}})


class _JsonHandler(BaseHTTPRequestHandler):
    status = 200
    content_type = "application/json"
    payload = b'{"ok":true}'

    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        self.send_response(self.status)
        self.send_header("Content-Type", self.content_type)
        self.send_header("Content-Length", str(len(self.payload)))
        self.end_headers()
        self.wfile.write(self.payload)


class FixedClientTests(unittest.TestCase):
    def test_fixed_client_reads_bounded_json_and_does_not_follow_redirects(self):
        with _RunningServer(_JsonHandler) as server:
            origin = Origin("http", "127.0.0.1", server.server.server_address[1])
            client = FixedJsonClient(origin, tls_context=None)
            self.assertEqual(client.get("/fixed"), {"ok": True})

            _JsonHandler.status = 302
            _JsonHandler.payload = b""
            with self.assertRaises(UpstreamSchemaInvalid):
                client.get("/fixed")
            _JsonHandler.status = 200
            _JsonHandler.payload = b'{"ok":true}'

    def test_https_private_client_requires_a_tls_context(self):
        with self.assertRaises(SecurityBoundaryError):
            FixedJsonClient(Origin("https", "127.0.0.1", 443), tls_context=None)


@unittest.skipUnless(shutil.which("openssl"), "openssl is required for local mTLS proof")
class MutualTlsTests(unittest.TestCase):
    def _run(self, *arguments: str) -> None:
        subprocess.run(
            ["openssl", *arguments],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def test_private_listener_requires_and_resolves_the_public_bff_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca_key, ca_cert = root / "ca.key", root / "ca.crt"
            server_key, server_csr, server_cert = (
                root / "server.key",
                root / "server.csr",
                root / "server.crt",
            )
            client_key, client_csr, client_cert = (
                root / "client.key",
                root / "client.csr",
                root / "client.crt",
            )
            server_extensions = root / "server.ext"
            client_extensions = root / "client.ext"
            server_extensions.write_text(
                "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
                encoding="ascii",
            )
            client_extensions.write_text("extendedKeyUsage=clientAuth\n", encoding="ascii")

            self._run(
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
                "-keyout", str(ca_key), "-out", str(ca_cert), "-days", "1",
                "-subj", "/CN=monitor-gateway-test-ca",
                "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign",
            )
            self._run(
                "req", "-newkey", "rsa:2048", "-nodes", "-sha256",
                "-keyout", str(server_key), "-out", str(server_csr),
                "-subj", "/CN=localhost",
            )
            self._run(
                "x509", "-req", "-in", str(server_csr), "-CA", str(ca_cert),
                "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(server_cert),
                "-days", "1", "-sha256", "-extfile", str(server_extensions),
            )
            self._run(
                "req", "-newkey", "rsa:2048", "-nodes", "-sha256",
                "-keyout", str(client_key), "-out", str(client_csr),
                "-subj", "/CN=public-bff",
            )
            self._run(
                "x509", "-req", "-in", str(client_csr), "-CA", str(ca_cert),
                "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(client_cert),
                "-days", "1", "-sha256", "-extfile", str(client_extensions),
            )

            dependencies = PrivateDependencies(
                raw_reader=_RawReader(),
                identities=IdentityRegistry.from_certificate_files(
                    {PUBLIC_BFF_IDENTITY: client_cert}
                ),
                logger=SafeEventLogger(lambda _line: None),
                now=lambda: NOW,
            )
            server = ThreadingHTTPServer(
                ("127.0.0.1", 0), make_private_handler(dependencies)
            )
            server_context = build_mtls_server_context(
                ca_file=ca_cert,
                certificate_file=server_cert,
                key_file=server_key,
            )
            self.assertEqual(server_context.verify_mode, ssl.CERT_REQUIRED)
            server.socket = server_context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client_context = build_mtls_client_context(
                    ca_file=ca_cert,
                    certificate_file=client_cert,
                    key_file=client_key,
                )
                connection = http.client.HTTPSConnection(
                    "localhost",
                    server.server_address[1],
                    timeout=3,
                    context=client_context,
                )
                connection.request("GET", "/api/public-summary")
                response = connection.getresponse()
                body = response.read()
                connection.close()
                self.assertEqual(response.status, 200)
                self.assertEqual(scan_public_value(json.loads(body)), [])

                no_identity = ssl.create_default_context(cafile=str(ca_cert))
                no_identity.minimum_version = ssl.TLSVersion.TLSv1_2
                rejected = http.client.HTTPSConnection(
                    "localhost",
                    server.server_address[1],
                    timeout=3,
                    context=no_identity,
                )
                try:
                    with self.assertRaises((ssl.SSLError, OSError)):
                        rejected.request("GET", "/api/public-summary")
                        rejected.getresponse().read()
                finally:
                    rejected.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()

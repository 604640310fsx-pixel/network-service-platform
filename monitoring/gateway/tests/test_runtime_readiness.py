#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import http.client
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from monitoring.gateway.client import (
    AUTH_SERVICE_IDENTITY,
    PUBLIC_BFF_IDENTITY,
    CertificateDiagnostic,
    IdentityRegistry,
    UpstreamSchemaInvalid,
    UpstreamTimeout,
    UpstreamUnavailable,
    certificate_diagnostic,
)
from monitoring.gateway.security import (
    MONITOR_CLIENT_IP_HEADER,
    SafeEventLogger,
    SecurityBoundaryError,
    TokenBucketLimiter,
    normalize_ip_literal,
    resolve_trusted_proxy_client_identity,
    validate_loopback_bind_host,
)
from monitoring.gateway.server import (
    CertificateRequirement,
    PrivateDependencies,
    PrivateRuntimeReadiness,
    PublicDependencies,
    PublicRuntimeReadiness,
    ReadinessFailure,
    _optional_identity_files,
    make_private_handler,
    make_public_handler,
)


def _summary(now: datetime, *, status: str = "healthy") -> dict[str, object]:
    timestamp = now.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )
    wans: list[dict[str, object]] = []
    for index, (wan_id, name) in enumerate(
        (("telecom", "电信"), ("mobile", "移动"), ("unicom", "联通"))
    ):
        if status == "no_data":
            wans.append(
                {
                    "wanId": wan_id,
                    "displayName": name,
                    "status": "no_data",
                    "packetLossSummary": None,
                    "updatedAt": None,
                    "stale": False,
                    "trend": [],
                }
            )
            continue
        wans.append(
            {
                "wanId": wan_id,
                "displayName": name,
                "status": status,
                "latestLatencyMs": 20.0 + index,
                "packetLossSummary": 0.0,
                "updatedAt": timestamp,
                "stale": status == "stale",
                "trend": [20.0 + index],
            }
        )
    if status == "stale":
        for wan in wans:
            wan.pop("latestLatencyMs")
            wan["packetLossSummary"] = None
            wan["trend"] = []
    return {"wans": wans}


def _raw_payloads(now: datetime) -> tuple[dict[str, object], dict[str, object]]:
    timestamp = now.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )
    overview_wans: dict[str, dict[str, object]] = {}
    samples: list[dict[str, object]] = []
    for index, wan_id in enumerate(("telecom", "mobile", "unicom")):
        latency = 20.0 + index
        overview_wans[wan_id] = {
            "status": "normal",
            "latest_timestamp": timestamp,
            "current_ms": latency,
            "alidns_loss_percent": 0.0,
        }
        samples.append(
            {
                "timestamp": timestamp,
                "wan": wan_id,
                "target_name": "AliDNS",
                "test_type": "icmp",
                "success": 1,
                "avg_ms": latency,
            }
        )
    return (
        {"wans": overview_wans},
        {"range": "6h", "type": "icmp", "target": "AliDNS", "samples": samples},
    )


class _SummaryReader:
    def __init__(self, payload: object, error: Exception | None = None) -> None:
        self.payload = payload
        self.error = error
        self.calls = 0

    def read_public_summary(self):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.payload


class _RawReader:
    def __init__(self, payloads: tuple[object, object]) -> None:
        self.payloads = payloads
        self.calls = 0

    def read_projection_inputs(self):
        self.calls += 1
        return self.payloads


class _TrackingLimiter:
    def __init__(self) -> None:
        self.keys: list[str] = []

    def consume(self, client_key: str) -> bool:
        self.keys.append(client_key)
        return True


class _FakeReadiness:
    def __init__(self, error: ReadinessFailure | None = None) -> None:
        self.error = error
        self.calls = 0

    def evaluate(self) -> None:
        self.calls += 1
        if self.error is not None:
            raise self.error


class _RunningServer:
    def __init__(self, handler) -> None:
        from http.server import ThreadingHTTPServer

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=2
        )
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        return response.status, response_headers, body

    def duplicate_header_request(self, *values: str) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=2
        )
        connection.putrequest("GET", "/api/summary")
        for value in values:
            connection.putheader(MONITOR_CLIENT_IP_HEADER, value)
        connection.endheaders()
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response.status, body


class ClientIdentityTests(unittest.TestCase):
    def test_ip_literals_are_canonical_and_proxy_syntax_is_rejected(self):
        self.assertEqual(normalize_ip_literal("192.0.2.10"), "192.0.2.10")
        self.assertEqual(normalize_ip_literal("2001:0db8::1"), "2001:db8::1")
        self.assertEqual(normalize_ip_literal("::ffff:192.0.2.10"), "192.0.2.10")
        for value in (
            "",
            " 192.0.2.10",
            "192.0.2.10 ",
            "192.0.2.10,192.0.2.11",
            "192.0.2.10:443",
            "[2001:db8::1]",
            "example.invalid",
            "192.0.2.10\r\n",
        ):
            with self.subTest(value=value), self.assertRaises(SecurityBoundaryError):
                normalize_ip_literal(value)

    def test_trusted_proxy_is_exactly_one_loopback_hop(self):
        self.assertEqual(
            resolve_trusted_proxy_client_identity("127.0.0.1", ("192.0.2.10",)),
            "192.0.2.10",
        )
        self.assertEqual(
            resolve_trusted_proxy_client_identity("::1", ("2001:0db8::1",)),
            "2001:db8::1",
        )
        self.assertEqual(
            resolve_trusted_proxy_client_identity(
                "192.0.2.20", ("198.51.100.10,198.51.100.11",)
            ),
            "192.0.2.20",
        )
        for values in ((), ("192.0.2.10", "192.0.2.11"), ("",)):
            with self.subTest(values=values), self.assertRaises(
                SecurityBoundaryError
            ):
                resolve_trusted_proxy_client_identity("127.0.0.1", values)

    def test_runtime_bind_accepts_only_exact_loopback_literals(self):
        self.assertEqual(validate_loopback_bind_host("127.0.0.1"), "127.0.0.1")
        self.assertEqual(validate_loopback_bind_host("::1"), "::1")
        for value in (
            "0.0.0.0",
            "::",
            "127.0.0.2",
            "10.0.0.2",
            "192.0.2.10",
            "localhost",
            "LOCALHOST",
        ):
            with self.subTest(value=value), self.assertRaises(SecurityBoundaryError):
                validate_loopback_bind_host(value)

    def test_public_handler_rejects_bad_proxy_identity_before_rate_limit(self):
        now = datetime.now(timezone.utc)
        reader = _SummaryReader(_summary(now))
        limiter = _TrackingLimiter()
        logs: list[str] = []
        handler = make_public_handler(
            PublicDependencies(
                summary_reader=reader,
                parent_origin="https://website.example",
                limiter=limiter,  # type: ignore[arg-type]
                logger=SafeEventLogger(logs.append),
                client_identity_resolver=resolve_trusted_proxy_client_identity,
            )
        )
        with _RunningServer(handler) as server:
            status, _, body = server.request("GET", "/api/summary")
            self.assertEqual(status, 400)
            self.assertEqual(json.loads(body)["error"]["code"], "bad_request")
            status, _, _ = server.request(
                "GET",
                "/api/summary",
                headers={"X-Forwarded-For": "192.0.2.10", "X-Real-IP": "192.0.2.10"},
            )
            self.assertEqual(status, 400)
            status, body = server.duplicate_header_request(
                "192.0.2.10", "192.0.2.11"
            )
            self.assertEqual(status, 400)
            self.assertEqual(json.loads(body)["error"]["code"], "bad_request")
        self.assertEqual(reader.calls, 0)
        self.assertEqual(limiter.keys, [])
        self.assertTrue(all("192.0.2." not in line for line in logs))

    def test_limiter_and_logger_share_normalized_per_client_identity(self):
        now = datetime.now(timezone.utc)
        logs: list[str] = []
        handler = make_public_handler(
            PublicDependencies(
                summary_reader=_SummaryReader(_summary(now)),
                parent_origin="https://website.example",
                limiter=TokenBucketLimiter(burst=1),
                logger=SafeEventLogger(logs.append),
                client_identity_resolver=resolve_trusted_proxy_client_identity,
            )
        )
        with _RunningServer(handler) as server:
            first = {MONITOR_CLIENT_IP_HEADER: "192.0.2.10"}
            second = {MONITOR_CLIENT_IP_HEADER: "192.0.2.11"}
            self.assertEqual(server.request("GET", "/api/summary", headers=first)[0], 200)
            self.assertEqual(server.request("GET", "/api/summary", headers=first)[0], 429)
            self.assertEqual(server.request("GET", "/api/summary", headers=second)[0], 200)
        self.assertEqual(len(logs), 3)
        self.assertTrue(all("192.0.2." not in line for line in logs))
        self.assertNotEqual(json.loads(logs[0])["client"], json.loads(logs[2])["client"])


class HealthEndpointTests(unittest.TestCase):
    def test_health_is_loopback_only_upstream_free_and_not_rate_limited(self):
        now = datetime.now(timezone.utc)
        reader = _SummaryReader(_summary(now))
        limiter = _TrackingLimiter()
        readiness = _FakeReadiness()
        handler = make_public_handler(
            PublicDependencies(
                summary_reader=reader,
                parent_origin="https://website.example",
                limiter=limiter,  # type: ignore[arg-type]
                logger=SafeEventLogger(lambda _line: None),
                readiness=readiness,
            )
        )
        with _RunningServer(handler) as server:
            status, headers, body = server.request("GET", "/healthz")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"status": "ok"})
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertNotIn("Set-Cookie", headers)
            status, _, body = server.request("HEAD", "/healthz")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"")
            status, _, body = server.request("GET", "/readyz")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"status": "ready"})
        self.assertEqual(reader.calls, 0)
        self.assertEqual(limiter.keys, [])
        self.assertEqual(readiness.calls, 1)

    def test_readiness_failure_is_safe_and_non_loopback_probe_is_hidden(self):
        now = datetime.now(timezone.utc)
        readiness = _FakeReadiness(ReadinessFailure("stale_data"))
        handler = make_public_handler(
            PublicDependencies(
                summary_reader=_SummaryReader(_summary(now)),
                parent_origin="https://website.example",
                limiter=TokenBucketLimiter(),
                logger=SafeEventLogger(lambda _line: None),
                readiness=readiness,
            )
        )
        with _RunningServer(handler) as server:
            status, _, body = server.request("GET", "/readyz")
            self.assertEqual(status, 503)
            self.assertEqual(
                json.loads(body),
                {"status": "not_ready", "code": "stale_data"},
            )

        hidden_handler = make_public_handler(
            PublicDependencies(
                summary_reader=_SummaryReader(_summary(now)),
                parent_origin="https://website.example",
                limiter=TokenBucketLimiter(),
                logger=SafeEventLogger(lambda _line: None),
            )
        )
        hidden_handler._is_loopback_peer = lambda _self: False
        with _RunningServer(hidden_handler) as server:
            status, _, body = server.request("GET", "/healthz")
            write_status, write_headers, write_body = server.request(
                "POST", "/readyz"
            )
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"]["code"], "not_found")
        self.assertEqual(write_status, 404)
        self.assertNotIn("Allow", write_headers)
        self.assertEqual(json.loads(write_body)["error"]["code"], "not_found")

    def test_private_health_and_readiness_share_the_loopback_only_contract(self):
        readiness = _FakeReadiness()
        handler = make_private_handler(
            PrivateDependencies(
                raw_reader=_RawReader(({}, {})),
                identities=IdentityRegistry({PUBLIC_BFF_IDENTITY: "0" * 64}),
                logger=SafeEventLogger(lambda _line: None),
                readiness=readiness,
            )
        )
        with _RunningServer(handler) as server:
            status, headers, body = server.request("GET", "/healthz")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"status": "ok"})
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            status, headers, body = server.request("POST", "/readyz")
            self.assertEqual(status, 405)
            self.assertEqual(headers.get("Allow"), "GET, HEAD")
            self.assertEqual(
                json.loads(body)["error"]["code"], "method_not_allowed"
            )
        self.assertEqual(readiness.calls, 0)


@unittest.skipUnless(shutil.which("openssl"), "openssl is required")
class CertificateAndReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls._temporary.name)
        cls.certificates: list[Path] = []
        for name in ("current", "next", "auth"):
            key = cls.root / f"{name}.key"
            certificate = cls.root / f"{name}.crt"
            subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-sha256",
                    "-keyout",
                    str(key),
                    "-out",
                    str(certificate),
                    "-days",
                    "2",
                    "-subj",
                    f"/CN=synthetic-monitor-{name}",
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            cls.certificates.append(certificate)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._temporary.cleanup()

    def _diagnostic(self, path: Path | None = None) -> CertificateDiagnostic:
        return certificate_diagnostic(
            path or self.certificates[0],
            role="public_bff_current",
        )

    def test_certificate_diagnostics_are_exact_and_safe(self):
        certificate = self.certificates[0]
        diagnostic = self._diagnostic(certificate)
        pem = certificate.read_text(encoding="ascii")
        expected = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
        self.assertEqual(diagnostic.fingerprint_sha256, expected)
        self.assertRegex(diagnostic.not_after or "", r"Z$")
        self.assertEqual(diagnostic.status, "valid")

        lines: list[str] = []
        SafeEventLogger(lines.append).write_certificate_status(
            role=diagnostic.role,
            fingerprint_sha256=diagnostic.fingerprint_sha256,
            not_after=diagnostic.not_after,
            remaining_seconds=diagnostic.remaining_seconds,
            status=diagnostic.status,
        )
        event = json.loads(lines[0])
        self.assertEqual(
            set(event),
            {
                "event",
                "fingerprintSha256",
                "notAfter",
                "remainingSeconds",
                "role",
                "status",
            },
        )
        self.assertNotIn(str(self.root), lines[0])
        self.assertNotIn("synthetic-monitor", lines[0])

        invalid = self.root / "invalid.crt"
        invalid.write_text("not a certificate", encoding="ascii")
        self.assertEqual(self._diagnostic(invalid).status, "invalid")

    def test_public_and_private_readiness_enforce_certificates_and_freshness(self):
        now = datetime.now(timezone.utc)
        requirements = (
            CertificateRequirement("public_bff_current", self.certificates[0]),
        )
        for status in ("healthy", "degraded", "unavailable"):
            with self.subTest(status=status):
                PublicRuntimeReadiness(
                    _SummaryReader(_summary(now, status=status)),
                    requirements,
                    now=lambda: now,
                ).evaluate()
        raw_reader = _RawReader(_raw_payloads(now))
        PrivateRuntimeReadiness(
            raw_reader, requirements, now=lambda: now
        ).evaluate()
        self.assertEqual(raw_reader.calls, 1)

        with self.assertRaises(ReadinessFailure) as caught:
            PublicRuntimeReadiness(
                _SummaryReader(_summary(now - timedelta(seconds=181))),
                requirements,
                now=lambda: now,
            ).evaluate()
        self.assertEqual(caught.exception.code, "stale_data")

        with self.assertRaises(ReadinessFailure) as caught:
            PublicRuntimeReadiness(
                _SummaryReader(_summary(now, status="no_data")),
                requirements,
                now=lambda: now,
            ).evaluate()
        self.assertEqual(caught.exception.code, "no_data")

    def test_readiness_maps_upstream_failures_and_certificate_margin(self):
        now = datetime.now(timezone.utc)
        requirements = (
            CertificateRequirement("public_bff_current", self.certificates[0]),
        )
        cases = (
            (UpstreamTimeout("timeout"), "upstream_timeout"),
            (UpstreamUnavailable("unavailable"), "upstream_unavailable"),
            (UpstreamSchemaInvalid("schema"), "upstream_schema_invalid"),
        )
        for error, code in cases:
            with self.subTest(code=code), self.assertRaises(ReadinessFailure) as caught:
                PublicRuntimeReadiness(
                    _SummaryReader(_summary(now), error=error),
                    requirements,
                    now=lambda: now,
                ).evaluate()
            self.assertEqual(caught.exception.code, code)

        diagnostic = self._diagnostic()
        assert diagnostic.not_after is not None
        expires_at = datetime.fromisoformat(diagnostic.not_after.replace("Z", "+00:00"))
        with self.assertRaises(ReadinessFailure) as caught:
            PublicRuntimeReadiness(
                _SummaryReader(_summary(expires_at - timedelta(hours=1))),
                requirements,
                now=lambda: expires_at - timedelta(hours=1),
            ).evaluate()
        self.assertEqual(caught.exception.code, "certificate_expiring")

        with self.assertRaises(ReadinessFailure) as caught:
            PublicRuntimeReadiness(
                _SummaryReader(_summary(expires_at + timedelta(seconds=1))),
                requirements,
                now=lambda: expires_at + timedelta(seconds=1),
            ).evaluate()
        self.assertEqual(caught.exception.code, "certificate_invalid")

    def test_identity_rotation_accepts_two_and_rejects_ambiguous_windows(self):
        der = [
            ssl.PEM_cert_to_DER_cert(path.read_text(encoding="ascii"))
            for path in self.certificates
        ]
        fingerprints = [hashlib.sha256(value).hexdigest() for value in der]
        registry = IdentityRegistry(
            {PUBLIC_BFF_IDENTITY: fingerprints[:2], AUTH_SERVICE_IDENTITY: fingerprints[2]}
        )
        self.assertEqual(registry.resolve_der_certificate(der[0]), PUBLIC_BFF_IDENTITY)
        self.assertEqual(registry.resolve_der_certificate(der[1]), PUBLIC_BFF_IDENTITY)
        self.assertEqual(registry.resolve_der_certificate(der[2]), AUTH_SERVICE_IDENTITY)

        rotated = IdentityRegistry({PUBLIC_BFF_IDENTITY: fingerprints[1]})
        self.assertIsNone(rotated.resolve_der_certificate(der[0]))
        self.assertEqual(rotated.resolve_der_certificate(der[1]), PUBLIC_BFF_IDENTITY)

        with self.assertRaises(SecurityBoundaryError):
            IdentityRegistry({PUBLIC_BFF_IDENTITY: fingerprints})
        with self.assertRaises(SecurityBoundaryError):
            IdentityRegistry({PUBLIC_BFF_IDENTITY: [fingerprints[0], fingerprints[0]]})
        with self.assertRaises(SecurityBoundaryError):
            IdentityRegistry(
                {
                    PUBLIC_BFF_IDENTITY: fingerprints[0],
                    AUTH_SERVICE_IDENTITY: fingerprints[0],
                }
            )

        from_files = IdentityRegistry.from_certificate_files(
            {PUBLIC_BFF_IDENTITY: self.certificates[:2]}
        )
        self.assertEqual(from_files.resolve_der_certificate(der[0]), PUBLIC_BFF_IDENTITY)
        self.assertEqual(from_files.resolve_der_certificate(der[1]), PUBLIC_BFF_IDENTITY)

        diagnostic = self._diagnostic()
        assert diagnostic.not_after is not None
        expires_at = datetime.fromisoformat(diagnostic.not_after.replace("Z", "+00:00"))
        with self.assertRaises(SecurityBoundaryError):
            IdentityRegistry.from_certificate_files(
                {PUBLIC_BFF_IDENTITY: self.certificates[0]},
                now=expires_at + timedelta(seconds=1),
            )

    def test_next_identity_without_current_fails_closed(self):
        environment = {
            "PUBLIC_BFF_IDENTITY_CERT_FILE": str(self.certificates[0]),
            "AUTH_SERVICE_IDENTITY_CERT_FILE_NEXT": str(self.certificates[2]),
        }
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaises(SecurityBoundaryError):
                _optional_identity_files()


if __name__ == "__main__":
    unittest.main()

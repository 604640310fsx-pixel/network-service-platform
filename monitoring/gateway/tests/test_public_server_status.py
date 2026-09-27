"""Public status of the operator's single server-side-configured server.

Private route: public-BFF identity only, target never taken from the request or
echoed. Public route: exact whitelist, rate limited, no fallback on failure.
"""

from __future__ import annotations

import json
import unittest

from monitoring.gateway.client import (
    AUTH_SERVICE_IDENTITY,
    OPERATOR_IDENTITY,
    PUBLIC_BFF_IDENTITY,
    FixedJsonClient,
    Origin,
    PrivateProjectionClient,
    UpstreamSchemaInvalid,
    UpstreamTimeout,
    UpstreamUnavailable,
)
from monitoring.gateway.security import SafeEventLogger, TokenBucketLimiter
from monitoring.gateway.server import (
    PrivateDependencies,
    make_private_handler,
    make_public_handler,
)
from monitoring.gateway.tests.test_auth_projection import (
    NOW,
    _RawReader,
    _RunningServer,
    raw_status,
    registry,
)
from monitoring.gateway.tests.test_gateway import public_dependencies


PRIVATE = "/api/public-server-status"
PUBLIC = "/api/server-status"
EXPECTED = {
    "label": "节点01",
    "status": "online",
    "updatedAt": "2030-01-01T00:01:00Z",
    "stale": False,
}


def private_handler(reader, *, target="Target A", identity=PUBLIC_BFF_IDENTITY, logs=None):
    lines = [] if logs is None else logs
    handler = make_private_handler(
        PrivateDependencies(
            raw_reader=reader,
            identities=registry(),
            logger=SafeEventLogger(lines.append),
            now=lambda: NOW,
            public_status_target=target,
        )
    )
    current = [identity]
    handler._identity = lambda _self: current[0]
    return handler, current


class PrivateServerStatusTests(unittest.TestCase):
    def test_exact_whitelist_for_configured_target(self):
        reader = _RawReader()
        logs = []
        handler, _ = private_handler(reader, logs=logs)
        with _RunningServer(handler) as server:
            status, headers, body = server.request("GET", PRIVATE)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        self.assertEqual(json.loads(body), EXPECTED)
        for leaked in (b"Target A", b"192.0.2.10", b"target", b"cpu", b"memory"):
            self.assertNotIn(leaked, body)
        self.assertEqual(reader.status_calls, ["Target A"])
        self.assertTrue(all("Target A" not in line for line in logs))

    def test_raw_provider_label_never_reaches_public_json(self):
        provider_label = "香港 ProviderCloud 节点"
        reader = _RawReader()
        reader.catalog["targets"][0]["display_name"] = provider_label
        private, _ = private_handler(reader)
        with _RunningServer(private) as private_server:
            status, _, private_body = private_server.request("GET", PRIVATE)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(private_body)["label"], "节点01")
            self.assertNotIn(provider_label.encode(), private_body)
            self.assertNotIn("ProviderCloud".encode(), private_body)

            client = PrivateProjectionClient(
                FixedJsonClient(
                    Origin.private(
                        f"http://127.0.0.1:{private_server.server.server_address[1]}",
                        require_https=False,
                    ),
                    tls_context=None,
                )
            )
            with _RunningServer(public_handler(client)) as public_server:
                status, _, public_body = public_server.request("GET", PUBLIC)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(public_body), EXPECTED)
        self.assertNotIn(provider_label.encode(), public_body)
        self.assertNotIn("ProviderCloud".encode(), public_body)

    def test_only_public_bff_identity_is_allowed(self):
        handler, current = private_handler(_RawReader())
        with _RunningServer(handler) as server:
            for identity in (AUTH_SERVICE_IDENTITY, OPERATOR_IDENTITY, None):
                current[0] = identity
                self.assertEqual(server.request("GET", PRIVATE)[0], 403)
            current[0] = PUBLIC_BFF_IDENTITY
            for path in (
                "/api/auth-service/targets",
                "/api/auth-service/status?target=Target%20A",
            ):
                self.assertEqual(server.request("GET", path)[0], 403)

    def test_request_cannot_choose_target_and_unconfigured_is_not_found(self):
        handler, _ = private_handler(_RawReader())
        with _RunningServer(handler) as server:
            self.assertEqual(server.request("GET", PRIVATE + "?target=Paused%20B")[0], 404)
        handler, _ = private_handler(_RawReader(), target=None)
        with _RunningServer(handler) as server:
            self.assertEqual(server.request("GET", PRIVATE)[0], 404)

    def test_stale_is_explicit(self):
        reader = _RawReader()
        reader.status = raw_status(source_status="stale", fresh=False)
        handler, _ = private_handler(reader)
        with _RunningServer(handler) as server:
            status, _, body = server.request("GET", PRIVATE)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "stale")
        self.assertIs(json.loads(body)["stale"], True)

    def test_inactive_missing_or_failed_source_collapses_to_unavailable(self):
        cases = []
        paused = _RawReader()
        cases.append((paused, "Paused B", 503))
        cases.append((_RawReader(), "Missing Z", 503))
        down = _RawReader()
        down.status_error = UpstreamUnavailable("down")
        cases.append((down, "Target A", 503))
        slow = _RawReader()
        slow.catalog_error = UpstreamTimeout("slow")
        cases.append((slow, "Target A", 504))
        drift = _RawReader()
        drift.status = {"unexpected": True}
        cases.append((drift, "Target A", 503))
        for reader, target, expected in cases:
            handler, _ = private_handler(reader, target=target)
            with _RunningServer(handler) as server:
                status, _, body = server.request("GET", PRIVATE)
            self.assertEqual(status, expected, target)
            self.assertEqual(json.loads(body), {"error": {"code": "monitor_unavailable"}})
            self.assertNotIn(target.encode(), body)


class _FixedClient:
    def __init__(self, payload=None, error=None):
        self.payload = payload
        self.error = error
        self.paths = []

    def get(self, path, **_kwargs):
        self.paths.append(path)
        if self.error is not None:
            raise self.error
        return self.payload


class ClientValidationTests(unittest.TestCase):
    def test_reader_accepts_only_the_exact_projection(self):
        fixed = _FixedClient(dict(EXPECTED))
        self.assertEqual(
            PrivateProjectionClient(fixed).read_public_server_status(), EXPECTED
        )
        self.assertEqual(fixed.paths, [PRIVATE])
        for bad in (
            {**EXPECTED, "target": "Target A"},
            {k: v for k, v in EXPECTED.items() if k != "label"},
            {**EXPECTED, "label": ""},
            {**EXPECTED, "label": "x\ny"},
            {**EXPECTED, "status": "stale"},
            {**EXPECTED, "updatedAt": "yesterday"},
            [],
        ):
            with self.assertRaises(UpstreamSchemaInvalid):
                PrivateProjectionClient(_FixedClient(bad)).read_public_server_status()


class _StatusReader:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error

    def read_public_server_status(self):
        if self.error is not None:
            raise self.error
        return dict(self.result)


def public_handler(status_reader, *, limiter=None):
    base = public_dependencies(limiter=limiter)
    dependencies = type(base)(
        summary_reader=base.summary_reader,
        parent_origin=base.parent_origin,
        limiter=base.limiter,
        logger=base.logger,
        static_root=base.static_root,
        server_status_reader=status_reader,
    )
    return make_public_handler(dependencies)


class PublicServerStatusTests(unittest.TestCase):
    def test_public_route_returns_whitelist_no_store(self):
        with _RunningServer(public_handler(_StatusReader(EXPECTED))) as server:
            status, headers, body = server.request("GET", PUBLIC)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        self.assertEqual(json.loads(body), EXPECTED)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertNotIn("Set-Cookie", headers)

    def test_query_method_and_unconfigured_gates(self):
        with _RunningServer(public_handler(_StatusReader(EXPECTED))) as server:
            self.assertEqual(server.request("GET", PUBLIC + "?target=x")[0], 404)
            self.assertEqual(server.request("POST", PUBLIC, body=b"")[0], 405)
            self.assertEqual(server.request("HEAD", PUBLIC)[0], 405)
        with _RunningServer(public_handler(None)) as server:
            self.assertEqual(server.request("GET", PUBLIC)[0], 404)

    def test_failures_never_fall_back(self):
        for error, expected in (
            (UpstreamUnavailable("down"), 503),
            (UpstreamTimeout("slow"), 504),
            (UpstreamSchemaInvalid("drift"), 502),
            (RuntimeError("unexpected"), 503),
        ):
            with _RunningServer(public_handler(_StatusReader(error=error))) as server:
                status, _, body = server.request("GET", PUBLIC)
            self.assertEqual(status, expected)
            self.assertEqual(json.loads(body), {"error": {"code": "monitor_unavailable"}})

    def test_leak_scan_blocks_address_like_labels(self):
        leaky = {**EXPECTED, "label": "server 192.0.2.10"}
        with _RunningServer(public_handler(_StatusReader(leaky))) as server:
            status, _, body = server.request("GET", PUBLIC)
        self.assertEqual(status, 502)
        self.assertNotIn(b"192.0.2.10", body)

    def test_rate_limited(self):
        limiter = TokenBucketLimiter(requests_per_minute=1, burst=1)
        with _RunningServer(public_handler(_StatusReader(EXPECTED), limiter=limiter)) as server:
            self.assertEqual(server.request("GET", PUBLIC)[0], 200)
            self.assertEqual(server.request("GET", PUBLIC)[0], 429)


if __name__ == "__main__":
    unittest.main()

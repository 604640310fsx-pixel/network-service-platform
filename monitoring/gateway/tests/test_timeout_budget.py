#!/usr/bin/env python3

from __future__ import annotations

import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from monitoring.gateway.client import (
    CONNECT_TIMEOUT_SECONDS,
    FUTURE_NGINX_CONNECT_TIMEOUT_SECONDS,
    FUTURE_NGINX_READ_TIMEOUT_SECONDS,
    MAX_TOTAL_TIMEOUT_SECONDS,
    PRIVATE_PROJECTION_MAX_SECONDS,
    PUBLIC_BFF_IDENTITY,
    PUBLIC_REQUEST_MAX_SECONDS,
    PUBLIC_TO_PRIVATE_TIMEOUT_SECONDS,
    RAW_LATENCY_TIMEOUT_SECONDS,
    RAW_OVERVIEW_TIMEOUT_SECONDS,
    READINESS_MAX_SECONDS,
    FixedJsonClient,
    IdentityRegistry,
    MonotonicDeadline,
    Origin,
    PrivateProjectionClient,
    RawMonitorClient,
    UpstreamTimeout,
    _DeadlineRawReader,
)
from monitoring.gateway.security import (
    SafeEventLogger,
    SecurityBoundaryError,
    TokenBucketLimiter,
)
from monitoring.gateway.server import (
    PrivateDependencies,
    PublicDependencies,
    PublicRuntimeReadiness,
    ReadinessFailure,
    make_private_handler,
    make_public_handler,
)


class _FakeClock:
    def __init__(self, value: float = 100.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def _public_summary() -> dict[str, object]:
    names = {"telecom": "电信", "mobile": "移动", "unicom": "联通"}
    return {
        "wans": [
            {
                "wanId": wan_id,
                "displayName": names[wan_id],
                "status": "no_data",
                "packetLossSummary": None,
                "updatedAt": None,
                "stale": False,
                "trend": [],
            }
            for wan_id in ("telecom", "mobile", "unicom")
        ]
    }


class _FakeSocket:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeResponse:
    status = 200

    def __init__(
        self,
        payload: bytes = b'{"ok":true}',
        *,
        clock: _FakeClock | None = None,
        seconds_per_read: float = 0.0,
    ) -> None:
        self.payload = payload
        self.clock = clock
        self.seconds_per_read = seconds_per_read
        self.calls = 0

    def getheader(self, name: str, default: str | None = None) -> str | None:
        if name.casefold() == "content-type":
            return "application/json"
        if name.casefold() == "content-length":
            return str(len(self.payload))
        return default

    def read(self, _size: int) -> bytes:
        if self.clock is not None:
            self.clock.advance(self.seconds_per_read)
        self.calls += 1
        if self.calls == 1:
            return self.payload
        return b""

    def close(self) -> None:
        return


class _FakeConnection:
    instances: list["_FakeConnection"] = []
    response_factory = staticmethod(_FakeResponse)
    connect_hook = staticmethod(lambda: None)

    def __init__(self, _host: str, _port: int, *, timeout: float) -> None:
        self.timeout = timeout
        self.original_socket = _FakeSocket()
        self.sock: object | None = self.original_socket
        self.response = self.response_factory()
        self.closed = False
        self.__class__.instances.append(self)

    def connect(self) -> None:
        self.connect_hook()

    def request(self, *_args: object, **_kwargs: object) -> None:
        return

    def getresponse(self) -> _FakeResponse:
        return self.response

    def close(self) -> None:
        self.closed = True
        if self.sock is not None:
            self.sock.close()  # type: ignore[union-attr]


class _ReceivingSocket:
    def __init__(self, clock: _FakeClock) -> None:
        self.clock = clock
        self.timeouts: list[float] = []

    def settimeout(self, timeout: float) -> None:
        self.timeouts.append(timeout)

    def recv_into(self, buffer: bytearray) -> int:
        self.clock.advance(3.0)
        buffer[:1] = b"x"
        return 1

    def fileno(self) -> int:
        return 1


class _RecordingClient:
    def __init__(
        self,
        responses: list[object],
        *,
        error_at: int | None = None,
    ) -> None:
        self.clock = _FakeClock()
        self.responses = responses
        self.error_at = error_at
        self.calls: list[tuple[str, float, MonotonicDeadline | None]] = []

    def deadline(self, total_timeout_seconds: float) -> MonotonicDeadline:
        return MonotonicDeadline.start(total_timeout_seconds, clock=self.clock)

    def get(
        self,
        path: str,
        *,
        total_timeout_seconds: float,
        _parent_deadline: MonotonicDeadline | None = None,
    ) -> object:
        self.calls.append((path, total_timeout_seconds, _parent_deadline))
        if self.error_at == len(self.calls):
            raise UpstreamTimeout("upstream timeout")
        return self.responses[len(self.calls) - 1]


class DeadlinePrimitiveTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeConnection.instances = []
        _FakeConnection.response_factory = staticmethod(_FakeResponse)
        _FakeConnection.connect_hook = staticmethod(lambda: None)

    def test_frozen_budget_values_are_exact(self) -> None:
        self.assertEqual(CONNECT_TIMEOUT_SECONDS, 3.0)
        self.assertEqual(RAW_OVERVIEW_TIMEOUT_SECONDS, 25.0)
        self.assertEqual(RAW_LATENCY_TIMEOUT_SECONDS, 8.0)
        self.assertEqual(PRIVATE_PROJECTION_MAX_SECONDS, 36.0)
        self.assertEqual(PUBLIC_TO_PRIVATE_TIMEOUT_SECONDS, 40.0)
        self.assertEqual(PUBLIC_REQUEST_MAX_SECONDS, 42.0)
        self.assertEqual(READINESS_MAX_SECONDS, 45.0)
        self.assertEqual(MAX_TOTAL_TIMEOUT_SECONDS, 45.0)
        self.assertEqual(FUTURE_NGINX_CONNECT_TIMEOUT_SECONDS, 3.0)
        self.assertEqual(FUTURE_NGINX_READ_TIMEOUT_SECONDS, 50.0)

    def test_fixed_client_requires_explicit_bounded_total_timeout(self) -> None:
        clock = _FakeClock()
        client = FixedJsonClient(
            Origin("http", "127.0.0.1", 3002),
            tls_context=None,
            _clock=clock,
        )
        for accepted in (8.0, 25.0, 40.0, 45.0):
            with self.subTest(accepted=accepted):
                self.assertEqual(client.deadline(accepted).remaining_seconds(), accepted)
        for rejected in (True, 0, -1, 45.1, float("inf"), float("nan")):
            with self.subTest(rejected=rejected), self.assertRaises(
                SecurityBoundaryError
            ):
                client.deadline(rejected)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            client.get("/fixed")  # type: ignore[call-arg]

    def test_child_deadline_never_extends_its_parent(self) -> None:
        clock = _FakeClock()
        parent = MonotonicDeadline.start(8.0, clock=clock)
        clock.advance(3.0)
        self.assertEqual(parent.child(25.0).remaining_seconds(), 5.0)
        clock.advance(5.0)
        with self.assertRaises(UpstreamTimeout):
            parent.child(8.0)

    def test_connect_timeout_is_capped_and_connection_is_closed(self) -> None:
        clock = _FakeClock()
        client = FixedJsonClient(
            Origin("http", "127.0.0.1", 3002),
            tls_context=None,
            _clock=clock,
        )
        with patch(
            "monitoring.gateway.client.http.client.HTTPConnection",
            _FakeConnection,
        ):
            self.assertEqual(
                client.get("/fixed", total_timeout_seconds=8.0),
                {"ok": True},
            )
        connection = _FakeConnection.instances[-1]
        self.assertEqual(connection.timeout, 3.0)
        self.assertTrue(connection.closed)
        self.assertTrue(connection.original_socket.closed)

    def test_connect_phase_cannot_outlive_its_three_second_budget(self) -> None:
        clock = _FakeClock()
        _FakeConnection.connect_hook = staticmethod(lambda: clock.advance(3.1))
        client = FixedJsonClient(
            Origin("http", "127.0.0.1", 3002),
            tls_context=None,
            _clock=clock,
        )
        with patch(
            "monitoring.gateway.client.http.client.HTTPConnection",
            _FakeConnection,
        ), self.assertRaises(UpstreamTimeout):
            client.get("/fixed", total_timeout_seconds=8.0)
        connection = _FakeConnection.instances[-1]
        self.assertTrue(connection.closed)
        self.assertTrue(connection.original_socket.closed)

    def test_expiry_after_a_body_read_fails_closed_and_closes(self) -> None:
        clock = _FakeClock()
        _FakeConnection.response_factory = staticmethod(
            lambda: _FakeResponse(clock=clock, seconds_per_read=8.1)
        )
        client = FixedJsonClient(
            Origin("http", "127.0.0.1", 3002),
            tls_context=None,
            _clock=clock,
        )
        with patch(
            "monitoring.gateway.client.http.client.HTTPConnection",
            _FakeConnection,
        ), self.assertRaises(UpstreamTimeout):
            client.get("/fixed", total_timeout_seconds=8.0)
        connection = _FakeConnection.instances[-1]
        self.assertTrue(connection.closed)
        self.assertTrue(connection.original_socket.closed)

    def test_each_body_receive_uses_only_the_absolute_remainder(self) -> None:
        clock = _FakeClock()
        deadline = MonotonicDeadline.start(8.0, clock=clock)
        raw_socket = _ReceivingSocket(clock)
        reader = _DeadlineRawReader(raw_socket, deadline)  # type: ignore[arg-type]
        buffer = bytearray(1)
        self.assertEqual(reader.readinto(buffer), 1)
        self.assertEqual(reader.readinto(buffer), 1)
        self.assertEqual(reader.readinto(buffer), 1)
        self.assertEqual(raw_socket.timeouts, [8.0, 5.0, 2.0])
        with self.assertRaises(UpstreamTimeout):
            deadline.ensure_remaining()


class RuntimeClientBudgetTests(unittest.TestCase):
    def test_raw_reads_are_sequential_and_use_the_frozen_sub_budgets(self) -> None:
        recording = _RecordingClient([{"overview": True}, {"latency": True}])
        client = RawMonitorClient(recording)  # type: ignore[arg-type]
        self.assertEqual(
            client.read_projection_inputs(),
            ({"overview": True}, {"latency": True}),
        )
        self.assertEqual(
            [(path, timeout) for path, timeout, _deadline in recording.calls],
            [
                (RawMonitorClient.OVERVIEW_PATH, 25.0),
                (RawMonitorClient.LATENCY_PATH, 8.0),
            ],
        )
        self.assertIs(recording.calls[0][2], recording.calls[1][2])

    def test_overview_timeout_prevents_the_latency_request(self) -> None:
        recording = _RecordingClient([{}], error_at=1)
        client = RawMonitorClient(recording)  # type: ignore[arg-type]
        with self.assertRaises(UpstreamTimeout):
            client.read_projection_inputs()
        self.assertEqual(len(recording.calls), 1)
        self.assertEqual(recording.calls[0][0], RawMonitorClient.OVERVIEW_PATH)

    def test_public_projection_read_uses_the_frozen_40_second_budget(self) -> None:
        recording = _RecordingClient([_public_summary()])
        client = PrivateProjectionClient(recording)  # type: ignore[arg-type]
        self.assertEqual(client.read_public_summary(), _public_summary())
        self.assertEqual(recording.calls[0][0], PrivateProjectionClient.SUMMARY_PATH)
        self.assertEqual(recording.calls[0][1], 40.0)


class _AdvancingSummaryReader:
    def __init__(self, clock: _FakeClock, seconds: float) -> None:
        self.clock = clock
        self.seconds = seconds

    def read_public_summary(self) -> dict[str, object]:
        self.clock.advance(self.seconds)
        return _public_summary()


class _AdvancingRawReader:
    def __init__(self, clock: _FakeClock, seconds: float) -> None:
        self.clock = clock
        self.seconds = seconds

    def read_projection_inputs(self) -> tuple[object, object]:
        self.clock.advance(self.seconds)
        return {}, {}


class _RunningServer:
    def __init__(self, handler: object) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)  # type: ignore[arg-type]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "_RunningServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get(self, path: str) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            self.server.server_address[1],
            timeout=2,
        )
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()


class RuntimeEndToEndBudgetTests(unittest.TestCase):
    def test_dynamic_public_request_fails_closed_after_42_seconds(self) -> None:
        clock = _FakeClock()
        handler = make_public_handler(
            PublicDependencies(
                summary_reader=_AdvancingSummaryReader(clock, 42.1),
                parent_origin="https://website.example",
                limiter=TokenBucketLimiter(),
                logger=SafeEventLogger(lambda _line: None),
                monotonic_clock=clock,
            )
        )
        with _RunningServer(handler) as server:
            status, body = server.get("/api/summary")
        self.assertEqual(status, 504)
        self.assertEqual(json.loads(body), {"error": {"code": "monitor_unavailable"}})

    def test_public_serialization_is_inside_the_42_second_budget(self) -> None:
        clock = _FakeClock()
        handler = make_public_handler(
            PublicDependencies(
                summary_reader=_AdvancingSummaryReader(clock, 0.0),
                parent_origin="https://website.example",
                limiter=TokenBucketLimiter(),
                logger=SafeEventLogger(lambda _line: None),
                monotonic_clock=clock,
            )
        )
        from monitoring.gateway import server as server_module

        original_json_bytes = server_module._json_bytes

        def delayed_json_bytes(payload: object) -> bytes:
            if isinstance(payload, dict) and "wans" in payload:
                clock.advance(42.1)
            return original_json_bytes(payload)

        with patch(
            "monitoring.gateway.server._json_bytes",
            side_effect=delayed_json_bytes,
        ), _RunningServer(handler) as server:
            status, body = server.get("/api/summary")
        self.assertEqual(status, 504)
        self.assertEqual(json.loads(body), {"error": {"code": "monitor_unavailable"}})

    def test_private_projection_fails_closed_after_36_seconds(self) -> None:
        clock = _FakeClock()
        handler = make_private_handler(
            PrivateDependencies(
                raw_reader=_AdvancingRawReader(clock, 36.1),
                identities=IdentityRegistry({PUBLIC_BFF_IDENTITY: "0" * 64}),
                logger=SafeEventLogger(lambda _line: None),
                monotonic_clock=clock,
            )
        )
        handler._identity = lambda _self: PUBLIC_BFF_IDENTITY
        with _RunningServer(handler) as server:
            status, body = server.get("/api/public-summary")
        self.assertEqual(status, 504)
        self.assertEqual(json.loads(body), {"error": {"code": "monitor_unavailable"}})

    def test_readiness_budget_starts_before_certificate_checks(self) -> None:
        clock = _FakeClock()
        readiness = PublicRuntimeReadiness(
            summary_reader=_AdvancingSummaryReader(clock, 0.0),
            certificate_requirements=(),
            monotonic_clock=clock,
        )

        def delayed_certificate_check(*_args: object, **_kwargs: object) -> None:
            clock.advance(45.1)

        with patch(
            "monitoring.gateway.server._check_certificate_readiness",
            side_effect=delayed_certificate_check,
        ), self.assertRaises(ReadinessFailure) as raised:
            readiness.evaluate()
        self.assertEqual(raised.exception.code, "upstream_timeout")


if __name__ == "__main__":
    unittest.main()

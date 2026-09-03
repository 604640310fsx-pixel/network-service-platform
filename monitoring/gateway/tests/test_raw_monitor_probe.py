#!/usr/bin/env python3

from __future__ import annotations

import json
import socket
import threading
import time
import unittest
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator
from unittest.mock import patch

from monitoring.gateway.client import MAX_JSON_BYTES
from monitoring.gateway.deploy import raw_monitor_probe
from monitoring.gateway.deploy.raw_monitor_probe import (
    FAILURE_STAGES,
    LATENCY_PATH,
    MAX_CANDIDATES,
    OVERVIEW_PATH,
    ProbeCandidate,
    REASON_CODES,
    RECORD_FIELDS,
    RESULTS,
    SCHEMA_VERSION,
    SUMMARY_FIELDS,
    probe_candidates,
    render_diagnostic,
)


VALID_OVERVIEW = {
    "wans": {
        wan: {
            "status": "normal",
            "latest_timestamp": None,
            "current_ms": None,
            "alidns_loss_percent": None,
        }
        for wan in ("telecom", "mobile", "unicom")
    }
}
VALID_LATENCY = {
    "range": "6h",
    "type": "icmp",
    "target": "AliDNS",
    "samples": [],
}

_AUTO_LENGTH = object()


@dataclass(frozen=True)
class _Reply:
    status: int = 200
    body: bytes = b"{}"
    content_type: str | None = "application/json"
    content_length: object = _AUTO_LENGTH
    delay_before_headers: float = 0.0
    delay_before_body: float = 0.0
    leak_header: str | None = None
    location: str | None = None


class _Scenario:
    def __init__(self, script: list[tuple[str, _Reply]]) -> None:
        self.script = list(script)
        self.requests: list[tuple[str, str]] = []
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()

    def begin(self, method: str, path: str) -> _Reply:
        with self.lock:
            self.requests.append((method, path))
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            if not self.script:
                return _Reply(status=500)
            expected_path, reply = self.script.pop(0)
            if path != expected_path:
                return _Reply(status=500)
            return reply

    def finish(self) -> None:
        with self.lock:
            self.active -= 1


class _SyntheticHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler hook
        scenario: _Scenario = self.server.scenario  # type: ignore[attr-defined]
        reply = scenario.begin("GET", self.path)
        try:
            if reply.delay_before_headers:
                time.sleep(reply.delay_before_headers)
            self.send_response(reply.status)
            if reply.content_type is not None:
                self.send_header("Content-Type", reply.content_type)
            if reply.content_length is _AUTO_LENGTH:
                self.send_header("Content-Length", str(len(reply.body)))
            elif reply.content_length is not None:
                self.send_header("Content-Length", str(reply.content_length))
            if reply.leak_header is not None:
                self.send_header("X-Synthetic-Secret", reply.leak_header)
            if reply.location is not None:
                self.send_header("Location", reply.location)
            self.send_header("Connection", "close")
            self.end_headers()
            if reply.delay_before_body:
                time.sleep(reply.delay_before_body)
            if reply.body:
                try:
                    self.wfile.write(reply.body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        finally:
            scenario.finish()

    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextmanager
def _running_server(
    script: list[tuple[str, _Reply]],
) -> Iterator[tuple[ProbeCandidate, _Scenario]]:
    scenario = _Scenario(script)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SyntheticHandler)
    server.scenario = scenario  # type: ignore[attr-defined]
    thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.01},
        daemon=True,
    )
    thread.start()
    try:
        yield ProbeCandidate("http", "127.0.0.1", server.server_address[1]), scenario
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


@contextmanager
def _malformed_protocol_server() -> Iterator[ProbeCandidate]:
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(1)

    def serve_once() -> None:
        try:
            connection, _address = listener.accept()
            with connection:
                connection.recv(4096)
                connection.sendall(b"not-an-http-response\r\n\r\n")
        except OSError:
            pass

    thread = threading.Thread(target=serve_once, daemon=True)
    thread.start()
    try:
        yield ProbeCandidate("http", "127.0.0.1", listener.getsockname()[1])
    finally:
        listener.close()
        thread.join(timeout=1)


def _json_reply(payload: object) -> _Reply:
    return _Reply(body=json.dumps(payload).encode())


def _valid_script() -> list[tuple[str, _Reply]]:
    return [
        (OVERVIEW_PATH, _json_reply(VALID_OVERVIEW)),
        (LATENCY_PATH, _json_reply(VALID_LATENCY)),
    ]


class RawMonitorProbeContractTests(unittest.TestCase):
    def test_full_match_has_exact_closed_schema_and_fixed_get_paths(self) -> None:
        with _running_server(_valid_script()) as (candidate, scenario):
            summary = probe_candidates([candidate])

        self.assertEqual(set(summary), SUMMARY_FIELDS)
        self.assertEqual(summary["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(summary["candidateCount"], 1)
        self.assertEqual(summary["overviewHttp200MatchCount"], 1)
        self.assertEqual(summary["fullContractMatchCount"], 1)
        self.assertEqual(
            summary["records"],
            [
                {
                    "attemptIndex": 1,
                    "result": "MATCH",
                    "failureStage": "NONE",
                    "reasonCode": "MATCH",
                    "httpStatus": 200,
                }
            ],
        )
        self.assertEqual(set(summary["records"][0]), RECORD_FIELDS)
        self.assertEqual(RESULTS, {"MATCH", "NO_MATCH"})
        self.assertEqual(
            FAILURE_STAGES, {"CONNECT", "OVERVIEW", "LATENCY", "CONTRACT", "NONE"}
        )
        self.assertEqual(
            REASON_CODES,
            {
                "MATCH",
                "CONNECTION_OR_PROTOCOL_FAILURE",
                "REQUEST_TIMEOUT",
                "HTTP_NON_200",
                "RESPONSE_INVALID_OR_OVERSIZED",
                "CONTRACT_MISMATCH",
                "OTHER_REQUEST_EXCEPTION",
            },
        )
        self.assertEqual(
            scenario.requests,
            [("GET", OVERVIEW_PATH), ("GET", LATENCY_PATH)],
        )

    def test_renderer_rejects_nonclosed_schema_values_and_fields(self) -> None:
        valid = {
            "schemaVersion": SCHEMA_VERSION,
            "candidateCount": 1,
            "overviewHttp200MatchCount": 1,
            "fullContractMatchCount": 1,
            "records": [
                {
                    "attemptIndex": 1,
                    "result": "MATCH",
                    "failureStage": "NONE",
                    "reasonCode": "MATCH",
                    "httpStatus": 200,
                }
            ],
        }
        mutations = []
        for key, value in (
            ("result", "UNKNOWN"),
            ("failureStage", "UNKNOWN"),
            ("reasonCode", "UNKNOWN"),
            ("httpStatus", 600),
        ):
            mutated = json.loads(json.dumps(valid))
            mutated["records"][0][key] = value
            mutations.append(mutated)
        extra_summary = json.loads(json.dumps(valid))
        extra_summary["origin"] = "forbidden-origin"
        mutations.append(extra_summary)
        extra_record = json.loads(json.dumps(valid))
        extra_record["records"][0]["body"] = "forbidden-body"
        mutations.append(extra_record)

        for mutated in mutations:
            with self.subTest(mutated=mutated):
                with self.assertRaisesRegex(RuntimeError, "invalid diagnostic"):
                    render_diagnostic(mutated)

    def test_connection_failure_and_timeout_are_reason_coded(self) -> None:
        refused_candidate = ProbeCandidate("http", "127.0.0.1", 1)
        with patch.object(
            raw_monitor_probe,
            "_new_connection",
            side_effect=ConnectionRefusedError,
        ):
            refused = probe_candidates(
                [refused_candidate], overview_timeout_seconds=0.1
            )
        self.assertEqual(
            refused["records"][0],
            {
                "attemptIndex": 1,
                "result": "NO_MATCH",
                "failureStage": "CONNECT",
                "reasonCode": "CONNECTION_OR_PROTOCOL_FAILURE",
                "httpStatus": None,
            },
        )

        with _malformed_protocol_server() as malformed_candidate:
            malformed = probe_candidates([malformed_candidate])
        self.assertEqual(malformed["records"][0]["failureStage"], "OVERVIEW")
        self.assertEqual(
            malformed["records"][0]["reasonCode"],
            "CONNECTION_OR_PROTOCOL_FAILURE",
        )
        self.assertIsNone(malformed["records"][0]["httpStatus"])

        timeout_reply = _Reply(
            body=json.dumps(VALID_OVERVIEW).encode(), delay_before_headers=0.2
        )
        with _running_server([(OVERVIEW_PATH, timeout_reply)]) as (candidate, scenario):
            timed_out = probe_candidates(
                [candidate], overview_timeout_seconds=0.03
            )
        self.assertEqual(scenario.requests, [("GET", OVERVIEW_PATH)])
        self.assertEqual(timed_out["records"][0]["failureStage"], "OVERVIEW")
        self.assertEqual(timed_out["records"][0]["reasonCode"], "REQUEST_TIMEOUT")
        self.assertIsNone(timed_out["records"][0]["httpStatus"])

        body_timeout_reply = _Reply(
            body=json.dumps(VALID_OVERVIEW).encode(), delay_before_body=0.2
        )
        with _running_server([(OVERVIEW_PATH, body_timeout_reply)]) as (
            candidate,
            scenario,
        ):
            body_timed_out = probe_candidates(
                [candidate], overview_timeout_seconds=0.03
            )
        self.assertEqual(scenario.requests, [("GET", OVERVIEW_PATH)])
        self.assertEqual(body_timed_out["overviewHttp200MatchCount"], 1)
        self.assertEqual(
            body_timed_out["records"][0]["reasonCode"], "REQUEST_TIMEOUT"
        )
        self.assertEqual(body_timed_out["records"][0]["httpStatus"], 200)

    def test_overview_non_200_stops_latency_and_redirects_are_not_followed(
        self,
    ) -> None:
        for status in (302, 404, 503):
            with self.subTest(status=status):
                reply = _Reply(
                    status=status,
                    body=b"forbidden-error-body-marker",
                    leak_header="forbidden-header-marker",
                    location="/must-not-follow" if status == 302 else None,
                )
                with _running_server([(OVERVIEW_PATH, reply)]) as (
                    candidate,
                    scenario,
                ):
                    summary = probe_candidates([candidate])
                self.assertEqual(scenario.requests, [("GET", OVERVIEW_PATH)])
                self.assertEqual(summary["records"][0]["failureStage"], "OVERVIEW")
                self.assertEqual(summary["records"][0]["reasonCode"], "HTTP_NON_200")
                self.assertEqual(summary["records"][0]["httpStatus"], status)
                rendered = render_diagnostic(summary)
                self.assertNotIn("forbidden-error-body-marker", rendered)
                self.assertNotIn("forbidden-header-marker", rendered)

    def test_latency_3xx_4xx_and_5xx_are_classified_without_redirects(self) -> None:
        for status in (307, 429, 500):
            with self.subTest(status=status):
                script = [
                    (OVERVIEW_PATH, _json_reply(VALID_OVERVIEW)),
                    (
                        LATENCY_PATH,
                        _Reply(
                            status=status,
                            body=b"do-not-read",
                            location="/must-not-follow" if status == 307 else None,
                        ),
                    ),
                ]
                with _running_server(script) as (candidate, scenario):
                    summary = probe_candidates([candidate])
                self.assertEqual(
                    scenario.requests,
                    [("GET", OVERVIEW_PATH), ("GET", LATENCY_PATH)],
                )
                self.assertEqual(summary["overviewHttp200MatchCount"], 1)
                self.assertEqual(summary["records"][0]["failureStage"], "LATENCY")
                self.assertEqual(summary["records"][0]["reasonCode"], "HTTP_NON_200")
                self.assertEqual(summary["records"][0]["httpStatus"], status)

    def test_invalid_and_oversized_overview_responses_stop_latency(self) -> None:
        cases = {
            "content-type": _Reply(content_type="text/plain"),
            "content-length": _Reply(content_length="not-a-number"),
            "mismatched-content-length": _Reply(body=b"{}", content_length=3),
            "declared-oversized": _Reply(content_length=MAX_JSON_BYTES + 1),
            "actual-oversized": _Reply(
                body=b"x" * (MAX_JSON_BYTES + 1), content_length=None
            ),
            "invalid-json": _Reply(body=b"credential-forbidden-body-marker"),
        }
        for name, reply in cases.items():
            with self.subTest(name=name):
                with _running_server([(OVERVIEW_PATH, reply)]) as (
                    candidate,
                    scenario,
                ):
                    summary = probe_candidates([candidate])
                self.assertEqual(scenario.requests, [("GET", OVERVIEW_PATH)])
                self.assertEqual(summary["overviewHttp200MatchCount"], 1)
                self.assertEqual(summary["records"][0]["failureStage"], "OVERVIEW")
                self.assertEqual(
                    summary["records"][0]["reasonCode"],
                    "RESPONSE_INVALID_OR_OVERSIZED",
                )
                self.assertEqual(summary["records"][0]["httpStatus"], 200)
                self.assertNotIn("forbidden-body-marker", render_diagnostic(summary))

    def test_valid_json_contract_mismatch_is_distinct(self) -> None:
        script = [
            (OVERVIEW_PATH, _json_reply({"unexpected": "private-config-marker"})),
            (LATENCY_PATH, _json_reply(VALID_LATENCY)),
        ]
        with _running_server(script) as (candidate, scenario):
            summary = probe_candidates([candidate])
        self.assertEqual(len(scenario.requests), 2)
        self.assertEqual(summary["overviewHttp200MatchCount"], 1)
        self.assertEqual(summary["fullContractMatchCount"], 0)
        self.assertEqual(summary["records"][0]["failureStage"], "CONTRACT")
        self.assertEqual(summary["records"][0]["reasonCode"], "CONTRACT_MISMATCH")
        self.assertEqual(summary["records"][0]["httpStatus"], 200)
        self.assertNotIn("private-config-marker", render_diagnostic(summary))

    def test_unknown_request_exception_is_sanitized(self) -> None:
        candidate = ProbeCandidate("http", "sensitive-origin.example", 43210)
        exception_marker = (
            "url=http://sensitive-origin.example:43210/private-path "
            "header=forbidden-header body=forbidden-body "
            "credential:forbidden-credential timing=19ms pid=2468 "
            "config=forbidden-config Traceback"
        )
        with patch.object(
            raw_monitor_probe,
            "_new_connection",
            side_effect=RuntimeError(exception_marker),
        ):
            summary = probe_candidates([candidate])
        self.assertEqual(
            summary["records"][0],
            {
                "attemptIndex": 1,
                "result": "NO_MATCH",
                "failureStage": "CONNECT",
                "reasonCode": "OTHER_REQUEST_EXCEPTION",
                "httpStatus": None,
            },
        )
        rendered = render_diagnostic(summary)
        for marker in (
            "sensitive-origin.example",
            "43210",
            "private-path",
            "forbidden-header",
            "forbidden-body",
            "forbidden-credential",
            "19ms",
            "2468",
            "forbidden-config",
            "Traceback",
            OVERVIEW_PATH,
            LATENCY_PATH,
        ):
            self.assertNotIn(marker, rendered)

    def test_non_200_error_body_is_never_read(self) -> None:
        class _Socket:
            def settimeout(self, _timeout: float) -> None:
                return

        class _Response:
            status = 503

            def read(self, _amount: int) -> bytes:
                raise AssertionError("error body was read")

            def close(self) -> None:
                return

        class _Connection:
            def __init__(self) -> None:
                self.sock = _Socket()

            def connect(self) -> None:
                return

            def request(self, method: str, path: str, *, headers: object) -> None:
                self.request_data = method, path, headers

            def getresponse(self) -> _Response:
                return _Response()

            def close(self) -> None:
                return

        connection = _Connection()
        with patch.object(
            raw_monitor_probe, "_new_connection", return_value=connection
        ):
            summary = probe_candidates(
                [ProbeCandidate("http", "redacted.example", 12345)]
            )
        self.assertEqual(summary["records"][0]["reasonCode"], "HTTP_NON_200")
        self.assertEqual(connection.request_data[0:2], ("GET", OVERVIEW_PATH))

    def test_six_candidate_aggregation_is_ordered_and_sequential(self) -> None:
        script = [
            *_valid_script(),
            (OVERVIEW_PATH, _Reply(status=503)),
            *_valid_script(),
            (OVERVIEW_PATH, _json_reply({})),
            (LATENCY_PATH, _json_reply(VALID_LATENCY)),
            (OVERVIEW_PATH, _json_reply(VALID_OVERVIEW)),
            (LATENCY_PATH, _Reply(status=404)),
            (OVERVIEW_PATH, _Reply(body=b"not-json")),
        ]
        with _running_server(script) as (candidate, scenario):
            summary = probe_candidates([candidate] * 6)

        self.assertEqual(summary["candidateCount"], 6)
        self.assertEqual(summary["overviewHttp200MatchCount"], 5)
        self.assertEqual(summary["fullContractMatchCount"], 2)
        self.assertEqual(
            [record["attemptIndex"] for record in summary["records"]],
            [1, 2, 3, 4, 5, 6],
        )
        self.assertEqual(
            [record["reasonCode"] for record in summary["records"]],
            [
                "MATCH",
                "HTTP_NON_200",
                "MATCH",
                "CONTRACT_MISMATCH",
                "HTTP_NON_200",
                "RESPONSE_INVALID_OR_OVERSIZED",
            ],
        )
        self.assertEqual(scenario.max_active, 1)
        self.assertFalse(scenario.script)

    def test_maximum_candidate_bound_is_fail_closed_before_requests(self) -> None:
        script = _valid_script() * MAX_CANDIDATES
        with _running_server(script) as (candidate, scenario):
            summary = probe_candidates([candidate] * MAX_CANDIDATES)
            request_count = len(scenario.requests)
            with self.assertRaisesRegex(ValueError, "candidate limit"):
                probe_candidates([candidate] * (MAX_CANDIDATES + 1))

        self.assertEqual(summary["candidateCount"], MAX_CANDIDATES)
        self.assertEqual(summary["fullContractMatchCount"], MAX_CANDIDATES)
        self.assertEqual(len(summary["records"]), MAX_CANDIDATES)
        self.assertEqual(summary["records"][-1]["attemptIndex"], MAX_CANDIDATES)
        self.assertEqual(len(scenario.requests), request_count)
        self.assertEqual(request_count, MAX_CANDIDATES * 2)


if __name__ == "__main__":
    unittest.main()

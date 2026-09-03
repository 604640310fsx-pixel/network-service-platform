"""Reason-coded, sanitized diagnostics for raw-monitor candidates.

This module is an internal repository diagnostic.  It deliberately returns no
candidate identity or request/response detail: records are correlated only by
their one-based attempt order.
"""

from __future__ import annotations

import http.client
import json
import math
import socket
import ssl
import time
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from monitoring.gateway.client import (
    CONNECT_TIMEOUT_SECONDS,
    MAX_JSON_BYTES,
    RAW_LATENCY_TIMEOUT_SECONDS,
    RAW_OVERVIEW_TIMEOUT_SECONDS,
)
from monitoring.gateway.projection import project_public_summary


SCHEMA_VERSION = "MGW-RAW-MONITOR-PROBE-DIAGNOSTIC-V1"
MAX_CANDIDATES = 64
OVERVIEW_PATH = "/api/overview"
LATENCY_PATH = "/api/latency?range=6h&type=icmp&target=AliDNS"

RESULTS = frozenset(("MATCH", "NO_MATCH"))
FAILURE_STAGES = frozenset(("CONNECT", "OVERVIEW", "LATENCY", "CONTRACT", "NONE"))
REASON_CODES = frozenset(
    (
        "MATCH",
        "CONNECTION_OR_PROTOCOL_FAILURE",
        "REQUEST_TIMEOUT",
        "HTTP_NON_200",
        "RESPONSE_INVALID_OR_OVERSIZED",
        "CONTRACT_MISMATCH",
        "OTHER_REQUEST_EXCEPTION",
    )
)
SUMMARY_FIELDS = frozenset(
    (
        "schemaVersion",
        "candidateCount",
        "overviewHttp200MatchCount",
        "fullContractMatchCount",
        "records",
    )
)
RECORD_FIELDS = frozenset(
    ("attemptIndex", "result", "failureStage", "reasonCode", "httpStatus")
)


@dataclass(frozen=True, repr=False)
class ProbeCandidate:
    """A private raw-monitor origin that is never copied into diagnostics."""

    scheme: str
    host: str
    port: int
    tls_context: ssl.SSLContext | None = None

    def __post_init__(self) -> None:
        if self.scheme not in ("http", "https"):
            raise ValueError("invalid probe candidate")
        if (
            not isinstance(self.host, str)
            or not self.host
            or len(self.host) > 253
            or self.host.strip() != self.host
            or any(ord(character) < 33 for character in self.host)
        ):
            raise ValueError("invalid probe candidate")
        if (
            isinstance(self.port, bool)
            or not isinstance(self.port, int)
            or not 1 <= self.port <= 65535
        ):
            raise ValueError("invalid probe candidate")
        if self.scheme == "https" and self.tls_context is None:
            raise ValueError("invalid probe candidate")
        if self.scheme == "http" and self.tls_context is not None:
            raise ValueError("invalid probe candidate")

    def __repr__(self) -> str:
        return "<ProbeCandidate redacted>"


@dataclass(frozen=True)
class _JsonResponse:
    payload: Any
    status: int


class _RequestFailure(Exception):
    def __init__(self, reason_code: str, failure_stage: str, http_status: int | None):
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.failure_stage = failure_stage
        self.http_status = http_status


def _validated_timeout(value: float, maximum: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
        or value > maximum
    ):
        raise ValueError("invalid probe timeout")
    return float(value)


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if not math.isfinite(remaining) or remaining <= 0:
        raise TimeoutError
    return remaining


def _new_connection(
    candidate: ProbeCandidate,
    *,
    timeout: float,
) -> http.client.HTTPConnection:
    if candidate.scheme == "https":
        return http.client.HTTPSConnection(
            candidate.host,
            candidate.port,
            timeout=timeout,
            context=candidate.tls_context,
        )
    return http.client.HTTPConnection(candidate.host, candidate.port, timeout=timeout)


def _failure_for_exception(
    error: Exception,
    *,
    failure_stage: str,
    http_status: int | None,
) -> _RequestFailure:
    if isinstance(error, (TimeoutError, socket.timeout)):
        reason_code = "REQUEST_TIMEOUT"
    elif isinstance(error, (ssl.SSLError, OSError, http.client.HTTPException)):
        reason_code = "CONNECTION_OR_PROTOCOL_FAILURE"
    else:
        reason_code = "OTHER_REQUEST_EXCEPTION"
    return _RequestFailure(reason_code, failure_stage, http_status)


def _request_json(
    candidate: ProbeCandidate,
    path: str,
    *,
    timeout_seconds: float,
    response_stage: str,
    connect_stage: str,
) -> _JsonResponse:
    deadline = time.monotonic() + timeout_seconds
    connection: http.client.HTTPConnection | None = None
    response: http.client.HTTPResponse | None = None
    network_socket: socket.socket | None = None
    failure_stage = connect_stage
    http_status: int | None = None
    try:
        connection = _new_connection(
            candidate,
            timeout=min(CONNECT_TIMEOUT_SECONDS, _remaining(deadline)),
        )
        connection.connect()
        _remaining(deadline)
        if connection.sock is None:
            raise ConnectionError
        network_socket = connection.sock

        failure_stage = response_stage
        network_socket.settimeout(_remaining(deadline))
        connection.request(
            "GET",
            path,
            headers={
                "Accept": "application/json",
                "User-Agent": "NetworkMonitorGatewayRawProbe/1",
                "Connection": "close",
            },
        )
        network_socket.settimeout(_remaining(deadline))
        response = connection.getresponse()
        raw_status = response.status
        if (
            isinstance(raw_status, bool)
            or not isinstance(raw_status, int)
            or not 100 <= raw_status <= 599
        ):
            raise http.client.BadStatusLine("invalid status")
        http_status = raw_status
        if http_status != 200:
            # Closing the response is safe; its error body is never consumed.
            raise _RequestFailure("HTTP_NON_200", response_stage, http_status)

        content_type = response.getheader("Content-Type", "")
        if "application/json" not in content_type.casefold():
            raise _RequestFailure(
                "RESPONSE_INVALID_OR_OVERSIZED", response_stage, http_status
            )

        content_length = response.getheader("Content-Length")
        declared_length: int | None = None
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except (TypeError, ValueError):
                raise _RequestFailure(
                    "RESPONSE_INVALID_OR_OVERSIZED", response_stage, http_status
                ) from None
            if declared_length < 0 or declared_length > MAX_JSON_BYTES:
                raise _RequestFailure(
                    "RESPONSE_INVALID_OR_OVERSIZED", response_stage, http_status
                )

        chunks: list[bytes] = []
        received = 0
        while True:
            if response.isclosed():
                break
            network_socket.settimeout(_remaining(deadline))
            chunk = response.read(min(64 * 1024, MAX_JSON_BYTES + 1 - received))
            _remaining(deadline)
            if not chunk:
                break
            chunks.append(chunk)
            received += len(chunk)
            if received > MAX_JSON_BYTES:
                raise _RequestFailure(
                    "RESPONSE_INVALID_OR_OVERSIZED", response_stage, http_status
                )
        if declared_length is not None and declared_length != received:
            raise _RequestFailure(
                "RESPONSE_INVALID_OR_OVERSIZED", response_stage, http_status
            )

        try:
            payload = json.loads(b"".join(chunks))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise _RequestFailure(
                "RESPONSE_INVALID_OR_OVERSIZED", response_stage, http_status
            ) from None
        _remaining(deadline)
        return _JsonResponse(payload=payload, status=http_status)
    except _RequestFailure:
        raise
    except Exception as error:
        raise _failure_for_exception(
            error,
            failure_stage=failure_stage,
            http_status=http_status,
        ) from None
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


def _record(
    attempt_index: int,
    *,
    result: str,
    failure_stage: str,
    reason_code: str,
    http_status: int | None,
) -> dict[str, Any]:
    return {
        "attemptIndex": attempt_index,
        "result": result,
        "failureStage": failure_stage,
        "reasonCode": reason_code,
        "httpStatus": http_status,
    }


def _bounded_candidates(candidates: Iterable[ProbeCandidate]) -> list[ProbeCandidate]:
    try:
        iterator = iter(candidates)
    except TypeError:
        raise ValueError("invalid probe candidate set") from None
    bounded: list[ProbeCandidate] = []
    for candidate in iterator:
        if len(bounded) == MAX_CANDIDATES:
            raise ValueError("probe candidate limit exceeded")
        if not isinstance(candidate, ProbeCandidate):
            raise ValueError("invalid probe candidate set")
        bounded.append(candidate)
    return bounded


def _validate_diagnostic(summary: Mapping[str, Any]) -> None:
    if set(summary) != SUMMARY_FIELDS or summary.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeError("invalid diagnostic summary")
    candidate_count = summary.get("candidateCount")
    overview_count = summary.get("overviewHttp200MatchCount")
    full_count = summary.get("fullContractMatchCount")
    records = summary.get("records")
    if (
        isinstance(candidate_count, bool)
        or not isinstance(candidate_count, int)
        or not 0 <= candidate_count <= MAX_CANDIDATES
        or isinstance(overview_count, bool)
        or not isinstance(overview_count, int)
        or isinstance(full_count, bool)
        or not isinstance(full_count, int)
        or not 0 <= full_count <= overview_count <= candidate_count
        or not isinstance(records, list)
        or len(records) != candidate_count
    ):
        raise RuntimeError("invalid diagnostic summary")

    for expected_index, record in enumerate(records, 1):
        if not isinstance(record, dict) or set(record) != RECORD_FIELDS:
            raise RuntimeError("invalid diagnostic record")
        status = record.get("httpStatus")
        if (
            record.get("attemptIndex") != expected_index
            or record.get("result") not in RESULTS
            or record.get("failureStage") not in FAILURE_STAGES
            or record.get("reasonCode") not in REASON_CODES
            or (
                status is not None
                and (
                    isinstance(status, bool)
                    or not isinstance(status, int)
                    or not 100 <= status <= 599
                )
            )
        ):
            raise RuntimeError("invalid diagnostic record")
        if record["result"] == "MATCH":
            if (
                record["failureStage"] != "NONE"
                or record["reasonCode"] != "MATCH"
                or status != 200
            ):
                raise RuntimeError("invalid diagnostic record")
        elif record["failureStage"] == "NONE" or record["reasonCode"] == "MATCH":
            raise RuntimeError("invalid diagnostic record")


def probe_candidates(
    candidates: Iterable[ProbeCandidate],
    *,
    overview_timeout_seconds: float = RAW_OVERVIEW_TIMEOUT_SECONDS,
    latency_timeout_seconds: float = RAW_LATENCY_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Probe at most 64 candidates sequentially and return only safe fields."""

    overview_timeout = _validated_timeout(
        overview_timeout_seconds, RAW_OVERVIEW_TIMEOUT_SECONDS
    )
    latency_timeout = _validated_timeout(
        latency_timeout_seconds, RAW_LATENCY_TIMEOUT_SECONDS
    )
    candidate_list = _bounded_candidates(candidates)
    overview_http_200_count = 0
    full_contract_match_count = 0
    records: list[dict[str, Any]] = []

    for attempt_index, candidate in enumerate(candidate_list, 1):
        try:
            overview = _request_json(
                candidate,
                OVERVIEW_PATH,
                timeout_seconds=overview_timeout,
                response_stage="OVERVIEW",
                connect_stage="CONNECT",
            )
        except _RequestFailure as failure:
            if failure.http_status == 200:
                overview_http_200_count += 1
            records.append(
                _record(
                    attempt_index,
                    result="NO_MATCH",
                    failure_stage=failure.failure_stage,
                    reason_code=failure.reason_code,
                    http_status=failure.http_status,
                )
            )
            continue

        overview_http_200_count += 1
        try:
            latency = _request_json(
                candidate,
                LATENCY_PATH,
                timeout_seconds=latency_timeout,
                response_stage="LATENCY",
                connect_stage="LATENCY",
            )
        except _RequestFailure as failure:
            records.append(
                _record(
                    attempt_index,
                    result="NO_MATCH",
                    failure_stage=failure.failure_stage,
                    reason_code=failure.reason_code,
                    http_status=failure.http_status,
                )
            )
            continue

        try:
            project_public_summary(overview.payload, latency.payload)
        except Exception:
            records.append(
                _record(
                    attempt_index,
                    result="NO_MATCH",
                    failure_stage="CONTRACT",
                    reason_code="CONTRACT_MISMATCH",
                    http_status=latency.status,
                )
            )
            continue

        full_contract_match_count += 1
        records.append(
            _record(
                attempt_index,
                result="MATCH",
                failure_stage="NONE",
                reason_code="MATCH",
                http_status=latency.status,
            )
        )

    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateCount": len(candidate_list),
        "overviewHttp200MatchCount": overview_http_200_count,
        "fullContractMatchCount": full_contract_match_count,
        "records": records,
    }
    _validate_diagnostic(summary)
    return summary


def render_diagnostic(summary: Mapping[str, Any]) -> str:
    """Serialize a validated diagnostic without adding metadata or details."""

    _validate_diagnostic(summary)
    return json.dumps(summary, ensure_ascii=True, separators=(",", ":"))


__all__ = (
    "FAILURE_STAGES",
    "LATENCY_PATH",
    "MAX_CANDIDATES",
    "OVERVIEW_PATH",
    "ProbeCandidate",
    "REASON_CODES",
    "RECORD_FIELDS",
    "RESULTS",
    "SCHEMA_VERSION",
    "SUMMARY_FIELDS",
    "probe_candidates",
    "render_diagnostic",
)

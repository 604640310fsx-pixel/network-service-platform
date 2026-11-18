"""Security boundaries shared by the public and private gateway listeners."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit


PROHIBITED_FIELD_NAMES = frozenset(
    (
        "source_ip",
        "target_host",
        "target_name",
        "interface",
        "internal_address",
        "public_node_address",
        "upstream_address",
        "internal_port",
        "hostname",
        "provider_resource_id",
        "monitor_target_key",
        "cpu",
        "memory",
        "storage",
        "upload",
        "download",
        "uptime",
        "hop",
        "ptr",
        "asn",
        "route",
        "config_path",
        "database_path",
        "stack",
        "connector_address",
        "credential",
        "tunnel_key",
        "private_key",
    )
)
PROHIBITED_TEXT_TOKENS = frozenset(
    (
        "source_ip",
        "target_host",
        "target_name",
        "monitor_target_key",
        "begin private key",
        "private_monitor_api_origin",
        "raw_monitor_api_origin",
    )
)
IPV4_PATTERN = re.compile(
    r"(?<![0-9])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})"
    r"(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?![0-9])"
)
URL_PATTERN = re.compile(r"\b(?:https?|wss?)://", re.IGNORECASE)


class SecurityBoundaryError(ValueError):
    """A configuration or artifact crosses a frozen trust boundary."""


def _walk(value: Any, path: str = "$"):
    if isinstance(value, dict):
        for key, child in value.items():
            yield f"{path}.{key}", str(key), True
            yield from _walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk(child, f"{path}[{index}]")
    elif isinstance(value, str):
        yield path, value, False


def scan_public_value(value: Any) -> list[str]:
    """Return identity-leak findings without echoing the sensitive value."""

    findings: list[str] = []
    for path, text, is_key in _walk(value):
        folded = text.casefold()
        if is_key and folded in PROHIBITED_FIELD_NAMES:
            findings.append(f"{path}: prohibited field")
            continue
        if any(token in folded for token in PROHIBITED_TEXT_TOKENS):
            findings.append(f"{path}: prohibited token")
        if not is_key and IPV4_PATTERN.search(text):
            findings.append(f"{path}: address-like value")
        if not is_key and URL_PATTERN.search(text):
            findings.append(f"{path}: origin-like value")
    return findings


def scan_public_files(paths: list[Path]) -> list[str]:
    findings: list[str] = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        for token in PROHIBITED_TEXT_TOKENS:
            if token in text.casefold():
                findings.append(f"{path.name}: prohibited token")
        if IPV4_PATTERN.search(text):
            findings.append(f"{path.name}: address-like value")
        if re.search(r"\b(?:https?|wss?)://", text, re.IGNORECASE):
            findings.append(f"{path.name}: hard-coded origin")
    return findings


def validate_origin(
    raw: str,
    *,
    require_https: bool,
    private_only: bool,
) -> tuple[str, str, int]:
    """Validate a configuration origin without resolving or contacting it."""

    if not isinstance(raw, str) or not raw or len(raw) > 512:
        raise SecurityBoundaryError("origin is required")
    parsed = urlsplit(raw)
    allowed_schemes = {"https"} if require_https else {"http", "https"}
    if parsed.scheme not in allowed_schemes:
        raise SecurityBoundaryError("origin scheme is not allowed")
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise SecurityBoundaryError("origin must be an exact authority")

    host = parsed.hostname.rstrip(".").casefold()
    if not host or "*" in host or any(character.isspace() for character in host):
        raise SecurityBoundaryError("origin host is invalid")
    if private_only and not _is_private_host(host):
        raise SecurityBoundaryError("private origin must use a private host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise SecurityBoundaryError("origin port is invalid") from exc
    return parsed.scheme, host, port or (443 if parsed.scheme == "https" else 80)


def _is_private_host(host: str) -> bool:
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".internal"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return not address.is_global and not address.is_unspecified and not address.is_multicast


def validate_private_bind_host(host: str) -> str:
    if not isinstance(host, str) or not _is_private_host(host.casefold()):
        raise SecurityBoundaryError("private listener must bind a private address")
    return host


def validate_public_parent_origin(raw: str) -> str:
    scheme, host, port = validate_origin(raw, require_https=True, private_only=False)
    default_port = port == 443
    authority_host = f"[{host}]" if ":" in host else host
    return (
        f"{scheme}://{authority_host}"
        if default_port
        else f"{scheme}://{authority_host}:{port}"
    )


@dataclass
class _Bucket:
    tokens: float
    updated_at: float


class TokenBucketLimiter:
    """In-memory 30/minute limiter with a frozen burst of ten."""

    def __init__(
        self,
        *,
        requests_per_minute: int = 30,
        burst: int = 10,
        max_clients: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if requests_per_minute <= 0 or burst <= 0 or max_clients <= 0:
            raise ValueError("rate limit must be positive")
        self._refill_per_second = requests_per_minute / 60
        self._burst = float(burst)
        self._max_clients = max_clients
        self._prune_after_seconds = self._burst / self._refill_per_second + 60
        self._clock = clock
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def consume(self, client_key: str) -> bool:
        now = self._clock()
        with self._lock:
            bucket = self._buckets.get(client_key)
            if bucket is None:
                if len(self._buckets) >= self._max_clients:
                    expired = [
                        key
                        for key, value in self._buckets.items()
                        if now - value.updated_at >= self._prune_after_seconds
                    ]
                    for key in expired:
                        del self._buckets[key]
                if len(self._buckets) >= self._max_clients:
                    return False
                bucket = _Bucket(tokens=self._burst, updated_at=now)
                self._buckets[client_key] = bucket
            elapsed = max(0.0, now - bucket.updated_at)
            bucket.tokens = min(
                self._burst,
                bucket.tokens + elapsed * self._refill_per_second,
            )
            bucket.updated_at = now
            if bucket.tokens < 1:
                return False
            bucket.tokens -= 1
            return True


class SafeEventLogger:
    """Structured logger that never records URLs, queries, bodies, or raw IPs."""

    _EVENTS = frozenset(
        (
            "public_request",
            "public_rejected",
            "private_request",
            "private_rejected",
            "upstream_timeout",
            "upstream_unavailable",
            "upstream_schema_invalid",
        )
    )

    def __init__(self, sink: Callable[[str], None] = print) -> None:
        self._sink = sink
        self._salt = secrets.token_bytes(32)

    def client_id(self, address: str) -> str:
        return hashlib.sha256(self._salt + address.encode("utf-8")).hexdigest()[:12]

    def write(self, event: str, *, status: int, client_id: str) -> None:
        if event not in self._EVENTS or not isinstance(status, int):
            raise SecurityBoundaryError("unsafe log event")
        self._sink(
            json.dumps(
                {"event": event, "status": status, "client": client_id},
                separators=(",", ":"),
                sort_keys=True,
            )
        )

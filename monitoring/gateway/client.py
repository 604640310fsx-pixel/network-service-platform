"""Bounded private HTTP clients and mTLS service-identity primitives."""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import math
import socket
import ssl
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from .projection import ProjectionError, validate_public_summary
from .security import SecurityBoundaryError, validate_origin


MAX_JSON_BYTES = 512 * 1024
CONNECT_TIMEOUT_SECONDS = 3.0
MAX_TOTAL_TIMEOUT_SECONDS = 45.0
RAW_OVERVIEW_TIMEOUT_SECONDS = 25.0
RAW_LATENCY_TIMEOUT_SECONDS = 8.0
PRIVATE_PROJECTION_MAX_SECONDS = 36.0
PUBLIC_TO_PRIVATE_TIMEOUT_SECONDS = 40.0
PUBLIC_REQUEST_MAX_SECONDS = 42.0
READINESS_MAX_SECONDS = 45.0
FUTURE_NGINX_CONNECT_TIMEOUT_SECONDS = 3.0
FUTURE_NGINX_READ_TIMEOUT_SECONDS = 50.0
CERTIFICATE_MINIMUM_VALIDITY_SECONDS = 24 * 60 * 60
PUBLIC_BFF_IDENTITY = "public_bff"
AUTH_SERVICE_IDENTITY = "auth_service"
OPERATOR_IDENTITY = "operator"
IDENTITY_ROLES = frozenset(
    (PUBLIC_BFF_IDENTITY, AUTH_SERVICE_IDENTITY, OPERATOR_IDENTITY)
)


class MonitorGatewayError(RuntimeError):
    """Base class for safe upstream failure mapping."""


class UpstreamTimeout(MonitorGatewayError):
    pass


class UpstreamUnavailable(MonitorGatewayError):
    pass


class UpstreamSchemaInvalid(MonitorGatewayError):
    pass


def _validated_timeout_seconds(value: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
        or value > MAX_TOTAL_TIMEOUT_SECONDS
    ):
        raise SecurityBoundaryError("upstream timeout is outside the safe range")
    return float(value)


@dataclass(frozen=True)
class MonotonicDeadline:
    """One absolute deadline shared by every step in a bounded operation."""

    expires_at: float
    _clock: Callable[[], float]

    @classmethod
    def start(
        cls,
        total_timeout_seconds: float,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> "MonotonicDeadline":
        timeout = _validated_timeout_seconds(total_timeout_seconds)
        started_at = clock()
        if not math.isfinite(started_at):
            raise SecurityBoundaryError("monotonic clock is invalid")
        return cls(started_at + timeout, clock)

    def child(self, total_timeout_seconds: float) -> "MonotonicDeadline":
        timeout = _validated_timeout_seconds(total_timeout_seconds)
        current = self._clock()
        if not math.isfinite(current):
            raise SecurityBoundaryError("monotonic clock is invalid")
        if current >= self.expires_at:
            raise UpstreamTimeout("upstream timeout")
        return MonotonicDeadline(min(self.expires_at, current + timeout), self._clock)

    def remaining_seconds(self) -> float:
        remaining = self.expires_at - self._clock()
        if not math.isfinite(remaining) or remaining <= 0:
            raise UpstreamTimeout("upstream timeout")
        return remaining

    def ensure_remaining(self) -> None:
        self.remaining_seconds()


class _DeadlineRawReader(io.RawIOBase):
    """Socket reader that reapplies only the absolute deadline remainder."""

    def __init__(
        self,
        raw_socket: socket.socket,
        deadline: MonotonicDeadline,
        release: Callable[[], None] = lambda: None,
    ) -> None:
        super().__init__()
        self._socket = raw_socket
        self._deadline = deadline
        self._release = release
        self._released = False

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        self._socket.settimeout(self._deadline.remaining_seconds())
        return self._socket.recv_into(buffer)

    def fileno(self) -> int:
        return self._socket.fileno()

    def close(self) -> None:
        if self._released:
            return
        self._released = True
        try:
            super().close()
        finally:
            self._release()


class _DeadlineSocket:
    """Minimal socket facade used by http.client without resetting timeouts."""

    def __init__(self, raw_socket: socket.socket, deadline: MonotonicDeadline) -> None:
        self._socket = raw_socket
        self._deadline = deadline
        self._file_references = 0
        self._close_requested = False
        self._closed = False

    def sendall(self, data: bytes, flags: int = 0) -> None:
        remaining_data = memoryview(data)
        while remaining_data:
            self._socket.settimeout(self._deadline.remaining_seconds())
            sent = self._socket.send(remaining_data, flags)
            if sent <= 0:
                raise OSError("upstream connection closed")
            remaining_data = remaining_data[sent:]

    def makefile(
        self,
        mode: str,
        buffering: int | None = None,
        *_args: Any,
        **_kwargs: Any,
    ) -> io.BufferedReader:
        if mode != "rb":
            raise ValueError("deadline socket supports binary reads only")
        buffer_size = (
            io.DEFAULT_BUFFER_SIZE
            if buffering is None or buffering <= 0
            else buffering
        )
        self._file_references += 1
        try:
            return io.BufferedReader(
                _DeadlineRawReader(
                    self._socket,
                    self._deadline,
                    self._release_file_reference,
                ),
                buffer_size=buffer_size,
            )
        except BaseException:
            self._release_file_reference()
            raise

    def close(self) -> None:
        self._close_requested = True
        if self._file_references == 0:
            self._close_socket()

    def _release_file_reference(self) -> None:
        if self._file_references > 0:
            self._file_references -= 1
        if self._close_requested and self._file_references == 0:
            self._close_socket()

    def _close_socket(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._socket.close()

    def force_close(self) -> None:
        self._close_requested = True
        self._close_socket()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._socket, name)


@dataclass(frozen=True)
class CertificateDiagnostic:
    role: str
    fingerprint_sha256: str | None
    not_after: str | None
    remaining_seconds: int
    status: str


@dataclass(frozen=True)
class Origin:
    scheme: str
    host: str
    port: int

    @classmethod
    def private(cls, raw: str, *, require_https: bool) -> "Origin":
        return cls(*validate_origin(raw, require_https=require_https, private_only=True))


def build_mtls_client_context(
    *,
    ca_file: Path,
    certificate_file: Path,
    key_file: Path,
) -> ssl.SSLContext:
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=str(ca_file))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(certificate_file), str(key_file))
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def build_mtls_server_context(
    *,
    ca_file: Path,
    certificate_file: Path,
    key_file: Path,
) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(certificate_file), str(key_file))
    context.load_verify_locations(cafile=str(ca_file))
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def build_public_tls_server_context(
    *,
    certificate_file: Path,
    key_file: Path,
) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(certificate_file), str(key_file))
    return context


class FixedJsonClient:
    """GET-only client with a fixed origin, bounded body, and no redirects."""

    def __init__(
        self,
        origin: Origin,
        *,
        tls_context: ssl.SSLContext | None,
        _clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if origin.scheme == "https" and tls_context is None:
            raise SecurityBoundaryError("HTTPS origin requires a TLS context")
        if origin.scheme == "http" and tls_context is not None:
            raise SecurityBoundaryError("HTTP origin cannot use a TLS context")
        self._origin = origin
        self._tls_context = tls_context
        self._clock = _clock

    def deadline(self, total_timeout_seconds: float) -> MonotonicDeadline:
        return MonotonicDeadline.start(total_timeout_seconds, clock=self._clock)

    def get(
        self,
        path: str,
        *,
        total_timeout_seconds: float,
        _parent_deadline: MonotonicDeadline | None = None,
    ) -> Any:
        if (
            not isinstance(path, str)
            or not path.startswith("/")
            or len(path) > 512
            or "\r" in path
            or "\n" in path
        ):
            raise SecurityBoundaryError("invalid fixed upstream path")
        timeout = _validated_timeout_seconds(total_timeout_seconds)
        deadline = (
            _parent_deadline.child(timeout)
            if _parent_deadline is not None
            else self.deadline(timeout)
        )
        connect_deadline = deadline.child(CONNECT_TIMEOUT_SECONDS)
        connect_timeout = connect_deadline.remaining_seconds()
        connection: http.client.HTTPConnection
        if self._origin.scheme == "https":
            connection = http.client.HTTPSConnection(
                self._origin.host,
                self._origin.port,
                timeout=connect_timeout,
                context=self._tls_context,
            )
        else:
            connection = http.client.HTTPConnection(
                self._origin.host,
                self._origin.port,
                timeout=connect_timeout,
            )
        deadline_socket: _DeadlineSocket | None = None
        response: Any = None
        try:
            connection.connect()
            connect_deadline.ensure_remaining()
            if connection.sock is None:
                raise UpstreamUnavailable("upstream unavailable")
            deadline_socket = _DeadlineSocket(connection.sock, deadline)
            connection.sock = deadline_socket  # type: ignore[assignment]
            connection.request(
                "GET",
                path,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "NetworkMonitorGateway/1",
                    "Connection": "close",
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                # Never consume or log an upstream error body.
                if response.status == 504:
                    raise UpstreamTimeout("upstream timeout")
                if response.status >= 500:
                    raise UpstreamUnavailable("upstream unavailable")
                raise UpstreamSchemaInvalid("unexpected upstream response")
            content_type = response.getheader("Content-Type", "")
            if "application/json" not in content_type.casefold():
                raise UpstreamSchemaInvalid("upstream content type is invalid")
            content_length = response.getheader("Content-Length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except ValueError as exc:
                    raise UpstreamSchemaInvalid(
                        "upstream content length is invalid"
                    ) from exc
                if declared_length < 0 or declared_length > MAX_JSON_BYTES:
                    raise UpstreamSchemaInvalid("upstream response is too large")
            chunks: list[bytes] = []
            received = 0
            while True:
                deadline.ensure_remaining()
                chunk = response.read(min(64 * 1024, MAX_JSON_BYTES + 1 - received))
                deadline.ensure_remaining()
                if not chunk:
                    break
                chunks.append(chunk)
                received += len(chunk)
                if received > MAX_JSON_BYTES:
                    raise UpstreamSchemaInvalid("upstream response is too large")
            body = b"".join(chunks)
            try:
                payload = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise UpstreamSchemaInvalid("upstream JSON is invalid") from exc
            deadline.ensure_remaining()
            return payload
        except UpstreamTimeout:
            raise
        except (TimeoutError, socket.timeout) as exc:
            raise UpstreamTimeout("upstream timeout") from exc
        except (ssl.SSLError, OSError, http.client.HTTPException) as exc:
            raise UpstreamUnavailable("upstream unavailable") from exc
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            try:
                connection.close()
            except Exception:
                pass
            if deadline_socket is not None:
                try:
                    deadline_socket.force_close()
                except Exception:
                    pass


class RawMonitorClient:
    """Private-only client for the two fixed raw 3002 read paths."""

    OVERVIEW_PATH = "/api/overview"
    LATENCY_PATH = "/api/latency?range=6h&type=icmp&target=AliDNS"

    def __init__(self, client: FixedJsonClient) -> None:
        self._client = client

    def read_projection_inputs(self) -> tuple[Any, Any]:
        return self.read_projection_inputs_with_deadline(
            self._client.deadline(PRIVATE_PROJECTION_MAX_SECONDS)
        )

    def read_projection_inputs_with_deadline(
        self,
        deadline: MonotonicDeadline,
    ) -> tuple[Any, Any]:
        # Sequential reads keep load bounded and avoid concurrent raw requests.
        overview = self._client.get(
            self.OVERVIEW_PATH,
            total_timeout_seconds=RAW_OVERVIEW_TIMEOUT_SECONDS,
            _parent_deadline=deadline,
        )
        latency = self._client.get(
            self.LATENCY_PATH,
            total_timeout_seconds=RAW_LATENCY_TIMEOUT_SECONDS,
            _parent_deadline=deadline,
        )
        deadline.ensure_remaining()
        return overview, latency


class PrivateProjectionClient:
    """Public-BFF mTLS client for the single sanitized private path."""

    SUMMARY_PATH = "/api/public-summary"

    def __init__(self, client: FixedJsonClient) -> None:
        self._client = client

    def read_public_summary(self) -> dict[str, Any]:
        return self.read_public_summary_with_deadline(
            self._client.deadline(PUBLIC_TO_PRIVATE_TIMEOUT_SECONDS)
        )

    def read_public_summary_with_deadline(
        self,
        deadline: MonotonicDeadline,
    ) -> dict[str, Any]:
        payload = self._client.get(
            self.SUMMARY_PATH,
            total_timeout_seconds=PUBLIC_TO_PRIVATE_TIMEOUT_SECONDS,
            _parent_deadline=deadline,
        )
        try:
            summary = validate_public_summary(payload)
        except ProjectionError as exc:
            raise UpstreamSchemaInvalid("private projection schema is invalid") from exc
        deadline.ensure_remaining()
        return summary


def certificate_fingerprint(path: Path) -> str:
    try:
        pem = path.read_text(encoding="ascii")
        der = ssl.PEM_cert_to_DER_cert(pem)
    except (OSError, UnicodeError, ValueError, ssl.SSLError) as exc:
        raise SecurityBoundaryError("identity certificate is invalid") from exc
    return hashlib.sha256(der).hexdigest()


def certificate_diagnostic(
    path: Path,
    *,
    role: str,
    now: datetime | None = None,
    minimum_validity_seconds: int = CERTIFICATE_MINIMUM_VALIDITY_SECONDS,
) -> CertificateDiagnostic:
    """Return only safe certificate metadata needed by startup/readiness gates."""

    if (
        not isinstance(role, str)
        or not role
        or minimum_validity_seconds < 0
    ):
        raise SecurityBoundaryError("certificate diagnostic configuration is invalid")
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise SecurityBoundaryError("certificate diagnostic time is invalid")
    current = current.astimezone(timezone.utc)
    try:
        fingerprint = certificate_fingerprint(path)
        decoded = ssl._ssl._test_decode_cert(str(path))  # type: ignore[attr-defined]
        raw_not_after = decoded.get("notAfter")
        if not isinstance(raw_not_after, str) or not raw_not_after:
            raise ValueError("missing expiry")
        expires_at = datetime.fromtimestamp(
            ssl.cert_time_to_seconds(raw_not_after),
            tz=timezone.utc,
        )
    except (
        AttributeError,
        OSError,
        OverflowError,
        TypeError,
        ValueError,
        ssl.SSLError,
        SecurityBoundaryError,
    ):
        return CertificateDiagnostic(
            role=role,
            fingerprint_sha256=None,
            not_after=None,
            remaining_seconds=0,
            status="invalid",
        )
    remaining_seconds = int((expires_at - current).total_seconds())
    if remaining_seconds <= 0:
        status = "expired"
    elif remaining_seconds < minimum_validity_seconds:
        status = "expiring"
    else:
        status = "valid"
    return CertificateDiagnostic(
        role=role,
        fingerprint_sha256=fingerprint,
        not_after=expires_at.isoformat(timespec="seconds").replace("+00:00", "Z"),
        remaining_seconds=remaining_seconds,
        status=status,
    )


class IdentityRegistry:
    """Maps independently revocable client certificates to one exact role."""

    def __init__(
        self,
        fingerprints: dict[str, str | Sequence[str]],
    ) -> None:
        if not fingerprints or not set(fingerprints).issubset(IDENTITY_ROLES):
            raise SecurityBoundaryError("identity role is invalid")
        normalized: dict[str, str] = {}
        for role, raw_fingerprints in fingerprints.items():
            values = (
                (raw_fingerprints,)
                if isinstance(raw_fingerprints, str)
                else tuple(raw_fingerprints)
            )
            if not 1 <= len(values) <= 2:
                raise SecurityBoundaryError("identity rotation window is invalid")
            role_fingerprints: set[str] = set()
            for raw_fingerprint in values:
                if not isinstance(raw_fingerprint, str):
                    raise SecurityBoundaryError("identity fingerprint is invalid")
                fingerprint = raw_fingerprint.casefold().replace(":", "")
                if not re_full_sha256(fingerprint):
                    raise SecurityBoundaryError("identity fingerprint is invalid")
                if fingerprint in role_fingerprints:
                    raise SecurityBoundaryError("identity fingerprint is duplicated")
                if fingerprint in normalized:
                    raise SecurityBoundaryError("service identities must be distinct")
                role_fingerprints.add(fingerprint)
                normalized[fingerprint] = role
        self._by_fingerprint = normalized

    @classmethod
    def from_certificate_files(
        cls,
        files: dict[str, Path | Sequence[Path]],
        *,
        now: datetime | None = None,
    ) -> "IdentityRegistry":
        fingerprints: dict[str, tuple[str, ...]] = {}
        for role, raw_paths in files.items():
            paths = (raw_paths,) if isinstance(raw_paths, Path) else tuple(raw_paths)
            if not 1 <= len(paths) <= 2:
                raise SecurityBoundaryError("identity rotation window is invalid")
            role_fingerprints: list[str] = []
            for path in paths:
                diagnostic = certificate_diagnostic(path, role=role, now=now)
                if diagnostic.status in {"invalid", "expired"}:
                    raise SecurityBoundaryError("identity certificate is invalid")
                assert diagnostic.fingerprint_sha256 is not None
                role_fingerprints.append(diagnostic.fingerprint_sha256)
            fingerprints[role] = tuple(role_fingerprints)
        return cls(fingerprints)

    def resolve_der_certificate(self, certificate: bytes | None) -> str | None:
        if not certificate:
            return None
        return self._by_fingerprint.get(hashlib.sha256(certificate).hexdigest())


def re_full_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)

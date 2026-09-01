"""Bounded private HTTP clients and mTLS service-identity primitives."""

from __future__ import annotations

import hashlib
import http.client
import json
import socket
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from .projection import ProjectionError, validate_public_summary
from .security import SecurityBoundaryError, validate_origin


MAX_JSON_BYTES = 512 * 1024
DEFAULT_TIMEOUT_SECONDS = 5.0
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
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if origin.scheme == "https" and tls_context is None:
            raise SecurityBoundaryError("HTTPS origin requires a TLS context")
        if origin.scheme == "http" and tls_context is not None:
            raise SecurityBoundaryError("HTTP origin cannot use a TLS context")
        if timeout_seconds <= 0 or timeout_seconds > 30:
            raise SecurityBoundaryError("upstream timeout is outside the safe range")
        self._origin = origin
        self._tls_context = tls_context
        self._timeout_seconds = timeout_seconds

    def get(self, path: str) -> Any:
        if (
            not isinstance(path, str)
            or not path.startswith("/")
            or len(path) > 512
            or "\r" in path
            or "\n" in path
        ):
            raise SecurityBoundaryError("invalid fixed upstream path")
        connection: http.client.HTTPConnection
        if self._origin.scheme == "https":
            connection = http.client.HTTPSConnection(
                self._origin.host,
                self._origin.port,
                timeout=self._timeout_seconds,
                context=self._tls_context,
            )
        else:
            connection = http.client.HTTPConnection(
                self._origin.host,
                self._origin.port,
                timeout=self._timeout_seconds,
            )
        try:
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
            body = response.read(MAX_JSON_BYTES + 1)
            if len(body) > MAX_JSON_BYTES:
                raise UpstreamSchemaInvalid("upstream response is too large")
            try:
                return json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise UpstreamSchemaInvalid("upstream JSON is invalid") from exc
        except (TimeoutError, socket.timeout) as exc:
            raise UpstreamTimeout("upstream timeout") from exc
        except (ssl.SSLError, OSError, http.client.HTTPException) as exc:
            raise UpstreamUnavailable("upstream unavailable") from exc
        finally:
            connection.close()


class RawMonitorClient:
    """Private-only client for the two fixed raw 3002 read paths."""

    OVERVIEW_PATH = "/api/overview"
    LATENCY_PATH = "/api/latency?range=6h&type=icmp&target=AliDNS"

    def __init__(self, client: FixedJsonClient) -> None:
        self._client = client

    def read_projection_inputs(self) -> tuple[Any, Any]:
        # Sequential reads keep load bounded and avoid concurrent raw requests.
        return self._client.get(self.OVERVIEW_PATH), self._client.get(self.LATENCY_PATH)


class PrivateProjectionClient:
    """Public-BFF mTLS client for the single sanitized private path."""

    SUMMARY_PATH = "/api/public-summary"

    def __init__(self, client: FixedJsonClient) -> None:
        self._client = client

    def read_public_summary(self) -> dict[str, Any]:
        payload = self._client.get(self.SUMMARY_PATH)
        try:
            return validate_public_summary(payload)
        except ProjectionError as exc:
            raise UpstreamSchemaInvalid("private projection schema is invalid") from exc


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

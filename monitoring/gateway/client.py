"""Bounded private HTTP clients and mTLS service-identity primitives."""

from __future__ import annotations

import hashlib
import http.client
import json
import socket
import ssl
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .projection import ProjectionError, validate_public_summary
from .security import SecurityBoundaryError, validate_origin


MAX_JSON_BYTES = 512 * 1024
RAW_STATUS_MAX_BYTES = 64 * 1024
RAW_CATALOG_MAX_BYTES = 256 * 1024
DEFAULT_TIMEOUT_SECONDS = 5.0
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


class UpstreamNotFound(MonitorGatewayError):
    pass


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

    def get(self, path: str, *, max_bytes: int = MAX_JSON_BYTES) -> Any:
        if (
            not isinstance(path, str)
            or not path.startswith("/")
            or len(path) > 512
            or "\r" in path
            or "\n" in path
            or not isinstance(max_bytes, int)
            or max_bytes < 1
            or max_bytes > MAX_JSON_BYTES
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
                if response.status == 404:
                    raise UpstreamNotFound("upstream target not found")
                if response.status == 504:
                    raise UpstreamTimeout("upstream timeout")
                if response.status >= 500:
                    raise UpstreamUnavailable("upstream unavailable")
                raise UpstreamSchemaInvalid("unexpected upstream response")
            content_type = response.getheader("Content-Type", "").casefold()
            content_type_parts = [part.strip() for part in content_type.split(";")]
            if (
                content_type_parts[0] != "application/json"
                or len(content_type_parts) > 2
                or (
                    len(content_type_parts) == 2
                    and content_type_parts[1] != "charset=utf-8"
                )
            ):
                raise UpstreamSchemaInvalid("upstream content type is invalid")
            content_length = response.getheader("Content-Length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except ValueError as exc:
                    raise UpstreamSchemaInvalid(
                        "upstream content length is invalid"
                    ) from exc
                if declared_length < 0 or declared_length > max_bytes:
                    raise UpstreamSchemaInvalid("upstream response is too large")
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes:
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
    """Private-only client for fixed raw 3002 read paths."""

    OVERVIEW_PATH = "/api/overview"
    LATENCY_PATH = "/api/latency?range=6h&type=icmp&target=AliDNS"

    def __init__(self, client: FixedJsonClient) -> None:
        self._client = client

    def read_projection_inputs(self) -> tuple[Any, Any]:
        # Sequential reads keep load bounded and avoid concurrent raw requests.
        return self._client.get(self.OVERVIEW_PATH), self._client.get(self.LATENCY_PATH)

    def read_target_catalog(self) -> Any:
        return self._client.get(
            "/api/vps-targets",
            max_bytes=RAW_CATALOG_MAX_BYTES,
        )

    def read_target_status(self, target: str) -> Any:
        if (
            not isinstance(target, str)
            or not target
            or target.strip() != target
            or len(target) > 128
            or any(ord(character) < 32 or ord(character) == 127 for character in target)
        ):
            raise SecurityBoundaryError("target key is invalid")
        return self._client.get(
            f"/api/vps-status?target={quote(target, safe='')}",
            max_bytes=RAW_STATUS_MAX_BYTES,
        )


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


class IdentityRegistry:
    """Maps independently revocable client certificates to one exact role."""

    def __init__(self, fingerprints: dict[str, str]) -> None:
        if not fingerprints or not set(fingerprints).issubset(IDENTITY_ROLES):
            raise SecurityBoundaryError("identity role is invalid")
        normalized: dict[str, str] = {}
        for role, raw_fingerprint in fingerprints.items():
            fingerprint = raw_fingerprint.casefold().replace(":", "")
            if not re_full_sha256(fingerprint):
                raise SecurityBoundaryError("identity fingerprint is invalid")
            if fingerprint in normalized:
                raise SecurityBoundaryError("service identities must be distinct")
            normalized[fingerprint] = role
        self._by_fingerprint = normalized

    @classmethod
    def from_certificate_files(cls, files: dict[str, Path]) -> "IdentityRegistry":
        return cls({role: certificate_fingerprint(path) for role, path in files.items()})

    def resolve_der_certificate(self, certificate: bytes | None) -> str | None:
        if not certificate:
            return None
        return self._by_fingerprint.get(hashlib.sha256(certificate).hexdigest())


def re_full_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)

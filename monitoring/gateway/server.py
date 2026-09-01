#!/usr/bin/env python3
"""TLS-only public BFF and private mTLS projection listener.

The two modes are separate processes and share no listener. The public process
can read only the sanitized private route. The private process can read the two
fixed raw 3002 GET paths and constructs a new allowlisted response.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import socket
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit

from .client import (
    AUTH_SERVICE_IDENTITY,
    OPERATOR_IDENTITY,
    PUBLIC_BFF_IDENTITY,
    CertificateDiagnostic,
    FixedJsonClient,
    IdentityRegistry,
    Origin,
    PrivateProjectionClient,
    RawMonitorClient,
    UpstreamSchemaInvalid,
    UpstreamTimeout,
    UpstreamUnavailable,
    build_mtls_client_context,
    build_mtls_server_context,
    build_public_tls_server_context,
    certificate_diagnostic,
)
from .projection import (
    STALE_AFTER_SECONDS,
    ProjectionError,
    project_public_summary,
    validate_public_summary,
)
from .security import (
    MONITOR_CLIENT_IP_HEADER,
    SafeEventLogger,
    SecurityBoundaryError,
    TokenBucketLimiter,
    is_loopback_address,
    resolve_direct_client_identity,
    resolve_trusted_proxy_client_identity,
    scan_public_value,
    validate_loopback_bind_host,
    validate_public_parent_origin,
)


STATIC_ROOT = Path(__file__).resolve().parent / "static"
INDEX_PARENT_ORIGIN_PLACEHOLDER = b"__MONITOR_PARENT_ORIGIN__"
PUBLIC_SUMMARY_PATH = "/api/summary"
PRIVATE_SUMMARY_PATH = "/api/public-summary"
HEALTH_PATH = "/healthz"
READINESS_PATH = "/readyz"
STATIC_PATHS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/master.css": ("master.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}


class PublicSummaryReader(Protocol):
    def read_public_summary(self) -> dict[str, Any]: ...


class RawProjectionReader(Protocol):
    def read_projection_inputs(self) -> tuple[Any, Any]: ...


class ReadinessEvaluator(Protocol):
    def evaluate(self) -> None: ...


class ClientIdentityResolver(Protocol):
    def __call__(
        self,
        peer_address: str,
        forwarded_values: tuple[str, ...],
    ) -> str: ...


@dataclass(frozen=True)
class CertificateRequirement:
    role: str
    path: Path


class ReadinessFailure(RuntimeError):
    SAFE_CODES = frozenset(
        (
            "certificate_invalid",
            "certificate_expiring",
            "identity_invalid",
            "upstream_timeout",
            "upstream_unavailable",
            "upstream_schema_invalid",
            "stale_data",
            "no_data",
        )
    )

    def __init__(self, code: str) -> None:
        if code not in self.SAFE_CODES:
            raise ValueError("unsafe readiness code")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PublicDependencies:
    summary_reader: PublicSummaryReader
    parent_origin: str
    limiter: TokenBucketLimiter
    logger: SafeEventLogger
    static_root: Path = STATIC_ROOT
    client_identity_resolver: ClientIdentityResolver = resolve_direct_client_identity
    readiness: ReadinessEvaluator | None = None


@dataclass(frozen=True)
class PrivateDependencies:
    raw_reader: RawProjectionReader
    identities: IdentityRegistry
    logger: SafeEventLogger
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    readiness: ReadinessEvaluator | None = None


def _certificate_diagnostics(
    requirements: tuple[CertificateRequirement, ...],
    *,
    now: datetime,
) -> tuple[CertificateDiagnostic, ...]:
    return tuple(
        certificate_diagnostic(requirement.path, role=requirement.role, now=now)
        for requirement in requirements
    )


def _check_certificate_readiness(
    requirements: tuple[CertificateRequirement, ...],
    *,
    now: datetime,
) -> None:
    if not requirements:
        raise ReadinessFailure("identity_invalid")
    for diagnostic in _certificate_diagnostics(requirements, now=now):
        if diagnostic.status in {"invalid", "expired"}:
            raise ReadinessFailure("certificate_invalid")
        if diagnostic.status == "expiring":
            raise ReadinessFailure("certificate_expiring")


def _check_summary_freshness(payload: Any, *, now: datetime) -> None:
    try:
        summary = validate_public_summary(payload)
    except ProjectionError as exc:
        raise ReadinessFailure("upstream_schema_invalid") from exc
    current = now.astimezone(timezone.utc)
    for wan in summary["wans"]:
        if wan["status"] == "no_data":
            raise ReadinessFailure("no_data")
        if wan["status"] == "stale" or wan["stale"]:
            raise ReadinessFailure("stale_data")
        updated_at = wan["updatedAt"]
        assert isinstance(updated_at, str)
        try:
            updated = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ReadinessFailure("upstream_schema_invalid") from exc
        age_seconds = (current - updated.astimezone(timezone.utc)).total_seconds()
        if age_seconds < -300:
            raise ReadinessFailure("upstream_schema_invalid")
        if age_seconds > STALE_AFTER_SECONDS:
            raise ReadinessFailure("stale_data")


def _map_readiness_error(error: Exception) -> ReadinessFailure:
    if isinstance(error, ReadinessFailure):
        return error
    if isinstance(error, UpstreamTimeout):
        return ReadinessFailure("upstream_timeout")
    if isinstance(error, UpstreamUnavailable):
        return ReadinessFailure("upstream_unavailable")
    if isinstance(error, (ProjectionError, UpstreamSchemaInvalid)):
        return ReadinessFailure("upstream_schema_invalid")
    return ReadinessFailure("upstream_unavailable")


@dataclass(frozen=True)
class PublicRuntimeReadiness:
    summary_reader: PublicSummaryReader
    certificate_requirements: tuple[CertificateRequirement, ...]
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    def evaluate(self) -> None:
        current = self.now().astimezone(timezone.utc)
        _check_certificate_readiness(self.certificate_requirements, now=current)
        try:
            payload = self.summary_reader.read_public_summary()
            _check_summary_freshness(payload, now=current)
        except ReadinessFailure:
            raise
        except Exception as exc:
            raise _map_readiness_error(exc) from exc


@dataclass(frozen=True)
class PrivateRuntimeReadiness:
    raw_reader: RawProjectionReader
    certificate_requirements: tuple[CertificateRequirement, ...]
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    def evaluate(self) -> None:
        current = self.now().astimezone(timezone.utc)
        _check_certificate_readiness(self.certificate_requirements, now=current)
        try:
            overview, latency = self.raw_reader.read_projection_inputs()
            payload = project_public_summary(overview, latency, now=current)
            _check_summary_freshness(payload, now=current)
        except ReadinessFailure:
            raise
        except Exception as exc:
            raise _map_readiness_error(exc) from exc


def _safe_error(code: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code}}


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )


def _threading_server(
    host: str,
    port: int,
    handler: type[BaseHTTPRequestHandler],
) -> ThreadingHTTPServer:
    if host == "::1":
        class _IPv6ThreadingHTTPServer(ThreadingHTTPServer):
            address_family = socket.AF_INET6

        return _IPv6ThreadingHTTPServer((host, port), handler)
    return ThreadingHTTPServer((host, port), handler)


class _SafeHandler(BaseHTTPRequestHandler):
    server_version = "NetworkMonitorGateway/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        # BaseHTTPRequestHandler includes the complete request target. Every
        # accepted event is logged through SafeEventLogger instead.
        return

    def direct_client_identity(self) -> str:
        return resolve_direct_client_identity(str(self.client_address[0]))

    def client_token(self, client_identity: str | None = None) -> str:
        logger: SafeEventLogger = self.dependencies.logger  # type: ignore[attr-defined]
        return logger.client_id(client_identity or self.direct_client_identity())

    def _is_loopback_peer(self) -> bool:
        return is_loopback_address(str(self.client_address[0]))

    def _send_runtime_probe(
        self,
        path: str,
        *,
        query: str,
        fragment: str,
        head_only: bool,
    ) -> bool:
        if path not in {HEALTH_PATH, READINESS_PATH}:
            return False
        event = "health_request" if path == HEALTH_PATH else "readiness_request"
        if query or fragment or not self._is_loopback_peer():
            payload: Any = _safe_error("not_found")
            status = 404
        elif path == HEALTH_PATH:
            payload = {"status": "ok"}
            status = 200
        else:
            readiness: ReadinessEvaluator | None = self.dependencies.readiness  # type: ignore[attr-defined]
            try:
                if readiness is None:
                    raise ReadinessFailure("identity_invalid")
                readiness.evaluate()
                payload = {"status": "ready"}
                status = 200
            except ReadinessFailure as exc:
                payload = {"status": "not_ready", "code": exc.code}
                status = 503
            except Exception:
                payload = {"status": "not_ready", "code": "upstream_unavailable"}
                status = 503
        body = _json_bytes(payload)
        self._send_bytes(
            body,
            status=status,
            content_type="application/json; charset=utf-8",
            cache_control="no-store",
            head_only=head_only,
        )
        self.dependencies.logger.write(  # type: ignore[attr-defined]
            event,
            status=status,
            client_id=self.client_token(),
        )
        return True

    def _common_headers(self, *, cache_control: str) -> None:
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )

    def _send_bytes(
        self,
        body: bytes,
        *,
        status: int,
        content_type: str,
        cache_control: str,
        head_only: bool = False,
        allow: str | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self._common_headers(cache_control=cache_control)
        if allow is not None:
            self.send_header("Allow", allow)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)


def make_public_handler(dependencies: PublicDependencies):
    bound_dependencies = dependencies

    class PublicHandler(_SafeHandler):
        dependencies = bound_dependencies

        def _forwarded_identity_values(self) -> tuple[str, ...]:
            return tuple(
                value
                for name, value in self.headers.raw_items()
                if name.casefold() == MONITOR_CLIENT_IP_HEADER.casefold()
            )

        def _request_client_identity(self) -> str:
            cached = getattr(self, "_monitor_client_identity", None)
            if cached is not None:
                return cached
            identity = dependencies.client_identity_resolver(
                str(self.client_address[0]),
                self._forwarded_identity_values(),
            )
            self._monitor_client_identity = identity
            return identity

        def _require_client_identity(self) -> str | None:
            try:
                return self._request_client_identity()
            except SecurityBoundaryError:
                self._send_public_json(
                    _safe_error("bad_request"),
                    status=400,
                    event="public_rejected",
                    client_identity=self.direct_client_identity(),
                )
                return None

        def send_error(
            self,
            code: int,
            _message: str | None = None,
            _explain: str | None = None,
        ) -> None:
            status = code if 400 <= code <= 599 else 400
            error_code = "bad_request" if status < 500 else "monitor_unavailable"
            self._send_public_json(
                _safe_error(error_code),
                status=status,
                event="public_rejected",
            )

        def _public_headers(self) -> None:
            self._common_headers(cache_control="no-store")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; "
                "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
                f"base-uri 'none'; form-action 'none'; frame-ancestors {dependencies.parent_origin}",
            )

        def _send_public_bytes(
            self,
            body: bytes,
            *,
            status: int,
            content_type: str,
            head_only: bool = False,
            allow: str | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self._public_headers()
            if allow is not None:
                self.send_header("Allow", allow)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _send_public_json(
            self,
            payload: Any,
            *,
            status: int,
            event: str,
            allow: str | None = None,
            head_only: bool = False,
            client_identity: str | None = None,
        ) -> None:
            if status < 400 and scan_public_value(payload):
                payload = _safe_error("monitor_unavailable")
                status = 502
                event = "upstream_schema_invalid"
            if client_identity is None:
                client_identity = getattr(
                    self,
                    "_monitor_client_identity",
                    self.direct_client_identity(),
                )
            self._send_public_bytes(
                _json_bytes(payload),
                status=status,
                content_type="application/json; charset=utf-8",
                allow=allow,
                head_only=head_only,
            )
            dependencies.logger.write(
                event,
                status=status,
                client_id=self.client_token(client_identity),
            )

        def do_GET(self) -> None:
            parsed = urlsplit(self.path)
            if self._send_runtime_probe(
                parsed.path,
                query=parsed.query,
                fragment=parsed.fragment,
                head_only=False,
            ):
                return
            client_identity = self._require_client_identity()
            if client_identity is None:
                return
            if parsed.path == PUBLIC_SUMMARY_PATH:
                if parsed.query or parsed.fragment:
                    return self._send_public_json(
                        _safe_error("not_found"),
                        status=404,
                        event="public_rejected",
                    )
                if not dependencies.limiter.consume(client_identity):
                    return self._send_public_json(
                        _safe_error("rate_limited"),
                        status=429,
                        event="public_rejected",
                    )
                try:
                    payload = dependencies.summary_reader.read_public_summary()
                except UpstreamTimeout:
                    return self._send_public_json(
                        _safe_error("monitor_unavailable"),
                        status=504,
                        event="upstream_timeout",
                    )
                except UpstreamSchemaInvalid:
                    return self._send_public_json(
                        _safe_error("monitor_unavailable"),
                        status=502,
                        event="upstream_schema_invalid",
                    )
                except UpstreamUnavailable:
                    return self._send_public_json(
                        _safe_error("monitor_unavailable"),
                        status=503,
                        event="upstream_unavailable",
                    )
                except Exception:
                    # Never let an unexpected client/parser failure print a
                    # traceback containing private implementation details.
                    return self._send_public_json(
                        _safe_error("monitor_unavailable"),
                        status=503,
                        event="upstream_unavailable",
                    )
                return self._send_public_json(
                    payload,
                    status=200,
                    event="public_request",
                )
            return self._serve_static(parsed.path, head_only=False)

        def do_HEAD(self) -> None:
            parsed = urlsplit(self.path)
            if self._send_runtime_probe(
                parsed.path,
                query=parsed.query,
                fragment=parsed.fragment,
                head_only=True,
            ):
                return
            if self._require_client_identity() is None:
                return
            if parsed.path == PUBLIC_SUMMARY_PATH:
                return self._send_public_json(
                    _safe_error("method_not_allowed"),
                    status=405,
                    event="public_rejected",
                    allow="GET",
                    head_only=True,
                )
            return self._serve_static(parsed.path, head_only=True)

        def _serve_static(self, path: str, *, head_only: bool) -> None:
            selected = STATIC_PATHS.get(path)
            if selected is None:
                return self._send_public_json(
                    _safe_error("not_found"),
                    status=404,
                    event="public_rejected",
                    head_only=head_only,
                )
            name, content_type = selected
            candidate = (dependencies.static_root / name).resolve()
            root = dependencies.static_root.resolve()
            if root not in candidate.parents or not candidate.is_file():
                return self._send_public_json(
                    _safe_error("not_found"),
                    status=404,
                    event="public_rejected",
                    head_only=head_only,
                )
            try:
                body = candidate.read_bytes()
            except OSError:
                return self._send_public_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                    head_only=head_only,
                )
            if name == "index.html":
                if body.count(INDEX_PARENT_ORIGIN_PLACEHOLDER) != 1:
                    return self._send_public_json(
                        _safe_error("monitor_unavailable"),
                        status=503,
                        event="upstream_unavailable",
                        head_only=head_only,
                    )
                escaped_parent = html.escape(
                    dependencies.parent_origin,
                    quote=True,
                ).encode("utf-8")
                body = body.replace(
                    INDEX_PARENT_ORIGIN_PLACEHOLDER,
                    escaped_parent,
                )
            self._send_public_bytes(
                body,
                status=200,
                content_type=content_type,
                head_only=head_only,
            )
            dependencies.logger.write(
                "public_request",
                status=200,
                client_id=self.client_token(self._request_client_identity()),
            )

        def _reject_write(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path in {HEALTH_PATH, READINESS_PATH}:
                hidden = (
                    bool(parsed.query)
                    or bool(parsed.fragment)
                    or not self._is_loopback_peer()
                )
                return self._send_public_json(
                    _safe_error("not_found" if hidden else "method_not_allowed"),
                    status=404 if hidden else 405,
                    event="public_rejected",
                    allow=None if hidden else "GET, HEAD",
                    client_identity=self.direct_client_identity(),
                )
            if self._require_client_identity() is None:
                return
            allow = "GET" if parsed.path == PUBLIC_SUMMARY_PATH else "GET, HEAD"
            self._send_public_json(
                _safe_error("method_not_allowed"),
                status=405,
                event="public_rejected",
                allow=allow,
            )

        do_POST = _reject_write
        do_PUT = _reject_write
        do_PATCH = _reject_write
        do_DELETE = _reject_write
        do_OPTIONS = _reject_write

    return PublicHandler


def make_private_handler(dependencies: PrivateDependencies):
    bound_dependencies = dependencies

    class PrivateHandler(_SafeHandler):
        dependencies = bound_dependencies

        def send_error(
            self,
            code: int,
            _message: str | None = None,
            _explain: str | None = None,
        ) -> None:
            status = code if 400 <= code <= 599 else 400
            error_code = "bad_request" if status < 500 else "monitor_unavailable"
            self._send_private_json(
                _safe_error(error_code),
                status=status,
                event="private_rejected",
            )

        def _send_private_json(
            self,
            payload: Any,
            *,
            status: int,
            event: str,
            allow: str | None = None,
            head_only: bool = False,
        ) -> None:
            if status < 400 and scan_public_value(payload):
                payload = _safe_error("monitor_unavailable")
                status = 502
                event = "upstream_schema_invalid"
            self._send_bytes(
                _json_bytes(payload),
                status=status,
                content_type="application/json; charset=utf-8",
                cache_control="private, no-store",
                allow=allow,
                head_only=head_only,
            )
            dependencies.logger.write(
                event,
                status=status,
                client_id=self.client_token(),
            )

        def _identity(self) -> str | None:
            if not isinstance(self.connection, ssl.SSLSocket):
                return None
            certificate = self.connection.getpeercert(binary_form=True)
            return dependencies.identities.resolve_der_certificate(certificate)

        def do_GET(self) -> None:
            parsed = urlsplit(self.path)
            if self._send_runtime_probe(
                parsed.path,
                query=parsed.query,
                fragment=parsed.fragment,
                head_only=False,
            ):
                return
            if parsed.path != PRIVATE_SUMMARY_PATH or parsed.query or parsed.fragment:
                return self._send_private_json(
                    _safe_error("not_found"),
                    status=404,
                    event="private_rejected",
                )
            if self._identity() != PUBLIC_BFF_IDENTITY:
                return self._send_private_json(
                    _safe_error("forbidden"),
                    status=403,
                    event="private_rejected",
                )
            try:
                overview, latency = dependencies.raw_reader.read_projection_inputs()
                payload = project_public_summary(
                    overview,
                    latency,
                    now=dependencies.now(),
                )
            except UpstreamTimeout:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=504,
                    event="upstream_timeout",
                )
            except (ProjectionError, UpstreamSchemaInvalid):
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=502,
                    event="upstream_schema_invalid",
                )
            except UpstreamUnavailable:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                )
            except Exception:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                )
            return self._send_private_json(
                payload,
                status=200,
                event="private_request",
            )

        def do_HEAD(self) -> None:
            parsed = urlsplit(self.path)
            if self._send_runtime_probe(
                parsed.path,
                query=parsed.query,
                fragment=parsed.fragment,
                head_only=True,
            ):
                return
            self._send_private_json(
                _safe_error("method_not_allowed"),
                status=405,
                event="private_rejected",
                allow="GET",
                head_only=True,
            )

        def _reject_method(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path in {HEALTH_PATH, READINESS_PATH}:
                hidden = (
                    bool(parsed.query)
                    or bool(parsed.fragment)
                    or not self._is_loopback_peer()
                )
                return self._send_private_json(
                    _safe_error("not_found" if hidden else "method_not_allowed"),
                    status=404 if hidden else 405,
                    event="private_rejected",
                    allow=None if hidden else "GET, HEAD",
                )
            self._send_private_json(
                _safe_error("method_not_allowed"),
                status=405,
                event="private_rejected",
                allow="GET",
            )

        do_POST = _reject_method
        do_PUT = _reject_method
        do_PATCH = _reject_method
        do_DELETE = _reject_method
        do_OPTIONS = _reject_method

    return PrivateHandler


def _required(name: str) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        raise SecurityBoundaryError(f"{name} is required")
    return value.strip()


def _required_port(name: str) -> int:
    raw = _required(name)
    try:
        port = int(raw)
    except ValueError as exc:
        raise SecurityBoundaryError(f"{name} is invalid") from exc
    if not 1 <= port <= 65535:
        raise SecurityBoundaryError(f"{name} is invalid")
    return port


def _path(name: str) -> Path:
    path = Path(_required(name)).expanduser().resolve()
    if not path.is_file():
        raise SecurityBoundaryError(f"{name} is not a file")
    return path


def _optional_file(name: str) -> Path | None:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return None
    path = Path(value.strip()).expanduser().resolve()
    if not path.is_file():
        raise SecurityBoundaryError(f"{name} is not a file")
    return path


def _optional_identity_files() -> dict[str, tuple[Path, ...]]:
    configured: dict[str, tuple[Path, ...]] = {}
    names = {
        PUBLIC_BFF_IDENTITY: (
            "PUBLIC_BFF_IDENTITY_CERT_FILE",
            "PUBLIC_BFF_IDENTITY_CERT_FILE_NEXT",
            True,
        ),
        AUTH_SERVICE_IDENTITY: (
            "AUTH_SERVICE_IDENTITY_CERT_FILE",
            "AUTH_SERVICE_IDENTITY_CERT_FILE_NEXT",
            False,
        ),
        OPERATOR_IDENTITY: (
            "OPERATOR_IDENTITY_CERT_FILE",
            "OPERATOR_IDENTITY_CERT_FILE_NEXT",
            False,
        ),
    }
    for role, (current_name, next_name, required) in names.items():
        current = _path(current_name) if required else _optional_file(current_name)
        next_path = _optional_file(next_name)
        if next_path is not None and current is None:
            raise SecurityBoundaryError(f"{next_name} requires {current_name}")
        if current is not None:
            configured[role] = (
                (current, next_path) if next_path is not None else (current,)
            )
    return configured


def _identity_certificate_requirements(
    files: dict[str, tuple[Path, ...]],
) -> tuple[CertificateRequirement, ...]:
    requirements: list[CertificateRequirement] = []
    for role, paths in files.items():
        for index, path in enumerate(paths):
            suffix = "current" if index == 0 else "next"
            requirements.append(
                CertificateRequirement(role=f"{role}_{suffix}", path=path)
            )
    return tuple(requirements)


def _emit_and_validate_startup_certificates(
    logger: SafeEventLogger,
    requirements: tuple[CertificateRequirement, ...],
) -> None:
    now = datetime.now(timezone.utc)
    for diagnostic in _certificate_diagnostics(requirements, now=now):
        logger.write_certificate_status(
            role=diagnostic.role,
            fingerprint_sha256=diagnostic.fingerprint_sha256,
            not_after=diagnostic.not_after,
            remaining_seconds=diagnostic.remaining_seconds,
            status=diagnostic.status,
        )
        if diagnostic.status in {"invalid", "expired"}:
            raise SecurityBoundaryError("runtime certificate is invalid")


def _raw_client() -> tuple[RawMonitorClient, tuple[CertificateRequirement, ...]]:
    origin = Origin.private(_required("RAW_MONITOR_API_ORIGIN"), require_https=False)
    context: ssl.SSLContext | None = None
    requirements: tuple[CertificateRequirement, ...] = ()
    if origin.scheme == "https":
        raw_ca_file = _path("RAW_MONITOR_CA_FILE")
        context = ssl.create_default_context(
            ssl.Purpose.SERVER_AUTH,
            cafile=str(raw_ca_file),
        )
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        requirements = (
            CertificateRequirement(role="raw_monitor_ca", path=raw_ca_file),
        )
    return RawMonitorClient(FixedJsonClient(origin, tls_context=context)), requirements


def run_public() -> None:
    parent_origin = validate_public_parent_origin(
        _required("FINAL_CANONICAL_WEBSITE_ORIGIN")
    )
    private_origin = Origin.private(_required("MONITOR_API_ORIGIN"), require_https=True)
    bind_host = validate_loopback_bind_host(_required("PUBLIC_MONITOR_BIND_HOST"))
    private_ca_file = _path("MONITOR_PRIVATE_CA_FILE")
    public_bff_certificate = _path("MONITOR_PUBLIC_BFF_CLIENT_CERT_FILE")
    public_bff_key = _path("MONITOR_PUBLIC_BFF_CLIENT_KEY_FILE")
    public_tls_certificate = _path("PUBLIC_MONITOR_TLS_CERT_FILE")
    public_tls_key = _path("PUBLIC_MONITOR_TLS_KEY_FILE")
    client_context = build_mtls_client_context(
        ca_file=private_ca_file,
        certificate_file=public_bff_certificate,
        key_file=public_bff_key,
    )
    summary_reader = PrivateProjectionClient(
        FixedJsonClient(private_origin, tls_context=client_context)
    )
    certificate_requirements = (
        CertificateRequirement(role="public_listener", path=public_tls_certificate),
        CertificateRequirement(role="private_ca", path=private_ca_file),
        CertificateRequirement(role="public_bff_current", path=public_bff_certificate),
    )
    logger = SafeEventLogger()
    _emit_and_validate_startup_certificates(logger, certificate_requirements)
    dependencies = PublicDependencies(
        summary_reader=summary_reader,
        parent_origin=parent_origin,
        limiter=TokenBucketLimiter(requests_per_minute=30, burst=10),
        logger=logger,
        client_identity_resolver=resolve_trusted_proxy_client_identity,
        readiness=PublicRuntimeReadiness(
            summary_reader=summary_reader,
            certificate_requirements=certificate_requirements,
        ),
    )
    server = _threading_server(
        bind_host,
        _required_port("PUBLIC_MONITOR_PORT"),
        make_public_handler(dependencies),
    )
    tls_context = build_public_tls_server_context(
        certificate_file=public_tls_certificate,
        key_file=public_tls_key,
    )
    server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


def run_private() -> None:
    host = validate_loopback_bind_host(_required("PRIVATE_MONITOR_BIND_HOST"))
    raw_reader, raw_requirements = _raw_client()
    identity_files = _optional_identity_files()
    private_tls_certificate = _path("PRIVATE_MONITOR_TLS_CERT_FILE")
    private_tls_key = _path("PRIVATE_MONITOR_TLS_KEY_FILE")
    private_client_ca = _path("PRIVATE_MONITOR_CLIENT_CA_FILE")
    certificate_requirements = (
        CertificateRequirement(role="private_listener", path=private_tls_certificate),
        CertificateRequirement(role="private_client_ca", path=private_client_ca),
        *_identity_certificate_requirements(identity_files),
        *raw_requirements,
    )
    logger = SafeEventLogger()
    _emit_and_validate_startup_certificates(logger, certificate_requirements)
    dependencies = PrivateDependencies(
        raw_reader=raw_reader,
        identities=IdentityRegistry.from_certificate_files(identity_files),
        logger=logger,
        readiness=PrivateRuntimeReadiness(
            raw_reader=raw_reader,
            certificate_requirements=certificate_requirements,
        ),
    )
    server = _threading_server(
        host,
        _required_port("PRIVATE_MONITOR_PORT"),
        make_private_handler(dependencies),
    )
    tls_context = build_mtls_server_context(
        ca_file=private_client_ca,
        certificate_file=private_tls_certificate,
        key_file=private_tls_key,
    )
    server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="sanitized monitor gateway")
    parser.add_argument("mode", choices=("public", "private"))
    args = parser.parse_args()
    if args.mode == "public":
        run_public()
    else:
        run_private()


if __name__ == "__main__":
    main()

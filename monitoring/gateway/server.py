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
import re
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import parse_qsl, urlsplit

from .client import (
    AUTH_SERVICE_IDENTITY,
    OPERATOR_IDENTITY,
    PUBLIC_BFF_IDENTITY,
    FixedJsonClient,
    IdentityRegistry,
    Origin,
    PrivateProjectionClient,
    RawMonitorClient,
    UpstreamNotFound,
    UpstreamSchemaInvalid,
    UpstreamTimeout,
    UpstreamUnavailable,
    build_mtls_client_context,
    build_mtls_server_context,
    build_public_tls_server_context,
)
from .auth_projection import (
    AuthProjectionError,
    project_target_catalog,
    project_target_status,
    require_assignable_target,
)
from .projection import ProjectionError, project_public_summary
from .security import (
    SafeEventLogger,
    SecurityBoundaryError,
    TokenBucketLimiter,
    scan_public_value,
    validate_private_bind_host,
    validate_public_parent_origin,
)


STATIC_ROOT = Path(__file__).resolve().parent / "static"
INDEX_PARENT_ORIGIN_PLACEHOLDER = b"__MONITOR_PARENT_ORIGIN__"
PUBLIC_SUMMARY_PATH = "/api/summary"
PRIVATE_SUMMARY_PATH = "/api/public-summary"
AUTH_TARGETS_PATH = "/api/auth-service/targets"
AUTH_STATUS_PATH = "/api/auth-service/status"
PUBLIC_SERVER_STATUS_PATH = "/api/server-status"
PRIVATE_SERVER_STATUS_PATH = "/api/public-server-status"
# Stable neutral public label for the one operator server. The catalog display
# label can carry provider identity, so it is never used for public output.
PUBLIC_SERVER_STATUS_LABEL = "节点01"
STATIC_PATHS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/master.css": ("master.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}


class PublicSummaryReader(Protocol):
    def read_public_summary(self) -> dict[str, Any]: ...


class PublicServerStatusReader(Protocol):
    def read_public_server_status(self) -> dict[str, Any]: ...


class RawProjectionReader(Protocol):
    def read_projection_inputs(self) -> tuple[Any, Any]: ...

    def read_target_catalog(self) -> Any: ...

    def read_target_status(self, target: str) -> Any: ...


@dataclass(frozen=True)
class PublicDependencies:
    summary_reader: PublicSummaryReader
    parent_origin: str
    limiter: TokenBucketLimiter
    logger: SafeEventLogger
    static_root: Path = STATIC_ROOT
    # Optional: public status of the single server-side-configured target.
    server_status_reader: PublicServerStatusReader | None = None


@dataclass(frozen=True)
class PrivateDependencies:
    raw_reader: RawProjectionReader
    identities: IdentityRegistry
    logger: SafeEventLogger
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    # Target key for the public server status; never taken from a request and
    # never returned. None keeps the public server-status route unconfigured.
    public_status_target: str | None = None


def _safe_error(code: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code}}


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )


class _SafeHandler(BaseHTTPRequestHandler):
    server_version = "NetworkMonitorGateway/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        # BaseHTTPRequestHandler includes the complete request target. Every
        # accepted event is logged through SafeEventLogger instead.
        return

    @property
    def client_token(self) -> str:
        logger: SafeEventLogger = self.dependencies.logger  # type: ignore[attr-defined]
        return logger.client_id(str(self.client_address[0]))

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
        ) -> None:
            if status < 400 and scan_public_value(payload):
                payload = _safe_error("monitor_unavailable")
                status = 502
                event = "upstream_schema_invalid"
            self._send_public_bytes(
                _json_bytes(payload),
                status=status,
                content_type="application/json; charset=utf-8",
                allow=allow,
                head_only=head_only,
            )
            dependencies.logger.write(event, status=status, client_id=self.client_token)

        def do_GET(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path == PUBLIC_SUMMARY_PATH:
                if parsed.query or parsed.fragment:
                    return self._send_public_json(
                        _safe_error("not_found"),
                        status=404,
                        event="public_rejected",
                    )
                if not dependencies.limiter.consume(str(self.client_address[0])):
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
            if parsed.path == PUBLIC_SERVER_STATUS_PATH:
                return self._public_server_status(parsed.query, parsed.fragment)
            return self._serve_static(parsed.path, head_only=False)

        def _public_server_status(self, query: str, fragment: str) -> None:
            reader = dependencies.server_status_reader
            if reader is None or query or fragment:
                return self._send_public_json(
                    _safe_error("not_found"),
                    status=404,
                    event="public_rejected",
                )
            if not dependencies.limiter.consume(str(self.client_address[0])):
                return self._send_public_json(
                    _safe_error("rate_limited"),
                    status=429,
                    event="public_rejected",
                )
            try:
                payload = reader.read_public_server_status()
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
            except Exception:
                # Unavailable, unconfigured or inactive targets all collapse to
                # one public state; no private reason or traceback is exposed.
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

        def do_HEAD(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path in (PUBLIC_SUMMARY_PATH, PUBLIC_SERVER_STATUS_PATH):
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
                "public_request", status=200, client_id=self.client_token
            )

        def _reject_write(self) -> None:
            parsed = urlsplit(self.path)
            allow = (
                "GET"
                if parsed.path in (PUBLIC_SUMMARY_PATH, PUBLIC_SERVER_STATUS_PATH)
                else "GET, HEAD"
            )
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
            public_projection: bool = True,
        ) -> None:
            if public_projection and status < 400 and scan_public_value(payload):
                payload = _safe_error("monitor_unavailable")
                status = 502
                event = "upstream_schema_invalid"
            self._send_bytes(
                _json_bytes(payload),
                status=status,
                content_type="application/json; charset=utf-8",
                cache_control="no-store",
                allow=allow,
                head_only=head_only,
            )
            dependencies.logger.write(event, status=status, client_id=self.client_token)

        def _identity(self) -> str | None:
            if not isinstance(self.connection, ssl.SSLSocket):
                return None
            certificate = self.connection.getpeercert(binary_form=True)
            return dependencies.identities.resolve_der_certificate(certificate)

        def _authorized(self, identity: str | None, path: str) -> bool:
            if path in (PRIVATE_SUMMARY_PATH, PRIVATE_SERVER_STATUS_PATH):
                return identity == PUBLIC_BFF_IDENTITY
            if path in (AUTH_TARGETS_PATH, AUTH_STATUS_PATH):
                return identity == AUTH_SERVICE_IDENTITY
            return False

        def _has_body(self) -> bool:
            if self.headers.get("Transfer-Encoding") is not None:
                return True
            raw_length = self.headers.get("Content-Length")
            if raw_length is None:
                return False
            return not raw_length.isdigit() or int(raw_length) != 0

        def _target_query(self, raw_query: str) -> str:
            if not raw_query or re.search(r"%(?![0-9A-Fa-f]{2})", raw_query):
                raise AuthProjectionError("invalid_request")
            try:
                pairs = parse_qsl(
                    raw_query,
                    keep_blank_values=True,
                    strict_parsing=True,
                    encoding="utf-8",
                    errors="strict",
                    max_num_fields=2,
                )
            except (UnicodeError, ValueError) as exc:
                raise AuthProjectionError("invalid_request") from exc
            if len(pairs) != 1 or pairs[0][0] != "target":
                raise AuthProjectionError("invalid_request")
            target = pairs[0][1]
            if (
                not target
                or target.strip() != target
                or len(target) > 128
                or any(ord(character) < 32 or ord(character) == 127 for character in target)
            ):
                raise AuthProjectionError("invalid_request")
            return target

        def _send_auth_error(self, code: str) -> None:
            status = {
                "invalid_request": 400,
                "forbidden": 403,
                "target_not_found": 404,
                "method_not_allowed": 405,
                "target_unavailable": 409,
                "monitor_invalid_response": 502,
                "monitor_unavailable": 503,
            }.get(code, 503)
            self._send_private_json(
                _safe_error(code if code in {
                    "invalid_request",
                    "forbidden",
                    "target_not_found",
                    "method_not_allowed",
                    "target_unavailable",
                    "monitor_invalid_response",
                    "monitor_unavailable",
                } else "monitor_unavailable"),
                status=status,
                event="private_rejected",
                allow="GET" if code == "method_not_allowed" else None,
                public_projection=False,
            )

        def _auth_targets(self) -> None:
            try:
                payload = {
                    "items": list(
                        project_target_catalog(
                            dependencies.raw_reader.read_target_catalog()
                        )
                    )
                }
            except UpstreamTimeout:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=504,
                    event="upstream_timeout",
                    public_projection=False,
                )
            except (AuthProjectionError, UpstreamSchemaInvalid, UpstreamNotFound):
                return self._send_private_json(
                    _safe_error("monitor_invalid_response"),
                    status=502,
                    event="upstream_schema_invalid",
                    public_projection=False,
                )
            except UpstreamUnavailable:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                    public_projection=False,
                )
            except Exception:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                    public_projection=False,
                )
            self._send_private_json(
                payload,
                status=200,
                event="private_request",
                public_projection=False,
            )

        def _auth_status(self, target: str) -> None:
            try:
                catalog = project_target_catalog(
                    dependencies.raw_reader.read_target_catalog()
                )
                require_assignable_target(catalog, target)
                payload = project_target_status(
                    dependencies.raw_reader.read_target_status(target),
                    target,
                )
            except UpstreamNotFound:
                return self._send_private_json(
                    _safe_error("target_not_found"),
                    status=404,
                    event="private_rejected",
                    public_projection=False,
                )
            except AuthProjectionError as exc:
                if exc.code == "target_not_found":
                    status = 404
                elif exc.code == "target_unavailable":
                    status = 409
                elif exc.code == "monitor_unavailable":
                    status = 503
                else:
                    status = 502
                code = (
                    exc.code
                    if exc.code in {
                        "target_not_found",
                        "target_unavailable",
                        "monitor_unavailable",
                        "monitor_invalid_response",
                    }
                    else "monitor_invalid_response"
                )
                return self._send_private_json(
                    _safe_error(code),
                    status=status,
                    event="private_rejected",
                    public_projection=False,
                )
            except UpstreamTimeout:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=504,
                    event="upstream_timeout",
                    public_projection=False,
                )
            except UpstreamSchemaInvalid:
                return self._send_private_json(
                    _safe_error("monitor_invalid_response"),
                    status=502,
                    event="upstream_schema_invalid",
                    public_projection=False,
                )
            except UpstreamUnavailable:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                    public_projection=False,
                )
            except Exception:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                    public_projection=False,
                )
            self._send_private_json(
                payload,
                status=200,
                event="private_request",
                public_projection=False,
            )

        def _public_server_status(self, target: str) -> None:
            try:
                require_assignable_target(
                    project_target_catalog(
                        dependencies.raw_reader.read_target_catalog()
                    ),
                    target,
                )
                status = project_target_status(
                    dependencies.raw_reader.read_target_status(target),
                    target,
                )
            except UpstreamTimeout:
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=504,
                    event="upstream_timeout",
                )
            except Exception:
                # Missing, inactive, invalid or unreachable targets collapse to
                # one unavailable state; the target key is never echoed.
                return self._send_private_json(
                    _safe_error("monitor_unavailable"),
                    status=503,
                    event="upstream_unavailable",
                )
            self._send_private_json(
                {
                    "label": PUBLIC_SERVER_STATUS_LABEL,
                    "status": status["status"],
                    "updatedAt": status["updatedAt"],
                    "stale": status["stale"],
                },
                status=200,
                event="private_request",
            )

        def do_GET(self) -> None:
            parsed = urlsplit(self.path)
            identity = self._identity()
            if not self._authorized(identity, parsed.path):
                return self._send_private_json(
                    _safe_error("forbidden"),
                    status=403,
                    event="private_rejected",
                )
            if parsed.path == PRIVATE_SERVER_STATUS_PATH:
                target = dependencies.public_status_target
                if target is None or parsed.query or parsed.fragment or self._has_body():
                    return self._send_private_json(
                        _safe_error("not_found"),
                        status=404,
                        event="private_rejected",
                    )
                return self._public_server_status(target)
            if parsed.path == AUTH_TARGETS_PATH:
                if parsed.query or parsed.fragment or self._has_body():
                    return self._send_auth_error("invalid_request")
                return self._auth_targets()
            if parsed.path == AUTH_STATUS_PATH:
                if parsed.fragment or self._has_body():
                    return self._send_auth_error("invalid_request")
                try:
                    target = self._target_query(parsed.query)
                except AuthProjectionError:
                    return self._send_auth_error("invalid_request")
                return self._auth_status(target)
            if parsed.query or parsed.fragment:
                return self._send_private_json(
                    _safe_error("not_found"),
                    status=404,
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
            self._reject_method(head_only=True)

        def _reject_method(self, *, head_only: bool = False) -> None:
            parsed = urlsplit(self.path)
            if not self._authorized(self._identity(), parsed.path):
                return self._send_private_json(
                    _safe_error("forbidden"),
                    status=403,
                    event="private_rejected",
                    head_only=head_only,
                )
            self._send_private_json(
                _safe_error("method_not_allowed"),
                status=405,
                event="private_rejected",
                allow="GET",
                head_only=head_only,
            )

        do_POST = _reject_method
        do_PUT = _reject_method
        do_PATCH = _reject_method
        do_DELETE = _reject_method
        do_OPTIONS = _reject_method
        do_TRACE = _reject_method
        do_CONNECT = _reject_method

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


def _optional_identity_files() -> dict[str, Path]:
    files = {PUBLIC_BFF_IDENTITY: _path("PUBLIC_BFF_IDENTITY_CERT_FILE")}
    optional = {
        AUTH_SERVICE_IDENTITY: "AUTH_SERVICE_IDENTITY_CERT_FILE",
        OPERATOR_IDENTITY: "OPERATOR_IDENTITY_CERT_FILE",
    }
    for role, name in optional.items():
        value = os.environ.get(name)
        if value and value.strip():
            path = Path(value.strip()).expanduser().resolve()
            if not path.is_file():
                raise SecurityBoundaryError(f"{name} is not a file")
            files[role] = path
    return files


def _optional_public_status_target() -> str | None:
    value = os.environ.get("PUBLIC_SERVER_STATUS_TARGET")
    if value is None or not value.strip():
        return None
    if (
        value.strip() != value
        or len(value) > 128
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise SecurityBoundaryError("PUBLIC_SERVER_STATUS_TARGET is invalid")
    return value


def _raw_client() -> RawMonitorClient:
    origin = Origin.private(_required("RAW_MONITOR_API_ORIGIN"), require_https=False)
    context: ssl.SSLContext | None = None
    if origin.scheme == "https":
        context = ssl.create_default_context(
            ssl.Purpose.SERVER_AUTH,
            cafile=str(_path("RAW_MONITOR_CA_FILE")),
        )
        context.minimum_version = ssl.TLSVersion.TLSv1_2
    return RawMonitorClient(FixedJsonClient(origin, tls_context=context))


def run_public() -> None:
    parent_origin = validate_public_parent_origin(
        _required("FINAL_CANONICAL_WEBSITE_ORIGIN")
    )
    private_origin = Origin.private(_required("MONITOR_API_ORIGIN"), require_https=True)
    client_context = build_mtls_client_context(
        ca_file=_path("MONITOR_PRIVATE_CA_FILE"),
        certificate_file=_path("MONITOR_PUBLIC_BFF_CLIENT_CERT_FILE"),
        key_file=_path("MONITOR_PUBLIC_BFF_CLIENT_KEY_FILE"),
    )
    projection_client = PrivateProjectionClient(
        FixedJsonClient(private_origin, tls_context=client_context)
    )
    dependencies = PublicDependencies(
        summary_reader=projection_client,
        server_status_reader=projection_client,
        parent_origin=parent_origin,
        limiter=TokenBucketLimiter(requests_per_minute=30, burst=10),
        logger=SafeEventLogger(),
    )
    server = ThreadingHTTPServer(
        (_required("PUBLIC_MONITOR_BIND_HOST"), _required_port("PUBLIC_MONITOR_PORT")),
        make_public_handler(dependencies),
    )
    tls_context = build_public_tls_server_context(
        certificate_file=_path("PUBLIC_MONITOR_TLS_CERT_FILE"),
        key_file=_path("PUBLIC_MONITOR_TLS_KEY_FILE"),
    )
    server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


def run_private() -> None:
    host = validate_private_bind_host(_required("PRIVATE_MONITOR_BIND_HOST"))
    dependencies = PrivateDependencies(
        raw_reader=_raw_client(),
        identities=IdentityRegistry.from_certificate_files(_optional_identity_files()),
        logger=SafeEventLogger(),
        public_status_target=_optional_public_status_target(),
    )
    server = ThreadingHTTPServer(
        (host, _required_port("PRIVATE_MONITOR_PORT")),
        make_private_handler(dependencies),
    )
    tls_context = build_mtls_server_context(
        ca_file=_path("PRIVATE_MONITOR_CLIENT_CA_FILE"),
        certificate_file=_path("PRIVATE_MONITOR_TLS_CERT_FILE"),
        key_file=_path("PRIVATE_MONITOR_TLS_KEY_FILE"),
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

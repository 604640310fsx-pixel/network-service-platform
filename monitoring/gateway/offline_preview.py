#!/usr/bin/env python3
"""Loopback-only fixture preview for the sanitized public monitor.

This module is an acceptance aid, not a production fallback. It never reads a
remote origin, binds only to loopback, and serves an allowlisted fixture through
the same public handler used by the gateway.
"""

from __future__ import annotations

import argparse
import threading
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from typing import Callable

from .projection import validate_public_summary
from .security import (
    SafeEventLogger,
    SecurityBoundaryError,
    TokenBucketLimiter,
    validate_origin,
)
from .server import PublicDependencies, make_public_handler


_FIXTURE_SERIES = {
    "telecom": (18.2, 18.8, 19.1, 18.6, 18.4, 19.0, 18.7, 18.5, 18.9, 19.2, 18.8, 18.6, 18.3, 18.7),
    "mobile": (28.6, 29.1, 29.8, 29.3, 28.9, 29.6, 30.1, 29.5, 29.0, 29.4, 29.8, 29.2, 28.8, 29.3),
    "unicom": (22.4, 22.9, 23.2, 22.8, 22.5, 23.0, 23.4, 22.9, 22.6, 23.1, 23.3, 22.7, 22.5, 22.9),
}
_DISPLAY_NAMES = {"telecom": "电信", "mobile": "移动", "unicom": "联通"}
_LOSSES = {"telecom": 0.0, "mobile": 0.3, "unicom": 0.1}


def build_offline_fixture(
    *,
    now: datetime | None = None,
    phase: int | None = None,
) -> dict[str, list[dict[str, object]]]:
    """Build deterministic identity-free data for local visual acceptance."""

    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("offline preview time must be timezone-aware")
    current = current.astimezone(timezone.utc)
    shift = int(current.timestamp() // 15) if phase is None else phase

    wans: list[dict[str, object]] = []
    for wan_id in ("telecom", "mobile", "unicom"):
        source = _FIXTURE_SERIES[wan_id]
        offset = shift % len(source)
        trend = list(source[offset:] + source[:offset])
        wans.append(
            {
                "wanId": wan_id,
                "displayName": _DISPLAY_NAMES[wan_id],
                "status": "healthy",
                "latestLatencyMs": trend[-1],
                "packetLossSummary": _LOSSES[wan_id],
                "updatedAt": current.isoformat(timespec="seconds").replace("+00:00", "Z"),
                "stale": False,
                "trend": trend,
            }
        )
    return validate_public_summary({"wans": wans})


class OfflineFixtureReader:
    def __init__(self, clock: Callable[[], datetime] | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def read_public_summary(self) -> dict[str, list[dict[str, object]]]:
        return build_offline_fixture(now=self._clock())


def validate_preview_parent_origin(raw: str | None) -> str:
    """Allow only an exact loopback parent for local iframe acceptance."""

    if raw is None:
        return "'none'"
    scheme, host, port = validate_origin(
        raw,
        require_https=False,
        private_only=True,
    )
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise SecurityBoundaryError("preview parent origin must use loopback")
    authority_host = f"[{host}]" if ":" in host else host
    default_port = (scheme == "http" and port == 80) or (
        scheme == "https" and port == 443
    )
    return f"{scheme}://{authority_host}" + ("" if default_port else f":{port}")


def build_preview_server(
    *,
    port: int = 0,
    parent_origin: str | None = None,
) -> ThreadingHTTPServer:
    if not isinstance(port, int) or not 0 <= port <= 65_535:
        raise ValueError("preview port is invalid")
    dependencies = PublicDependencies(
        summary_reader=OfflineFixtureReader(),
        parent_origin=validate_preview_parent_origin(parent_origin),
        limiter=TokenBucketLimiter(requests_per_minute=30, burst=10),
        logger=SafeEventLogger(lambda _line: None),
    )
    server = ThreadingHTTPServer(
        ("127.0.0.1", port),
        make_public_handler(dependencies),
    )
    server.daemon_threads = True
    return server


def main() -> None:
    parser = argparse.ArgumentParser(
        description="loopback-only sanitized monitor fixture preview"
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument(
        "--parent-origin",
        help="exact loopback website origin for local iframe acceptance",
    )
    arguments = parser.parse_args()
    server = build_preview_server(
        port=arguments.port,
        parent_origin=arguments.parent_origin,
    )
    port = server.server_address[1]
    print(f"Offline fixture preview: http://127.0.0.1:{port}/?preview=fixture")
    print("演示数据 · 非报价；不会连接真实 FNOS。按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()

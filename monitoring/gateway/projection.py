"""Fail-closed projection from the private 3002 schema to public WAN data."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


WAN_ORDER = ("telecom", "mobile", "unicom")
WAN_NAMES = {
    "telecom": "电信",
    "mobile": "移动",
    "unicom": "联通",
}
STATUS_MAP = {
    "normal": "healthy",
    "warning": "degraded",
    "degraded": "degraded",
    "down": "unavailable",
    "stale": "stale",
}
PUBLIC_STATUSES = frozenset(
    ("healthy", "degraded", "unavailable", "no_data", "stale")
)
PUBLIC_WAN_FIELDS = frozenset(
    (
        "wanId",
        "displayName",
        "status",
        "latestLatencyMs",
        "packetLossSummary",
        "updatedAt",
        "stale",
        "trend",
    )
)
PUBLIC_REQUIRED_WAN_FIELDS = PUBLIC_WAN_FIELDS - {"latestLatencyMs"}
TREND_POINT_LIMIT = 14
STALE_AFTER_SECONDS = 180


class ProjectionError(ValueError):
    """The private payload cannot be safely projected."""


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProjectionError(f"invalid {label}")
    return value


def _finite_number(
    value: Any,
    label: str,
    *,
    minimum: float = 0,
    maximum: float = 60_000,
    nullable: bool = True,
) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProjectionError(f"invalid {label}")
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise ProjectionError(f"invalid {label}")
    return round(number, 2)


def _timestamp(value: Any, label: str, *, nullable: bool = True) -> datetime | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ProjectionError(f"invalid {label}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ProjectionError(f"invalid {label}") from exc
    if parsed.tzinfo is None:
        raise ProjectionError(f"invalid {label}")
    return parsed.astimezone(timezone.utc)


def _public_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _boolean_probe_success(value: Any) -> bool:
    if value is True or value == 1:
        return True
    if value is False or value == 0:
        return False
    raise ProjectionError("invalid probe success")


@dataclass(frozen=True)
class _WanLatencyWindow:
    trend: list[float | None]
    latest_timestamp: datetime | None
    latest_success: bool | None
    latest_latency_ms: float | None


def _latency_by_wan(raw_latency: Any) -> dict[str, _WanLatencyWindow]:
    latency = _mapping(raw_latency, "latency response")
    if (
        latency.get("range") != "6h"
        or latency.get("type") != "icmp"
        or latency.get("target") != "AliDNS"
    ):
        raise ProjectionError("latency response identity mismatch")
    samples = latency.get("samples")
    if not isinstance(samples, list) or len(samples) > 10_000:
        raise ProjectionError("invalid latency samples")

    output: dict[str, list[tuple[datetime, float | None]]] = {
        wan: [] for wan in WAN_ORDER
    }
    for raw_sample in samples:
        sample = _mapping(raw_sample, "latency sample")
        if sample.get("test_type") != "icmp" or sample.get("target_name") != "AliDNS":
            raise ProjectionError("latency sample identity mismatch")
        wan = sample.get("wan")
        if wan not in output:
            raise ProjectionError("invalid latency WAN")
        timestamp = _timestamp(sample.get("timestamp"), "latency timestamp", nullable=False)
        assert timestamp is not None
        success = _boolean_probe_success(sample.get("success"))
        latency_ms = _finite_number(sample.get("avg_ms"), "latency value")
        if success and latency_ms is None:
            raise ProjectionError("successful probe is missing latency")
        if not success:
            latency_ms = None
        output[wan].append((timestamp, latency_ms))

    windows: dict[str, _WanLatencyWindow] = {}
    for wan in WAN_ORDER:
        ordered = sorted(output[wan], key=lambda item: item[0])[-TREND_POINT_LIMIT:]
        latest = ordered[-1] if ordered else None
        windows[wan] = _WanLatencyWindow(
            trend=[value for _, value in ordered],
            latest_timestamp=latest[0] if latest else None,
            latest_success=latest[1] is not None if latest else None,
            latest_latency_ms=latest[1] if latest else None,
        )
    return windows


def project_public_summary(
    raw_overview: Any,
    raw_latency: Any,
    *,
    now: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Return only the frozen anonymous three-WAN allowlist.

    The existing private overview and latency payloads contain infrastructure
    identity. This function accepts those payloads, validates every value it
    consumes, and constructs a new object rather than deleting known-bad keys.
    """

    overview = _mapping(raw_overview, "overview")
    raw_wans = _mapping(overview.get("wans"), "overview WANs")
    if set(raw_wans) != set(WAN_ORDER):
        raise ProjectionError("overview must contain exactly three WANs")

    latency_windows = _latency_by_wan(raw_latency)
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    public_wans: list[dict[str, Any]] = []

    for wan in WAN_ORDER:
        raw_wan = _mapping(raw_wans[wan], f"{wan} overview")
        raw_status = raw_wan.get("status")
        if raw_status not in STATUS_MAP:
            raise ProjectionError(f"invalid {wan} status")

        # Validate the private overview timestamp, but derive public freshness
        # from the exact ICMP window rather than a possibly newer TCP sample.
        _timestamp(raw_wan.get("latest_timestamp"), f"{wan} overview timestamp")
        overview_latency_ms = _finite_number(
            raw_wan.get("current_ms"), f"{wan} latency"
        )
        loss_percent = _finite_number(
            raw_wan.get("alidns_loss_percent"),
            f"{wan} packet loss",
            maximum=100,
        )

        latency_window = latency_windows[wan]
        updated = latency_window.latest_timestamp
        if updated is None:
            if overview_latency_ms is not None:
                raise ProjectionError(f"{wan} has latency without timestamp")
            status = "no_data"
            stale = False
        else:
            age_seconds = (current_time - updated).total_seconds()
            if age_seconds < -300:
                raise ProjectionError(f"{wan} timestamp is in the future")
            stale = raw_status == "stale" or age_seconds > STALE_AFTER_SECONDS
            if stale:
                status = "stale"
            elif latency_window.latest_success is False:
                status = "unavailable"
            else:
                status = STATUS_MAP[raw_status]

        if latency_window.latest_success is True:
            if overview_latency_ms is None or latency_window.latest_latency_ms is None:
                raise ProjectionError(f"successful {wan} probe is missing current latency")
            if abs(overview_latency_ms - latency_window.latest_latency_ms) > 0.01:
                raise ProjectionError(f"{wan} current latency is inconsistent")
        elif overview_latency_ms is not None:
            raise ProjectionError(f"failed {wan} probe retained a current latency")

        current_metrics_allowed = status not in ("no_data", "stale")
        item: dict[str, Any] = {
            "wanId": wan,
            "displayName": WAN_NAMES[wan],
            "status": status,
            "packetLossSummary": loss_percent if current_metrics_allowed else None,
            "updatedAt": _public_timestamp(updated),
            "stale": stale,
            "trend": latency_window.trend if current_metrics_allowed else [],
        }
        # A failed latest probe must not inherit an older successful value.
        if not stale and latency_window.latest_latency_ms is not None:
            item["latestLatencyMs"] = latency_window.latest_latency_ms
        public_wans.append(item)

    result = {"wans": public_wans}
    validate_public_summary(result)
    return result


def validate_public_summary(payload: Any) -> dict[str, list[dict[str, Any]]]:
    """Validate the public contract again at every trust boundary."""

    root = _mapping(payload, "public summary")
    if set(root) != {"wans"} or not isinstance(root["wans"], list):
        raise ProjectionError("invalid public summary envelope")
    if len(root["wans"]) != len(WAN_ORDER):
        raise ProjectionError("public summary must contain exactly three WANs")

    seen: set[str] = set()
    for raw_item in root["wans"]:
        item = _mapping(raw_item, "public WAN")
        keys = set(item)
        if not PUBLIC_REQUIRED_WAN_FIELDS.issubset(keys) or not keys.issubset(
            PUBLIC_WAN_FIELDS
        ):
            raise ProjectionError("public WAN field allowlist violation")
        wan = item.get("wanId")
        if wan not in WAN_ORDER or wan in seen:
            raise ProjectionError("invalid public WAN id")
        seen.add(wan)
        if item.get("displayName") != WAN_NAMES[wan]:
            raise ProjectionError("invalid public WAN name")
        if item.get("status") not in PUBLIC_STATUSES:
            raise ProjectionError("invalid public WAN status")
        if not isinstance(item.get("stale"), bool):
            raise ProjectionError("invalid public stale flag")
        if item["stale"] != (item["status"] == "stale"):
            raise ProjectionError("inconsistent public stale state")

        updated = item.get("updatedAt")
        _timestamp(updated, "public update timestamp", nullable=True)
        if item["status"] == "no_data" and updated is not None:
            raise ProjectionError("no-data WAN cannot have an update timestamp")
        if item["status"] != "no_data" and updated is None:
            raise ProjectionError("current WAN is missing an update timestamp")
        _finite_number(
            item.get("packetLossSummary"),
            "public packet loss",
            maximum=100,
        )
        if "latestLatencyMs" in item:
            _finite_number(
                item["latestLatencyMs"],
                "public latest latency",
                nullable=False,
            )
            if item["status"] in ("no_data", "stale"):
                raise ProjectionError("non-current latency cannot be public")

        trend = item.get("trend")
        if not isinstance(trend, list) or len(trend) > TREND_POINT_LIMIT:
            raise ProjectionError("invalid public trend")
        for point in trend:
            _finite_number(point, "public trend point")
        if item["status"] in ("no_data", "stale") and (
            item.get("packetLossSummary") is not None or trend or "latestLatencyMs" in item
        ):
            raise ProjectionError("non-current public metrics must be empty")

    if seen != set(WAN_ORDER):
        raise ProjectionError("public WAN set mismatch")
    return root

"""Strict customer/admin projections for the Auth Service mTLS identity."""

from __future__ import annotations

from datetime import datetime
from typing import Any


TARGET_KEY_MAX_LENGTH = 128
TARGET_LABEL_MAX_LENGTH = 200
TARGET_STATES = frozenset(("active", "disabled", "retired"))
STATUS_VALUES = frozenset(("online", "offline", "stale"))
RAW_CATALOG_FIELDS = frozenset(
    (
        "target_name",
        "display_name",
        "target_host",
        "tcp_port",
        "collector_enabled",
        "customer_state",
        "has_data",
        "samples",
        "latest_timestamp",
    )
)
RAW_STATUS_FIELDS = frozenset(
    (
        "source",
        "source_status",
        "customer_state",
        "fresh",
        "updated_at",
        "snapshot_age_seconds",
        "target",
        "target_host",
        "item",
    )
)
RAW_STATUS_ITEM_FIELDS = frozenset(
    (
        "target_name",
        "target_host",
        "online",
        "uptime_seconds",
        "cpu_percent",
        "memory_percent",
        "storage_percent",
        "upload_bytes_per_second",
        "download_bytes_per_second",
        "last_active",
    )
)


class AuthProjectionError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _bounded_text(value: Any, limit: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value.strip() != value
        or len(value) > limit
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise AuthProjectionError("monitor_invalid_response")
    return value


def _utc_second(value: Any) -> str:
    if not isinstance(value, str) or not value.endswith("Z") or "." in value:
        raise AuthProjectionError("monitor_invalid_response")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AuthProjectionError("monitor_invalid_response") from exc
    if parsed.tzinfo is None or parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != value:
        raise AuthProjectionError("monitor_invalid_response")
    return value


def _raw_timestamp(value: Any) -> str:
    timestamp = _bounded_text(value, 64)
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AuthProjectionError("monitor_invalid_response") from exc
    if parsed.tzinfo is None:
        raise AuthProjectionError("monitor_invalid_response")
    return timestamp


def _optional_number(value: Any) -> bool:
    return value is None or (
        isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
    )


def project_target_catalog(payload: Any) -> tuple[dict[str, str], ...]:
    if not isinstance(payload, dict) or set(payload) != {"targets"}:
        raise AuthProjectionError("monitor_invalid_response")
    targets = payload["targets"]
    if not isinstance(targets, list) or len(targets) > 100:
        raise AuthProjectionError("monitor_invalid_response")

    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for raw_target in targets:
        if not isinstance(raw_target, dict) or set(raw_target) != RAW_CATALOG_FIELDS:
            raise AuthProjectionError("monitor_invalid_response")
        key = _bounded_text(raw_target.get("target_name"), TARGET_KEY_MAX_LENGTH)
        label = _bounded_text(
            raw_target.get("display_name"), TARGET_LABEL_MAX_LENGTH
        )
        _bounded_text(raw_target.get("target_host"), 255)
        state = raw_target.get("customer_state")
        tcp_port = raw_target.get("tcp_port")
        has_data = raw_target.get("has_data")
        samples = raw_target.get("samples")
        latest_timestamp = raw_target.get("latest_timestamp")
        if (
            state not in TARGET_STATES
            or key in seen
            or not (
                tcp_port is None
                or (
                    isinstance(tcp_port, int)
                    and not isinstance(tcp_port, bool)
                    and 1 <= tcp_port <= 65535
                )
            )
            or not isinstance(has_data, bool)
            or not isinstance(samples, int)
            or isinstance(samples, bool)
            or samples < 0
            or not (
                latest_timestamp is None
                or _raw_timestamp(latest_timestamp) == latest_timestamp
            )
            or (has_data and (samples < 1 or latest_timestamp is None))
            or (not has_data and (samples != 0 or latest_timestamp is not None))
        ):
            raise AuthProjectionError("monitor_invalid_response")
        if not isinstance(raw_target.get("collector_enabled"), bool):
            raise AuthProjectionError("monitor_invalid_response")
        seen.add(key)
        result.append({"key": key, "label": label, "state": state})
    return tuple(result)


def require_assignable_target(
    catalog: tuple[dict[str, str], ...], target: str
) -> dict[str, str]:
    selected = next((item for item in catalog if item["key"] == target), None)
    if selected is None:
        raise AuthProjectionError("target_not_found")
    if selected["state"] != "active":
        raise AuthProjectionError("target_unavailable")
    return selected


def project_target_status(payload: Any, expected_target: str) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != RAW_STATUS_FIELDS:
        raise AuthProjectionError("monitor_invalid_response")
    if payload.get("source") != "nezha-public" or payload.get("target") != expected_target:
        raise AuthProjectionError("monitor_invalid_response")
    if payload.get("customer_state") != "active":
        raise AuthProjectionError("target_unavailable")
    target_host = _bounded_text(payload.get("target_host"), 255)

    source_status = payload.get("source_status")
    fresh = payload.get("fresh")
    item = payload.get("item")
    age = payload.get("snapshot_age_seconds")
    if not isinstance(fresh, bool) or not _optional_number(age):
        raise AuthProjectionError("monitor_invalid_response")
    if source_status in ("connecting", "not_connected") and item is None:
        raise AuthProjectionError("monitor_unavailable")
    if (
        not isinstance(item, dict)
        or set(item) != RAW_STATUS_ITEM_FIELDS
        or item.get("target_name") != expected_target
        or item.get("target_host") != target_host
    ):
        raise AuthProjectionError("monitor_invalid_response")
    online = item.get("online")
    if (
        not isinstance(online, bool)
        or not all(
            _optional_number(item.get(field))
            for field in (
                "uptime_seconds",
                "cpu_percent",
                "memory_percent",
                "storage_percent",
                "upload_bytes_per_second",
                "download_bytes_per_second",
            )
        )
        or not (
            item.get("last_active") is None
            or _raw_timestamp(item.get("last_active")) == item.get("last_active")
        )
    ):
        raise AuthProjectionError("monitor_invalid_response")
    updated_at = _utc_second(payload.get("updated_at"))

    if source_status == "ok" and fresh is True:
        status = "online" if online else "offline"
        return {"status": status, "updatedAt": updated_at, "stale": False}
    if source_status == "stale" and fresh is False:
        return {"status": "stale", "updatedAt": updated_at, "stale": True}
    raise AuthProjectionError("monitor_invalid_response")


def validate_private_status(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {
        "status",
        "updatedAt",
        "stale",
    }:
        raise AuthProjectionError("monitor_invalid_response")
    status = payload["status"]
    stale = payload["stale"]
    updated_at = _utc_second(payload["updatedAt"])
    if (
        status not in STATUS_VALUES
        or not isinstance(stale, bool)
        or (status == "stale") != stale
    ):
        raise AuthProjectionError("monitor_invalid_response")
    return {"status": status, "updatedAt": updated_at, "stale": stale}

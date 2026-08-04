#!/usr/bin/env python3
from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Callable
from zoneinfo import ZoneInfo

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from routes.core import (  # type: ignore
        NonBlockingLock, RouteConfigError, RouteExecutionError, RouteStore,
        RouteTask, RunResult, append_event, atomic_write, in_blackout,
        decode_nexttrace_json, eligible_outbound_targets, load_config,
        normalize_nexttrace, return_tasks, run_task, target_by_name,
    )
else:
    from .core import (
        NonBlockingLock, RouteConfigError, RouteExecutionError, RouteStore,
        RouteTask, RunResult, append_event, atomic_write, in_blackout,
        decode_nexttrace_json, eligible_outbound_targets, load_config,
        normalize_nexttrace, return_tasks, run_task, target_by_name,
    )


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "routes.json"
FORCED_COMMAND = "ingest-route-bundle"
DEFAULT_MAX_BUNDLE_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_RECORD_BYTES = 1024 * 1024
BUNDLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
WAN_ORDER = ("telecom", "mobile", "unicom")


class BundleValidationError(ValueError):
    pass


@dataclass(frozen=True)
class BundleRecord:
    bundle_id: str
    sequence: int
    record_type: str
    timestamp: str
    wan: str
    device: str
    source_ip: str
    protocol: str
    target: str
    target_name: str
    exit_code: int
    duration_ms: int
    stdout: str
    stderr: str


RECORD_FIELDS = {
    "schema_version", "bundle_id", "sequence", "record_type", "timestamp",
    "wan", "device", "source_ip", "protocol", "target", "target_name",
    "exit_code", "duration_ms", "stdout_b64", "stderr_b64",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_limited(stream: BinaryIO, limit: int) -> bytes:
    if limit < 1:
        raise BundleValidationError("invalid_bundle_size_limit")
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise BundleValidationError("bundle_size_limit_exceeded")
    if not data:
        raise BundleValidationError("empty_bundle")
    return data


def _decode_text(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise BundleValidationError(f"{field}_must_be_base64_string")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BundleValidationError(f"invalid_{field}_base64") from exc
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BundleValidationError(f"invalid_{field}_utf8") from exc


def _canonical_timestamp(value: Any) -> str:
    if not isinstance(value, str):
        raise BundleValidationError("invalid_timestamp")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise BundleValidationError("invalid_timestamp") from exc
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")


def _expected_layout(config: dict[str, Any]) -> list[tuple[str, str, str, str | None]]:
    layout = [("public_ip", wan, "metadata", None) for wan in WAN_ORDER]
    for target in eligible_outbound_targets(config):
        for wan in WAN_ORDER:
            for protocol in config["outbound"]["protocols"]:
                layout.append(("outbound_route", wan, protocol, target["name"]))
    return layout


def _legacy_expected_layout(config: dict[str, Any]) -> list[tuple[str, str, str, str | None]]:
    """The deployed pre-expansion R5S sends 3 metadata + 6 DMIT records.

    Keeping this strict layout lets the receiver be deployed first. The old
    sender remains accepted during that bounded migration window; arbitrary
    record counts, orderings and targets remain rejected.
    """
    target_name = config["outbound"]["legacy_target"]
    layout = [("public_ip", wan, "metadata", None) for wan in WAN_ORDER]
    for wan in WAN_ORDER:
        for protocol in config["outbound"]["protocols"]:
            layout.append(("outbound_route", wan, protocol, target_name))
    return layout


def parse_bundle(data: bytes, config: dict[str, Any]) -> list[BundleRecord]:
    max_record = int(config.get("r5s_push", {}).get("max_record_bytes", DEFAULT_MAX_RECORD_BYTES))
    lines = data.splitlines()
    current = _expected_layout(config)
    legacy = _legacy_expected_layout(config)
    if len(lines) == len(current):
        expected = current
    elif config["r5s_push"].get("accept_legacy_bundle") and len(lines) == len(legacy):
        expected = legacy
    else:
        raise BundleValidationError(f"record_count_mismatch:{len(lines)}")
    records: list[BundleRecord] = []
    bundle_id: str | None = None
    for index, (line, layout) in enumerate(zip(lines, expected, strict=True), 1):
        if len(line) > max_record:
            raise BundleValidationError(f"record_size_limit_exceeded:{index}")
        try:
            item = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BundleValidationError(f"invalid_json_record:{index}") from exc
        if not isinstance(item, dict) or set(item) != RECORD_FIELDS:
            raise BundleValidationError(f"record_fields_mismatch:{index}")
        if item.get("schema_version") != 1:
            raise BundleValidationError(f"unsupported_record_schema:{index}")
        current_id = item.get("bundle_id")
        if not isinstance(current_id, str) or not BUNDLE_ID_RE.fullmatch(current_id):
            raise BundleValidationError(f"invalid_bundle_id:{index}")
        if bundle_id is None:
            bundle_id = current_id
        elif bundle_id != current_id:
            raise BundleValidationError(f"mixed_bundle_ids:{index}")
        if type(item.get("sequence")) is not int or item["sequence"] != index:
            raise BundleValidationError(f"invalid_sequence:{index}")

        record_type, wan, protocol, expected_target_name = layout
        if (item.get("record_type"), item.get("wan"), item.get("protocol")) != layout[:3]:
            raise BundleValidationError(f"record_order_mismatch:{index}")
        binding = config["wans"][wan]
        if item.get("device") != binding["interface"] or item.get("source_ip") != binding["source_ip"]:
            raise BundleValidationError(f"wan_binding_mismatch:{index}")
        if record_type == "public_ip":
            if item.get("target") != config["public_ip"]["endpoint"] or item.get("target_name") != "public-ip":
                raise BundleValidationError(f"public_ip_target_mismatch:{index}")
        else:
            target = target_by_name(config, str(expected_target_name))
            if item.get("target") != target["host"] or item.get("target_name") != target["name"]:
                raise BundleValidationError(f"outbound_target_mismatch:{index}")

        exit_code = item.get("exit_code")
        duration_ms = item.get("duration_ms")
        if type(exit_code) is not int or not 0 <= exit_code <= 255:
            raise BundleValidationError(f"invalid_exit_code:{index}")
        if type(duration_ms) is not int or not 0 <= duration_ms <= 120_000:
            raise BundleValidationError(f"invalid_duration:{index}")
        records.append(BundleRecord(
            bundle_id=current_id,
            sequence=index,
            record_type=record_type,
            timestamp=_canonical_timestamp(item.get("timestamp")),
            wan=wan,
            device=binding["interface"],
            source_ip=binding["source_ip"],
            protocol=protocol,
            target=item["target"],
            target_name=item["target_name"],
            exit_code=exit_code,
            duration_ms=duration_ms,
            stdout=_decode_text(item.get("stdout_b64"), "stdout"),
            stderr=_decode_text(item.get("stderr_b64"), "stderr"),
        ))
    return records


def _public_ip(record: BundleRecord) -> tuple[str | None, str | None]:
    if record.exit_code != 0:
        return None, f"public_ip_exit_{record.exit_code}"
    try:
        payload = json.loads(record.stdout)
        if not isinstance(payload, dict):
            raise ValueError("payload_not_object")
        if (
            payload.get("wan") != record.wan
            or payload.get("source_ip") != record.source_ip
            or payload.get("interface") != record.device
        ):
            raise ValueError("binding_mismatch")
        address = ipaddress.ip_address(payload.get("public_ip", ""))
        if address.version != 4 or not address.is_global:
            raise ValueError("not_global_ipv4")
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        return None, f"invalid_public_ip_payload:{exc}"
    return str(address), None


def _outbound_task(record: BundleRecord, config: dict[str, Any]) -> RouteTask:
    return RouteTask(
        wan=record.wan,
        direction="outbound",
        protocol=record.protocol,
        source=record.source_ip,
        target=record.target,
        target_name=record.target_name,
        device=record.device,
        source_ip=record.source_ip,
        runner="r5s-local",
        ssh_host="",
        ssh_port=None,
        ssh_user=None,
        ssh_key="",
        nexttrace_binary=config["nexttrace"]["binary"],
    )


def _outbound_result(record: BundleRecord, config: dict[str, Any]) -> RunResult:
    payload = None
    error = None
    if record.exit_code != 0:
        error = f"nexttrace_exit_{record.exit_code}"
    else:
        try:
            payload = decode_nexttrace_json(record.stdout)
        except (json.JSONDecodeError, ValueError):
            error = "invalid_nexttrace_json"
        if payload is not None:
            premium = config.get("premium_detection", {})
            premium_asns = set(premium.get("asns", [])) if premium.get("approved") else set()
            if not normalize_nexttrace(payload, _outbound_task(record, config), premium_asns)["completed"]:
                error = "target_not_reached"
    return RunResult(
        timestamp=record.timestamp,
        completed=error is None,
        exit_code=record.exit_code,
        raw_stdout=record.stdout,
        raw_stderr=record.stderr,
        payload=payload,
        error=error,
    )


def _archive_bundle(data: bytes, bundle_id: str, config: dict[str, Any]) -> Path:
    local_date = datetime.now(timezone.utc).astimezone(
        ZoneInfo(config["timezone"])
    ).strftime("%Y-%m-%d")
    directory = Path(config["paths"]["route_logs"]) / "incoming" / local_date
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{bundle_id}.jsonl"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise BundleValidationError("duplicate_bundle") from exc
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path


def ingest_execution_blockers(config: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not config.get("deployment_enabled"):
        blockers.append("deployment_enabled=false")
    if not config["nexttrace"].get("data_provider_approved"):
        blockers.append("nexttrace.data_provider_approved=false")
    if not config["public_ip"].get("provider_approved"):
        blockers.append("public_ip.provider_approved=false")
    known_hosts: set[Path] = set()
    for target in config["vps_targets"]:
        if not target.get("return_enabled"):
            continue
        if target.get("authorization_status") != "confirmed":
            blockers.append(f"{target['name']}.authorization_status={target.get('authorization_status')}")
        key = Path(str(target.get("ssh_key") or ""))
        if not key.is_file():
            blockers.append(f"{target['name']}.ssh_key=file_missing")
        elif key not in known_hosts:
            known_hosts.add(key)
            if not key.with_name("known_hosts").is_file():
                blockers.append("ssh.known_hosts=file_missing")
    return blockers


def process_bundle(
    data: bytes,
    config: dict[str, Any],
    executor: Callable[[RouteTask, dict[str, Any]], RunResult] = run_task,
) -> dict[str, Any]:
    records = parse_bundle(data, config)
    current_record_count = len(_expected_layout(config))
    bundle_layout = "multi-target-v1" if len(records) == current_record_count else "legacy-dmit-v1"
    bundle_id = records[0].bundle_id
    paths = config["paths"]
    store = RouteStore(Path(paths["database"]), Path(paths["route_logs"]))
    store.ensure_schema()
    counts = {
        "public_ip_ok": 0,
        "public_ip_failed": 0,
        "outbound_completed": 0,
        "outbound_failed": 0,
        "return_completed": 0,
        "return_target_not_reached": 0,
        "return_failed": 0,
        "return_not_executed_blackout": 0,
    }

    with NonBlockingLock(Path(paths["lock_file"])):
        if in_blackout(config):
            raise RouteExecutionError("blocked_blackout")
        incoming_path = _archive_bundle(data, bundle_id, config)

        public_ips: dict[str, str] = {}
        public_ip_errors: dict[str, str] = {}
        for record in records[:3]:
            address, error = _public_ip(record)
            if address:
                public_ips[record.wan] = address
                counts["public_ip_ok"] += 1
            else:
                public_ip_errors[record.wan] = error or "public_ip_failed"
                counts["public_ip_failed"] += 1
        atomic_write(
            Path(paths["public_ip_file"]),
            json.dumps({
                "timestamp": utc_now(),
                "bundle_id": bundle_id,
                "wans": public_ips,
                "errors": public_ip_errors,
            }, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

        for record in records[3:]:
            result = _outbound_result(record, config)
            store.persist(_outbound_task(record, config), result, config)
            counts["outbound_completed" if result.completed else "outbound_failed"] += 1

        return_items = return_tasks(config, public_ips)
        for index, task in enumerate(return_items):
            if in_blackout(config):
                counts["return_not_executed_blackout"] = len(return_items) - index
                append_event(Path(paths["event_log"]), {
                    "timestamp": utc_now(),
                    "bundle_id": bundle_id,
                    "status": "blocked_blackout_midrun",
                    "remaining_returns": len(return_items) - index,
                })
                break
            result = executor(task, config)
            store.persist(task, result, config)
            if result.completed:
                counts["return_completed"] += 1
            elif result.error == "target_not_reached":
                # A remote endpoint may filter the final probe while still
                # returning a usable route.  Preserve that truthful sample,
                # but do not turn an expected endpoint behaviour into a
                # collector/transport failure.
                counts["return_target_not_reached"] += 1
            else:
                counts["return_failed"] += 1

        event = {
            "timestamp": utc_now(),
            "bundle_id": bundle_id,
            "status": "finished",
            "incoming_file": str(incoming_path),
            "bundle_layout": bundle_layout,
            "counts": counts,
        }
        append_event(Path(paths["event_log"]), event)
        return event


def main() -> int:
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if command != FORCED_COMMAND:
        print(json.dumps({"status": "rejected", "reason": "forced_command_mismatch"}))
        return 64
    try:
        config = load_config(DEFAULT_CONFIG)
        blockers = ingest_execution_blockers(config)
        if blockers:
            print(json.dumps({"status": "blocked", "reasons": blockers}, ensure_ascii=False))
            return 78
        if in_blackout(config):
            print(json.dumps({"status": "blocked_blackout"}, ensure_ascii=False))
            return 78
        limit = int(config.get("r5s_push", {}).get("max_bundle_bytes", DEFAULT_MAX_BUNDLE_BYTES))
        data = read_limited(sys.stdin.buffer, limit)
        result = process_bundle(data, config)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        counts = result["counts"]
        return 0 if not (
            counts["outbound_failed"]
            or counts["return_failed"]
            or counts["return_not_executed_blackout"]
        ) else 2
    except (BundleValidationError, RouteConfigError, RouteExecutionError, OSError, sqlite3.Error) as exc:
        try:
            config
        except UnboundLocalError:
            config = None
        if config:
            append_event(Path(config["paths"]["event_log"]), {
                "timestamp": utc_now(),
                "status": "ingest_rejected",
                "error": type(exc).__name__,
                "detail": str(exc),
            })
        print(json.dumps({
            "status": "rejected",
            "error": type(exc).__name__,
            "detail": str(exc),
        }, ensure_ascii=False, separators=(",", ":")))
        return 65


if __name__ == "__main__":
    raise SystemExit(main())

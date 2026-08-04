#!/usr/bin/env python3
from __future__ import annotations

import fcntl
import ipaddress
import json
import os
import re
import secrets
import shlex
import sqlite3
import subprocess
import tempfile
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


ALLOWED_PROTOCOLS = {"icmp", "tcp"}
EXPECTED_ROUTE_COLUMNS = {
    "id", "timestamp", "wan", "direction", "protocol", "source", "target",
    "final_latency_ms", "hop_count", "completed", "raw_file", "error",
}


class RouteConfigError(ValueError):
    pass


class RouteExecutionError(RuntimeError):
    pass


@dataclass(frozen=True)
class RouteTask:
    wan: str
    direction: str
    protocol: str
    source: str
    target: str
    target_name: str
    device: str
    source_ip: str
    runner: str
    ssh_host: str
    ssh_port: int | None
    ssh_user: str | None
    ssh_key: str
    nexttrace_binary: str
    ready: bool = True
    blocked_reason: str | None = None


@dataclass(frozen=True)
class RunResult:
    timestamp: str
    completed: bool
    exit_code: int
    raw_stdout: str
    raw_stderr: str
    payload: Any | None
    error: str | None


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    validate_config(config)
    return config


def validate_config(config: dict[str, Any]) -> None:
    if config.get("schema_version") != 1:
        raise RouteConfigError("unsupported routes config schema")
    wans = config.get("wans")
    if not isinstance(wans, dict) or set(wans) != {"telecom", "mobile", "unicom"}:
        raise RouteConfigError("exactly three known WAN bindings are required")
    seen_hosts: set[str] = set()
    targets = config.get("vps_targets")
    if not isinstance(targets, list) or len(targets) != 7:
        raise RouteConfigError("exactly seven non-Alibaba VPS targets are required")
    for target in targets:
        if "alibaba" in str(target.get("name", "")).lower():
            raise RouteConfigError("Alibaba must not be present in route targets")
        host = str(ipaddress.ip_address(target["host"]))
        if host in seen_hosts:
            raise RouteConfigError("duplicate VPS host")
        seen_hosts.add(host)
        if type(target.get("return_enabled")) is not bool:
            raise RouteConfigError("VPS return_enabled must be boolean")
    outbound = config.get("outbound", {})
    if outbound.get("target_selector") != "return_enabled_confirmed":
        raise RouteConfigError("daily outbound target selector must be return_enabled_confirmed")
    legacy_target = outbound.get("legacy_target")
    if legacy_target != "DMIT Premium":
        raise RouteConfigError("legacy outbound target must remain DMIT Premium during migration")
    if not any(target.get("name") == legacy_target for target in targets):
        raise RouteConfigError("legacy outbound target is missing")
    protocols = outbound.get("protocols")
    if protocols != ["icmp", "tcp"]:
        raise RouteConfigError("daily outbound protocols must be ICMP then TCP")
    if not eligible_outbound_targets(config):
        raise RouteConfigError("at least one return-enabled confirmed outbound target is required")
    return_protocols = config.get("return", {}).get("protocols", [])
    if not return_protocols or not set(return_protocols).issubset(ALLOWED_PROTOCOLS):
        raise RouteConfigError("invalid return protocols")
    push = config.get("r5s_push", {})
    if push.get("architecture") != "r5s-local-push-v1":
        raise RouteConfigError("unsupported R5S push architecture")
    if push.get("forced_command") != "ingest-route-bundle":
        raise RouteConfigError("unexpected R5S push forced command")
    for key in ("ssh_host", "ssh_port", "ssh_user", "ssh_key", "known_hosts"):
        if not push.get(key):
            raise RouteConfigError(f"r5s_push.{key} is required")
    if not 1024 <= int(push.get("max_bundle_bytes", 0)) <= 8 * 1024 * 1024:
        raise RouteConfigError("R5S push bundle limit is outside the safe range")
    if not 1024 <= int(push.get("max_record_bytes", 0)) <= int(push["max_bundle_bytes"]):
        raise RouteConfigError("R5S push record limit is outside the safe range")
    if type(push.get("accept_legacy_bundle")) is not bool:
        raise RouteConfigError("r5s_push.accept_legacy_bundle must be boolean")
    parse_hhmm(config["schedule"]["blackout_start"])
    parse_hhmm(config["schedule"]["blackout_end"])


def parse_hhmm(value: str) -> time:
    try:
        hour, minute = (int(part) for part in value.split(":"))
        return time(hour, minute)
    except (TypeError, ValueError) as exc:
        raise RouteConfigError(f"invalid HH:MM value: {value!r}") from exc


def in_blackout(config: dict[str, Any], when: datetime | None = None) -> bool:
    tz = ZoneInfo(config["timezone"])
    local = (when or datetime.now(tz)).astimezone(tz)
    current = local.time().replace(second=0, microsecond=0)
    start = parse_hhmm(config["schedule"]["blackout_start"])
    end = parse_hhmm(config["schedule"]["blackout_end"])
    if start <= end:
        return start <= current <= end
    return current >= start or current <= end


def target_by_name(config: dict[str, Any], name: str) -> dict[str, Any]:
    for target in config["vps_targets"]:
        if target["name"] == name:
            return target
    raise RouteConfigError(f"unknown target: {name}")


def eligible_outbound_targets(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the configured, ordered and explicitly authorized outbound set."""
    return [
        target for target in config["vps_targets"]
        if target.get("return_enabled")
        and target.get("authorization_status") == "confirmed"
    ]


def outbound_tasks(config: dict[str, Any]) -> list[RouteTask]:
    tasks = []
    for target in eligible_outbound_targets(config):
        for wan, binding in config["wans"].items():
            for protocol in config["outbound"]["protocols"]:
                tasks.append(RouteTask(
                    wan=wan,
                    direction="outbound",
                    protocol=protocol,
                    source=binding["source_ip"],
                    target=target["host"],
                    target_name=target["name"],
                    device=binding["interface"],
                    source_ip=binding["source_ip"],
                    runner="r5s-local",
                    ssh_host="",
                    ssh_port=None,
                    ssh_user=None,
                    ssh_key="",
                    nexttrace_binary=config["nexttrace"]["binary"],
                ))
    return tasks


def return_tasks(config: dict[str, Any], public_ips: dict[str, str]) -> list[RouteTask]:
    tasks = []
    for target in config["vps_targets"]:
        if not target.get("return_enabled"):
            continue
        missing = [key for key in ("ssh_port", "ssh_user", "ssh_key") if not target.get(key)]
        if target.get("authorization_status") != "confirmed":
            missing.append(target.get("authorization_status") or "auth_pending")
        for wan in config["wans"]:
            public_ip = public_ips.get(wan)
            reason_parts = list(missing)
            if not public_ip:
                reason_parts.append("public_ip_missing")
                public_ip = "0.0.0.0"
            else:
                public_ip = str(ipaddress.ip_address(public_ip))
            for protocol in config["return"]["protocols"]:
                tasks.append(RouteTask(
                    wan=wan,
                    direction="return",
                    protocol=protocol,
                    source=target["host"],
                    target=public_ip,
                    target_name=target["name"],
                    device=target.get("return_interface") or "",
                    source_ip=target.get("return_source_ip") or "",
                    runner="vps",
                    ssh_host=target["ssh_host"],
                    ssh_port=int(target["ssh_port"]) if target.get("ssh_port") else None,
                    ssh_user=target.get("ssh_user"),
                    ssh_key=target["ssh_key"],
                    nexttrace_binary=target["nexttrace_binary"],
                    ready=not reason_parts,
                    blocked_reason=",".join(reason_parts) or None,
                ))
    return tasks


def nexttrace_argv(task: RouteTask, config: dict[str, Any]) -> list[str]:
    if task.protocol not in ALLOWED_PROTOCOLS:
        raise RouteConfigError("invalid protocol")
    if not task.device or not task.source_ip:
        raise RouteConfigError("both device and source address are mandatory")
    ipaddress.ip_address(task.source_ip)
    ipaddress.ip_address(task.target)
    nt = config["nexttrace"]
    argv = [
        task.nexttrace_binary,
        "--ipv4",
        "--dev", task.device,
        "--source", task.source_ip,
        "--queries", str(nt["queries"]),
        "--max-hops", str(nt["max_hops"]),
        "--parallel-requests", str(nt["parallel_requests"]),
        "--timeout", str(nt["probe_timeout_ms"]),
        "--json",
        "--no-color",
    ]
    if nt.get("data_provider"):
        if not nt.get("data_provider_approved"):
            raise RouteConfigError("NextTrace data provider is not approved")
        argv += ["--data-provider", nt["data_provider"], "--language", "cn"]
    if task.protocol == "tcp":
        argv += ["--tcp", "--port", str(nt["tcp_port"])]
    argv.append(task.target)
    return argv


def ssh_argv(task: RouteTask, remote_argv: Iterable[str]) -> list[str]:
    if not task.ssh_user or not task.ssh_port:
        raise RouteConfigError("SSH user and port are required")
    destination = f"{task.ssh_user}@{task.ssh_host}"
    command = " ".join(shlex.quote(part) for part in remote_argv)
    known_hosts = str(Path(task.ssh_key).with_name("known_hosts"))
    return [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
        "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
        "-i", task.ssh_key, "-p", str(task.ssh_port),
        destination, command,
    ]


def route_probe_argv(task: RouteTask, config: dict[str, Any]) -> list[str]:
    if task.runner == "r5s-local":
        raise RouteConfigError("R5S outbound probes must run through local run_and_push.sh")
    remote = ["route-return", task.protocol, task.target]
    if task.protocol == "tcp":
        remote.append(str(config["nexttrace"]["tcp_port"]))
    return ssh_argv(task, remote)


def run_task(task: RouteTask, config: dict[str, Any]) -> RunResult:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not task.ready:
        return RunResult(timestamp, False, 78, "", "", None, task.blocked_reason or "task_not_ready")
    try:
        argv = route_probe_argv(task, config)
    except (RouteConfigError, ValueError) as exc:
        return RunResult(timestamp, False, 78, "", "", None, str(exc))
    timeout_seconds = int(config["nexttrace"]["process_timeout_seconds"]) + 15
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            env={**os.environ, "LC_ALL": "C.UTF-8"},
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode("utf-8", "replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        return RunResult(timestamp, False, 124, stdout, stderr, None, "process_timeout")
    except OSError as exc:
        return RunResult(timestamp, False, 127, "", "", None, f"process_start_failed_{exc.errno or 'unknown'}")
    payload = None
    parse_error = None
    try:
        payload = decode_nexttrace_json(completed.stdout)
    except (json.JSONDecodeError, ValueError):
        parse_error = "invalid_nexttrace_json"
    error = None
    if completed.returncode != 0:
        error = f"nexttrace_exit_{completed.returncode}"
    elif parse_error:
        error = parse_error
    elif payload is not None:
        premium = config.get("premium_detection", {})
        premium_asns = set(premium.get("asns", [])) if premium.get("approved") else set()
        if not normalize_nexttrace(payload, task, premium_asns).get("completed"):
            error = "target_not_reached"
    return RunResult(
        timestamp=timestamp,
        completed=error is None,
        exit_code=completed.returncode,
        raw_stdout=completed.stdout,
        raw_stderr=completed.stderr,
        payload=payload,
        error=error,
    )


def decode_nexttrace_json(output: str) -> Any:
    """Decode a complete NextTrace JSON document after an optional notice line."""
    candidate = output.strip()
    if not candidate:
        raise ValueError("empty NextTrace output")
    decoder = json.JSONDecoder()
    offsets = [0]
    offsets.extend(match.start() for match in re.finditer(r"(?m)^[ \t]*[\[{]", candidate) if match.start())
    for offset in offsets:
        document = candidate[offset:].lstrip()
        try:
            payload, end = decoder.raw_decode(document)
        except json.JSONDecodeError:
            continue
        if not document[end:].strip():
            return payload
    raise ValueError("NextTrace JSON document missing or has trailing data")


def _lookup(mapping: dict[str, Any], *keys: str) -> Any:
    lowered = {str(key).lower(): value for key, value in mapping.items()}
    for key in keys:
        if key.lower() in lowered:
            return lowered[key.lower()]
    return None


def _numeric(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:\.\d+)?", value)
        return float(match.group()) if match else None
    if isinstance(value, list):
        values = [item for item in (_numeric(item) for item in value) if item is not None]
        return sum(values) / len(values) if values else None
    if isinstance(value, dict):
        return _numeric(_lookup(value, "avg", "average", "rtt", "latency"))
    return None


def _hop_groups(payload: Any) -> list[list[dict[str, Any]]]:
    """Return one probe-node group per TTL.

    NextTrace 1.5 emits ``Hops`` as ``list[list[dict]]`` (normally three
    probe nodes for each TTL). Older builds and fixtures may emit one dict per
    TTL, so those dicts are wrapped as single-node groups.
    """
    if isinstance(payload, list):
        groups: list[list[dict[str, Any]]] = []
        for item in payload:
            if isinstance(item, dict):
                groups.append([item])
            elif isinstance(item, list):
                nodes = [node for node in item if isinstance(node, dict)]
                if nodes:
                    groups.append(nodes)
        return groups
    if not isinstance(payload, dict):
        return []
    for key in ("hops", "trace", "route", "results"):
        value = _lookup(payload, key)
        nested = _hop_groups(value)
        if nested:
            return nested
    for value in payload.values():
        nested = _hop_groups(value)
        if nested:
            return nested
    return []


def _node_address(raw: dict[str, Any]) -> tuple[Any, Any]:
    address = _lookup(raw, "address", "ip", "host")
    if isinstance(address, dict):
        return (
            _lookup(address, "ip", "address"),
            _lookup(address, "hostname", "host", "ptr", "rdns")
            or _lookup(raw, "hostname", "ptr", "rdns", "reverse"),
        )
    return address, _lookup(raw, "hostname", "ptr", "rdns", "reverse")


def _node_latency_ms(raw: dict[str, Any]) -> float | None:
    # NextTrace 1.5 serializes time.Duration RTT as integer nanoseconds.
    rtt = _lookup(raw, "rtt")
    if rtt is not None:
        value = _numeric(rtt)
        return value / 1_000_000 if value is not None else None
    return _numeric(_lookup(raw, "avg_ms", "avg", "latency", "elapsed"))


def normalize_nexttrace(payload: Any, task: RouteTask, premium_asns: set[int] | None = None) -> dict[str, Any]:
    premium_asns = premium_asns or set()
    hops = []
    for index, group in enumerate(_hop_groups(payload), 1):
        responding = []
        for node in group:
            ip, reverse = _node_address(node)
            if ip not in (None, "", "*"):
                responding.append((node, ip, reverse))
        raw, ip, reverse = responding[0] if responding else (group[0], None, None)
        if ip not in (None, "", "*"):
            # NextTrace frequently places Hostname on the second or third probe
            # for a TTL. Keep the first address as the displayed hop, but merge
            # rDNS from any probe that reports the same address.
            reverse = next((
                candidate_reverse
                for _, candidate_ip, candidate_reverse in responding
                if str(candidate_ip) == str(ip) and candidate_reverse
            ), reverse)
        geo = _lookup(raw, "geo", "location")
        geo = geo if isinstance(geo, dict) else {}
        asn_value = _lookup(raw, "asn", "asnumber") or _lookup(geo, "asn", "asnumber")
        asn_number = None
        if asn_value is not None:
            match = re.search(r"\d+", str(asn_value))
            asn_number = int(match.group()) if match else None
        location = " ".join(
            str(value) for value in (
                _lookup(geo, "country"), _lookup(geo, "prov", "province"),
                _lookup(geo, "city"), _lookup(geo, "district"),
            ) if value
        ) or None
        latency_values = [
            latency for latency in (_node_latency_ms(node) for node, _, _ in responding)
            if latency is not None and latency >= 0
        ]
        latency = sum(latency_values) / len(latency_values) if latency_values else None
        ttl = next(
            (_lookup(node, "ttl", "hop", "id") for node in group if _lookup(node, "ttl", "hop", "id") is not None),
            index,
        )
        ttl_number = int(_numeric(ttl) or index)
        owner = _lookup(raw, "owner", "isp", "org", "carrier") or _lookup(geo, "owner", "isp", "org")
        hops.append({
            "hop": ttl_number,
            "ip": str(ip) if ip not in (None, "", "*") else None,
            "latency_ms": round(latency, 3) if latency is not None else None,
            "location": location,
            "asn": asn_number,
            "carrier": str(owner) if owner else None,
            "reverse": str(reverse) if reverse else None,
            "quality": "premium" if asn_number in premium_asns else "standard",
        })
    successful_hops = [hop for hop in hops if hop["ip"]]
    final_latency = successful_hops[-1]["latency_ms"] if successful_hops else None
    return {
        "schema_version": 1,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "task": asdict(task),
        "completed": bool(successful_hops and successful_hops[-1]["ip"] == task.target),
        "hop_count": len(hops),
        "final_latency_ms": final_latency,
        "hops": hops,
    }


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-.").lower()
    return slug[:64] or "route"


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class RouteStore:
    def __init__(self, database: Path, route_logs: Path):
        self.database = database
        self.route_logs = route_logs

    def ensure_schema(self) -> None:
        with closing(sqlite3.connect(f"file:{self.database}?mode=ro", uri=True)) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(route_runs)")}
        if columns != EXPECTED_ROUTE_COLUMNS:
            raise RouteConfigError("route_runs schema mismatch; migration is not allowed")

    def persist(self, task: RouteTask, result: RunResult, config: dict[str, Any]) -> dict[str, Any]:
        local_date = datetime.fromisoformat(result.timestamp.replace("Z", "+00:00")).astimezone(
            ZoneInfo(config["timezone"])
        ).strftime("%Y-%m-%d")
        stem = "-".join((
            result.timestamp.replace(":", "").replace("-", ""),
            safe_slug(task.wan), safe_slug(task.direction), safe_slug(task.protocol), safe_slug(task.target_name),
            secrets.token_hex(4),
        ))
        directory = self.route_logs / local_date
        if result.payload is not None:
            raw_path = directory / f"{stem}.raw.json"
            raw_data = result.raw_stdout.encode("utf-8")
        else:
            raw_path = directory / f"{stem}.failure.json"
            raw_data = json.dumps({
                "timestamp": result.timestamp,
                "exit_code": result.exit_code,
                "error": result.error,
                "stdout": result.raw_stdout,
                "stderr": result.raw_stderr,
            }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        premium = config.get("premium_detection", {})
        premium_asns = set(premium.get("asns", [])) if premium.get("approved") else set()
        normalized = normalize_nexttrace(result.payload, task, premium_asns) if result.payload is not None else {
            "schema_version": 1,
            "timestamp": result.timestamp,
            "task": asdict(task),
            "completed": False,
            "hop_count": 0,
            "final_latency_ms": None,
            "hops": [],
            "error": result.error,
        }
        normalized["completed"] = bool(result.completed and normalized.get("completed"))
        normalized_path = directory / f"{stem}.normalized.json"
        atomic_write(raw_path, raw_data)
        atomic_write(normalized_path, json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        try:
            raw_reference = str(raw_path.relative_to(self.database.parent.parent))
        except ValueError:
            raw_reference = str(raw_path)
        with closing(sqlite3.connect(self.database, timeout=10)) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(
                """
                INSERT INTO route_runs(
                    timestamp,wan,direction,protocol,source,target,final_latency_ms,
                    hop_count,completed,raw_file,error
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    result.timestamp, task.wan, task.direction, task.protocol, task.source,
                    task.target, normalized.get("final_latency_ms"), normalized.get("hop_count"),
                    1 if normalized.get("completed") else 0, raw_reference, result.error,
                ),
            )
            conn.commit()
        return {"raw_file": str(raw_path), "normalized_file": str(normalized_path), "normalized": normalized}


class NonBlockingLock:
    def __init__(self, path: Path):
        self.path = path
        self.handle = None

    def __enter__(self) -> "NonBlockingLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.handle.close()
            self.handle = None
            raise RouteExecutionError("route_collector_overlap")
        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(str(os.getpid()))
        self.handle.flush()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self.handle is not None:
            fcntl.flock(self.handle, fcntl.LOCK_UN)
            self.handle.close()


def append_event(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, line.encode("utf-8"))
    finally:
        os.close(descriptor)

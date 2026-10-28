#!/usr/bin/env python3
import base64
import gzip
import hashlib
import ipaddress
import json
import math
import mimetypes
import os
import re
import socket
import sqlite3
import struct
import threading
import time
from collections import defaultdict
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DB_PATH = ROOT / "data" / "monitor.sqlite3"
WANS_PATH = ROOT / "config" / "wans.json"
TARGETS_PATH = ROOT / "config" / "targets.json"
ROUTES_CONFIG_PATH = ROOT / "config" / "routes.json"
ROUTE_LOG_ROOT = ROOT / "logs" / "routes"
STATIC = HERE / "static"
STARTED = time.monotonic()
RANGES = {"1h": 1, "6h": 6, "24h": 24, "7d": 168}
WAN_ORDER = ("telecom", "mobile", "unicom")
STATUS_RANK = {"normal": 0, "warning": 1, "degraded": 2, "down": 3, "stale": 4}
# 仓库副本已脱敏：生产 fnnas 上的 server.py 保留真实地址，本文件不参与部署。
NEZHA_BASE_URL = os.environ.get("NEZHA_BASE_URL", "http://192.0.2.1:8008").rstrip("/")
NEZHA_WS_PATH = "/api/v1/ws/server"
NEZHA_MAX_FRAME_BYTES = 4 * 1024 * 1024
VPS_TARGET_NAMES = (
    "Zillion Network",
    "Alibaba Cloud",
    "NetLab Global HK",
    "DMIT Premium",
    "DMIT Eyeball",
    "NetLab Global US",
    "Evoxt Premium",
    "Yecaoyun Cloud",
)
CACHE_LOCK = threading.Lock()
CACHE = {}
CACHE_KEY_LOCKS = {}
CACHE_REVISION = None
NEZHA_LOCK = threading.Lock()
NEZHA_STATE = {
    "connected": False,
    "updated_at": None,
    "updated_monotonic": 0.0,
    "targets": {},
    "error": "connecting",
}
TARGET_HOSTS_CACHE = None
ROUTE_NORMALIZED_MAX_BYTES = 2 * 1024 * 1024
ROUTE_RAW_MAX_BYTES = 2 * 1024 * 1024
ROUTE_DIRECTIONS = ("outbound", "return")
ROUTE_PROTOCOLS = ("icmp", "tcp")
ROUTE_HIDDEN_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")
)
PREMIUM_ROUTE_PATTERN = re.compile(
    r"(?:CN2|CTG|CMIN2)|(?<![A-Z0-9])CMI(?![A-Z0-9])",
    re.IGNORECASE,
)
CN2_FALLBACK_NETWORK = ipaddress.ip_network("59.43.0.0/16")
BACKBONE_ASN_FALLBACKS = {906: "DMIT-BB"}
ROUTE_LOCATION_TIMEOUT_VALUES = frozenset(("网络故障", "network error"))


class RequestError(ValueError):
    pass


class RoutePayloadError(ValueError):
    pass


def target_hosts():
    global TARGET_HOSTS_CACHE
    if TARGET_HOSTS_CACHE is not None:
        return TARGET_HOSTS_CACHE
    config = json.loads(TARGETS_PATH.read_text())
    TARGET_HOSTS_CACHE = {
        item["name"]: item["host"]
        for item in config.get("tcp_targets", [])
        if item.get("name") in VPS_TARGET_NAMES
    }
    return TARGET_HOSTS_CACHE


def optional_integer(value):
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def percentage(used, total):
    try:
        total = float(total)
        return rounded(100.0 * float(used) / total) if total > 0 else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def timestamp_ms(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000
    except (TypeError, ValueError):
        return 0


def sanitize_nezha_snapshot(message):
    configured = target_hosts()
    now_ms = int(message.get("now") or 0)
    servers = message.get("servers") if isinstance(message.get("servers"), list) else []
    result = {}
    for target_name, target_host in configured.items():
        raw = next(
            (
                item
                for item in servers
                if str(item.get("name", "")).endswith(target_host)
                and str(item.get("name", ""))[-len(target_host) - 1 : -len(target_host)] not in "0123456789."
            ),
            None,
        )
        if raw is None:
            continue
        host = raw.get("host") if isinstance(raw.get("host"), dict) else {}
        state = raw.get("state") if isinstance(raw.get("state"), dict) else {}
        last_active = raw.get("last_active")
        active_ms = timestamp_ms(last_active)
        result[target_name] = {
            "target_name": target_name,
            "target_host": target_host,
            "online": bool(now_ms and active_ms and now_ms - active_ms <= 30000),
            "uptime_seconds": optional_integer(state.get("uptime")),
            "cpu_percent": rounded(state.get("cpu")),
            "memory_percent": percentage(state.get("mem_used"), host.get("mem_total")),
            "storage_percent": percentage(state.get("disk_used"), host.get("disk_total")),
            "upload_bytes_per_second": optional_integer(state.get("net_out_speed")),
            "download_bytes_per_second": optional_integer(state.get("net_in_speed")),
            "last_active": last_active,
        }
    return result


def websocket_frame(sock, buffer):
    def read_exact(size):
        nonlocal buffer
        output = buffer[:size]
        buffer = buffer[size:]
        while len(output) < size:
            chunk = sock.recv(size - len(output))
            if not chunk:
                raise ConnectionError("websocket closed")
            output += chunk
        return output

    fragments = bytearray()
    text_started = False
    while True:
        first, second = read_exact(2)
        final = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", read_exact(8))[0]
        if length > NEZHA_MAX_FRAME_BYTES:
            raise ValueError("websocket frame too large")
        mask = read_exact(4) if masked else None
        payload = read_exact(length)
        if mask:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        if opcode == 0x8:
            raise ConnectionError("websocket closed")
        if opcode == 0x9:
            send_websocket_frame(sock, 0xA, payload)
            continue
        if opcode == 0xA:
            continue
        if opcode == 0x1:
            fragments = bytearray(payload)
            text_started = True
        elif opcode == 0x0 and text_started:
            fragments.extend(payload)
        else:
            continue
        if final:
            return fragments.decode("utf-8"), buffer


def send_websocket_frame(sock, opcode, payload=b""):
    payload = bytes(payload)
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        header = bytes((0x80 | opcode, 0x80 | length))
    elif length <= 65535:
        header = bytes((0x80 | opcode, 0x80 | 126)) + struct.pack("!H", length)
    else:
        header = bytes((0x80 | opcode, 0x80 | 127)) + struct.pack("!Q", length)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    sock.sendall(header + mask + masked)


def open_nezha_websocket():
    parsed = urlparse(NEZHA_BASE_URL)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ValueError("unsupported Nezha URL")
    port = parsed.port or 80
    sock = socket.create_connection((parsed.hostname, port), timeout=5)
    sock.settimeout(20)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET {NEZHA_WS_PATH} HTTP/1.1\r\n"
        f"Host: {parsed.hostname}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Origin: {NEZHA_BASE_URL}\r\n"
        "User-Agent: network-monitor-readonly/1.0\r\n\r\n"
    )
    sock.sendall(request.encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk or len(response) > 65536:
            raise ConnectionError("invalid websocket handshake")
        response += chunk
    header, buffer = response.split(b"\r\n\r\n", 1)
    lines = header.decode("latin1").split("\r\n")
    if not lines or " 101 " not in f" {lines[0]} ":
        raise ConnectionError("websocket handshake rejected")
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    if headers.get("sec-websocket-accept") != expected:
        raise ConnectionError("invalid websocket accept")
    return sock, buffer


def monitor_nezha():
    retry_delay = 2
    while True:
        sock = None
        try:
            sock, buffer = open_nezha_websocket()
            with NEZHA_LOCK:
                NEZHA_STATE["connected"] = True
                NEZHA_STATE["error"] = None
            while True:
                message, buffer = websocket_frame(sock, buffer)
                parsed = json.loads(message)
                targets = sanitize_nezha_snapshot(parsed)
                with NEZHA_LOCK:
                    NEZHA_STATE.update({
                        "connected": True,
                        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "updated_monotonic": time.monotonic(),
                        "targets": targets,
                        "error": None,
                    })
                retry_delay = 2
        except (ConnectionError, OSError, ValueError, json.JSONDecodeError):
            with NEZHA_LOCK:
                NEZHA_STATE["connected"] = False
                NEZHA_STATE["error"] = "unavailable"
            time.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 30)
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass


def start_nezha_monitor():
    thread = threading.Thread(target=monitor_nezha, name="nezha-readonly", daemon=True)
    thread.start()


def database_revision():
    paths = (DB_PATH, Path(str(DB_PATH) + "-wal"))
    revision = []
    for path in paths:
        try:
            stat = path.stat()
            revision.append((path.name, stat.st_mtime_ns, stat.st_size))
        except FileNotFoundError:
            revision.append((path.name, 0, 0))
    return tuple(revision)


def encode_json(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()


def cached_json(key, builder):
    global CACHE_REVISION
    revision = database_revision()
    with CACHE_LOCK:
        if CACHE_REVISION != revision:
            CACHE.clear()
            CACHE_REVISION = revision
        cached = CACHE.get(key)
        if cached is not None:
            return cached
        key_lock = CACHE_KEY_LOCKS.setdefault(key, threading.Lock())

    with key_lock:
        revision = database_revision()
        with CACHE_LOCK:
            if CACHE_REVISION != revision:
                CACHE.clear()
                CACHE_REVISION = revision
            cached = CACHE.get(key)
            if cached is not None:
                return cached

        payload = builder()
        body = encode_json(payload)
        compressed = gzip.compress(body, compresslevel=5) if len(body) >= 1024 else None
        result = (payload, body, compressed)
        final_revision = database_revision()
        with CACHE_LOCK:
            if CACHE_REVISION == revision == final_revision:
                CACHE[key] = result
        return result


def connect():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def cutoff(range_name):
    hours = RANGES.get(range_name, 24)
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def percentile(values, quantile):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    index = (len(values) - 1) * quantile
    low = int(index)
    high = min(low + 1, len(values) - 1)
    fraction = index - low
    return values[low] * (1 - fraction) + values[high] * fraction


def rounded(value, digits=2):
    return None if value is None else round(float(value), digits)


def latest_by_target(conn, wan, test_type):
    rows = conn.execute(
        """
        SELECT l.* FROM latency_samples l
        JOIN (
          SELECT target_name, MAX(id) AS max_id FROM latency_samples
          WHERE wan=? AND test_type=? GROUP BY target_name
        ) latest ON latest.max_id=l.id
        """,
        (wan, test_type),
    ).fetchall()
    return {row["target_name"]: dict(row) for row in rows}


WARNING_FAILURE_STREAK = 3


def _persistent_failure(rows, target_name, test_type, streak=WARNING_FAILURE_STREAK):
    """单目标最近 streak 条采样（按 id 升序取尾部）全部失败才算持续故障；样本不足按瞬断处理。"""
    recent = [row["success"] for row in rows if row["test_type"] == test_type and row["target_name"] == target_name][-streak:]
    return len(recent) == streak and not any(recent)


def status_for(latest_icmp, latest_tcp, latest_timestamp, rows=()):
    timestamp = parse_time(latest_timestamp)
    if timestamp is None or (datetime.now(timezone.utc) - timestamp).total_seconds() > 180:
        return "stale", "数据过期"
    alidns = latest_icmp.get("AliDNS")
    tcp_ok = sum(1 for row in latest_tcp.values() if row["success"])
    tcp_total = len(latest_tcp)
    cloudflare = latest_icmp.get("Cloudflare DNS")
    if (not alidns or not alidns["success"]) and tcp_total and tcp_ok == 0:
        return "down", "线路不可达"
    if not alidns or not alidns["success"] or (tcp_total and tcp_ok <= 1):
        return "degraded", "多目标异常"
    # 单目标波动豁免瞬断：失败需连续 WARNING_FAILURE_STREAK 次采样（约 3 分钟）才升级为 warning。
    # stale / down / degraded 仍按最新样本即时判定。
    cloudflare_persistent = bool(cloudflare) and not cloudflare["success"] and _persistent_failure(rows, "Cloudflare DNS", "icmp")
    tcp_persistent = any(
        not row["success"] and _persistent_failure(rows, name, "tcp")
        for name, row in latest_tcp.items()
    )
    if cloudflare_persistent or tcp_persistent:
        return "warning", "单目标异常"
    return "normal", "正常"


def build_overview():
    since = cutoff("24h")
    with connect() as conn:
        wan_config = json.loads(WANS_PATH.read_text())
        result = {}
        newest = None
        for wan in WAN_ORDER:
            cfg = wan_config[wan]
            rows = conn.execute(
                """
                SELECT * FROM latency_samples
                WHERE wan=? AND timestamp>=?
                ORDER BY id
                """,
                (wan, since),
            ).fetchall()
            latest_icmp = latest_by_target(conn, wan, "icmp")
            latest_tcp = latest_by_target(conn, wan, "tcp")
            latest_ts = max((row["timestamp"] for row in rows), default=None)
            newest = max(filter(None, (newest, latest_ts)), default=None)

            alidns_rows = [row for row in rows if row["test_type"] == "icmp" and row["target_name"] == "AliDNS"]
            alidns_values = [row["avg_ms"] for row in alidns_rows if row["success"] and row["avg_ms"] is not None]
            latest_alidns = latest_icmp.get("AliDNS")
            tcp_rows = [row for row in rows if row["test_type"] == "tcp"]
            tcp_success = 100.0 * sum(row["success"] for row in tcp_rows) / len(tcp_rows) if tcp_rows else None
            breakdown = {}
            for target in ("AliDNS", "Cloudflare DNS"):
                target_rows = [row for row in rows if row["test_type"] == "icmp" and row["target_name"] == target]
                breakdown[target] = {
                    "samples": len(target_rows),
                    "success_percent": rounded(100.0 * sum(row["success"] for row in target_rows) / len(target_rows)) if target_rows else None,
                    "loss_percent": rounded(sum((row["loss_percent"] or 0) for row in target_rows) / len(target_rows)) if target_rows else None,
                    "latest_success": bool(latest_icmp.get(target, {}).get("success")) if target in latest_icmp else None,
                }

            status, status_label = status_for(latest_icmp, latest_tcp, latest_ts, rows)
            result[wan] = {
                "display_name": cfg["display_name"],
                "interface": cfg["interface"],
                "source_ip": cfg["source_ip"],
                "status": status,
                "status_label": status_label,
                "latest_timestamp": latest_ts,
                "current_ms": rounded(latest_alidns["avg_ms"]) if latest_alidns and latest_alidns["success"] else None,
                "avg_ms": rounded(sum(alidns_values) / len(alidns_values)) if alidns_values else None,
                "p95_ms": rounded(percentile(alidns_values, 0.95)),
                "max_ms": rounded(max((row["max_ms"] for row in alidns_rows if row["max_ms"] is not None), default=None)),
                "alidns_loss_percent": breakdown["AliDNS"]["loss_percent"],
                "tcp_success_percent": rounded(tcp_success),
                "icmp_targets": breakdown,
                "tcp_latest": {
                    name: {"success": bool(row["success"]), "avg_ms": rounded(row["avg_ms"]), "timestamp": row["timestamp"]}
                    for name, row in latest_tcp.items()
                },
                "samples": {"alidns": len(alidns_rows), "tcp": len(tcp_rows)},
            }

        status = max((item["status"] for item in result.values()), key=lambda value: STATUS_RANK[value])
        status_labels = {"normal": "正常", "warning": "存在单目标波动", "degraded": "多目标异常", "down": "线路异常", "stale": "数据过期"}
        last_run = conn.execute(
            "SELECT timestamp, accepted, rejected, error FROM collector_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        collector = conn.execute(
            """
            SELECT COUNT(*) AS runs, COALESCE(SUM(rejected),0) AS rejected,
                   SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
            FROM collector_runs WHERE datetime(timestamp)>=datetime(?)
            """,
            (since,),
        ).fetchone()
        sample_count = conn.execute("SELECT COUNT(*) FROM latency_samples").fetchone()[0]
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_update": newest,
        "overall": {"status": status, "label": status_labels[status]},
        "wans": result,
        "collector": {
            "status": "normal" if last_run and last_run["accepted"] == 54 and last_run["rejected"] == 0 and not last_run["error"] else "degraded",
            "last_run": dict(last_run) if last_run else None,
            "runs_24h": collector["runs"],
            "rejected_24h": collector["rejected"],
            "writer_errors_24h": collector["errors"],
            "parser_errors": None,
            "overlaps": None,
            "duration_seconds": None,
        },
        "database": {"bytes": DB_PATH.stat().st_size, "samples": sample_count},
        "runtime": {
            "r5s_uptime": None,
            "r5s_cpu": None,
            "r5s_memory": None,
            "r5s_storage": None,
            "note": "R5S 资源连续指标尚未接入数据库",
        },
    }


def aggregate_samples(rows, bucket_seconds):
    if bucket_seconds <= 60:
        return [dict(row) for row in rows]
    buckets = defaultdict(list)
    for row in rows:
        timestamp = parse_time(row["timestamp"])
        epoch = int(timestamp.timestamp())
        key = (row["wan"], epoch - epoch % bucket_seconds)
        buckets[key].append(row)
    output = []
    for (wan, epoch), items in sorted(buckets.items(), key=lambda item: item[0][1]):
        good = [row for row in items if row["success"] and row["avg_ms"] is not None]
        output.append({
            "timestamp": datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "wan": wan,
            "target_name": items[0]["target_name"],
            "test_type": items[0]["test_type"],
            "success": 1 if len(good) == len(items) else 0,
            "success_rate": round(100.0 * len(good) / len(items), 2),
            "avg_ms": rounded(sum(row["avg_ms"] for row in good) / len(good)) if good else None,
            "max_ms": rounded(max((row["max_ms"] for row in good if row["max_ms"] is not None), default=None)),
            "loss_percent": rounded(sum((row["loss_percent"] or 0) for row in items) / len(items)),
            "samples": len(items),
        })
    return output


def query_value(query, name, default):
    values = query.get(name)
    if not values:
        return default
    if len(values) != 1 or not isinstance(values[0], str):
        raise RequestError(f"invalid {name}")
    value = values[0].strip()
    if not value or len(value) > 96:
        raise RequestError(f"invalid {name}")
    return value


def route_config():
    payload = json.loads(ROUTES_CONFIG_PATH.read_text(encoding="utf-8"))
    targets = payload.get("vps_targets")
    if not isinstance(targets, list):
        raise RoutePayloadError("route target config unavailable")
    return payload


def route_target_options(config, direction):
    targets = []
    for item in config.get("vps_targets", []):
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        host = item.get("host")
        if not isinstance(name, str) or not isinstance(host, str):
            continue
        display_name = str(item.get("display_name") or name)
        if item.get("authorization_status") != "confirmed":
            continue
        if direction == "return" and not item.get("return_enabled"):
            continue
        if direction == "outbound" and not item.get("outbound_enabled", item.get("return_enabled")):
            continue
        targets.append({
            "target_name": name,
            "display_name": display_name[:96],
            "host": host,
        })
    return targets


def normalized_path_for(raw_file):
    if not isinstance(raw_file, str) or not raw_file or len(raw_file) > 1024:
        raise RoutePayloadError("invalid normalized route reference")
    raw_path = Path(raw_file)
    if not raw_path.is_absolute():
        raw_path = ROOT / raw_path
    route_root = ROUTE_LOG_ROOT.resolve()
    resolved_raw = raw_path.resolve()
    if resolved_raw != route_root and route_root not in resolved_raw.parents:
        raise RoutePayloadError("normalized route reference outside route log root")
    name = resolved_raw.name
    if name.endswith(".normalized.json"):
        normalized_name = name
    elif name.endswith(".raw.json"):
        normalized_name = name[:-9] + ".normalized.json"
    elif name.endswith(".failure.json"):
        normalized_name = name[:-13] + ".normalized.json"
    else:
        raise RoutePayloadError("invalid route log suffix")
    normalized = resolved_raw.with_name(normalized_name).resolve()
    if normalized != route_root and route_root not in normalized.parents:
        raise RoutePayloadError("normalized route path outside route log root")
    return normalized


def raw_path_for(raw_file):
    if not isinstance(raw_file, str) or not raw_file or len(raw_file) > 1024:
        raise RoutePayloadError("invalid raw route reference")
    candidate = Path(raw_file)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    route_root = ROUTE_LOG_ROOT.resolve()
    resolved = candidate.resolve()
    if resolved != route_root and route_root not in resolved.parents:
        raise RoutePayloadError("raw route reference outside route log root")
    name = resolved.name
    if name.endswith(".raw.json"):
        raw_name = name
    elif name.endswith(".normalized.json"):
        raw_name = name[:-16] + ".raw.json"
    else:
        raise RoutePayloadError("invalid raw route suffix")
    raw_path = resolved.with_name(raw_name).resolve()
    if raw_path != route_root and route_root not in raw_path.parents:
        raise RoutePayloadError("raw route path outside route log root")
    return raw_path


def bounded_text(value, limit=256):
    if value in (None, ""):
        return None
    return str(value)[:limit]


def clean_route_text(value, limit=256):
    value = bounded_text(value, limit)
    return re.sub(r"\s+", " ", value).strip() if value else None


def display_route_location(value):
    location = clean_route_text(value)
    if location and location.casefold() in ROUTE_LOCATION_TIMEOUT_VALUES:
        return "位置解析超时"
    return location


def mapping_value(mapping, *names):
    if not isinstance(mapping, dict):
        return None
    for name in names:
        if name in mapping:
            return mapping[name]
    folded = {str(key).casefold(): value for key, value in mapping.items()}
    for name in names:
        if name.casefold() in folded:
            return folded[name.casefold()]
    return None


def raw_node_address(node):
    address = mapping_value(node, "Address", "address", "IP", "ip")
    if isinstance(address, dict):
        address = mapping_value(address, "IP", "ip", "Address", "address")
    return canonical_ip(address)


def raw_route_metadata(raw_file):
    try:
        path = raw_path_for(raw_file)
        stat = path.stat()
        if stat.st_size < 2 or stat.st_size > ROUTE_RAW_MAX_BYTES:
            return {}
        payload = json.loads(path.read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RoutePayloadError):
        return {}
    groups = mapping_value(payload, "Hops", "hops")
    if not isinstance(groups, list) or len(groups) > 64:
        return {}
    metadata = {}
    for index, group in enumerate(groups, 1):
        nodes = group if isinstance(group, list) else [group]
        responding = [(node, raw_node_address(node)) for node in nodes if isinstance(node, dict)]
        responding = [(node, address) for node, address in responding if address]
        if not responding:
            continue
        node, address = responding[0]
        geo = mapping_value(node, "Geo", "geo", "Location", "location")
        geo = geo if isinstance(geo, dict) else {}
        ttl = optional_integer(mapping_value(node, "TTL", "ttl", "Hop", "hop")) or index
        ptr = next((
            clean_route_text(mapping_value(candidate, "Hostname", "hostname", "PTR", "ptr"))
            for candidate, candidate_address in responding
            if candidate_address == address and mapping_value(candidate, "Hostname", "hostname", "PTR", "ptr")
        ), None)
        metadata[(ttl, address)] = {
            "backbone": clean_route_text(mapping_value(geo, "whois")),
            "owner": clean_route_text(mapping_value(geo, "owner")),
            "domain": clean_route_text(mapping_value(geo, "domain")),
            "operator": clean_route_text(mapping_value(geo, "isp")),
            "ptr": ptr,
        }
    return metadata


def short_operator(value):
    value = clean_route_text(value)
    if not value:
        return None
    folded = value.casefold()
    for needles, label in (
        (("中国电信", "china telecom", "chinatelecom"), "电信"),
        (("中国移动", "china mobile", "chinamobile"), "移动"),
        (("中国联通", "china unicom", "chinaunicom"), "联通"),
    ):
        if any(needle in folded for needle in needles):
            return label
    return value


def join_unique_route_text(*values):
    output = []
    seen = set()
    for value in values:
        value = clean_route_text(value)
        if not value:
            continue
        key = value.casefold()
        if key in seen:
            continue
        seen.add(key)
        output.append(value)
    return " ".join(output) or None


def contains_sensitive_ip_text(value, sensitive_ips):
    if not value:
        return False
    folded = str(value).casefold()
    for address in sensitive_ips:
        for token in (address, address.replace(".", "-"), address.replace(".", "_")):
            if token.casefold() in folded:
                return True
    return False


def cn2_prefix_fallback(value):
    try:
        address = ipaddress.ip_address(str(value).strip())
    except (TypeError, ValueError):
        return False
    return address.version == 4 and address in CN2_FALLBACK_NETWORK


def clean_latency(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0 or number > 3_600_000:
        return None
    return round(number, 3)


def clean_asn(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if 0 < number <= 4_294_967_295 else None


def canonical_ip(value):
    try:
        return str(ipaddress.ip_address(str(value).strip()))
    except (TypeError, ValueError):
        return None


def hide_route_ip(value, sensitive_ips):
    try:
        address = ipaddress.ip_address(str(value).strip())
    except (TypeError, ValueError):
        return False
    if str(address) in sensitive_ips:
        return True
    return address.version == 4 and any(address in network for network in ROUTE_HIDDEN_IPV4_NETWORKS)


def nested_ip_values(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from nested_ip_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from nested_ip_values(item)
    else:
        ip = canonical_ip(value)
        if ip:
            yield ip


def sensitive_route_ips(config):
    hidden = set()
    for binding in config.get("wans", {}).values():
        if isinstance(binding, dict):
            ip = canonical_ip(binding.get("source_ip"))
            if ip:
                hidden.add(ip)
    for target in config.get("vps_targets", []):
        if isinstance(target, dict):
            ip = canonical_ip(target.get("host"))
            if ip:
                hidden.add(ip)
    public_ip_path = ROOT / "data" / "public-ip.json"
    try:
        public_payload = json.loads(public_ip_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        public_payload = {}
    hidden.update(nested_ip_values(public_payload))
    return hidden


def premium_text_fields(location, carrier, reverse, premium_asns):
    fields = []
    asn_tokens = "|".join(str(value) for value in sorted(premium_asns))
    asn_pattern = re.compile(rf"(?<![A-Z0-9])AS\s*(?:{asn_tokens})(?![0-9])", re.IGNORECASE) if asn_tokens else None
    for name, value in (("location", location), ("carrier", carrier), ("reverse", reverse)):
        if value and (PREMIUM_ROUTE_PATTERN.search(value) or (asn_pattern and asn_pattern.search(value))):
            fields.append(name)
    return fields


def read_normalized_route(row, expected):
    path = normalized_path_for(row["raw_file"])
    try:
        stat = path.stat()
    except OSError as exc:
        raise RoutePayloadError("normalized route file unavailable") from exc
    if stat.st_size < 2 or stat.st_size > ROUTE_NORMALIZED_MAX_BYTES:
        raise RoutePayloadError("normalized route file size rejected")
    try:
        raw_payload = path.read_bytes()
        if len(raw_payload) > ROUTE_NORMALIZED_MAX_BYTES:
            raise RoutePayloadError("normalized route file size rejected")
        payload = json.loads(raw_payload)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RoutePayloadError("normalized route file invalid") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise RoutePayloadError("normalized route schema rejected")
    task = payload.get("task")
    if not isinstance(task, dict):
        raise RoutePayloadError("normalized route task missing")
    for field in ("wan", "direction", "protocol", "target_name"):
        if task.get(field) != expected[field]:
            raise RoutePayloadError("normalized route task mismatch")
    if str(task.get("source")) != str(row["source"]) or str(task.get("target")) != str(row["target"]):
        raise RoutePayloadError("normalized route endpoint mismatch")
    raw_hops = payload.get("hops")
    if not isinstance(raw_hops, list) or len(raw_hops) > 64:
        raise RoutePayloadError("normalized route hops rejected")
    premium_asns = set(expected["premium_asns"])
    hidden_ips = set(expected["hidden_ips"])
    raw_metadata = raw_route_metadata(row["raw_file"])
    hops = []
    for index, item in enumerate(raw_hops, 1):
        if not isinstance(item, dict):
            raise RoutePayloadError("normalized route hop rejected")
        try:
            hop_number = int(item.get("hop", index))
        except (TypeError, ValueError):
            hop_number = index
        if hop_number < 1 or hop_number > 255:
            hop_number = index
        asn = clean_asn(item.get("asn"))
        ip = bounded_text(item.get("ip"), 64)
        location = display_route_location(item.get("location"))
        carrier = bounded_text(item.get("carrier"))
        reverse = bounded_text(item.get("reverse"))
        canonical_hop_ip = canonical_ip(ip)
        metadata = raw_metadata.get((hop_number, canonical_hop_ip), {})
        backbone = clean_route_text(metadata.get("backbone"))
        owner = clean_route_text(metadata.get("owner")) or clean_route_text(carrier)
        domain = clean_route_text(metadata.get("domain"))
        operator = short_operator(metadata.get("operator"))
        ptr = clean_route_text(metadata.get("ptr")) or clean_route_text(reverse)
        if cn2_prefix_fallback(canonical_hop_ip) and not backbone:
            backbone = "CN2-BackBone"
        if not backbone:
            backbone = BACKBONE_ASN_FALLBACKS.get(asn)
        if contains_sensitive_ip_text(ptr, hidden_ips):
            ptr = None
        fallback_owner = join_unique_route_text(domain, operator)
        reverse_display = join_unique_route_text(backbone, owner or fallback_owner) or ptr
        if contains_sensitive_ip_text(reverse_display, hidden_ips):
            reverse_display = None
        carrier = owner
        reverse = ptr
        premium_reverse = reverse_display if reverse_display != carrier else reverse
        matched_fields = premium_text_fields(location, carrier, premium_reverse, premium_asns)
        if backbone and PREMIUM_ROUTE_PATTERN.search(backbone) and "reverse" not in matched_fields:
            matched_fields.append("reverse")
        if asn in premium_asns:
            matched_fields.insert(0, "asn")
        hops.append({
            "hop": hop_number,
            "ip": "已隐藏" if hide_route_ip(ip, hidden_ips) else ip,
            "latency_ms": clean_latency(item.get("latency_ms")),
            "location": location,
            "asn": asn,
            "carrier": carrier,
            "reverse": reverse,
            "backbone": backbone,
            "reverse_display": reverse_display,
            "quality": "premium" if matched_fields else "standard",
            "premium_matches": matched_fields,
        })
    return {
        "timestamp": bounded_text(payload.get("timestamp"), 40) or row["timestamp"],
        "completed": bool(payload.get("completed") and row["completed"]),
        "hop_count": len(hops),
        "final_latency_ms": clean_latency(payload.get("final_latency_ms")),
        "hops": hops,
        "payload_error": bounded_text(payload.get("error"), 128),
    }


def route_row(conn, wan, direction, protocol, target):
    endpoint_column = "target" if direction == "outbound" else "source"
    return conn.execute(
        f"""
        SELECT * FROM route_runs
        WHERE wan=? AND direction=? AND protocol=? AND {endpoint_column}=?
        ORDER BY timestamp DESC,id DESC LIMIT 1
        """,
        (wan, direction, protocol, target["host"]),
    ).fetchone()


def build_routes_response(query):
    wan = query_value(query, "wan", "telecom")
    direction = query_value(query, "direction", "outbound")
    protocol = query_value(query, "protocol", "icmp")
    target_name = query_value(query, "target_name", "DMIT Premium")
    if wan not in WAN_ORDER:
        raise RequestError("invalid wan")
    if direction not in ROUTE_DIRECTIONS:
        raise RequestError("invalid direction")
    if protocol not in ROUTE_PROTOCOLS:
        raise RequestError("invalid protocol")
    config = route_config()
    choices = route_target_options(config, direction)
    by_name = {item["target_name"]: item for item in choices}
    if target_name not in by_name:
        raise RequestError("invalid target_name")
    selected = by_name[target_name]
    premium = config.get("premium_detection", {})
    premium_asns = set(premium.get("asns", [])) if premium.get("approved") else set()
    with closing(connect()) as conn:
        row = route_row(conn, wan, direction, protocol, selected)
        options = []
        for choice in choices:
            latest = route_row(conn, wan, direction, protocol, choice)
            options.append({
                "target_name": choice["target_name"],
                "display_name": choice["display_name"],
                "has_data": latest is not None,
                "latest_timestamp": latest["timestamp"] if latest else None,
            })
    base = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "query": {
            "wan": wan,
            "direction": direction,
            "protocol": protocol,
            "target_name": target_name,
        },
        "targets": options,
    }
    if row is None:
        base.update({
            "summary": {
                "status": "no_data",
                "label": "暂无该组合的路由数据",
                "completed": False,
                "hop_count": 0,
                "final_latency_ms": None,
                "error": None,
            },
            "item": None,
            "hops": [],
        })
        return base
    expected = {
        "wan": wan,
        "direction": direction,
        "protocol": protocol,
        "target_name": target_name,
        "premium_asns": premium_asns,
        "hidden_ips": sensitive_route_ips(config),
    }
    try:
        normalized = read_normalized_route(row, expected)
        hops = normalized["hops"]
        completed = normalized["completed"]
        payload_error = normalized["payload_error"]
        if completed:
            status, label = "ok", "已到达目标"
        elif hops:
            status = "incomplete"
            label = "探测完成 · 终点未回应" if direction == "return" else "未到达目标"
        else:
            status, label = "failed", "探测失败"
        display_error = bounded_text(row["error"], 128) or payload_error
    except RoutePayloadError:
        normalized = {
            "timestamp": row["timestamp"],
            "completed": False,
            "hop_count": int(row["hop_count"] or 0),
            "final_latency_ms": clean_latency(row["final_latency_ms"]),
        }
        hops = []
        completed = False
        status, label = "unavailable", "逐跳文件不可用"
        display_error = "normalized_route_unavailable"
    summary = {
        "status": status,
        "label": label,
        "completed": completed,
        "hop_count": normalized["hop_count"],
        "final_latency_ms": normalized["final_latency_ms"],
        "error": display_error,
    }
    base.update({
        "summary": summary,
        "item": {
            "id": row["id"],
            "timestamp": row["timestamp"],
            "wan": wan,
            "direction": direction,
            "protocol": protocol,
            "target_name": target_name,
            "target_display_name": selected["display_name"],
            **summary,
        },
        "hops": hops,
    })
    return base


class Handler(BaseHTTPRequestHandler):
    server_version = "NetworkMonitorNext/0.1"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def send_json_body(self, body, status=200, compressed=None):
        use_gzip = compressed is not None and "gzip" in self.headers.get("Accept-Encoding", "").lower()
        response_body = compressed if use_gzip else body
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Accept-Encoding")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def send_json(self, payload, status=200):
        self.send_json_body(encode_json(payload), status)

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path in ("/api/overview", "/api/summary"):
                _, body, compressed = cached_json(("overview",), build_overview)
                return self.send_json_body(body, compressed=compressed)
            if parsed.path == "/api/latency":
                return self.latency(query)
            if parsed.path == "/api/live":
                return self.live(query)
            if parsed.path == "/api/targets":
                return self.targets(query)
            if parsed.path == "/api/vps-targets":
                return self.vps_targets()
            if parsed.path == "/api/vps-status":
                return self.vps_status(query)
            if parsed.path == "/api/health":
                overview, _, _ = cached_json(("overview",), build_overview)
                return self.send_json({
                    "status": "ok",
                    "server_uptime_seconds": int(time.monotonic() - STARTED),
                    "latest_sample": overview["latest_update"],
                    "collector": overview["collector"],
                    "database": overview["database"],
                })
            if parsed.path == "/api/routes":
                return self.routes(query)
            if parsed.path == "/api/bandwidth":
                return self.table("bandwidth_samples", query)
            return self.static(parsed.path)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except RequestError as exc:
            try:
                return self.send_json({"error": str(exc)}, 400)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
        except (sqlite3.Error, ValueError, OSError) as exc:
            try:
                return self.send_json({"error": type(exc).__name__}, 500)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return

    def targets(self, query):
        test_type = query.get("type", ["icmp"])[0]
        if test_type not in ("icmp", "tcp"):
            raise ValueError("invalid type")
        with connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT target_name, target_host, tcp_port FROM latency_samples WHERE test_type=? ORDER BY target_name",
                (test_type,),
            ).fetchall()
        self.send_json({"type": test_type, "targets": [dict(row) for row in rows]})

    def vps_targets(self):
        config = json.loads(TARGETS_PATH.read_text())
        display_names = {
            "Zillion Network": "美国 Zillion Network",
            "Alibaba Cloud": "新加坡 100TB Cloud",
            "NetLab Global HK": "香港 NetLab Global",
            "DMIT Premium": "美国 DMIT Premium",
            "DMIT Eyeball": "美国 DMIT Eyeball",
            "NetLab Global US": "美国 NetLab Global",
            "Evoxt Premium": "马来 Evoxt Premium",
            "Yecaoyun Cloud": "香港 Yecaoyun Cloud",
            "Yecaoyun Cloud2-current": "香港 Yecaoyun Cloud2",
        }
        with connect() as conn:
            rows = conn.execute(
                """
                SELECT target_name,COUNT(*) AS samples,MAX(timestamp) AS latest_timestamp
                FROM latency_samples WHERE test_type='tcp' GROUP BY target_name
                """
            ).fetchall()
        sampled = {row["target_name"]: dict(row) for row in rows}
        targets = []
        for item in config.get("tcp_targets", []):
            stats = sampled.get(item["name"])
            targets.append({
                "target_name": item["name"],
                "display_name": display_names.get(item["name"], item["name"]),
                "target_host": item["host"],
                "tcp_port": item.get("tcp_port"),
                "collector_enabled": bool(item.get("enabled")),
                "has_data": stats is not None,
                "samples": stats["samples"] if stats else 0,
                "latest_timestamp": stats["latest_timestamp"] if stats else None,
            })
        self.send_json({"targets": targets})

    def vps_status(self, query):
        target = query.get("target", ["DMIT Premium"])[0]
        configured = target_hosts()
        if target not in configured:
            return self.send_json({"error": "unknown target"}, 404)
        with NEZHA_LOCK:
            connected = bool(NEZHA_STATE["connected"])
            updated_at = NEZHA_STATE["updated_at"]
            updated_monotonic = float(NEZHA_STATE["updated_monotonic"] or 0)
            item = NEZHA_STATE["targets"].get(target)
        age = round(time.monotonic() - updated_monotonic, 1) if updated_monotonic else None
        fresh = bool(item is not None and connected and age is not None and age <= 15)
        if item is None:
            source_status = "connecting" if updated_at is None else "not_connected"
        elif fresh:
            source_status = "ok"
        else:
            source_status = "stale"
        self.send_json({
            "source": "nezha-public",
            "source_status": source_status,
            "fresh": fresh,
            "updated_at": updated_at,
            "snapshot_age_seconds": age,
            "target": target,
            "target_host": configured[target],
            "item": item,
        })

    def latency(self, query):
        range_name = query.get("range", ["24h"])[0]
        if range_name not in RANGES:
            raise ValueError("invalid range")
        test_type = query.get("type", query.get("test_type", ["icmp"]))[0]
        if test_type not in ("icmp", "tcp"):
            raise ValueError("invalid type")
        target = query.get("target", ["AliDNS" if test_type == "icmp" else "DMIT Premium"])[0]
        wan = query.get("wan", [None])[0]
        if wan:
            if wan not in WAN_ORDER:
                raise ValueError("invalid wan")

        def build():
            selected_wans = (wan,) if wan else WAN_ORDER
            rows = []
            since = cutoff(range_name)
            sql = (
                "SELECT timestamp,wan,interface,source_ip,target_name,target_host,test_type,success,"
                "avg_ms,max_ms,loss_percent,tcp_port,error FROM latency_samples "
                "WHERE wan=? AND test_type=? AND timestamp>=? AND target_name=? ORDER BY timestamp,id"
            )
            with connect() as conn:
                for selected_wan in selected_wans:
                    rows.extend(conn.execute(sql, (selected_wan, test_type, since, target)).fetchall())
            rows.sort(key=lambda row: row["timestamp"])
            bucket_seconds = 60
            samples = aggregate_samples(rows, bucket_seconds)
            return {
                "range": range_name,
                "type": test_type,
                "target": target,
                "bucket_seconds": bucket_seconds,
                "count": len(samples),
                "samples": samples,
            }

        _, body, compressed = cached_json(("latency", range_name, test_type, target, wan), build)
        self.send_json_body(body, compressed=compressed)

    def live(self, query):
        test_type = query.get("type", ["icmp"])[0]
        if test_type not in ("icmp", "tcp"):
            raise ValueError("invalid type")
        target = query.get("target", ["AliDNS" if test_type == "icmp" else "DMIT Premium"])[0]

        def build():
            with connect() as conn:
                rows = conn.execute(
                    """
                    SELECT l.timestamp,l.wan,l.interface,l.source_ip,l.target_name,l.target_host,
                           l.test_type,l.success,l.avg_ms,l.max_ms,l.loss_percent,l.tcp_port,l.error
                    FROM latency_samples l
                    JOIN (
                      SELECT wan,MAX(id) AS max_id FROM latency_samples
                      WHERE test_type=? AND target_name=? GROUP BY wan
                    ) latest ON latest.max_id=l.id
                    ORDER BY CASE l.wan WHEN 'telecom' THEN 1 WHEN 'mobile' THEN 2 ELSE 3 END
                    """,
                    (test_type, target),
                ).fetchall()
            items = [dict(row) for row in rows]
            latest = max((row["timestamp"] for row in rows), default=None)
            return {
                "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "type": test_type,
                "target": target,
                "latest_timestamp": latest,
                "items": items,
            }

        _, body, compressed = cached_json(("live", test_type, target), build)
        self.send_json_body(body, compressed=compressed)

    def routes(self, query):
        self.send_json(build_routes_response(query))

    def table(self, name, query):
        range_name = query.get("range", ["7d"])[0]
        if range_name not in RANGES:
            raise ValueError("invalid range")
        with connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM {name} WHERE datetime(timestamp)>=datetime(?) ORDER BY timestamp DESC,id DESC LIMIT 500",
                (cutoff(range_name),),
            ).fetchall()
        self.send_json({"items": [dict(row) for row in rows]})

    def static(self, path):
        name = "index.html" if path in ("", "/") else path.lstrip("/")
        candidate = (STATIC / name).resolve()
        if STATIC.resolve() not in candidate.parents or not candidate.is_file():
            return self.send_json({"error": "not found"}, 404)
        body = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    host = os.environ.get("NETWORK_MONITOR_HOST", "0.0.0.0")
    port = int(os.environ.get("NETWORK_MONITOR_PORT", "3003"))
    start_nezha_monitor()
    ThreadingHTTPServer((host, port), Handler).serve_forever()

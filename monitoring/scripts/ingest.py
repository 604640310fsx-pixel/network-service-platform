#!/usr/bin/env python3
import json
import sys
from datetime import datetime, timezone
from db import connect

REQUIRED = {"timestamp", "wan", "interface", "source_ip", "target_name", "target_host", "test_type", "success"}
WAN_BINDINGS = {
    "unicom": ("eth0.10", "192.0.2.11"),
    "telecom": ("eth0.20", "192.0.2.12"),
    "mobile": ("eth0.30", "192.0.2.13"),
}
FIELDS = (
    "timestamp", "wan", "interface", "source_ip", "target_name", "target_host",
    "test_type", "success", "min_ms", "avg_ms", "max_ms", "jitter_ms",
    "loss_percent", "tcp_port", "error"
)


def validate(item):
    if not REQUIRED.issubset(item):
        raise ValueError("missing required field")
    if item["wan"] not in WAN_BINDINGS:
        raise ValueError("unknown wan")
    if (item["interface"], item["source_ip"]) != WAN_BINDINGS[item["wan"]]:
        raise ValueError("wan binding mismatch")
    if item["test_type"] not in ("icmp", "tcp"):
        raise ValueError("invalid test type")
    item["success"] = 1 if bool(item["success"]) else 0
    if item["test_type"] == "tcp" and item.get("tcp_port") != 20001:
        raise ValueError("unapproved tcp port")
    return tuple(item.get(name) for name in FIELDS)


def main():
    accepted = 0
    rejected = 0
    rows = []
    errors = []
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            rows.append(validate(json.loads(line)))
            accepted += 1
        except Exception as exc:
            rejected += 1
            errors.append(type(exc).__name__)
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        if rows:
            conn.executemany(
                "INSERT INTO latency_samples (" + ",".join(FIELDS) + ") VALUES (" + ",".join("?" for _ in FIELDS) + ")",
                rows,
            )
        conn.execute(
            "INSERT INTO collector_runs(timestamp, source_host, accepted, rejected, error) VALUES(?,?,?,?,?)",
            (now, "r5s", accepted, rejected, ",".join(sorted(set(errors))) or None),
        )
    print(json.dumps({"accepted": accepted, "rejected": rejected}, ensure_ascii=False))
    return 0 if rejected == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())

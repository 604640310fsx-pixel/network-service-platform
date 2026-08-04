#!/usr/bin/env python3
import json
import mimetypes
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "monitor.sqlite3"
STATIC = Path(__file__).resolve().parent / "static"
RANGES = {"1h": 1, "24h": 24, "7d": 168, "30d": 720}


def db():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def since(value):
    hours = RANGES.get(value, 24)
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


class Handler(BaseHTTPRequestHandler):
    server_version = "NetworkMonitor/0.1"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                return self.health()
            if parsed.path == "/api/summary":
                return self.summary()
            if parsed.path == "/api/latency":
                return self.latency(parse_qs(parsed.query))
            if parsed.path == "/api/bandwidth":
                return self.table("bandwidth_samples", parse_qs(parsed.query))
            if parsed.path == "/api/routes":
                return self.table("route_runs", parse_qs(parsed.query))
            return self.static(parsed.path)
        except (sqlite3.Error, ValueError) as exc:
            return self.json({"error": type(exc).__name__}, 500)

    def health(self):
        with db() as conn:
            row = conn.execute("SELECT MAX(timestamp) AS last_sample, COUNT(*) AS samples FROM latency_samples").fetchone()
            last_run = conn.execute("SELECT timestamp, accepted, rejected, error FROM collector_runs ORDER BY id DESC LIMIT 1").fetchone()
        self.json({
            "status": "ok",
            "database_bytes": DB.stat().st_size,
            "last_sample": row["last_sample"],
            "sample_count": row["samples"],
            "last_collector_run": dict(last_run) if last_run else None,
        })

    def summary(self):
        cutoff = since("24h")
        result = {}
        with db() as conn:
            for wan in ("unicom", "telecom", "mobile"):
                row = conn.execute("""
                    SELECT
                      MAX(timestamp) AS last_sample,
                      AVG(CASE WHEN test_type='icmp' THEN avg_ms END) AS ping_avg_ms,
                      AVG(CASE WHEN test_type='icmp' THEN loss_percent END) AS loss_percent,
                      100.0 * AVG(CASE WHEN test_type='tcp' THEN success END) AS tcp_success_percent,
                      SUM(CASE WHEN test_type='icmp' THEN 1 ELSE 0 END) AS icmp_samples,
                      SUM(CASE WHEN test_type='tcp' THEN 1 ELSE 0 END) AS tcp_samples
                    FROM latency_samples WHERE wan=? AND timestamp>=?
                """, (wan, cutoff)).fetchone()
                latest = conn.execute("""
                    SELECT success, avg_ms, loss_percent FROM latency_samples
                    WHERE wan=? AND test_type='icmp' ORDER BY timestamp DESC, id DESC LIMIT 1
                """, (wan,)).fetchone()
                result[wan] = dict(row)
                result[wan]["latest_icmp"] = dict(latest) if latest else None
        self.json({"range": "24h", "wans": result})

    def latency(self, query):
        clauses = ["timestamp>=?"]
        params = [since(query.get("range", ["24h"])[0])]
        for key in ("wan", "target_host", "test_type"):
            value = query.get(key, [None])[0]
            if value:
                clauses.append(f"{key}=?")
                params.append(value)
        sql = "SELECT * FROM latency_samples WHERE " + " AND ".join(clauses) + " ORDER BY timestamp DESC, id DESC LIMIT 5000"
        with db() as conn:
            rows = [dict(r) for r in conn.execute(sql, params)]
        self.json({"samples": rows})

    def table(self, name, query):
        cutoff = since(query.get("range", ["30d"])[0])
        with db() as conn:
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {name} WHERE timestamp>=? ORDER BY timestamp DESC, id DESC LIMIT 1000", (cutoff,))]
        self.json({"items": rows})

    def static(self, path):
        name = "index.html" if path in ("", "/") else path.lstrip("/")
        candidate = (STATIC / name).resolve()
        if STATIC.resolve() not in candidate.parents or not candidate.is_file():
            return self.json({"error": "not found"}, 404)
        body = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    host = os.environ.get("NETWORK_MONITOR_HOST", "0.0.0.0")
    port = int(os.environ.get("NETWORK_MONITOR_PORT", "3002"))
    ThreadingHTTPServer((host, port), Handler).serve_forever()

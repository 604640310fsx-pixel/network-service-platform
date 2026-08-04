#!/usr/bin/env python3
from pathlib import Path
from db import DB_PATH, connect

SCHEMA = """
CREATE TABLE IF NOT EXISTS latency_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    wan TEXT NOT NULL,
    interface TEXT NOT NULL,
    source_ip TEXT NOT NULL,
    target_name TEXT NOT NULL,
    target_host TEXT NOT NULL,
    test_type TEXT NOT NULL CHECK(test_type IN ('icmp','tcp')),
    success INTEGER NOT NULL CHECK(success IN (0,1)),
    min_ms REAL,
    avg_ms REAL,
    max_ms REAL,
    jitter_ms REAL,
    loss_percent REAL,
    tcp_port INTEGER,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_latency_time ON latency_samples(timestamp);
CREATE INDEX IF NOT EXISTS idx_latency_wan_type_time ON latency_samples(wan, test_type, timestamp);
CREATE TABLE IF NOT EXISTS bandwidth_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    wan TEXT NOT NULL,
    server_name TEXT NOT NULL,
    server_host TEXT NOT NULL,
    direction TEXT NOT NULL,
    streams INTEGER NOT NULL,
    sender_mbps REAL,
    receiver_mbps REAL,
    retransmits INTEGER,
    completed INTEGER NOT NULL,
    error TEXT,
    raw_file TEXT
);
CREATE TABLE IF NOT EXISTS route_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    wan TEXT NOT NULL,
    direction TEXT NOT NULL,
    protocol TEXT NOT NULL,
    source TEXT,
    target TEXT NOT NULL,
    final_latency_ms REAL,
    hop_count INTEGER,
    completed INTEGER NOT NULL,
    raw_file TEXT NOT NULL,
    error TEXT
);
CREATE TABLE IF NOT EXISTS collector_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    source_host TEXT NOT NULL,
    accepted INTEGER NOT NULL,
    rejected INTEGER NOT NULL,
    error TEXT
);
"""


def main():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
    Path(DB_PATH).chmod(0o640)
    print(DB_PATH)


if __name__ == "__main__":
    main()

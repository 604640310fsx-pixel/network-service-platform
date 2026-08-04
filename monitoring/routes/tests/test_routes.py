#!/usr/bin/env python3
from __future__ import annotations

import copy
import base64
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path
from unittest import mock

MODULE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(MODULE_ROOT))

from routes.core import (  # noqa: E402
    NonBlockingLock, RouteConfigError, RouteStore, RunResult, in_blackout,
    decode_nexttrace_json, eligible_outbound_targets, load_config, nexttrace_argv,
    normalize_nexttrace, outbound_tasks, return_tasks, route_probe_argv, run_task,
)
from routes.orchestrator import execution_blockers, plan  # noqa: E402
from routes.ingest_and_return import (  # noqa: E402
    BundleValidationError, parse_bundle, process_bundle, read_limited,
)


CONFIG_PATH = MODULE_ROOT / "config" / "routes.json"
R5S_ROUTE_PROBE_PATH = MODULE_ROOT / "r5s" / "route_probe.sh"
R5S_RUN_AND_PUSH_PATH = MODULE_ROOT / "r5s" / "run_and_push.sh"
VPS_ROUTE_RUNNER_PATH = MODULE_ROOT / "routes" / "vps_route_runner.sh"


ROUTE_SCHEMA = """
CREATE TABLE route_runs (
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
)
"""


class RouteConfigTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(CONFIG_PATH)

    def test_enabled_config_and_exact_target_set(self):
        self.assertTrue(self.config["deployment_enabled"])
        names = [item["name"] for item in self.config["vps_targets"]]
        self.assertEqual(len(names), 7)
        self.assertTrue(all("Alibaba" not in name for name in names))
        self.assertTrue(all(item["return_enabled"] for item in self.config["vps_targets"]))
        self.assertEqual(self.config["outbound"]["target_selector"], "return_enabled_confirmed")
        self.assertEqual(self.config["outbound"]["legacy_target"], "DMIT Premium")
        self.assertEqual(len(eligible_outbound_targets(self.config)), 7)

    def test_plan_has_forty_two_outbound_and_forty_two_return(self):
        result = plan(self.config)
        self.assertEqual(result["architecture"], "r5s-local-push-v1")
        self.assertEqual(result["r5s_public_ip_count"], 3)
        self.assertEqual(result["outbound_count"], 42)
        self.assertEqual(result["return_count"], 42)
        self.assertEqual(result["bundle_record_count"], 45)
        self.assertEqual(result["max_bundle_bytes"], 8 * 1024 * 1024)
        self.assertEqual(result["max_concurrent_nexttrace"], 1)
        self.assertEqual(result["worst_case_r5s_seconds"], 3186)
        self.assertEqual(result["worst_case_receiver_seconds"], 3780)
        self.assertEqual(result["worst_case_end_to_end_seconds"], 6966)
        self.assertEqual(result["automatic_retries"], 0)
        self.assertTrue(any("ssh_key=file_missing" in item for item in result["blockers"]))

    def test_return_protocols_are_icmp_then_tcp(self):
        self.assertEqual(self.config["return"]["protocols"], ["icmp", "tcp"])
        self.assertFalse(self.config["return"]["tcp_pending_approval"])

    def test_outbound_plan_covers_every_authorized_target_for_all_wans_and_protocols(self):
        tasks = outbound_tasks(self.config)
        expected = {
            (target["name"], wan, protocol)
            for target in eligible_outbound_targets(self.config)
            for wan in ("telecom", "mobile", "unicom")
            for protocol in ("icmp", "tcp")
        }
        self.assertEqual(
            {(task.target_name, task.wan, task.protocol) for task in tasks},
            expected,
        )
        self.assertEqual(len(tasks), len(expected))

    def test_unconfirmed_or_disabled_target_is_not_scheduled_outbound(self):
        config = copy.deepcopy(self.config)
        config["vps_targets"][1]["authorization_status"] = "pending"
        config["vps_targets"][2]["return_enabled"] = False
        tasks = outbound_tasks(config)
        names = {task.target_name for task in tasks}
        self.assertNotIn(config["vps_targets"][1]["name"], names)
        self.assertNotIn(config["vps_targets"][2]["name"], names)
        self.assertEqual(len(tasks), 30)

    def test_strict_device_and_source_are_both_in_command(self):
        config = copy.deepcopy(self.config)
        config["nexttrace"]["data_provider_approved"] = True
        task = outbound_tasks(config)[1]
        argv = nexttrace_argv(task, config)
        self.assertEqual(argv[argv.index("--dev") + 1], "eth0.20")
        self.assertEqual(argv[argv.index("--source") + 1], "192.0.2.12")
        self.assertEqual(argv[0], "/root/network-monitor/bin/nexttrace-1.7.1")
        self.assertNotEqual(argv[0], "/usr/bin/nexttrace")
        self.assertIn("--tcp", argv)
        self.assertEqual(argv[argv.index("--port") + 1], "20001")

    def test_return_uses_restricted_runner_command(self):
        task = return_tasks(self.config, {"telecom": "198.51.100.10"})[0]
        argv = route_probe_argv(task, self.config)
        self.assertEqual(argv[-1], "route-return icmp 198.51.100.10")
        self.assertNotIn("--dev", argv[-1])
        self.assertNotIn("--source", argv[-1])

        tcp_task = return_tasks(self.config, {"telecom": "198.51.100.10"})[1]
        tcp_argv = route_probe_argv(tcp_task, self.config)
        self.assertEqual(tcp_argv[-1], "route-return tcp 198.51.100.10 20001")

    def test_return_command_exit_zero_without_target_is_incomplete(self):
        task = return_tasks(self.config, {"telecom": "8.8.8.8"})[0]
        payload = {"Hops": [[{
            "Success": True,
            "TTL": 1,
            "RTT": 1_000_000,
            "Address": {"IP": "192.0.2.1"},
            "Geo": {},
        }]]}
        completed = mock.Mock(returncode=0, stdout=json.dumps(payload), stderr="")
        with mock.patch("routes.core.subprocess.run", return_value=completed):
            result = run_task(task, self.config)
        self.assertFalse(result.completed)
        self.assertEqual(result.error, "target_not_reached")

    def test_blackout_is_inclusive(self):
        self.assertTrue(in_blackout(self.config, datetime.fromisoformat("2026-08-03T18:00:00+08:00")))
        self.assertTrue(in_blackout(self.config, datetime.fromisoformat("2026-08-03T19:10:59+08:00")))
        self.assertFalse(in_blackout(self.config, datetime.fromisoformat("2026-08-03T19:11:00+08:00")))

    def test_execution_stays_blocked_until_deployed_key_exists(self):
        blockers = execution_blockers(self.config)
        self.assertTrue(any("ssh_key=file_missing" in item for item in blockers))

    def test_both_route_wrappers_force_reverse_dns(self):
        r5s_wrapper = R5S_ROUTE_PROBE_PATH.read_text(encoding="utf-8")
        vps_wrapper = VPS_ROUTE_RUNNER_PATH.read_text(encoding="utf-8")
        self.assertIn("--always-rdns --json --no-color", r5s_wrapper)
        self.assertEqual(vps_wrapper.count("--always-rdns --json --no-color"), 2)

    def test_r5s_sender_allowlist_matches_configured_outbound_set(self):
        sender = R5S_RUN_AND_PUSH_PATH.read_text(encoding="utf-8")
        for target in eligible_outbound_targets(self.config):
            self.assertIn(
                f'run_outbound_target "{target["name"]}" {target["host"]}',
                sender,
            )
            self.assertIn(f'"{target["name"]}|{target["host"]}"', sender)
        self.assertIn('[ "$sequence" -eq 45 ]', sender)
        self.assertIn("ROUTE_MAX_BUNDLE_BYTES:-8388608", sender)
        self.assertIn("ROUTE_MAX_RECORD_BYTES:-1048576", sender)
        self.assertIn("timeout -k 5s 4500s ssh", sender)


class NormalizationAndStorageTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(CONFIG_PATH)
        self.task = outbound_tasks(self.config)[0]
        self.payload = {
            "Hops": [
                {
                    "Hop": 1,
                    "Address": {"IP": "192.0.2.1", "Hostname": "gateway"},
                    "Latency": [1.0, 1.2, 1.1],
                    "Geo": {"Country": "中国", "Prov": "广东", "City": "广州"},
                },
                {
                    "Hop": 2,
                    "Address": {"IP": self.task.target, "Hostname": "target.example"},
                    "Latency": [10.0, 11.0, 12.0],
                    "Geo": {"Asnumber": "AS4809", "Owner": "China Telecom"},
                },
            ]
        }

    def test_normalizes_hops_without_inventing_missing_fields(self):
        normalized = normalize_nexttrace(self.payload, self.task, {4809})
        self.assertTrue(normalized["completed"])
        self.assertEqual(normalized["hop_count"], 2)
        self.assertEqual(normalized["hops"][0]["ip"], "192.0.2.1")
        self.assertAlmostEqual(normalized["hops"][1]["latency_ms"], 11.0)
        self.assertEqual(normalized["hops"][1]["quality"], "premium")

    def test_nexttrace_15_probe_groups_are_one_hop_and_rtt_is_nanoseconds(self):
        payload = {
            "Hops": [
                [
                    {
                        "TTL": 1,
                        "RTT": 1_749_666,
                        "Address": {"IP": "192.0.2.1", "Hostname": "gateway"},
                        "Geo": {"Country": "中国", "Prov": "广东", "City": "广州"},
                    },
                    {
                        "TTL": 1,
                        "RTT": 2_000_000,
                        "Address": {"IP": "192.0.2.1", "Hostname": "gateway"},
                        "Geo": {"Country": "中国", "Prov": "广东", "City": "广州"},
                    },
                    {
                        "TTL": 1,
                        "RTT": 2_250_334,
                        "Address": {"IP": "192.0.2.1", "Hostname": "gateway"},
                        "Geo": {"Country": "中国", "Prov": "广东", "City": "广州"},
                    },
                ],
                [
                    {
                        "TTL": 2,
                        "RTT": 10_000_000,
                        "Address": {"IP": self.task.target, "Hostname": "target.example"},
                        "Geo": {"Asnumber": "AS4809", "Owner": "China Telecom"},
                    },
                    {
                        "TTL": 2,
                        "RTT": 11_000_000,
                        "Address": {"IP": self.task.target, "Hostname": "target.example"},
                        "Geo": {"Asnumber": "AS4809", "Owner": "China Telecom"},
                    },
                    {
                        "TTL": 2,
                        "RTT": 12_000_000,
                        "Address": {"IP": self.task.target, "Hostname": "target.example"},
                        "Geo": {"Asnumber": "AS4809", "Owner": "China Telecom"},
                    },
                ],
            ]
        }
        normalized = normalize_nexttrace(payload, self.task, {4809})
        self.assertEqual(normalized["hop_count"], 2)
        self.assertAlmostEqual(normalized["hops"][0]["latency_ms"], 2.0, places=6)
        self.assertAlmostEqual(normalized["hops"][1]["latency_ms"], 11.0, places=6)
        self.assertEqual(normalized["hops"][1]["quality"], "premium")
        self.assertTrue(normalized["completed"])

    def test_optional_nexttrace_notice_is_not_part_of_json(self):
        payload = decode_nexttrace_json('[NextTrace API] LeoMoeAPI\n{"Hops":[]}\n')
        self.assertEqual(payload, {"Hops": []})

    def test_reverse_is_merged_from_later_probe_for_same_hop_ip(self):
        payload = {"Hops": [[
            {
                "TTL": 1,
                "RTT": 1_000_000,
                "Address": {"IP": self.task.target},
                "Geo": {},
            },
            {
                "TTL": 1,
                "RTT": 2_000_000,
                "Address": {"IP": self.task.target, "Hostname": "edge.example.com"},
                "Geo": {},
            },
            {
                "TTL": 1,
                "RTT": 3_000_000,
                "Address": {"IP": "198.51.100.99", "Hostname": "other.example.com"},
                "Geo": {},
            },
        ]]}
        normalized = normalize_nexttrace(payload, self.task)
        self.assertEqual(normalized["hops"][0]["ip"], self.task.target)
        self.assertEqual(normalized["hops"][0]["reverse"], "edge.example.com")

    def test_persists_raw_normalized_and_existing_summary_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "data" / "monitor.sqlite3"
            database.parent.mkdir()
            with closing(sqlite3.connect(database)) as conn:
                conn.execute(ROUTE_SCHEMA)
                conn.commit()
            store = RouteStore(database, root / "logs" / "routes")
            store.ensure_schema()
            result = RunResult(
                timestamp="2026-08-03T02:20:00Z",
                completed=True,
                exit_code=0,
                raw_stdout=json.dumps(self.payload),
                raw_stderr="",
                payload=self.payload,
                error=None,
            )
            saved = store.persist(self.task, result, self.config)
            self.assertTrue(Path(saved["raw_file"]).is_file())
            self.assertTrue(Path(saved["normalized_file"]).is_file())
            with closing(sqlite3.connect(database)) as conn:
                row = conn.execute(
                    "SELECT wan,direction,protocol,completed,hop_count,error FROM route_runs"
                ).fetchone()
                columns_after = {item[1] for item in conn.execute("PRAGMA table_info(route_runs)")}
            self.assertEqual(row, ("telecom", "outbound", "icmp", 1, 2, None))
            self.assertEqual(columns_after, {
                "id", "timestamp", "wan", "direction", "protocol", "source", "target",
                "final_latency_ms", "hop_count", "completed", "raw_file", "error",
            })

    def test_lock_is_nonblocking(self):
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / "routes.lock"
            with NonBlockingLock(lock_path):
                with self.assertRaises(Exception) as raised:
                    with NonBlockingLock(lock_path):
                        pass
            self.assertEqual(str(raised.exception), "route_collector_overlap")


def encode_record(
    bundle_id, sequence, record_type, wan, device, source_ip, protocol,
    target, target_name, stdout, exit_code=0,
):
    return json.dumps({
        "schema_version": 1,
        "bundle_id": bundle_id,
        "sequence": sequence,
        "record_type": record_type,
        "timestamp": "2026-08-03T04:20:00Z",
        "wan": wan,
        "device": device,
        "source_ip": source_ip,
        "protocol": protocol,
        "target": target,
        "target_name": target_name,
        "exit_code": exit_code,
        "duration_ms": 1000,
        "stdout_b64": base64.b64encode(stdout.encode()).decode(),
        "stderr_b64": "",
    }, separators=(",", ":")).encode()


def make_bundle(config, *, legacy=False):
    bundle_id = "20260803T042000Z-123"
    lines = []
    public_ips = {"telecom": "8.8.8.8", "mobile": "1.1.1.1", "unicom": "9.9.9.9"}
    sequence = 0
    for wan in ("telecom", "mobile", "unicom"):
        sequence += 1
        binding = config["wans"][wan]
        stdout = json.dumps({
            "wan": wan,
            "source_ip": binding["source_ip"],
            "interface": binding["interface"],
            "public_ip": public_ips[wan],
        })
        lines.append(encode_record(
            bundle_id, sequence, "public_ip", wan, binding["interface"],
            binding["source_ip"], "metadata", config["public_ip"]["endpoint"],
            "public-ip", stdout,
        ))
    targets = eligible_outbound_targets(config)
    if legacy:
        targets = [
            item for item in targets
            if item["name"] == config["outbound"]["legacy_target"]
        ]
    for target in targets:
        for wan in ("telecom", "mobile", "unicom"):
            binding = config["wans"][wan]
            for protocol in ("icmp", "tcp"):
                sequence += 1
                payload = {"Hops": [[{
                    "TTL": 1,
                    "RTT": 10_000_000,
                    "Address": {"IP": target["host"], "Hostname": "target.example"},
                    "Geo": {"Asnumber": "AS4809", "Owner": "China Telecom"},
                }]]}
                lines.append(encode_record(
                    bundle_id, sequence, "outbound_route", wan, binding["interface"],
                    binding["source_ip"], protocol, target["host"], target["name"],
                    json.dumps(payload),
                ))
    return b"\n".join(lines) + b"\n"


class ReversePushBundleTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(CONFIG_PATH)

    def test_bundle_requires_exact_order_and_strict_bindings(self):
        bundle = make_bundle(self.config)
        records = parse_bundle(bundle, self.config)
        self.assertEqual(len(records), 45)
        self.assertEqual(
            [(item.record_type, item.wan, item.protocol) for item in records[:9]],
            [
                ("public_ip", "telecom", "metadata"),
                ("public_ip", "mobile", "metadata"),
                ("public_ip", "unicom", "metadata"),
                ("outbound_route", "telecom", "icmp"),
                ("outbound_route", "telecom", "tcp"),
                ("outbound_route", "mobile", "icmp"),
                ("outbound_route", "mobile", "tcp"),
                ("outbound_route", "unicom", "icmp"),
                ("outbound_route", "unicom", "tcp"),
            ],
        )
        self.assertEqual(records[3].target_name, "DMIT Premium")
        self.assertEqual(records[-1].target_name, "Yecaoyun Cloud")
        bad = bundle.replace(b'"device":"eth0.20"', b'"device":"eth0.10"', 1)
        with self.assertRaisesRegex(BundleValidationError, "wan_binding_mismatch"):
            parse_bundle(bad, self.config)

    def test_legacy_nine_record_bundle_is_strictly_accepted_during_migration(self):
        records = parse_bundle(make_bundle(self.config, legacy=True), self.config)
        self.assertEqual(len(records), 9)
        self.assertTrue(all(
            item.target_name == "DMIT Premium"
            for item in records if item.record_type == "outbound_route"
        ))
        bad = make_bundle(self.config, legacy=True).replace(
            b'"target_name":"DMIT Premium"',
            b'"target_name":"DMIT Eyeball"',
            1,
        )
        with self.assertRaisesRegex(BundleValidationError, "outbound_target_mismatch"):
            parse_bundle(bad, self.config)

    def test_legacy_bundle_gate_can_be_closed_after_sender_migration(self):
        config = copy.deepcopy(self.config)
        config["r5s_push"]["accept_legacy_bundle"] = False
        with self.assertRaisesRegex(BundleValidationError, "record_count_mismatch:9"):
            parse_bundle(make_bundle(config, legacy=True), config)

    def test_full_bundle_rejects_target_name_host_pair_out_of_order(self):
        bundle = make_bundle(self.config)
        bad = bundle.replace(
            b'"target_name":"DMIT Premium"',
            b'"target_name":"DMIT Eyeball"',
            1,
        )
        with self.assertRaisesRegex(BundleValidationError, "outbound_target_mismatch"):
            parse_bundle(bad, self.config)

    def test_size_limit_is_enforced_before_json_parsing(self):
        with self.assertRaisesRegex(BundleValidationError, "bundle_size_limit_exceeded"):
            read_limited(io.BytesIO(b"x" * 11), 10)

    def test_configured_bundle_limit_is_exactly_eight_mib(self):
        limit = self.config["r5s_push"]["max_bundle_bytes"]
        self.assertEqual(limit, 8 * 1024 * 1024)
        with self.assertRaisesRegex(BundleValidationError, "bundle_size_limit_exceeded"):
            read_limited(io.BytesIO(b"x" * (limit + 1)), limit)

    def test_offline_ingest_persists_forty_two_outbound_and_returns_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = copy.deepcopy(self.config)
            config["schedule"]["blackout_start"] = "00:00"
            config["schedule"]["blackout_end"] = "00:00"
            config["paths"] = {
                "database": str(root / "data" / "monitor.sqlite3"),
                "route_logs": str(root / "logs" / "routes"),
                "event_log": str(root / "logs" / "routes" / "events.jsonl"),
                "public_ip_file": str(root / "data" / "public-ip.json"),
                "lock_file": str(root / "routes.lock"),
            }
            Path(config["paths"]["database"]).parent.mkdir(parents=True)
            with closing(sqlite3.connect(config["paths"]["database"])) as conn:
                conn.execute(ROUTE_SCHEMA)
                conn.commit()

            calls = []

            def fake_executor(task, unused_config):
                calls.append((task.target_name, task.wan, task.protocol, task.target))
                payload = {"Hops": [[{
                    "TTL": 1,
                    "RTT": 20_000_000,
                    "Address": {"IP": task.target, "Hostname": "wan.example"},
                    "Geo": {},
                }]]}
                return RunResult(
                    timestamp="2026-08-03T04:21:00Z", completed=True, exit_code=0,
                    raw_stdout=json.dumps(payload), raw_stderr="", payload=payload, error=None,
                )

            result = process_bundle(make_bundle(config), config, executor=fake_executor)
            self.assertEqual(len(calls), 42)
            self.assertEqual(len(set(calls)), 42)
            self.assertEqual(result["counts"]["outbound_completed"], 42)
            self.assertEqual(result["counts"]["return_completed"], 42)
            self.assertEqual(result["counts"]["return_target_not_reached"], 0)
            self.assertEqual(result["counts"]["return_failed"], 0)
            self.assertEqual(result["bundle_layout"], "multi-target-v1")
            with closing(sqlite3.connect(config["paths"]["database"])) as conn:
                rows = conn.execute(
                    "SELECT direction,COUNT(*) FROM route_runs GROUP BY direction ORDER BY direction"
                ).fetchall()
                columns = {item[1] for item in conn.execute("PRAGMA table_info(route_runs)")}
            self.assertEqual(rows, [("outbound", 42), ("return", 42)])
            self.assertEqual(columns, {
                "id", "timestamp", "wan", "direction", "protocol", "source", "target",
                "final_latency_ms", "hop_count", "completed", "raw_file", "error",
            })
            self.assertEqual(json.loads(Path(config["paths"]["public_ip_file"]).read_text())["wans"], {
                "telecom": "8.8.8.8", "mobile": "1.1.1.1", "unicom": "9.9.9.9",
            })

    def test_legacy_ingest_persists_six_outbound_and_labels_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = copy.deepcopy(self.config)
            config["schedule"]["blackout_start"] = "00:00"
            config["schedule"]["blackout_end"] = "00:00"
            config["paths"] = {
                "database": str(root / "data" / "monitor.sqlite3"),
                "route_logs": str(root / "logs" / "routes"),
                "event_log": str(root / "logs" / "routes" / "events.jsonl"),
                "public_ip_file": str(root / "data" / "public-ip.json"),
                "lock_file": str(root / "routes.lock"),
            }
            Path(config["paths"]["database"]).parent.mkdir(parents=True)
            with closing(sqlite3.connect(config["paths"]["database"])) as conn:
                conn.execute(ROUTE_SCHEMA)
                conn.commit()

            def fake_executor(task, unused_config):
                payload = {"Hops": [[{
                    "TTL": 1,
                    "RTT": 20_000_000,
                    "Address": {"IP": task.target},
                    "Geo": {},
                }]]}
                return RunResult(
                    timestamp="2026-08-03T04:21:00Z", completed=True, exit_code=0,
                    raw_stdout=json.dumps(payload), raw_stderr="", payload=payload, error=None,
                )

            result = process_bundle(
                make_bundle(config, legacy=True), config, executor=fake_executor,
            )
            self.assertEqual(result["bundle_layout"], "legacy-dmit-v1")
            self.assertEqual(result["counts"]["outbound_completed"], 6)
            with closing(sqlite3.connect(config["paths"]["database"])) as conn:
                outbound_count = conn.execute(
                    "SELECT COUNT(*) FROM route_runs WHERE direction='outbound'"
                ).fetchone()[0]
            self.assertEqual(outbound_count, 6)

    def test_return_target_not_reached_is_counted_as_sample_not_runner_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = copy.deepcopy(self.config)
            config["schedule"]["blackout_start"] = "00:00"
            config["schedule"]["blackout_end"] = "00:00"
            config["paths"] = {
                "database": str(root / "data" / "monitor.sqlite3"),
                "route_logs": str(root / "logs" / "routes"),
                "event_log": str(root / "logs" / "routes" / "events.jsonl"),
                "public_ip_file": str(root / "data" / "public-ip.json"),
                "lock_file": str(root / "routes.lock"),
            }
            Path(config["paths"]["database"]).parent.mkdir(parents=True)
            with closing(sqlite3.connect(config["paths"]["database"])) as conn:
                conn.execute(ROUTE_SCHEMA)
                conn.commit()

            def filtered_endpoint(task, unused_config):
                payload = {"Hops": [[{
                    "TTL": 1,
                    "RTT": 20_000_000,
                    "Address": {"IP": "192.0.2.1"},
                    "Geo": {},
                }]]}
                return RunResult(
                    timestamp="2026-08-03T04:21:00Z", completed=False, exit_code=0,
                    raw_stdout=json.dumps(payload), raw_stderr="", payload=payload,
                    error="target_not_reached",
                )

            result = process_bundle(make_bundle(config), config, executor=filtered_endpoint)
            self.assertEqual(result["counts"]["return_completed"], 0)
            self.assertEqual(result["counts"]["return_target_not_reached"], 42)
            self.assertEqual(result["counts"]["return_failed"], 0)


if __name__ == "__main__":
    unittest.main()

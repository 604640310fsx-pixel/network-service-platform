#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import http.client
import importlib.util
import io
import json
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock


SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("dashboard_next_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(SERVER)


CATALOG = (
    {
        "name": "Target A",
        "display_name": "账户服务器 A",
        "host": "192.0.2.10",
        "tcp_port": 443,
        "enabled": True,
        "customer_state": "active",
    },
    {
        "name": "Paused B",
        "display_name": "维护中的服务器 B",
        "host": "192.0.2.11",
        "tcp_port": 8443,
        "enabled": False,
        "customer_state": "disabled",
    },
)


class _RowsConnection:
    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback):
        return False

    def execute(self, _source, _parameters=()):
        return self

    def fetchall(self):
        return []


class _RunningDashboard:
    def __init__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, _type, _value, _traceback):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, method, path, *, body=None, headers=None):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=2
        )
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        return response.status, response_headers, payload


class VpsCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.targets_path = Path(self.temp_dir.name) / "targets.json"
        self.path_patch = mock.patch.object(SERVER, "TARGETS_PATH", self.targets_path)
        self.path_patch.start()
        SERVER.VPS_CATALOG_CACHE["signature"] = None
        SERVER.VPS_CATALOG_CACHE["items"] = ()

    def tearDown(self):
        self.path_patch.stop()
        self.temp_dir.cleanup()

    def write_targets(self, targets):
        self.targets_path.write_text(
            json.dumps({"tcp_targets": targets}, ensure_ascii=False),
            encoding="utf-8",
        )

    def test_catalog_defaults_old_config_and_preserves_explicit_lifecycle(self):
        self.write_targets([
            {
                "name": "Active A",
                "display_name": "美国线路 A",
                "host": "192.0.2.10",
                "enabled": True,
                "tcp_port": 20001,
            },
            {
                "name": "Paused B",
                "host": "192.0.2.11",
                "enabled": False,
            },
            {
                "name": "Retired C",
                "host": "192.0.2.12",
                "enabled": True,
                "customer_state": "retired",
            },
        ])

        catalog = SERVER.load_vps_catalog()
        self.assertEqual(
            [(item["name"], item["display_name"], item["customer_state"]) for item in catalog],
            [
                ("Active A", "美国线路 A", "active"),
                ("Paused B", "Paused B", "disabled"),
                ("Retired C", "Retired C", "retired"),
            ],
        )
        self.assertEqual(
            SERVER.target_hosts(),
            {
                "Active A": "192.0.2.10",
                "Paused B": "192.0.2.11",
                "Retired C": "192.0.2.12",
            },
        )

    def test_catalog_reloads_after_add_replace_and_remove(self):
        self.write_targets([
            {"name": "Old A", "host": "192.0.2.20", "enabled": True},
        ])
        self.assertEqual(list(SERVER.target_hosts()), ["Old A"])

        self.write_targets([
            {
                "name": "New Replacement With Longer Name",
                "host": "198.51.100.30",
                "enabled": True,
                "customer_state": "active",
            },
            {
                "name": "New B",
                "host": "198.51.100.31",
                "enabled": False,
                "customer_state": "disabled",
            },
        ])
        self.assertEqual(
            SERVER.target_hosts(),
            {
                "New Replacement With Longer Name": "198.51.100.30",
                "New B": "198.51.100.31",
            },
        )

    def test_catalog_rejects_duplicate_or_unknown_lifecycle(self):
        self.write_targets([
            {"name": "Same", "host": "192.0.2.40", "enabled": True},
            {"name": "Same", "host": "192.0.2.41", "enabled": True},
        ])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            SERVER.load_vps_catalog()

        self.write_targets([
            {
                "name": "Invalid State",
                "host": "192.0.2.42",
                "enabled": True,
                "customer_state": "deleted",
            },
        ])
        with self.assertRaisesRegex(ValueError, "customer state"):
            SERVER.load_vps_catalog()

        self.write_targets([
            {
                "name": "Null State",
                "host": "192.0.2.43",
                "enabled": True,
                "customer_state": None,
            },
        ])
        with self.assertRaisesRegex(ValueError, "customer state"):
            SERVER.load_vps_catalog()


class DashboardVpsApiTests(unittest.TestCase):
    def setUp(self):
        self.catalog_patch = mock.patch.object(
            SERVER, "load_vps_catalog", return_value=CATALOG
        )
        self.connect_patch = mock.patch.object(
            SERVER, "connect", return_value=_RowsConnection()
        )
        self.catalog_patch.start()
        self.connect_patch.start()
        self.previous_state = dict(SERVER.NEZHA_STATE)
        with SERVER.NEZHA_LOCK:
            SERVER.NEZHA_STATE.update(
                {
                    "connected": True,
                    "updated_at": "2030-01-01T00:01:00Z",
                    "updated_monotonic": time.monotonic(),
                    "targets": {
                        "Target A": {
                            "target_name": "Target A",
                            "target_host": "192.0.2.10",
                            "online": True,
                            "last_active": "2030-01-01T00:01:00Z",
                        }
                    },
                    "error": None,
                }
            )

    def tearDown(self):
        with SERVER.NEZHA_LOCK:
            SERVER.NEZHA_STATE.clear()
            SERVER.NEZHA_STATE.update(self.previous_state)
        self.connect_patch.stop()
        self.catalog_patch.stop()

    def test_catalog_and_exact_target_status_are_private_raw_json(self):
        with _RunningDashboard() as server:
            status, headers, body = server.request("GET", "/api/vps-targets")
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            payload = json.loads(body)
            self.assertEqual(set(payload), {"targets"})
            self.assertEqual(payload["targets"][0]["target_name"], "Target A")
            self.assertEqual(payload["targets"][0]["customer_state"], "active")

            status, headers, body = server.request(
                "GET", "/api/vps-status?target=Target%20A"
            )
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            payload = json.loads(body)
            self.assertEqual(payload["target"], "Target A")
            self.assertEqual(payload["source_status"], "ok")
            self.assertTrue(payload["fresh"])
            self.assertTrue(payload["item"]["online"])

            status, _, body = server.request(
                "GET", "/api/vps-status?target=Missing"
            )
            self.assertEqual(status, 404)
            self.assertEqual(json.loads(body), {"error": "unknown target"})

    def test_status_requires_one_exact_target_and_never_uses_a_default(self):
        invalid_queries = (
            "",
            "?target=",
            "?target=Target%20A&target=Paused%20B",
            "?target=Target%20A&extra=",
            "?extra=Target%20A",
            "?target=%20Target%20A",
            "?target=Target%20A%20",
            "?target=bad%00key",
            "?target=%FF",
            "?target=%",
        )
        with _RunningDashboard() as server:
            for query in invalid_queries:
                with self.subTest(query=query):
                    status, _, body = server.request(
                        "GET", f"/api/vps-status{query}"
                    )
                    self.assertEqual(status, 400)
                    self.assertEqual(json.loads(body), {"error": "invalid request"})

    def test_catalog_and_status_reject_request_bodies_and_non_get_methods(self):
        with _RunningDashboard() as server:
            for path in (
                "/api/vps-targets",
                "/api/vps-status?target=Target%20A",
            ):
                status, _, body = server.request("GET", path, body=b"{}")
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(body), {"error": "invalid request"})

                for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"):
                    status, headers, body = server.request(method, path)
                    self.assertEqual(status, 405)
                    self.assertEqual(headers.get("Allow"), "GET")
                    self.assertEqual(json.loads(body), {"error": "method not allowed"})

                status, headers, body = server.request("HEAD", path)
                self.assertEqual(status, 405)
                self.assertEqual(headers.get("Allow"), "GET")
                self.assertEqual(body, b"")

    def test_request_logging_never_emits_the_target_query(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), _RunningDashboard() as server:
            status, _, _ = server.request(
                "GET", "/api/vps-status?target=Sensitive%20Target"
            )
            self.assertEqual(status, 404)
        self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

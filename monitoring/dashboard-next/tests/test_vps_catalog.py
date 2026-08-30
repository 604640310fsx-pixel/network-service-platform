#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("dashboard_next_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(SERVER)


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


if __name__ == "__main__":
    unittest.main()

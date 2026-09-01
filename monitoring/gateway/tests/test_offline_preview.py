#!/usr/bin/env python3

from __future__ import annotations

import http.client
import json
import threading
import unittest
from datetime import datetime, timezone

from monitoring.gateway.offline_preview import (
    build_offline_fixture,
    build_preview_server,
    validate_preview_parent_origin,
)
from monitoring.gateway.security import SecurityBoundaryError, scan_public_value


NOW = datetime(2030, 1, 1, tzinfo=timezone.utc)


class OfflinePreviewTests(unittest.TestCase):
    def test_fixture_is_deterministic_allowlisted_and_visibly_nonproduction(self):
        first = build_offline_fixture(now=NOW, phase=0)
        second = build_offline_fixture(now=NOW, phase=1)
        self.assertEqual(scan_public_value(first), [])
        self.assertNotEqual(first, second)
        self.assertEqual([item["wanId"] for item in first["wans"]], ["telecom", "mobile", "unicom"])
        self.assertTrue(all(item["status"] == "healthy" for item in first["wans"]))

    def test_preview_server_is_loopback_only_and_uses_the_public_contract(self):
        server = build_preview_server(
            port=0,
            parent_origin="http://127.0.0.1:4173",
        )
        self.assertEqual(server.server_address[0], "127.0.0.1")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1", server.server_address[1], timeout=2
            )
            connection.request("GET", "/api/summary")
            response = connection.getresponse()
            body = response.read()
            headers = dict(response.getheaders())
            connection.close()
            self.assertEqual(response.status, 200)
            self.assertEqual(headers.get("Cache-Control"), "no-store")
            self.assertEqual(scan_public_value(json.loads(body)), [])

            connection = http.client.HTTPConnection(
                "127.0.0.1", server.server_address[1], timeout=2
            )
            connection.request("GET", "/")
            response = connection.getresponse()
            body = response.read()
            headers = dict(response.getheaders())
            connection.close()
            self.assertEqual(response.status, 200)
            self.assertIn(
                "frame-ancestors http://127.0.0.1:4173",
                headers.get("Content-Security-Policy", ""),
            )
            self.assertIn(
                b'<meta name="monitor-parent-origin" content="http://127.0.0.1:4173">',
                body,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_preview_parent_origin_accepts_only_exact_loopback_authority(self):
        self.assertEqual(validate_preview_parent_origin(None), "'none'")
        self.assertEqual(
            validate_preview_parent_origin("http://localhost:4173"),
            "http://localhost:4173",
        )
        self.assertEqual(
            validate_preview_parent_origin("https://[::1]:4443"),
            "https://[::1]:4443",
        )
        for value in (
            "http://10.0.0.2:4173",
            "https://8.8.8.8",
            "http://127.0.0.1:4173/path",
            "http://user:pass@127.0.0.1:4173",
        ):
            with self.subTest(value=value), self.assertRaises(SecurityBoundaryError):
                validate_preview_parent_origin(value)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3

from __future__ import annotations

import http.client
import json
import threading
import unittest
from datetime import datetime, timezone

from monitoring.gateway.offline_preview import build_offline_fixture, build_preview_server
from monitoring.gateway.security import scan_public_value


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
        server = build_preview_server(port=0)
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
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()

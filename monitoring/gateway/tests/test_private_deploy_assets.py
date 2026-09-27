"""Private gateway deployment assets for the account /status path.

Binds the systemd unit and the environment template to what server.py actually
reads in private mode, so the deployed listener serves the Auth routes that
website /status depends on and fails closed until approved bindings exist.
"""

from __future__ import annotations

import ipaddress
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from monitoring.gateway import server
from monitoring.gateway.client import AUTH_SERVICE_IDENTITY, PUBLIC_BFF_IDENTITY, Origin
from monitoring.gateway.security import SecurityBoundaryError


GATEWAY = Path(__file__).resolve().parents[1]
DEPLOY = GATEWAY / "deploy"
ENV_TEMPLATE = DEPLOY / "private.env.example"
UNIT = DEPLOY / "systemd" / "monitor-gateway-private.service"

# Settings private mode reads when the raw origin is plain loopback HTTP and
# the Auth Service identity is bound for /status.
PRIVATE_STATUS_KEYS = {
    "PRIVATE_MONITOR_BIND_HOST",
    "PRIVATE_MONITOR_PORT",
    "PRIVATE_MONITOR_TLS_CERT_FILE",
    "PRIVATE_MONITOR_TLS_KEY_FILE",
    "PRIVATE_MONITOR_CLIENT_CA_FILE",
    "PUBLIC_BFF_IDENTITY_CERT_FILE",
    "AUTH_SERVICE_IDENTITY_CERT_FILE",
    "PUBLIC_SERVER_STATUS_TARGET",
    "RAW_MONITOR_API_ORIGIN",
}


def _template() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in ENV_TEMPLATE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, value = stripped.partition("=")
        if not separator or key in values:
            raise AssertionError(f"malformed or duplicate template line: {key}")
        values[key] = value
    return values


def _unit() -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for line in UNIT.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.startswith(("#", "[")):
            key, _, value = line.partition("=")
            directives.setdefault(key, []).append(value)
    return directives


class PrivateEnvTemplateTests(unittest.TestCase):
    def test_template_covers_exactly_the_private_status_settings(self):
        keys = set(_template())
        self.assertEqual(keys, PRIVATE_STATUS_KEYS)
        source = (GATEWAY / "server.py").read_text(encoding="utf-8")
        for key in keys:
            self.assertIn(f'"{key}"', source, key)

    def test_auth_service_identity_is_bound_because_status_needs_it(self):
        self.assertTrue(_template()["AUTH_SERVICE_IDENTITY_CERT_FILE"].strip())
        with tempfile.TemporaryDirectory() as directory:
            public = Path(directory, "public-bff-client.crt")
            auth = Path(directory, "auth-service-client.crt")
            public.write_text("placeholder", encoding="utf-8")
            auth.write_text("placeholder", encoding="utf-8")
            environment = {
                "PUBLIC_BFF_IDENTITY_CERT_FILE": str(public),
                "AUTH_SERVICE_IDENTITY_CERT_FILE": str(auth),
            }
            with mock.patch.dict(os.environ, environment, clear=True):
                files = server._optional_identity_files()
            self.assertEqual(set(files), {PUBLIC_BFF_IDENTITY, AUTH_SERVICE_IDENTITY})
            with mock.patch.dict(
                os.environ, {"PUBLIC_BFF_IDENTITY_CERT_FILE": str(public)}, clear=True
            ):
                without_auth = server._optional_identity_files()
            self.assertNotIn(AUTH_SERVICE_IDENTITY, without_auth)

    def test_unfilled_private_binding_fails_closed(self):
        template = _template()
        self.assertEqual(template["PRIVATE_MONITOR_BIND_HOST"], "")
        self.assertEqual(template["PRIVATE_MONITOR_PORT"], "")
        with mock.patch.dict(os.environ, template, clear=True):
            with self.assertRaisesRegex(
                SecurityBoundaryError, "PRIVATE_MONITOR_BIND_HOST is required"
            ):
                server.run_private()

    def test_raw_origin_is_loopback_http_and_accepted_as_private(self):
        origin = Origin.private(_template()["RAW_MONITOR_API_ORIGIN"], require_https=False)
        self.assertEqual(origin.scheme, "http")
        self.assertTrue(ipaddress.ip_address(origin.host).is_loopback)

    def test_template_holds_no_addresses_or_key_material(self):
        text = ENV_TEMPLATE.read_text(encoding="utf-8")
        self.assertNotIn("BEGIN", text)
        for literal in re.findall(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", text):
            self.assertTrue(ipaddress.ip_address(literal).is_loopback, literal)
        for key, value in _template().items():
            if key.endswith("_FILE"):
                self.assertTrue(value.startswith("/etc/monitor-gateway/pki/"), key)


class PrivateUnitTests(unittest.TestCase):
    def test_unit_runs_private_mode_from_the_installed_template(self):
        directives = _unit()
        self.assertEqual(directives["EnvironmentFile"], ["/etc/monitor-gateway/private.env"])
        self.assertEqual(
            directives["ExecStart"], ["/usr/bin/python3 -m monitoring.gateway.server private"]
        )

    def test_unit_is_unprivileged_and_hardened(self):
        directives = _unit()
        self.assertNotIn(directives["User"][0], ("", "root"))
        for key, expected in {
            "NoNewPrivileges": "true",
            "ProtectSystem": "strict",
            "ProtectHome": "true",
            "PrivateTmp": "true",
            "CapabilityBoundingSet": "",
            "UMask": "0077",
        }.items():
            self.assertEqual(directives[key], [expected], key)


if __name__ == "__main__":
    unittest.main()

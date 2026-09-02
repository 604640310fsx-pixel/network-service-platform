#!/usr/bin/env python3
"""Fail-closed renderer for monitor-gateway private staging assets.

The input manifest is an operator-held runtime document. It may contain network
and origin values, so failures identify only a stable field path and never echo
the value. Generated files are refused inside the repository and are never
printed to stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit


SCHEMA_VERSION = "MGW-PRIVATE-STAGING-MANIFEST-V1"
MANIFEST_FINGERPRINT = (
    "6894f212e2ddc4edfbee08f94fea1452771f6a054d9544b4a807fb70e96470b4"
)
CANDIDATE_SET_FINGERPRINT = (
    "8e54e9574717d882bfb9dc0ca56840bd63959ff20f70b463f230089d8973f0a5"
)
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEPLOY_ROOT = Path(__file__).resolve().parent
NGINX_TEMPLATE = DEPLOY_ROOT / "nginx" / "monitor-gateway-server.conf"
RELEASE_ROOT = Path("/opt/network-service-platform/monitor-gateway/releases")
CURRENT_LINK = Path("/opt/network-service-platform/monitor-gateway/current")
ENV_DIRECTORY = Path("/etc/monitor-gateway")
PKI_DIRECTORY = ENV_DIRECTORY / "pki"

_SHA40 = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_STABLE_ID = re.compile(r"MGW-[A-Z0-9-]+-V1\Z")
_CREDENTIAL_ID = re.compile(r"MGW-CREDENTIAL-[A-Z0-9-]+-V1\Z")
_INTERFACE = re.compile(r"[A-Za-z0-9_=+.-]{1,15}\Z")
_DNS_NAME = re.compile(
    r"(?=.{1,253}\Z)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\Z"
)
_SAFE_ANCHOR = re.compile(r"[A-Za-z0-9_.:/@+-]{1,1024}\Z")
_SAFE_NGINX_LISTEN = re.compile(r"[A-Za-z0-9_.:\[\]-]+(?:[ \t]+ssl)\Z")
_PEM_OR_SECRET_BODY = re.compile(
    r"-----" r"BEGIN|PRIVATE[ _-]?KEY|PASSWORD\s*=|TOKEN\s*=|SECRET\s*=",
    re.IGNORECASE,
)


class ManifestError(ValueError):
    """A deliberately redacted manifest failure."""

    def __init__(self, code: str, path: str) -> None:
        self.code = code
        self.path = path
        super().__init__(f"{code} at {path}")


def _fail(code: str, path: str) -> None:
    raise ManifestError(code, path)


def _mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        _fail("invalid_type", path)
    return value


def _exact_keys(
    value: Mapping[str, Any],
    *,
    required: set[str],
    optional: set[str] = frozenset(),
    path: str,
) -> None:
    missing = required - set(value)
    if missing:
        _fail("missing_field", f"{path}.{sorted(missing)[0]}")
    extra = set(value) - required - optional
    if extra:
        _fail("extra_field", f"{path}.{sorted(extra)[0]}")


def _string(value: Any, path: str, *, maximum: int = 1024) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        _fail("invalid_string", path)
    if any(character in value for character in ("\x00", "\r", "\n")):
        _fail("control_character", path)
    if _PEM_OR_SECRET_BODY.search(value):
        _fail("credential_body_forbidden", path)
    return value


def _constant(value: Any, expected: Any, path: str) -> None:
    if value != expected:
        _fail("authority_mismatch", path)


def _integer(value: Any, path: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail("invalid_integer", path)
    if not minimum <= value <= maximum:
        _fail("integer_out_of_range", path)
    return value


def _absolute_path(value: Any, path: str, *, under: Path | None = None) -> Path:
    text = _string(value, path)
    candidate = Path(text)
    if not candidate.is_absolute() or ".." in candidate.parts:
        _fail("unsafe_path", path)
    if candidate in (Path("/"), Path("/etc"), Path("/opt"), Path("/var")):
        _fail("broad_path_forbidden", path)
    if under is not None:
        try:
            candidate.relative_to(under)
        except ValueError:
            _fail("path_outside_boundary", path)
    return candidate


def _stable_value(
    value: Any,
    path: str,
    *,
    expected_id: str,
) -> str:
    item = _mapping(value, path)
    _exact_keys(item, required={"stableId", "value"}, path=path)
    _constant(item["stableId"], expected_id, f"{path}.stableId")
    return _string(item["value"], f"{path}.value")


def _private_ipv4(value: Any, path: str) -> ipaddress.IPv4Address:
    text = _string(value, path, maximum=64)
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        _fail("invalid_ipv4", path)
    if not isinstance(address, ipaddress.IPv4Address):
        _fail("ipv4_required", path)
    private_ranges = (
        ipaddress.ip_network("10.0.0.0/8"),
        ipaddress.ip_network("172.16.0.0/12"),
        ipaddress.ip_network("192.168.0.0/16"),
    )
    if address not in ipaddress.ip_network("127.0.0.0/8") and not any(
        address in network for network in private_ranges
    ):
        _fail("private_ipv4_required", path)
    return address


def _origin(
    value: str,
    path: str,
    *,
    https_only: bool,
    private_host: bool,
) -> tuple[str, str, int]:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        _fail("invalid_origin", path)
    if parsed.scheme not in ({"https"} if https_only else {"http", "https"}):
        _fail("invalid_origin_scheme", path)
    if (
        not parsed.hostname
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        _fail("origin_authority_only", path)
    if private_host:
        _private_ipv4(parsed.hostname, path)
    return parsed.scheme, parsed.hostname, port


def _canonical_origin(value: str, path: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        _fail("invalid_origin", path)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not _DNS_NAME.fullmatch(parsed.hostname)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        _fail("canonical_https_origin_required", path)
    if port is not None and not 1 <= port <= 65535:
        _fail("invalid_origin_port", path)
    return value


def _pki_item(
    value: Any,
    path: str,
    *,
    source_id: str,
    target_file: Path,
    target_key_file: Path | None,
    san_required: bool,
) -> dict[str, str]:
    item = _mapping(value, path)
    required = {"credentialSourceId", "targetFile"}
    optional: set[str] = set()
    if target_key_file is not None:
        required.add("targetKeyFile")
    if san_required:
        required.add("expectedSan")
    _exact_keys(item, required=required, optional=optional, path=path)
    _constant(item["credentialSourceId"], source_id, f"{path}.credentialSourceId")
    _constant(item["targetFile"], str(target_file), f"{path}.targetFile")
    if target_key_file is not None:
        _constant(
            item["targetKeyFile"], str(target_key_file), f"{path}.targetKeyFile"
        )
    result = {
        "credentialSourceId": source_id,
        "targetFile": str(target_file),
    }
    if target_key_file is not None:
        result["targetKeyFile"] = str(target_key_file)
    if san_required:
        result["expectedSan"] = _string(
            item["expectedSan"], f"{path}.expectedSan", maximum=253
        )
    return result


def validate_manifest(
    document: Any,
    *,
    expected_release_sha: str | None = None,
) -> dict[str, Any]:
    """Validate every security-critical field without returning partial state."""

    root = _mapping(document, "manifest")
    root_keys = {
        "schemaVersion",
        "authority",
        "release",
        "service",
        "network",
        "origins",
        "pki",
        "nginx",
        "anchors",
        "baselines",
        "backup",
        "residue",
    }
    _exact_keys(root, required=root_keys, path="manifest")
    _constant(root["schemaVersion"], SCHEMA_VERSION, "manifest.schemaVersion")

    authority = _mapping(root["authority"], "manifest.authority")
    _exact_keys(
        authority,
        required={"manifestFingerprint", "candidateSetFingerprint", "collisionChecked"},
        path="manifest.authority",
    )
    _constant(
        authority["manifestFingerprint"],
        MANIFEST_FINGERPRINT,
        "manifest.authority.manifestFingerprint",
    )
    _constant(
        authority["candidateSetFingerprint"],
        CANDIDATE_SET_FINGERPRINT,
        "manifest.authority.candidateSetFingerprint",
    )
    _constant(authority["collisionChecked"], True, "manifest.authority.collisionChecked")

    release = _mapping(root["release"], "manifest.release")
    _exact_keys(release, required={"sha", "installDirectory"}, path="manifest.release")
    release_sha = _string(release["sha"], "manifest.release.sha", maximum=40)
    if not _SHA40.fullmatch(release_sha):
        _fail("invalid_release_sha", "manifest.release.sha")
    if expected_release_sha is not None and release_sha != expected_release_sha:
        _fail("release_sha_mismatch", "manifest.release.sha")
    release_directory = _absolute_path(
        release["installDirectory"], "manifest.release.installDirectory"
    )
    if release_directory != RELEASE_ROOT / release_sha:
        _fail("release_path_sha_mismatch", "manifest.release.installDirectory")

    service = _mapping(root["service"], "manifest.service")
    _exact_keys(
        service,
        required={"user", "group", "envDirectory", "releaseRoot", "currentLink", "python"},
        path="manifest.service",
    )
    constants = {
        "user": "monitor-gateway",
        "group": "monitor-gateway",
        "envDirectory": str(ENV_DIRECTORY),
        "releaseRoot": str(RELEASE_ROOT),
        "currentLink": str(CURRENT_LINK),
        "python": "/usr/bin/python3",
    }
    for name, expected in constants.items():
        _constant(service[name], expected, f"manifest.service.{name}")

    network = _mapping(root["network"], "manifest.network")
    _exact_keys(
        network,
        required={"privateListener", "publicListener", "wireguard"},
        path="manifest.network",
    )
    listeners: dict[str, Mapping[str, Any]] = {}
    for name, stable_id in (
        ("privateListener", "MGW-PRIVATE-LOOPBACK-LISTENER-V1"),
        ("publicListener", "MGW-PUBLIC-LOOPBACK-LISTENER-V1"),
    ):
        listener_path = f"manifest.network.{name}"
        listener = _mapping(network[name], listener_path)
        _exact_keys(listener, required={"stableId", "host", "port"}, path=listener_path)
        _constant(listener["stableId"], stable_id, f"{listener_path}.stableId")
        _constant(listener["host"], "127.0.0.1", f"{listener_path}.host")
        _integer(listener["port"], f"{listener_path}.port", minimum=1, maximum=65535)
        listeners[name] = listener
    if listeners["privateListener"]["port"] == listeners["publicListener"]["port"]:
        _fail("listener_collision", "manifest.network")

    wireguard = _mapping(network["wireguard"], "manifest.network.wireguard")
    wg_keys = {
        "interfaceStableId",
        "interfaceName",
        "prefixStableId",
        "prefix",
        "webAddressStableId",
        "webAddress",
        "fnosAddressStableId",
        "fnosAddress",
        "webEndpointStableId",
        "webEndpointHost",
        "webEndpointPort",
        "webPrivateKeySourceId",
        "fnosPublicKeySourceId",
        "webPeerAllowedIp",
        "fnosPeerAllowedIp",
        "persistentKeepalive",
        "webIsUdpReceiver",
        "fnosInitiatesOutbound",
        "fnosOutputChainDeltaRequired",
    }
    _exact_keys(wireguard, required=wg_keys, path="manifest.network.wireguard")
    wg_constants = {
        "interfaceStableId": "MGW-WG-INTERFACE-V1",
        "prefixStableId": "MGW-WG-PREFIX-V1",
        "webAddressStableId": "MGW-WG-WEB-ADDRESS-V1",
        "fnosAddressStableId": "MGW-WG-FNOS-ADDRESS-V1",
        "webEndpointStableId": "MGW-WG-WEB-UDP-ENDPOINT-V1",
        "webPrivateKeySourceId": "MGW-CREDENTIAL-WG-WEB-PRIVATE-V1",
        "fnosPublicKeySourceId": "MGW-CREDENTIAL-WG-FNOS-PUBLIC-V1",
        "persistentKeepalive": 25,
        "webIsUdpReceiver": True,
        "fnosInitiatesOutbound": True,
        "fnosOutputChainDeltaRequired": False,
    }
    for name, expected in wg_constants.items():
        _constant(wireguard[name], expected, f"manifest.network.wireguard.{name}")
    interface_name = _string(
        wireguard["interfaceName"], "manifest.network.wireguard.interfaceName", maximum=15
    )
    if not _INTERFACE.fullmatch(interface_name):
        _fail("invalid_interface", "manifest.network.wireguard.interfaceName")
    prefix_text = _string(wireguard["prefix"], "manifest.network.wireguard.prefix", maximum=64)
    try:
        prefix = ipaddress.ip_network(prefix_text, strict=True)
    except ValueError:
        _fail("invalid_wireguard_prefix", "manifest.network.wireguard.prefix")
    if not isinstance(prefix, ipaddress.IPv4Network) or not 16 <= prefix.prefixlen <= 30:
        _fail("bounded_ipv4_prefix_required", "manifest.network.wireguard.prefix")
    web_address = _private_ipv4(
        wireguard["webAddress"], "manifest.network.wireguard.webAddress"
    )
    fnos_address = _private_ipv4(
        wireguard["fnosAddress"], "manifest.network.wireguard.fnosAddress"
    )
    if (
        web_address.is_loopback
        or fnos_address.is_loopback
        or web_address not in prefix
        or fnos_address not in prefix
        or web_address in {prefix.network_address, prefix.broadcast_address}
        or fnos_address in {prefix.network_address, prefix.broadcast_address}
        or web_address == fnos_address
    ):
        _fail("wireguard_address_collision", "manifest.network.wireguard")
    try:
        endpoint_address = ipaddress.ip_address(
            _string(
                wireguard["webEndpointHost"],
                "manifest.network.wireguard.webEndpointHost",
                maximum=253,
            )
        )
    except ValueError:
        _fail("literal_endpoint_required", "manifest.network.wireguard.webEndpointHost")
    documentation_endpoint = endpoint_address in ipaddress.ip_network("192.0.2.0/24")
    if (
        not isinstance(endpoint_address, ipaddress.IPv4Address)
        or endpoint_address.is_unspecified
        or endpoint_address.is_loopback
        or endpoint_address.is_link_local
        or endpoint_address.is_multicast
        or (not endpoint_address.is_global and not documentation_endpoint)
    ):
        _fail("ipv4_endpoint_required", "manifest.network.wireguard.webEndpointHost")
    _integer(
        wireguard["webEndpointPort"],
        "manifest.network.wireguard.webEndpointPort",
        minimum=1,
        maximum=65535,
    )
    for name, expected in (
        ("webPeerAllowedIp", f"{fnos_address}/32"),
        ("fnosPeerAllowedIp", f"{web_address}/32"),
    ):
        if wireguard[name] != expected:
            _fail("single_host_route_required", f"manifest.network.wireguard.{name}")

    origins = _mapping(root["origins"], "manifest.origins")
    _exact_keys(
        origins,
        required={"rawMonitorApi", "privateMonitorApi", "canonicalWebsite"},
        path="manifest.origins",
    )
    raw_origin = _stable_value(
        origins["rawMonitorApi"],
        "manifest.origins.rawMonitorApi",
        expected_id="MGW-RAW-MONITOR-ORIGIN-V1",
    )
    raw_scheme, raw_host, _ = _origin(
        raw_origin,
        "manifest.origins.rawMonitorApi.value",
        https_only=False,
        private_host=True,
    )
    if ipaddress.ip_address(raw_host) != fnos_address:
        _fail("raw_origin_peer_mismatch", "manifest.origins.rawMonitorApi.value")
    private_origin = _stable_value(
        origins["privateMonitorApi"],
        "manifest.origins.privateMonitorApi",
        expected_id="MGW-PRIVATE-MONITOR-ORIGIN-V1",
    )
    _, private_host, private_port = _origin(
        private_origin,
        "manifest.origins.privateMonitorApi.value",
        https_only=True,
        private_host=True,
    )
    if private_host != "127.0.0.1" or private_port != listeners["privateListener"]["port"]:
        _fail("private_origin_listener_mismatch", "manifest.origins.privateMonitorApi.value")
    canonical_origin = _stable_value(
        origins["canonicalWebsite"],
        "manifest.origins.canonicalWebsite",
        expected_id="MGW-NGINX-CANONICAL-ORIGIN-V1",
    )
    _canonical_origin(canonical_origin, "manifest.origins.canonicalWebsite.value")

    pki = _mapping(root["pki"], "manifest.pki")
    required_pki = {
        "runtimeDirectory",
        "leafValidityDays",
        "rotationStartsDaysRemaining",
        "readinessClosesHoursRemaining",
        "publicCa",
        "publicServer",
        "privateCa",
        "privateServer",
        "publicBffClient",
    }
    optional_pki = {"publicBffClientNext", "rawMonitorCa"}
    _exact_keys(pki, required=required_pki, optional=optional_pki, path="manifest.pki")
    _constant(pki["runtimeDirectory"], str(PKI_DIRECTORY), "manifest.pki.runtimeDirectory")
    _constant(pki["leafValidityDays"], 90, "manifest.pki.leafValidityDays")
    _constant(
        pki["rotationStartsDaysRemaining"],
        30,
        "manifest.pki.rotationStartsDaysRemaining",
    )
    _constant(
        pki["readinessClosesHoursRemaining"],
        24,
        "manifest.pki.readinessClosesHoursRemaining",
    )
    pki_items = {
        "publicCa": _pki_item(
            pki["publicCa"],
            "manifest.pki.publicCa",
            source_id="MGW-CREDENTIAL-PUBLIC-CA-V1",
            target_file=PKI_DIRECTORY / "public-ca.pem",
            target_key_file=None,
            san_required=False,
        ),
        "publicServer": _pki_item(
            pki["publicServer"],
            "manifest.pki.publicServer",
            source_id="MGW-CREDENTIAL-PUBLIC-SERVER-LEAF-V1",
            target_file=PKI_DIRECTORY / "public-server.crt",
            target_key_file=PKI_DIRECTORY / "public-server.key",
            san_required=True,
        ),
        "privateCa": _pki_item(
            pki["privateCa"],
            "manifest.pki.privateCa",
            source_id="MGW-CREDENTIAL-PRIVATE-CA-V1",
            target_file=PKI_DIRECTORY / "private-ca.pem",
            target_key_file=None,
            san_required=False,
        ),
        "privateServer": _pki_item(
            pki["privateServer"],
            "manifest.pki.privateServer",
            source_id="MGW-CREDENTIAL-PRIVATE-SERVER-LEAF-V1",
            target_file=PKI_DIRECTORY / "private-server.crt",
            target_key_file=PKI_DIRECTORY / "private-server.key",
            san_required=True,
        ),
        "publicBffClient": _pki_item(
            pki["publicBffClient"],
            "manifest.pki.publicBffClient",
            source_id="MGW-CREDENTIAL-PUBLIC-BFF-CLIENT-LEAF-V1",
            target_file=PKI_DIRECTORY / "public-bff-client.crt",
            target_key_file=PKI_DIRECTORY / "public-bff-client.key",
            san_required=False,
        ),
    }
    if "publicBffClientNext" in pki:
        pki_items["publicBffClientNext"] = _pki_item(
            pki["publicBffClientNext"],
            "manifest.pki.publicBffClientNext",
            source_id="MGW-CREDENTIAL-PUBLIC-BFF-CLIENT-NEXT-LEAF-V1",
            target_file=PKI_DIRECTORY / "public-bff-client-next.crt",
            target_key_file=PKI_DIRECTORY / "public-bff-client-next.key",
            san_required=False,
        )
    if raw_scheme == "https":
        if "rawMonitorCa" not in pki:
            _fail("missing_field", "manifest.pki.rawMonitorCa")
        pki_items["rawMonitorCa"] = _pki_item(
            pki["rawMonitorCa"],
            "manifest.pki.rawMonitorCa",
            source_id="MGW-CREDENTIAL-RAW-MONITOR-CA-V1",
            target_file=PKI_DIRECTORY / "raw-monitor-ca.pem",
            target_key_file=None,
            san_required=False,
        )
    elif "rawMonitorCa" in pki:
        _fail("unused_security_input", "manifest.pki.rawMonitorCa")
    source_ids = [item["credentialSourceId"] for item in pki_items.values()]
    if len(source_ids) != len(set(source_ids)):
        _fail("credential_source_collision", "manifest.pki")

    nginx = _mapping(root["nginx"], "manifest.nginx")
    nginx_keys = {
        "listen",
        "serverName",
        "edgeCertificateFile",
        "edgeKeyFile",
        "publicGatewayTlsName",
        "publicGatewayCaFile",
    }
    _exact_keys(nginx, required=nginx_keys, path="manifest.nginx")
    nginx_listen = _string(nginx["listen"], "manifest.nginx.listen", maximum=128)
    if not _SAFE_NGINX_LISTEN.fullmatch(nginx_listen):
        _fail("tls_listen_required", "manifest.nginx.listen")
    server_name = _string(nginx["serverName"], "manifest.nginx.serverName", maximum=253)
    tls_name = _string(
        nginx["publicGatewayTlsName"],
        "manifest.nginx.publicGatewayTlsName",
        maximum=253,
    )
    if not _DNS_NAME.fullmatch(server_name) or not _DNS_NAME.fullmatch(tls_name):
        _fail("dns_name_required", "manifest.nginx")
    edge_certificate = _absolute_path(
        nginx["edgeCertificateFile"], "manifest.nginx.edgeCertificateFile"
    )
    edge_key = _absolute_path(nginx["edgeKeyFile"], "manifest.nginx.edgeKeyFile")
    if not _SAFE_ANCHOR.fullmatch(str(edge_certificate)) or not _SAFE_ANCHOR.fullmatch(
        str(edge_key)
    ):
        _fail("nginx_path_unsafe", "manifest.nginx")
    if edge_certificate == edge_key:
        _fail("certificate_key_collision", "manifest.nginx")
    _constant(
        nginx["publicGatewayCaFile"],
        str(PKI_DIRECTORY / "public-ca.pem"),
        "manifest.nginx.publicGatewayCaFile",
    )
    if pki_items["publicServer"]["expectedSan"] != tls_name:
        _fail("public_san_name_mismatch", "manifest.pki.publicServer.expectedSan")
    if pki_items["privateServer"]["expectedSan"] != "127.0.0.1":
        _fail("private_ip_san_required", "manifest.pki.privateServer.expectedSan")

    anchors = _mapping(root["anchors"], "manifest.anchors")
    expected_anchor_ids = {
        "nginxHttpInclude": "MGW-NGINX-HTTP-INCLUDE-V1",
        "nginxVhost": "MGW-NGINX-PUBLIC-VHOST-V1",
        "webFirewall": "MGW-WEB-FIREWALL-ANCHOR-V1",
        "fnosOutputChain": "MGW-FNOS-OUTPUT-CHAIN-V1",
    }
    _exact_keys(anchors, required=set(expected_anchor_ids), path="manifest.anchors")
    anchor_values: dict[str, str] = {}
    for name, stable_id in expected_anchor_ids.items():
        anchor_values[name] = _stable_value(
            anchors[name], f"manifest.anchors.{name}", expected_id=stable_id
        )
        if not _SAFE_ANCHOR.fullmatch(anchor_values[name]):
            _fail("unsafe_anchor", f"manifest.anchors.{name}.value")
    _absolute_path(
        anchor_values["nginxHttpInclude"],
        "manifest.anchors.nginxHttpInclude.value",
        under=Path("/etc/nginx"),
    )
    _absolute_path(
        anchor_values["nginxVhost"],
        "manifest.anchors.nginxVhost.value",
        under=Path("/etc/nginx"),
    )

    baselines = _mapping(root["baselines"], "manifest.baselines")
    baseline_names = {"dns", "ntp", "time", "defaultRoute", "packageDatabase"}
    _exact_keys(baselines, required=baseline_names, path="manifest.baselines")
    for name in baseline_names:
        fingerprint = _string(
            baselines[name], f"manifest.baselines.{name}", maximum=64
        )
        if not _SHA256.fullmatch(fingerprint):
            _fail("invalid_baseline_fingerprint", f"manifest.baselines.{name}")

    backup = _mapping(root["backup"], "manifest.backup")
    _exact_keys(
        backup,
        required={"root", "destinationUnused", "rollbackReady"},
        path="manifest.backup",
    )
    backup_root = _absolute_path(backup["root"], "manifest.backup.root")
    try:
        backup_root.relative_to(REPOSITORY_ROOT)
    except ValueError:
        pass
    else:
        _fail("backup_in_repository", "manifest.backup.root")
    _constant(backup["destinationUnused"], True, "manifest.backup.destinationUnused")
    _constant(backup["rollbackReady"], True, "manifest.backup.rollbackReady")

    residue = _mapping(root["residue"], "manifest.residue")
    residue_names = {
        "generatedConfigInRepository",
        "issuerPrivateKeysOnRuntimeHosts",
        "defaultRouteTakeover",
        "subnetForwarding",
        "homeInbound",
        "persistentReverseSsh",
    }
    _exact_keys(residue, required=residue_names, path="manifest.residue")
    for name in residue_names:
        _constant(residue[name], False, f"manifest.residue.{name}")

    # Return only after all sections have passed. Callers must not log this object.
    return dict(root)


def load_manifest(path: Path, *, expected_release_sha: str | None = None) -> dict[str, Any]:
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        _fail("manifest_file_required", "manifest")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        _fail("manifest_parse_failed", "manifest")
    return validate_manifest(document, expected_release_sha=expected_release_sha)


def _environment_line(name: str, value: str | int) -> str:
    text = str(value)
    if not text or any(character in text for character in "\x00\r\n\"' "):
        _fail("environment_value_requires_escaping", f"render.{name}")
    return f"{name}={text}\n"


def _render_environment(manifest: Mapping[str, Any]) -> tuple[str, str]:
    network = manifest["network"]
    origins = manifest["origins"]
    pki = manifest["pki"]
    private_lines = [
        _environment_line("PYTHONDONTWRITEBYTECODE", "1"),
        _environment_line("PRIVATE_MONITOR_BIND_HOST", network["privateListener"]["host"]),
        _environment_line("PRIVATE_MONITOR_PORT", network["privateListener"]["port"]),
        _environment_line("PRIVATE_MONITOR_TLS_CERT_FILE", pki["privateServer"]["targetFile"]),
        _environment_line("PRIVATE_MONITOR_TLS_KEY_FILE", pki["privateServer"]["targetKeyFile"]),
        _environment_line("PRIVATE_MONITOR_CLIENT_CA_FILE", pki["privateCa"]["targetFile"]),
        _environment_line("PUBLIC_BFF_IDENTITY_CERT_FILE", pki["publicBffClient"]["targetFile"]),
        _environment_line("RAW_MONITOR_API_ORIGIN", origins["rawMonitorApi"]["value"]),
    ]
    if "publicBffClientNext" in pki:
        private_lines.append(
            _environment_line(
                "PUBLIC_BFF_IDENTITY_CERT_FILE_NEXT",
                pki["publicBffClientNext"]["targetFile"],
            )
        )
    if "rawMonitorCa" in pki:
        private_lines.append(
            _environment_line("RAW_MONITOR_CA_FILE", pki["rawMonitorCa"]["targetFile"])
        )
    public_lines = [
        _environment_line("PYTHONDONTWRITEBYTECODE", "1"),
        _environment_line("PUBLIC_MONITOR_BIND_HOST", network["publicListener"]["host"]),
        _environment_line("PUBLIC_MONITOR_PORT", network["publicListener"]["port"]),
        _environment_line("PUBLIC_MONITOR_TLS_CERT_FILE", pki["publicServer"]["targetFile"]),
        _environment_line("PUBLIC_MONITOR_TLS_KEY_FILE", pki["publicServer"]["targetKeyFile"]),
        _environment_line("FINAL_CANONICAL_WEBSITE_ORIGIN", origins["canonicalWebsite"]["value"]),
        _environment_line("MONITOR_API_ORIGIN", origins["privateMonitorApi"]["value"]),
        _environment_line("MONITOR_PRIVATE_CA_FILE", pki["privateCa"]["targetFile"]),
        _environment_line(
            "MONITOR_PUBLIC_BFF_CLIENT_CERT_FILE", pki["publicBffClient"]["targetFile"]
        ),
        _environment_line(
            "MONITOR_PUBLIC_BFF_CLIENT_KEY_FILE", pki["publicBffClient"]["targetKeyFile"]
        ),
    ]
    return "".join(private_lines), "".join(public_lines)


def _render_nginx(manifest: Mapping[str, Any]) -> str:
    try:
        template = NGINX_TEMPLATE.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        _fail("template_read_failed", "render.nginx")
    public_port = manifest["network"]["publicListener"]["port"]
    replacements = {
        "@@PUBLIC_NGINX_LISTEN@@": manifest["nginx"]["listen"],
        "@@PUBLIC_NGINX_SERVER_NAME@@": manifest["nginx"]["serverName"],
        "@@PUBLIC_EDGE_TLS_CERT_FILE@@": manifest["nginx"]["edgeCertificateFile"],
        "@@PUBLIC_EDGE_TLS_KEY_FILE@@": manifest["nginx"]["edgeKeyFile"],
        "@@PUBLIC_GATEWAY_ORIGIN@@": f"https://127.0.0.1:{public_port}",
        "@@PUBLIC_GATEWAY_TLS_NAME@@": manifest["nginx"]["publicGatewayTlsName"],
        "@@PUBLIC_GATEWAY_CA_FILE@@": manifest["nginx"]["publicGatewayCaFile"],
    }
    rendered = template
    for token, value in replacements.items():
        if rendered.count(token) != 1:
            _fail("template_token_count", "render.nginx")
        rendered = rendered.replace(token, str(value))
    if "@@" in rendered:
        _fail("unresolved_template_token", "render.nginx")
    return rendered


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def manifest_sha256(manifest: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return _sha256(canonical)


def _write_private_file(path: Path, content: bytes) -> None:
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_file():
            _fail("output_target_unsafe", f"render.{path.name}")
        try:
            existing = path.read_bytes()
        except OSError:
            _fail("output_read_failed", f"render.{path.name}")
        if existing != content:
            _fail("output_conflict", f"render.{path.name}")
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        return
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            stat.S_IRUSR | stat.S_IWUSR,
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        _fail("output_write_failed", f"render.{path.name}")


def render(manifest: Mapping[str, Any], output_directory: Path) -> tuple[str, ...]:
    if not output_directory.is_absolute() or output_directory == Path("/"):
        _fail("absolute_output_directory_required", "render.outputDirectory")
    resolved_output = output_directory.resolve(strict=False)
    try:
        resolved_output.relative_to(REPOSITORY_ROOT)
    except ValueError:
        pass
    else:
        _fail("repository_output_forbidden", "render.outputDirectory")
    if output_directory.is_symlink():
        _fail("output_symlink_forbidden", "render.outputDirectory")
    try:
        output_directory.mkdir(mode=0o700, parents=False, exist_ok=True)
        os.chmod(output_directory, 0o700)
    except OSError:
        _fail("output_directory_failed", "render.outputDirectory")
    allowed_names = {
        "private.env",
        "public.env",
        "monitor-gateway-server.conf",
        "nginx-candidate-root.conf",
        "render-report.json",
    }
    try:
        extras = {entry.name for entry in output_directory.iterdir()} - allowed_names
    except OSError:
        _fail("output_directory_read_failed", "render.outputDirectory")
    if extras:
        _fail("output_residue", "render.outputDirectory")

    private_env, public_env = _render_environment(manifest)
    nginx_server = _render_nginx(manifest)
    nginx_http = (DEPLOY_ROOT / "nginx" / "monitor-gateway-http.conf").read_text(
        encoding="utf-8"
    )
    nginx_root = (
        "# Generated candidate for isolated nginx -t only; never activate this file.\n"
        "events {}\n"
        "http {\n"
        + nginx_http
        + nginx_server
        + "}\n"
    )
    rendered: dict[str, bytes] = {
        "private.env": private_env.encode(),
        "public.env": public_env.encode(),
        "monitor-gateway-server.conf": nginx_server.encode(),
        "nginx-candidate-root.conf": nginx_root.encode(),
    }
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "manifestFingerprint": MANIFEST_FINGERPRINT,
        "candidateSetFingerprint": CANDIDATE_SET_FINGERPRINT,
        "manifestSha256": manifest_sha256(manifest),
        "releaseSha": manifest["release"]["sha"],
        "files": {name: _sha256(content) for name, content in sorted(rendered.items())},
    }
    rendered["render-report.json"] = (
        json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    for name, content in rendered.items():
        _write_private_file(output_directory / name, content)
    return tuple(sorted(rendered))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="render private staging assets")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--expected-release-sha", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--check", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not _SHA40.fullmatch(args.expected_release_sha):
        print("RENDER_FAILED code=invalid_expected_sha field=arguments", file=sys.stderr)
        return 2
    if args.output_dir is None and not args.check:
        print("RENDER_FAILED code=output_required field=arguments", file=sys.stderr)
        return 2
    try:
        manifest = load_manifest(
            args.manifest, expected_release_sha=args.expected_release_sha
        )
        files: tuple[str, ...] = ()
        if args.output_dir is not None:
            files = render(manifest, args.output_dir)
    except ManifestError as error:
        print(f"RENDER_FAILED code={error.code} field={error.path}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print("RENDER_FAILED code=io_failure field=runtime", file=sys.stderr)
        return 1
    print("RESULT: PASS")
    print(f"SCHEMA_VERSION: {SCHEMA_VERSION}")
    print(f"GENERATED_FILE_COUNT: {len(files)}")
    print("SENSITIVE_VALUES_EMITTED: NO")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

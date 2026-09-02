#!/usr/bin/env python3
"""Read-only preflight and postcheck gates for monitor-gateway staging."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping


DEPLOY_ROOT = Path(__file__).resolve().parent
if str(DEPLOY_ROOT) not in sys.path:
    sys.path.insert(0, str(DEPLOY_ROOT))

from render import (  # noqa: E402
    CANDIDATE_SET_FINGERPRINT,
    MANIFEST_FINGERPRINT,
    ManifestError,
    _render_environment,
    _render_nginx,
    load_manifest,
    manifest_sha256,
)


_SHA40 = re.compile(r"[0-9a-f]{40}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_IP_LITERAL = re.compile(
    r"(?<![A-Za-z0-9])(?:\d{1,3}\.){3}\d{1,3}(?![A-Za-z0-9])"
)
EXPECTED_RENDERED_FILES = {
    "private.env",
    "public.env",
    "monitor-gateway-server.conf",
    "nginx-candidate-root.conf",
    "render-report.json",
}


class PreflightError(RuntimeError):
    def __init__(self, code: str, check: str) -> None:
        self.code = code
        self.check = check
        super().__init__(f"{code} at {check}")


def _fail(code: str, check: str) -> None:
    raise PreflightError(code, check)


def _absolute_file(path: Path, check: str) -> Path:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        _fail("regular_file_required", check)
    return path


def _absolute_directory(path: Path, check: str) -> Path:
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        _fail("directory_required", check)
    if path == Path("/"):
        _fail("broad_path_forbidden", check)
    return path


def _mode(path: Path, expected: int, check: str) -> None:
    try:
        actual = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        _fail("stat_failed", check)
    if actual != expected:
        _fail("mode_mismatch", check)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError:
        _fail("hash_failed", "file_integrity")
    return digest.hexdigest()


def validate_schema_asset() -> None:
    schema_path = DEPLOY_ROOT / "manifest.schema.json"
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        _fail("schema_parse_failed", "manifest_schema")
    if schema.get("additionalProperties") is not False:
        _fail("schema_not_closed", "manifest_schema")
    authority = schema.get("properties", {}).get("authority", {}).get("properties", {})
    if authority.get("manifestFingerprint", {}).get("const") != MANIFEST_FINGERPRINT:
        _fail("schema_authority_mismatch", "manifest_schema")
    if (
        authority.get("candidateSetFingerprint", {}).get("const")
        != CANDIDATE_SET_FINGERPRINT
    ):
        _fail("schema_authority_mismatch", "manifest_schema")


def validate_artifact(artifact_directory: Path, release_sha: str) -> None:
    artifact = _absolute_directory(artifact_directory, "artifact")
    if artifact.name != release_sha:
        _fail("artifact_directory_sha_mismatch", "artifact")
    marker = _absolute_file(artifact / ".monitor-gateway-release-sha", "artifact_marker")
    try:
        marker_value = marker.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        _fail("artifact_marker_unreadable", "artifact_marker")
    if marker_value != release_sha:
        _fail("artifact_sha_mismatch", "artifact_marker")
    required = artifact / "monitoring" / "gateway" / "server.py"
    _absolute_file(required, "artifact_entrypoint")
    for parent, directories, files in os.walk(artifact, followlinks=False):
        parent_path = Path(parent)
        for name in (*directories, *files):
            candidate = parent_path / name
            if candidate.is_symlink():
                _fail("artifact_symlink_forbidden", "artifact_tree")
            try:
                mode = stat.S_IMODE(candidate.stat().st_mode)
            except OSError:
                _fail("artifact_stat_failed", "artifact_tree")
            if mode & 0o022:
                _fail("artifact_group_or_world_writable", "artifact_tree")


def _load_report(rendered: Path) -> Mapping[str, Any]:
    report_path = _absolute_file(rendered / "render-report.json", "render_report")
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        _fail("render_report_invalid", "render_report")
    if not isinstance(report, dict):
        _fail("render_report_invalid", "render_report")
    if set(report) != {
        "schemaVersion",
        "manifestFingerprint",
        "candidateSetFingerprint",
        "manifestSha256",
        "releaseSha",
        "files",
    }:
        _fail("render_report_fields", "render_report")
    return report


def validate_rendered(rendered_directory: Path, manifest: Mapping[str, Any]) -> None:
    rendered = _absolute_directory(rendered_directory, "rendered_directory")
    _mode(rendered, 0o700, "rendered_directory")
    try:
        names = {entry.name for entry in rendered.iterdir()}
    except OSError:
        _fail("rendered_directory_unreadable", "rendered_directory")
    if names != EXPECTED_RENDERED_FILES:
        _fail("rendered_residue_or_missing_file", "rendered_directory")
    for name in names:
        path = _absolute_file(rendered / name, "rendered_file")
        _mode(path, 0o600, "rendered_file")
    report = _load_report(rendered)
    expected_header = {
        "schemaVersion": "MGW-PRIVATE-STAGING-MANIFEST-V1",
        "manifestFingerprint": MANIFEST_FINGERPRINT,
        "candidateSetFingerprint": CANDIDATE_SET_FINGERPRINT,
        "manifestSha256": manifest_sha256(manifest),
        "releaseSha": manifest["release"]["sha"],
    }
    for name, expected in expected_header.items():
        if report.get(name) != expected:
            _fail("render_report_mismatch", "render_report")
    hashes = report.get("files")
    if not isinstance(hashes, dict) or set(hashes) != EXPECTED_RENDERED_FILES - {
        "render-report.json"
    }:
        _fail("render_hash_set_mismatch", "render_report")
    for name, expected_hash in hashes.items():
        if not isinstance(expected_hash, str) or not _SHA256.fullmatch(expected_hash):
            _fail("render_hash_invalid", "render_report")
        if _sha256_file(rendered / name) != expected_hash:
            _fail("render_hash_mismatch", "rendered_file")
    expected_private, expected_public = _render_environment(manifest)
    expected_server = _render_nginx(manifest)
    expected_content = {
        "private.env": expected_private.encode(),
        "public.env": expected_public.encode(),
        "monitor-gateway-server.conf": expected_server.encode(),
    }
    for name, expected in expected_content.items():
        try:
            actual = (rendered / name).read_bytes()
        except OSError:
            _fail("rendered_file_unreadable", "rendered_file")
        if actual != expected:
            _fail("rendered_content_mismatch", "rendered_file")
    try:
        candidate_root = (rendered / "nginx-candidate-root.conf").read_text(
            encoding="utf-8"
        )
    except (OSError, UnicodeError):
        _fail("nginx_candidate_unreadable", "nginx_candidate")
    if (
        not candidate_root.startswith(
            "# Generated candidate for isolated nginx -t only; never activate this file."
        )
        or "events {}" not in candidate_root
        or "http {" not in candidate_root
        or expected_server not in candidate_root
        or "@@" in candidate_root
    ):
        _fail("nginx_candidate_invalid", "nginx_candidate")


def validate_wireguard(wireguard_config: Path, manifest: Mapping[str, Any]) -> None:
    config = _absolute_file(wireguard_config, "wireguard_config")
    _mode(config, 0o600, "wireguard_config")
    try:
        lines = config.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        _fail("wireguard_unreadable", "wireguard_config")
    section = ""
    parsed: dict[str, dict[str, list[str]]] = {"Interface": {}, "Peer": {}}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line in ("[Interface]", "[Peer]"):
            section = line[1:-1]
            continue
        if section not in parsed or "=" not in line:
            _fail("wireguard_syntax", "wireguard_config")
        name, value = (part.strip() for part in line.split("=", 1))
        if not name or not value or "\x00" in value:
            _fail("wireguard_syntax", "wireguard_config")
        parsed[section].setdefault(name, []).append(value)
    forbidden = {"PreUp", "PostUp", "PreDown", "PostDown", "Table", "SaveConfig", "DNS"}
    if forbidden.intersection(parsed["Interface"]) or forbidden.intersection(parsed["Peer"]):
        _fail("wireguard_mutating_directive", "wireguard_config")
    wg = manifest["network"]["wireguard"]
    expected_interface = {
        "Address": [f"{wg['webAddress']}/{str(wg['prefix']).split('/', 1)[1]}"],
        "ListenPort": [str(wg["webEndpointPort"])],
    }
    for name, expected in expected_interface.items():
        if parsed["Interface"].get(name) != expected:
            _fail("wireguard_interface_mismatch", "wireguard_config")
    if len(parsed["Interface"].get("PrivateKey", [])) != 1:
        _fail("wireguard_private_key_missing", "wireguard_config")
    if len(parsed["Peer"].get("PublicKey", [])) != 1:
        _fail("wireguard_peer_key_missing", "wireguard_config")
    decoded_keys: list[bytes] = []
    for value in (
        parsed["Interface"]["PrivateKey"][0],
        parsed["Peer"]["PublicKey"][0],
    ):
        try:
            decoded = base64.b64decode(value, validate=True)
        except (ValueError, binascii.Error):
            _fail("wireguard_key_invalid", "wireguard_config")
        if len(decoded) != 32:
            _fail("wireguard_key_invalid", "wireguard_config")
        decoded_keys.append(decoded)
    if decoded_keys[0] == decoded_keys[1]:
        _fail("wireguard_key_collision", "wireguard_config")
    if parsed["Peer"].get("AllowedIPs") != [wg["webPeerAllowedIp"]]:
        _fail("wireguard_host_route_mismatch", "wireguard_config")
    if "Endpoint" in parsed["Peer"] or "PersistentKeepalive" in parsed["Peer"]:
        _fail("wireguard_receiver_must_not_initiate", "wireguard_config")
    allowed_interface = {"Address", "ListenPort", "PrivateKey"}
    allowed_peer = {"PublicKey", "AllowedIPs"}
    if set(parsed["Interface"]) != allowed_interface or set(parsed["Peer"]) != allowed_peer:
        _fail("wireguard_extra_directive", "wireguard_config")


def _run(command: list[str], check: str, *, input_bytes: bytes | None = None) -> bytes:
    try:
        completed = subprocess.run(
            command,
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        _fail("tool_failed", check)
    if completed.returncode != 0:
        _fail("tool_rejected_input", check)
    return completed.stdout


def _openssl_verify(ca: Path, certificate: Path, *, should_pass: bool, check: str) -> None:
    try:
        completed = subprocess.run(
            ["openssl", "verify", "-CAfile", str(ca), str(certificate)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        _fail("openssl_failed", check)
    if (completed.returncode == 0) is not should_pass:
        _fail("certificate_trust_boundary", check)


def _certificate_text(path: Path, extension: str, check: str) -> str:
    output = _run(
        ["openssl", "x509", "-in", str(path), "-noout", "-ext", extension],
        check,
    )
    return output.decode("utf-8", errors="replace")


def _certificate_dates(path: Path, check: str) -> tuple[datetime, datetime]:
    output = _run(
        ["openssl", "x509", "-in", str(path), "-noout", "-startdate", "-enddate"],
        check,
    ).decode("ascii", errors="replace")
    values: dict[str, datetime] = {}
    for line in output.splitlines():
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        try:
            values[name] = datetime.strptime(value, "%b %d %H:%M:%S %Y %Z").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            _fail("certificate_date_invalid", check)
    if set(values) != {"notBefore", "notAfter"}:
        _fail("certificate_date_missing", check)
    return values["notBefore"], values["notAfter"]


def _key_matches(certificate: Path, key: Path, check: str) -> None:
    certificate_public = _run(
        ["openssl", "x509", "-in", str(certificate), "-pubkey", "-noout"], check
    )
    key_public = _run(
        ["openssl", "pkey", "-in", str(key), "-pubout"], check
    )
    if hashlib.sha256(certificate_public).digest() != hashlib.sha256(key_public).digest():
        _fail("certificate_key_mismatch", check)


def _validate_leaf(
    certificate: Path,
    key: Path,
    *,
    expected_eku: str,
    forbidden_eku: str,
    expected_san: str | None,
    check: str,
) -> None:
    eku = _certificate_text(certificate, "extendedKeyUsage", check)
    if expected_eku not in eku or forbidden_eku in eku:
        _fail("certificate_eku_mismatch", check)
    if expected_san is not None:
        san = _certificate_text(certificate, "subjectAltName", check)
        candidates = (f"DNS:{expected_san}", f"IP Address:{expected_san}")
        if not any(candidate in san for candidate in candidates):
            _fail("certificate_san_mismatch", check)
    not_before, not_after = _certificate_dates(certificate, check)
    now = datetime.now(timezone.utc)
    if not_after - not_before > timedelta(days=90, hours=1):
        _fail("certificate_lifetime_too_long", check)
    if not_before > now + timedelta(minutes=5) or not_after <= now + timedelta(hours=24):
        _fail("certificate_readiness_closed", check)
    _key_matches(certificate, key, check)


def validate_pki(
    pki_directory: Path,
    manifest: Mapping[str, Any],
    *,
    require_runtime_ownership: bool,
) -> None:
    pki = _absolute_directory(pki_directory, "pki_directory")
    _mode(pki, 0o750, "pki_directory")
    configured = manifest["pki"]
    names = {
        "public-ca.pem",
        "public-server.crt",
        "public-server.key",
        "private-ca.pem",
        "private-server.crt",
        "private-server.key",
        "public-bff-client.crt",
        "public-bff-client.key",
    }
    if "publicBffClientNext" in configured:
        names.update({"public-bff-client-next.crt", "public-bff-client-next.key"})
    if "rawMonitorCa" in configured:
        names.add("raw-monitor-ca.pem")
    try:
        actual_names = {entry.name for entry in pki.iterdir()}
    except OSError:
        _fail("pki_directory_unreadable", "pki_directory")
    if actual_names != names:
        _fail("pki_residue_or_missing_file", "pki_directory")
    for name in names:
        item = _absolute_file(pki / name, "pki_file")
        _mode(item, 0o640, "pki_file")
        if require_runtime_ownership:
            try:
                import grp
                import pwd

                status = item.stat()
                if pwd.getpwuid(status.st_uid).pw_name != "root":
                    _fail("pki_owner_mismatch", "pki_file")
                if grp.getgrgid(status.st_gid).gr_name != "monitor-gateway":
                    _fail("pki_group_mismatch", "pki_file")
            except KeyError:
                _fail("pki_identity_missing", "pki_file")
    public_ca = pki / "public-ca.pem"
    private_ca = pki / "private-ca.pem"
    public_server = pki / "public-server.crt"
    private_server = pki / "private-server.crt"
    public_client = pki / "public-bff-client.crt"
    _openssl_verify(public_ca, public_server, should_pass=True, check="public_ca_boundary")
    _openssl_verify(private_ca, public_server, should_pass=False, check="public_ca_boundary")
    _openssl_verify(private_ca, private_server, should_pass=True, check="private_ca_boundary")
    _openssl_verify(private_ca, public_client, should_pass=True, check="private_ca_boundary")
    _openssl_verify(public_ca, private_server, should_pass=False, check="private_ca_boundary")
    _openssl_verify(public_ca, public_client, should_pass=False, check="private_ca_boundary")
    _validate_leaf(
        public_server,
        pki / "public-server.key",
        expected_eku="TLS Web Server Authentication",
        forbidden_eku="TLS Web Client Authentication",
        expected_san=configured["publicServer"]["expectedSan"],
        check="public_server_leaf",
    )
    _validate_leaf(
        private_server,
        pki / "private-server.key",
        expected_eku="TLS Web Server Authentication",
        forbidden_eku="TLS Web Client Authentication",
        expected_san=configured["privateServer"]["expectedSan"],
        check="private_server_leaf",
    )
    _validate_leaf(
        public_client,
        pki / "public-bff-client.key",
        expected_eku="TLS Web Client Authentication",
        forbidden_eku="TLS Web Server Authentication",
        expected_san=None,
        check="public_bff_client_leaf",
    )
    if "publicBffClientNext" in configured:
        next_certificate = pki / "public-bff-client-next.crt"
        _openssl_verify(
            private_ca,
            next_certificate,
            should_pass=True,
            check="public_bff_next_leaf",
        )
        _validate_leaf(
            next_certificate,
            pki / "public-bff-client-next.key",
            expected_eku="TLS Web Client Authentication",
            forbidden_eku="TLS Web Server Authentication",
            expected_san=None,
            check="public_bff_next_leaf",
        )


def _ownership(path: Path, user: str, group: str, check: str) -> None:
    try:
        import grp
        import pwd

        status = path.stat()
        actual_user = pwd.getpwuid(status.st_uid).pw_name
        actual_group = grp.getgrgid(status.st_gid).gr_name
    except (OSError, KeyError):
        _fail("runtime_identity_missing", check)
    if actual_user != user or actual_group != group:
        _fail("runtime_ownership_mismatch", check)


def validate_runtime_layout(
    manifest: Mapping[str, Any],
    *,
    artifact_directory: Path,
    pki_directory: Path,
    wireguard_config: Path,
    require_current: bool,
) -> None:
    try:
        import grp
        import pwd

        account = pwd.getpwnam("monitor-gateway")
        group = grp.getgrnam("monitor-gateway")
    except KeyError:
        _fail("runtime_service_identity_missing", "runtime_layout")
    if (
        account.pw_gid != group.gr_gid
        or account.pw_dir != "/nonexistent"
        or account.pw_shell not in {"/usr/sbin/nologin", "/sbin/nologin"}
        or Path("/nonexistent").exists()
    ):
        _fail("runtime_service_identity_invalid", "runtime_layout")

    env_root = _absolute_directory(Path("/etc/monitor-gateway"), "runtime_env_root")
    runtime_pki = _absolute_directory(pki_directory, "runtime_pki_root")
    if runtime_pki != env_root / "pki":
        _fail("runtime_pki_path_mismatch", "runtime_layout")
    for directory in (env_root, runtime_pki):
        _mode(directory, 0o750, "runtime_directory")
        _ownership(directory, "root", "monitor-gateway", "runtime_directory")

    expected_private, expected_public = _render_environment(manifest)
    for name, expected in (
        ("private.env", expected_private.encode()),
        ("public.env", expected_public.encode()),
    ):
        target = _absolute_file(env_root / name, "runtime_environment")
        _mode(target, 0o640, "runtime_environment")
        _ownership(target, "root", "monitor-gateway", "runtime_environment")
        try:
            actual = target.read_bytes()
        except OSError:
            _fail("runtime_environment_unreadable", "runtime_environment")
        if actual != expected:
            _fail("runtime_environment_mismatch", "runtime_environment")

    for name in ("monitor-gateway-private.service", "monitor-gateway-public.service"):
        source = _absolute_file(DEPLOY_ROOT / "systemd" / name, "unit_source")
        target = _absolute_file(Path("/etc/systemd/system") / name, "runtime_unit")
        _mode(target, 0o644, "runtime_unit")
        _ownership(target, "root", "root", "runtime_unit")
        try:
            if target.read_bytes() != source.read_bytes():
                _fail("runtime_unit_mismatch", "runtime_unit")
        except OSError:
            _fail("runtime_unit_unreadable", "runtime_unit")

    release_sha = manifest["release"]["sha"]
    release_target = _absolute_directory(
        Path(manifest["release"]["installDirectory"]), "runtime_release"
    )
    _mode(release_target, 0o555, "runtime_release")
    expected_artifact = _absolute_directory(artifact_directory, "artifact")
    try:
        expected_entries = {
            path.relative_to(expected_artifact): path
            for path in expected_artifact.rglob("*")
        }
        actual_entries = {
            path.relative_to(release_target): path for path in release_target.rglob("*")
        }
    except OSError:
        _fail("runtime_release_unreadable", "runtime_release")
    if set(expected_entries) != set(actual_entries):
        _fail("runtime_release_tree_mismatch", "runtime_release")
    for relative_path, source in expected_entries.items():
        target = actual_entries[relative_path]
        if source.is_symlink() or target.is_symlink() or source.is_dir() != target.is_dir():
            _fail("runtime_release_tree_mismatch", "runtime_release")
        _ownership(target, "root", "root", "runtime_release")
        target_mode = stat.S_IMODE(target.stat().st_mode)
        if target.is_dir():
            if target_mode != 0o555:
                _fail("runtime_release_writable", "runtime_release")
        else:
            if target_mode != 0o444 or _sha256_file(source) != _sha256_file(target):
                _fail("runtime_release_content_mismatch", "runtime_release")
    marker = _absolute_file(
        release_target / ".monitor-gateway-release-sha", "runtime_release_marker"
    )
    try:
        if marker.read_text(encoding="ascii").strip() != release_sha:
            _fail("runtime_release_sha_mismatch", "runtime_release_marker")
    except (OSError, UnicodeError):
        _fail("runtime_release_marker_unreadable", "runtime_release_marker")

    runtime_wireguard = _absolute_file(wireguard_config, "runtime_wireguard")
    _mode(runtime_wireguard, 0o600, "runtime_wireguard")
    _ownership(runtime_wireguard, "root", "root", "runtime_wireguard")

    if require_current:
        current = Path("/opt/network-service-platform/monitor-gateway/current")
        if not current.is_symlink():
            _fail("runtime_current_link_missing", "runtime_layout")
        try:
            if current.resolve(strict=True) != release_target:
                _fail("runtime_current_link_mismatch", "runtime_layout")
        except OSError:
            _fail("runtime_current_link_invalid", "runtime_layout")


def validate_backup(
    backup_directory: Path,
    manifest: Mapping[str, Any],
    *,
    phase: str,
) -> None:
    expected = Path(manifest["backup"]["root"])
    if backup_directory != expected:
        _fail("backup_target_mismatch", "backup")
    if phase == "precheck":
        if backup_directory.exists() or backup_directory.is_symlink():
            _fail("backup_target_not_unused", "backup")
        if not backup_directory.parent.is_dir():
            _fail("backup_parent_missing", "backup")
        return
    backup = _absolute_directory(backup_directory, "backup")
    _mode(backup, 0o700, "backup")
    record = _absolute_file(backup / "backup-record.json", "backup_record")
    _mode(record, 0o600, "backup_record")
    frozen_manifest_path = _absolute_file(
        backup / "execution-manifest.json", "backup_manifest"
    )
    _mode(frozen_manifest_path, 0o600, "backup_manifest")
    try:
        document = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        _fail("backup_record_invalid", "backup_record")
    expected_record_fields = {
        "schemaVersion",
        "releaseSha",
        "manifestSha256",
        "releaseTargetExisted",
        "serviceUserExisted",
        "serviceGroupExisted",
        "privateServiceWasActive",
        "publicServiceWasActive",
        "wireguardWasActive",
        "platformRootExisted",
        "gatewayRootExisted",
        "releaseRootExisted",
        "envRootExisted",
        "pkiRootExisted",
        "wireguardRootExisted",
        "targets",
    }
    if (
        not isinstance(document, dict)
        or set(document) != expected_record_fields
        or document.get("schemaVersion") != "MGW-BACKUP-RECORD-V1"
    ):
        _fail("backup_record_invalid", "backup_record")
    if document.get("releaseSha") != manifest["release"]["sha"]:
        _fail("backup_release_mismatch", "backup_record")
    if document.get("manifestSha256") != manifest_sha256(manifest):
        _fail("backup_manifest_mismatch", "backup_record")
    try:
        frozen_manifest = load_manifest(
            frozen_manifest_path,
            expected_release_sha=manifest["release"]["sha"],
        )
    except ManifestError:
        _fail("backup_manifest_invalid", "backup_manifest")
    if manifest_sha256(frozen_manifest) != document.get("manifestSha256"):
        _fail("backup_manifest_hash_mismatch", "backup_manifest")
    for field in (
        "releaseTargetExisted",
        "serviceUserExisted",
        "serviceGroupExisted",
        "privateServiceWasActive",
        "publicServiceWasActive",
        "wireguardWasActive",
        "platformRootExisted",
        "gatewayRootExisted",
        "releaseRootExisted",
        "envRootExisted",
        "pkiRootExisted",
        "wireguardRootExisted",
    ):
        if not isinstance(document.get(field), bool):
            _fail("backup_record_invalid", "backup_record")
    targets = document.get("targets")
    if not isinstance(targets, list) or not targets:
        _fail("backup_targets_missing", "backup_record")
    expected_target_ids = {
        "current-link",
        "private-env",
        "public-env",
        "public-ca",
        "public-server-cert",
        "public-server-key",
        "private-ca",
        "private-server-cert",
        "private-server-key",
        "public-bff-cert",
        "public-bff-key",
        "public-bff-next-cert",
        "public-bff-next-key",
        "raw-monitor-ca",
        "wireguard-config",
        "private-unit",
        "public-unit",
    }
    target_ids = [target.get("targetId") for target in targets if isinstance(target, dict)]
    if len(target_ids) != len(set(target_ids)) or set(target_ids) != expected_target_ids:
        _fail("backup_target_set_mismatch", "backup_record")
    expected_backup_names = {
        "current-link": "current-link.backup",
        "private-env": "private-env.backup",
        "public-env": "public-env.backup",
        "public-ca": "public-ca.backup",
        "public-server-cert": "public-server-cert.backup",
        "public-server-key": "public-server-key.backup",
        "private-ca": "private-ca.backup",
        "private-server-cert": "private-server-cert.backup",
        "private-server-key": "private-server-key.backup",
        "public-bff-cert": "public-bff-cert.backup",
        "public-bff-key": "public-bff-key.backup",
        "public-bff-next-cert": "public-bff-next-cert.backup",
        "public-bff-next-key": "public-bff-next-key.backup",
        "raw-monitor-ca": "raw-monitor-ca.backup",
        "wireguard-config": "wireguard-config.backup",
        "private-unit": "private-unit.backup",
        "public-unit": "public-unit.backup",
    }
    expected_files = {"backup-record.json", "execution-manifest.json"}
    for target in targets:
        if not isinstance(target, dict) or set(target) != {
            "targetId",
            "state",
            "backupFile",
            "sha256",
        }:
            _fail("backup_target_invalid", "backup_record")
        if target["state"] not in {"absent", "file", "symlink"}:
            _fail("backup_target_invalid", "backup_record")
        if target["state"] == "absent":
            if target["backupFile"] is not None or target["sha256"] is not None:
                _fail("backup_absent_target_invalid", "backup_record")
            continue
        backup_name = target["backupFile"]
        digest = target["sha256"]
        if (
            not isinstance(backup_name, str)
            or "/" in backup_name
            or backup_name != expected_backup_names[target["targetId"]]
            or not isinstance(digest, str)
            or not _SHA256.fullmatch(digest)
        ):
            _fail("backup_target_invalid", "backup_record")
        backup_file = _absolute_file(backup / backup_name, "backup_file")
        _mode(backup_file, 0o600, "backup_file")
        if _sha256_file(backup_file) != digest:
            _fail("backup_hash_mismatch", "backup_file")
        if target["state"] == "symlink" and target["targetId"] != "current-link":
            _fail("backup_symlink_target_invalid", "backup_record")
        if target["state"] == "file" and target["targetId"] == "current-link":
            _fail("backup_current_link_state_invalid", "backup_record")
        expected_files.add(backup_name)
    try:
        actual_files = {entry.name for entry in backup.iterdir()}
    except OSError:
        _fail("backup_unreadable", "backup")
    if actual_files != expected_files:
        _fail("backup_residue", "backup")


def _http_probe(
    host: str,
    port: int,
    context: ssl.SSLContext,
    server_name: str,
    path: str,
    *,
    headers: Mapping[str, str] | None = None,
) -> tuple[int, Mapping[str, str], bytes]:
    try:
        raw = socket.create_connection((host, port), timeout=3)
        tls = context.wrap_socket(raw, server_hostname=server_name)
        connection = http.client.HTTPConnection(host, port, timeout=50)
        connection.sock = tls
        connection.request("GET", path, headers=dict(headers or {}))
        response = connection.getresponse()
        body = response.read(512 * 1024 + 1)
        status_code = response.status
        response_headers = {name.casefold(): value for name, value in response.getheaders()}
        connection.close()
    except (OSError, ssl.SSLError, http.client.HTTPException):
        _fail("loopback_probe_failed", "runtime_postcheck")
    if len(body) > 512 * 1024:
        _fail("response_too_large", "runtime_postcheck")
    return status_code, response_headers, body


def validate_runtime_postcheck(manifest: Mapping[str, Any], pki_directory: Path) -> None:
    pki = pki_directory
    private_context = ssl.create_default_context(
        ssl.Purpose.SERVER_AUTH, cafile=str(pki / "private-ca.pem")
    )
    private_context.load_cert_chain(
        str(pki / "public-bff-client.crt"), str(pki / "public-bff-client.key")
    )
    public_context = ssl.create_default_context(
        ssl.Purpose.SERVER_AUTH, cafile=str(pki / "public-ca.pem")
    )
    private = manifest["network"]["privateListener"]
    public = manifest["network"]["publicListener"]
    private_name = manifest["pki"]["privateServer"]["expectedSan"]
    public_name = manifest["pki"]["publicServer"]["expectedSan"]
    for listener, context, name in ((private, private_context, private_name),):
        for path in ("/healthz", "/readyz"):
            status_code, headers, body = _http_probe(
                listener["host"], listener["port"], context, name, path
            )
            if status_code != 200 or headers.get("cache-control") not in {
                "no-store",
                "private, no-store",
            }:
                _fail("runtime_probe_rejected", "runtime_postcheck")
            if "set-cookie" in headers or "access-control-allow-origin" in headers:
                _fail("runtime_header_leakage", "runtime_postcheck")
            try:
                payload = json.loads(body)
            except (UnicodeError, json.JSONDecodeError):
                _fail("runtime_probe_body_invalid", "runtime_postcheck")
            if payload != {"status": "ok"} and path == "/healthz":
                _fail("runtime_probe_body_invalid", "runtime_postcheck")
    _validate_private_negative_gate(manifest, pki_directory)
    for listener, context, name in ((public, public_context, public_name),):
        for path in ("/healthz", "/readyz"):
            status_code, headers, body = _http_probe(
                listener["host"], listener["port"], context, name, path
            )
            if status_code != 200 or headers.get("cache-control") != "no-store":
                _fail("runtime_probe_rejected", "runtime_postcheck")
            if "set-cookie" in headers or "access-control-allow-origin" in headers:
                _fail("runtime_header_leakage", "runtime_postcheck")
            try:
                payload = json.loads(body)
            except (UnicodeError, json.JSONDecodeError):
                _fail("runtime_probe_body_invalid", "runtime_postcheck")
            if payload != {"status": "ok"} and path == "/healthz":
                _fail("runtime_probe_body_invalid", "runtime_postcheck")
    status_code, headers, body = _http_probe(
        public["host"],
        public["port"],
        public_context,
        public_name,
        "/api/summary",
        headers={"X-Monitor-Client-IP": "192.0.2.123"},
    )
    if status_code != 200 or "set-cookie" in headers or "access-control-allow-origin" in headers:
        _fail("public_contract_failed", "runtime_postcheck")
    try:
        payload = json.loads(body)
    except (UnicodeError, json.JSONDecodeError):
        _fail("public_contract_failed", "runtime_postcheck")
    if not isinstance(payload, dict) or set(payload) != {"wans"}:
        _fail("public_contract_failed", "runtime_postcheck")
    wans = payload["wans"]
    if not isinstance(wans, list) or len(wans) != 3:
        _fail("public_contract_failed", "runtime_postcheck")
    allowed = {
        "wanId",
        "displayName",
        "status",
        "latestLatencyMs",
        "packetLossSummary",
        "updatedAt",
        "stale",
        "trend",
    }
    if any(not isinstance(item, dict) or not set(item).issubset(allowed) for item in wans):
        _fail("public_contract_failed", "runtime_postcheck")
    if _IP_LITERAL.search(body.decode("utf-8", errors="ignore")):
        _fail("public_value_leakage", "runtime_postcheck")


def _validate_private_negative_gate(
    manifest: Mapping[str, Any], pki_directory: Path
) -> None:
    private = manifest["network"]["privateListener"]
    private_name = manifest["pki"]["privateServer"]["expectedSan"]
    negative_context = ssl.create_default_context(
        ssl.Purpose.SERVER_AUTH, cafile=str(pki_directory / "private-ca.pem")
    )
    try:
        raw = socket.create_connection((private["host"], private["port"]), timeout=3)
        with negative_context.wrap_socket(raw, server_hostname=private_name) as tls:
            tls.sendall(b"HEAD /healthz HTTP/1.1\r\nHost: private\r\nConnection: close\r\n\r\n")
            response = tls.recv(1)
            if response:
                _fail("private_mtls_negative_gate_failed", "runtime_postcheck")
    except (ssl.SSLError, EOFError):
        pass
    except OSError:
        _fail("private_mtls_negative_gate_inconclusive", "runtime_postcheck")


def validate_private_postcheck(
    manifest: Mapping[str, Any], pki_directory: Path
) -> None:
    private = manifest["network"]["privateListener"]
    private_name = manifest["pki"]["privateServer"]["expectedSan"]
    context = ssl.create_default_context(
        ssl.Purpose.SERVER_AUTH, cafile=str(pki_directory / "private-ca.pem")
    )
    context.load_cert_chain(
        str(pki_directory / "public-bff-client.crt"),
        str(pki_directory / "public-bff-client.key"),
    )
    for path in ("/healthz", "/readyz"):
        status_code, headers, body = _http_probe(
            private["host"], private["port"], context, private_name, path
        )
        if status_code != 200 or headers.get("cache-control") != "private, no-store":
            _fail("private_runtime_probe_rejected", "private_postcheck")
        if "set-cookie" in headers or "access-control-allow-origin" in headers:
            _fail("private_runtime_header_leakage", "private_postcheck")
        try:
            payload = json.loads(body)
        except (UnicodeError, json.JSONDecodeError):
            _fail("private_runtime_body_invalid", "private_postcheck")
        if payload != {"status": "ok"} and path == "/healthz":
            _fail("private_runtime_body_invalid", "private_postcheck")
    _validate_private_negative_gate(manifest, pki_directory)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="read-only monitor gateway staging preflight")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--expected-release-sha", required=True)
    parser.add_argument(
        "--phase",
        choices=("manifest", "precheck", "private-postcheck", "postcheck", "rollback"),
        default="manifest",
    )
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--rendered-dir", type=Path)
    parser.add_argument("--pki-dir", type=Path)
    parser.add_argument("--wireguard-config", type=Path)
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--require-runtime-ownership", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    print("PREFLIGHT_MODE: READ_ONLY")
    print(f"PHASE: {args.phase}")
    if not _SHA40.fullmatch(args.expected_release_sha):
        print("PREFLIGHT_FAILED code=invalid_expected_sha check=arguments", file=sys.stderr)
        print("RESULT: BLOCKED")
        return 2
    try:
        validate_schema_asset()
        manifest = load_manifest(
            args.manifest, expected_release_sha=args.expected_release_sha
        )
        supplied = {
            "artifact": args.artifact_dir,
            "rendered": args.rendered_dir,
            "pki": args.pki_dir,
            "wireguard": args.wireguard_config,
            "backup": args.backup_dir,
        }
        if args.phase in {"precheck", "private-postcheck", "postcheck"} and any(
            value is None for value in supplied.values()
        ):
            _fail("complete_runtime_inputs_required", "arguments")
        if args.phase == "rollback" and args.backup_dir is None:
            _fail("backup_input_required", "arguments")
        if args.artifact_dir is not None:
            validate_artifact(args.artifact_dir, args.expected_release_sha)
        if args.rendered_dir is not None:
            validate_rendered(args.rendered_dir, manifest)
        if args.pki_dir is not None:
            validate_pki(
                args.pki_dir,
                manifest,
                require_runtime_ownership=args.require_runtime_ownership,
            )
        if args.wireguard_config is not None:
            validate_wireguard(args.wireguard_config, manifest)
        if args.require_runtime_ownership:
            if any(
                value is None
                for value in (
                    args.artifact_dir,
                    args.rendered_dir,
                    args.pki_dir,
                    args.wireguard_config,
                )
            ):
                _fail("complete_runtime_inputs_required", "arguments")
            assert args.artifact_dir is not None
            assert args.rendered_dir is not None
            assert args.pki_dir is not None
            assert args.wireguard_config is not None
            validate_runtime_layout(
                manifest,
                artifact_directory=args.artifact_dir,
                pki_directory=args.pki_dir,
                wireguard_config=args.wireguard_config,
                require_current=args.phase in {"private-postcheck", "postcheck"},
            )
        if args.backup_dir is not None:
            validate_backup(args.backup_dir, manifest, phase=args.phase)
        if args.phase == "private-postcheck":
            assert args.pki_dir is not None
            validate_private_postcheck(manifest, args.pki_dir)
        elif args.phase == "postcheck":
            assert args.pki_dir is not None
            validate_runtime_postcheck(manifest, args.pki_dir)
    except ManifestError as error:
        print(f"PREFLIGHT_FAILED code={error.code} check={error.path}", file=sys.stderr)
        print("RESULT: BLOCKED")
        return 1
    except PreflightError as error:
        print(f"PREFLIGHT_FAILED code={error.code} check={error.check}", file=sys.stderr)
        print("RESULT: BLOCKED")
        return 1
    except (OSError, UnicodeError, ValueError):
        print("PREFLIGHT_FAILED code=unhandled_safe_failure check=runtime", file=sys.stderr)
        print("RESULT: BLOCKED")
        return 1
    print("MANIFEST_VALID: YES")
    print("RAW_VALUES_EMITTED: NO")
    print("WORKTREE_MUTATED: NO")
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

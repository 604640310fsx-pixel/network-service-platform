#!/usr/bin/env python3
"""Closed, forced-command-only raw-monitor ownership correlation.

This repository source is not an installer and is not production-deployable.
It accepts no caller arguments or stdin and emits only one bounded MOR1 record.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import stat
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence

# Isolated mode deliberately removes the script directory and current working
# directory from sys.path. Restore only the immutable root derived from this
# script's own location: the repository root in tests, or the future libexec
# bundle root containing a colocated ``monitoring`` package.
_SOURCE_PATH = Path(__file__).resolve()
if tuple(part for part in _SOURCE_PATH.parent.parts[-3:]) == (
    "monitoring",
    "gateway",
    "deploy",
):
    _IMPORT_ROOT = _SOURCE_PATH.parents[3]
else:
    _IMPORT_ROOT = _SOURCE_PATH.parent

ROLE = "FNOS_PRODUCTION"
OPERATION = "RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1"
REMOTE_RECORD_PATH = Path(
    "/etc/network-service-platform/monitor-gateway/"
    "raw-monitor-ownership-operation-v1.tlv"
)
REMOTE_OPERATION_PATH = Path(
    "/usr/local/libexec/network-service-platform/"
    "raw-monitor-ownership-correlation-readonly-v1.py"
)
ACCEPTED_PROBE_PATH = _IMPORT_ROOT / "monitoring/gateway/deploy/raw_monitor_probe.py"
SYSTEMCTL_PATH = "/usr/bin/systemctl"
REMOTE_BUILD = 1
RECORD_VERSION = 1
RMOR1_MAX_BYTES = 8192
MOR1_MAX_BYTES = 32768
PROC_TABLE_MAX_BYTES = 1024 * 1024
METADATA_MAX_BYTES = 64 * 1024
SYSTEMCTL_MAX_BYTES = 4096
HASH_CHUNK_BYTES = 64 * 1024
MAX_CANDIDATES = 64
_ACCEPTED_PROBE_MODULE = None

REASON_CODES = frozenset(
    {
        "SUCCESS",
        "REMOTE_OUTPUT_INVALID_OR_OVERSIZED",
        "REMOTE_OPERATION_PERMISSION_DENIED",
        "REMOTE_OPERATION_POLICY_REJECTED",
        "REMOTE_OPERATION_FAILED",
        "OWNERSHIP_ZERO_MATCH",
        "OWNERSHIP_MULTIPLE_MATCHES",
        "OWNERSHIP_UNEXPECTED_MATCH",
        "OWNERSHIP_UNKNOWN",
        "INTERNAL_FAIL_CLOSED",
    }
)
LIVE_CLASSIFICATIONS = frozenset(
    {
        "ZERO_MATCH",
        "UNIQUE_EXPECTED_MATCH",
        "UNIQUE_UNEXPECTED_MATCH",
        "MULTIPLE_MATCHES",
        "UNKNOWN",
        "NOT_RUN",
    }
)
OPERATION_RESULTS = frozenset({"SUCCESS", "FAILED", "BLOCKED", "NOT_RUN"})
OWNERSHIP_RESULTS = frozenset(
    {"MATCH", "ZERO_MATCH", "MULTIPLE_MATCHES", "UNEXPECTED_MATCH", "UNKNOWN", "NOT_RUN"}
)
UNIT_PATTERN = re.compile(r"(?=.{9,128}\Z)[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service\Z")
SOCKET_LINK_PATTERN = re.compile(r"socket:\[([0-9]{1,20})\]\Z")


class OperationError(RuntimeError):
    """A sanitized failure carrying only an allowlisted MOR1 reason code."""

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code if reason_code in REASON_CODES else "INTERNAL_FAIL_CLOSED"


def _accepted_probe_module():
    global _ACCEPTED_PROBE_MODULE
    if _ACCEPTED_PROBE_MODULE is not None:
        return _ACCEPTED_PROBE_MODULE
    module_name = "_nsp_accepted_raw_monitor_probe_v1"
    try:
        if str(_IMPORT_ROOT) not in sys.path:
            sys.path.insert(0, str(_IMPORT_ROOT))
        specification = importlib.util.spec_from_file_location(module_name, ACCEPTED_PROBE_PATH)
        if specification is None or specification.loader is None:
            raise RuntimeError
        loaded = importlib.util.module_from_spec(specification)
        sys.modules[module_name] = loaded
        specification.loader.exec_module(loaded)
        if (
            Path(loaded.__file__).resolve() != ACCEPTED_PROBE_PATH.resolve()
            or loaded.MAX_CANDIDATES != MAX_CANDIDATES
            or loaded.SCHEMA_VERSION != "MGW-RAW-MONITOR-PROBE-DIAGNOSTIC-V1"
        ):
            raise RuntimeError
    except BaseException as error:
        sys.modules.pop(module_name, None)
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED") from error
    _ACCEPTED_PROBE_MODULE = loaded
    return loaded


@dataclass(frozen=True)
class RemoteRecord:
    expected_unit: str
    unit_fragment_sha256: bytes
    executable_sha256: bytes
    accepted_probe_sha256: bytes
    expires_at: int
    minimum_remote_build: int


@dataclass(frozen=True, order=True)
class ListenerCandidate:
    host: str
    port: int
    inodes: tuple[int, ...]

    def probe_candidate(self):
        return _accepted_probe_module().ProbeCandidate("http", self.host, self.port)


@dataclass(frozen=True)
class OperationResult:
    operation_result: str
    ownership_result: str
    live_match_classification: str
    reason_code: str
    probe_diagnostic: str | None


def _candidate_order(candidate: ListenerCandidate) -> tuple[int, str, tuple[int, ...]]:
    return candidate.port, candidate.host, candidate.inodes


def _read_u32(value: bytes) -> int:
    if len(value) != 4:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    return struct.unpack(">I", value)[0]


def _read_u64(value: bytes) -> int:
    if len(value) != 8:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    return struct.unpack(">Q", value)[0]


def _encode_tlv(tag: int, value: bytes) -> bytes:
    if not isinstance(tag, int) or isinstance(tag, bool) or not 1 <= tag <= 255:
        raise OperationError("INTERNAL_FAIL_CLOSED")
    if not isinstance(value, bytes) or len(value) > 0xFFFFFFFF:
        raise OperationError("INTERNAL_FAIL_CLOSED")
    return bytes((tag,)) + struct.pack(">I", len(value)) + value


def _parse_exact_tlvs(payload: bytes, magic: bytes, count: int, maximum: int) -> list[bytes]:
    if (
        not isinstance(payload, bytes)
        or len(payload) > maximum
        or not payload.startswith(magic)
    ):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    offset = len(magic)
    values: list[bytes] = []
    for expected_tag in range(1, count + 1):
        if len(payload) - offset < 5 or payload[offset] != expected_tag:
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        length = struct.unpack(">I", payload[offset + 1 : offset + 5])[0]
        offset += 5
        if length > len(payload) - offset:
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        values.append(payload[offset : offset + length])
        offset += length
    if offset != len(payload):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    return values


def _decode_ascii(value: bytes, *, maximum: int) -> str:
    if not value or len(value) > maximum or any(byte < 0x21 or byte > 0x7E for byte in value):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    try:
        return value.decode("ascii")
    except UnicodeDecodeError as error:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED") from error


def parse_remote_record(payload: bytes, *, now: int, current_build: int = REMOTE_BUILD) -> RemoteRecord:
    values = _parse_exact_tlvs(payload, b"RMOR1", 9, RMOR1_MAX_BYTES)
    version = _read_u32(values[0])
    role = _decode_ascii(values[1], maximum=31)
    operation = _decode_ascii(values[2], maximum=63)
    unit = _decode_ascii(values[3], maximum=128)
    expires_at = _read_u64(values[7])
    minimum_build = _read_u32(values[8])
    if (
        version != RECORD_VERSION
        or role != ROLE
        or operation != OPERATION
        or UNIT_PATTERN.fullmatch(unit) is None
        or ".." in unit
        or any(len(value) != 32 for value in values[4:7])
        or isinstance(now, bool)
        or not isinstance(now, int)
        or expires_at <= now
        or minimum_build < 1
        or minimum_build > current_build
    ):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    return RemoteRecord(
        expected_unit=unit,
        unit_fragment_sha256=values[4],
        executable_sha256=values[5],
        accepted_probe_sha256=values[6],
        expires_at=expires_at,
        minimum_remote_build=minimum_build,
    )


def encode_remote_record(record: RemoteRecord) -> bytes:
    if UNIT_PATTERN.fullmatch(record.expected_unit) is None or ".." in record.expected_unit:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    fields = (
        struct.pack(">I", RECORD_VERSION),
        ROLE.encode("ascii"),
        OPERATION.encode("ascii"),
        record.expected_unit.encode("ascii"),
        record.unit_fragment_sha256,
        record.executable_sha256,
        record.accepted_probe_sha256,
        struct.pack(">Q", record.expires_at),
        struct.pack(">I", record.minimum_remote_build),
    )
    if any(len(value) != 32 for value in fields[4:7]):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    encoded = b"RMOR1" + b"".join(_encode_tlv(index, value) for index, value in enumerate(fields, 1))
    if len(encoded) > RMOR1_MAX_BYTES:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    return encoded


def _mode(metadata: os.stat_result) -> int:
    return stat.S_IMODE(metadata.st_mode)


def _validate_root_nonwritable_ancestors(path: Path) -> None:
    current = path.parent
    while True:
        try:
            metadata = os.lstat(current)
        except OSError as error:
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED") from error
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != 0
            or _mode(metadata) & (stat.S_IWGRP | stat.S_IWOTH)
        ):
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        if current == current.parent:
            return
        current = current.parent


def validate_remote_record_metadata(
    parent_metadata: os.stat_result,
    record_metadata: os.stat_result,
    opened_metadata: os.stat_result,
    *,
    effective_uid: int,
    effective_gid: int,
    primary_gid: int,
) -> None:
    if (
        effective_uid == 0
        or effective_gid != primary_gid
        or not stat.S_ISDIR(parent_metadata.st_mode)
        or stat.S_ISLNK(parent_metadata.st_mode)
        or parent_metadata.st_uid != 0
        or parent_metadata.st_gid != primary_gid
        or _mode(parent_metadata) != 0o750
        or not stat.S_ISREG(record_metadata.st_mode)
        or stat.S_ISLNK(record_metadata.st_mode)
        or record_metadata.st_uid != 0
        or record_metadata.st_gid != primary_gid
        or _mode(record_metadata) != 0o440
        or record_metadata.st_dev != opened_metadata.st_dev
        or record_metadata.st_ino != opened_metadata.st_ino
        or record_metadata.st_mode != opened_metadata.st_mode
        or record_metadata.st_uid != opened_metadata.st_uid
        or record_metadata.st_gid != opened_metadata.st_gid
    ):
        raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED")


def validate_remote_runtime_integrity() -> None:
    source = Path(os.path.abspath(__file__))
    try:
        source_metadata = os.lstat(source)
        resolved = Path(os.path.realpath(source))
        parent_metadata = os.lstat(REMOTE_OPERATION_PATH.parent)
    except OSError as error:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED") from error
    if (
        source != REMOTE_OPERATION_PATH
        or resolved != REMOTE_OPERATION_PATH
        or not stat.S_ISREG(source_metadata.st_mode)
        or stat.S_ISLNK(source_metadata.st_mode)
        or source_metadata.st_uid != 0
        or source_metadata.st_gid != 0
        or _mode(source_metadata) != 0o555
        or not stat.S_ISDIR(parent_metadata.st_mode)
        or stat.S_ISLNK(parent_metadata.st_mode)
        or parent_metadata.st_uid != 0
        or parent_metadata.st_gid != 0
        or _mode(parent_metadata) != 0o755
    ):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    _validate_root_nonwritable_ancestors(REMOTE_OPERATION_PATH)


def _read_fd_bounded(descriptor: int, maximum: int) -> bytes:
    chunks: list[bytes] = []
    received = 0
    while True:
        chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - received))
        if not chunk:
            break
        chunks.append(chunk)
        received += len(chunk)
        if received > maximum:
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    return b"".join(chunks)


def read_remote_record(path: Path = REMOTE_RECORD_PATH) -> RemoteRecord:
    effective_uid = os.geteuid()
    effective_gid = os.getegid()
    try:
        primary_gid = os.getgid()
        parent_metadata = os.lstat(path.parent)
        record_metadata = os.lstat(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError) as error:
        raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED") from error
    try:
        opened_metadata = os.fstat(descriptor)
        validate_remote_record_metadata(
            parent_metadata,
            record_metadata,
            opened_metadata,
            effective_uid=effective_uid,
            effective_gid=effective_gid,
            primary_gid=primary_gid,
        )
        payload = _read_fd_bounded(descriptor, RMOR1_MAX_BYTES)
    finally:
        os.close(descriptor)
    return parse_remote_record(payload, now=int(time.time()))


def _read_fixed_file(path: Path, maximum: int) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError) as error:
        raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        return _read_fd_bounded(descriptor, maximum)
    finally:
        os.close(descriptor)


def _sha256_file(
    path: Path,
    *,
    require_root_nonwritable: bool,
    allow_kernel_symlink: bool = False,
) -> bytes:
    if require_root_nonwritable:
        _validate_root_nonwritable_ancestors(path)
    try:
        path_metadata = os.lstat(path)
        open_flags = os.O_RDONLY | os.O_CLOEXEC
        if not allow_kernel_symlink:
            open_flags |= os.O_NOFOLLOW
        descriptor = os.open(path, open_flags)
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError) as error:
        raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED") from error
    digest = hashlib.sha256()
    try:
        opened_metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_metadata.st_mode)
            or (
                not allow_kernel_symlink
                and (
                    not stat.S_ISREG(path_metadata.st_mode)
                    or stat.S_ISLNK(path_metadata.st_mode)
                    or path_metadata.st_dev != opened_metadata.st_dev
                    or path_metadata.st_ino != opened_metadata.st_ino
                )
            )
            or (
                require_root_nonwritable
                and (
                    path_metadata.st_uid != 0
                    or _mode(path_metadata) & (stat.S_IWGRP | stat.S_IWOTH)
                )
            )
        ):
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        while True:
            chunk = os.read(descriptor, HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        os.close(descriptor)
    return digest.digest()


def _decode_ipv4_proc_address(raw: str) -> str | None:
    if len(raw) != 8 or any(character not in "0123456789ABCDEF" for character in raw):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    decoded = bytes.fromhex(raw)[::-1]
    if decoded == b"\x00\x00\x00\x00" or decoded[0] == 127:
        return "127.0.0.1"
    return None


def _decode_ipv6_proc_address(raw: str) -> str | None:
    if len(raw) != 32 or any(character not in "0123456789ABCDEF" for character in raw):
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    encoded = bytes.fromhex(raw)
    decoded = b"".join(encoded[index : index + 4][::-1] for index in range(0, 16, 4))
    if decoded in (b"\x00" * 16, b"\x00" * 15 + b"\x01"):
        return "::1"
    return None


def _parse_proc_table(text: str, *, ipv6: bool) -> list[tuple[str, int, int]]:
    output: list[tuple[str, int, int]] = []
    if not isinstance(text, str) or len(text.encode("ascii", "ignore")) > PROC_TABLE_MAX_BYTES:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    for line_number, line in enumerate(text.splitlines()):
        if line_number == 0 and "local_address" in line:
            continue
        fields = line.split()
        if not fields:
            continue
        if len(fields) < 10 or fields[3] != "0A" or ":" not in fields[1]:
            continue
        address_raw, port_raw = fields[1].rsplit(":", 1)
        try:
            port = int(port_raw, 16)
            inode = int(fields[9], 10)
        except ValueError as error:
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED") from error
        if not 1 <= port <= 65535 or inode <= 0:
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        host = _decode_ipv6_proc_address(address_raw) if ipv6 else _decode_ipv4_proc_address(address_raw)
        if host is not None:
            output.append((host, port, inode))
    return output


def candidates_from_proc_tables(ipv4_table: str, ipv6_table: str) -> list[ListenerCandidate]:
    grouped: dict[tuple[str, int], set[int]] = {}
    for host, port, inode in (
        _parse_proc_table(ipv4_table, ipv6=False)
        + _parse_proc_table(ipv6_table, ipv6=True)
    ):
        grouped.setdefault((host, port), set()).add(inode)
    if len(grouped) > MAX_CANDIDATES:
        raise OperationError("OWNERSHIP_UNKNOWN")
    return [
        ListenerCandidate(host=host, port=port, inodes=tuple(sorted(inodes)))
        for (host, port), inodes in sorted(grouped.items(), key=lambda item: (item[0][1], item[0][0]))
    ]


def discover_listener_candidates(proc_root: Path = Path("/proc")) -> list[ListenerCandidate]:
    ipv4 = _read_fixed_file(proc_root / "net" / "tcp", PROC_TABLE_MAX_BYTES)
    ipv6 = _read_fixed_file(proc_root / "net" / "tcp6", PROC_TABLE_MAX_BYTES)
    try:
        return candidates_from_proc_tables(ipv4.decode("ascii"), ipv6.decode("ascii"))
    except UnicodeDecodeError as error:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED") from error


def find_processes_for_inodes(
    inodes: Iterable[int],
    proc_root: Path = Path("/proc"),
) -> dict[int, set[int]]:
    wanted = frozenset(inodes)
    if not wanted or any(not isinstance(inode, int) or isinstance(inode, bool) or inode <= 0 for inode in wanted):
        raise OperationError("OWNERSHIP_UNKNOWN")
    found = {inode: set() for inode in wanted}
    try:
        process_entries = sorted(
            (entry for entry in os.scandir(proc_root) if entry.name.isdecimal()),
            key=lambda entry: int(entry.name),
        )
        for process_entry in process_entries:
            pid = int(process_entry.name)
            fd_path = proc_root / process_entry.name / "fd"
            try:
                descriptors = sorted(os.scandir(fd_path), key=lambda entry: int(entry.name))
            except (FileNotFoundError, ProcessLookupError):
                continue
            except (PermissionError, OSError) as error:
                raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED") from error
            for descriptor in descriptors:
                try:
                    target = os.readlink(descriptor.path)
                except (FileNotFoundError, ProcessLookupError):
                    continue
                except (PermissionError, OSError) as error:
                    raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED") from error
                match = SOCKET_LINK_PATTERN.fullmatch(target)
                if match is not None:
                    inode = int(match.group(1))
                    if inode in found:
                        found[inode].add(pid)
    except (PermissionError, OSError) as error:
        if isinstance(error, OperationError):
            raise
        raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED") from error
    return found


def _parse_cgroup(payload: bytes) -> str:
    if len(payload) > METADATA_MAX_BYTES:
        raise OperationError("OWNERSHIP_UNKNOWN")
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise OperationError("OWNERSHIP_UNKNOWN") from error
    unified = [line[3:] for line in lines if line.startswith("0::/")]
    if len(unified) != 1 or not unified[0].startswith("/") or ".." in unified[0].split("/"):
        raise OperationError("OWNERSHIP_UNKNOWN")
    return unified[0]


def systemctl_show(
    unit: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> dict[str, str]:
    if UNIT_PATTERN.fullmatch(unit) is None or ".." in unit:
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
    argv = [
        SYSTEMCTL_PATH,
        "show",
        "--no-pager",
        "--property=MainPID",
        "--property=ControlGroup",
        "--property=FragmentPath",
        unit,
    ]
    try:
        completed = runner(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
            env={"LC_ALL": "C", "LANG": "C"},
        )
    except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired, OSError) as error:
        raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED") from error
    if completed.returncode != 0 or len(completed.stdout) > SYSTEMCTL_MAX_BYTES:
        raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED")
    try:
        lines = completed.stdout.decode("ascii").splitlines()
    except UnicodeDecodeError as error:
        raise OperationError("OWNERSHIP_UNKNOWN") from error
    values: dict[str, str] = {}
    for line in lines:
        if "=" not in line:
            raise OperationError("OWNERSHIP_UNKNOWN")
        key, value = line.split("=", 1)
        if key not in {"MainPID", "ControlGroup", "FragmentPath"} or key in values:
            raise OperationError("OWNERSHIP_UNKNOWN")
        values[key] = value
    if set(values) != {"MainPID", "ControlGroup", "FragmentPath"}:
        raise OperationError("OWNERSHIP_UNKNOWN")
    return values


def correlate_expected_ownership(
    candidate: ListenerCandidate,
    record: RemoteRecord,
    *,
    proc_root: Path = Path("/proc"),
    process_lookup: Callable[[Iterable[int], Path], dict[int, set[int]]] | None = None,
    systemctl_reader: Callable[[str], Mapping[str, str]] = systemctl_show,
    file_hasher: Callable[..., bytes] = _sha256_file,
) -> bool:
    if len(candidate.inodes) != 1:
        raise OperationError("OWNERSHIP_UNKNOWN")
    lookup = process_lookup or (lambda inode_values, root: find_processes_for_inodes(inode_values, root))
    owners = lookup(candidate.inodes, proc_root)
    processes = owners.get(candidate.inodes[0], set())
    if len(processes) != 1:
        raise OperationError("OWNERSHIP_UNKNOWN")
    pid = next(iter(processes))
    cgroup = _parse_cgroup(_read_fixed_file(proc_root / str(pid) / "cgroup", METADATA_MAX_BYTES))
    unit_values = systemctl_reader(record.expected_unit)
    try:
        main_pid = int(unit_values["MainPID"], 10)
        control_group = unit_values["ControlGroup"]
        fragment_path = Path(unit_values["FragmentPath"])
    except (KeyError, TypeError, ValueError) as error:
        raise OperationError("OWNERSHIP_UNKNOWN") from error
    if main_pid != pid or control_group != cgroup or not fragment_path.is_absolute():
        return False
    if file_hasher(fragment_path, require_root_nonwritable=True) != record.unit_fragment_sha256:
        return False
    if file_hasher(
        proc_root / str(pid) / "exe",
        require_root_nonwritable=False,
        allow_kernel_symlink=True,
    ) != record.executable_sha256:
        return False
    if file_hasher(ACCEPTED_PROBE_PATH, require_root_nonwritable=True) != record.accepted_probe_sha256:
        return False
    return True


def _probe_matches(summary: Mapping[str, object]) -> list[int]:
    try:
        rendered = _accepted_probe_module().render_diagnostic(summary)
        canonical = json.dumps(json.loads(rendered), ensure_ascii=True, separators=(",", ":"))
        records = summary["records"]
    except (KeyError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        raise OperationError("REMOTE_OUTPUT_INVALID_OR_OVERSIZED") from error
    if rendered != canonical or not isinstance(records, list):
        raise OperationError("REMOTE_OUTPUT_INVALID_OR_OVERSIZED")
    return [
        int(record["attemptIndex"])
        for record in records
        if isinstance(record, dict) and record.get("result") == "MATCH"
    ]


def execute_operation(
    record: RemoteRecord,
    *,
    candidates: Sequence[ListenerCandidate] | None = None,
    probe: Callable[[Iterable[object]], dict[str, object]] | None = None,
    correlator: Callable[[ListenerCandidate, RemoteRecord], bool] = correlate_expected_ownership,
) -> OperationResult:
    selected = list(candidates if candidates is not None else discover_listener_candidates())
    if len(selected) > MAX_CANDIDATES or selected != sorted(set(selected), key=_candidate_order):
        raise OperationError("OWNERSHIP_UNKNOWN")
    selected_probe = _accepted_probe_module().probe_candidates if probe is None else probe
    summary = selected_probe(candidate.probe_candidate() for candidate in selected)
    diagnostic = _accepted_probe_module().render_diagnostic(summary)
    if len(diagnostic.encode("ascii")) > MOR1_MAX_BYTES:
        raise OperationError("REMOTE_OUTPUT_INVALID_OR_OVERSIZED")
    matches = _probe_matches(summary)
    if not matches:
        return OperationResult("SUCCESS", "ZERO_MATCH", "ZERO_MATCH", "OWNERSHIP_ZERO_MATCH", diagnostic)
    if len(matches) > 1:
        return OperationResult(
            "SUCCESS",
            "MULTIPLE_MATCHES",
            "MULTIPLE_MATCHES",
            "OWNERSHIP_MULTIPLE_MATCHES",
            diagnostic,
        )
    attempt_index = matches[0]
    if not 1 <= attempt_index <= len(selected):
        raise OperationError("REMOTE_OUTPUT_INVALID_OR_OVERSIZED")
    candidate = selected[attempt_index - 1]
    try:
        expected = correlator(candidate, record)
    except OperationError as error:
        if error.reason_code == "REMOTE_OPERATION_PERMISSION_DENIED":
            raise
        return OperationResult("FAILED", "UNKNOWN", "UNKNOWN", "OWNERSHIP_UNKNOWN", diagnostic)
    if expected:
        return OperationResult("SUCCESS", "MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS", diagnostic)
    return OperationResult(
        "SUCCESS",
        "UNEXPECTED_MATCH",
        "UNIQUE_UNEXPECTED_MATCH",
        "OWNERSHIP_UNEXPECTED_MATCH",
        diagnostic,
    )


def encode_mor1(result: OperationResult) -> bytes:
    semantic_tuple = (
        result.operation_result,
        result.ownership_result,
        result.live_match_classification,
        result.reason_code,
    )
    positive = {
        ("SUCCESS", "MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS"),
        ("SUCCESS", "ZERO_MATCH", "ZERO_MATCH", "OWNERSHIP_ZERO_MATCH"),
        ("SUCCESS", "MULTIPLE_MATCHES", "MULTIPLE_MATCHES", "OWNERSHIP_MULTIPLE_MATCHES"),
        ("SUCCESS", "UNEXPECTED_MATCH", "UNIQUE_UNEXPECTED_MATCH", "OWNERSHIP_UNEXPECTED_MATCH"),
    }
    unknown = ("FAILED", "UNKNOWN", "UNKNOWN", "OWNERSHIP_UNKNOWN")
    closed_failures = {
        ("BLOCKED", "UNKNOWN", "UNKNOWN", "REMOTE_OPERATION_PERMISSION_DENIED"),
        ("BLOCKED", "NOT_RUN", "NOT_RUN", "REMOTE_OPERATION_POLICY_REJECTED"),
        ("FAILED", "UNKNOWN", "UNKNOWN", "REMOTE_OUTPUT_INVALID_OR_OVERSIZED"),
        ("FAILED", "UNKNOWN", "UNKNOWN", "REMOTE_OPERATION_FAILED"),
        ("FAILED", "UNKNOWN", "UNKNOWN", "INTERNAL_FAIL_CLOSED"),
    }
    if (
        result.operation_result not in OPERATION_RESULTS
        or result.ownership_result not in OWNERSHIP_RESULTS
        or result.live_match_classification not in LIVE_CLASSIFICATIONS
        or result.reason_code not in REASON_CODES
        or (semantic_tuple not in positive and semantic_tuple != unknown and semantic_tuple not in closed_failures)
        or (semantic_tuple in positive and result.probe_diagnostic is None)
        or (semantic_tuple in closed_failures and result.probe_diagnostic is not None)
    ):
        raise OperationError("INTERNAL_FAIL_CLOSED")
    probe = b"" if result.probe_diagnostic is None else result.probe_diagnostic.encode("ascii")
    if probe:
        try:
            parsed = json.loads(probe)
            canonical = json.dumps(parsed, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            _accepted_probe_module().render_diagnostic(parsed)
        except (UnicodeEncodeError, json.JSONDecodeError, TypeError, ValueError, RuntimeError) as error:
            raise OperationError("REMOTE_OUTPUT_INVALID_OR_OVERSIZED") from error
        if canonical != probe:
            raise OperationError("REMOTE_OUTPUT_INVALID_OR_OVERSIZED")
    fields = (
        struct.pack(">I", RECORD_VERSION),
        result.operation_result.encode("ascii"),
        result.ownership_result.encode("ascii"),
        result.live_match_classification.encode("ascii"),
        result.reason_code.encode("ascii"),
        b"NONE",
        struct.pack(">I", 0),
        b"NONE",
        probe,
    )
    output = b"MOR1" + b"".join(_encode_tlv(index, value) for index, value in enumerate(fields, 1))
    if len(output) > MOR1_MAX_BYTES:
        raise OperationError("REMOTE_OUTPUT_INVALID_OR_OVERSIZED")
    return output


def _stdin_has_data(descriptor: int = 0) -> bool:
    try:
        flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
        fcntl.fcntl(descriptor, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        try:
            return os.read(descriptor, 1) != b""
        except BlockingIOError:
            return False
        finally:
            fcntl.fcntl(descriptor, fcntl.F_SETFL, flags)
    except OSError as error:
        if error.errno in {errno.EBADF, errno.ENOTTY}:
            return False
        raise OperationError("REMOTE_OPERATION_POLICY_REJECTED") from error


def invocation_allowed(
    argv: Sequence[str],
    environment: Mapping[str, str],
    *,
    effective_uid: int,
    stdin_has_data: Callable[[], bool] = _stdin_has_data,
) -> bool:
    return (
        len(argv) == 1
        and effective_uid != 0
        and not environment.get("SSH_ORIGINAL_COMMAND")
        and not stdin_has_data()
    )


def _sanitized_failure(reason_code: str) -> OperationResult:
    if reason_code == "REMOTE_OPERATION_PERMISSION_DENIED":
        return OperationResult("BLOCKED", "UNKNOWN", "UNKNOWN", reason_code, None)
    if reason_code == "REMOTE_OPERATION_POLICY_REJECTED":
        return OperationResult("BLOCKED", "NOT_RUN", "NOT_RUN", reason_code, None)
    return OperationResult("FAILED", "UNKNOWN", "UNKNOWN", reason_code, None)


def main() -> int:
    result: OperationResult
    try:
        if not invocation_allowed(sys.argv, os.environ, effective_uid=os.geteuid()):
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        validate_remote_runtime_integrity()
        record = read_remote_record()
        if _sha256_file(ACCEPTED_PROBE_PATH, require_root_nonwritable=True) != record.accepted_probe_sha256:
            raise OperationError("REMOTE_OPERATION_POLICY_REJECTED")
        result = execute_operation(record)
    except OperationError as error:
        result = _sanitized_failure(error.reason_code)
    except BaseException:
        result = _sanitized_failure("INTERNAL_FAIL_CLOSED")
    try:
        output = encode_mor1(result)
    except BaseException:
        output = encode_mor1(_sanitized_failure("INTERNAL_FAIL_CLOSED"))
    try:
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()
    except BaseException:
        return 74
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import struct
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from monitoring.gateway.deploy import raw_monitor_ownership_operation as operation
from monitoring.gateway.deploy.raw_monitor_ownership_operation import (
    ListenerCandidate,
    OperationError,
    OperationResult,
    RemoteRecord,
    candidates_from_proc_tables,
    correlate_expected_ownership,
    encode_mor1,
    encode_remote_record,
    execute_operation,
    invocation_allowed,
    parse_remote_record,
    systemctl_show,
    validate_remote_record_metadata,
)
from monitoring.gateway.deploy.raw_monitor_probe import MAX_CANDIDATES, SCHEMA_VERSION


REPOSITORY = Path(__file__).resolve().parents[3]
SOURCE = REPOSITORY / "monitoring/gateway/deploy/raw_monitor_ownership_operation.py"


def _record(*, expires_at: int = 2_000_000_000, minimum_build: int = 1) -> RemoteRecord:
    return RemoteRecord(
        expected_unit="raw-monitor-api.service",
        unit_fragment_sha256=b"f" * 32,
        executable_sha256=b"e" * 32,
        accepted_probe_sha256=b"p" * 32,
        expires_at=expires_at,
        minimum_remote_build=minimum_build,
    )


def _tlv(tag: int, value: bytes) -> bytes:
    return bytes((tag,)) + struct.pack(">I", len(value)) + value


def _remote_fields(record: RemoteRecord | None = None) -> list[bytes]:
    selected = _record() if record is None else record
    return [
        struct.pack(">I", 1),
        operation.ROLE.encode("ascii"),
        operation.OPERATION.encode("ascii"),
        selected.expected_unit.encode("ascii"),
        selected.unit_fragment_sha256,
        selected.executable_sha256,
        selected.accepted_probe_sha256,
        struct.pack(">Q", selected.expires_at),
        struct.pack(">I", selected.minimum_remote_build),
    ]


def _remote_payload(fields: list[bytes] | None = None, tags: list[int] | None = None) -> bytes:
    selected = _remote_fields() if fields is None else fields
    selected_tags = list(range(1, 10)) if tags is None else tags
    return b"RMOR1" + b"".join(_tlv(tag, value) for tag, value in zip(selected_tags, selected))


def _summary(candidate_count: int, matches: set[int] | None = None) -> dict[str, object]:
    selected_matches = set() if matches is None else matches
    records = []
    for index in range(1, candidate_count + 1):
        matched = index in selected_matches
        records.append(
            {
                "attemptIndex": index,
                "result": "MATCH" if matched else "NO_MATCH",
                "failureStage": "NONE" if matched else "CONNECT",
                "reasonCode": "MATCH" if matched else "CONNECTION_OR_PROTOCOL_FAILURE",
                "httpStatus": 200 if matched else None,
            }
        )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "candidateCount": candidate_count,
        "overviewHttp200MatchCount": len(selected_matches),
        "fullContractMatchCount": len(selected_matches),
        "records": records,
    }


def _proc_line(address: str, port: int, inode: int, *, state: str = "0A") -> str:
    return (
        f"0: {address}:{port:04X} 00000000:0000 {state} "
        f"00000000:00000000 00:00000000 00000000 1000 0 {inode}"
    )


def _decode_tlvs(payload: bytes, magic: bytes, count: int) -> list[bytes]:
    if not payload.startswith(magic):
        raise AssertionError("wrong magic")
    offset = len(magic)
    values = []
    for expected_tag in range(1, count + 1):
        if payload[offset] != expected_tag:
            raise AssertionError("wrong tag")
        length = struct.unpack(">I", payload[offset + 1 : offset + 5])[0]
        offset += 5
        values.append(payload[offset : offset + length])
        offset += length
    if offset != len(payload):
        raise AssertionError("trailing bytes")
    return values


class RemoteRecordContractTests(unittest.TestCase):
    def test_rmor1_exact_round_trip(self) -> None:
        expected = _record()
        encoded = encode_remote_record(expected)
        self.assertTrue(encoded.startswith(b"RMOR1"))
        self.assertEqual(parse_remote_record(encoded, now=1_900_000_000), expected)
        values = _decode_tlvs(encoded, b"RMOR1", 9)
        self.assertEqual(values[1], b"FNOS_PRODUCTION")
        self.assertEqual(values[2], b"RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1")
        self.assertEqual(values[3], b"raw-monitor-api.service")

    def test_rmor1_rejects_missing_extra_duplicate_reorder_trailing_and_oversize(self) -> None:
        valid = _remote_payload()
        malformed = [
            b"X" + valid[1:],
            valid[:-1],
            b"RMOR1" + b"".join(_tlv(tag, value) for tag, value in zip(range(1, 9), _remote_fields()[:-1])),
            valid + _tlv(10, b"x"),
            valid + b"x",
            _remote_payload(tags=[1, 2, 3, 4, 5, 6, 7, 8, 8]),
            _remote_payload(tags=[1, 3, 2, 4, 5, 6, 7, 8, 9]),
            b"RMOR1" + b"x" * operation.RMOR1_MAX_BYTES,
        ]
        for payload in malformed:
            with self.subTest(length=len(payload), digest=hashlib.sha256(payload).hexdigest()[:8]):
                with self.assertRaisesRegex(OperationError, "REMOTE_OPERATION_POLICY_REJECTED"):
                    parse_remote_record(payload, now=1_900_000_000)

    def test_rmor1_rejects_version_identity_hash_expiry_build_and_unit_drift(self) -> None:
        cases = {
            "version": (0, struct.pack(">I", 2)),
            "role": (1, b"OTHER"),
            "operation": (2, b"GENERIC_EXEC"),
            "unit": (3, b"../../escape.service"),
            "option-like unit": (3, b"--help.service"),
            "hidden unit": (3, b".hidden.service"),
            "double-dot unit": (3, b"raw..monitor.service"),
            "fragment digest": (4, b"short"),
            "executable digest": (5, b"short"),
            "probe digest": (6, b"short"),
            "expiry": (7, struct.pack(">Q", 1_900_000_000)),
            "minimum build zero": (8, struct.pack(">I", 0)),
            "future build": (8, struct.pack(">I", 2)),
        }
        for name, (index, replacement) in cases.items():
            with self.subTest(name=name):
                fields = _remote_fields()
                fields[index] = replacement
                with self.assertRaisesRegex(OperationError, "REMOTE_OPERATION_POLICY_REJECTED"):
                    parse_remote_record(_remote_payload(fields), now=1_900_000_000, current_build=1)

    def test_remote_record_requires_revised_root_group_0440_contract(self) -> None:
        primary_gid = 4242

        def metadata(kind: int, mode: int, uid: int, gid: int, inode: int = 10) -> types.SimpleNamespace:
            return types.SimpleNamespace(
                st_mode=kind | mode,
                st_uid=uid,
                st_gid=gid,
                st_dev=1,
                st_ino=inode,
            )

        parent = metadata(stat.S_IFDIR, 0o750, 0, primary_gid, 1)
        path = metadata(stat.S_IFREG, 0o440, 0, primary_gid)
        opened = metadata(stat.S_IFREG, 0o440, 0, primary_gid)
        validate_remote_record_metadata(
            parent,
            path,
            opened,
            effective_uid=501,
            effective_gid=primary_gid,
            primary_gid=primary_gid,
        )
        mutations = [
            ("root execution", {}, {"effective_uid": 0}),
            ("wrong effective group", {}, {"effective_gid": 7}),
            ("parent owner", {"parent": metadata(stat.S_IFDIR, 0o750, 501, primary_gid, 1)}, {}),
            ("parent mode", {"parent": metadata(stat.S_IFDIR, 0o755, 0, primary_gid, 1)}, {}),
            ("record owner", {"path": metadata(stat.S_IFREG, 0o440, 501, primary_gid)}, {}),
            ("record group", {"path": metadata(stat.S_IFREG, 0o440, 0, 7)}, {}),
            ("record mode", {"path": metadata(stat.S_IFREG, 0o400, 0, primary_gid)}, {}),
            ("identity mismatch", {"opened": metadata(stat.S_IFREG, 0o440, 0, primary_gid, 11)}, {}),
        ]
        for name, replacements, keyword_replacements in mutations:
            with self.subTest(name=name):
                kwargs = {
                    "effective_uid": 501,
                    "effective_gid": primary_gid,
                    "primary_gid": primary_gid,
                }
                kwargs.update(keyword_replacements)
                with self.assertRaisesRegex(OperationError, "REMOTE_OPERATION_PERMISSION_DENIED"):
                    validate_remote_record_metadata(
                        replacements.get("parent", parent),
                        replacements.get("path", path),
                        replacements.get("opened", opened),
                        **kwargs,
                    )


class CandidateDiscoveryTests(unittest.TestCase):
    def test_only_tcp_listen_loopback_or_wildcard_is_selected_and_deduplicated(self) -> None:
        header = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode"
        ipv4 = "\n".join(
            [
                header,
                _proc_line("0100007F", 9100, 101),
                _proc_line("00000000", 9100, 102),
                _proc_line("0100007F", 9100, 101),
                _proc_line("0101A8C0", 9200, 103),
                _proc_line("0100007F", 9300, 104, state="01"),
            ]
        )
        ipv6 = "\n".join(
            [
                header,
                _proc_line("00000000000000000000000001000000", 9000, 201),
                _proc_line("00000000000000000000000000000000", 9000, 202),
                _proc_line("FE800000000000000000000001000000", 9400, 203),
            ]
        )
        self.assertEqual(
            candidates_from_proc_tables(ipv4, ipv6),
            [
                ListenerCandidate("::1", 9000, (201, 202)),
                ListenerCandidate("127.0.0.1", 9100, (101, 102)),
            ],
        )

    def test_candidate_set_is_deterministic_and_bounded_to_64(self) -> None:
        lines = [
            _proc_line("0100007F", 10000 + index, index + 1)
            for index in reversed(range(MAX_CANDIDATES))
        ]
        candidates = candidates_from_proc_tables("\n".join(lines), "")
        self.assertEqual(len(candidates), MAX_CANDIDATES)
        self.assertEqual([item.port for item in candidates], list(range(10000, 10000 + MAX_CANDIDATES)))
        lines.append(_proc_line("0100007F", 20000, 1000))
        with self.assertRaisesRegex(OperationError, "OWNERSHIP_UNKNOWN"):
            candidates_from_proc_tables("\n".join(lines), "")

    def test_discovery_order_is_the_same_order_accepted_by_execution(self) -> None:
        candidates = candidates_from_proc_tables(
            _proc_line("0100007F", 9100, 1),
            _proc_line("00000000000000000000000001000000", 9000, 2),
        )

        def zero_probe(values):
            self.assertEqual(len(list(values)), 2)
            return _summary(2)

        result = execute_operation(_record(), candidates=candidates, probe=zero_probe)
        self.assertEqual(result.reason_code, "OWNERSHIP_ZERO_MATCH")

    def test_malformed_proc_values_fail_closed(self) -> None:
        for line in (
            _proc_line("INVALID0", 9100, 1),
            _proc_line("0100007F", 0, 1),
            _proc_line("0100007F", 9100, 0),
        ):
            with self.assertRaisesRegex(OperationError, "REMOTE_OPERATION_POLICY_REJECTED"):
                candidates_from_proc_tables(line, "")


class ForcedOperationTests(unittest.TestCase):
    def test_main_uses_zero_transport_exit_for_closed_nonmatch_mor1(self) -> None:
        diagnostic = json.dumps(_summary(0), ensure_ascii=True, separators=(",", ":"))
        closed = OperationResult(
            "SUCCESS",
            "ZERO_MATCH",
            "ZERO_MATCH",
            "OWNERSHIP_ZERO_MATCH",
            diagnostic,
        )
        output = io.BytesIO()
        fake_stdout = types.SimpleNamespace(buffer=output)
        with (
            patch.object(operation.sys, "argv", [str(operation.REMOTE_OPERATION_PATH)]),
            patch.object(operation.sys, "stdout", fake_stdout),
            patch.object(operation.os, "geteuid", return_value=501),
            patch.object(operation, "validate_remote_runtime_integrity"),
            patch.object(operation, "read_remote_record", return_value=_record()),
            patch.object(operation, "_sha256_file", return_value=b"p" * 32),
            patch.object(operation, "execute_operation", return_value=closed),
            patch.dict(operation.os.environ, {}, clear=True),
        ):
            self.assertEqual(operation.main(), 0)
        values = _decode_tlvs(output.getvalue(), b"MOR1", 9)
        self.assertEqual(values[2], b"ZERO_MATCH")
        self.assertEqual(values[4], b"OWNERSHIP_ZERO_MATCH")

    def test_module_loads_under_the_exact_isolated_python_flags_without_running_operation(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                (
                    "import runpy; "
                    f"m=runpy.run_path({str(SOURCE)!r}, run_name='synthetic_remote_operation'); "
                    "assert m['ROLE']=='FNOS_PRODUCTION'; "
                    "p=m['_accepted_probe_module'](); "
                    "assert p.__file__==str(m['ACCEPTED_PROBE_PATH'])"
                ),
            ],
            cwd=REPOSITORY,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        self.assertEqual(completed.stdout, b"")
        self.assertEqual(completed.stderr, b"")

    def test_forced_invocation_rejects_arguments_root_original_command_and_stdin(self) -> None:
        self.assertTrue(
            invocation_allowed(
                ["operation.py"], {}, effective_uid=501, stdin_has_data=lambda: False
            )
        )
        invalid = [
            (["operation.py", "argument"], {}, 501, False),
            (["operation.py"], {}, 0, False),
            (["operation.py"], {"SSH_ORIGINAL_COMMAND": "id"}, 501, False),
            (["operation.py"], {}, 501, True),
        ]
        for argv, environment, uid, has_stdin in invalid:
            self.assertFalse(
                invocation_allowed(
                    argv,
                    environment,
                    effective_uid=uid,
                    stdin_has_data=lambda value=has_stdin: value,
                )
            )

    def test_zero_unique_expected_unique_unexpected_and_multiple_results(self) -> None:
        record = _record()
        candidates = [
            ListenerCandidate("127.0.0.1", 9001, (101,)),
            ListenerCandidate("127.0.0.1", 9002, (102,)),
        ]

        def probe_for(matches: set[int]):
            def probe(values):
                observed = list(values)
                self.assertEqual(len(observed), 2)
                return _summary(2, matches)

            return probe

        zero = execute_operation(record, candidates=candidates, probe=probe_for(set()))
        self.assertEqual(
            (zero.ownership_result, zero.live_match_classification, zero.reason_code),
            ("ZERO_MATCH", "ZERO_MATCH", "OWNERSHIP_ZERO_MATCH"),
        )
        multiple = execute_operation(record, candidates=candidates, probe=probe_for({1, 2}))
        self.assertEqual(
            (multiple.ownership_result, multiple.live_match_classification, multiple.reason_code),
            ("MULTIPLE_MATCHES", "MULTIPLE_MATCHES", "OWNERSHIP_MULTIPLE_MATCHES"),
        )
        expected = execute_operation(
            record,
            candidates=candidates,
            probe=probe_for({1}),
            correlator=lambda _candidate, _record: True,
        )
        self.assertEqual(
            (expected.ownership_result, expected.live_match_classification, expected.reason_code),
            ("MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS"),
        )
        unexpected = execute_operation(
            record,
            candidates=candidates,
            probe=probe_for({2}),
            correlator=lambda _candidate, _record: False,
        )
        self.assertEqual(
            (unexpected.ownership_result, unexpected.live_match_classification, unexpected.reason_code),
            ("UNEXPECTED_MATCH", "UNIQUE_UNEXPECTED_MATCH", "OWNERSHIP_UNEXPECTED_MATCH"),
        )

    def test_ownership_ambiguity_is_unknown_and_permission_denial_is_not_bypassed(self) -> None:
        record = _record()
        candidate = [ListenerCandidate("127.0.0.1", 9001, (101,))]

        def probe(values):
            self.assertEqual(len(list(values)), 1)
            return _summary(1, {1})

        def unknown(_candidate, _record):
            raise OperationError("OWNERSHIP_UNKNOWN")

        result = execute_operation(record, candidates=candidate, probe=probe, correlator=unknown)
        self.assertEqual(
            (result.operation_result, result.ownership_result, result.reason_code),
            ("FAILED", "UNKNOWN", "OWNERSHIP_UNKNOWN"),
        )

        def denied(_candidate, _record):
            raise OperationError("REMOTE_OPERATION_PERMISSION_DENIED")

        with self.assertRaisesRegex(OperationError, "REMOTE_OPERATION_PERMISSION_DENIED"):
            execute_operation(record, candidates=candidate, probe=probe, correlator=denied)

    def test_unsorted_duplicate_or_excess_candidate_inputs_fail_closed(self) -> None:
        one = ListenerCandidate("127.0.0.1", 9001, (1,))
        two = ListenerCandidate("127.0.0.1", 9002, (2,))
        for selected in ([two, one], [one, one], [ListenerCandidate("127.0.0.1", port, (port,)) for port in range(1, 66)]):
            with self.assertRaisesRegex(OperationError, "OWNERSHIP_UNKNOWN"):
                execute_operation(_record(), candidates=selected)

    def test_correlation_requires_unique_inode_process_pid_cgroup_and_all_hashes(self) -> None:
        record = _record()
        candidate = ListenerCandidate("127.0.0.1", 9001, (101,))
        proc_root = Path("/synthetic/proc")

        def process_lookup(inodes, root):
            self.assertEqual(tuple(inodes), (101,))
            self.assertEqual(root, proc_root)
            return {101: {4321}}

        values = {
            "MainPID": "4321",
            "ControlGroup": "/system.slice/raw-monitor-api.service",
            "FragmentPath": "/synthetic/raw-monitor-api.service",
        }

        def hasher(path, *, require_root_nonwritable, allow_kernel_symlink=False):
            self.assertTrue(path.is_absolute())
            if path == Path("/synthetic/raw-monitor-api.service"):
                self.assertTrue(require_root_nonwritable)
                return b"f" * 32
            if path == proc_root / "4321/exe":
                self.assertTrue(allow_kernel_symlink)
                return b"e" * 32
            if path == operation.ACCEPTED_PROBE_PATH:
                self.assertTrue(require_root_nonwritable)
                return b"p" * 32
            raise AssertionError(path)

        with patch.object(
            operation,
            "_read_fixed_file",
            return_value=b"0::/system.slice/raw-monitor-api.service\n",
        ):
            self.assertTrue(
                correlate_expected_ownership(
                    candidate,
                    record,
                    proc_root=proc_root,
                    process_lookup=process_lookup,
                    systemctl_reader=lambda unit: values,
                    file_hasher=hasher,
                )
            )
            for field, replacement in (
                ("MainPID", "9999"),
                ("ControlGroup", "/system.slice/other.service"),
                ("FragmentPath", "relative.service"),
            ):
                changed = dict(values)
                changed[field] = replacement
                self.assertFalse(
                    correlate_expected_ownership(
                        candidate,
                        record,
                        proc_root=proc_root,
                        process_lookup=process_lookup,
                        systemctl_reader=lambda unit, selected=changed: selected,
                        file_hasher=hasher,
                    )
                )

        for ambiguous_candidate, lookup in (
            (ListenerCandidate("127.0.0.1", 9001, (101, 102)), process_lookup),
            (candidate, lambda _inodes, _root: {101: set()}),
            (candidate, lambda _inodes, _root: {101: {1, 2}}),
        ):
            with self.assertRaisesRegex(OperationError, "OWNERSHIP_UNKNOWN"):
                correlate_expected_ownership(
                    ambiguous_candidate,
                    record,
                    proc_root=proc_root,
                    process_lookup=lookup,
                )

    def test_each_fragment_executable_and_probe_hash_mismatch_rejects_ownership(self) -> None:
        record = _record()
        candidate = ListenerCandidate("127.0.0.1", 9001, (101,))
        proc_root = Path("/synthetic/proc")
        values = {
            "MainPID": "4321",
            "ControlGroup": "/system.slice/raw-monitor-api.service",
            "FragmentPath": "/synthetic/raw-monitor-api.service",
        }
        paths = [
            Path("/synthetic/raw-monitor-api.service"),
            proc_root / "4321/exe",
            operation.ACCEPTED_PROBE_PATH,
        ]
        expected = {paths[0]: b"f" * 32, paths[1]: b"e" * 32, paths[2]: b"p" * 32}
        with patch.object(
            operation,
            "_read_fixed_file",
            return_value=b"0::/system.slice/raw-monitor-api.service\n",
        ):
            for mismatched in paths:
                def hasher(path, **_kwargs):
                    return b"x" * 32 if path == mismatched else expected[path]

                self.assertFalse(
                    correlate_expected_ownership(
                        candidate,
                        record,
                        proc_root=proc_root,
                        process_lookup=lambda _inodes, _root: {101: {4321}},
                        systemctl_reader=lambda _unit: values,
                        file_hasher=hasher,
                    )
                )

    def test_systemctl_uses_only_the_frozen_argv_and_closed_environment(self) -> None:
        observed = {}

        def runner(argv, **kwargs):
            observed["argv"] = argv
            observed["kwargs"] = kwargs
            return subprocess.CompletedProcess(
                argv,
                0,
                stdout=(
                    b"MainPID=4321\n"
                    b"ControlGroup=/system.slice/raw-monitor-api.service\n"
                    b"FragmentPath=/etc/systemd/system/raw-monitor-api.service\n"
                ),
                stderr=b"",
            )

        values = systemctl_show("raw-monitor-api.service", runner=runner)
        self.assertEqual(values["MainPID"], "4321")
        self.assertEqual(
            observed["argv"],
            [
                "/usr/bin/systemctl",
                "show",
                "--no-pager",
                "--property=MainPID",
                "--property=ControlGroup",
                "--property=FragmentPath",
                "raw-monitor-api.service",
            ],
        )
        self.assertIs(observed["kwargs"]["stdin"], subprocess.DEVNULL)
        self.assertEqual(observed["kwargs"]["timeout"], 5)
        self.assertEqual(observed["kwargs"]["env"], {"LC_ALL": "C", "LANG": "C"})
        self.assertNotIn("shell", observed["kwargs"])
        for output in (
            b"MainPID=4321\nControlGroup=/x\n",
            b"MainPID=4321\nControlGroup=/x\nFragmentPath=/x\nExtra=x\n",
            b"MainPID=1\nMainPID=2\nControlGroup=/x\nFragmentPath=/x\n",
        ):
            with self.assertRaisesRegex(OperationError, "OWNERSHIP_UNKNOWN"):
                systemctl_show(
                    "raw-monitor-api.service",
                    runner=lambda argv, selected=output, **kwargs: subprocess.CompletedProcess(
                        argv, 0, stdout=selected, stderr=b""
                    ),
                )

    def test_mor1_is_exact_bounded_closed_and_contains_no_target_metadata(self) -> None:
        diagnostic = json.dumps(_summary(1, {1}), ensure_ascii=True, separators=(",", ":"))
        result = OperationResult("SUCCESS", "MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS", diagnostic)
        encoded = encode_mor1(result)
        self.assertLessEqual(len(encoded), 32768)
        values = _decode_tlvs(encoded, b"MOR1", 9)
        self.assertEqual(
            values[:8],
            [
                struct.pack(">I", 1),
                b"SUCCESS",
                b"MATCH",
                b"UNIQUE_EXPECTED_MATCH",
                b"SUCCESS",
                b"NONE",
                struct.pack(">I", 0),
                b"NONE",
            ],
        )
        self.assertEqual(values[8], diagnostic.encode("ascii"))
        for forbidden in (
            b"127.0.0.1",
            b"raw-monitor-api.service",
            b"/proc/",
            b"socket",
            b"inode",
            b"MainPID",
        ):
            self.assertNotIn(forbidden, encoded)
        invalid = [
            OperationResult("WRITTEN", "MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS", diagnostic),
            OperationResult("SUCCESS", "MATCH", "UNIQUE_EXPECTED_MATCH", "UNKNOWN_CODE", diagnostic),
            OperationResult("SUCCESS", "MATCH", "UNKNOWN", "SUCCESS", diagnostic),
            OperationResult("SUCCESS", "MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS", None),
            OperationResult("SUCCESS", "MATCH", "UNIQUE_EXPECTED_MATCH", "SUCCESS", "{}"),
        ]
        for item in invalid:
            with self.assertRaises(OperationError):
                encode_mor1(item)

    def test_source_has_no_generic_exec_shell_sudo_network_or_write_path(self) -> None:
        source = SOURCE.read_text(encoding="utf-8")
        for forbidden in (
            "shell=True",
            "os.system",
            "os.popen",
            "subprocess.Popen",
            "socket.socket",
            "http.client",
            "requests.",
            "sudo ",
            "open(REMOTE_RECORD_PATH, \"w",
            "write_text(",
            "write_bytes(",
        ):
            self.assertNotIn(forbidden, source)
        self.assertEqual(source.count("subprocess.run"), 1)
        self.assertIn("len(argv) == 1", source)
        self.assertIn("effective_uid != 0", source)
        self.assertIn('not environment.get("SSH_ORIGINAL_COMMAND")', source)
        self.assertIn("MAX_CANDIDATES", source)
        self.assertIn("validate_remote_runtime_integrity()", source)
        self.assertIn("_validate_root_nonwritable_ancestors(path)", source)
        self.assertIn("raw-monitor-ownership-correlation-readonly-v1.py", source)


if __name__ == "__main__":
    unittest.main()

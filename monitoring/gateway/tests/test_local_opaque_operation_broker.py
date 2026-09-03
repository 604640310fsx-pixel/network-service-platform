#!/usr/bin/env python3

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[3]
DEPLOY = REPOSITORY / "monitoring/gateway/deploy"
CORE_SOURCE = DEPLOY / "local_opaque_operation_broker_core.c"
BROKER_SOURCE = DEPLOY / "local_opaque_operation_broker.c"
ADMIN_SOURCE = DEPLOY / "local_opaque_operation_broker_admin.m"
ENTITLEMENTS = DEPLOY / "local_opaque_operation_broker.entitlements"

ROLE = b"FNOS_PRODUCTION"
OPERATION = b"RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1"
COMMAND_PROFILE = b"SERVER_FORCED_COMMAND_V1"
BROKER_SCHEMA = "LOCAL-OPAQUE-OPERATION-BROKER-RESULT-V1"
PROBE_SCHEMA = "MGW-RAW-MONITOR-PROBE-DIAGNOSTIC-V1"

REASON_CODES = {
    "SUCCESS",
    "INVALID_INVOCATION",
    "UNKNOWN_ROLE",
    "UNKNOWN_OPERATION",
    "BROKER_INTEGRITY_FAILURE",
    "PROTECTED_RECORD_NOT_FOUND",
    "PROTECTED_RECORD_AMBIGUOUS",
    "PROTECTED_RECORD_ACCESS_DENIED",
    "PROTECTED_RECORD_INTERACTION_REQUIRED",
    "PROTECTED_RECORD_INVALID",
    "RECORD_VERSION_MISMATCH",
    "RECORD_EXPIRED",
    "TARGET_BINDING_REJECTED",
    "HOST_KEY_BINDING_REJECTED",
    "IDENTITY_KEY_NOT_FOUND",
    "IDENTITY_KEY_ACCESS_DENIED",
    "IDENTITY_KEY_INTERACTION_REQUIRED",
    "IDENTITY_BINDING_REJECTED",
    "IDENTITY_AGENT_FAILURE",
    "TEMP_RESOURCE_FAILURE",
    "SSH_LAUNCH_FAILURE",
    "SSH_TIMEOUT",
    "SSH_HOST_KEY_REJECTED",
    "SSH_AUTHENTICATION_FAILED",
    "SSH_TRANSPORT_FAILURE",
    "REMOTE_OUTPUT_INVALID_OR_OVERSIZED",
    "REMOTE_OPERATION_PERMISSION_DENIED",
    "REMOTE_OPERATION_POLICY_REJECTED",
    "REMOTE_OPERATION_FAILED",
    "OWNERSHIP_ZERO_MATCH",
    "OWNERSHIP_MULTIPLE_MATCHES",
    "OWNERSHIP_UNEXPECTED_MATCH",
    "OWNERSHIP_UNKNOWN",
    "INTERRUPTED",
    "CLEANUP_FAILED",
    "INTERNAL_FAIL_CLOSED",
}


def _tlv(tag: int, value: bytes) -> bytes:
    return bytes((tag,)) + struct.pack(">I", len(value)) + value


def _mobr1_fields(*, now: int | None = None) -> list[bytes]:
    reference_time = int(time.time()) if now is None else now
    return [
        struct.pack(">I", 1),
        ROLE,
        OPERATION,
        b"DNS",
        b"fnos.example.net",
        struct.pack(">H", 2222),
        b"monitor_ops",
        b"ssh-ed25519",
        bytes(range(32)),
        b"synthetic-persistent-reference",
        bytes(reversed(range(32))),
        COMMAND_PROFILE,
        struct.pack(">Q", reference_time + 3600),
        struct.pack(">I", 1),
    ]


def _mobr1(fields: list[bytes] | None = None, tags: list[int] | None = None) -> bytes:
    selected = _mobr1_fields() if fields is None else fields
    selected_tags = list(range(1, 15)) if tags is None else tags
    return b"MOBR1" + b"".join(_tlv(tag, value) for tag, value in zip(selected_tags, selected))


def _probe_json(*, match: bool = True) -> bytes:
    record = {
        "attemptIndex": 1,
        "result": "MATCH" if match else "NO_MATCH",
        "failureStage": "NONE" if match else "CONNECT",
        "reasonCode": "MATCH" if match else "CONNECTION_OR_PROTOCOL_FAILURE",
        "httpStatus": 200 if match else None,
    }
    payload = {
        "schemaVersion": PROBE_SCHEMA,
        "candidateCount": 1,
        "overviewHttp200MatchCount": 1 if match else 0,
        "fullContractMatchCount": 1 if match else 0,
        "records": [record],
    }
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def _mor1_fields(probe: bytes | None = None) -> list[bytes]:
    return [
        struct.pack(">I", 1),
        b"SUCCESS",
        b"MATCH",
        b"UNIQUE_EXPECTED_MATCH",
        b"SUCCESS",
        b"NONE",
        struct.pack(">I", 0),
        b"NONE",
        _probe_json() if probe is None else probe,
    ]


def _mor1(fields: list[bytes] | None = None, tags: list[int] | None = None) -> bytes:
    selected = _mor1_fields() if fields is None else fields
    selected_tags = list(range(1, 10)) if tags is None else tags
    return b"MOR1" + b"".join(_tlv(tag, value) for tag, value in zip(selected_tags, selected))


class RoleRecord(ctypes.Structure):
    _fields_ = [
        ("version", ctypes.c_uint32),
        ("role", ctypes.c_char * 32),
        ("operation", ctypes.c_char * 64),
        ("target_kind", ctypes.c_char * 4),
        ("target", ctypes.c_char * 254),
        ("port", ctypes.c_uint16),
        ("username", ctypes.c_char * 33),
        ("host_key_algorithm", ctypes.c_char * 24),
        ("host_key", ctypes.c_uint8 * 32),
        ("persistent_key_ref", ctypes.c_uint8 * 4096),
        ("persistent_key_ref_length", ctypes.c_size_t),
        ("identity_sha256", ctypes.c_uint8 * 32),
        ("command_profile", ctypes.c_char * 32),
        ("expires_at", ctypes.c_uint64),
        ("minimum_build", ctypes.c_uint32),
    ]


class RemoteResult(ctypes.Structure):
    _fields_ = [
        ("operation_result", ctypes.c_char * 24),
        ("ownership_result", ctypes.c_char * 24),
        ("live_match_classification", ctypes.c_char * 32),
        ("reason_code", ctypes.c_char * 48),
        ("probe_json", ctypes.c_char * 32769),
        ("probe_json_length", ctypes.c_size_t),
    ]


class ParentResult(ctypes.Structure):
    _fields_ = [
        ("accepted_invocation", ctypes.c_bool),
        ("connection_result", ctypes.c_char_p),
        ("target_binding_result", ctypes.c_char_p),
        ("host_key_result", ctypes.c_char_p),
        ("identity_result", ctypes.c_char_p),
        ("operation_result", ctypes.c_char_p),
        ("ownership_correlation_result", ctypes.c_char_p),
        ("live_match_classification", ctypes.c_char_p),
        ("reason_code", ctypes.c_char_p),
        ("probe_json", ctypes.c_char_p),
        ("probe_json_length", ctypes.c_size_t),
    ]


class AgentRequest(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("sign_data", ctypes.POINTER(ctypes.c_uint8)),
        ("sign_data_length", ctypes.c_size_t),
    ]


class LocalOpaqueBrokerCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._build = tempfile.TemporaryDirectory(prefix="mob-synthetic-")
        cls.build = Path(cls._build.name)
        os.chmod(cls.build, 0o700)
        compiler = shutil.which("clang") or shutil.which("cc")
        if compiler is None:
            raise unittest.SkipTest("C11 compiler unavailable")
        cls.library_path = cls.build / ("libmob.dylib" if sys.platform == "darwin" else "libmob.so")
        link_mode = ["-dynamiclib"] if sys.platform == "darwin" else ["-shared", "-fPIC"]
        subprocess.run(
            [
                compiler,
                "-std=c11",
                "-Wall",
                "-Wextra",
                "-Werror",
                *link_mode,
                str(CORE_SOURCE),
                "-o",
                str(cls.library_path),
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"},
        )
        cls.lib = ctypes.CDLL(str(cls.library_path))
        cls.lib.mob_validate_invocation.argtypes = [
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_char_p),
        ]
        cls.lib.mob_validate_invocation.restype = ctypes.c_char_p
        cls.lib.mob_protected_access_reason.argtypes = [
            ctypes.c_bool,
            ctypes.c_int,
            ctypes.c_size_t,
        ]
        cls.lib.mob_protected_access_reason.restype = ctypes.c_char_p
        cls.lib.mob_parse_mobr1.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_uint64,
            ctypes.c_uint32,
            ctypes.POINTER(RoleRecord),
        ]
        cls.lib.mob_parse_mobr1.restype = ctypes.c_char_p
        cls.lib.mob_parse_mor1.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(RemoteResult),
        ]
        cls.lib.mob_parse_mor1.restype = ctypes.c_char_p
        cls.lib.mob_validate_target.argtypes = [
            ctypes.c_char_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_void_p,
        ]
        cls.lib.mob_validate_target.restype = ctypes.c_bool
        cls.lib.mob_validate_username.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
        cls.lib.mob_validate_username.restype = ctypes.c_bool
        cls.lib.mob_validate_probe_json.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        cls.lib.mob_validate_probe_json.restype = ctypes.c_bool
        cls.lib.mob_reason_allowed.argtypes = [ctypes.c_char_p]
        cls.lib.mob_reason_allowed.restype = ctypes.c_bool
        cls.lib.mob_reason_or_internal.argtypes = [ctypes.c_char_p]
        cls.lib.mob_reason_or_internal.restype = ctypes.c_char_p
        cls.lib.mob_serialize_parent_json.argtypes = [
            ctypes.POINTER(ParentResult),
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        cls.lib.mob_serialize_parent_json.restype = ctypes.c_bool
        cls.lib.mob_render_ssh_config.argtypes = [
            ctypes.POINTER(RoleRecord),
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        cls.lib.mob_render_ssh_config.restype = ctypes.c_bool
        cls.lib.mob_verify_ssh_effective_config.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(RoleRecord),
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
        ]
        cls.lib.mob_verify_ssh_effective_config.restype = ctypes.c_bool
        cls.lib.mob_cleanup_transition.argtypes = [
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_int,
        ]
        cls.lib.mob_cleanup_transition.restype = ctypes.c_bool
        cls.lib.mob_parse_agent_request.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(AgentRequest),
        ]
        cls.lib.mob_parse_agent_request.restype = ctypes.c_bool
        cls.lib.mob_sha256.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
        cls.lib.mob_base64_encode.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        cls.lib.mob_base64_encode.restype = ctypes.c_bool
        cls.lib.mob_make_ed25519_key_blob.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        cls.lib.mob_make_ed25519_key_blob.restype = ctypes.c_bool
        cls.lib.mob_make_p256_key_blob.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        cls.lib.mob_make_p256_key_blob.restype = ctypes.c_bool

    @classmethod
    def tearDownClass(cls) -> None:
        cls._build.cleanup()

    @classmethod
    def parse_record(cls, payload: bytes, *, now: int | None = None, build: int = 1) -> tuple[str, RoleRecord]:
        timestamp = int(time.time()) if now is None else now
        source = ctypes.create_string_buffer(payload)
        result = RoleRecord()
        reason = cls.lib.mob_parse_mobr1(source, len(payload), timestamp, build, ctypes.byref(result))
        return reason.decode("ascii"), result

    @classmethod
    def parse_result(cls, payload: bytes) -> tuple[str, RemoteResult]:
        source = ctypes.create_string_buffer(payload)
        result = RemoteResult()
        reason = cls.lib.mob_parse_mor1(source, len(payload), ctypes.byref(result))
        return reason.decode("ascii"), result

    def test_invocation_is_exact_and_rejected_before_native_access(self) -> None:
        valid = [b"broker", b"run", b"--role", ROLE, b"--operation", OPERATION]
        cases = [
            (valid, "SUCCESS"),
            (valid[:-1], "INVALID_INVOCATION"),
            (valid + [b"extra"], "INVALID_INVOCATION"),
            ([*valid[:3], b"UNKNOWN", *valid[4:]], "UNKNOWN_ROLE"),
            ([*valid[:5], b"UNKNOWN"], "UNKNOWN_OPERATION"),
            ([b"broker", b"connect", *valid[2:]], "INVALID_INVOCATION"),
        ]
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                argv = (ctypes.c_char_p * len(arguments))(*arguments)
                actual = self.lib.mob_validate_invocation(len(arguments), argv)
                self.assertEqual(actual.decode("ascii"), expected)

    def test_mobr1_valid_round_trip_fields_are_bound(self) -> None:
        reason, record = self.parse_record(_mobr1())
        self.assertEqual(reason, "SUCCESS")
        self.assertEqual(record.role, ROLE)
        self.assertEqual(record.operation, OPERATION)
        self.assertEqual(record.target_kind, b"DNS")
        self.assertEqual(record.target, b"fnos.example.net")
        self.assertEqual(record.port, 2222)
        self.assertEqual(record.username, b"monitor_ops")
        self.assertEqual(record.host_key_algorithm, b"ssh-ed25519")
        self.assertEqual(bytes(record.host_key), bytes(range(32)))
        self.assertEqual(record.persistent_key_ref_length, len(b"synthetic-persistent-reference"))
        self.assertEqual(record.command_profile, COMMAND_PROFILE)

    def test_synthetic_keychain_outcomes_cover_zero_two_denied_and_ui_without_access(self) -> None:
        cases = [
            (False, 0, 1, "SUCCESS"),
            (False, 0, 0, "PROTECTED_RECORD_NOT_FOUND"),
            (False, 0, 2, "PROTECTED_RECORD_AMBIGUOUS"),
            (False, 1, 0, "PROTECTED_RECORD_NOT_FOUND"),
            (False, 2, 0, "PROTECTED_RECORD_ACCESS_DENIED"),
            (False, 3, 0, "PROTECTED_RECORD_INTERACTION_REQUIRED"),
            (True, 0, 1, "SUCCESS"),
            (True, 0, 0, "IDENTITY_BINDING_REJECTED"),
            (True, 1, 0, "IDENTITY_KEY_NOT_FOUND"),
            (True, 2, 0, "IDENTITY_KEY_ACCESS_DENIED"),
            (True, 3, 0, "IDENTITY_KEY_INTERACTION_REQUIRED"),
        ]
        for identity, outcome, count, expected in cases:
            with self.subTest(identity=identity, outcome=outcome, count=count):
                actual = self.lib.mob_protected_access_reason(identity, outcome, count)
                self.assertEqual(actual.decode("ascii"), expected)

    def test_target_and_username_grammars_are_canonical_and_injection_closed(self) -> None:
        valid_targets = [
            (b"IP", b"127.0.0.1"),
            (b"IP", b"::1"),
            (b"IP", b"2001:db8::1"),
            (b"DNS", b"fnos-1.example.net"),
        ]
        for kind, value in valid_targets:
            output = ctypes.create_string_buffer(254)
            source = ctypes.create_string_buffer(value)
            self.assertTrue(self.lib.mob_validate_target(kind, source, len(value), output))
            self.assertEqual(output.value, value)
        invalid_targets = [
            (b"IP", b"127.000.0.1"),
            (b"IP", b"2001:0db8::1"),
            (b"IP", b"2001:DB8::1"),
            (b"DNS", b"FNOS.example.net"),
            (b"DNS", b"-fnos.example.net"),
            (b"DNS", b"fnos.example.net."),
            (b"DNS", b"fnos.example.net\nProxyCommand=x"),
            (b"DNS", b"a" * 254),
        ]
        for kind, value in invalid_targets:
            output = ctypes.create_string_buffer(254)
            source = ctypes.create_string_buffer(value)
            self.assertFalse(self.lib.mob_validate_target(kind, source, len(value), output))
        for value, expected in ((b"monitor_ops", True), (b"root", False), (b"Monitor", False), (b"ops x", False), (b"a" * 33, False)):
            output = ctypes.create_string_buffer(33)
            source = ctypes.create_string_buffer(value)
            self.assertEqual(bool(self.lib.mob_validate_username(source, len(value), output)), expected)

    def test_mobr1_rejects_missing_extra_duplicate_reordered_and_trailing(self) -> None:
        valid = _mobr1()
        malformed = {
            "wrong magic": b"X" + valid[1:],
            "missing": b"MOBR1" + b"".join(
                _tlv(tag, value) for tag, value in zip(range(1, 14), _mobr1_fields()[:-1])
            ),
            "extra": valid + _tlv(15, b"x"),
            "duplicate": _mobr1(tags=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13]),
            "reordered": _mobr1(tags=[1, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
            "trailing": valid + b"x",
            "truncated": valid[:-1],
            "oversized": b"MOBR1" + b"x" * 16384,
        }
        for name, payload in malformed.items():
            with self.subTest(name=name):
                reason, _record = self.parse_record(payload)
                self.assertNotEqual(reason, "SUCCESS")

    def test_mobr1_rejects_version_expiry_build_and_all_bound_values(self) -> None:
        now = int(time.time())
        changes = {
            "version": (0, struct.pack(">I", 2), "RECORD_VERSION_MISMATCH"),
            "role": (1, b"UNKNOWN", "PROTECTED_RECORD_INVALID"),
            "operation": (2, b"UNKNOWN", "PROTECTED_RECORD_INVALID"),
            "kind": (3, b"URL", "TARGET_BINDING_REJECTED"),
            "target uppercase": (4, b"FNOS.example.net", "TARGET_BINDING_REJECTED"),
            "target noncanonical ipv4": (4, b"127..0.1", "TARGET_BINDING_REJECTED"),
            "port zero": (5, b"\x00\x00", "TARGET_BINDING_REJECTED"),
            "root username": (6, b"root", "TARGET_BINDING_REJECTED"),
            "host key algorithm": (7, b"ssh-rsa", "HOST_KEY_BINDING_REJECTED"),
            "host key length": (8, b"short", "HOST_KEY_BINDING_REJECTED"),
            "empty persistent ref": (9, b"", "PROTECTED_RECORD_INVALID"),
            "identity digest": (10, b"short", "IDENTITY_BINDING_REJECTED"),
            "command": (11, b"GENERIC_EXEC", "REMOTE_OPERATION_POLICY_REJECTED"),
            "expired": (12, struct.pack(">Q", now), "RECORD_EXPIRED"),
            "future build": (13, struct.pack(">I", 2), "RECORD_VERSION_MISMATCH"),
        }
        for name, (index, value, expected) in changes.items():
            with self.subTest(name=name):
                fields = _mobr1_fields(now=now)
                fields[index] = value
                reason, _record = self.parse_record(_mobr1(fields), now=now)
                self.assertEqual(reason, expected)

    def test_mor1_accepts_exact_record_and_rejects_all_malformed_forms(self) -> None:
        valid = _mor1()
        reason, result = self.parse_result(valid)
        self.assertEqual(reason, "SUCCESS")
        self.assertEqual(result.operation_result, b"SUCCESS")
        self.assertEqual(result.ownership_result, b"MATCH")
        self.assertEqual(result.live_match_classification, b"UNIQUE_EXPECTED_MATCH")
        self.assertEqual(result.reason_code, b"SUCCESS")
        self.assertEqual(bytes(result.probe_json[: result.probe_json_length]), _probe_json())

        invalid_fields = {
            "version": (0, struct.pack(">I", 2)),
            "operation result": (1, b"UNKNOWN"),
            "ownership": (2, b"ROOT"),
            "classification": (3, b"TARGET"),
            "reason": (4, b"UNKNOWN_REASON"),
            "semantic mismatch": (3, b"UNKNOWN"),
            "write": (5, b"SOME"),
            "actions": (6, struct.pack(">I", 1)),
            "permission": (7, b"CHANGED"),
            "probe": (8, b"{}"),
        }
        malformed = [
            b"X" + valid[1:],
            valid[:-1],
            valid + _tlv(10, b"x"),
            valid + b"x",
            _mor1(tags=[1, 2, 3, 4, 5, 6, 7, 8, 8]),
            _mor1(tags=[1, 3, 2, 4, 5, 6, 7, 8, 9]),
            b"MOR1" + b"x" * 32768,
        ]
        for index, value in invalid_fields.values():
            fields = _mor1_fields()
            fields[index] = value
            malformed.append(_mor1(fields))
        for payload in malformed:
            with self.subTest(length=len(payload), digest=hashlib.sha256(payload).hexdigest()[:8]):
                reason, _result = self.parse_result(payload)
                self.assertEqual(reason, "REMOTE_OUTPUT_INVALID_OR_OVERSIZED")

    def test_probe_json_is_canonical_closed_and_consistent(self) -> None:
        valid = _probe_json()
        valid_buffer = ctypes.create_string_buffer(valid)
        self.assertTrue(self.lib.mob_validate_probe_json(valid_buffer, len(valid)))
        wrapped_count = (
            b'{"schemaVersion":"MGW-RAW-MONITOR-PROBE-DIAGNOSTIC-V1",'
            b'"candidateCount":18446744073709551616,'
            b'"overviewHttp200MatchCount":0,"fullContractMatchCount":0,"records":[]}'
        )
        invalid = [
            b"{}",
            valid + b" ",
            wrapped_count,
            valid.replace(b'"candidateCount":1', b'"candidateCount":2'),
            valid.replace(b'"fullContractMatchCount":1', b'"fullContractMatchCount":0'),
            valid.replace(b'"attemptIndex":1', b'"attemptIndex":2'),
            valid.replace(b'"MATCH"', b'"UNKNOWN"', 1),
            valid.replace(b'"httpStatus":200', b'"httpStatus":null'),
            valid.replace(b'"records"', b'"target"'),
            valid + b"\x00secret",
        ]
        for payload in invalid:
            with self.subTest(payload=payload[:30]):
                source = ctypes.create_string_buffer(payload)
                self.assertFalse(self.lib.mob_validate_probe_json(source, len(payload)))

    def test_reason_allowlist_is_exact_and_unknown_maps_closed(self) -> None:
        for reason in REASON_CODES:
            self.assertTrue(self.lib.mob_reason_allowed(reason.encode("ascii")), reason)
        self.assertEqual(
            self.lib.mob_reason_or_internal(b"caller-controlled-secret").decode("ascii"),
            "INTERNAL_FAIL_CLOSED",
        )
        core_text = CORE_SOURCE.read_text(encoding="utf-8")
        declared = {
            value
            for value in REASON_CODES
            if f'"{value}"' in core_text
        }
        self.assertEqual(declared, REASON_CODES)

    def test_parent_json_has_only_exact_fields_and_never_echoes_unknown_input(self) -> None:
        output = ctypes.create_string_buffer(65536)
        output_length = ctypes.c_size_t()
        result = ParentResult(
            accepted_invocation=False,
            connection_result=b"NOT_RUN",
            target_binding_result=b"NOT_RUN",
            host_key_result=b"NOT_RUN",
            identity_result=b"NOT_RUN",
            operation_result=b"NOT_RUN",
            ownership_correlation_result=b"NOT_RUN",
            live_match_classification=b"NOT_RUN",
            reason_code=b"INVALID_INVOCATION",
            probe_json=None,
            probe_json_length=0,
        )
        self.assertTrue(
            self.lib.mob_serialize_parent_json(
                ctypes.byref(result), output, len(output), ctypes.byref(output_length)
            )
        )
        payload = json.loads(output.raw[: output_length.value])
        self.assertEqual(
            list(payload),
            [
                "schemaVersion",
                "role",
                "operation",
                "connectionResult",
                "targetBindingResult",
                "hostKeyResult",
                "identityResult",
                "operationResult",
                "ownershipCorrelationResult",
                "liveMatchClassification",
                "productionWrite",
                "serviceActions",
                "permissionDelta",
                "reasonCode",
                "probeDiagnostic",
            ],
        )
        self.assertEqual(payload["schemaVersion"], BROKER_SCHEMA)
        self.assertIsNone(payload["role"])
        self.assertIsNone(payload["operation"])
        self.assertEqual(payload["productionWrite"], "NONE")
        self.assertEqual(payload["serviceActions"], 0)
        self.assertEqual(payload["permissionDelta"], "NONE")
        self.assertNotIn("caller-controlled-secret", output.value.decode("ascii"))

    def test_ssh_config_expands_to_the_closed_verified_profile(self) -> None:
        if sys.platform != "darwin" or not Path("/usr/bin/ssh").exists():
            self.skipTest("frozen Apple OpenSSH path unavailable")
        reason, record = self.parse_record(_mobr1())
        self.assertEqual(reason, "SUCCESS")
        identity = b"/private/tmp/mob-synthetic/identity"
        agent = b"/private/tmp/mob-synthetic/agent.sock"
        known_hosts = b"/private/tmp/mob-synthetic/known_hosts"
        config = ctypes.create_string_buffer(8192)
        config_length = ctypes.c_size_t()
        self.assertTrue(
            self.lib.mob_render_ssh_config(
                ctypes.byref(record),
                identity,
                agent,
                known_hosts,
                config,
                len(config),
                ctypes.byref(config_length),
            )
        )
        rendered = config.raw[: config_length.value]
        completed = subprocess.run(
            ["/usr/bin/ssh", "-G", "-F", "/dev/stdin", "broker-fnos-v1"],
            input=rendered,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        self.assertEqual(completed.stderr, b"")
        expanded = ctypes.create_string_buffer(completed.stdout)
        self.assertTrue(
            self.lib.mob_verify_ssh_effective_config(
                expanded,
                len(completed.stdout),
                ctypes.byref(record),
                identity,
                agent,
                known_hosts,
            )
        )
        for injection in (
            b"sendenv SECRET\n",
            b"localforward 10000 127.0.0.1:22\n",
            b"dynamicforward 1080\n",
            b"proxycommand /bin/false\n",
            b"securitykeyprovider /private/tmp/plugin.dylib\n",
            b"pkcs11provider /private/tmp/plugin.dylib\n",
            b"unknownoption value\n",
            b"\xffoption value\n",
        ):
            modified = completed.stdout + injection
            source = ctypes.create_string_buffer(modified)
            self.assertFalse(
                self.lib.mob_verify_ssh_effective_config(
                    source,
                    len(modified),
                    ctypes.byref(record),
                    identity,
                    agent,
                    known_hosts,
                )
            )
        self.assertNotIn(b"fnos.example.net", completed.args)

    def test_agent_parser_allows_only_identities_and_exact_bounded_sign(self) -> None:
        key = b"synthetic-exact-public-key"
        key_buffer = ctypes.create_string_buffer(key)

        def parse(request: bytes) -> tuple[bool, AgentRequest, ctypes.Array[ctypes.c_char]]:
            source = ctypes.create_string_buffer(request)
            parsed = AgentRequest()
            accepted = self.lib.mob_parse_agent_request(
                source, len(request), key_buffer, len(key), ctypes.byref(parsed)
            )
            return bool(accepted), parsed, source

        accepted, parsed, _source = parse(b"\x0b")
        self.assertTrue(accepted)
        self.assertEqual(parsed.type, 1)

        data = b"bounded-signing-data"
        sign = b"\x0d" + struct.pack(">I", len(key)) + key
        sign += struct.pack(">I", len(data)) + data + struct.pack(">I", 0)
        accepted, parsed, source = parse(sign)
        self.assertTrue(accepted)
        self.assertEqual(parsed.type, 2)
        self.assertEqual(parsed.sign_data_length, len(data))
        self.assertEqual(ctypes.string_at(parsed.sign_data, parsed.sign_data_length), data)
        self.assertIsNotNone(source)

        rejected = [
            b"\x0c",
            b"\x0bextra",
            sign[:-1],
            sign[:-4] + struct.pack(">I", 1),
            sign.replace(key, b"synthetic-wrong-public-key", 1),
            b"\x0d" + struct.pack(">I", len(key)) + key + struct.pack(">I", 0) + struct.pack(">I", 0),
            b"\x0d" + struct.pack(">I", len(key)) + key + struct.pack(">I", 32769) + b"x" * 32769 + struct.pack(">I", 0),
        ]
        for request in rejected:
            self.assertFalse(parse(request)[0])

    def test_cleanup_state_machine_and_sha256_are_portable(self) -> None:
        state = ctypes.c_int(0)
        for next_state in (1, 2, 3, 4):
            self.assertTrue(self.lib.mob_cleanup_transition(ctypes.byref(state), next_state))
        self.assertFalse(self.lib.mob_cleanup_transition(ctypes.byref(state), 3))
        invalid = ctypes.c_int(0)
        self.assertFalse(self.lib.mob_cleanup_transition(ctypes.byref(invalid), 2))

        source = ctypes.create_string_buffer(b"abc")
        digest = (ctypes.c_uint8 * 32)()
        self.lib.mob_sha256(source, 3, digest)
        self.assertEqual(bytes(digest).hex(), hashlib.sha256(b"abc").hexdigest())

    def test_public_key_blob_and_base64_helpers_are_exact(self) -> None:
        raw_host = bytes(range(32))
        host_source = ctypes.create_string_buffer(raw_host)
        host_blob = ctypes.create_string_buffer(128)
        host_length = ctypes.c_size_t()
        self.assertTrue(
            self.lib.mob_make_ed25519_key_blob(
                host_source, host_blob, len(host_blob), ctypes.byref(host_length)
            )
        )
        expected_host = struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32) + raw_host
        self.assertEqual(host_blob.raw[: host_length.value], expected_host)

        x963 = b"\x04" + b"x" * 32 + b"y" * 32
        p256_source = ctypes.create_string_buffer(x963)
        p256_blob = ctypes.create_string_buffer(256)
        p256_length = ctypes.c_size_t()
        self.assertTrue(
            self.lib.mob_make_p256_key_blob(
                p256_source, len(x963), p256_blob, len(p256_blob), ctypes.byref(p256_length)
            )
        )
        algorithm = b"ecdsa-sha2-nistp256"
        curve = b"nistp256"
        expected_p256 = (
            struct.pack(">I", len(algorithm))
            + algorithm
            + struct.pack(">I", len(curve))
            + curve
            + struct.pack(">I", len(x963))
            + x963
        )
        self.assertEqual(p256_blob.raw[: p256_length.value], expected_p256)

        encoded = ctypes.create_string_buffer(512)
        encoded_length = ctypes.c_size_t()
        self.assertTrue(
            self.lib.mob_base64_encode(
                p256_blob,
                p256_length.value,
                encoded,
                len(encoded),
                ctypes.byref(encoded_length),
            )
        )
        self.assertEqual(
            encoded.raw[: encoded_length.value],
            base64.b64encode(expected_p256),
        )

    def test_source_contract_has_no_runtime_bypass_or_forbidden_keychain_api(self) -> None:
        broker = BROKER_SOURCE.read_text(encoding="utf-8")
        admin = ADMIN_SOURCE.read_text(encoding="utf-8")
        core = CORE_SOURCE.read_text(encoding="utf-8")
        combined = broker + admin
        for forbidden in (
            "kSecUseDataProtectionKeychain",
            "kSecAttrAccessGroup",
            "kSecAttrTokenIDSecureEnclave",
            "kSecAttrAccessControl",
            "SecItemExport",
            "security find-",
            "security add-",
            "getenv(",
            "popen(",
            "system(",
            "/bin/sh",
            "TEST_ADAPTER",
            "BYPASS",
        ):
            self.assertNotIn(forbidden, combined)
        self.assertIn("kSecUseAuthenticationUIFail", broker)
        self.assertIn("mob_protected_access_reason", broker)
        self.assertIn("MOB_PROTECTED_ACCESS_INTERACTION_REQUIRED", broker)
        self.assertIn("MOB_PROTECTED_ACCESS_DENIED", broker)
        self.assertIn("kSecAttrSynchronizable", combined)
        self.assertIn("kSecAttrAccess", combined)
        self.assertIn("mob_access_is_exact(access, kSecACLAuthorizationDecrypt)", broker)
        self.assertIn("mob_access_is_exact(access, kSecACLAuthorizationSign)", broker)
        self.assertIn("CFArrayGetCount(acl_list) != 1", broker)
        self.assertIn("SecTrustedApplicationCreateFromPath", admin)
        self.assertIn("kSecPrivateKeyAttrs", admin)
        self.assertIn("MOBValidateBindingInputs", admin)
        self.assertIn("MOBParseUnsignedDecimal", admin)
        self.assertNotIn("port.integerValue", admin)
        self.assertIn("SecKeyCopyPublicKey", combined)
        self.assertGreater(
            combined.find("SecKeyCopyExternalRepresentation"),
            combined.find("SecKeyCopyPublicKey"),
        )
        self.assertIn("LOCAL_PEERPID", broker)
        self.assertIn("MOB_AGENT_REQUEST_LIMIT 16U", broker)
        self.assertIn('return "IDENTITY_AGENT_FAILURE";', broker)
        self.assertIn("result->agent_failed = true;", broker)
        self.assertIn("MOB_TOTAL_TIMEOUT_SECONDS 300", broker)
        self.assertIn('MOB_CONFIG_LINE("ConnectTimeout", "10")', core)
        self.assertIn("MOB_STDOUT_LIMIT 32768U", broker)
        self.assertIn("MOB_STDERR_LIMIT 8192U", broker)
        self.assertIn("POSIX_SPAWN_SETPGROUP", broker)
        self.assertIn("kSecCodeInfoPlatformIdentifier", broker)
        self.assertIn("mob_signal_received", broker)
        self.assertIn("kill(-runtime->child_pid, SIGTERM)", broker)
        self.assertIn("kill(-runtime->child_pid, SIGKILL)", broker)
        self.assertIn("unlink(runtime->agent_path)", broker)
        self.assertIn("unlink(runtime->identity_path)", broker)
        self.assertIn("unlink(runtime->known_hosts_path)", broker)
        self.assertIn("rmdir(runtime->directory)", broker)
        verify_argv = broker[broker.index("char *const verify_argv[]") : broker.index("char *const connect_argv[]")]
        connect_argv = broker[broker.index("char *const connect_argv[]") : broker.index("char *const empty_environment[]")]
        for argv_source in (verify_argv, connect_argv):
            self.assertIn("MOB_SSH_PATH", argv_source)
            self.assertIn('"-F"', argv_source)
            self.assertIn('"/dev/stdin"', argv_source)
            self.assertIn('"broker-fnos-v1"', argv_source)
            self.assertNotIn("target", argv_source.casefold())
            self.assertNotIn("username", argv_source.casefold())
        self.assertIn("char *const empty_environment[] = {NULL};", broker)
        self.assertIn('MOB_CONFIG_LINE("ProxyCommand", "none")', core)
        self.assertIn('MOB_CONFIG_LINE("ProxyJump", "none")', core)
        self.assertIn('MOB_CONFIG_LINE("RemoteCommand", "none")', core)
        self.assertIn('MOB_CONFIG_LINE("ControlMaster", "no")', core)
        self.assertIn('MOB_CONFIG_LINE("SecurityKeyProvider", "none")', core)
        self.assertIn('MOB_CONFIG_LINE("PKCS11Provider", "none")', core)
        self.assertEqual(
            plistlib.loads(ENTITLEMENTS.read_bytes()),
            {"com.apple.security.get-task-allow": False},
        )


@unittest.skipUnless(sys.platform == "darwin", "native Security.framework test is macOS-only")
class LocalOpaqueBrokerNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._build = tempfile.TemporaryDirectory(prefix="mob-native-synthetic-")
        cls.build = Path(cls._build.name)
        os.chmod(cls.build, 0o700)
        cls.broker = cls.build / "monitor-opaque-operation-broker-v1"
        cls.admin = cls.build / "monitor-opaque-operation-broker-admin-v1"
        subprocess.run(
            [
                "/usr/bin/clang",
                "-std=c11",
                "-Wall",
                "-Wextra",
                "-Werror",
                str(CORE_SOURCE),
                str(BROKER_SOURCE),
                "-framework",
                "CoreFoundation",
                "-framework",
                "Security",
                "-o",
                str(cls.broker),
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        subprocess.run(
            [
                "/usr/bin/clang",
                "-fobjc-arc",
                "-Wall",
                "-Wextra",
                "-Werror",
                str(ADMIN_SOURCE),
                str(CORE_SOURCE),
                "-framework",
                "AppKit",
                "-framework",
                "CoreFoundation",
                "-framework",
                "Security",
                "-o",
                str(cls.admin),
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls._build.cleanup()

    def test_invalid_invocation_returns_closed_json_without_keychain_or_prompt(self) -> None:
        canary = "synthetic-target-canary.example.net"
        completed = subprocess.run(
            [str(self.broker), "run", "--role", canary, "--operation", OPERATION.decode()],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=2,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stderr, b"")
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["reasonCode"], "UNKNOWN_ROLE")
        self.assertIsNone(payload["role"])
        self.assertIsNone(payload["operation"])
        self.assertNotIn(canary.encode(), completed.stdout)
        self.assertEqual(payload["productionWrite"], "NONE")
        self.assertEqual(payload["serviceActions"], 0)
        self.assertEqual(payload["permissionDelta"], "NONE")


if __name__ == "__main__":
    unittest.main()

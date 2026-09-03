# Monitor gateway opaque operation broker contract

## Status and authority

```text
CONTRACT_REFERENCE=MONITOR-OPAQUE-BROKER-SECURITY-CONTRACT-V1
STATUS=FROZEN
ARCHITECTURE_ID=LOCAL_OPAQUE_OPERATION_BROKER_V1
PROFILE=C11_SECURITY_FRAMEWORK_FILE_KEYCHAIN_AGENT_FORCED_COMMAND_V1
ROLE_SET=FNOS_PRODUCTION only
OPERATION_SET=RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1 only
PRODUCTION_DEPLOYABLE=NO
PRIVATE_STAGING_RETRY_ELIGIBILITY=NO
PRODUCTION_WRITE=NONE
SERVICE_ACTIONS=0
PERMISSION_DELTA=NONE
```

This document describes repository source and synthetic tests. It is not an
installation, signing, Keychain-provisioning, SSH, remote-host, private-staging,
production, public-cutover, Nginx, DNS, or customer-traffic authorization. The
repository task must not inspect a real Keychain item or signing identity, make
an SSH connection, write `/usr/local` or `/etc`, invoke `sudo`, sign code, or
contact production. Missing runtime ownership, group, signing, ACL, build,
artifact, or permission evidence is `UNKNOWN_FAIL_CLOSED`.

There is no architecture fallback. Swift, Data Protection Keychain, Secure
Enclave, access groups, access-control objects, generic connect/exec/shell,
additional roles or operations, and changes to the accepted raw-monitor probe
are outside this contract.

## Trust boundary and invocation

The future broker is a non-setuid macOS executable running as its calling
non-root user. Its trusted boundary contains only its compiled C11 code,
Security.framework, the exact file-based default-Keychain records, its tracked
ephemeral resources, and fixed Apple `/usr/bin/ssh`. The parent, inherited
environment/stdin, user SSH configuration, caller files, target binding, SSH
output, and remote result are untrusted.

The only invocation is:

```text
/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-v1 run --role FNOS_PRODUCTION --operation RAW_MONITOR_OWNERSHIP_CORRELATION_READONLY_V1
```

The five arguments after the executable are required in that order. Unknown,
missing, case-variant, or extra values are rejected before integrity,
Keychain, temporary-resource, or transport access. Caller environment and
stdin do not select behavior and are not forwarded.

## File-based Keychain contract

The role record is exactly one default file-Keychain generic-password item:

```text
class=kSecClassGenericPassword
service=com.network-service-platform.monitor-opaque-broker.role-record.v1
account=FNOS_PRODUCTION
kSecAttrSynchronizable=false
access=legacy SecAccess ACL with exactly the broker and admin trusted applications
runtime authentication UI=kSecUseAuthenticationUIFail
```

The broker uses one match-all query and requires exactly one item. Zero items,
two or more items, an inaccessible/malformed ACL, authentication denial, or a
request for UI fails closed. It performs no enumeration or fallback search.

The signing identity is a permanent P-256 private `SecKey` referenced only by
the role record's persistent reference. Its attributes are
`kSecAttrIsPermanent=true`, `kSecAttrIsExtractable=false`, and
`kSecAttrCanSign=true`, with the same exact trusted-application ACL. The
private key is never exported. The only external representation is obtained
from `SecKeyCopyPublicKey` and is used to construct and hash the public SSH
identity. `SecItemExport`, private-key `SecKeyCopyExternalRepresentation`, the
`security` command, Data Protection Keychain, Secure Enclave,
`kSecAttrAccessGroup`, and `kSecAttrAccessControl` are forbidden.

### MOBR1 canonical TLV

`MOBR1` is the five-byte magic followed by exactly 14 tags. Every tag is one
unsigned byte, one network-big-endian unsigned 32-bit length, and the value.
Tags must occur once in this exact order:

1. version, unsigned 32-bit;
2. exact role;
3. exact operation;
4. target kind, `IP` or `DNS`;
5. canonical target;
6. port, unsigned 16-bit;
7. bounded POSIX username, not `root`;
8. `ssh-ed25519`;
9. 32-byte Ed25519 Host Key;
10. signing-key persistent reference;
11. SHA-256 of the P-256 public SSH identity blob;
12. `SERVER_FORCED_COMMAND_V1`;
13. expiry, unsigned 64-bit;
14. minimum broker build, unsigned 32-bit.

The maximum record is 16,384 bytes. An IP must already be canonical; a DNS
target must be a lower-case strict ASCII A-label sequence. Missing, extra,
duplicate, reordered, unknown, truncated, oversized, expired, trailing, or
future-build data is rejected. No field value is rendered to the parent.

## Runtime integrity

The future local paths and modes are:

```text
/usr/local/libexec/network-service-platform                         root:wheel 0755
/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-v1       root:wheel 0555
/usr/local/libexec/network-service-platform/monitor-opaque-operation-broker-admin-v1 root:wheel 0555
```

Every component must be non-symlink and have no caller-writable ancestor. Both
production executables require a stable non-ad-hoc designated requirement,
hardened runtime, and the sole entitlement
`com.apple.security.get-task-allow=false`. The broker validates its own path,
mode, ancestors, signature, and entitlements natively. The admin validates its
own and the broker's fixed paths before provisioning. The fixed
`/usr/bin/ssh` must be a root-owned, caller-non-writable regular non-symlink
with a valid Apple platform signature.

Unsigned repository test binaries are test-only and intentionally cannot pass
the runtime integrity gate. This task performs no `codesign` operation.

## Fixed OpenSSH transport

Configuration validation and connection use only:

```text
/usr/bin/ssh -G -F /dev/stdin broker-fnos-v1
/usr/bin/ssh -F /dev/stdin broker-fnos-v1
```

Target, user, and port occur only in an anonymous configuration pipe. They do
not occur in parent/tool/child argv, inherited environment, a persistent file,
the fixed known-host alias, stderr, or parent output. After configuration is
read, `StdinNull=yes`; no remote stdin or client command is supplied.

Before connection, the broker parses the complete `ssh -G` result and requires
the following effective values:

- MOBR1 `HostName`, `User`, and `Port`;
- `BatchMode=yes`, public-key-only authentication, and zero password prompts;
- password, keyboard-interactive, GSSAPI, and hostbased authentication off;
- no TTY, null stdin, `IdentitiesOnly=yes`, and exact ephemeral public identity
  and agent paths;
- strict Host Key checking, exact ephemeral known-hosts path, no global
  known-hosts file or command, alias `broker-fnos-hostkey-v1`, Host Key
  algorithm `ssh-ed25519`, and accepted public-key algorithm
  `ecdsa-sha2-nistp256`;
- `CheckHostIP`, `UpdateHostKeys`, and `VerifyHostKeyDNS` off;
- agent, X11, local, remote, dynamic, and tunnel forwarding off;
- proxy command/jump, local/remote command, and control reuse absent/off;
- hostname canonicalization and environment forwarding absent/off;
- one connection attempt and a 10-second connect timeout.

Unknown keys outside the compiled Apple OpenSSH default-key set, duplicate
security keys, a missing required key, or any deviation fails closed. Raw
`ssh -G` stdout/stderr never reaches the parent.

The ephemeral workspace is randomly named and mode `0700`. Its public identity
and pinned Host Key files are mode `0600`; the known-host entry contains only
the fixed alias and public key, never the raw target. The minimal in-process
agent socket is mode `0600`. Private signing stays in `SecKey`.

The agent accepts one connection from the exact directly spawned SSH peer PID
and at most 16 requests. It accepts only `SSH_AGENTC_REQUEST_IDENTITIES`
and an ECDSA sign request for the exact public key, zero flags, and at most
32,768 data bytes. All add/remove/lock/unlock/extension/unknown requests,
wrong keys, wrong peers, extra connections, malformed frames, or limit
violations fail the operation. No plugin, shell, eval, or caller dylib path is
used.

```text
connect timeout=10 seconds
total timeout=300 seconds
stdout limit=32768 bytes
stderr limit=8192 bytes
agent connections=1
agent requests<=16
```

The child is created directly with an empty environment and a new process
group. Normal failure, timeout, `SIGINT`, `SIGTERM`, or `SIGHUP` closes pipes,
terminates the tracked child group when required, closes the agent, unlinks all
tracked files/socket, removes the workspace, and wipes in-process buffers.
Cleanup failure returns `CLEANUP_FAILED`.

## Fixed remote ownership operation

The future `authorized_keys` entry is restricted to exactly:

```text
restrict,command="/usr/bin/python3 -I -B /usr/local/libexec/network-service-platform/raw-monitor-ownership-correlation-readonly-v1.py"
```

The operation accepts no argument or stdin, rejects a non-empty
`SSH_ORIGINAL_COMMAND`, rejects effective UID 0, and has no `sudo`, shell,
generic exec, write, service mutation, or privilege fallback. Isolated Python
loads the accepted probe only from the immutable bundle root derived from the
operation's own path; environment and current-directory import roots are not
used.

The remote operation record is:

```text
path=/etc/network-service-platform/monitor-gateway/raw-monitor-ownership-operation-v1.tlv
schema=RMOR1_CANONICAL_TLV
owner=root
group=exact existing primary group of the bound non-root identity
mode=0440
parent owner=root
parent group=same exact primary group
parent mode=0750
```

The path, parent, and opened descriptor must identify non-symlink objects with
no caller write access. Missing future group/read evidence is
`REMOTE_RECORD_PERMISSION_FACT_MISSING` and stops deployment; this repository
does not claim that evidence exists.

`RMOR1` uses the same one-byte-tag/network-32-bit-length framing, magic
`RMOR1`, and exactly these ordered values: version, role, operation, expected
systemd unit, unit-fragment SHA-256, executable SHA-256, accepted-probe
SHA-256, expiry, and minimum remote build. Missing, extra, duplicate,
reordered, malformed, expired, future-build, oversized, or trailing bytes fail
closed.

Only `/proc/net/tcp` and `/proc/net/tcp6` TCP `LISTEN` entries are candidates.
IPv4 loopback/wildcard maps to `127.0.0.1`; IPv6 loopback/wildcard maps to
`::1`. UDP, external addresses, ranges, and scans are forbidden. Candidates
are deterministic, deduplicated, and capped at 64.

One probe match is correlated through socket inode to exactly one process,
that process's unified cgroup, and the exact expected unit. The only child
command is:

```text
/usr/bin/systemctl show --no-pager --property=MainPID --property=ControlGroup --property=FragmentPath <validated-exact-unit>
```

`MainPID` and `ControlGroup` must match. `FragmentPath` must be an absolute,
root-owned, regular, non-symlink, group/world-non-writable file with the exact
hash. `/proc/<MainPID>/exe` and the accepted probe must match their hashes.
Permission failure returns `REMOTE_OPERATION_PERMISSION_DENIED`; ambiguity or
metadata drift returns the closed unknown/unexpected result without fallback.

## MOR1 result

`MOR1` is bounded to 32,768 bytes and uses the same canonical TLV framing.
Exactly nine tags appear in order:

1. version;
2. operation result;
3. ownership result;
4. live-match classification;
5. allowlisted reason code;
6. `productionWrite=NONE`;
7. `serviceActions=0`, unsigned 32-bit;
8. `permissionDelta=NONE`;
9. canonical accepted probe JSON, or zero length.

The parser rejects an invalid enum, inconsistent result tuple, missing/extra/
duplicate/reordered/unknown tag, non-canonical probe, oversize, or trailing
byte. The only successful ownership tuples are zero match, unique expected
match, unique unexpected match, and multiple matches. Permission/policy/
internal failures use their exact closed tuple and carry no probe when the
operation did not produce one.

## Closed parent JSON

The only parent schema is
`LOCAL-OPAQUE-OPERATION-BROKER-RESULT-V1`, with exactly these ordered fields:

```text
schemaVersion
role
operation
connectionResult
targetBindingResult
hostKeyResult
identityResult
operationResult
ownershipCorrelationResult
liveMatchClassification
productionWrite
serviceActions
permissionDelta
reasonCode
probeDiagnostic
```

Role and operation are the accepted singleton values or `null`; unknown input
is never echoed. The live classification is one of `ZERO_MATCH`,
`UNIQUE_EXPECTED_MATCH`, `UNIQUE_UNEXPECTED_MATCH`, `MULTIPLE_MATCHES`,
`UNKNOWN`, or `NOT_RUN`. `productionWrite="NONE"`, `serviceActions=0`, and
`permissionDelta="NONE"` are invariant. `probeDiagnostic` is `null` or the
exact canonical `MGW-RAW-MONITOR-PROBE-DIAGNOSTIC-V1` object accepted at the
base SHA.

The exact reason-code allowlist is:

```text
SUCCESS
INVALID_INVOCATION
UNKNOWN_ROLE
UNKNOWN_OPERATION
BROKER_INTEGRITY_FAILURE
PROTECTED_RECORD_NOT_FOUND
PROTECTED_RECORD_AMBIGUOUS
PROTECTED_RECORD_ACCESS_DENIED
PROTECTED_RECORD_INTERACTION_REQUIRED
PROTECTED_RECORD_INVALID
RECORD_VERSION_MISMATCH
RECORD_EXPIRED
TARGET_BINDING_REJECTED
HOST_KEY_BINDING_REJECTED
IDENTITY_KEY_NOT_FOUND
IDENTITY_KEY_ACCESS_DENIED
IDENTITY_KEY_INTERACTION_REQUIRED
IDENTITY_BINDING_REJECTED
IDENTITY_AGENT_FAILURE
TEMP_RESOURCE_FAILURE
SSH_LAUNCH_FAILURE
SSH_TIMEOUT
SSH_HOST_KEY_REJECTED
SSH_AUTHENTICATION_FAILED
SSH_TRANSPORT_FAILURE
REMOTE_OUTPUT_INVALID_OR_OVERSIZED
REMOTE_OPERATION_PERMISSION_DENIED
REMOTE_OPERATION_POLICY_REJECTED
REMOTE_OPERATION_FAILED
OWNERSHIP_ZERO_MATCH
OWNERSHIP_MULTIPLE_MATCHES
OWNERSHIP_UNEXPECTED_MATCH
OWNERSHIP_UNKNOWN
INTERRUPTED
CLEANUP_FAILED
INTERNAL_FAIL_CLOSED
```

Unknown values and exceptions map to `INTERNAL_FAIL_CLOSED`. Parent output
never contains target, host/IP, port, username, path, PID, socket, inode, unit
configuration, Keychain attributes/reference, Host Key/fingerprint, exception,
traceback, headers, body, or raw child output. Broker stderr is empty.

## Native admin, bootstrap, and rollback source contract

The admin is no-argument native AppKit UI with only `Provision`, `Replace`, and
`Revoke` for the singleton role. It has no network operation. Provisioning
validates canonical public binding values, creates the non-exportable P-256 key
and MOBR1 record, attaches the exact broker/admin trusted-application ACL, and
exports only the public identity through `NSSavePanel`. Input values never
enter argv, environment, or logs. A failed or canceled operation removes its
partial exact objects.

Revocation deletes only the exact role item and exact tagged identity without
reading the old role value, then verifies both no longer resolve. No
`sudoers`, `NOPASSWD`, setuid executable, helper daemon, user/group, capability,
or broader ACL is introduced.

A future separately authorized installer must verify a staged signed binary,
atomically replace it on the same filesystem, and retain the prior signed
binary until postcheck. Upgrade failure restores that binary without changing
the role record. Stale schema/build rejects execution. Uninstall ordering is
revoke, verify unresolved, then remove binaries; child/socket/temp cleanup is
still mandatory. None of those install or rollback actions is authorized or
implemented by this repository-only task.

## Synthetic acceptance matrix

Positive repository gates cover:

- exact argv, singleton role/operation, canonical MOBR1 and MOR1;
- canonical IP/DNS/username, expiry/build, Host Key/public-identity binding;
- exact closed parent JSON and accepted probe diagnostic;
- fixed child argv, anonymous config, actual Apple `ssh -G` expansion, strict
  Host Key and all disabled forwarding/proxy/control/environment paths;
- minimal identities/exact-key sign parser, request bounds, peer/connection
  source gates, timeout/signal/cleanup state machine;
- isolated `python3 -I -B` load, revised root/group `0440` RMOR1 metadata,
  deterministic local TCP candidates, and fixed systemctl argv;
- zero, unique expected, unique unexpected, multiple, ambiguity, permission,
  cgroup/PID/unit/fragment/executable/probe-hash outcomes;
- strict C/Objective-C compilation, Python compilation, existing raw-probe,
  gateway, Node, scope, leakage, forbidden-symbol, and residue gates.

Negative repository gates cover every missing/extra/duplicate/reordered/
trailing/oversized TLV form, version/expiry/build drift, role/operation/target/
username/Host Key/identity mismatch, Keychain zero/two/denied/UI branches,
invalid SSH directives, wrong agent key/request/flags, child bounds and cleanup,
root/args/stdin/original-command remote invocation, RMOR1 permission drift,
candidate overflow, ownership ambiguity, each fixed metadata/hash mismatch,
invalid MOR1 tuples, and leakage canaries.

All tests are synthetic. They do not use a real Keychain, create a real
identity key, connect an SSH agent or host, invoke `sudo`/systemd, sign/install
code, or access production. The portable C11 harness links only the core, while
the native broker links the production Security.framework adapter separately;
there is no argv, environment, or runtime-selectable test adapter or bypass.

## Permanent stop line

```text
PRODUCTION_DEPLOYABLE=NO
PRIVATE_STAGING_RETRY_ELIGIBILITY=NO
REAL_KEYCHAIN_READS=0
REAL_KEYCHAIN_WRITES=0
REAL_KEYGEN=0
CODESIGN=0
INSTALL=0
REMOTE_CONNECTIONS=0
PRODUCTION_HTTP_REQUESTS=0
PRODUCTION_WRITES=0
SERVICE_ACTIONS=0
PERMISSION_DELTA=NONE
```

Passing repository and CI checks establishes only a reviewable implementation
candidate. It does not establish signing, installation, server permissions,
authorized-keys state, host visibility, staging readiness, or production
readiness.

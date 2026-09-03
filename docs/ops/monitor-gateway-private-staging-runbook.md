# Monitor gateway private-staging asset runbook

## Status and stop line

This is a repository asset and future operator procedure, not deployment
authorization. The current task stops after local validation, a pushed task SHA,
a Draft PR, and green CI. It does not authorize SSH, sudo execution, a remote
host, DNS, firewall changes, Nginx installation/reload, service changes,
certificate generation, network changes, deployment, cutover, migration,
merge, payment/order activity, or production access.

Every runtime command below is conditional on a separate, explicit staging
window with a named root operator and rollback owner. Do not execute it from the
current repository task. A missing exact value, approval, credential source,
backup owner, rollback owner, or accepted baseline is `FACT_SOURCE_MISSING` and
stops the affected phase. Any fingerprint, SHA, path, ownership, route, EKU,
SAN, expiry, anchor, package, DNS/NTP/time or default-route mismatch is `DRIFT`.
Do not infer or print the missing value.

Public Nginx route installation, reload and cutover are forbidden in this
procedure even after the two gateway services pass. Stop with:

```text
PRIVATE_STAGING_ASSETS: VERIFIED
PUBLIC_LOOPBACK: VERIFIED
NGINX_CANDIDATE: VALIDATED_ONLY
PUBLIC_CUTOVER: NOT_PERFORMED
```

## External execution record

Keep one mode-`0600` execution record outside Git and logs. It binds stable IDs
to the already approved values without recording those values in the ticket or
terminal transcript. Record only safe pass/fail, timestamps, hashes, exact SHA,
approval references and responsible roles.

Required authority:

- exact repository artifact SHA and immutable target
  `/opt/network-service-platform/monitor-gateway/releases/<exact-sha>`;
- the accepted manifest and candidate-set fingerprints from the frozen task;
- collision-free stable IDs for both loopback listeners, WireGuard interface,
  prefix, Web/FNOS single-host addresses, Web UDP endpoint, PKI identities,
  Nginx include/vhost, Web firewall enforcement anchor, and FNOS output chain;
- `MGW-NGINX-CANONICAL-ORIGIN-V1`, bound only in the operator manifest to the
  directly approved canonical HTTPS origin;
- accepted DNS, NTP, time, default-route and package-database baseline hashes;
- unused backup destination, rollback readiness, named operator and rollback
  owner.

Never record raw host/address/interface/prefix/endpoint/origin/port/anchor
values, certificate subject/SAN/serial, PEM, key, response body, full URL, client
IP, credential body or secret path in task output.

## Least-privilege credential sources

The runtime manifest contains only these exact source IDs and fixed target
intent. The secure assembler resolves them outside Git:

| Source ID | Required access | Runtime result |
| --- | --- | --- |
| `MGW-CREDENTIAL-WG-WEB-PRIVATE-V1` | root assembler, read once | Web receiver configuration, root-only `0600` |
| `MGW-CREDENTIAL-WG-FNOS-PUBLIC-V1` | root assembler, read once | one peer public key; no shared secret |
| `MGW-CREDENTIAL-PUBLIC-CA-V1` | root assembler | public CA certificate only |
| `MGW-CREDENTIAL-PUBLIC-SERVER-LEAF-V1` | root assembler | public-loopback server leaf/key |
| `MGW-CREDENTIAL-PRIVATE-CA-V1` | root assembler | private CA trust bundle only |
| `MGW-CREDENTIAL-PRIVATE-SERVER-LEAF-V1` | root assembler | private server leaf/key |
| `MGW-CREDENTIAL-PUBLIC-BFF-CLIENT-LEAF-V1` | root assembler | current public-BFF client leaf/key |
| `MGW-CREDENTIAL-PUBLIC-BFF-CLIENT-NEXT-LEAF-V1` | root assembler during overlap | optional next public-BFF client leaf/key |
| `MGW-CREDENTIAL-RAW-MONITOR-CA-V1` | root assembler only when raw origin is HTTPS | raw server CA certificate only |

The issuer private keys are never copied to either runtime host. WireGuard keys
and application mTLS rotate independently. The `monitor-gateway` system account
has no created home, uses `nologin`, has no sudo policy or capabilities, and
reads the immutable release plus root:`monitor-gateway` environment/PKI files.
The services cannot write the release or key directories. Nginx trusts only the
public-loopback CA; the private service trusts only the private client CA
bundle. Only `PUBLIC_BFF_IDENTITY` is required in this stage.

## Assembly outside the repository

1. Create a new mode-`0700` workspace outside Git. It must not be a symlink.
2. Export the exact accepted GitHub SHA into a read-only artifact directory
   named exactly for that SHA. Put the same SHA, and only that SHA, in
   `.monitor-gateway-release-sha`. Remove group/world write bits from the whole
   artifact.
3. Materialize the operator manifest from `manifest.schema.json`. Do not add
   fields, defaults or credential bodies. Both listeners must be the IPv4
   loopback literal; IPv6, wildcard, LAN, WireGuard, public, hostname and
   `localhost` binds are rejected.
4. Materialize the Web receiver WireGuard file at mode `0600`. It contains one
   interface address, one UDP listen port, one private key, one peer public key,
   and exactly the FNOS `/32` route. It contains no endpoint, keepalive,
   default route, table override, hooks, DNS or forwarding directive. FNOS is
   the outbound initiator and separately uses keepalive 25 plus only the Web
   `/32`; its already accepted output-chain requires no delta.
5. Materialize PKI at directory mode `0750` and file mode `0640`. The public CA
   verifies only the public-loopback server leaf. The private CA verifies the
   private server leaf and separate public-BFF client leaf. Server leaves have
   only server EKU; the BFF leaf has only client EKU. Leaf lifetime is at most
   90 days, rotation begins with 30 days remaining, and readiness closes below
   24 hours.
6. Run `render.py` into a new mode-`0700` output outside Git. Confirm exactly
   five mode-`0600` files and the safe `render-report.json` hashes. Never commit
   or print the generated files.

## Gate matrix

| Gate | Required evidence | Failure action |
| --- | --- | --- |
| Manifest | closed schema, exact fingerprints/SHA/stable IDs, no extra field or credential body | stop before any root action |
| Artifact | directory and marker equal exact SHA; entry point present; no symlink or group/world write | discard candidate; do not install |
| Ownership intent | env `0640`, PKI dir `0750`, PKI files `0640`, WireGuard `0600`, immutable release | stop before switch/start |
| Network | collision evidence, one peer `/32` each direction, no default route/forwarding/home inbound/reverse SSH, accepted endpoint/firewall anchors | restore staged files; no service start |
| PKI | dual-CA separation, key match, EKU/SAN, at most 90-day leaf, at least 24-hour readiness | do not start affected service |
| Backup | unused `0700` destination; every affected target state/hash recorded; previous service/network state recorded | rollback unavailable; do not install |
| Private success | private service active; mTLS positive health/readiness pass; missing-client negative gate rejected; no leak | stop public phase and rollback |
| Public loopback success | private remains active; public health/readiness/summary pass; exact public allowlist/no-store/no cookie/no CORS/no raw IP | stop and rollback public then private |
| Nginx candidate | isolated `nginx -t`; public CA verification; logical SAN; overwritten client IP; forwarded headers cleared; 30r/m burst 10; 3s/50s/50s; safe 503 | keep route inactive; rollback services |
| Residue | no unexpected runtime files, generated Git files, issuer keys, extra listener, route takeover, or partial backup | keep staging closed and recover |

## Repository-only raw-monitor candidate diagnostic

`monitoring/gateway/deploy/raw_monitor_probe.py` is an internal diagnostic aid;
it is not staging, remote-host, or production authorization. It accepts an
ordered private candidate set, rejects more than 64 candidates before any
request, and probes sequentially with bounded `GET` requests to only
`/api/overview` and
`/api/latency?range=6h&type=icmp&target=AliDNS`. An overview failure skips the
latency request, redirects are not followed, and non-200 error bodies are not
read.

The only safe rendered result is schema
`MGW-RAW-MONITOR-PROBE-DIAGNOSTIC-V1`, with exact top-level fields
`schemaVersion`, `candidateCount`, `overviewHttp200MatchCount`,
`fullContractMatchCount`, and `records`. Each ordered record has only
`attemptIndex`, `result`, `failureStage`, `reasonCode`, and `httpStatus`.
`httpStatus` is `null` unless a real 100-599 HTTP response was received. Use
the reason code and failure stage to distinguish transport, timeout, non-200,
invalid/oversized response, and contract mismatch failures; do not infer a
candidate identity from the attempt index.

Never append or print candidate origins, hosts, addresses, ports, URLs, paths,
headers, bodies, exception text, tracebacks, credentials, timings, process
details, or configuration. A diagnostic result is evidence for a separately
authorized read-only investigation only; it does not make private staging
eligible and must not be used to retry activation.

## Future authorized phase sequence

Bind the arguments once in a protected operator command record. Never enable
shell tracing. First run the non-mutating gate as an unprivileged user:

```text
install-root.sh precheck --confirm MONITOR-GATEWAY-PRIVATE-STAGING \
  --manifest <manifest> --expected-release-sha <sha> \
  --artifact-dir <artifact> --rendered-dir <rendered> --pki-dir <pki> \
  --wireguard-config <web-wg-config> --backup-dir <unused-backup>
```

After a separately authorized root window, run exactly one phase at a time and
review its safe result before continuing:

1. `install`: reruns preflight, backs up every affected resource and hash,
   records prior states, creates/verifies the no-home `monitor-gateway` identity,
   installs the immutable artifact, env, PKI, Web WireGuard file and both units.
   It does not switch `current`, start services or activate Nginx.
2. `network-up`: establishes the Web receiver and proves the FNOS address route
   uses only the approved interface. Confirm the FNOS outbound handshake and
   accepted Web endpoint without logging peer details. Reconfirm DNS, time,
   NTP, default route, package database and Web firewall anchor are unchanged.
3. `activate-private`: atomically switches `current` to the exact release,
   starts only `monitor-gateway-private.service`, and requires positive and
   negative mTLS gates. Stop if readiness is not 200 or any unexpected listener,
   log value, URL, path, raw IP or response body appears.
4. `activate-public`: first proves private is active, starts
   `monitor-gateway-public.service`, runs the loopback public contract/leakage
   gates, and validates only the isolated Nginx candidate. It never copies the
   vhost to the accepted include, reloads Nginx or changes the public route.
5. `postcheck`: repeats service, mTLS, public allowlist/header/leakage, candidate
   and residue gates. Record safe statuses and hashes only, then stop.

The unit order is private `Wants/After=network-online.target`; public
`Requires/After=monitor-gateway-private.service`. Both are simple services with
on-failure restart, 5-second delay, a 300-second/3-attempt start limit, SIGTERM,
75-second start timeout, 65-second stop timeout, journald only, IPv4/Unix address
families, empty capabilities and the frozen systemd hardening. No service has
sudo or write access to release/key material.

## Rollback and recovery

Rollback is strict reverse activation order: stop public, stop private, restore
the old atomic `current` link, take down the newly established WireGuard state,
restore units/WireGuard/PKI/env from verified backups, reload only the systemd
manager, remove only a release proven to have been created by this execution,
then restore the previously recorded network/private/public active states. A
one-time service identity is removed only when the backup proves it did not
exist and no process remains. Backup evidence is retained.

Before rollback, run the independent read-only gate using the separate token:

```text
rollback-root.sh precheck --confirm MONITOR-GATEWAY-PRIVATE-STAGING-ROLLBACK \
  --manifest <manifest> --expected-release-sha <sha> \
  --backup-dir <existing-backup>
```

Then run `rollback` and `postcheck` with the same frozen arguments. Do not use a
different manifest, inferred path, glob, broad recursive target, stale backup,
or manually edited record. If rollback validation fails, keep public routing
unchanged, leave services stopped where safe, preserve evidence, and escalate to
the named rollback owner.

For certificate rotation, first extend verifier trust to current plus next,
switch only the sender leaf, verify mTLS/readiness/traffic, then remove old
trust. Rollback restores the old symlink/env/trust bundle. Never rotate
WireGuard in the same action. Under 24 hours remaining, readiness stays closed
and the affected process is not promoted.

## Completion record

Record exact SHA, manifest/candidate fingerprints, safe hashes, all gate
statuses, backup/rollback readiness, service state, zero residue, and
`PUBLIC_CUTOVER: NOT_PERFORMED`. Do not claim deployment, public availability,
production readiness or real-client proof from repository/loopback checks.

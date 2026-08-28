# Diagnosis Intake release safety runbook

## Status and authority boundary

This is a release candidate procedure, not production authorization. It does
not authorize SSH, database access, Nginx changes, service restart or reload,
DNS changes, deployment, migration, traffic changes, payment/order actions, or
any other production operation. Every production step below requires a separate
approved release window and an identified operator.

Planning inputs frozen for `DIAGNOSIS-INTAKE-RELEASE-SAFETY-01` and
`DIAGNOSIS-INTAKE-RELEASE-TRAFFIC-GATE-01`:

- previously observed release: `9f58dc5e1d905fd06a1871c0e9c2e2d1f9eff71e`;
- implementation base and accepted Diagnosis Intake feature baseline:
  `47de74dee54382b15b08785b3bd6004090d31a77`;
- traffic-gate implementation base:
  `0cf35bfd0d011591aa5a01719fbaae9cfab28bde`;
- the existing database was observed in WAL mode with migrations 1 through 12;
- candidate startup automatically applies Migration 13;
- the older release understands only migrations 1 through 12;
- internal `GET /health` is the application health endpoint; public
  `/api/health` returning 404 is not changed by this release;
- the canonical public origin remains `https://www.siqiapparel.com`;
- release-wide closure uses the standalone replacement candidate
  `ops/nginx/release-traffic-closed.conf.example`; the diagnosis-only emergency
  include is not a release-wide traffic gate.

`47de74dee54382b15b08785b3bd6004090d31a77` is
`FEATURE_IMPLEMENTATION_BASE_SHA`, and
`0cf35bfd0d011591aa5a01719fbaae9cfab28bde` is
`TRAFFIC_GATE_IMPLEMENTATION_BASE_SHA`; neither is a production release
candidate. `RELEASE_CANDIDATE_SHA` does not yet exist in this task. Only after
this Draft PR is accepted and a merge is separately authorized may the exact
new GitHub SHA of `integration/consolidate-project` be queried and frozen as
`RELEASE_CANDIDATE_SHA` in a separate release decision. This runbook does not
prefill that future SHA and this task does not merge or deploy.

These are inputs for planning only. At execution time, revalidate every item
read-only under the separate production authorization. Any mismatch is `DRIFT`:
keep traffic closed and stop the affected step.

Validate the repository candidate and the required runbook invariants before
handoff or runtime assembly:

```text
node scripts/ops/validate-release-traffic-gate.mjs
```

## Required release record

Create an external release record without copying secrets, customer data,
database contents, or production paths into Git or logs. Record:

- approved operator, authorization reference, window, and rollback owner;
- `FEATURE_IMPLEMENTATION_BASE_SHA` and `TRAFFIC_GATE_IMPLEMENTATION_BASE_SHA`
  as lineage evidence;
- the separately frozen `RELEASE_CANDIDATE_SHA` and its GitHub verification
  evidence, recorded only after the separately authorized merge has completed,
  the new integration SHA exists, and that exact SHA is approved;
- expected and observed old release SHA;
- SHA-256 of the assembled closed configuration, its isolated `nginx -t`
  result, and the approved open-state configuration held for gate rollback;
- traffic gate closed time and the evidence that business writes stopped;
- the HTTP/HTTPS, bare/www, and safe non-business method-probe result;
- source migration sequence before startup;
- backup tool result: SHA-256, byte count, `0600` file mode, quick check,
  foreign-key result, and migration sequence;
- candidate startup time and observed migration sequence after startup;
- internal health result and the explicitly approved functional checks;
- either the traffic reopened time or the stopped/rollback state;
- the point at which database-restore eligibility ended.

Do not record database rows, contact details, credentials, environment values,
or filesystem locations.

## Parameterized release command record

Before a release window is approved, the operator must bind every placeholder
below to the already verified environment and freeze the resulting command
record outside Git. Values must be absolute or unambiguous, must not be printed
in task output, and must never be inferred during the release:

- `<NGINX_BINARY>`, `<NGINX_UNIT>`, `<STAGED_CLOSED_ROOT_CONFIG>`,
  `<ACTIVE_PUBLIC_CONFIG>`, and `<OPEN_PUBLIC_CONFIG>`;
- `<APP_UNIT>`, `<DATABASE_PATH>`, `<OLD_RELEASE>`, `<CANDIDATE_RELEASE>`, and
  `<CURRENT_RELEASE_POINTER>`;
- `<CANDIDATE_SHA_PROOF_COMMAND>` that fails unless the staged files are exactly
  `RELEASE_CANDIDATE_SHA`;
- `<DB_WRITER_PROOF_COMMAND>` that emits only pass/fail and fails if any
  application process can still write `<DATABASE_PATH>`;
- `<ATOMIC_RELEASE_SWITCH_COMMAND>` that changes the release pointer atomically
  on one filesystem and never copies into a live tree;
- `<CLOSED_GATE_INSTALL_COMMAND>`, `<OPEN_GATE_INSTALL_COMMAND>`, and
  `<GATE_ROLLBACK_COMMAND>` that replace the complete public virtual-host
  configuration atomically;
- `<PUBLIC_GATE_PROBE_COMMAND>` that checks only a unique non-business path and
  emits the status code, never response data;
- `<CLOSED_TRAFFIC_SMOKE_COMMANDS>` containing only separately approved,
  read-only checks that cannot create a diagnosis request or any payment,
  order, session, or other business write.

The command record must name the operator and rollback owner and include exact
commands for `systemctl stop`, `systemctl is-active`, `systemctl show` of the
main PID, `systemctl start`, and `systemctl status --no-pager` for `<APP_UNIT>`.
It must also include the exact internal loopback `GET /health` command. A
placeholder, missing command, unresolved path, command that prints sensitive
values, or release switch that is not atomic is a stop condition.

The closed Nginx artifact is assembled in a newly created `0700` private
directory. Copy the repository candidate there, insert only the environment's
existing TLS directives at `RUNTIME_TLS_DIRECTIVES_REQUIRED`, restrict the
assembled file to `0600`, and run:

```text
<NGINX_BINARY> -t -c <STAGED_CLOSED_ROOT_CONFIG>
```

The staged root must reference the assembled candidate as the complete public
configuration. It must not reference the normal public servers, the
diagnosis-only emergency include, proxy routes, or static routes. Do not test or
activate the incomplete repository example directly. Record only pass/fail and
the assembled file hash; do not record the assembled configuration or paths.

## Phase 1: read-only preflight

Before changing traffic or services:

1. Confirm `FEATURE_IMPLEMENTATION_BASE_SHA` and
   `TRAFFIC_GATE_IMPLEMENTATION_BASE_SHA` only as lineage evidence. Do not use
   either as the release candidate.
2. Confirm the separately authorized merge has completed, then confirm a
   separate release decision has frozen the resulting existing exact
   `RELEASE_CANDIDATE_SHA` from GitHub. If that field is missing, inferred,
   points to either implementation base, predates the merge, or does not exist
   on the approved integration branch, stop.
3. Confirm the actual deployed SHA, database journal mode, quick check,
   foreign-key check, and `schema_migrations` sequence using read-only methods.
4. Confirm the current application Origin remains only
   `https://www.siqiapparel.com`; do not add the bare domain.
5. Confirm the parameterized command record is complete and that isolated
   `nginx -t` passed for the exact assembled closed configuration.
6. Confirm the closed candidate is a complete replacement covering bare and
   www hostnames on HTTP and HTTPS. The active closed state must have no proxy,
   static, application, or diagnosis-specific route.
7. Confirm the separately approved release procedure identifies how to stop
   `<APP_UNIT>`, prove its process has exited, prove no application database
   writer remains, atomically switch `<CURRENT_RELEASE_POINTER>`, and start only
   the exact frozen candidate. If any bound command is missing, stop.
8. Confirm the operator has an unused backup destination and enough storage.
9. Confirm the rollback owner understands that the old release cannot open a
   database after Migration 13 has been applied.

Stop on an unexpected SHA, failed integrity check, migration sequence other
than 1 through 12, missing traffic gate, missing rollback owner, insufficient
storage, or any request to infer a production path or secret.

## Phase 2: close traffic, create backup, and prove the gate

1. Re-run `<NGINX_BINARY> -t -c <STAGED_CLOSED_ROOT_CONFIG>`. If it passes, run
   the frozen `<CLOSED_GATE_INSTALL_COMMAND>`, test the exact active Nginx root,
   and reload `<NGINX_UNIT>` using only the separately approved production
   authorization. If install, test, or reload fails, restore the already-tested
   `<OPEN_PUBLIC_CONFIG>` with `<GATE_ROLLBACK_COMMAND>` and stop before
   the backup or service change.
2. Prove the closed state without sending a business request. Against a unique
   non-business path, run `<PUBLIC_GATE_PROBE_COMMAND>` for bare and www over
   HTTP and HTTPS, sampling GET, POST, PUT, and DELETE. Every result must be 503
   with no redirect or response body recorded. Confirm from the active parsed
   configuration, without logging it, that no other public server for either
   hostname can proxy or serve a request. Record only:

   ```text
   FULL_PUBLIC_GATE: CLOSED
   PUBLIC_WRITE_PATHS: CLOSED
   ```

3. Keep the closed gate active. The internal loopback `GET /health` remains
   outside Nginx and may still report the old service as healthy; it is not
   evidence that public traffic is open.
4. Run the repository backup tool with explicit absolute paths supplied by the
   authorized operator. The destination must not exist:

   ```text
   node auth-service/scripts/sqlite-backup.mjs create --source <SOURCE_DB_PATH> --destination <NEW_BACKUP_PATH>
   ```

   The tool does not read environment variables. It validates the source,
   creates an online SQLite backup suitable for a WAL source, validates the
   backup with `quick_check` and `foreign_key_check`, compares the
   source/snapshot `schema_migrations` sequences, and emits SHA-256, byte count,
   and file mode without emitting database content. The partial and final
   backup are explicitly restricted to owner read/write mode `0600`; the tool
   fails closed if it cannot enforce that mode.

5. Independently re-run verification with the recorded hash:

   ```text
   node auth-service/scripts/sqlite-backup.mjs verify --backup <NEW_BACKUP_PATH> --expected-sha256 <RECORDED_SHA256> --expected-last-migration 12
   ```

   Independent verification intentionally does not read the live source. It
   proves the backup still has mode `0600`, the recorded hash, successful
   `quick_check` and `foreign_key_check`, and a continuous migration sequence
   exactly from 1 through the explicit boundary. This remains valid after the
   live database advances to Migration 13.

6. Record only the safe result fields. A non-zero exit, partial result, missing
   hash, permission failure, failed check, or migration mismatch is a failed
   backup. Do not deploy.
7. From the `FULL_PUBLIC_GATE: CLOSED` checkpoint until traffic reopens,
   continuously preserve evidence that the complete replacement stayed active.
   Any non-503 probe, Nginx reload, public-config change, alternate ingress, or
   unaccounted write invalidates the no-public-write proof. Without that proof,
   database restore is forbidden.

## Phase 3: start the candidate while traffic stays closed

1. Re-run the four host/scheme probes and keep all public traffic closed.
2. Run the frozen `systemctl stop <APP_UNIT>` command. Require
   `systemctl is-active <APP_UNIT>` to report `inactive` and the frozen
   `systemctl show` main-PID check to report no running process.
3. Run `<DB_WRITER_PROOF_COMMAND>`. It must fail closed and emit only pass/fail.
   Do not start or switch anything unless the record contains:

   ```text
   APPLICATION_DB_WRITERS: ZERO
   ```

4. Run `<CANDIDATE_SHA_PROOF_COMMAND>`, then
   `<ATOMIC_RELEASE_SWITCH_COMMAND>`, and immediately repeat the SHA proof
   against `<CURRENT_RELEASE_POINTER>`. Start `<APP_UNIT>` only when both proofs
   identify the exact separately frozen `RELEASE_CANDIDATE_SHA`. The old service
   and candidate must never run as concurrent writers against the same database.
   Candidate startup automatically applies Migration 13; do not run an extra
   manual migration.
5. Confirm `systemctl is-active <APP_UNIT>` reports `active`, the main PID is
   non-zero and belongs to the candidate, and internal `GET /health` returns 200
   with the expected response. Confirm the process remains healthy across the
   separately frozen observation interval. Do not treat public `/api/health` as
   a health check.
6. Re-check database integrity and confirm `schema_migrations` is exactly 1
   through 13. Confirm the diagnosis table exists without reading or printing
   customer rows.
7. Run only `<CLOSED_TRAFFIC_SMOKE_COMMANDS>`, then repeat the full public gate
   probes. Payment or real-order activity requires its own explicit
   authorization and is not part of this runbook.

Do not reopen traffic if startup, health, schema, integrity, configuration, or
the approved smoke checks fail.

## Rollback boundary before traffic reopens

Database restore is eligible only when all of the following are true:

- business traffic has not been reopened;
- the write gate remained effective after the backup;
- evidence proves there were no production business writes after the backup;
- the recorded backup hash and verification still pass;
- the rollback is separately authorized and performed by the named owner.

If every condition is met, the authorized rollback must treat the old release
and the migrations-1-through-12 database backup as one matched rollback unit.
First rerun the source-independent `verify` command above with the recorded hash
and `--expected-last-migration 12`. Keep the full public gate closed while
stopping the candidate and repeating the inactive-PID and
`APPLICATION_DB_WRITERS: ZERO` proofs. Restore the verified backup, atomically
switch `<CURRENT_RELEASE_POINTER>` to `<OLD_RELEASE>`, prove the expected old
SHA, and only then start `<APP_UNIT>`. Repeat internal health, database integrity,
migration-1-through-12, and full-gate checks. Reopen traffic only after the
rollback acceptance is recorded. Never start the old release against a
migrations-1-through-13 database.

If any condition cannot be proven, do not restore the database. Keep traffic
closed and use a forward fix or obtain a new decision.

## Reopen traffic and end restore eligibility

Reopen traffic only after the release owner accepts candidate health, schema,
integrity, closed-traffic smoke checks, and the repeated full-gate probes.
Re-run `nginx -t` with the staged open-state configuration. The open state must
restore the canonical www service and the separately tested bare-domain 308
redirect. Run `<OPEN_GATE_INSTALL_COMMAND>`, test the exact active root, and
reload `<NGINX_UNIT>` only under the separately approved production release.
If any step fails, restore the tested closed candidate and remain closed.

Record the exact time of the first accepted non-503 public response and
immediately mark:

```text
DATABASE_RESTORE_ELIGIBILITY: ENDED
```

After this point, restoring the old database is prohibited because it can lose
orders, payments, diagnosis requests, or other business writes. The prohibition
applies even if the diagnosis feature is the only visible problem.

## Diagnosis emergency close after traffic reopens

For a diagnosis-specific incident after reopen:

1. Do not restore the database and do not switch the old release onto the
   migrations-1-through-13 database.
2. Under separate production authorization, assemble
   `ops/nginx/diagnosis-emergency-closed.conf.example` inside the existing www
   server. It returns 503 only for `/diagnosis`, the public diagnosis API, and
   the admin diagnosis API; it does not intentionally close health, Auth,
   payment, order, or other website routes.
3. Assemble `ops/nginx/bare-domain-redirect.conf.example` with the existing TLS
   directives so bare-domain HTTP and HTTPS requests permanently redirect to
   `https://www.siqiapparel.com`. Do not expand the application Origin list.
4. Run `nginx -t` against the fully assembled environment configuration, review
   the diff, and reload only with separate production authorization. This
   repository task does not run or claim `nginx -t` success.
5. Confirm the diagnosis page and both diagnosis API boundaries return 503,
   while the canonical site and internal health behavior remain as approved.
6. Prepare and deploy a forward fix through a new frozen task. Remove the
   emergency include only after that fix is accepted.

## Stop lines

Stop the affected step and keep or return traffic to the safest already-proven
state when any of these occurs:

- release SHA, migration sequence, Origin, or health behavior drifts;
- `RELEASE_CANDIDATE_SHA` is missing, inferred, still equals either
  implementation base, or has not been separately frozen from GitHub;
- backup validation or hash verification fails;
- the backup destination already exists or source and destination resolve to
  the same path;
- traffic closure or absence of post-backup writes cannot be proven;
- the closed candidate is layered beside an open public server instead of
  replacing every public bare/www server;
- any bare/www HTTP/HTTPS probe does not return 503 while the gate should be
  closed;
- the approved old-service stop/switch procedure is missing, the old process
  remains connected, or absence of concurrent application writers cannot be
  proven;
- a step needs a real secret, customer data, unapproved path, dependency,
  contract change, manual migration, payment/order action, or production access;
- `nginx -t`, startup, integrity, or the approved smoke checks fail;
- rollback would combine the old release with the migrations-1-through-13
  database;
- anyone proposes database restore after traffic reopened.

The only allowed post-reopen recovery paths are the narrow diagnosis emergency
close or a forward fix. Merge, deployment, production changes, and traffic
actions remain independently authorized operations.

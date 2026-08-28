# Diagnosis Intake release safety runbook

## Status and authority boundary

This is a release candidate procedure, not production authorization. It does
not authorize SSH, database access, Nginx changes, service restart or reload,
DNS changes, deployment, migration, traffic changes, payment/order actions, or
any other production operation. Every production step below requires a separate
approved release window and an identified operator.

Planning inputs frozen for `DIAGNOSIS-INTAKE-RELEASE-SAFETY-01`:

- previously observed release: `9f58dc5e1d905fd06a1871c0e9c2e2d1f9eff71e`;
- approved candidate: `47de74dee54382b15b08785b3bd6004090d31a77`;
- the existing database was observed in WAL mode with migrations 1 through 12;
- candidate startup automatically applies Migration 13;
- the older release understands only migrations 1 through 12;
- internal `GET /health` is the application health endpoint; public
  `/api/health` returning 404 is not changed by this release;
- the canonical public origin remains `https://www.siqiapparel.com`.

These are inputs for planning only. At execution time, revalidate every item
read-only under the separate production authorization. Any mismatch is `DRIFT`:
keep traffic closed and stop the affected step.

## Required release record

Create an external release record without copying secrets, customer data,
database contents, or production paths into Git or logs. Record:

- approved operator, authorization reference, window, and rollback owner;
- expected and observed release SHA;
- traffic gate closed time and the evidence that business writes stopped;
- source migration sequence before startup;
- backup tool result: SHA-256, byte count, quick check, foreign-key result, and
  migration sequence;
- candidate startup time and observed migration sequence after startup;
- internal health result and the explicitly approved functional checks;
- either the traffic reopened time or the stopped/rollback state;
- the point at which database-restore eligibility ended.

Do not record database rows, contact details, credentials, environment values,
or filesystem locations.

## Phase 1: read-only preflight

Before changing traffic or services:

1. Confirm the approved source and candidate SHAs from the release record.
2. Confirm the actual deployed SHA, database journal mode, quick check,
   foreign-key check, and `schema_migrations` sequence using read-only methods.
3. Confirm the current application Origin remains only
   `https://www.siqiapparel.com`; do not add the bare domain.
4. Confirm the existing traffic-withdrawal procedure can stop all business
   writes, not only the diagnosis page.
5. Confirm the operator has an unused backup destination and enough storage.
6. Confirm the rollback owner understands that the old release cannot open a
   database after Migration 13 has been applied.

Stop on an unexpected SHA, failed integrity check, migration sequence other
than 1 through 12, missing traffic gate, missing rollback owner, insufficient
storage, or any request to infer a production path or secret.

## Phase 2: close traffic, create backup, and prove the gate

1. Use the already approved traffic-withdrawal mechanism to stop all external
   business traffic and writes.
2. Prove the gate is effective. Record the gate-closed time and the write-stop
   evidence before creating the backup.
3. Keep the old service and database state stable while the backup runs.
4. Run the repository tool with explicit absolute paths supplied by the
   authorized operator. The destination must not exist:

   ```text
   node auth-service/scripts/sqlite-backup.mjs create --source <SOURCE_DB_PATH> --destination <NEW_BACKUP_PATH>
   ```

   The tool does not read environment variables. It validates the source,
   creates an online SQLite backup suitable for a WAL source, validates the
   backup with `quick_check` and `foreign_key_check`, compares the
   `schema_migrations` sequences, and emits SHA-256 and byte count without
   emitting database content.

5. Independently re-run verification with the recorded hash:

   ```text
   node auth-service/scripts/sqlite-backup.mjs verify --source <SOURCE_DB_PATH> --backup <NEW_BACKUP_PATH> --expected-sha256 <RECORDED_SHA256>
   ```

6. Record only the safe result fields. A non-zero exit, partial result, missing
   hash, failed check, or migration mismatch is a failed backup. Do not deploy.
7. From this point until traffic reopens, continuously preserve evidence that
   no production business write occurred after the backup snapshot. Without
   that proof, database restore is forbidden.

## Phase 3: start the candidate while traffic stays closed

1. Keep all business traffic closed.
2. Start the exact approved candidate using the separately authorized release
   procedure. Startup automatically applies Migration 13; do not run an extra
   manual migration.
3. Confirm the process stays up and internal `GET /health` returns 200 with the
   expected response. Do not treat public `/api/health` as a health check.
4. Re-check database integrity and confirm `schema_migrations` is exactly 1
   through 13. Confirm the diagnosis table exists without reading or printing
   customer rows.
5. Run only the approved closed-traffic smoke checks. Payment or real-order
   activity requires its own explicit authorization and is not part of this
   runbook.

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
Keep traffic closed while stopping the candidate, restoring the verified
backup, starting the exact old release, and repeating the internal health and
integrity checks. Reopen traffic only after the rollback acceptance is recorded.

If any condition cannot be proven, do not restore the database. Keep traffic
closed and use a forward fix or obtain a new decision.

## Reopen traffic and end restore eligibility

Reopen traffic only after the release owner accepts the closed-traffic checks.
Record the exact reopen time and immediately mark:

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
- backup validation or hash verification fails;
- the backup destination already exists or source and destination resolve to
  the same path;
- traffic closure or absence of post-backup writes cannot be proven;
- a step needs a real secret, customer data, unapproved path, dependency,
  contract change, manual migration, payment/order action, or production access;
- `nginx -t`, startup, integrity, or the approved smoke checks fail;
- rollback would combine the old release with the migrations-1-through-13
  database;
- anyone proposes database restore after traffic reopened.

The only allowed post-reopen recovery paths are the narrow diagnosis emergency
close or a forward fix. Merge, deployment, production changes, and traffic
actions remain independently authorized operations.

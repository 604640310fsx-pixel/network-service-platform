# Consolidated release runbook

## Status and authority

This repository document is a release procedure, not authorization to release.
It does not authorize access to a host, service manager, database, credential
store, Nginx, DNS, payment system, mail provider, monitoring origin, or customer
system. Merge, release, deployment, production access, traffic changes, database
restore, and external effects each require their own approved execution packet.

Frozen repository facts for `CONSOLIDATED-RELEASE-PACKET-HARDENING-01`:

```text
IMPLEMENTATION_BASE_SHA: 7b79139133fe912088bfe3ae9e1321bb8bc379de
IMPLEMENTATION_BASE_IS_RELEASE_CANDIDATE: NO
PRE_RELEASE_SCHEMA_BOUNDARY: 13
CANDIDATE_SCHEMA_BOUNDARY: 14
```

The implementation base is only the starting point for this hardening change.
After this Draft PR is accepted and a merge is separately authorized, a new
exact `integration/consolidate-project` commit may be frozen in a separate
decision as `RELEASE_CANDIDATE_SHA`. Never substitute the implementation base,
a PR head, a local tree, a tag name, or a planned commit for that future value.

The release is fail-closed until every binding named in
[`consolidated-release-bindings.md`](consolidated-release-bindings.md) has a
current proof in an external release record. The record may contain hashes,
counts, timestamps, pass/fail results, and binding names. It must not contain
secret values, customer rows, database contents, credential material, or
private configuration bodies.

## Pre-window artifact gate

Before requesting a release window:

1. Build auth-service and website from the exact clean candidate checkout with
   the frozen Node runtime and exact lockfiles. Do not install dependencies on a
   production host as part of the switch.
2. Assemble the candidate with explicit values:

   ```text
   node scripts/ops/assemble-consolidated-release.mjs \
     --source <CLEAN_CANDIDATE_CHECKOUT> \
     --destination <NEW_BUNDLE_DIRECTORY> \
     --expected-sha <RELEASE_CANDIDATE_SHA>
   ```

   The destination must not exist. The bundle retains the repository-relative
   auth runtime layout, including compiled `auth-service/dist/src`, package
   manifests, migrations 001-014, and `website/dist`. It excludes dependency
   directories, environment files, credentials, private keys, databases, and
   files outside the explicit release inputs.
3. Assemble into a second new destination from the same checkout. Require the
   two `release-manifest.json` files to be byte-for-byte identical.
4. Validate both the repository packet and chosen bundle:

   ```text
   node scripts/ops/validate-consolidated-release-packet.mjs \
     --source <CLEAN_CANDIDATE_CHECKOUT> \
     --expected-sha <RELEASE_CANDIDATE_SHA> \
     --bundle <NEW_BUNDLE_DIRECTORY>
   ```

5. Independently hash the retained candidate bundle and bind it to the future
   release record. Also bind a previously validated rollback bundle containing
   the matched old auth and website artifacts. The old auth binary must accept
   exactly the pre-release migration boundary. Because dependency directories
   are deliberately excluded, bind a prebuilt auth dependency layer to the
   candidate lockfile, Node version, OS/architecture/libc, and native-module ABI.
6. Assemble and test complete open and closed Nginx roots in an isolated
   location. Repository examples are incomplete candidates and must never be
   activated directly. Record configuration hashes and `nginx -t` pass/fail,
   never the configuration bodies or production paths.

Any source SHA mismatch, dirty source, non-deterministic manifest, missing
artifact, extra inventory file, hash mismatch, symlink, forbidden file,
unmatched rollback artifact, or failed isolated configuration test stops the
release before traffic changes.

## Nginx invariants

`CLOSED_NGINX_INVARIANT` starts from
`ops/nginx/release-traffic-closed.conf.example` and requires a complete
replacement of every public and alternate ingress for both approved hostnames
on HTTP and HTTPS. Each request
method and path must terminate at 503 with `Cache-Control: no-store` and a
bounded `Retry-After`. There must be no active proxy, static root, SPA fallback,
redirect, application route, or second server that can accept the same names.
The internal loopback health endpoint is outside this public gate.

`OPEN_NGINX_INVARIANT` requires the approved website root from the same
candidate bundle, BrowserRouter fallback to `index.html`, the exact approved
`/api` upstream, existing TLS material, security headers, and the bare-domain
308 redirect to the canonical www origin. It must contain no release-closed 503
server and no alternate ingress that bypasses the approved application path.

The active parsed topology, four host/scheme probes, representative safe
methods, and configuration hash must prove the selected invariant. A listener
alone is not proof.

## Read-only execution preflight

Before closing traffic, the authorized operator must prove all of the
following from the bound target:

- the separately frozen candidate exists on the approved integration lineage;
- candidate and rollback bundle hashes and inventories match their records;
- the prebuilt auth dependency layer matches the candidate lockfile and runtime
  ABI without an install during the release switch;
- the current auth/website artifacts and schema boundary match the rollback
  record;
- `schema_migrations` is the continuous prefix 001-013, journal mode and
  integrity checks pass, and the database owner/mode are the approved values;
- the exact application PID, every background writer, alternate ingress, and
  active Nginx topology are discoverable without printing sensitive values;
- the combined auth/website pointer switch is a single atomic switch to one
  versioned consolidated bundle;
- backup destination, capacity, owner, restore procedure, restore deadline,
  operator, rollback owner, and evidence destination are bound;
- the closed and open configurations still pass isolated validation;
- feature inclusion and normal worker readiness checks are frozen.

Unexpected SHA, schema other than 001-013, unknown writer, partial artifact,
unresolved placeholder, missing proof, or changed binding is `DRIFT`. Stop
before writes.

## Frozen release sequence

The external record must capture these checkpoints in this exact order. Do not
create the database snapshot while the old application or any background writer
is still running.

1. Install the already-tested closed root atomically and reload only within the
   approved window. Prove all public and alternate paths closed, then record:

   ```text
   FULL_INGRESS: CLOSED
   ```

2. Stop the exact old application through the bound service manager. Require
   inactive state and record:

   ```text
   OLD_APPLICATION: STOPPED
   ```

3. Prove the recorded main PID and all child processes are gone. Record:

   ```text
   OLD_APPLICATION_PID: ABSENT
   ```

4. Run the bound writer inventory after the process is absent. It must include
   request handlers, payment expiry, mail dispatch, maintenance processes, and
   any process holding a writable database descriptor. Record only:

   ```text
   APPLICATION_DB_WRITERS: ZERO
   ```

5. With ingress still closed and writers still zero, create the SQLite backup
   at a new destination. Verify owner-only mode, SHA-256, size, `quick_check`,
   `foreign_key_check`, and continuous migrations through 013. Re-run the
   source-independent verification using the recorded hash, then record:

   ```text
   SQLITE_SNAPSHOT: VERIFIED
   ```

6. Reverify both candidate and rollback artifact hashes. Atomically move the
   one consolidated release pointer so auth and website select the same
   candidate bundle. Prove both paths and the manifest resolve to the future
   exact candidate before recording:

   ```text
   AUTH_WEBSITE_POINTERS: SWITCHED_ATOMICALLY
   ```

7. Start the candidate in quiescent validation mode with payment, mail dispatch,
   and registration disabled and the monitor origin omitted. Prove the bound
   environment without printing values. The expected state is:

   ```text
   QUIESCENT_PAYMENT: DISABLED
   QUIESCENT_MAIL: DISABLED
   BACKGROUND_WRITERS: DISABLED
   MONITOR_API_ORIGIN: OMITTED_IN_QUIESCENT_MODE
   ```

   Startup may apply migration 014. Validate exact candidate identity, loopback
   health, migration prefix 001-014, database integrity, static website files,
   the manifest inventory, and the still-closed ingress. Do not send a payment,
   email, order, registration, diagnosis, or other business request.

8. Decide while the candidate remains quiescent whether to roll back or commit
   to the forward path. Database restore is eligible only if the closed gate was
   continuous, the snapshot is still valid, and no post-snapshot business or
   background write occurred. Require the matched old auth/website/schema unit:

   ```text
   ROLLBACK_ARTIFACT_COMPATIBILITY: MATCHED
   ROLLBACK_ELIGIBILITY: DECIDED
   ```

9. If rollback is selected, execute the rollback section below. If the forward
   path is selected, record the irreversible release decision before enabling
   any worker:

   ```text
   DATABASE_RESTORE_ELIGIBILITY: ENDED
   ```

   Stop the quiescent candidate, prove its PID absent and database writers zero,
   then start the same candidate bundle with the approved normal bindings. Only
   after its exact identity and normal environment are proven record:

   ```text
   NORMAL_CANDIDATE: STARTED
   ```

10. While ingress remains closed, validate health, schema 001-014, database
    integrity, auth and website artifact hashes, worker-specific readiness, and
    all approved non-business probes. Payment expiry and mail dispatch are not
    considered ready merely because `/health` succeeds. Repeat closed topology
    and ingress probes, then record:

    ```text
    CLOSED_TRAFFIC_ACCEPTANCE: PASS
    ```

11. Atomically install the already-tested open root, validate the exact active
    root, and reload within the same authorization. Prove canonical website,
    bare-domain redirect, API routing, static SPA fallback, security headers,
    and absence of an alternate bypass before recording:

    ```text
    FULL_INGRESS: OPEN
    ```

If normal startup or worker readiness fails after restore eligibility ended,
keep ingress closed and use a separately approved forward fix. Do not restore
the pre-014 database.

## Rollback while restore remains eligible

Rollback is a matched database-and-artifact operation:

1. Keep every ingress closed; stop the quiescent candidate and prove its PID is
   absent and all database writers are zero.
2. Reverify the backup mode, hash, size, integrity, foreign keys, and migration
   boundary 001-013. Reprove that no post-snapshot write occurred and the
   restore deadline has not passed.
3. Restore the verified pre-014 snapshot using the separately authorized bound
   command. Never open the old binary on a database containing migration 014.
4. Atomically switch the single consolidated pointer to the matched rollback
   bundle containing both old auth and old website artifacts. Prove their hashes
   and old source SHA.
5. Start the old service, then validate loopback health, schema compatibility,
   database integrity, rollback website, and the closed Nginx invariant.
6. Install the already-tested open root and reopen only after rollback
   acceptance.

If any business or background write occurred after the snapshot, if the closed
gate was interrupted, or if any compatibility proof is missing, database
restore is prohibited. Keep ingress closed and obtain a forward-fix decision.

## Monitor boundary

```text
MONITOR_AUTH_PROJECTION_STATUS: CONDITIONAL_BLOCKER
```

This task does not implement `MONITOR-AUTH-PROJECTION-01`. If the release
includes administrator monitor-target selection or monitor-linked fulfillment,
the separate Auth Service mTLS identity and private HTTPS projection must first
be contract-tested and accepted. A plain `MONITOR_API_ORIGIN` value is not an
allowed bypass. If the projection is not accepted, the capability must remain
excluded under a separate product decision; the runbook cannot make that
decision.

## Stop lines

Stop the affected step, preserve the last proven closed state, and record only
redacted evidence when any of these occurs:

- SHA, manifest, migration boundary, artifact, binding, worker, or Nginx drift;
- an unresolved writer, surviving PID, failed stop, or writable database handle;
- snapshot, hash, ownership, integrity, foreign-key, or restore-deadline failure;
- independent auth/website switching that could expose a mixed release;
- quiescent payment/mail/registration unexpectedly enabled;
- normal worker readiness not independently proven;
- an open or closed ingress invariant fails on any path;
- rollback artifacts do not match the pre-014 database;
- database restore is proposed after eligibility ended;
- monitor-linked fulfillment is requested without the accepted private mTLS
  projection;
- a step needs a secret in Git/logs, an inferred production value, a new
  dependency, a public contract change, real payment, merge, deployment, or
  production authority that has not been separately granted.

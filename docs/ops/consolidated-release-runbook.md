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
PRE_RELEASE_SCHEMA_BOUNDARY: 16
CANDIDATE_SCHEMA_BOUNDARY: 17
```

The block above records the historical hardening packet. The current repository
inventory includes migration 025 (ticket attachments and grant link), and its local
candidate manifest requires schema boundary 25 through the `standard16-25`,
`direct14-25`, or `standard19-25` route; neither value authorizes a release
candidate. The `standard16-24`, `direct14-24`, and `standard19-24` routes remain
recognized only for already-built 001-024 bundles, the `standard16-23`,
`direct14-23`, and `standard19-23` routes only for already-built 001-023
bundles, the `standard16-22`,
`direct14-22`, and `standard19-22` routes only for already-built 001-022
bundles, the `standard16-21`,
`direct14-21`, and `standard19-21` routes only for already-built 001-021
bundles, the `standard16-20`,
`direct14-20`, and `standard19-20` routes only for already-built 001-020
bundles, and the `standard16-19` and
`direct14-19` routes only for already-built 001-019 bundles; none of them can
assemble the current source.

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

## Runtime configuration inventory gate

Before the pre-window artifact gate, an authorized operator uses only the
separately authorized external binding record and credential source. Do not
print, copy, or compare values. Record only redacted pass/fail results, counts,
the accepted inventory fingerprint
`bfc8fecc287438a3958f01cb6f7933697e59a8af713435a4f3f936cfcd464705`, and
approved evidence references. The fingerprint represents the currently accepted
62-tuple release baseline, sorted as UTF-8 LF tuples with a final LF, and contains
no values. The five frozen conditional Monitor Auth Projection names are not
part of that baseline; enabling them requires a separately accepted expanded
inventory/fingerprint rather than silently changing this record.

Compare names and classifications only, and keep these categories separate:

- Auth runtime environment keys: required normal-runtime keys and conditional
  payment/mail keys described in
  [`consolidated-release-bindings.md`](consolidated-release-bindings.md).
- Credential logical names: required and conditional names from the approved
  credential source; source ownership, readability, and non-logging are proven
  without emitting credential contents.
- Monitor Auth Projection names: conditional server-only
  `MONITOR_AUTH_PROJECTION_ENABLED`, `MONITOR_AUTH_PRIVATE_ORIGIN`, and the three
  dedicated mTLS credential logical names in the binding checklist. These names
  do not authorize values or enablement.
- Public website build key: optional, conditional, browser-exposed
  `VITE_MONITOR_URL`, which is distinct from the excluded
  `MONITOR_API_ORIGIN` and has no literal default.

In quiescent mode, require `PAYMENT_ENABLED`, `MAIL_DISPATCH_ENABLED`, and
`REGISTRATION_ENABLED` to be explicitly disabled, require
`MONITOR_AUTH_PROJECTION_ENABLED` to be explicitly disabled, and require both
`MONITOR_AUTH_PRIVATE_ORIGIN` and `MONITOR_API_ORIGIN` to be omitted. Normal-mode inclusions, values, and
capabilities require their separately approved production binding record;
required or conditional classification does not authorize supplying values,
enabling features, contacting providers, or deploying. Also prove that
server-only secrets are absent from the website bundle and any browser output.

Stop the release on any missing, extra, unknown, or stale name; malformed
required flag; unreadable credential; value leakage; classification or
fingerprint mismatch; or any `MONITOR_API_ORIGIN` present in this release. Do
not treat CI, tooling, or test keys as production runtime bindings.

## Pre-window artifact gate

The ignored `auth-service/dist` and `website/dist` directories are not bound by
Git cleanliness. A local assembly can therefore test layout and determinism but
can never establish that those bytes were built from its `sourceSha`:

```text
LOCAL_BUNDLE_RELEASE_USE: FORBIDDEN
GITHUB_ARTIFACT_PROVENANCE: REQUIRED
```

Pull-request merge refs, Draft PRs, task branches, non-integration branches, and
local runs produce test-only provenance with `releaseUse: forbidden`. Their
bundles must never be retained, frozen, staged, or relabelled as release
candidates. Only the repository CI job triggered by a successful `push` to
`refs/heads/integration/consolidate-project` may assemble and retain the exact
candidate artifact. That job checks `GITHUB_SHA === expectedSha`, builds auth
and website first, assembles twice, compares the manifests, validates both
inventories, and uploads only the first bundle under the exact name
`consolidated-release-<RELEASE_CANDIDATE_SHA>`; it passes
`--schema-route standard16-25` explicitly.
The same job also independently assembles and validates an explicit
`direct14-25` bundle twice, then retains its first bundle as
`consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`. It likewise assembles
and validates an explicit `standard19-25` bundle twice and retains its first
bundle as `consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>`. Pull-request
runs only test these routes; nothing is retained outside a successful
integration push. The artifact names and manifest schema boundaries are
distinct; no route can validate another route's bundle. The default command and the sequence below remain the
001-016 rollback route.

The upload alone does not authorize release. After the merge and integration
push are separately authorized, the future candidate SHA must still be frozen
in a separate decision. Before requesting a release window:

1. Select the successful `CI` run whose event is `push`, workflow path is
   `.github/workflows/ci.yml`, head branch is
   `integration/consolidate-project`, head SHA equals the separately frozen
   `RELEASE_CANDIDATE_SHA`, and run attempt matches the manifest provenance.
   A job name or copied environment variables are not proof.
2. Bind the run ID, attempt, exact artifact ID, exact artifact name, and the
   GitHub-reported `sha256:` artifact digest without recording credentials.
   Download that exact artifact through the GitHub Actions artifact API into a
   new archive path. Do not rebuild or substitute local ignored output.
3. Extract the archive into a new directory and validate it against a clean
   checkout of the same candidate SHA:

   ```text
   gh api \
     --hostname github.com \
     repos/604640310fsx-pixel/network-service-platform/actions/artifacts/<CANDIDATE_GITHUB_ARTIFACT_ID>/zip \
     > <NEW_ARTIFACT_ARCHIVE>
   unzip <NEW_ARTIFACT_ARCHIVE> -d <NEW_EXTRACTED_BUNDLE_DIRECTORY>
   node scripts/ops/validate-consolidated-release-packet.mjs \
     --source <CLEAN_CANDIDATE_CHECKOUT> \
     --expected-sha <RELEASE_CANDIDATE_SHA> \
     --bundle <NEW_EXTRACTED_BUNDLE_DIRECTORY> \
     --validation-mode candidate \
     --github-artifact-id <CANDIDATE_GITHUB_ARTIFACT_ID> \
     --artifact-archive <NEW_ARTIFACT_ARCHIVE>
   ```

   Candidate validation retrieves live artifact and workflow-run metadata. It
   requires the artifact ID/name/digest, run ID/attempt, successful push event,
   integration ref, run head SHA, manifest `sourceSha`, manifest bytes, archive
   file set, and every inventoried file hash to agree. An expired artifact,
   unavailable metadata, altered archive, PR merge ref, failed run, or
   environment-only provenance fails closed.
4. The bundle retains the repository-relative auth runtime layout, including
   compiled `auth-service/dist/src`, package manifests, migrations 001-025, and
   `website/dist`. It excludes dependency directories, environment files,
   credentials, private keys, databases, and files outside the explicit release
   inputs. Bind its verified manifest and auth/website inventory hashes.
5. Bind a previously validated rollback bundle containing the matched old auth
   and website artifacts. The old auth binary must accept exactly the
   pre-release migration boundary. Because dependency directories are
   deliberately excluded, bind a prebuilt auth dependency layer to the
   candidate lockfile, Node version, OS/architecture/libc, and native-module ABI.
6. Assemble and test complete open and closed Nginx roots in an isolated
   location. Repository examples are incomplete candidates and must never be
   activated directly. Record configuration hashes and `nginx -t` pass/fail,
   never the configuration bodies or production paths.

For local tooling tests only, use `--provenance-mode local-dry-run` during both
assemblies and `--validation-mode local-dry-run` during validation. Such output
remains forbidden for release even when both manifests are identical.

Any source SHA mismatch, dirty source, non-deterministic manifest, missing or
expired artifact, extra inventory file, hash mismatch, symlink, forbidden file,
unmatched rollback artifact, unverifiable GitHub provenance, or failed isolated
configuration test stops the release before traffic changes.

## Nginx invariants

The repository carries four candidate fragments and one validator in the
release inventory: the default value-free open template, the value-free bare redirect
template, the opt-in value-free dual-direct template, the existing closed candidate, and
`scripts/ops/validate-release-open-http-contract.mjs`. A repository template is
not a target-rendered configuration. It cannot pass `nginx -t`, must not be
installed, and contains no target hostname, website root, upstream, TLS path,
CSP origin, framing choice, HSTS value, or compression choice. Rendering occurs
only in a separately authorized target record. Every token must be resolved,
the caller-provided non-secret metadata must match, and only then may the
isolated rendered validator and later target gates run.

The exact repository placeholder inventory is:

| Placeholder | Open template | Bare template | Total |
| --- | ---: | ---: | ---: |
| `__OPEN_CANONICAL_HOST__` | 3 | 2 | 5 |
| `__OPEN_BARE_HOST__` | 0 | 2 | 2 |
| `__OPEN_CANDIDATE_WEBSITE_ROOT__` | 1 | 0 | 1 |
| `__OPEN_API_UPSTREAM__` | 2 | 0 | 2 |
| `__OPEN_EXISTING_TLS_DIRECTIVES__` | 1 | 1 | 2 |
| `__OPEN_CSP_POLICY__` | 1 | 0 | 1 |
| `__OPEN_X_FRAME_OPTIONS_DIRECTIVE__` | 1 | 0 | 1 |
| `__OPEN_HSTS_DIRECTIVE__` | 1 | 1 | 2 |
| `__OPEN_COMPRESSION_DIRECTIVES__` | 1 | 0 | 1 |

The opt-in dual-direct template has two canonical and two bare host tokens,
one website root, two API upstreams, and one each of the TLS, CSP, framing,
HSTS, and compression tokens. Its source validator is invoked with
--source . --mode dual-direct. Omitting --mode keeps the canonical contract.
Rendered dual-direct validation uses --mode dual-direct with open, closed,
and expected metadata inputs, without the bare redirect fragment.

An unknown, missing, excess, or unresolved token is a hard failure. A concrete
host, root, upstream, TLS/certificate path, credential, wildcard origin, or
unsafe CSP source in a repository template is also a hard failure. The bundle
contains only the templates and validator, never a rendered configuration, TLS
material, environment file, credential, or production path.

`CLOSED_NGINX_INVARIANT` starts from
`ops/nginx/release-traffic-closed.conf.example` and requires a complete
replacement of every public and alternate ingress for both approved hostnames
on HTTP and HTTPS. Each request
method and path must terminate at 503 with `Cache-Control: no-store` and a
bounded `Retry-After`. There must be no active proxy, static root, SPA fallback,
redirect, application route, or second server that can accept the same names.
The internal loopback health endpoint is outside this public gate.

`OPEN_NGINX_INVARIANT` requires the approved website root from the same
candidate bundle, extensionless BrowserRouter fallback to exact `index.html`,
the exact approved `/api` upstream, existing TLS material, security headers,
and the bare-domain 308 redirect to the canonical origin. The bare fragment is
the sole owner of bare HTTP and HTTPS. The full open template is the sole owner
of canonical HTTP-to-HTTPS redirect and canonical HTTPS application service;
the two fragments may not duplicate host/listener ownership. The open root must
contain no release-closed 503 or `Retry-After`, and it must have no alternate
ingress that bypasses the approved application path. Alternate-ingress absence
is target evidence, never a repository assumption.

OPEN_DUAL_DIRECT_INVARIANT is an explicit alternative for a target already
serving both approved hostnames directly. Its single HTTP server owns exactly
the bare and canonical names and returns 301 to the same host and request URI
on HTTPS. Its single HTTPS server owns exactly those names and serves the same
verified website root and API upstream without a cross-host redirect. The bare
redirect fragment must not be loaded with this mode. All routing, cache, TLS,
security, HSTS, compression, and closed-traffic checks above still apply in the
ordinary dual-direct mode. A separately approved dual-direct
`preserve-existing` render may retain a target with no explicit
`X-Frame-Options` or HSTS declaration in its two site blocks. It never creates
either header. The renderer must replace the existing template placeholders
with `# OPEN_FRAMING_POLICY: preserve-existing` and
`# OPEN_HSTS_OWNER: preserve-existing`, and set all three metadata fields
`framingPolicy`, `hstsOwner`, and `hstsValue` to `preserve-existing`. Canonical
and ordinary dual-direct renders continue to require their original explicit
policies. A target that already declares either protected header cannot use
this opt-in path to accept an invalid value or silently remove it.

The opt-in rendered validator additionally requires `--existing-context` and
`--candidate-context`: complete, separately bound Nginx configuration inputs
before and after substitution. It compares non-target and inherited directives,
target security headers and includes, and TLS references, and checks that the
assembled target is exactly the validated dual-direct open configuration.
The two target blocks must not gain an explicit framing or HSTS header.
Only in dual-direct preserve-existing mode, `cspConnectSources: []` in the
expected metadata records that the preserved CSP has no explicit `connect-src`.
The rendered CSP must also omit that directive, and the complete CSP text must
remain equal across the before and candidate contexts. An empty or malformed
`connect-src` directive is invalid; canonical and ordinary dual-direct modes
still require a nonempty `cspConnectSources` list.
Preserve-existing also permits an unchanged CSP containing only `frame-src`;
missing directives must be represented by empty expected allowlists, and every
present directive must remain unique, nonempty, and free of forbidden sources.
The complete CSP and its declared scope must match before and after. This
preservation does not establish policy adequacy, so the result reports
`securityPolicyAdequacy: UNVERIFIED`. Ordinary modes still require all eleven
CSP directives.
In the same preserve-existing mode, compression and Vary declarations may
remain in their existing inherited scope. The validator compares the complete
before and candidate contexts, including target compression, Vary, and include
placement; a new declaration or changed scope fails validation. It reports
`effectiveInheritedCompressionPolicy: UNVERIFIED` because configuration text
alone cannot establish effective inheritance or the HTTP response. Canonical
and ordinary dual-direct modes retain the explicit HTTPS compression check.
For preserve-existing rendering, remove the two marked blocks in the
dual-direct template for direct MIME mapping/default type and the three new
security headers. Keep the bound target TLS include and existing security
headers exactly as they were. The validator compares target and inherited
MIME directives, includes, and protected headers before and after, and reports
`effectiveInheritedMimePolicy: UNVERIFIED`; configuration text does not prove
the effective MIME mapping or response headers. Ordinary modes retain their
required direct MIME mapping and security headers.
`effectiveInheritedSecurityPolicy: UNVERIFIED` remains in a successful result:
parsing two supplied configurations cannot prove the active include bytes,
Nginx header inheritance, or effective browser responses. The operator must
bind the inputs to the actual target, preserve every other server block and
include, and separately test the isolated complete configuration with
`nginx -t`; this repository result alone is not a security-equivalence or
deployment acceptance proof.
The target proof matrix must show bare HTTP to bare HTTPS, canonical HTTP to
canonical HTTPS, and direct HTTPS application responses on both names. No DNS,
TLS certificate, alternate ingress, or other virtual host is changed by this
repository template.

The approved public recommendation landing is website/dist/referral.html.
The build and release inventory must contain that file and its built script
asset; Nginx's file-like 404 rule serves the actual file without SPA fallback.
The documented target values are REFERRAL_PUBLIC_ORIGIN=https://www.siqiapparel.com
and REFERRAL_PUBLIC_PATH=/referral.html, for local synthetic validation only.
Production configuration is not set by this packet. With
REGISTRATION_ENABLED=false, the landing says “注册暂未开放”; link validity
does not promise registration, attribution, commission, settlement, or
withdrawal. The authenticated /referrals page uses real read-only API state
and keeps cap and financial integrations in their returned unconfigured state.

Exact `/api` and the `^~ /api/` prefix outrank every static and SPA location.
They disable proxy caching and error interception and do not hide upstream
`Content-Type`, `Content-Encoding`, `Vary`, or `Cache-Control`; an API status or
body is never converted into SPA HTML. Existing static files resolve under the
bound candidate root. Missing `/assets` files and missing file-like paths return
404 and never reach `index.html`; only extensionless navigation may use the SPA
fallback. Directory listing and `alias` are forbidden.

Cache ownership is explicit: `index.html` and SPA fallback use fail-safe
revalidation/no-store; only names matching the validator-frozen hashed
`/assets` pattern receive exactly one immutable year; non-hashed assets
revalidate; API cache headers remain upstream-owned. Security headers apply
with `always` without location-level `add_header` inheritance loss. The rendered
canonical HTTPS server must use production MIME mapping plus
`application/octet-stream`, `nosniff`, strict-origin-when-cross-origin referrer
policy, conservative camera/microphone/geolocation/payment/USB denial, and a
complete CSP containing all frozen directives. CSP wildcard origins,
`unsafe-eval`, script `data:`, and unbound monitor/payment origins are forbidden.
The rendered framing marker, X-Frame-Options, and `frame-ancestors` must agree.
HSTS is HTTPS-only and target-bound. Compression has one target-bound owner,
never rewrites upstream content encoding, and owns `Vary: Accept-Encoding`.

The active parsed topology, four host/scheme probes, representative safe
methods, and configuration hash must prove the selected invariant. A listener
alone is not proof.

The future target proof matrix is mandatory and remains `UNVERIFIED` in this
repository task:

| Proof | Required result |
| --- | --- |
| Isolated rendered validator | Open, bare, and closed inputs match all externally bound metadata; no token remains. |
| `nginx -t` | Complete isolated open and closed roots both pass on the bound target runtime. |
| Four host/scheme probes | Bare HTTP, bare HTTPS, canonical HTTP, and canonical HTTPS each reach exactly their owned redirect or application behavior. |
| Canonical deep link | An extensionless client route returns revalidating/no-store `index.html` with security headers. |
| Missing static | Missing `/assets` and representative file-like requests return 404, never SPA HTML. |
| API non-HTML error | Representative safe API failure preserves upstream status, body, MIME, encoding, Vary, and cache headers. |
| Header matrix | HTML, hashed assets, non-hashed assets, API success/error, and static 404 responses satisfy cache, MIME, security, CSP, framing, HSTS, compression, and Vary ownership. |
| Alternate-ingress bypass | Bound owner/inventory plus safe probes prove no second ingress bypasses the selected open or closed root. |

## Read-only execution preflight

Before closing traffic, the authorized operator must prove all of the
following from the bound target:

- the separately frozen candidate exists on the approved integration lineage;
- candidate and rollback bundle hashes and inventories match their records;
- the prebuilt auth dependency layer matches the candidate lockfile and runtime
  ABI without an install during the release switch;
- the current auth/website artifacts and schema boundary match the rollback
  record;
- `schema_migrations` is the continuous prefix 001-016, journal mode and
  integrity checks pass, and the database owner/mode are the approved values;
- the exact application PID, every background writer, alternate ingress, and
  active Nginx topology are discoverable without printing sensitive values;
- the combined auth/website pointer switch is a single atomic switch to one
  versioned consolidated bundle;
- backup destination, capacity, owner, restore procedure, restore deadline,
  operator, rollback owner, and evidence destination are bound;
- the closed and open configurations still pass isolated validation;
- feature inclusion and the normal loopback `/ready` aggregate readiness check
  are frozen.

Unexpected SHA, schema other than 001-016, unknown writer, partial artifact,
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
   `foreign_key_check`, and continuous migrations through 016. Re-run the
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
   QUIESCENT_MONITOR_AUTH_PROJECTION: DISABLED
   BACKGROUND_WRITERS: DISABLED
   MONITOR_AUTH_PRIVATE_ORIGIN: OMITTED_IN_QUIESCENT_MODE
   MONITOR_API_ORIGIN: OMITTED_IN_QUIESCENT_MODE
   ```

   Startup may apply migrations 017, 018, 019, 020, 021, 022, 023, 024 and 025. Validate exact candidate identity, loopback
   health, migration prefix 001-025, database integrity, static website files,
   the manifest inventory, and the still-closed ingress. The loopback
   `GET /health` liveness response is exactly `200 {"status":"ok"}`; do not treat
   it as traffic readiness or send a payment, email, order, registration,
   diagnosis, or other business request.

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

10. While ingress remains closed, validate `GET /health` exact
    `200 {"status":"ok"}` as liveness, schema 001-025, database integrity, and
    auth and website artifact hashes. Then require loopback `GET /ready` to
    return exact `200 {"status":"ready"}` with `Cache-Control: no-store` as the
    normal aggregate readiness proof for the serving phase, database migration
    probe, and every enabled local payment-expiry or mail-dispatch handle.
    Disabled payment or mail is an accepted configured state when its exclusion
    is separately bound. `/ready` performs no live provider probe and neither
    `/ready` nor payment enablement proves quiescent, closed, or open traffic
    mode. Repeat the separately bound closed topology, ingress, and approved
    non-business probes, then record:

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
the pre-017 database.

## Rollback while restore remains eligible

Rollback is a matched database-and-artifact operation:

1. Keep every ingress closed; stop the quiescent candidate and prove its PID is
   absent and all database writers are zero.
2. Reverify the backup mode, hash, size, integrity, foreign keys, and migration
   boundary 001-016. Reprove that no post-snapshot write occurred and the
   restore deadline has not passed.
3. Restore the verified pre-017 snapshot using the separately authorized bound
   command. Never open the old binary on a database containing migration 017, 018, 019, 020, 021, 022, 023 or 024.
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

## Explicit DIRECT14 to 19 route

Historical route for already-built 001-019 bundles only; a current-source
candidate uses the explicit DIRECT14 to 20 route below.
This route is available only when a separate release execution packet selects
`direct14-19` and binds the additional `DIRECT14_*` proofs in the binding
checklist. It does not convert a schema-14 observation into release authority.
The historical `standard16-19` route remains strict and unchanged.
For this route only, every preflight, snapshot, and rollback reference to the
old 001-016 boundary in the default sequence means the verified 001-014
boundary. Its candidate boundary remains 001-019.

Before the window, identify the matching old Auth, website, configuration, and
runtime artifacts from the current running paths, record their identities and
integrity hashes, and prove old Auth accepts continuous migrations 001-014 and
the current database has exactly that prefix. Record an old source SHA only if
independently verifiable; otherwise record `UNKNOWN`, without inventing a Git
linkage. Bind active ingress topology, service manager, and an atomic restore
plan without emitting secrets or private configuration. For this route only,
captured old-unit identity and integrity evidence substitutes for the default
sequence's historical-source-SHA proof; no old artifact or schema proof is
waived.

The direct14 candidate must be the separately retained integration-push
artifact `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`. Validate its
manifest and live GitHub artifact proof with the candidate command above plus
`--schema-route direct14-19`. The manifest must state
`"schemaRoute":"direct14-19"` and `rollback: 14, candidate: 19`.

Recheck the read-only impact counts immediately before closing traffic:
pending registrations that migration 016 would supersede, matching mail outbox
items it would delete, invite audit rows it would redact, and active invite
codes it would revoke. Record counts and the approval for their exact effects,
without row values. A changed count or unapproved effect stops this route.

During the separately approved window, follow the same ordered checkpoints as
the frozen sequence above, with these explicit substitutions only:

1. Close **every** public and alternate ingress, stop the matched old service,
   prove its PID absent, and prove all database writers zero before backup.
2. Create a new owner-only SQLite snapshot and independently verify its hash,
   size, integrity, foreign keys, and continuous migrations 001-014. Using the
   captured exact old Auth, website, configuration, and runtime bytes, perform
   an independent isolated restore test with this snapshot and prove the
   restored old unit accepts Schema 14. Keep live ingress closed and writers
   zero throughout. Do not switch either artifact without the matched hashes,
   isolated restore result, and rollback owner recorded.
3. Atomically switch the consolidated Auth/website pointer to the exact
   direct14 candidate. Start quiescent with payment, mail dispatch,
   registration, background writers, and monitor projection disabled. Startup
   may apply migrations **015, 016, 017, 018, and 019**. Keep ingress closed;
   verify exact candidate identity, schema 001-019, database integrity,
   loopback health, website inventory, and disabled workers without business
   requests.
4. Decide rollback eligibility before normal startup. Restore the verified
   001-014 snapshot and matched old Auth/website/runtime unit only while
   ingress has remained closed, all writers remain zero, no post-snapshot
   business or background write has occurred, and the bound restore deadline
   remains open. Never start the old binary against a database containing any
   migration 015-019.
5. If moving forward, end restore eligibility explicitly before enabling
   workers. Apply the existing normal readiness, closed-ingress acceptance,
   and open-ingress checkpoints unchanged. If a post-snapshot business or
   background write occurred, keep ingress closed and seek a separately
   authorized forward fix; do not restore the snapshot.

No step here authorizes production access, a database write, restore, pointer
switch, traffic change, deployment, or release by itself.

## Explicit DIRECT14 to 20 route

Historical route for already-built 001-020 bundles only; a current-source
candidate uses the explicit DIRECT14 to 21 route below. Counterpart of the historical DIRECT14 to 19 route above, for
candidates whose inventory ends at migration 020. Every requirement, proof,
substitution, and stop line of that route applies unchanged, with the candidate
boundary 001-020 in place of 001-019. The standard counterpart is
`--schema-route standard16-20` (`rollback: 16, candidate: 20`), which keeps the
default sequence's 001-016 rollback meaning.

Validate the retained artifact `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`
with the candidate command above plus `--schema-route direct14-20`. The
manifest must state `"schemaRoute":"direct14-20"` and
`rollback: 14, candidate: 20`, and list exactly migrations 001-020. Quiescent
startup may apply migrations **015 through 020**; verify schema 001-020.

Migration 020 only adds the `tickets` and `ticket_messages` tables and their
indexes. It changes no existing row or column. It still moves the schema
boundary: an Auth binary built for 001-019 refuses to start on a database that
records migration 020 (`database contains unknown migration version 20`). After
020 is applied, a code-only rollback to a 001-019 release is therefore not
available; restore the verified pre-candidate snapshot only under the existing
restore-eligibility rules, or forward-fix. Never start a 001-019 binary against
a database containing migration 020.

No step here authorizes production access, a database write, restore, pointer
switch, traffic change, deployment, or release by itself.

## Explicit STANDARD19 to 20 route

Historical route for already-built 001-020 bundles only; a current-source
candidate uses the explicit STANDARD19 to 21 route below. Formal route for a site whose live database is already the continuous
001-019 prefix. The manifest states `"schemaRoute":"standard19-20"` and
`rollback: 19, candidate: 20`, and lists exactly migrations 001-020; on that
database the existing loader applies only migration 020. The `standard16-20`,
`direct14-20`, and historical 019 routes keep their own meanings and cannot
validate this route's bundle, nor it theirs.

This route is available only when a separate release execution packet selects
it and binds every `STANDARD19_*` proof in the binding checklist. Nothing in
this repository proves any of those site facts.

The candidate must be the separately retained integration-push artifact
`consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>`. Validate its manifest
and live GitHub artifact proof with the candidate command above plus
`--schema-route standard19-20`.

Before any quiescent 020 start, the packet must prove, from the site itself:

1. The live database is the continuous 001-019 prefix, read without writes.
2. The matching old 019 Auth and old website artifacts currently serving the
   site are identified by their running paths, with identities and integrity
   hashes recorded. Their roots may differ (for example a website root outside
   the Auth release bundle); record each root separately and never assume they
   share a bundle.
3. Every public and alternate ingress is closed, the old Auth service is
   stopped with its PID proven absent, and database writers are proven zero.
4. A new owner-only SQLite snapshot of that 001-019 database is verified for
   hash, size, integrity, foreign keys, and continuous migrations 001-019, and
   an isolated restore test proves the matched old 019 Auth unit starts on it.
   Only then is a restorable 019 snapshot established.

Then switch to the exact standard19 candidate and start quiescent with payment,
mail dispatch, registration, background writers, and monitor projection
disabled. Startup may apply only migration **020**; verify schema 001-020,
database integrity, loopback health, and website inventory without business
requests, keeping ingress closed.

Pre-open restore of that 019 snapshot together with the matched old 019 Auth
and website remains unproven until the site checks above are recorded and the
existing restore-eligibility conditions hold (ingress still closed, writers
still zero, no post-snapshot business or background write, restore deadline
open). No step here asserts that eligibility.

After any new business or background write reaches the 020 database, never
overwrite or restore the database, and never start a 001-019 Auth binary on a
database containing migration 020. There is no rollback artifact for a
database at 020, and none may be assumed; the only path is a separately
authorized forward fix.

No step here authorizes production access, a database write, backup, restore,
pointer switch, traffic change, deployment, or release by itself.

## Explicit DIRECT14 to 21 route

Historical route for already-built 001-021 bundles only; a current-source
candidate uses the DIRECT14 to 22 route below. Counterpart of the DIRECT14 to 20 route above, for candidates
whose inventory ends at migration 021. Every requirement, proof, substitution,
and stop line of the DIRECT14 routes applies unchanged, with the candidate
boundary 001-021. The standard counterpart is `--schema-route standard16-21`
(`rollback: 16, candidate: 21`).

Validate the retained artifact `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`
with the candidate command above plus `--schema-route direct14-21`. The
manifest must state `"schemaRoute":"direct14-21"` and
`rollback: 14, candidate: 21`, and list exactly migrations 001-021. Quiescent
startup may apply migrations **015 through 021**; verify schema 001-021 and the
Migration 021 table rebuild proof below.

## Explicit STANDARD19 to 21 route

Historical route for already-built 001-021 bundles only; a current-source
candidate uses the STANDARD19 to 22 route below. Counterpart of the STANDARD19 to 20 route above, for a site whose
live database is the continuous 001-019 prefix. The manifest states
`"schemaRoute":"standard19-21"` and `rollback: 19, candidate: 21`, and lists
exactly migrations 001-021; on that database the existing loader applies
migrations 020 and 021. Validate the retained artifact
`consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>` with the candidate
command above plus `--schema-route standard19-21`. Every `STANDARD19_*` proof,
the pre-open restore rule, and the after-write rule of the STANDARD19 to 20
route apply unchanged, with "020" read as "020 and 021". After any new write,
never overwrite or restore the database and never start a 001-019 or 001-020
Auth binary on a database containing migration 021; there is no rollback
artifact for a database at 021, and none may be assumed.

## Migration 021 table rebuild

Migration 021 (personal invites) rebuilds `users` and `pending_registrations`
to record a real direct inviter. Other tables reference `users` with
`ON DELETE RESTRICT`, which SQLite enforces even for deferred constraints, so
this one migration runs through a dedicated startup path in the migration
runner; every other migration keeps the normal transactional path.

- It runs on the Auth startup connection before the HTTP server listens and
  before any background worker starts; no request is served until it commits.
- `foreign_keys` is switched OFF on that connection only, outside any
  transaction, and the path refuses to start inside a transaction.
- The rebuild drops and recreates each table under the same name (no
  `ALTER TABLE ... RENAME`), copies every row with its original primary key and
  values, recreates the indexes and triggers, and restores the AUTOINCREMENT
  high-water marks.
- Row counts, a full `foreign_key_check`, `integrity_check`, and the
  `schema_migrations` record for 021 commit in ONE exclusive transaction; any
  failure rolls back the rebuild and the ledger together.
- `foreign_keys` is then switched back ON and verified. On failure it is also
  restored, and startup aborts; the service never runs with foreign keys off.

Existing accounts keep their legacy invite origin unchanged. A 001-020 Auth
binary refuses a database that records migration 021
(`database contains unknown migration version 21`), so after 021 applies there
is no code-only rollback; only the verified pre-candidate snapshot under the
existing restore-eligibility rules, or a forward fix.

No step here authorizes production access, a database write, backup, restore,
pointer switch, traffic change, deployment, or release by itself.

## Explicit DIRECT14 to 22 route

Historical route for already-built 001-022 bundles only; a current-source
candidate uses the DIRECT14 to 23 route below. Counterpart of the DIRECT14 to 21 route above, for candidates
whose inventory ends at migration 022. Every requirement, proof, substitution,
and stop line of the DIRECT14 routes applies unchanged, with the candidate
boundary 001-022. The standard counterpart is `--schema-route standard16-22`
(`rollback: 16, candidate: 22`).

Validate the retained artifact `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`
with the candidate command above plus `--schema-route direct14-22`. The
manifest must state `"schemaRoute":"direct14-22"` and
`rollback: 14, candidate: 22`, and list exactly migrations 001-022. Quiescent
startup may apply migrations **015 through 022**; verify schema 001-022, the
Migration 021 table rebuild proof, and the Migration 022 forward-only proof below.

## Explicit STANDARD19 to 22 route

Historical route for already-built 001-022 bundles only; a current-source
candidate uses the STANDARD19 to 23 route below. Counterpart of the STANDARD19 to 21 route above. The manifest
states `"schemaRoute":"standard19-22"` and `rollback: 19, candidate: 22`, and
lists exactly migrations 001-022; the existing loader applies every listed
migration the live database does not yet record (020, 021 and 022 on a
001-019 database; only 022 on a database already at 021). Validate the
retained artifact `consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>`
with the candidate command above plus `--schema-route standard19-22`. Every
`STANDARD19_*` proof, the pre-open restore rule, and the after-write rule apply
unchanged, with the applied migrations read accordingly. After any new write,
never overwrite or restore the database and never start an Auth binary whose
inventory ends before 022 on a database containing migration 022; there is no
rollback artifact for a database at 022, and none may be assumed.

## Migration 022 forward-only additive change

Migration 022 (admin service management) only adds the nullable `services`
columns `ends_at`, `plan_override` and `admin_note`, and creates the
`admin_grants` table with its index. It rewrites no existing row and runs on
the normal transactional path; existing purchases keep NULL in the new columns
(long-term, order snapshot, no note).

It is still forward-only for the Auth binary: an Auth binary whose inventory
ends at 021 refuses a database that records migration 022
(`database contains unknown migration version 22`), so after 022 applies there
is no code-only rollback. Before any post-snapshot write, only the verified
pre-candidate snapshot under the existing restore-eligibility rules may be
restored together with the matched old Auth and website; after any write, only
a separately approved forward fix is eligible.

No step here authorizes production access, a database write, backup, restore,
pointer switch, traffic change, deployment, or release by itself.

## Explicit DIRECT14 to 23 route

Historical route for already-built 001-023 bundles only; a current-source
candidate uses the DIRECT14 to 24 route below. Counterpart of the DIRECT14 to 22 route above, for candidates
whose inventory ends at migration 023. Every requirement, proof, substitution,
and stop line of the DIRECT14 routes applies unchanged, with the candidate
boundary 001-023. The standard counterpart is `--schema-route standard16-23`
(`rollback: 16, candidate: 23`).

Validate the retained artifact `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`
with the candidate command above plus `--schema-route direct14-23`. The
manifest must state `"schemaRoute":"direct14-23"` and
`rollback: 14, candidate: 23`, and list exactly migrations 001-023. Quiescent
startup may apply migrations **015 through 023**; verify schema 001-023, the
Migration 021 table rebuild proof, and the Migration 022 and 023 forward-only proofs.

## Explicit STANDARD19 to 23 route

Historical route for already-built 001-023 bundles only; a current-source
candidate uses the STANDARD19 to 24 route below. Counterpart of the STANDARD19 to 22 route above. The manifest
states `"schemaRoute":"standard19-23"` and `rollback: 19, candidate: 23`, and
lists exactly migrations 001-023; the existing loader applies every listed
migration the live database does not yet record (only 023 on a database
already at 022). Validate the retained artifact
`consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>` with the candidate
command above plus `--schema-route standard19-23`. Every `STANDARD19_*` proof,
the pre-open restore rule, and the after-write rule apply unchanged. After any
new write, never overwrite or restore the database and never start an Auth
binary whose inventory ends before 023 on a database containing migration 023;
there is no rollback artifact for a database at 023, and none may be assumed.

## Migration 023 forward-only grant delivery

Migration 023 (admin grant delivery) adds nullable catalog, months and value
columns to `admin_grants`, a `delivery_status` column that defaults to
`pending_open` for every existing row, and `opened_at`; it creates
`admin_grant_delivery_items` for encrypted gift subscription lines. It rewrites
no existing value and runs on the normal transactional path.

It is forward-only for the Auth binary: an Auth binary whose inventory ends at
022 refuses a database that records migration 023
(`database contains unknown migration version 23`), so after 023 applies there
is no code-only rollback. Before any post-snapshot write, only the verified
pre-candidate snapshot under the existing restore-eligibility rules may be
restored together with the matched old Auth and website; after any write, only
a separately approved forward fix is eligible.

No step here authorizes production access, a database write, backup, restore,
pointer switch, traffic change, deployment, or release by itself.

## Explicit DIRECT14 to 24 route

Current-source counterpart of the DIRECT14 to 23 route above, for candidates
whose inventory ends at migration 024. Every requirement, proof, substitution,
and stop line of the DIRECT14 routes applies unchanged, with the candidate
boundary 001-024. The standard counterpart is `--schema-route standard16-24`
(`rollback: 16, candidate: 24`).

Validate the retained artifact `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`
with the candidate command above plus `--schema-route direct14-24`. The
manifest must state `"schemaRoute":"direct14-24"` and
`rollback: 14, candidate: 24`, and list exactly migrations 001-024. Quiescent
startup may apply migrations **015 through 024**; verify schema 001-024, the
Migration 021 table rebuild proof, and the Migration 022, 023 and 024 forward-only proofs.

## Explicit STANDARD19 to 24 route

Current-source counterpart of the STANDARD19 to 23 route above. The manifest
states `"schemaRoute":"standard19-24"` and `rollback: 19, candidate: 24`, and
lists exactly migrations 001-024; the existing loader applies every listed
migration the live database does not yet record (only 024 on a database
already at 023). Validate the retained artifact
`consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>` with the candidate
command above plus `--schema-route standard19-24`. Every `STANDARD19_*` proof,
the pre-open restore rule, and the after-write rule apply unchanged. After any
new write, never overwrite or restore the database and never start an Auth
binary whose inventory ends before 024 on a database containing migration 024;
there is no rollback artifact for a database at 024, and none may be assumed.

## Migration 024 forward-only gift delivery VPS binding

Migration 024 (gift delivery VPS binding) adds one nullable `monitor_target`
column to `admin_grant_delivery_items`; every existing gift delivery line keeps
all prior values and is unbound (NULL). It rewrites no existing value and runs
on the normal transactional path.

It is forward-only for the Auth binary: an Auth binary whose inventory ends at
023 refuses a database that records migration 024
(`database contains unknown migration version 24`), so after 024 applies there
is no code-only rollback. Before any post-snapshot write, only the verified
pre-candidate snapshot under the existing restore-eligibility rules may be
restored together with the matched old Auth and website; after any write, only
a separately approved forward fix is eligible.

No step here authorizes production access, a database write, backup, restore,
pointer switch, traffic change, deployment, or release by itself.

## Explicit DIRECT14 to 25 route

Current-source counterpart of the DIRECT14 to 24 route above, for candidates
whose inventory ends at migration 025. Every requirement, proof, substitution,
and stop line of the DIRECT14 routes applies unchanged, with the candidate
boundary 001-025. The standard counterpart is `--schema-route standard16-25`
(`rollback: 16, candidate: 25`).

Validate the retained artifact `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`
with the candidate command above plus `--schema-route direct14-25`. The
manifest must state `"schemaRoute":"direct14-25"` and
`rollback: 14, candidate: 25`, and list exactly migrations 001-025. Quiescent
startup may apply migrations **015 through 025**; verify schema 001-025, the
Migration 021 table rebuild proof, and the Migration 022, 023, 024 and 025 forward-only proofs.

## Explicit STANDARD19 to 25 route

Current-source counterpart of the STANDARD19 to 24 route above. The manifest
states `"schemaRoute":"standard19-25"` and `rollback: 19, candidate: 25`, and
lists exactly migrations 001-025; the existing loader applies every listed
migration the live database does not yet record (only 025 on a database
already at 024). Validate the retained artifact
`consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>` with the candidate
command above plus `--schema-route standard19-25`. Every `STANDARD19_*` proof,
the pre-open restore rule, and the after-write rule apply unchanged. After any
new write, never overwrite or restore the database and never start an Auth
binary whose inventory ends before 025 on a database containing migration 025;
there is no rollback artifact for a database at 025, and none may be assumed.

## Migration 025 forward-only ticket attachments and grant link

Migration 025 (ticket attachments and grant link) adds the `ticket_attachments`
table (opaque reference, message foreign key, constrained content type and byte
size, private BLOB content) and one nullable `grant_id` column on `tickets`
with a database check that keeps `service_id` and `grant_id` mutually
exclusive; every existing ticket keeps all prior values and is unlinked (NULL).
It rewrites no existing value and runs on the normal transactional path.

It is forward-only for the Auth binary: an Auth binary whose inventory ends at
024 refuses a database that records migration 025
(`database contains unknown migration version 25`), so after 025 applies there
is no code-only rollback. Before any post-snapshot write, only the verified
pre-candidate snapshot under the existing restore-eligibility rules may be
restored together with the matched old Auth and website; after any write, only
a separately approved forward fix is eligible.

No step here authorizes production access, a database write, backup, restore,
pointer switch, traffic change, deployment, or release by itself.

## Monitor boundary

```text
MONITOR_AUTH_PROJECTION_STATUS: CONDITIONAL_BLOCKER
```

The repository candidate implements the frozen
[`MONITOR-AUTH-PROJECTION-01`](../architecture/MONITOR-AUTH-PROJECTION-01.md)
code and offline acceptance matrix, but this runbook does not mark it accepted,
merged, configured, deployed, or production-ready. The conditional blocker
remains until project-manager acceptance and fresh external proofs bind the
dedicated Auth Service mTLS identity, private HTTPS authority, credential
logical names, ACL, raw source, rollback, and runtime reachability without
recording their values.

The browser must stay on same-origin `GET /api/me/monitor-status`; the public
gateway's `MONITOR_API_ORIGIN` is not an allowed Auth configuration or fallback.
If the projection is not accepted or any binding is absent, its feature gate
remains disabled and the capability stays excluded under a separate product
decision. This runbook cannot infer that decision from repository or CI state.

## Public operator monitor preservation

User decision ruled by the project manager on 2026-09-27 (final acceptance
still pending): the existing monitor
subdomain and the public display of the operator-owned 3002 monitor are kept.
Provider, node, route public IP/ASN, and bandwidth data may be shown without
redaction; account, order, and credential data stay private. `/monitor` and
`/status` render the same public 3002 embed for every visitor, including
signed-in users. This does not accept, configure, or enable the account Monitor
Auth Projection above; that blocker and the account status UI remain deferred.

The current production state was hand-applied outside this release procedure
and is recorded in
[`public-monitor-live-state-20260927.md`](public-monitor-live-state-20260927.md).
A release that renders or replaces the website-host Nginx root or website build
must preserve it, or stop:

1. The website build binds `VITE_MONITOR_URL` to the ruled public monitor
   origin; without it `/monitor`, `/status`, and the customer sidebar card fall
   back to the unconfigured display.
2. The monitor-subdomain HTTP server serves only the ACME webroot challenge path
   and redirects everything else to HTTPS; a blanket 503 blocks certificate
   renewal.
3. The monitor-subdomain HTTPS server reverse-proxies the operator monitor over
   the private tailnet with GET/HEAD only, an explicit deployed allowlist of
   `/`, `/master.css`, `/app.js`, and only the read-only `/api/*` routes the
   embedded monitor page requires, 404 for every other path, upstream framing
   headers hidden, and `frame-ancestors` limited to the canonical and bare
   website origins. A route handled by the upstream monitor service is not
   thereby approved for public exposure; only the explicit allowlist is.
4. The monitor API edge cache (`proxy_cache_path` zone, 20-second validity,
   stale-while-background-update, cache lock, browser-side upstream `no-store`)
   stays in place; without it cold monitor API requests return in 5-30 seconds.
5. The internal rewrite of `?view=mini` and its two versioned static assets to
   the host copy of `monitoring/dashboard-next/static` stays in place until the
   operator monitor build and `monitoring/dashboard-next` are reconciled.

Post-release proof, recorded without values: `/monitor` and `/status` load the
embed with live data; the mini view reports LIVE; a representative monitor API
response carries `X-Monitor-Cache`; a disallowed path returns 404 and POST
returns 405; the ACME challenge path is reachable over HTTP; the website build
contains no private or loopback address.

Recovery if the preserved state is lost or wrong: restore the website-host
Nginx configuration from the pre-change backup recorded on the host, run
`nginx -t`, then reload; point the website root back to the last verified build
directory. A bundle that lacks the ruled `VITE_MONITOR_URL` fails the website
monitor origin gate below and is not released. Rolling back the monitor-host database indexes requires
separate approval and verification and is not performed by this section. Host-side
backup locations and step-by-step commands live only in the host notes, not in
this repository.

## Website monitor origin gate

The retained integration-push candidate builds its website with the ruled
public monitor origin, injected from the repository secret
`NSP_PUBLIC_MONITOR_ORIGIN` so the value stays masked in CI logs. On an
integration push, `scripts/ops/verify-website-monitor-origin.mjs` runs with
policy `required`: CI fails closed before building when the secret is missing
or is not a bare `https` origin with a DNS hostname, and again after building
when `website/dist` does not embed it. Pull-request and test bundles use policy
`optional`, may lack the origin, and remain test-only. No step prints the
origin; the script reports only `configured`, `embedded`, or `absent`.

Before a window, prove the downloaded candidate embeds the approved origin from
a clean checkout of the candidate SHA, taking the value from the external
release record and never echoing it:

```text
VITE_MONITOR_URL=<APPROVED_PUBLIC_MONITOR_ORIGIN> \
  node scripts/ops/verify-website-monitor-origin.mjs \
  --phase embedded --policy required \
  --dist <NEW_EXTRACTED_BUNDLE_DIRECTORY>/website/dist
```

A candidate that fails this check is not eligible for release. Do not rebuild
or substitute its website locally; fix the input and let the integration push
produce a new retained artifact.

## Isolated rehearsal guard

Any rehearsal that starts an Auth binary outside the live service (restore
proofs, migration rehearsals, quiescent start trials) must start it through
`scripts/ops/isolated-rehearsal-start.mjs`, taken from a clean checkout of the
candidate SHA, as the rehearsal process itself. The guard evaluates the
environment after the service manager has resolved every `Environment=` and
`EnvironmentFile=` source, and refuses to start the server unless the resolved
`DB_PATH` is an existing regular file inside the rehearsal root that is not the
protected live database by path or inode, and the resolved `PORT` is not the
live port:

```text
node scripts/ops/isolated-rehearsal-start.mjs \
  --protected-db <LIVE_DATABASE_FILE> \
  --protected-port <LIVE_AUTH_PORT> \
  --rehearsal-root <NEW_REHEARSAL_DIRECTORY> \
  --server <REHEARSAL_AUTH_SERVICE>/dist/src/server.js
```

Never pass rehearsal overrides as `-E`/`Environment=` next to a site
`EnvironmentFile=`: an environment file takes precedence and can silently point
the rehearsal at the live database. Build a dedicated rehearsal environment
file instead. The rehearsal root must not contain the live database directory.
The guard covers only rehearsal starts; it does not change the live service
unit or its configuration.

Known residual limits:

- The guard is procedural. It protects only a rehearsal whose process
  entrypoint is the guard itself; an Auth binary started any other way is not
  checked. Operators must use it as the rehearsal entrypoint every time.
- It identifies the live database by resolved path and by device plus inode.
  It cannot recognise the same live file re-exposed under a different device
  (for example through a bind or cross-filesystem mount that reports another
  device), so the rehearsal root must be a fresh directory on the same
  filesystem view as the live database path, never a mount of it.

## Stop lines

Stop the affected step, preserve the last proven closed state, and record only
redacted evidence when any of these occurs:

- SHA, manifest, migration boundary, artifact, binding, worker, or Nginx drift;
- an unresolved writer, surviving PID, failed stop, or writable database handle;
- a candidate website that fails the monitor origin gate, or a rehearsal Auth
  start not made through the isolated rehearsal guard;
- snapshot, hash, ownership, integrity, foreign-key, or restore-deadline failure;
- independent auth/website switching that could expose a mixed release;
- quiescent payment/mail/registration unexpectedly enabled;
- normal aggregate loopback `/ready` proof not independently proven;
- an open or closed ingress invariant fails on any path;
- rollback artifacts do not match the pre-017 database;
- database restore is proposed after eligibility ended;
- monitor-linked fulfillment is requested without the accepted private mTLS
  projection;
- a step needs a secret in Git/logs, an inferred production value, a new
  dependency, a public contract change, real payment, merge, deployment, or
  production authority that has not been separately granted.

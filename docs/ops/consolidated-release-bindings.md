# Consolidated release binding checklist

## Repository boundary

```text
BINDING_VALUES_IN_REPOSITORY: FORBIDDEN
MONITOR_AUTH_PROJECTION_STATUS: CONDITIONAL_BLOCKER
```

This file defines binding names and proof requirements only. Actual hostnames,
addresses, absolute paths, unit names, usernames, groups, certificates,
credentials, environment values, commands, windows, and operator identities
belong in the separately authorized external release record. Never paste their
values into this file, a pull request, CI output, or task transcript.

A binding is complete only when a named owner validates it against the exact
target during the approved window and records a redacted pass/fail result. A
previous release record or dashboard observation is not current proof.

## Authority and candidate identity

| Binding name | Required proof |
| --- | --- |
| `RELEASE_AUTHORIZATION` | Approved scope, operator, window, rollback owner, restore deadline, and evidence destination. |
| `RELEASE_CANDIDATE_SHA_PROOF` | Full post-hardening integration SHA exists on the approved remote lineage and equals both bundle manifest and staged candidate. |
| `CANDIDATE_GITHUB_WORKFLOW_RUN` | Live GitHub metadata proves a successful `.github/workflows/ci.yml` push run on `integration/consolidate-project`; run ID, attempt, head SHA, and manifest provenance all match. |
| `CANDIDATE_GITHUB_ARTIFACT_ID` | Exact retained artifact ID belongs to that workflow run and has the name `consolidated-release-<RELEASE_CANDIDATE_SHA>`; PR, task-branch, and local results are ineligible. |
| `CANDIDATE_GITHUB_ARTIFACT_DIGEST` | GitHub-reported `sha256:` digest matches the downloaded artifact archive; its manifest bytes, complete file set, source SHA, and inventory hashes match the extracted candidate. |
| `CURRENT_RELEASE_SHA_PROOF` | Current auth and website artifacts resolve to the recorded rollback source before any switch. |
| `REPOSITORY_CLEAN_BUILD_PROOF` | Candidate bundle was built by the exact successful integration-push CI run with Node/runtime and lockfile hashes recorded; local ignored build output is not proof. |

## Candidate and rollback artifacts

| Binding name | Required proof |
| --- | --- |
| `CANDIDATE_BUNDLE_MANIFEST_SHA256` | Two independent assemblies have identical manifests; the retained manifest hash and inventory validate. |
| `CANDIDATE_AUTH_BUNDLE_SHA256` | Compiled auth entrypoint, runtime files, package manifests, and migrations 001-014 match inventory. |
| `CANDIDATE_WEBSITE_BUNDLE_SHA256` | Website `dist` and entrypoint match the same candidate inventory. |
| `AUTH_RUNTIME_DEPENDENCY_PROOF` | Prebuilt dependency layer matches the candidate lockfile, Node version, OS/architecture/libc, and native-module ABI; it is ready before the window and is not stored in the bundle. |
| `ROLLBACK_AUTH_BUNDLE_SHA256` | Old auth artifact hash matches the old source SHA and accepts the rollback schema boundary. |
| `ROLLBACK_WEBSITE_BUNDLE_SHA256` | Old website artifact hash belongs to the same rollback release as old auth. |
| `ROLLBACK_SOURCE_SCHEMA_PROOF` | Old auth and the verified database snapshot are compatible with continuous migrations 001-013. |
| `CONSOLIDATED_RELEASE_ATOMIC_POINTER` | One versioned release root contains auth and website; one atomic pointer selects them together. |
| `AUTH_ATOMIC_POINTER_SWITCH` | Auth resolves through the consolidated pointer and cannot independently select a mixed release. |
| `WEBSITE_ATOMIC_POINTER_SWITCH` | Website resolves through the same consolidated pointer and cannot independently select a mixed release. |

## Application and database

| Binding name | Required proof |
| --- | --- |
| `AUTH_SERVICE_MANAGER` | Exact manager/unit, runtime, working directory, execution identity, stop timeout, and restart policy are known without logging values. |
| `OLD_APPLICATION_PID_ABSENT_PROOF` | After stop, manager state is inactive and the recorded main PID plus children no longer exist. |
| `DATABASE_WRITER_ZERO_PROOF` | After PID absence, a fail-closed inventory proves no request, payment, mail, maintenance, or writable-descriptor process can write the database. |
| `DATABASE_SCHEMA_AND_INTEGRITY_PROOF` | Journal mode, quick check, foreign keys, owner/mode, capacity, and continuous applied prefix are observed read-only. |
| `SQLITE_BACKUP_DESTINATION` | New non-existing destination, capacity, owner, retention, restore command, and cleanup owner are approved. |
| `SQLITE_BACKUP_SHA256_PROOF` | Snapshot mode 0600, bytes, SHA-256, quick check, foreign keys, and boundary 001-013 independently verify. |
| `POST_SNAPSHOT_WRITE_PROOF` | Closed-ingress continuity and writer observations prove whether any post-snapshot write occurred. |
| `DATABASE_RESTORE_DEADLINE` | Owner can determine before normal worker startup whether restore eligibility remains open. |

## Runtime modes and workers

| Binding name | Required proof |
| --- | --- |
| `QUIESCENT_FEATURE_FLAG_PROOF` | Candidate starts with payment, mail dispatch, and registration disabled and monitor origin absent; values are checked without printing them. |
| `QUIESCENT_HEALTH_PROOF` | Exact candidate, loopback health, schema 001-014, database integrity, static website, manifest, and closed ingress pass without business requests. |
| `NORMAL_FEATURE_FLAG_PROOF` | Included/excluded registration, payment, mail, public monitor, and monitor-linked fulfillment capabilities have separate acceptance. |
| `NORMAL_WORKER_READINESS_PROOF` | Payment expiry and mail dispatch each have an approved readiness check beyond generic health; external side effects remain within release authority. |
| `HEALTH_OBSERVATION_PROOF` | Exact loopback URL/body, candidate PID, observation interval, and failure threshold are frozen. |
| `CREDENTIAL_INJECTION_PROOF` | Credential source, ownership, readability, rotation owner, and non-logging behavior are validated without recording values. |

## Website and Nginx

| Binding name | Required proof |
| --- | --- |
| `CANDIDATE_WEBSITE_ROOT_PROOF` | Active static root resolves into the candidate bundle and its inventory hash matches. |
| `ROLLBACK_WEBSITE_ROOT_PROOF` | Rollback static root resolves into the matched rollback bundle. |
| `CLOSED_NGINX_CONFIG_PROOF` | Complete isolated root passes syntax validation and contains only the full 503 topology for every approved and alternate ingress. |
| `OPEN_NGINX_CONFIG_PROOF` | Complete isolated root passes syntax validation and binds candidate website, SPA fallback, exact API upstream, TLS, headers, and bare-domain redirect. |
| `ALTERNATE_INGRESS_CLOSURE_PROOF` | Inventory and safe probes show no load balancer, second server, port, hostname, or proxy bypasses the closed root. |
| `NGINX_ATOMIC_SWITCH_AND_ROLLBACK` | Closed/open roots are installed atomically with a pre-tested rollback command and exact active-root proof. |
| `CLOSED_TRAFFIC_PROBE_PROOF` | Bare/www and every approved alternate ingress return only the expected 503 for safe representative methods. |
| `OPEN_TRAFFIC_PROBE_PROOF` | Canonical site, bare redirect, API proxy, SPA fallback, headers, and absence of closed/bypass servers pass. |

## Conditional monitor projection

| Binding name | Required proof |
| --- | --- |
| `MONITOR_AUTH_PROJECTION_ACCEPTANCE` | If included, a separately accepted contract proves Auth Service private HTTPS route, dedicated mTLS identity, ACL, projections, failure mapping, and tests. |
| `MONITOR_ORIGIN_OMISSION_PROOF` | If that contract is not accepted, quiescent and normal release records prove no plain monitor origin is used as a bypass. |
| `MONITOR_CAPABILITY_EXCLUSION` | Product acceptance explicitly excludes admin target selection and monitor-linked fulfillment when projection acceptance is absent. |

## Completion rule

All applicable binding names must have fresh redacted proof before the affected
release step. `UNBOUND`, `UNKNOWN`, stale evidence, inferred values, mismatched
hashes, or a request to disclose a secret is a stop condition. Repository
validation proves this checklist exists; it does not prove any production
binding is complete.

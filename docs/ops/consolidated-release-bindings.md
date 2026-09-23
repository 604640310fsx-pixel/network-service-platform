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
| `CANDIDATE_AUTH_BUNDLE_SHA256` | Compiled auth entrypoint, runtime files, package manifests, and migrations 001-019 match inventory. |
| `CANDIDATE_WEBSITE_BUNDLE_SHA256` | Website `dist` and entrypoint match the same candidate inventory. |
| `AUTH_RUNTIME_DEPENDENCY_PROOF` | Prebuilt dependency layer matches the candidate lockfile, Node version, OS/architecture/libc, and native-module ABI; it is ready before the window and is not stored in the bundle. |
| `ROLLBACK_AUTH_BUNDLE_SHA256` | Old auth artifact hash matches the old source SHA and accepts the rollback schema boundary. |
| `ROLLBACK_WEBSITE_BUNDLE_SHA256` | Old website artifact hash belongs to the same rollback release as old auth. |
| `ROLLBACK_SOURCE_SCHEMA_PROOF` | Old auth and the verified database snapshot are compatible with continuous migrations 001-016. |
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
| `SQLITE_BACKUP_SHA256_PROOF` | Snapshot mode 0600, bytes, SHA-256, quick check, foreign keys, and boundary 001-016 independently verify. |
| `POST_SNAPSHOT_WRITE_PROOF` | Closed-ingress continuity and writer observations prove whether any post-snapshot write occurred. |
| `DATABASE_RESTORE_DEADLINE` | Owner can determine before normal worker startup whether restore eligibility remains open. |

### Additional bindings for the explicit DIRECT14 to 19 route

These proofs are required only when a separately authorized execution packet
selects `direct14-19`. They do not replace or weaken the default 001-016
route's proofs above. For this route, the captured old-unit identity and
integrity proof below replaces only the historical-source-SHA requirement in
the generic rollback artifact rows; artifact hashes, matched Auth/website
identity, schema compatibility, and restore proof remain mandatory.

| Binding name | Required proof |
| --- | --- |
| `DIRECT14_ROUTE_AUTHORIZATION` | Approved execution packet explicitly selects `direct14-19`, its operator, window, rollback owner, restore deadline, and evidence destination. |
| `DIRECT14_CANDIDATE_ARTIFACT_PROOF` | Exact successful integration-push SHA, live workflow run, retained artifact ID/name `consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>`, GitHub digest, archive bytes, and manifest `schemaRoute` plus boundary 14→19 all agree. |
| `DIRECT14_OLD_RELEASE_UNIT_PROOF` | Capture the matching old Auth, website, configuration, and runtime artifacts from the current running paths; record their identities and integrity hashes, service manager and ingress ownership, and old Auth compatibility with continuous migrations 001-014. Record the old source SHA only if independently verifiable; otherwise record `UNKNOWN` without inference. The captured bytes must form one restorable unit with the Schema 14 snapshot and pass an independent isolated restore test before pointer switch. |
| `DIRECT14_SCHEMA_AND_IMPACT_PROOF` | Current database has exactly continuous migrations 001-014; fresh read-only counts of pending registration supersession, matching outbox deletion, invite audit redaction, and active invite revocation are approved for the migration 016 effect. |
| `DIRECT14_SQLITE_SNAPSHOT_PROOF` | After closed ingress and zero writers, a new owner-only snapshot independently verifies mode, bytes, SHA-256, quick check, foreign keys, and continuous boundary 001-014; restore procedure and old release compatibility are proven. |
| `DIRECT14_RESTORE_ELIGIBILITY_PROOF` | Closed-ingress continuity, zero writers, no post-snapshot business or background write, valid snapshot, and restore deadline are all proven before restoring old Auth, website, runtime bindings, and database together. Otherwise only a separately approved forward fix is eligible. |

## Runtime modes and workers

| Binding name | Required proof |
| --- | --- |
| `QUIESCENT_FEATURE_FLAG_PROOF` | Candidate starts with payment, mail dispatch, and registration disabled and monitor origin absent; values are checked without printing them. |
| `QUIESCENT_HEALTH_PROOF` | Exact candidate, loopback health, schema 001-019, database integrity, static website, manifest, and closed ingress pass without business requests; loopback health is the exact `GET /health` liveness response `200 {"status":"ok"}` and is not traffic readiness. |
| `NORMAL_FEATURE_FLAG_PROOF` | Included/excluded registration, payment, mail, public monitor, and monitor-linked fulfillment capabilities have separate acceptance. |
| `NORMAL_WORKER_READINESS_PROOF` | Loopback `GET /ready` is the normal aggregate readiness proof: exact `200 {"status":"ready"}` with `Cache-Control: no-store` proves the serving lifecycle phase, the schema 001-019 database probe, and every enabled local payment-expiry or mail-dispatch handle. It performs no provider reachability probe. |
| `HEALTH_OBSERVATION_PROOF` | Exact loopback `GET /health` URL/body, candidate PID, observation interval, and failure threshold are frozen as liveness evidence. |
| `CREDENTIAL_INJECTION_PROOF` | Credential source, ownership, readability, rotation owner, and non-logging behavior are validated without recording values. |

Disabled payment or mail is an accepted configured readiness state; it does not
authorize enabling either capability. Neither `/ready` nor payment enablement
proves quiescent, closed, or open traffic mode. Release configuration, active
Nginx topology, and external binding evidence own that proof.

## Runtime configuration key-name inventory

This inventory records names and classifications only. Values, credential
bodies, source locations, and production bindings are forbidden here and remain
only in the separately authorized external release record and credential source.
The currently accepted release baseline remains 62 unique tuples with fingerprint
`bfc8fecc287438a3958f01cb6f7933697e59a8af713435a4f3f936cfcd464705`.
That fingerprint is derived from lexicographically sorted UTF-8 LF tuples plus
the final LF; every tuple contains only key, phase, exposure, requiredness, and
relevance--never a value.

The repository candidate now freezes five additional conditional Monitor Auth
Projection names below. They are not silently folded into the accepted 62-tuple
release fingerprint. Including the capability requires project-manager
acceptance plus a separately frozen expanded name/classification inventory and
fingerprint in the external release record. This prevents repository code from
claiming a production binding.

### Required Auth runtime environment keys

| Key name | Classification |
| --- | --- |
| `CREDENTIALS_DIRECTORY` | Required in normal runtime. |
| `DB_PATH` | Required in normal runtime. |
| `HOST` | Required in normal runtime. |
| `MAIL_DISPATCH_ENABLED` | Required in normal runtime. |
| `NODE_ENV` | Required in normal runtime. |
| `PAYMENT_ENABLED` | Required in normal runtime. |
| `PORT` | Required in normal runtime. |
| `REGISTRATION_ENABLED` | Required in normal runtime. |

### Conditional payment and mail environment keys

| Key name | Classification |
| --- | --- |
| `ALIPAY_APP_ID` | Conditional payment runtime key. |
| `ALIPAY_ENVIRONMENT` | Conditional payment runtime key. |
| `ALIPAY_NOTIFY_URL` | Conditional payment runtime key. |
| `ALIPAY_PRIVATE_KEY_FILE` | Conditional payment runtime key. |
| `ALIPAY_PRIVATE_KEY_TYPE` | Conditional payment runtime key. |
| `ALIPAY_PUBLIC_KEY_FILE` | Conditional payment runtime key. |
| `ALIPAY_RETURN_URL` | Conditional payment runtime key. |
| `ALIPAY_SELLER_ID` | Conditional payment runtime key. |
| `MAIL_DISPATCH_INTERVAL_MS` | Conditional mail runtime key. |
| `MAIL_DISPATCH_LEASE_MS` | Conditional mail runtime key. |
| `MAIL_DISPATCH_MAX_ATTEMPTS` | Conditional mail runtime key. |
| `MAIL_DISPATCH_RETRY_DELAYS_MS` | Conditional mail runtime key. |
| `RESEND_FROM_EMAIL` | Conditional mail runtime key. |
| `RESEND_REQUEST_TIMEOUT_MS` | Conditional mail runtime key. |

### Conditional Monitor Auth Projection environment keys

| Key name | Classification |
| --- | --- |
| `MONITOR_AUTH_PROJECTION_ENABLED` | Conditional Auth runtime feature gate; required and exactly `true` only when the separately accepted projection is enabled. |
| `MONITOR_AUTH_PRIVATE_ORIGIN` | Conditional server-only private HTTPS authority; required only when the accepted projection is enabled. |

The public gateway's legacy `MONITOR_API_ORIGIN` is not an Auth configuration
key and is excluded from the consolidated Auth/website release. It must be
omitted in quiescent mode and must never be introduced as an Auth projection
bypass. Until acceptance and all external bindings exist, the projection feature
gate remains disabled and the private Auth origin remains absent.

### Credential logical filenames

| Logical name | Classification |
| --- | --- |
| `csrf_signing_key` | Required credential logical name. |
| `invite_hmac_keyring` | Required credential logical name. |
| `mail_payload_enc_keyring` | Required credential logical name. |
| `rate_limit_key` | Required credential logical name. |
| `token_hmac_keyring` | Required credential logical name. |
| `delivery_payload_enc_keyring` | Conditional credential logical name. |
| `resend_api_key` | Conditional credential logical name. |
| `monitor_private_ca_certificate` | Conditional Monitor Auth private CA logical name. |
| `monitor_auth_service_client_certificate` | Conditional dedicated Auth Service client certificate logical name. |
| `monitor_auth_service_client_private_key` | Conditional dedicated Auth Service client private-key logical name. |

### Public website build key

`VITE_MONITOR_URL` is a website-build, browser-exposed, public, optional, and
conditional key. It has no literal default. A missing or malformed key preserves
the current unconfigured fail-closed display. It is distinct from
`MONITOR_API_ORIGIN`; active website/README guidance may be referenced without
changing either classification.

Proof is valid only when the exact key set and classifications match the
accepted inventory: required members are explicitly supplied and verified;
conditional groups exist only for separately approved enabled features; and
credential-source ownership, readability, and non-logging are proven without
outputting values. Server-only secrets must not appear in any `VITE_` or browser
output. CI, tooling, and test keys are not production runtime bindings. An
unknown, stale, missing, or extra key, or any value disclosure, stops the
release.

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
| `OPEN_CANONICAL_HOST` | Exact canonical host is bound externally and matches the rendered canonical HTTP and HTTPS ownership. |
| `OPEN_BARE_HOST` | Exact bare host is bound externally and matches the rendered bare HTTP and HTTPS redirect ownership. |
| `OPEN_CANDIDATE_WEBSITE_ROOT` | Exact candidate website root is bound externally and resolves to the verified website inventory. |
| `OPEN_API_UPSTREAM` | Exact `/api` upstream is bound externally; scheme, address, port, and any path semantics are approved as one value. |
| `OPEN_TLS_BINDING` | Existing TLS directive ownership for both HTTPS servers is identified and verified without recording certificate paths or material. |
| `OPEN_CSP_CONNECT_ALLOWLIST` | Complete approved `connect-src` sources are bound explicitly; monitor and payment origins are never inferred. |
| `OPEN_CSP_FRAME_ALLOWLIST` | Complete approved `frame-src` sources are bound explicitly and remain distinct from the embedding policy. |
| `OPEN_FRAMING_POLICY` | Approved embedding policy, `frame-ancestors`, and X-Frame-Options directive are mutually consistent. |
| `OPEN_HSTS_OWNER_AND_VALUE` | HTTPS-only HSTS owner and exact policy value are bound and validated after rendering. |
| `OPEN_COMPRESSION_OWNER` | Exactly one compression owner, its target-bound module/algorithm, and its `Vary: Accept-Encoding` duty are recorded. |
| `ALTERNATE_INGRESS_OWNER_INVENTORY` | Target-side owner inventory covers every alternate load balancer, listener, hostname, port, proxy, and redirect; repository absence is not proof. |
| `RENDERED_OPEN_CONFIG_SHA256` | Hash of the isolated, fully rendered open root that passed rendered-contract validation and `nginx -t`. |
| `RENDERED_CLOSED_CONFIG_SHA256` | Hash of the isolated closed root that passed the authoritative closed validator and `nginx -t`. |

## Conditional monitor projection

| Binding name | Required proof |
| --- | --- |
| `MONITOR_AUTH_PROJECTION_ACCEPTANCE` | If included, a separately accepted contract proves Auth Service private HTTPS route, dedicated mTLS identity, ACL, projections, failure mapping, and tests. |
| `MONITOR_AUTH_CONFIGURATION_PROOF` | Enabled flag, private HTTPS authority, three credential logical names, source ownership, readability, TLS >=1.2, server-chain/hostname verification, and non-logging are validated without recording values. |
| `MONITOR_AUTH_IDENTITY_ACL_PROOF` | Fresh certificate fingerprints prove `public_bff` only reads `/api/public-summary`, `auth_service` only reads the two Auth routes, and operator/unknown read neither; rotation and revocation are exercised. |
| `MONITOR_AUTH_RAW_BINDING_PROOF` | The authorized target proves the gateway's fixed raw catalog/status routes, 5-second timeout, body bounds, no redirects, and target-query redaction without exposing the origin or target. |
| `MONITOR_ORIGIN_OMISSION_PROOF` | If that contract is not accepted, quiescent and normal release records prove no plain monitor origin is used as a bypass. |
| `MONITOR_CAPABILITY_EXCLUSION` | Product acceptance explicitly excludes admin target selection and monitor-linked fulfillment when projection acceptance is absent. |

## Completion rule

All applicable binding names must have fresh redacted proof before the affected
release step. `UNBOUND`, `UNKNOWN`, stale evidence, inferred values, mismatched
hashes, or a request to disclose a secret is a stop condition. Repository
validation proves this checklist exists; it does not prove any production
binding is complete.

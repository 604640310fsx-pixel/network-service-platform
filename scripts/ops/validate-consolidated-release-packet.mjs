#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReleaseProvenance,
  releaseArtifactNameForRoute,
  DEFAULT_RELEASE_SCHEMA_ROUTE,
  isForbiddenBundlePath,
  isKnownReleaseSchemaRoute,
  releaseManifestCarriesSchemaRoute,
  releaseMigrationsForRoute,
  RELEASE_SCHEMA_ROUTE_ARGUMENT_MESSAGE,
  RELEASE_BUNDLE_FORMAT,
  RELEASE_INTEGRATION_REF,
  RELEASE_HTTP_CONTRACT_PATHS,
  RELEASE_MIGRATIONS,
  RELEASE_REPOSITORY,
  RELEASE_SCHEMA_BOUNDARIES,
  RELEASE_WORKFLOW_JOB,
} from "./assemble-consolidated-release.mjs";
import { validateTemplateRoot } from "./validate-release-open-http-contract.mjs";

const REQUIRED_BUNDLE_PATHS = Object.freeze([
  "auth-service/dist/src/db.js",
  "auth-service/dist/src/server.js",
  "auth-service/package-lock.json",
  "auth-service/package.json",
  "website/dist/index.html",
  "website/dist/referral.html",
  "website/package-lock.json",
  "website/package.json",
  ...RELEASE_HTTP_CONTRACT_PATHS,
]);

const REQUIRED_OPEN_VALIDATOR_FRAGMENTS = Object.freeze([
  "OPEN_HTTP_PLACEHOLDERS",
  "validateTemplateSources",
  "validateRenderedSources",
  "UNRESOLVED_PLACEHOLDER",
  "OPEN_CLOSED_CONFLICT",
]);

const RELEASE_SEQUENCE = Object.freeze([
  "FULL_INGRESS: CLOSED",
  "OLD_APPLICATION: STOPPED",
  "OLD_APPLICATION_PID: ABSENT",
  "APPLICATION_DB_WRITERS: ZERO",
  "SQLITE_SNAPSHOT: VERIFIED",
  "AUTH_WEBSITE_POINTERS: SWITCHED_ATOMICALLY",
  "QUIESCENT_PAYMENT: DISABLED",
  "QUIESCENT_MAIL: DISABLED",
  "ROLLBACK_ELIGIBILITY: DECIDED",
  "NORMAL_CANDIDATE: STARTED",
  "CLOSED_TRAFFIC_ACCEPTANCE: PASS",
  "FULL_INGRESS: OPEN",
]);

const REQUIRED_RUNBOOK_FRAGMENTS = Object.freeze([
  "IMPLEMENTATION_BASE_SHA: 7b79139133fe912088bfe3ae9e1321bb8bc379de",
  "IMPLEMENTATION_BASE_IS_RELEASE_CANDIDATE: NO",
  "PRE_RELEASE_SCHEMA_BOUNDARY: 16",
  "CANDIDATE_SCHEMA_BOUNDARY: 17",
  "BACKGROUND_WRITERS: DISABLED",
  "ROLLBACK_ARTIFACT_COMPATIBILITY: MATCHED",
  "DATABASE_RESTORE_ELIGIBILITY: ENDED",
  "CLOSED_NGINX_INVARIANT",
  "OPEN_NGINX_INVARIANT",
  "MONITOR_AUTH_PROJECTION_STATUS: CONDITIONAL_BLOCKER",
  "QUIESCENT_MONITOR_AUTH_PROJECTION: DISABLED",
  "MONITOR_AUTH_PRIVATE_ORIGIN: OMITTED_IN_QUIESCENT_MODE",
  "MONITOR_API_ORIGIN: OMITTED_IN_QUIESCENT_MODE",
  "LOCAL_BUNDLE_RELEASE_USE: FORBIDDEN",
  "GITHUB_ARTIFACT_PROVENANCE: REQUIRED",
  "__OPEN_CANONICAL_HOST__",
  "Exact `/api` and the `^~ /api/` prefix",
  "The future target proof matrix is mandatory",
  "--hostname github.com",
]);

const REQUIRED_BINDING_NAMES = Object.freeze([
  "RELEASE_CANDIDATE_SHA_PROOF",
  "CANDIDATE_AUTH_BUNDLE_SHA256",
  "CANDIDATE_WEBSITE_BUNDLE_SHA256",
  "CANDIDATE_GITHUB_ARTIFACT_ID",
  "CANDIDATE_GITHUB_ARTIFACT_DIGEST",
  "CANDIDATE_GITHUB_WORKFLOW_RUN",
  "AUTH_RUNTIME_DEPENDENCY_PROOF",
  "ROLLBACK_AUTH_BUNDLE_SHA256",
  "ROLLBACK_WEBSITE_BUNDLE_SHA256",
  "ROLLBACK_SOURCE_SCHEMA_PROOF",
  "AUTH_ATOMIC_POINTER_SWITCH",
  "WEBSITE_ATOMIC_POINTER_SWITCH",
  "OLD_APPLICATION_PID_ABSENT_PROOF",
  "DATABASE_WRITER_ZERO_PROOF",
  "SQLITE_BACKUP_DESTINATION",
  "SQLITE_BACKUP_SHA256_PROOF",
  "QUIESCENT_FEATURE_FLAG_PROOF",
  "NORMAL_WORKER_READINESS_PROOF",
  "CLOSED_NGINX_CONFIG_PROOF",
  "OPEN_NGINX_CONFIG_PROOF",
  "ALTERNATE_INGRESS_CLOSURE_PROOF",
  "MONITOR_AUTH_PROJECTION_ACCEPTANCE",
  "MONITOR_AUTH_CONFIGURATION_PROOF",
  "MONITOR_AUTH_IDENTITY_ACL_PROOF",
  "MONITOR_AUTH_RAW_BINDING_PROOF",
  "OPEN_CANONICAL_HOST",
  "OPEN_BARE_HOST",
  "OPEN_CANDIDATE_WEBSITE_ROOT",
  "OPEN_API_UPSTREAM",
  "OPEN_TLS_BINDING",
  "OPEN_CSP_CONNECT_ALLOWLIST",
  "OPEN_CSP_FRAME_ALLOWLIST",
  "OPEN_FRAMING_POLICY",
  "OPEN_HSTS_OWNER_AND_VALUE",
  "OPEN_COMPRESSION_OWNER",
  "ALTERNATE_INGRESS_OWNER_INVENTORY",
  "RENDERED_OPEN_CONFIG_SHA256",
  "RENDERED_CLOSED_CONFIG_SHA256",
]);

export class ReleaseValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseValidationError";
    this.code = code;
  }
}

function parseOptions(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      throw new ReleaseValidationError(
        "ARGUMENT_ERROR",
        "options must be --name value pairs",
      );
    }
    if (options.has(name)) {
      throw new ReleaseValidationError(
        "ARGUMENT_ERROR",
        `${name} may be provided only once`,
      );
    }
    options.set(name, value);
  }
  return options;
}

function requireOption(options, name) {
  const value = options.get(name);
  if (value === undefined || value.trim() === "") {
    throw new ReleaseValidationError("ARGUMENT_ERROR", `${name} is required`);
  }
  return value;
}

function normalizedExpectedSha(value) {
  const sha = value.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new ReleaseValidationError(
      "ARGUMENT_ERROR",
      "--expected-sha must be a full hexadecimal Git object ID",
    );
  }
  return sha;
}

function existingDirectory(input, label) {
  let path;
  try {
    path = realpathSync(resolve(input));
    if (!statSync(path).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new ReleaseValidationError(
      "ARGUMENT_ERROR",
      `${label} must be an existing directory`,
    );
  }
  return path;
}

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ReleaseValidationError(
      "ARTIFACT_MISSING",
      `${label} could not be read`,
    );
  }
}

function runGit(source, arguments_) {
  const result = spawnSync("git", ["-C", source, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new ReleaseValidationError(
      "SOURCE_INVALID",
      "source Git metadata could not be verified",
    );
  }
  return result.stdout.trim();
}

function assertSourceRevision(source, expectedSha) {
  const topLevel = realpathSync(runGit(source, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== source) {
    throw new ReleaseValidationError(
      "SOURCE_INVALID",
      "--source must be the repository root",
    );
  }
  const actualSha = runGit(source, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]).toLowerCase();
  if (actualSha !== expectedSha) {
    throw new ReleaseValidationError(
      "SHA_MISMATCH",
      "source HEAD does not match --expected-sha",
    );
  }
  if (
    runGit(source, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
  ) {
    throw new ReleaseValidationError(
      "SOURCE_DIRTY",
      "source repository contains uncommitted files",
    );
  }
}

function assertExactMigrationFiles(directory, label, migrations = RELEASE_MIGRATIONS) {
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new ReleaseValidationError(
      "ARTIFACT_MISSING",
      `${label} migrations could not be read`,
    );
  }
  if (
    files.length !== migrations.length ||
    files.some((file, index) => file !== migrations[index])
  ) {
    throw new ReleaseValidationError(
      "SCHEMA_BOUNDARY_MISMATCH",
      `${label} migrations must be the exact frozen 001-${String(migrations.length).padStart(3, "0")} sequence`,
    );
  }
}

function assertFragments(source, fragments, label) {
  for (const fragment of fragments) {
    if (!source.includes(fragment)) {
      throw new ReleaseValidationError(
        "PACKET_INCOMPLETE",
        `${label} is missing required invariant ${fragment}`,
      );
    }
  }
}

function assertNoFragments(source, fragments, label) {
  for (const fragment of fragments) {
    if (source.includes(fragment)) {
      throw new ReleaseValidationError(
        "PACKET_INCOMPLETE",
        `${label} contains forbidden fragment ${fragment}`,
      );
    }
  }
}

const MONITOR_AUTH_SOURCE_PATHS = Object.freeze({
  architecture: "docs/architecture/MONITOR-AUTH-PROJECTION-01.md",
  authConfig: "auth-service/src/config.ts",
  authRoute: "auth-service/src/http/monitor-routes.ts",
  authRateLimit: "auth-service/src/http/rate-limit.ts",
  accountProjection: "auth-service/src/monitor/account-projection.ts",
  authPrivateClient: "auth-service/src/monitor/private-client.ts",
  authServer: "auth-service/src/server.ts",
  customerPaymentRoute: "auth-service/src/http/payment-routes.ts",
  gatewayClient: "monitoring/gateway/client.py",
  gatewayProjection: "monitoring/gateway/auth_projection.py",
  gatewayServer: "monitoring/gateway/server.py",
  dashboardServer: "monitoring/dashboard-next/server.py",
  websiteClient: "website/app/lib/monitor-status-api.ts",
  websitePage: "website/app/components/status/BuyerServerStatusPage.tsx",
  websiteStatusLink: "website/app/lib/buyerStatusLink.ts",
  websitePaymentApi: "website/app/lib/payment-api.ts",
});

export function validateMonitorAuthProjectionSources(sourceRoot, overrides = {}) {
  const read = (name) => {
    const relativePath = MONITOR_AUTH_SOURCE_PATHS[name];
    if (Object.hasOwn(overrides, relativePath)) {
      const value = overrides[relativePath];
      if (typeof value !== "string") {
        throw new ReleaseValidationError(
          "PACKET_INCOMPLETE",
          `monitor Auth override is invalid for ${relativePath}`,
        );
      }
      return value;
    }
    return readText(join(sourceRoot, relativePath), `monitor Auth ${name}`);
  };

  const architecture = read("architecture");
  assertFragments(
    architecture,
    [
      "DECISION_TYPE: FROZEN_FINAL2",
      "GET /api/me/monitor-status",
      "services.payment_id = payments.id",
      "payments.order_id = orders.id",
      "MONITOR_AUTH_PROJECTION_ENABLED",
      "MONITOR_AUTH_PRIVATE_ORIGIN",
      "monitor_private_ca_certificate",
      "monitor_auth_service_client_certificate",
      "monitor_auth_service_client_private_key",
      "monitor:status:user",
      "1440x900",
      "390x844",
    ],
    "monitor Auth architecture",
  );

  const accountProjection = read("accountProjection");
  assertFragments(
    accountProjection,
    [
      "JOIN payments ON payments.id = services.payment_id",
      "JOIN orders ON orders.id = payments.order_id",
      "WHERE orders.user_id = ?",
      "AND orders.status = 'paid'",
      "AND payments.status = 'paid'",
      "AND services.status = 'open'",
      "ORDER BY services.id DESC, service_delivery_items.position ASC",
    ],
    "monitor Auth account selector",
  );
  assertNoFragments(
    accountProjection,
    ["services.order_id"],
    "monitor Auth account selector",
  );

  const authConfig = read("authConfig");
  assertFragments(
    authConfig,
    [
      "MONITOR_AUTH_PROJECTION_ENABLED",
      "MONITOR_AUTH_PRIVATE_ORIGIN",
      '"monitor_private_ca_certificate"',
      '"monitor_auth_service_client_certificate"',
      '"monitor_auth_service_client_private_key"',
    ],
    "monitor Auth configuration",
  );
  assertNoFragments(authConfig, ["MONITOR_API_ORIGIN"], "monitor Auth configuration");

  assertFragments(
    read("authRoute"),
    [
      'url: "/api/me/monitor-status"',
      "consumeMonitorStatusRateLimit",
      '"no_eligible_service"',
      'errorResponse("monitor_unbound")',
      'errorResponse("monitor_unconfigured")',
      "MONITOR_BROWSER_RESPONSE_MAX_BYTES = 4 * 1024",
      "MONITOR_AUTH_TOTAL_TIMEOUT_MS",
    ],
    "monitor Auth HTTP route",
  );
  assertFragments(
    read("authRateLimit"),
    ["MONITOR_STATUS_USER_LIMIT = 120", '"monitor:status:user"'],
    "monitor Auth rate limit",
  );
  const privateClient = read("authPrivateClient");
  assertFragments(
    privateClient,
    [
      "MONITOR_PRIVATE_STATUS_MAX_BYTES = 8 * 1024",
      "MONITOR_PRIVATE_CATALOG_MAX_BYTES = 64 * 1024",
      "MONITOR_AUTH_TOTAL_TIMEOUT_MS = 6_000",
      '"/api/auth-service/targets"',
      "`/api/auth-service/status?target=${encodeURIComponent(normalizedTarget)}`",
      'minVersion: "TLSv1.2"',
      "rejectUnauthorized: true",
      'response.cacheControl.trim().toLowerCase() !== "no-store"',
    ],
    "monitor Auth private client",
  );
  assertNoFragments(
    `${privateClient}\n${read("authServer")}`,
    ["MONITOR_API_ORIGIN"],
    "monitor Auth private path",
  );

  const gatewayClient = read("gatewayClient");
  assertFragments(
    gatewayClient,
    [
      "RAW_STATUS_MAX_BYTES = 64 * 1024",
      "RAW_CATALOG_MAX_BYTES = 256 * 1024",
      "DEFAULT_TIMEOUT_SECONDS = 5.0",
      '"/api/vps-targets"',
      'f"/api/vps-status?target={quote(target, safe=\'\')}"',
    ],
    "monitor Auth gateway raw client",
  );
  const gatewayServer = read("gatewayServer");
  assertFragments(
    gatewayServer,
    [
      'AUTH_TARGETS_PATH = "/api/auth-service/targets"',
      'AUTH_STATUS_PATH = "/api/auth-service/status"',
      "identity == PUBLIC_BFF_IDENTITY",
      "identity == AUTH_SERVICE_IDENTITY",
      'cache_control="no-store"',
      'AUTH_SERVICE_IDENTITY: "AUTH_SERVICE_IDENTITY_CERT_FILE"',
    ],
    "monitor Auth gateway ACL",
  );
  assertFragments(
    read("gatewayProjection"),
    [
      'TARGET_KEY_MAX_LENGTH = 128',
      'TARGET_LABEL_MAX_LENGTH = 200',
      '"status": status, "updatedAt": updated_at, "stale": False',
      'return {"status": "stale", "updatedAt": updated_at, "stale": True}',
    ],
    "monitor Auth gateway projection",
  );
  assertFragments(
    read("dashboardServer"),
    [
      'parsed.path == "/api/vps-targets"',
      'parsed.path == "/api/vps-status"',
      "target = parse_vps_target_query(raw_query)",
      "def log_message(self, _fmt, *_args):",
    ],
    "monitor Auth raw dashboard",
  );

  const websiteClient = read("websiteClient");
  assertFragments(
    websiteClient,
    [
      "MONITOR_STATUS_RESPONSE_MAX_BYTES = 4 * 1024",
      "MONITOR_STATUS_TIMEOUT_MS = 7_000",
      'fetchImpl("/api/me/monitor-status"',
      'credentials: "same-origin"',
      'cache: "no-store"',
      'redirect: "manual"',
    ],
    "monitor Auth website client",
  );
  assertNoFragments(
    websiteClient,
    ["VITE_MONITOR_URL", "MONITOR_API_ORIGIN", "?target=", "?vps="],
    "monitor Auth website client",
  );
  assertFragments(
    read("websitePage"),
    ["getMonitorStatus(controller.signal)", "controller.abort()", "手动重试"],
    "monitor Auth website page",
  );
  assertNoFragments(
    read("websiteStatusLink"),
    ["?vps=", "monitorTargetKey"],
    "monitor Auth website status link",
  );
  assertNoFragments(
    read("customerPaymentRoute"),
    ["monitorTargetKey", "monitor_target_key"],
    "customer payment route",
  );
  assertFragments(
    read("websitePaymentApi"),
    [
      'hasExactKeys(item, ["position", "label", "subscriptionUrl"])',
      'hasExactKeys(item, ["orderRef", "position", "label"])',
    ],
    "customer website payment parser",
  );

  return Object.freeze({ status: "ok" });
}

function assertOrderedFragments(source, fragments, label) {
  let previous = -1;
  for (const fragment of fragments) {
    const current = source.indexOf(fragment);
    if (current <= previous) {
      throw new ReleaseValidationError(
        "PACKET_INCOMPLETE",
        `${label} does not preserve the frozen release order at ${fragment}`,
      );
    }
    previous = current;
  }
}

function runTrafficGateValidation(source) {
  const result = spawnSync(
    process.execPath,
    [join(source, "scripts/ops/validate-release-traffic-gate.mjs")],
    {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new ReleaseValidationError(
      "NGINX_INVARIANT_FAILED",
      "closed Nginx candidate validation failed",
    );
  }
}

// The repository gate follows the selected schema route: the default (and any
// 020 route) requires the exact current 001-020 source, while an explicit
// historical 019 route requires an exact 001-019 source and its own markers.
export function validateRepository({
  source,
  expectedSha,
  schemaRoute = DEFAULT_RELEASE_SCHEMA_ROUTE,
}) {
  if (!isKnownReleaseSchemaRoute(schemaRoute)) {
    throw new ReleaseValidationError(
      "ARGUMENT_ERROR",
      RELEASE_SCHEMA_ROUTE_ARGUMENT_MESSAGE,
    );
  }
  const routeMigrations = releaseMigrationsForRoute(schemaRoute);
  const candidate = RELEASE_SCHEMA_BOUNDARIES[schemaRoute].candidate;
  // 020, 021 and 022 sources all carry the 020-generation markers; later ones add their own.
  const currentSchema = candidate >= 20;
  const sourceRoot = existingDirectory(source, "source");
  const sha = normalizedExpectedSha(expectedSha);
  assertSourceRevision(sourceRoot, sha);
  assertExactMigrationFiles(
    join(sourceRoot, "auth-service/src/migrations"),
    "repository",
    routeMigrations,
  );

  const databaseSource = readText(
    join(sourceRoot, "auth-service/src/db.ts"),
    "migration runner",
  );
  assertFragments(databaseSource, routeMigrations, "migration runner");
  assertFragments(
    databaseSource,
    ["continuous prefix starting at version 1"],
    "migration runner",
  );

  const serverSource = readText(
    join(sourceRoot, "auth-service/src/server.ts"),
    "auth server",
  );
  assertFragments(
    serverSource,
    [
      'process.on("SIGTERM", requestSignalShutdown)',
      'process.on("SIGINT", requestSignalShutdown)',
      'app.addHook("onClose"',
      "payment.enabled ? startOrderExpirySweep(payment) : null",
      "mailConfig.enabled && mailTransport !== null",
    ],
    "auth server",
  );

  validateMonitorAuthProjectionSources(sourceRoot);

  const runbook = readText(
    join(sourceRoot, "docs/ops/consolidated-release-runbook.md"),
    "consolidated runbook",
  );
  assertFragments(runbook, REQUIRED_RUNBOOK_FRAGMENTS, "consolidated runbook");
  assertFragments(
    runbook,
    [
      "## Explicit DIRECT14 to 19 route",
      "--schema-route direct14-19",
      ...(currentSchema
        ? [
            "## Explicit DIRECT14 to 20 route",
            "--schema-route direct14-20",
            "--schema-route standard16-20",
            "## Explicit STANDARD19 to 20 route",
            "--schema-route standard19-20",
            "consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>",
          ]
        : []),
      ...(candidate === 21
        ? [
            "## Explicit DIRECT14 to 21 route",
            "--schema-route direct14-21",
            "--schema-route standard16-21",
            "## Explicit STANDARD19 to 21 route",
            "--schema-route standard19-21",
          ]
        : []),
      // 022 sources still carry migration 021, so its rebuild section stays required.
      ...(candidate >= 21 ? ["## Migration 021 table rebuild"] : []),
      ...(candidate === 22
        ? [
            "## Explicit DIRECT14 to 22 route",
            "--schema-route direct14-22",
            "--schema-route standard16-22",
            "## Explicit STANDARD19 to 22 route",
            "--schema-route standard19-22",
          ]
        : []),
      // Later sources still carry migration 022, so its section stays required.
      ...(candidate >= 22 ? ["## Migration 022 forward-only additive change"] : []),
      ...(candidate === 23
        ? [
            "## Explicit DIRECT14 to 23 route",
            "--schema-route direct14-23",
            "--schema-route standard16-23",
            "## Explicit STANDARD19 to 23 route",
            "--schema-route standard19-23",
          ]
        : []),
      // Later sources still carry migration 023, so its section stays required.
      ...(candidate >= 23 ? ["## Migration 023 forward-only grant delivery"] : []),
      ...(candidate === 24
        ? [
            "## Explicit DIRECT14 to 24 route",
            "--schema-route direct14-24",
            "--schema-route standard16-24",
            "## Explicit STANDARD19 to 24 route",
            "--schema-route standard19-24",
          ]
        : []),
      // Later sources still carry migration 024, so its section stays required.
      ...(candidate >= 24 ? ["## Migration 024 forward-only gift delivery VPS binding"] : []),
      ...(candidate === 25
        ? [
            "## Explicit DIRECT14 to 25 route",
            "--schema-route direct14-25",
            "--schema-route standard16-25",
            "## Explicit STANDARD19 to 25 route",
            "--schema-route standard19-25",
            "## Migration 025 forward-only ticket attachments and grant link",
          ]
        : []),
      "consolidated-release-direct14-<RELEASE_CANDIDATE_SHA>",
      "continuous migrations 001-014",
    ],
    "consolidated runbook",
  );
  assertOrderedFragments(runbook, RELEASE_SEQUENCE, "consolidated runbook");

  const bindings = readText(
    join(sourceRoot, "docs/ops/consolidated-release-bindings.md"),
    "release bindings",
  );
  assertFragments(bindings, REQUIRED_BINDING_NAMES, "release bindings");
  assertFragments(
    bindings,
    [
      "BINDING_VALUES_IN_REPOSITORY: FORBIDDEN",
      "MONITOR_AUTH_PROJECTION_STATUS: CONDITIONAL_BLOCKER",
      "Snapshot mode 0600, bytes, SHA-256, quick check, foreign keys, and boundary 001-016 independently verify.",
      "DIRECT14_CANDIDATE_ARTIFACT_PROOF",
      "DIRECT14_OLD_RELEASE_UNIT_PROOF",
      "DIRECT14_SCHEMA_AND_IMPACT_PROOF",
      "DIRECT14_SQLITE_SNAPSHOT_PROOF",
      "DIRECT14_RESTORE_ELIGIBILITY_PROOF",
      ...(currentSchema
        ? [
            "STANDARD19_ROUTE_AUTHORIZATION",
            "STANDARD19_CANDIDATE_ARTIFACT_PROOF",
            "STANDARD19_OLD_RELEASE_UNIT_PROOF",
            "STANDARD19_SCHEMA_PROOF",
            "STANDARD19_SQLITE_SNAPSHOT_PROOF",
            "STANDARD19_PRE_OPEN_RESTORE_PROOF",
          ]
        : []),
      ...(candidate >= 21 ? ["MIGRATION_021_REBUILD_PROOF"] : []),
      ...(candidate >= 22 ? ["MIGRATION_022_FORWARD_ONLY_PROOF"] : []),
      ...(candidate >= 23 ? ["MIGRATION_023_FORWARD_ONLY_PROOF"] : []),
      ...(candidate >= 24 ? ["MIGRATION_024_FORWARD_ONLY_PROOF"] : []),
      ...(candidate === 25 ? ["MIGRATION_025_FORWARD_ONLY_PROOF"] : []),
    ],
    "release bindings",
  );

  const superseded = readText(
    join(sourceRoot, "docs/ops/diagnosis-intake-release-runbook.md"),
    "superseded diagnosis runbook",
  );
  assertFragments(
    superseded,
    ["SUPERSEDED", "consolidated-release-runbook.md"],
    "superseded diagnosis runbook",
  );
  if (/Migration 13|systemctl|<APP_UNIT>/.test(superseded)) {
    throw new ReleaseValidationError(
      "PACKET_INCOMPLETE",
      "superseded diagnosis runbook must contain only the replacement pointer",
    );
  }

  const workflow = readText(
    join(sourceRoot, ".github/workflows/ci.yml"),
    "CI workflow",
  );
  assertFragments(
    workflow,
    [
      "validate-consolidated-release-packet.mjs",
      "validate-release-open-http-contract.mjs",
      "assemble-consolidated-release.mjs",
      "python3 -m unittest discover -s monitoring/gateway/tests -v",
      "python3 -m unittest discover -s monitoring/dashboard-next/tests -v",
      "node --test monitoring/gateway/tests/static-app.test.cjs",
      "npm --prefix auth-service test",
      "node auth-service/dist/test/db.test.js",
      "node auth-service/dist/test/diagnosis/migration.test.js",
      "npm --prefix website test",
      "npm --prefix website run check",
      "npm --prefix website run build",
      "VITE_MONITOR_URL: ${{ secrets.NSP_PUBLIC_MONITOR_ORIGIN }}",
      "MONITOR_ORIGIN_POLICY: ${{ github.event_name == 'push' && github.ref == 'refs/heads/integration/consolidate-project' && 'required' || 'optional' }}",
      '--phase configured --policy "$MONITOR_ORIGIN_POLICY"',
      '--phase embedded --policy "$MONITOR_ORIGIN_POLICY" --dist website/dist',
      'PROVENANCE_MODE: ${{ github.event_name == \'push\' && github.ref == \'refs/heads/integration/consolidate-project\' && \'github-actions\' || \'github-actions-test\' }}',
      '--provenance-mode "$PROVENANCE_MODE"',
      '--validation-mode "$VALIDATION_MODE"',
      "actions/upload-artifact@v4",
      "consolidated-release-${{ env.EXPECTED_SHA }}",
      "consolidated-release-direct14-${{ env.EXPECTED_SHA }}",
      ...(candidate === 25
        ? [
            "--schema-route direct14-25",
            "--schema-route standard16-25",
            "--schema-route standard19-25",
            "consolidated-release-standard19-${{ env.EXPECTED_SHA }}",
          ]
        : candidate === 24
        ? [
            "--schema-route direct14-24",
            "--schema-route standard16-24",
            "--schema-route standard19-24",
            "consolidated-release-standard19-${{ env.EXPECTED_SHA }}",
          ]
        : candidate === 23
        ? [
            "--schema-route direct14-23",
            "--schema-route standard16-23",
            "--schema-route standard19-23",
            "consolidated-release-standard19-${{ env.EXPECTED_SHA }}",
          ]
        : candidate === 22
        ? [
            "--schema-route direct14-22",
            "--schema-route standard16-22",
            "--schema-route standard19-22",
            "consolidated-release-standard19-${{ env.EXPECTED_SHA }}",
          ]
        : candidate === 21
        ? [
            "--schema-route direct14-21",
            "--schema-route standard16-21",
            "--schema-route standard19-21",
            "consolidated-release-standard19-${{ env.EXPECTED_SHA }}",
          ]
        : candidate === 20
          ? [
              "--schema-route direct14-20",
              "--schema-route standard16-20",
              "--schema-route standard19-20",
              "consolidated-release-standard19-${{ env.EXPECTED_SHA }}",
            ]
          : ["--schema-route direct14-19"]),
      "github.sha == env.EXPECTED_SHA",
      'test "$GITHUB_SHA" = "$EXPECTED_SHA"',
      "artifact-digest",
    ],
    "CI workflow",
  );

  const openValidator = readText(
    join(sourceRoot, "scripts/ops/validate-release-open-http-contract.mjs"),
    "open HTTP contract validator",
  );
  assertFragments(
    openValidator,
    REQUIRED_OPEN_VALIDATOR_FRAGMENTS,
    "open HTTP contract validator",
  );

  runTrafficGateValidation(sourceRoot);
  validateTemplateRoot(sourceRoot);
  validateTemplateRoot(sourceRoot, "dual-direct");
  return Object.freeze({ status: "ok", sourceSha: sha, bundleValidated: false });
}

function normalizedRelativePath(path) {
  return path.split(sep).join("/");
}

function collectBundleFiles(root, relativeRoot = "") {
  const absolute = join(root, relativeRoot);
  const state = lstatSync(absolute);
  if (state.isSymbolicLink()) {
    throw new ReleaseValidationError(
      "BUNDLE_INTEGRITY_FAILED",
      "release bundle must not contain symbolic links",
    );
  }
  if (state.isFile()) {
    return [normalizedRelativePath(relativeRoot)];
  }
  if (!state.isDirectory()) {
    throw new ReleaseValidationError(
      "BUNDLE_INTEGRITY_FAILED",
      "release bundle contains a non-regular filesystem entry",
    );
  }
  const files = [];
  for (const entry of readdirSync(absolute).sort()) {
    files.push(...collectBundleFiles(root, join(relativeRoot, entry)));
  }
  return files;
}

function sha256(path) {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parsedManifest(bundleRoot) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(bundleRoot, "release-manifest.json"), "utf8"),
    );
  } catch {
    throw new ReleaseValidationError(
      "BUNDLE_INTEGRITY_FAILED",
      "release manifest is missing or invalid",
    );
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new ReleaseValidationError(
      "BUNDLE_INTEGRITY_FAILED",
      "release manifest must be an object",
    );
  }
  return manifest;
}

function validateProvenance({
  provenance,
  expectedSha,
  validationMode,
  schemaRoute,
  environment,
}) {
  const isObject =
    typeof provenance === "object" &&
    provenance !== null &&
    !Array.isArray(provenance);
  if (!isObject) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "release manifest is missing build provenance",
    );
  }

  const localShape =
    Object.keys(provenance).sort().join(",") === "kind,releaseUse" &&
    provenance.kind === "local-dry-run" &&
    provenance.releaseUse === "forbidden";
  const githubTestShape =
    Object.keys(provenance).sort().join(",") ===
      "eventName,githubSha,job,kind,ref,releaseUse,repository,runAttempt,runId,workflowRef" &&
    provenance.kind === "github-actions-test" &&
    provenance.releaseUse === "forbidden" &&
    provenance.repository === RELEASE_REPOSITORY &&
    provenance.job === RELEASE_WORKFLOW_JOB &&
    typeof provenance.eventName === "string" &&
    typeof provenance.ref === "string" &&
    typeof provenance.githubSha === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(provenance.githubSha) &&
    typeof provenance.runId === "string" &&
    /^[1-9][0-9]*$/.test(provenance.runId) &&
    typeof provenance.runAttempt === "string" &&
    /^[1-9][0-9]*$/.test(provenance.runAttempt) &&
    typeof provenance.workflowRef === "string" &&
    provenance.workflowRef.startsWith(
      `${RELEASE_REPOSITORY}/.github/workflows/ci.yml@`,
    );
  const githubShape =
    Object.keys(provenance).sort().join(",") ===
      "artifactName,eventName,githubSha,job,kind,ref,releaseUse,repository,runAttempt,runId,workflowRef" &&
    provenance.kind === "github-actions" &&
    provenance.releaseUse === "requires-github-artifact-verification" &&
    provenance.repository === RELEASE_REPOSITORY &&
    provenance.job === RELEASE_WORKFLOW_JOB &&
    provenance.eventName === "push" &&
    provenance.ref === RELEASE_INTEGRATION_REF &&
    provenance.githubSha === expectedSha &&
    provenance.artifactName === releaseArtifactNameForRoute(expectedSha, schemaRoute) &&
    typeof provenance.runId === "string" &&
    /^[1-9][0-9]*$/.test(provenance.runId) &&
    typeof provenance.runAttempt === "string" &&
    /^[1-9][0-9]*$/.test(provenance.runAttempt) &&
    typeof provenance.workflowRef === "string" &&
    provenance.workflowRef.startsWith(
      `${RELEASE_REPOSITORY}/.github/workflows/ci.yml@`,
    );

  if (validationMode === "local-dry-run") {
    if (!localShape) {
      throw new ReleaseValidationError(
        "PROVENANCE_REQUIRED",
        "local dry-run validation requires forbidden-for-release provenance",
      );
    }
    return provenance;
  }
  if (validationMode === "ci-test") {
    if (!githubTestShape) {
      throw new ReleaseValidationError(
        "PROVENANCE_REQUIRED",
        "CI test validation requires forbidden-for-release Actions provenance",
      );
    }
    let expectedProvenance;
    try {
      expectedProvenance = createReleaseProvenance({
        mode: "github-actions-test",
        expectedSha,
        schemaRoute,
        environment,
      });
    } catch {
      throw new ReleaseValidationError(
        "PROVENANCE_REQUIRED",
        "CI test provenance could not be verified from the job environment",
      );
    }
    for (const [name, value] of Object.entries(expectedProvenance)) {
      if (provenance[name] !== value) {
        throw new ReleaseValidationError(
          "PROVENANCE_REQUIRED",
          `CI test provenance mismatch at ${name}`,
        );
      }
    }
    return provenance;
  }
  if (validationMode !== "ci-build" && validationMode !== "candidate") {
    throw new ReleaseValidationError(
      "ARGUMENT_ERROR",
      "--validation-mode must be local-dry-run, ci-test, ci-build, or candidate",
    );
  }
  if (!githubShape) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "release candidates require GitHub Actions build provenance",
    );
  }
  if (validationMode === "ci-build") {
    let expectedProvenance;
    try {
      expectedProvenance = createReleaseProvenance({
        mode: "github-actions",
        expectedSha,
        schemaRoute,
        environment,
      });
    } catch {
      throw new ReleaseValidationError(
        "PROVENANCE_REQUIRED",
        "CI build provenance could not be verified from the job environment",
      );
    }
    for (const [name, value] of Object.entries(expectedProvenance)) {
      if (provenance[name] !== value) {
        throw new ReleaseValidationError(
          "PROVENANCE_REQUIRED",
          `CI build provenance mismatch at ${name}`,
        );
      }
    }
  }
  return provenance;
}

function requiredArtifactId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "candidate validation requires a numeric GitHub artifact ID",
    );
  }
  return value;
}

function existingArtifactArchive(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "candidate validation requires the downloaded artifact archive",
    );
  }
  let path;
  try {
    path = realpathSync(resolve(input));
    if (!statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error("not a regular file");
    }
  } catch {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "downloaded artifact archive must be an existing regular file",
    );
  }
  return path;
}

function githubApiJson(endpoint) {
  const result = spawnSync(
    "gh",
    ["api", "--hostname", "github.com", endpoint],
    {
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "live GitHub artifact provenance could not be retrieved",
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "live GitHub artifact provenance was not valid JSON",
    );
  }
}

function archiveEntries(archive) {
  const result = spawnSync("unzip", ["-Z1", archive], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "downloaded artifact archive could not be inspected",
    );
  }
  const entries = result.stdout
    .split(/\r?\n/)
    .filter((entry) => entry !== "" && !entry.endsWith("/"));
  const unique = new Set(entries);
  if (
    entries.length === 0 ||
    unique.size !== entries.length ||
    entries.some((entry) => {
      const parts = entry.split("/");
      return (
        entry.startsWith("/") ||
        entry.includes("\\") ||
        parts.some((part) => part === "" || part === "." || part === "..")
      );
    })
  ) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "downloaded artifact archive contains unsafe or duplicate entries",
    );
  }
  return entries.sort();
}

function archiveFile(archive, path) {
  const result = spawnSync("unzip", ["-p", archive, path], {
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      `downloaded artifact entry could not be read: ${path}`,
    );
  }
  return result.stdout;
}

function validateGithubArtifactProof({
  artifactId,
  artifactArchive,
  expectedSha,
  expectedFiles,
  inventory,
  bundleRoot,
  provenance,
}) {
  const id = requiredArtifactId(artifactId);
  const archive = existingArtifactArchive(artifactArchive);
  const artifact = githubApiJson(
    `repos/${RELEASE_REPOSITORY}/actions/artifacts/${id}`,
  );
  const workflowRun = githubApiJson(
    `repos/${RELEASE_REPOSITORY}/actions/runs/${provenance.runId}`,
  );
  const expectedDigest = `sha256:${sha256(archive)}`;
  if (
    String(artifact?.id) !== id ||
    artifact?.name !== provenance.artifactName ||
    artifact?.expired !== false ||
    artifact?.digest !== expectedDigest ||
    String(artifact?.workflow_run?.id) !== provenance.runId ||
    artifact?.workflow_run?.head_sha !== expectedSha ||
    String(workflowRun?.id) !== provenance.runId ||
    workflowRun?.repository?.full_name !== RELEASE_REPOSITORY ||
    workflowRun?.path !== ".github/workflows/ci.yml" ||
    workflowRun?.event !== "push" ||
    workflowRun?.head_branch !==
      RELEASE_INTEGRATION_REF.slice("refs/heads/".length) ||
    workflowRun?.head_sha !== expectedSha ||
    workflowRun?.status !== "completed" ||
    workflowRun?.conclusion !== "success" ||
    String(workflowRun?.run_attempt) !== provenance.runAttempt
  ) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "live GitHub artifact or workflow metadata does not match the candidate",
    );
  }

  const archivedFiles = archiveEntries(archive);
  if (
    archivedFiles.length !== expectedFiles.length ||
    archivedFiles.some((path, index) => path !== expectedFiles[index]) ||
    !archiveFile(archive, "release-manifest.json").equals(
      readFileSync(join(bundleRoot, "release-manifest.json")),
    )
  ) {
    throw new ReleaseValidationError(
      "PROVENANCE_REQUIRED",
      "downloaded artifact archive does not match the validated bundle",
    );
  }
  for (const entry of inventory) {
    const bytes = archiveFile(archive, entry.path);
    if (bytes.length !== entry.bytes || sha256Bytes(bytes) !== entry.sha256) {
      throw new ReleaseValidationError(
        "PROVENANCE_REQUIRED",
        `downloaded artifact payload failed verification: ${entry.path}`,
      );
    }
  }

  return Object.freeze({
    artifactId: id,
    artifactDigest: expectedDigest,
    workflowRunId: provenance.runId,
  });
}

export function validateBundle({
  bundle,
  expectedSha,
  validationMode,
  schemaRoute = DEFAULT_RELEASE_SCHEMA_ROUTE,
  githubArtifactId,
  artifactArchive,
  environment = process.env,
}) {
  if (!isKnownReleaseSchemaRoute(schemaRoute)) {
    throw new ReleaseValidationError(
      "ARGUMENT_ERROR",
      RELEASE_SCHEMA_ROUTE_ARGUMENT_MESSAGE,
    );
  }
  const expectedBoundary = RELEASE_SCHEMA_BOUNDARIES[schemaRoute];
  const routeMigrations = releaseMigrationsForRoute(schemaRoute);
  const carriesSchemaRoute = releaseManifestCarriesSchemaRoute(schemaRoute);
  const bundleRoot = existingDirectory(bundle, "bundle");
  const sha = normalizedExpectedSha(expectedSha);
  const manifest = parsedManifest(bundleRoot);

  if (
    Object.keys(manifest).sort().join(",") !==
      (carriesSchemaRoute
        ? "entrypoints,format,inventory,migrations,provenance,schemaBoundary,schemaRoute,sourceSha"
        : "entrypoints,format,inventory,migrations,provenance,schemaBoundary,sourceSha") ||
    (carriesSchemaRoute && manifest.schemaRoute !== schemaRoute) ||
    manifest.format !== RELEASE_BUNDLE_FORMAT ||
    manifest.sourceSha !== sha ||
    typeof manifest.schemaBoundary !== "object" ||
    manifest.schemaBoundary === null ||
    Array.isArray(manifest.schemaBoundary) ||
    Object.keys(manifest.schemaBoundary).sort().join(",") !==
      "candidate,rollback" ||
    manifest.schemaBoundary?.rollback !== expectedBoundary.rollback ||
    manifest.schemaBoundary?.candidate !== expectedBoundary.candidate ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length !== routeMigrations.length ||
    manifest.migrations.some(
      (migration, index) => migration !== routeMigrations[index],
    ) ||
    typeof manifest.entrypoints !== "object" ||
    manifest.entrypoints === null ||
    Array.isArray(manifest.entrypoints) ||
    Object.keys(manifest.entrypoints).sort().join(",") !== "auth,website" ||
    manifest.entrypoints?.auth !== "auth-service/dist/src/server.js" ||
    manifest.entrypoints?.website !== "website/dist/index.html" ||
    !Array.isArray(manifest.inventory)
  ) {
    throw new ReleaseValidationError(
      "BUNDLE_INTEGRITY_FAILED",
      "release manifest does not match the frozen packet format",
    );
  }

  const provenance = validateProvenance({
    provenance: manifest.provenance,
    expectedSha: sha,
    validationMode,
    schemaRoute,
    environment,
  });

  const inventoryPaths = [];
  let previousPath = "";
  for (const entry of manifest.inventory) {
    const pathParts =
      typeof entry?.path === "string" ? entry.path.split("/") : [];
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "bytes,path,sha256" ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      pathParts.some((part) => part === "" || part === "." || part === "..") ||
      entry.path <= previousPath ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      isForbiddenBundlePath(entry.path)
    ) {
      throw new ReleaseValidationError(
        "BUNDLE_INTEGRITY_FAILED",
        "release inventory contains an invalid entry",
      );
    }
    const artifact = join(bundleRoot, entry.path);
    let state;
    try {
      state = lstatSync(artifact);
    } catch {
      throw new ReleaseValidationError(
        "BUNDLE_INTEGRITY_FAILED",
        `inventoried artifact is missing: ${entry.path}`,
      );
    }
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.size !== entry.bytes ||
      sha256(artifact) !== entry.sha256
    ) {
      throw new ReleaseValidationError(
        "BUNDLE_INTEGRITY_FAILED",
        `inventoried artifact failed verification: ${entry.path}`,
      );
    }
    if (
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(
        readFileSync(artifact, "utf8"),
      )
    ) {
      throw new ReleaseValidationError(
        "BUNDLE_INTEGRITY_FAILED",
        `private-key material found in bundle: ${entry.path}`,
      );
    }
    inventoryPaths.push(entry.path);
    previousPath = entry.path;
  }

  for (const requiredPath of REQUIRED_BUNDLE_PATHS) {
    if (!inventoryPaths.includes(requiredPath)) {
      throw new ReleaseValidationError(
        "ARTIFACT_MISSING",
        `required bundle artifact is missing: ${requiredPath}`,
      );
    }
  }
  const referralHtml = readText(
    join(bundleRoot, "website/dist/referral.html"),
    "built public referral entrypoint",
  );
  const referralScript = referralHtml.match(/src="\/assets\/([A-Za-z0-9._-]+\.js)"/);
  if (!referralScript ||
      !inventoryPaths.includes("website/dist/assets/" + referralScript[1]) ||
      /src="\/app\/|href="\/register/.test(referralHtml)) {
    throw new ReleaseValidationError(
      "BUNDLE_INTEGRITY_FAILED",
      "public referral entrypoint must reference built assets and keep registration closed",
    );
  }
  for (const migration of routeMigrations) {
    if (!inventoryPaths.includes(`auth-service/src/migrations/${migration}`)) {
      throw new ReleaseValidationError(
        "ARTIFACT_MISSING",
        `required bundle migration is missing: ${migration}`,
      );
    }
  }

  const actualFiles = collectBundleFiles(bundleRoot).sort();
  const expectedFiles = [...inventoryPaths, "release-manifest.json"].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((path, index) => path !== expectedFiles[index])
  ) {
    throw new ReleaseValidationError(
      "BUNDLE_INTEGRITY_FAILED",
      "release bundle contains missing or untracked files",
    );
  }
  assertExactMigrationFiles(
    join(bundleRoot, "auth-service/src/migrations"),
    "bundle",
    routeMigrations,
  );
  const bundledOpenValidator = readText(
    join(bundleRoot, "scripts/ops/validate-release-open-http-contract.mjs"),
    "bundled open HTTP contract validator",
  );
  assertFragments(
    bundledOpenValidator,
    REQUIRED_OPEN_VALIDATOR_FRAGMENTS,
    "bundled open HTTP contract validator",
  );
  validateTemplateRoot(bundleRoot);
  validateTemplateRoot(bundleRoot, "dual-direct");

  const githubArtifactProof =
    validationMode === "candidate"
      ? validateGithubArtifactProof({
          artifactId: githubArtifactId,
          artifactArchive,
          expectedSha: sha,
          expectedFiles,
          inventory: manifest.inventory,
          bundleRoot,
          provenance,
        })
      : null;

  return Object.freeze({
    status: "ok",
    sourceSha: sha,
    bundleValidated: true,
    candidateVerified: githubArtifactProof !== null,
    provenanceKind: provenance.kind,
    releaseUse: provenance.releaseUse,
    artifactName: provenance.artifactName ?? null,
    githubRunId: provenance.runId ?? null,
    githubArtifactId: githubArtifactProof?.artifactId ?? null,
    githubArtifactDigest: githubArtifactProof?.artifactDigest ?? null,
    files: inventoryPaths.length,
    manifestSha256: sha256(join(bundleRoot, "release-manifest.json")),
  });
}

export function run(arguments_) {
  const options = parseOptions(arguments_);
  for (const name of options.keys()) {
    if (
      ![
        "--source",
        "--expected-sha",
        "--bundle",
        "--validation-mode",
        "--github-artifact-id",
        "--artifact-archive",
        "--schema-route",
      ].includes(name)
    ) {
      throw new ReleaseValidationError(
        "ARGUMENT_ERROR",
        `unsupported option ${name}`,
      );
    }
  }
  const source = requireOption(options, "--source");
  const expectedSha = requireOption(options, "--expected-sha");
  const bundle = options.get("--bundle");
  // Without --bundle the repository gate stays strict on the current 001-020
  // route; with --bundle it follows the bundle's explicit --schema-route.
  const schemaRoute =
    bundle === undefined
      ? DEFAULT_RELEASE_SCHEMA_ROUTE
      : (options.get("--schema-route") ?? DEFAULT_RELEASE_SCHEMA_ROUTE);
  const repositoryResult = validateRepository({ source, expectedSha, schemaRoute });
  if (bundle === undefined) {
    if (
      options.has("--validation-mode") ||
      options.has("--github-artifact-id") ||
      options.has("--artifact-archive") ||
      options.has("--schema-route")
    ) {
      throw new ReleaseValidationError(
        "ARGUMENT_ERROR",
        "bundle validation options require --bundle",
      );
    }
    return repositoryResult;
  }
  const validationMode = requireOption(options, "--validation-mode");
  if (
    validationMode !== "candidate" &&
    (options.has("--github-artifact-id") || options.has("--artifact-archive"))
  ) {
    throw new ReleaseValidationError(
      "ARGUMENT_ERROR",
      "GitHub artifact proof options are only valid in candidate mode",
    );
  }
  return validateBundle({
    bundle,
    expectedSha,
    validationMode,
    schemaRoute,
    githubArtifactId: options.get("--github-artifact-id"),
    artifactArchive: options.get("--artifact-archive"),
  });
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (error) {
    const safeError =
      error instanceof ReleaseValidationError
        ? error
        : new ReleaseValidationError(
            "INTERNAL_FAILURE",
            "release packet validation failed",
          );
    process.stderr.write(
      `${JSON.stringify({
        status: "error",
        code: safeError.code,
        message: safeError.message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

function isDirectExecution(moduleUrl, argumentPath) {
  if (argumentPath === undefined) {
    return false;
  }
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) ===
      realpathSync(resolve(argumentPath))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main();
}

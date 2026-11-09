#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_BUNDLE_FORMAT =
  "network-service-platform-consolidated-v1";
export const RELEASE_REPOSITORY =
  "604640310fsx-pixel/network-service-platform";
export const RELEASE_WORKFLOW_JOB = "consolidated-release-packet";
export const RELEASE_ARTIFACT_PREFIX = "consolidated-release-";
export const DIRECT14_RELEASE_ARTIFACT_PREFIX = "consolidated-release-direct14-";
export const STANDARD19_RELEASE_ARTIFACT_PREFIX = "consolidated-release-standard19-";
export const STANDARD26_RELEASE_ARTIFACT_PREFIX = "consolidated-release-standard26-";
export const RESIDENTIAL31_RELEASE_ARTIFACT_PREFIX = "consolidated-release-residential31-";
export const ADMIN32_RELEASE_ARTIFACT_PREFIX = "consolidated-release-admin32-";
export const RELEASE_INTEGRATION_REF =
  "refs/heads/integration/consolidate-project";
export const STANDARD26_FORMAL_REF =
  "refs/heads/codex/service-change-release-prepare-20261103";
export const STANDARD26_PRODUCT_BASELINE =
  "20b18764ff465cd690a433305fad5124ed4ecb60";
export const RESIDENTIAL31_FORMAL_REF = "refs/heads/codex/residential-options-local-20261105";
export const RESIDENTIAL31_PRODUCT_BASELINE = "d3d7297b48a7fd89fb46a8ae508eeec323cf330c";
export const STANDARD26_CONTROL_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "scripts/ops/assemble-consolidated-release.mjs",
  "scripts/ops/validate-consolidated-release-packet.mjs",
  "scripts/ops/consolidated-release-packet.test.mjs",
]);
export function releaseFormalRefForRoute(schemaRoute) {
  // Local 031→032 assembly is available; formal CI binding remains a separate frozen decision.
  if (schemaRoute === STANDARD31_32_RELEASE_SCHEMA_ROUTE) return null;
  if (schemaRoute === STANDARD26_31_RELEASE_SCHEMA_ROUTE) return RESIDENTIAL31_FORMAL_REF;
  return schemaRoute === STANDARD26_30_RELEASE_SCHEMA_ROUTE
    ? STANDARD26_FORMAL_REF : RELEASE_INTEGRATION_REF;
}
// Historical routes (001-019) stay recognized so already-built 019 bundles
// still validate; the current repository sequence is 001-020 (tickets).
export const STANDARD16_19_RELEASE_SCHEMA_ROUTE = "standard16-19";
export const DIRECT14_19_RELEASE_SCHEMA_ROUTE = "direct14-19";
export const STANDARD16_20_RELEASE_SCHEMA_ROUTE = "standard16-20";
export const DIRECT14_20_RELEASE_SCHEMA_ROUTE = "direct14-20";
// Formal route for a live database that is already continuous 001-019: the
// candidate loader applies only migration 020 (rollback boundary 19).
export const STANDARD19_20_RELEASE_SCHEMA_ROUTE = "standard19-20";
// Current routes for the repository's 001-021 sequence (personal invites). The
// -20 routes stay recognized only for already-built 001-020 bundles.
export const STANDARD16_21_RELEASE_SCHEMA_ROUTE = "standard16-21";
export const DIRECT14_21_RELEASE_SCHEMA_ROUTE = "direct14-21";
export const STANDARD19_21_RELEASE_SCHEMA_ROUTE = "standard19-21";
// Current routes for the repository's 001-022 sequence (admin service management).
// The -21 routes stay recognized only for already-built 001-021 bundles.
export const STANDARD16_22_RELEASE_SCHEMA_ROUTE = "standard16-22";
export const DIRECT14_22_RELEASE_SCHEMA_ROUTE = "direct14-22";
export const STANDARD19_22_RELEASE_SCHEMA_ROUTE = "standard19-22";
// Current routes for the repository's 001-023 sequence (admin grant delivery).
// The -22 routes stay recognized only for already-built 001-022 bundles.
export const STANDARD16_23_RELEASE_SCHEMA_ROUTE = "standard16-23";
export const DIRECT14_23_RELEASE_SCHEMA_ROUTE = "direct14-23";
export const STANDARD19_23_RELEASE_SCHEMA_ROUTE = "standard19-23";
export const STANDARD16_24_RELEASE_SCHEMA_ROUTE = "standard16-24";
export const DIRECT14_24_RELEASE_SCHEMA_ROUTE = "direct14-24";
export const STANDARD19_24_RELEASE_SCHEMA_ROUTE = "standard19-24";
// The -25 and older routes stay recognized only for already-built historical bundles.
export const STANDARD16_25_RELEASE_SCHEMA_ROUTE = "standard16-25";
export const DIRECT14_25_RELEASE_SCHEMA_ROUTE = "direct14-25";
export const STANDARD19_25_RELEASE_SCHEMA_ROUTE = "standard19-25";
// Current routes for the repository's 001-026 sequence (wallet accounting tables).
export const STANDARD16_26_RELEASE_SCHEMA_ROUTE = "standard16-26";
export const DIRECT14_26_RELEASE_SCHEMA_ROUTE = "direct14-26";
export const STANDARD19_26_RELEASE_SCHEMA_ROUTE = "standard19-26";
// Independent opt-in route. Never changes the frozen default/026 CI routes.
export const STANDARD26_30_RELEASE_SCHEMA_ROUTE = "standard26-30";
export const STANDARD26_31_RELEASE_SCHEMA_ROUTE = "standard26-31";
export const STANDARD31_32_RELEASE_SCHEMA_ROUTE = "standard31-32";
export function isIndependentStandard26Route(route) {
  return route === STANDARD26_30_RELEASE_SCHEMA_ROUTE || route === STANDARD26_31_RELEASE_SCHEMA_ROUTE;
}
export function releaseProductBaselineForRoute(route) {
  return route === STANDARD26_31_RELEASE_SCHEMA_ROUTE ? RESIDENTIAL31_PRODUCT_BASELINE :
    route === STANDARD26_30_RELEASE_SCHEMA_ROUTE ? STANDARD26_PRODUCT_BASELINE : null;
}
export const DEFAULT_RELEASE_SCHEMA_ROUTE = STANDARD16_26_RELEASE_SCHEMA_ROUTE;
export const DIRECT14_RELEASE_SCHEMA_ROUTE = DIRECT14_26_RELEASE_SCHEMA_ROUTE;
export const RELEASE_SCHEMA_BOUNDARIES = Object.freeze({
  [STANDARD16_19_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 19 }),
  [DIRECT14_19_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 19 }),
  [STANDARD16_20_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 20 }),
  [DIRECT14_20_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 20 }),
  [STANDARD19_20_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 19, candidate: 20 }),
  [STANDARD16_21_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 21 }),
  [DIRECT14_21_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 21 }),
  [STANDARD19_21_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 19, candidate: 21 }),
  [STANDARD16_22_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 22 }),
  [DIRECT14_22_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 22 }),
  [STANDARD19_22_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 19, candidate: 22 }),
  [STANDARD16_23_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 23 }),
  [DIRECT14_23_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 23 }),
  [STANDARD19_23_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 19, candidate: 23 }),
  [STANDARD16_24_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 24 }),
  [DIRECT14_24_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 24 }),
  [STANDARD19_24_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 19, candidate: 24 }),
  [STANDARD16_25_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 25 }),
  [DIRECT14_25_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 25 }),
  [STANDARD19_25_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 19, candidate: 25 }),
  [STANDARD16_26_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 26 }),
  [DIRECT14_26_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 26 }),
  [STANDARD19_26_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 19, candidate: 26 }),
  [STANDARD26_30_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 26, candidate: 30 }),
  [STANDARD26_31_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 26, candidate: 31 }),
  [STANDARD31_32_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 31, candidate: 32 }),
});
export const RELEASE_SCHEMA_ROUTE_ARGUMENT_MESSAGE =
  "--schema-route must be standard16-19, direct14-19, standard16-20, direct14-20, standard19-20, standard16-21, direct14-21, standard19-21, standard16-22, direct14-22, standard19-22, standard16-23, direct14-23, standard19-23, standard16-24, direct14-24, standard19-24, standard16-25, direct14-25, standard19-25, standard16-26, direct14-26, standard19-26, standard26-30, standard26-31, or standard31-32";
const DIRECT14_RELEASE_SCHEMA_ROUTES = Object.freeze(
  new Set([
    DIRECT14_19_RELEASE_SCHEMA_ROUTE,
    DIRECT14_20_RELEASE_SCHEMA_ROUTE,
    DIRECT14_21_RELEASE_SCHEMA_ROUTE,
    DIRECT14_22_RELEASE_SCHEMA_ROUTE,
    DIRECT14_23_RELEASE_SCHEMA_ROUTE,
    DIRECT14_24_RELEASE_SCHEMA_ROUTE,
    DIRECT14_25_RELEASE_SCHEMA_ROUTE,
    DIRECT14_26_RELEASE_SCHEMA_ROUTE,
  ]),
);
export function isKnownReleaseSchemaRoute(schemaRoute) {
  return (
    typeof schemaRoute === "string" &&
    Object.hasOwn(RELEASE_SCHEMA_BOUNDARIES, schemaRoute)
  );
}
export function isDirect14ReleaseSchemaRoute(schemaRoute) {
  return DIRECT14_RELEASE_SCHEMA_ROUTES.has(schemaRoute);
}
// Historical standard16-19 manifests omit schemaRoute; every other route,
// including both 001-020 routes, records it explicitly.
export function releaseManifestCarriesSchemaRoute(schemaRoute) {
  return schemaRoute !== STANDARD16_19_RELEASE_SCHEMA_ROUTE;
}
export function releaseArtifactNameForRoute(sha, schemaRoute) {
  if (!isKnownReleaseSchemaRoute(schemaRoute)) {
    throw new ReleaseAssemblyError(
      "ARGUMENT_ERROR",
      RELEASE_SCHEMA_ROUTE_ARGUMENT_MESSAGE,
    );
  }
  const prefix = schemaRoute === STANDARD31_32_RELEASE_SCHEMA_ROUTE ? ADMIN32_RELEASE_ARTIFACT_PREFIX :
    schemaRoute === STANDARD26_31_RELEASE_SCHEMA_ROUTE ? RESIDENTIAL31_RELEASE_ARTIFACT_PREFIX : schemaRoute === STANDARD26_30_RELEASE_SCHEMA_ROUTE
    ? STANDARD26_RELEASE_ARTIFACT_PREFIX
    : isDirect14ReleaseSchemaRoute(schemaRoute)
    ? DIRECT14_RELEASE_ARTIFACT_PREFIX
    : schemaRoute === STANDARD19_20_RELEASE_SCHEMA_ROUTE ||
        schemaRoute === STANDARD19_21_RELEASE_SCHEMA_ROUTE ||
        schemaRoute === STANDARD19_22_RELEASE_SCHEMA_ROUTE ||
        schemaRoute === STANDARD19_23_RELEASE_SCHEMA_ROUTE ||
        schemaRoute === STANDARD19_24_RELEASE_SCHEMA_ROUTE ||
        schemaRoute === STANDARD19_25_RELEASE_SCHEMA_ROUTE ||
        schemaRoute === STANDARD19_26_RELEASE_SCHEMA_ROUTE
      ? STANDARD19_RELEASE_ARTIFACT_PREFIX
      : RELEASE_ARTIFACT_PREFIX;
  return `${prefix}${sha}`;
}
export const RELEASE_MIGRATIONS_001_019 = Object.freeze([
  "001_users_and_invite_codes.sql",
  "002_invite_code_redemptions.sql",
  "003_session_families_and_sessions.sql",
  "004_pending_registrations.sql",
  "005_password_reset_tokens.sql",
  "006_sso_states_and_codes.sql",
  "007_mail_outbox.sql",
  "008_rate_limit_buckets.sql",
  "009_audit_log.sql",
  "010_orders_payments_services.sql",
  "011_service_delivery_items.sql",
  "012_commerce_plans_and_coupons.sql",
  "013_diagnosis_requests.sql",
  "014_service_delivery_monitor_target.sql",
  "015_diagnosis_request_idempotency.sql",
  "016_invite_codes_prebound_single_use.sql",
  "017_referral_profiles.sql",
  "018_referral_attribution_candidates.sql",
  "019_referral_candidate_owner_page_index.sql",
]);
export const RELEASE_MIGRATIONS_001_020 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_019,
  "020_tickets.sql",
]);
export const RELEASE_MIGRATIONS_001_021 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_020,
  "021_personal_invites.sql",
]);
export const RELEASE_MIGRATIONS_001_022 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_021,
  "022_admin_service_management.sql",
]);
export const RELEASE_MIGRATIONS_001_023 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_022,
  "023_admin_grant_delivery.sql",
]);
export const RELEASE_MIGRATIONS_001_024 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_023,
  "024_grant_delivery_monitor_target.sql",
]);
export const RELEASE_MIGRATIONS_001_025 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_024,
  "025_ticket_attachments_and_grant_link.sql",
]);
export const RELEASE_MIGRATIONS_001_026 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_025,
  "026_wallet.sql",
]);
export const RELEASE_MIGRATIONS_001_030 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_026,
  "027_package_option_plans.sql",
  "028_period_price_rule.sql",
  "029_remove_single_payment_cap.sql",
  "030_service_change_local.sql",
]);
export const RELEASE_MIGRATIONS_001_031 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_030,
  "031_residential_order_options.sql",
]);
export const RELEASE_MIGRATIONS_001_032 = Object.freeze([
  ...RELEASE_MIGRATIONS_001_031,
  "032_catalog_directory_and_last_login.sql",
]);
// Frozen default contract, not a moving alias for the newest source.
export const RELEASE_MIGRATIONS = RELEASE_MIGRATIONS_001_026;
export function releaseMigrationsForRoute(schemaRoute) {
  if (!isKnownReleaseSchemaRoute(schemaRoute)) {
    throw new ReleaseAssemblyError(
      "ARGUMENT_ERROR",
      RELEASE_SCHEMA_ROUTE_ARGUMENT_MESSAGE,
    );
  }
  const candidate = RELEASE_SCHEMA_BOUNDARIES[schemaRoute].candidate;
  return candidate === 19
    ? RELEASE_MIGRATIONS_001_019
    : candidate === 20
      ? RELEASE_MIGRATIONS_001_020
      : candidate === 21
        ? RELEASE_MIGRATIONS_001_021
        : candidate === 22
          ? RELEASE_MIGRATIONS_001_022
          : candidate === 23
            ? RELEASE_MIGRATIONS_001_023
            : candidate === 24
              ? RELEASE_MIGRATIONS_001_024
              : candidate === 25
                ? RELEASE_MIGRATIONS_001_025
                : candidate === 30
                  ? RELEASE_MIGRATIONS_001_030
                  : candidate === 31 ? RELEASE_MIGRATIONS_001_031
                  : candidate === 32 ? RELEASE_MIGRATIONS_001_032
                  : RELEASE_MIGRATIONS_001_026;
}

/** Pure decision guard, NOT an executor or evidence collector. External facts
 * must be bound to one closed-traffic release attempt. UNKNOWN is never true.
 * The existing sqlite-backup verify operation supplies snapshotVerification;
 * its hash must match the pre-migration snapshot bound to this database/attempt.
 * No rollback SQL exists: eligible recovery restores that entire 026 snapshot
 * with independently matched Auth AND Website artifacts. */
export function assertStandard26RecoveryBoundary({ phase, attemptId, databaseBinding,
  trafficClosed, oldApplicationStopped, candidateStopped, applicationWriters,
  applicationWritesSinceSnapshot, paymentsSinceSnapshot, fulfillmentsSinceSnapshot, externalEffectsSinceSnapshot,
  liveMigrations, snapshot, snapshotVerification, rollbackArtifacts } = {}) {
  const deny = (message) => { throw new ReleaseAssemblyError("RESTORE_26_FORBIDDEN", message); };
  const continuous = (versions, max) => Array.isArray(versions) && versions.length === max &&
    versions.every((version, index) => version === index + 1);
  const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const bound = (proof) => proof?.attemptId === attemptId && proof?.databaseBinding === databaseBinding;
  if (!["before-upgrade", "failed-upgrade"].includes(phase) ||
      typeof attemptId !== "string" || attemptId.trim() === "" ||
      typeof databaseBinding !== "string" || databaseBinding.trim() === "" ||
      trafficClosed !== true || oldApplicationStopped !== true || candidateStopped !== true ||
      applicationWriters !== 0 || applicationWritesSinceSnapshot !== 0 ||
      paymentsSinceSnapshot !== 0 || fulfillmentsSinceSnapshot !== 0 || externalEffectsSinceSnapshot !== 0) {
    deny("closed ingress, stopped applications, zero writers and zero new writes/external effects must all be proven; otherwise preserve current facts and forward-fix/reconcile, never start the old 026 binary");
  }
  // A failed migration may have committed a prefix 027..029. It can recover only
  // before any non-migration write; future/contradictory schema is never eligible.
  const last = Array.isArray(liveMigrations) ? liveMigrations.length : 0;
  if ((phase === "before-upgrade" && !continuous(liveMigrations, 26)) ||
      (phase === "failed-upgrade" && (last < 26 || last > 30 || !continuous(liveMigrations, last)))) {
    deny("live schema must be exact 001-026 before upgrade or a continuous 026..030 failed-upgrade boundary");
  }
  if (!bound(snapshot) || !sha(snapshot?.sha256) ||
      snapshotVerification?.status !== "ok" || snapshotVerification.operation !== "verify" ||
      snapshotVerification.sha256 !== snapshot.sha256 || snapshotVerification.fileMode !== "0600" ||
      snapshotVerification.quickCheck !== "ok" || snapshotVerification.foreignKeyFailures !== 0 ||
      !Number.isSafeInteger(snapshotVerification.bytes) || snapshotVerification.bytes <= 0 ||
      snapshotVerification.bytes !== snapshot.bytes || !continuous(snapshotVerification.migrations, 26)) {
    deny("a matching current-attempt independently verified 001-026 snapshot is required");
  }
  if (!bound(rollbackArtifacts) || rollbackArtifacts?.verified !== true ||
      rollbackArtifacts?.authSchemaBoundary !== 26 || !sha(rollbackArtifacts?.authSha256) ||
      !sha(rollbackArtifacts?.websiteSha256)) {
    deny("independently verified matching Auth026 and Website recovery artifacts are required");
  }
  return Object.freeze({ status: "ok", schemaRoute: STANDARD26_30_RELEASE_SCHEMA_ROUTE,
    permittedAction: phase === "before-upgrade" ? "upgrade-026-to-030" : "restore-matched-026-snapshot-and-artifacts",
    automaticRestore: false, requiresFreshProofAtExecution: true });
}
// Independent031 recovery: never widens the accepted030 rollback boundary.
export function assertResidential31RecoveryBoundary({ phase, attemptId, databaseBinding,
  trafficClosed, oldApplicationStopped, candidateStopped, applicationWriters,
  applicationWritesSinceSnapshot, paymentsSinceSnapshot, fulfillmentsSinceSnapshot, externalEffectsSinceSnapshot,
  liveMigrations, snapshot, snapshotVerification, rollbackArtifacts } = {}) {
  const deny = (message) => { throw new ReleaseAssemblyError("RESTORE_26_FORBIDDEN", message); };
  const continuous = (versions, max) => Array.isArray(versions) && versions.length === max &&
    versions.every((version, index) => version === index + 1);
  const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const bound = (proof) => proof?.attemptId === attemptId && proof?.databaseBinding === databaseBinding;
  if (!["before-upgrade", "failed-upgrade"].includes(phase) ||
      typeof attemptId !== "string" || attemptId.trim() === "" ||
      typeof databaseBinding !== "string" || databaseBinding.trim() === "" ||
      trafficClosed !== true || oldApplicationStopped !== true || candidateStopped !== true ||
      applicationWriters !== 0 || applicationWritesSinceSnapshot !== 0 ||
      paymentsSinceSnapshot !== 0 || fulfillmentsSinceSnapshot !== 0 || externalEffectsSinceSnapshot !== 0) {
    deny("closed ingress, stopped applications, zero writers and zero new writes/external effects must all be proven; otherwise preserve current facts and forward-fix/reconcile, never start the old 026 binary");
  }
  // A failed migration may have committed a prefix 027..029. It can recover only
  // before any non-migration write; future/contradictory schema is never eligible.
  const last = Array.isArray(liveMigrations) ? liveMigrations.length : 0;
  if ((phase === "before-upgrade" && !continuous(liveMigrations, 26)) ||
      (phase === "failed-upgrade" && (last < 26 || last > 31 || !continuous(liveMigrations, last)))) {
    deny("live schema must be exact 001-026 before upgrade or a continuous 026..031 failed-upgrade boundary");
  }
  if (!bound(snapshot) || !sha(snapshot?.sha256) ||
      snapshotVerification?.status !== "ok" || snapshotVerification.operation !== "verify" ||
      snapshotVerification.sha256 !== snapshot.sha256 || snapshotVerification.fileMode !== "0600" ||
      snapshotVerification.quickCheck !== "ok" || snapshotVerification.foreignKeyFailures !== 0 ||
      !Number.isSafeInteger(snapshotVerification.bytes) || snapshotVerification.bytes <= 0 ||
      snapshotVerification.bytes !== snapshot.bytes || !continuous(snapshotVerification.migrations, 26)) {
    deny("a matching current-attempt independently verified 001-026 snapshot is required");
  }
  if (!bound(rollbackArtifacts) || rollbackArtifacts?.verified !== true ||
      rollbackArtifacts?.authSchemaBoundary !== 26 || !sha(rollbackArtifacts?.authSha256) ||
      !sha(rollbackArtifacts?.websiteSha256)) {
    deny("independently verified matching Auth026 and Website recovery artifacts are required");
  }
  return Object.freeze({ status: "ok", schemaRoute: STANDARD26_31_RELEASE_SCHEMA_ROUTE,
    permittedAction: phase === "before-upgrade" ? "upgrade-026-to-031" : "restore-matched-026-snapshot-and-artifacts",
    automaticRestore: false, requiresFreshProofAtExecution: true });
}
export const RELEASE_HTTP_CONTRACT_PATHS = Object.freeze([
  "ops/nginx/release-traffic-open.conf.example",
  "ops/nginx/release-traffic-dual-direct.conf.example",
  "ops/nginx/bare-domain-redirect.conf.example",
  "ops/nginx/release-traffic-closed.conf.example",
  "scripts/ops/validate-release-open-http-contract.mjs",
]);

const FILE_MAPPINGS = Object.freeze([
  ["auth-service/package.json", "auth-service/package.json"],
  ["auth-service/package-lock.json", "auth-service/package-lock.json"],
  ["auth-service/dist/src", "auth-service/dist/src"],
  ["auth-service/src/migrations", "auth-service/src/migrations"],
  ["website/package.json", "website/package.json"],
  ["website/package-lock.json", "website/package-lock.json"],
  ["website/dist", "website/dist"],
  [
    "ops/nginx/release-traffic-open.conf.example",
    "ops/nginx/release-traffic-open.conf.example",
  ],
  [
    "ops/nginx/release-traffic-dual-direct.conf.example",
    "ops/nginx/release-traffic-dual-direct.conf.example",
  ],
  [
    "ops/nginx/bare-domain-redirect.conf.example",
    "ops/nginx/bare-domain-redirect.conf.example",
  ],
  [
    "ops/nginx/release-traffic-closed.conf.example",
    "ops/nginx/release-traffic-closed.conf.example",
  ],
  [
    "scripts/ops/validate-release-open-http-contract.mjs",
    "scripts/ops/validate-release-open-http-contract.mjs",
  ],
]);

const REQUIRED_PAYLOAD_PATHS = Object.freeze([
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

export class ReleaseAssemblyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseAssemblyError";
    this.code = code;
  }
}

function parseOptions(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      throw new ReleaseAssemblyError(
        "ARGUMENT_ERROR",
        "options must be --name value pairs",
      );
    }
    if (options.has(name)) {
      throw new ReleaseAssemblyError(
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
    throw new ReleaseAssemblyError("ARGUMENT_ERROR", `${name} is required`);
  }
  return value;
}

function assertOnlyOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new ReleaseAssemblyError(
        "ARGUMENT_ERROR",
        `unsupported option ${name}`,
      );
    }
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function existingDirectory(input, label) {
  let path;
  try {
    path = realpathSync(resolve(input));
    if (!statSync(path).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new ReleaseAssemblyError(
      "SOURCE_INVALID",
      `${label} must be an existing directory`,
    );
  }
  return path;
}

function newDestination(input, source) {
  const requested = resolve(input);
  let parent;
  try {
    parent = realpathSync(dirname(requested));
    if (!statSync(parent).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new ReleaseAssemblyError(
      "DESTINATION_INVALID",
      "destination parent must be an existing directory",
    );
  }
  const destination = join(parent, basename(requested));
  if (pathExists(destination)) {
    throw new ReleaseAssemblyError(
      "DESTINATION_EXISTS",
      "destination already exists",
    );
  }
  const fromSource = relative(source, destination);
  if (
    fromSource === "" ||
    (!fromSource.startsWith(`..${sep}`) &&
      fromSource !== ".." &&
      !isAbsolute(fromSource))
  ) {
    throw new ReleaseAssemblyError(
      "DESTINATION_INVALID",
      "destination must be outside the source repository",
    );
  }
  return destination;
}

function normalizedExpectedSha(value) {
  const sha = value.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new ReleaseAssemblyError(
      "ARGUMENT_ERROR",
      "--expected-sha must be a full hexadecimal Git object ID",
    );
  }
  return sha;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseAssemblyError(
      "PROVENANCE_REQUIRED",
      `${name} is required for GitHub Actions provenance`,
    );
  }
  return value;
}

export function createReleaseProvenance({
  mode,
  expectedSha,
  schemaRoute = DEFAULT_RELEASE_SCHEMA_ROUTE,
  environment = process.env,
}) {
  const sha = normalizedExpectedSha(expectedSha);
  const artifactName = releaseArtifactNameForRoute(sha, schemaRoute);
  if (mode === "local-dry-run") {
    return Object.freeze({
      kind: "local-dry-run",
      releaseUse: "forbidden",
    });
  }
  if (mode !== "github-actions" && mode !== "github-actions-test") {
    throw new ReleaseAssemblyError(
      "ARGUMENT_ERROR",
      "--provenance-mode must be local-dry-run, github-actions-test, or github-actions",
    );
  }
  if (schemaRoute === STANDARD31_32_RELEASE_SCHEMA_ROUTE && mode === "github-actions") {
    throw new ReleaseAssemblyError("PROVENANCE_REQUIRED", "formal 032 CI ref and source binding are not frozen");
  }
  if (environment.GITHUB_ACTIONS !== "true") {
    throw new ReleaseAssemblyError(
      "PROVENANCE_REQUIRED",
      "GitHub Actions provenance is unavailable outside GitHub Actions",
    );
  }

  const repository = requiredEnvironment(environment, "GITHUB_REPOSITORY");
  const runId = requiredEnvironment(environment, "GITHUB_RUN_ID");
  const runAttempt = requiredEnvironment(environment, "GITHUB_RUN_ATTEMPT");
  const workflowRef = requiredEnvironment(environment, "GITHUB_WORKFLOW_REF");
  const job = requiredEnvironment(environment, "GITHUB_JOB");
  const eventName = requiredEnvironment(environment, "GITHUB_EVENT_NAME");
  const ref = requiredEnvironment(environment, "GITHUB_REF");
  const githubSha = requiredEnvironment(environment, "GITHUB_SHA").toLowerCase();
  if (
    repository !== RELEASE_REPOSITORY ||
    job !== RELEASE_WORKFLOW_JOB ||
    !/^[1-9][0-9]*$/.test(runId) ||
    !/^[1-9][0-9]*$/.test(runAttempt) ||
    !workflowRef.startsWith(
      `${RELEASE_REPOSITORY}/.github/workflows/ci.yml@`,
    )
  ) {
    throw new ReleaseAssemblyError(
      "PROVENANCE_REQUIRED",
      "GitHub Actions provenance does not match the release workflow",
    );
  }

  const isReleaseCandidateContext =
    eventName === "push" &&
    ref === releaseFormalRefForRoute(schemaRoute) &&
    githubSha === sha &&
    (!isIndependentStandard26Route(schemaRoute) ||
      workflowRef === `${RELEASE_REPOSITORY}/.github/workflows/ci.yml@${releaseFormalRefForRoute(schemaRoute)}`);
  if (mode === "github-actions-test") {
    if (isReleaseCandidateContext) {
      throw new ReleaseAssemblyError(
        "PROVENANCE_REQUIRED",
        "an integration push must use release-candidate provenance",
      );
    }
    return Object.freeze({
      kind: "github-actions-test",
      releaseUse: "forbidden",
      repository,
      workflowRef,
      runId,
      runAttempt,
      job,
      eventName,
      ref,
      githubSha,
    });
  }
  if (!isReleaseCandidateContext) {
    throw new ReleaseAssemblyError(
      "PROVENANCE_REQUIRED",
      "release-candidate provenance requires an exact integration push SHA",
    );
  }
  if (isIndependentStandard26Route(schemaRoute)) {
    let event;
    try { event = JSON.parse(readFileSync(requiredEnvironment(environment, "GITHUB_EVENT_PATH"), "utf8")); }
    catch { throw new ReleaseAssemblyError("PROVENANCE_REQUIRED", "formal standard26 source requires the actual push event payload"); }
    if (event.ref !== releaseFormalRefForRoute(schemaRoute) || event.after !== sha ||
      event.repository?.full_name !== RELEASE_REPOSITORY || event.deleted !== false) {
      throw new ReleaseAssemblyError("PROVENANCE_REQUIRED", "formal standard26 push payload does not match repository/ref/head");
    }
  }

  return Object.freeze({
    kind: "github-actions",
    releaseUse: "requires-github-artifact-verification",
    repository,
    workflowRef,
    runId,
    runAttempt,
    job,
    eventName,
    ref,
    githubSha,
    artifactName,
    ...(isIndependentStandard26Route(schemaRoute)
      ? { productBaseline: releaseProductBaselineForRoute(schemaRoute) } : {}),
  });
}

function runGit(source, arguments_) {
  const result = spawnSync("git", ["-C", source, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new ReleaseAssemblyError(
      "SOURCE_INVALID",
      "source Git metadata could not be verified",
    );
  }
  return result.stdout.trim();
}

function verifySourceRevision(source, expectedSha) {
  const topLevel = realpathSync(runGit(source, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== source) {
    throw new ReleaseAssemblyError(
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
    throw new ReleaseAssemblyError(
      "SHA_MISMATCH",
      "source HEAD does not match --expected-sha",
    );
  }
  if (
    runGit(source, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
  ) {
    throw new ReleaseAssemblyError(
      "SOURCE_DIRTY",
      "source repository contains uncommitted files",
    );
  }
}

// This is a single frozen product source, not a general branch publishing rule.
// Compare the entire tracked tree (not just payload paths), including SQL/locks.
export function verifyStandard26ProductSource(source, expectedSha) {
  source = existingDirectory(source, "source");
  verifySourceRevision(source, normalizedExpectedSha(expectedSha));
  const ancestor = spawnSync("git", ["-C", source, "merge-base", "--is-ancestor",
    STANDARD26_PRODUCT_BASELINE, expectedSha], { encoding: "utf8" });
  if (ancestor.status !== 0) {
    throw new ReleaseAssemblyError("PRODUCT_SOURCE_MISMATCH", "frozen product baseline must be an ancestor of the formal source");
  }
  const diff = spawnSync("git", ["-C", source, "diff", "--name-only", "--no-renames", "-z",
    STANDARD26_PRODUCT_BASELINE, expectedSha], { encoding: "utf8" });
  if (diff.status !== 0) throw new ReleaseAssemblyError("SOURCE_INVALID", "formal product tree comparison failed");
  const changed = diff.stdout.split("\0").filter(Boolean);
  if (changed.some(path => !STANDARD26_CONTROL_PATHS.includes(path))) {
    throw new ReleaseAssemblyError("PRODUCT_SOURCE_MISMATCH", "formal source may differ from the frozen product baseline only in four release controls");
  }
  return STANDARD26_PRODUCT_BASELINE;
}
// Independent031 policy: it never changes the existing030 baseline or allowance.
export function verifyResidential31ProductSource(source, expectedSha) {
  source = existingDirectory(source,"source");
  verifySourceRevision(source,normalizedExpectedSha(expectedSha));
  const ancestor=spawnSync("git",["-C",source,"merge-base","--is-ancestor",RESIDENTIAL31_PRODUCT_BASELINE,expectedSha],{encoding:"utf8"});
  if(ancestor.status!==0)throw new ReleaseAssemblyError("PRODUCT_SOURCE_MISMATCH","frozen residential product baseline must be an ancestor");
  const diff=spawnSync("git",["-C",source,"diff","--name-only","--no-renames","-z",RESIDENTIAL31_PRODUCT_BASELINE,expectedSha],{encoding:"utf8"});
  if(diff.status!==0)throw new ReleaseAssemblyError("SOURCE_INVALID","residential product tree comparison failed");
  if(diff.stdout.split("\0").filter(Boolean).some(path=>!STANDARD26_CONTROL_PATHS.includes(path)))
    throw new ReleaseAssemblyError("PRODUCT_SOURCE_MISMATCH","residential formal source may differ only in the four release controls");
  return RESIDENTIAL31_PRODUCT_BASELINE;
}
export function verifyIndependentProductSource(source,expectedSha,route) {
  return route===STANDARD26_31_RELEASE_SCHEMA_ROUTE ? verifyResidential31ProductSource(source,expectedSha) : verifyStandard26ProductSource(source,expectedSha);
}

function normalizedRelativePath(path) {
  return path.split(sep).join("/");
}

export function isForbiddenBundlePath(path) {
  const normalized = normalizedRelativePath(path);
  const parts = normalized.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.some((part) =>
      [".git", "node_modules", "credentials", "secrets"].includes(part),
    ) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    /(?:^|[._-])(?:credential|credentials|secret|secrets)(?:[._-]|$)/i.test(
      name,
    ) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(name) ||
    /\.(?:db|sqlite|sqlite3|pem|key|p12|pfx)$/i.test(name) ||
    /-(?:wal|shm|journal)$/i.test(name)
  );
}

function collectRegularFiles(root, relativeRoot = "") {
  const absoluteRoot = join(root, relativeRoot);
  const state = lstatSync(absoluteRoot);
  if (state.isSymbolicLink()) {
    throw new ReleaseAssemblyError(
      "SOURCE_INVALID",
      "release inputs must not contain symbolic links",
    );
  }
  if (state.isFile()) {
    return [normalizedRelativePath(relativeRoot)];
  }
  if (!state.isDirectory()) {
    throw new ReleaseAssemblyError(
      "SOURCE_INVALID",
      "release inputs must contain only regular files and directories",
    );
  }

  const files = [];
  for (const entry of readdirSync(absoluteRoot).sort()) {
    const child = join(relativeRoot, entry);
    files.push(...collectRegularFiles(root, child));
  }
  return files;
}

function assertSafeSourceFile(sourcePath, bundlePath) {
  if (isForbiddenBundlePath(bundlePath)) {
    throw new ReleaseAssemblyError(
      "FORBIDDEN_SOURCE_ENTRY",
      `release input contains forbidden path ${bundlePath}`,
    );
  }
  const bytes = readFileSync(sourcePath);
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(bytes.toString("utf8"))) {
    throw new ReleaseAssemblyError(
      "FORBIDDEN_SOURCE_ENTRY",
      `release input contains private-key material at ${bundlePath}`,
    );
  }
}

function ensureParentDirectory(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
}

function copyMappedInput(source, destination, sourceRelative, targetRelative) {
  const sourcePath = join(source, sourceRelative);
  if (!pathExists(sourcePath)) {
    throw new ReleaseAssemblyError(
      "ARTIFACT_MISSING",
      `required release input is missing: ${sourceRelative}`,
    );
  }
  if (realpathSync(sourcePath) !== sourcePath) {
    throw new ReleaseAssemblyError(
      "SOURCE_INVALID",
      `release input path must not contain symbolic links: ${sourceRelative}`,
    );
  }
  const state = lstatSync(sourcePath);
  const copiedPaths = [];

  if (state.isFile()) {
    assertSafeSourceFile(sourcePath, targetRelative);
    const targetPath = join(destination, targetRelative);
    ensureParentDirectory(targetPath);
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 0o644);
    return [normalizedRelativePath(targetRelative)];
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new ReleaseAssemblyError(
      "SOURCE_INVALID",
      `release input is not a regular directory: ${sourceRelative}`,
    );
  }

  for (const child of collectRegularFiles(sourcePath)) {
    const bundlePath = normalizedRelativePath(join(targetRelative, child));
    const childSource = join(sourcePath, child);
    assertSafeSourceFile(childSource, bundlePath);
    const childDestination = join(destination, bundlePath);
    ensureParentDirectory(childDestination);
    copyFileSync(childSource, childDestination);
    chmodSync(childDestination, 0o644);
    copiedPaths.push(bundlePath);
  }
  return copiedPaths;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildInventory(destination, paths) {
  return [...paths]
    .sort()
    .map((path) => ({
      path,
      bytes: statSync(join(destination, path)).size,
      sha256: sha256File(join(destination, path)),
    }));
}

function verifyMigrationInputs(source, migrations) {
  const migrationsDirectory = join(source, "auth-service/src/migrations");
  let files;
  try {
    files = readdirSync(migrationsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new ReleaseAssemblyError(
      "ARTIFACT_MISSING",
      "migration inputs could not be read",
    );
  }
  if (
    files.length !== migrations.length ||
    files.some((file, index) => file !== migrations[index])
  ) {
    throw new ReleaseAssemblyError(
      "SCHEMA_BOUNDARY_MISMATCH",
      `migration inputs must be the exact frozen 001-${String(migrations.length).padStart(3, "0")} sequence for the selected schema route`,
    );
  }
}

export function assembleReleaseBundle({
  source,
  destination,
  expectedSha,
  provenanceMode,
  schemaRoute = DEFAULT_RELEASE_SCHEMA_ROUTE,
  environment = process.env,
}) {
  if (!isKnownReleaseSchemaRoute(schemaRoute)) {
    throw new ReleaseAssemblyError(
      "ARGUMENT_ERROR",
      RELEASE_SCHEMA_ROUTE_ARGUMENT_MESSAGE,
    );
  }
  const schemaBoundary = RELEASE_SCHEMA_BOUNDARIES[schemaRoute];
  const routeMigrations = releaseMigrationsForRoute(schemaRoute);
  const sourceRoot = existingDirectory(source, "source");
  const sha = normalizedExpectedSha(expectedSha);
  const provenance = createReleaseProvenance({
    mode: provenanceMode,
    expectedSha: sha,
    schemaRoute,
    environment,
  });
  const destinationRoot = newDestination(destination, sourceRoot);
  verifySourceRevision(sourceRoot, sha);
  if (isIndependentStandard26Route(schemaRoute) && provenance.kind === "github-actions") {
    verifyIndependentProductSource(sourceRoot, sha, schemaRoute);
  }
  verifyMigrationInputs(sourceRoot, routeMigrations);

  let created = false;
  try {
    mkdirSync(destinationRoot, { mode: 0o700 });
    created = true;
    const copiedPaths = [];
    for (const [sourceRelative, targetRelative] of FILE_MAPPINGS) {
      copiedPaths.push(
        ...copyMappedInput(
          sourceRoot,
          destinationRoot,
          sourceRelative,
          targetRelative,
        ),
      );
    }

    for (const requiredPath of REQUIRED_PAYLOAD_PATHS) {
      if (!copiedPaths.includes(requiredPath)) {
        throw new ReleaseAssemblyError(
          "ARTIFACT_MISSING",
          `required bundle artifact is missing: ${requiredPath}`,
        );
      }
    }
    for (const migration of routeMigrations) {
      const path = `auth-service/src/migrations/${migration}`;
      if (!copiedPaths.includes(path)) {
        throw new ReleaseAssemblyError(
          "ARTIFACT_MISSING",
          `required bundle migration is missing: ${migration}`,
        );
      }
    }

    const manifest = {
      format: RELEASE_BUNDLE_FORMAT,
      sourceSha: sha,
      ...(releaseManifestCarriesSchemaRoute(schemaRoute) ? { schemaRoute } : {}),
      schemaBoundary,
      migrations: routeMigrations,
      entrypoints: {
        auth: "auth-service/dist/src/server.js",
        website: "website/dist/index.html",
      },
      provenance,
      inventory: buildInventory(destinationRoot, copiedPaths),
    };
    const manifestPath = join(destinationRoot, "release-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });

    return Object.freeze({
      status: "ok",
      sourceSha: sha,
      provenanceKind: provenance.kind,
      releaseUse: provenance.releaseUse,
      files: manifest.inventory.length,
      manifestSha256: sha256File(manifestPath),
    });
  } catch (error) {
    if (created) {
      rmSync(destinationRoot, { recursive: true, force: true });
    }
    if (error instanceof ReleaseAssemblyError) {
      throw error;
    }
    throw new ReleaseAssemblyError(
      "ASSEMBLY_FAILED",
      "release bundle assembly failed",
    );
  }
}

export function run(arguments_) {
  const options = parseOptions(arguments_);
  assertOnlyOptions(
    options,
    new Set([
      "--source",
      "--destination",
      "--expected-sha",
      "--provenance-mode",
      "--schema-route",
    ]),
  );
  return assembleReleaseBundle({
    source: requireOption(options, "--source"),
    destination: requireOption(options, "--destination"),
    expectedSha: requireOption(options, "--expected-sha"),
    provenanceMode: requireOption(options, "--provenance-mode"),
    schemaRoute: options.get("--schema-route") ?? DEFAULT_RELEASE_SCHEMA_ROUTE,
  });
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (error) {
    const safeError =
      error instanceof ReleaseAssemblyError
        ? error
        : new ReleaseAssemblyError(
            "INTERNAL_FAILURE",
            "release bundle assembly failed",
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

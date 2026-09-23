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
export const RELEASE_INTEGRATION_REF =
  "refs/heads/integration/consolidate-project";
export const DEFAULT_RELEASE_SCHEMA_ROUTE = "standard16-19";
export const DIRECT14_RELEASE_SCHEMA_ROUTE = "direct14-19";
export const RELEASE_SCHEMA_BOUNDARIES = Object.freeze({
  [DEFAULT_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 16, candidate: 19 }),
  [DIRECT14_RELEASE_SCHEMA_ROUTE]: Object.freeze({ rollback: 14, candidate: 19 }),
});
export function releaseArtifactNameForRoute(sha, schemaRoute) {
  if (!Object.hasOwn(RELEASE_SCHEMA_BOUNDARIES, schemaRoute)) {
    throw new ReleaseAssemblyError(
      "ARGUMENT_ERROR",
      "--schema-route must be standard16-19 or direct14-19",
    );
  }
  return `${schemaRoute === DIRECT14_RELEASE_SCHEMA_ROUTE ? DIRECT14_RELEASE_ARTIFACT_PREFIX : RELEASE_ARTIFACT_PREFIX}${sha}`;
}
export const RELEASE_MIGRATIONS = Object.freeze([
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
    ref === RELEASE_INTEGRATION_REF &&
    githubSha === sha;
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

function verifyMigrationInputs(source) {
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
    files.length !== RELEASE_MIGRATIONS.length ||
    files.some((file, index) => file !== RELEASE_MIGRATIONS[index])
  ) {
    throw new ReleaseAssemblyError(
      "SCHEMA_BOUNDARY_MISMATCH",
      "migration inputs must be the exact frozen 001-019 sequence",
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
  if (!Object.hasOwn(RELEASE_SCHEMA_BOUNDARIES, schemaRoute)) {
    throw new ReleaseAssemblyError(
      "ARGUMENT_ERROR",
      "--schema-route must be standard16-19 or direct14-19",
    );
  }
  const schemaBoundary = RELEASE_SCHEMA_BOUNDARIES[schemaRoute];
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
  verifyMigrationInputs(sourceRoot);

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
    for (const migration of RELEASE_MIGRATIONS) {
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
      ...(schemaRoute === DIRECT14_RELEASE_SCHEMA_ROUTE ? { schemaRoute } : {}),
      schemaBoundary,
      migrations: RELEASE_MIGRATIONS,
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

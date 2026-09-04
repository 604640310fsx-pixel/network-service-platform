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
  isForbiddenBundlePath,
  RELEASE_ARTIFACT_PREFIX,
  RELEASE_BUNDLE_FORMAT,
  RELEASE_INTEGRATION_REF,
  RELEASE_MIGRATIONS,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_JOB,
} from "./assemble-consolidated-release.mjs";

const REQUIRED_BUNDLE_PATHS = Object.freeze([
  "auth-service/dist/src/db.js",
  "auth-service/dist/src/server.js",
  "auth-service/package-lock.json",
  "auth-service/package.json",
  "website/dist/index.html",
  "website/package-lock.json",
  "website/package.json",
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
  "PRE_RELEASE_SCHEMA_BOUNDARY: 13",
  "CANDIDATE_SCHEMA_BOUNDARY: 14",
  "BACKGROUND_WRITERS: DISABLED",
  "ROLLBACK_ARTIFACT_COMPATIBILITY: MATCHED",
  "DATABASE_RESTORE_ELIGIBILITY: ENDED",
  "CLOSED_NGINX_INVARIANT",
  "OPEN_NGINX_INVARIANT",
  "MONITOR_AUTH_PROJECTION_STATUS: CONDITIONAL_BLOCKER",
  "MONITOR_API_ORIGIN: OMITTED_IN_QUIESCENT_MODE",
  "LOCAL_BUNDLE_RELEASE_USE: FORBIDDEN",
  "GITHUB_ARTIFACT_PROVENANCE: REQUIRED",
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

function assertExactMigrationFiles(directory, label) {
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
    files.length !== RELEASE_MIGRATIONS.length ||
    files.some((file, index) => file !== RELEASE_MIGRATIONS[index])
  ) {
    throw new ReleaseValidationError(
      "SCHEMA_BOUNDARY_MISMATCH",
      `${label} migrations must be the exact frozen 001-014 sequence`,
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

export function validateRepository({ source, expectedSha }) {
  const sourceRoot = existingDirectory(source, "source");
  const sha = normalizedExpectedSha(expectedSha);
  assertSourceRevision(sourceRoot, sha);
  assertExactMigrationFiles(
    join(sourceRoot, "auth-service/src/migrations"),
    "repository",
  );

  const databaseSource = readText(
    join(sourceRoot, "auth-service/src/db.ts"),
    "migration runner",
  );
  assertFragments(databaseSource, RELEASE_MIGRATIONS, "migration runner");
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

  const runbook = readText(
    join(sourceRoot, "docs/ops/consolidated-release-runbook.md"),
    "consolidated runbook",
  );
  assertFragments(runbook, REQUIRED_RUNBOOK_FRAGMENTS, "consolidated runbook");
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
      "assemble-consolidated-release.mjs",
      "python3 -m unittest discover -s monitoring/gateway/tests -v",
      "node --test monitoring/gateway/tests/static-app.test.cjs",
      "npm --prefix auth-service test",
      "node auth-service/dist/test/db.test.js",
      "node auth-service/dist/test/diagnosis/migration.test.js",
      "npm --prefix website test",
      "npm --prefix website run check",
      "npm --prefix website run build",
      'PROVENANCE_MODE: ${{ github.event_name == \'push\' && github.ref == \'refs/heads/integration/consolidate-project\' && \'github-actions\' || \'github-actions-test\' }}',
      '--provenance-mode "$PROVENANCE_MODE"',
      '--validation-mode "$VALIDATION_MODE"',
      "actions/upload-artifact@v4",
      "consolidated-release-${{ env.EXPECTED_SHA }}",
      "github.sha == env.EXPECTED_SHA",
      'test "$GITHUB_SHA" = "$EXPECTED_SHA"',
      "artifact-digest",
    ],
    "CI workflow",
  );

  runTrafficGateValidation(sourceRoot);
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
    provenance.artifactName === `${RELEASE_ARTIFACT_PREFIX}${expectedSha}` &&
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
  githubArtifactId,
  artifactArchive,
  environment = process.env,
}) {
  const bundleRoot = existingDirectory(bundle, "bundle");
  const sha = normalizedExpectedSha(expectedSha);
  const manifest = parsedManifest(bundleRoot);

  if (
    Object.keys(manifest).sort().join(",") !==
      "entrypoints,format,inventory,migrations,provenance,schemaBoundary,sourceSha" ||
    manifest.format !== RELEASE_BUNDLE_FORMAT ||
    manifest.sourceSha !== sha ||
    typeof manifest.schemaBoundary !== "object" ||
    manifest.schemaBoundary === null ||
    Array.isArray(manifest.schemaBoundary) ||
    Object.keys(manifest.schemaBoundary).sort().join(",") !==
      "candidate,rollback" ||
    manifest.schemaBoundary?.rollback !== 13 ||
    manifest.schemaBoundary?.candidate !== 14 ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length !== RELEASE_MIGRATIONS.length ||
    manifest.migrations.some(
      (migration, index) => migration !== RELEASE_MIGRATIONS[index],
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
  for (const migration of RELEASE_MIGRATIONS) {
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
  );

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
  const repositoryResult = validateRepository({ source, expectedSha });
  const bundle = options.get("--bundle");
  if (bundle === undefined) {
    if (
      options.has("--validation-mode") ||
      options.has("--github-artifact-id") ||
      options.has("--artifact-archive")
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

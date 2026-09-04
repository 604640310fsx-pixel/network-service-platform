import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assembleReleaseBundle,
  isForbiddenBundlePath,
  RELEASE_MIGRATIONS,
} from "./assemble-consolidated-release.mjs";
import { validateBundle } from "./validate-consolidated-release-packet.mjs";

const ASSEMBLER_PATH = fileURLToPath(
  new URL("./assemble-consolidated-release.mjs", import.meta.url),
);
const VALIDATOR_PATH = fileURLToPath(
  new URL("./validate-consolidated-release-packet.mjs", import.meta.url),
);
const RUNBOOK_PATH = fileURLToPath(
  new URL("../../docs/ops/consolidated-release-runbook.md", import.meta.url),
);
const BINDINGS_PATH = fileURLToPath(
  new URL("../../docs/ops/consolidated-release-bindings.md", import.meta.url),
);
const LOCAL_PROVENANCE_MODE = "local-dry-run";
const SQLITE_BACKUP_SHA256_PROOF =
  "Snapshot mode 0600, bytes, SHA-256, quick check, foreign keys, and boundary 001-014 independently verify.";
const STALE_SQLITE_BACKUP_SHA256_PROOF =
  "Snapshot mode 0600, bytes, SHA-256, quick check, foreign keys, and boundary 001-013 independently verify.";

function githubEnvironment({ sha, candidate }) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "604640310fsx-pixel/network-service-platform",
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF:
      "604640310fsx-pixel/network-service-platform/.github/workflows/ci.yml@refs/heads/integration/consolidate-project",
    GITHUB_JOB: "consolidated-release-packet",
    GITHUB_EVENT_NAME: candidate ? "push" : "pull_request",
    GITHUB_REF: candidate
      ? "refs/heads/integration/consolidate-project"
      : "refs/pull/48/merge",
    GITHUB_SHA: candidate ? sha : "a".repeat(40),
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createArtifactArchive(bundle, archive) {
  const result = spawnSync("zip", ["-X", "-q", "-r", archive, "."], {
    cwd: bundle,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
}

function installFakeGithub(parent, { artifact, workflowRun }) {
  const bin = join(parent, "fake-bin");
  const command = join(bin, "gh");
  mkdirSync(bin);
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      '[ "$1" = "api" ] || exit 11',
      '[ "$2" = "--hostname" ] || exit 12',
      '[ "$3" = "github.com" ] || exit 13',
      'case "$4" in',
      '  */actions/artifacts/*) printf "%s" "$TEST_ARTIFACT_JSON" ;;',
      '  */actions/runs/*) printf "%s" "$TEST_WORKFLOW_RUN_JSON" ;;',
      "  *) exit 14 ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(command, 0o755);
  const previous = {
    path: process.env.PATH,
    ghHost: process.env.GH_HOST,
    artifact: process.env.TEST_ARTIFACT_JSON,
    workflowRun: process.env.TEST_WORKFLOW_RUN_JSON,
  };
  process.env.PATH = `${bin}:${previous.path ?? ""}`;
  process.env.GH_HOST = "untrusted.example.invalid";
  process.env.TEST_ARTIFACT_JSON = JSON.stringify(artifact);
  process.env.TEST_WORKFLOW_RUN_JSON = JSON.stringify(workflowRun);
  return () => {
    for (const [name, value] of [
      ["PATH", previous.path],
      ["GH_HOST", previous.ghHost],
      ["TEST_ARTIFACT_JSON", previous.artifact],
      ["TEST_WORKFLOW_RUN_JSON", previous.workflowRun],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

function writeFixtureFile(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function runGit(root, ...arguments_) {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=test@example.invalid",
      ...arguments_,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createFixtureRepository(parent) {
  const root = join(parent, "source");
  mkdirSync(root);
  writeFixtureFile(
    root,
    "auth-service/dist/src/db.js",
    "export const db = true;\n",
  );
  writeFixtureFile(
    root,
    "auth-service/dist/src/server.js",
    "export const server = true;\n",
  );
  writeFixtureFile(root, "auth-service/package.json", '{"type":"module"}\n');
  writeFixtureFile(
    root,
    "auth-service/package-lock.json",
    '{"lockfileVersion":3}\n',
  );
  for (const migration of RELEASE_MIGRATIONS) {
    writeFixtureFile(
      root,
      `auth-service/src/migrations/${migration}`,
      `-- ${migration}\n`,
    );
  }
  writeFixtureFile(
    root,
    "website/dist/index.html",
    "<!doctype html><title>fixture</title>\n",
  );
  writeFixtureFile(root, "website/dist/assets/app.js", "export {};\n");
  writeFixtureFile(root, "website/package.json", '{"type":"module"}\n');
  writeFixtureFile(root, "website/package-lock.json", '{"lockfileVersion":3}\n');

  // These user/runtime files are outside the explicit release mappings.
  writeFixtureFile(
    root,
    ".gitignore",
    "auth-service/dist\nwebsite/dist\nnode_modules\n.env\n*.sqlite\n",
  );
  writeFixtureFile(root, ".env", "EXAMPLE_FLAG=fixture\n");
  writeFixtureFile(root, "customer-notes.txt", "fixture user file\n");
  writeFixtureFile(root, "runtime.sqlite", "fixture database\n");
  writeFixtureFile(root, "node_modules/example/index.js", "export {};\n");

  runGit(root, "init", "--initial-branch=main");
  runGit(root, "add", "--all");
  runGit(root, "commit", "-m", "fixture");
  return { root, sha: runGit(root, "rev-parse", "HEAD") };
}

function allFiles(root, relative = "") {
  const entries = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      entries.push(...allFiles(root, child));
    } else {
      entries.push(child);
    }
  }
  return entries.sort();
}

test("release migrations independently pin the exact continuous 001-015 sequence", () => {
  assert.equal(RELEASE_MIGRATIONS.length, 15);
  assert.equal(
    RELEASE_MIGRATIONS.at(-1),
    "015_diagnosis_request_idempotency.sql",
  );
  assert.deepEqual(
    RELEASE_MIGRATIONS.map((migration, index) => {
      const version = index + 1;
      assert.equal(
        migration.startsWith(`${String(version).padStart(3, "0")}_`),
        true,
      );
      return version;
    }),
    Array.from({ length: 15 }, (_, index) => index + 1),
  );
});

test("two independent assemblies produce one deterministic, complete manifest", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-test-"));
  try {
    const fixture = createFixtureRepository(parent);
    const first = join(parent, "bundle-first");
    const second = join(parent, "bundle-second");
    const firstResult = assembleReleaseBundle({
      source: fixture.root,
      destination: first,
      expectedSha: fixture.sha,
      provenanceMode: LOCAL_PROVENANCE_MODE,
    });
    const secondResult = assembleReleaseBundle({
      source: fixture.root,
      destination: second,
      expectedSha: fixture.sha,
      provenanceMode: LOCAL_PROVENANCE_MODE,
    });

    assert.deepEqual(firstResult, secondResult);
    assert.equal(
      readFileSync(join(first, "release-manifest.json"), "utf8"),
      readFileSync(join(second, "release-manifest.json"), "utf8"),
    );
    const manifest = JSON.parse(
      readFileSync(join(first, "release-manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest.migrations, RELEASE_MIGRATIONS);
    assert.deepEqual(manifest.schemaBoundary, {
      rollback: 14,
      candidate: 15,
    });
    assert.equal(
      validateBundle({
        bundle: first,
        expectedSha: fixture.sha,
        validationMode: "local-dry-run",
      }).status,
      "ok",
    );
    assert.equal(
      validateBundle({
        bundle: second,
        expectedSha: fixture.sha,
        validationMode: "local-dry-run",
      }).status,
      "ok",
    );

    const files = allFiles(first);
    assert.ok(files.includes("auth-service/dist/src/server.js"));
    assert.ok(files.includes("website/dist/index.html"));
    assert.ok(files.includes("release-manifest.json"));
    assert.equal(files.some((path) => isForbiddenBundlePath(path)), false);
    assert.equal(files.includes("customer-notes.txt"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("assembler rejects missing, extra, or wrong Migration 015 inputs", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-schema-"));
  const cases = [
    {
      name: "missing",
      mutate(root) {
        rmSync(
          join(
            root,
            "auth-service/src/migrations/015_diagnosis_request_idempotency.sql",
          ),
        );
      },
    },
    {
      name: "extra",
      mutate(root) {
        writeFixtureFile(
          root,
          "auth-service/src/migrations/016_unexpected.sql",
          "-- unexpected migration\n",
        );
      },
    },
    {
      name: "wrong",
      mutate(root) {
        rmSync(
          join(
            root,
            "auth-service/src/migrations/015_diagnosis_request_idempotency.sql",
          ),
        );
        writeFixtureFile(
          root,
          "auth-service/src/migrations/015_wrong.sql",
          "-- wrong migration\n",
        );
      },
    },
  ];

  try {
    for (const scenario of cases) {
      const scenarioParent = join(parent, scenario.name);
      mkdirSync(scenarioParent);
      const fixture = createFixtureRepository(scenarioParent);
      scenario.mutate(fixture.root);
      runGit(fixture.root, "add", "--all");
      runGit(fixture.root, "commit", "-m", `${scenario.name} migration`);
      const sha = runGit(fixture.root, "rev-parse", "HEAD");
      const destination = join(scenarioParent, "bundle");
      assert.throws(
        () =>
          assembleReleaseBundle({
            source: fixture.root,
            destination,
            expectedSha: sha,
            provenanceMode: LOCAL_PROVENANCE_MODE,
          }),
        (error) => error?.code === "SCHEMA_BOUNDARY_MISMATCH",
      );
      assert.equal(existsSync(destination), false);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("assembler rejects an existing destination, a wrong SHA, and a dirty source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-gates-"));
  try {
    const fixture = createFixtureRepository(parent);
    const existing = join(parent, "existing");
    mkdirSync(existing);
    assert.throws(
      () =>
        assembleReleaseBundle({
          source: fixture.root,
          destination: existing,
          expectedSha: fixture.sha,
          provenanceMode: LOCAL_PROVENANCE_MODE,
        }),
      (error) => error?.code === "DESTINATION_EXISTS",
    );

    const wrongShaDestination = join(parent, "wrong-sha");
    assert.throws(
      () =>
        assembleReleaseBundle({
          source: fixture.root,
          destination: wrongShaDestination,
          expectedSha: "0".repeat(40),
          provenanceMode: LOCAL_PROVENANCE_MODE,
        }),
      (error) => error?.code === "SHA_MISMATCH",
    );
    assert.equal(existsSync(wrongShaDestination), false);

    writeFixtureFile(fixture.root, "uncommitted.txt", "dirty\n");
    const dirtyDestination = join(parent, "dirty");
    assert.throws(
      () =>
        assembleReleaseBundle({
          source: fixture.root,
          destination: dirtyDestination,
          expectedSha: fixture.sha,
          provenanceMode: LOCAL_PROVENANCE_MODE,
        }),
      (error) => error?.code === "SOURCE_DIRTY",
    );
    assert.equal(existsSync(dirtyDestination), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bundle validation rejects an artifact changed after assembly", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-tamper-"));
  try {
    const fixture = createFixtureRepository(parent);
    const bundle = join(parent, "bundle");
    assembleReleaseBundle({
      source: fixture.root,
      destination: bundle,
      expectedSha: fixture.sha,
      provenanceMode: LOCAL_PROVENANCE_MODE,
    });
    writeFileSync(join(bundle, "website/dist/index.html"), "tampered\n", "utf8");
    assert.throws(
      () =>
        validateBundle({
          bundle,
          expectedSha: fixture.sha,
          validationMode: "local-dry-run",
        }),
      (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bundle validation rejects Migration 015 drift and every old 13/14 boundary", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-bundle-schema-"));
  try {
    const fixture = createFixtureRepository(parent);
    const baseline = join(parent, "bundle-baseline");
    assembleReleaseBundle({
      source: fixture.root,
      destination: baseline,
      expectedSha: fixture.sha,
      provenanceMode: LOCAL_PROVENANCE_MODE,
    });

    const migrationRelative =
      "auth-service/src/migrations/015_diagnosis_request_idempotency.sql";
    const bundleCases = [
      {
        name: "missing",
        mutate(bundle) {
          rmSync(join(bundle, migrationRelative));
        },
      },
      {
        name: "extra",
        mutate(bundle) {
          writeFixtureFile(
            bundle,
            "auth-service/src/migrations/016_unexpected.sql",
            "-- unexpected migration\n",
          );
        },
      },
      {
        name: "wrong",
        mutate(bundle) {
          rmSync(join(bundle, migrationRelative));
          writeFixtureFile(
            bundle,
            "auth-service/src/migrations/015_wrong.sql",
            "-- wrong migration\n",
          );
        },
      },
    ];
    for (const scenario of bundleCases) {
      const bundle = join(parent, `bundle-${scenario.name}`);
      cpSync(baseline, bundle, { recursive: true });
      scenario.mutate(bundle);
      assert.throws(
        () =>
          validateBundle({
            bundle,
            expectedSha: fixture.sha,
            validationMode: "local-dry-run",
          }),
        (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
      );
    }

    for (const [name, schemaBoundary] of [
      ["wrong-rollback", { rollback: 13, candidate: 15 }],
      ["wrong-candidate", { rollback: 14, candidate: 14 }],
      ["old-shared-boundary", { rollback: 13, candidate: 14 }],
    ]) {
      const bundle = join(parent, `bundle-${name}`);
      cpSync(baseline, bundle, { recursive: true });
      const manifestPath = join(bundle, "release-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.schemaBoundary = schemaBoundary;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      assert.throws(
        () =>
          validateBundle({
            bundle,
            expectedSha: fixture.sha,
            validationMode: "local-dry-run",
          }),
        (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runbook and bindings describe rollback 014 and candidate 015 consistently", () => {
  const runbook = readFileSync(RUNBOOK_PATH, "utf8");
  for (const fragment of [
    "PRE_RELEASE_SCHEMA_BOUNDARY: 14",
    "CANDIDATE_SCHEMA_BOUNDARY: 15",
    "migrations 001-015",
    "continuous prefix 001-014",
    "continuous migrations through 014",
    "Startup may apply migration 015",
    "migration prefix 001-015",
    "Never open the old binary on a database containing migration 015",
  ]) {
    assert.equal(runbook.includes(fragment), true, fragment);
  }

  const bindings = readFileSync(BINDINGS_PATH, "utf8");
  for (const fragment of [
    "migrations 001-015 match inventory",
    "compatible with continuous migrations 001-014",
    "loopback health, schema 001-015",
    SQLITE_BACKUP_SHA256_PROOF,
  ]) {
    assert.equal(bindings.includes(fragment), true, fragment);
  }
  assert.equal(
    bindings.includes(STALE_SQLITE_BACKUP_SHA256_PROOF),
    false,
    "stale backup boundary must be absent",
  );

  const validatorSource = readFileSync(VALIDATOR_PATH, "utf8");
  assert.equal(
    validatorSource.includes(SQLITE_BACKUP_SHA256_PROOF),
    true,
    "repository validator must require the exact backup proof",
  );
});

test("assembler rejects a symbolic link in a mapped ignored artifact path", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-link-"));
  try {
    const fixture = createFixtureRepository(parent);
    const linkedWebsite = join(parent, "linked-website");
    writeFixtureFile(linkedWebsite, "index.html", "linked content\n");
    rmSync(join(fixture.root, "website/dist"), {
      recursive: true,
      force: true,
    });
    symlinkSync(linkedWebsite, join(fixture.root, "website/dist"), "dir");

    assert.throws(
      () =>
        assembleReleaseBundle({
          source: fixture.root,
          destination: join(parent, "bundle"),
          expectedSha: fixture.sha,
          provenanceMode: LOCAL_PROVENANCE_MODE,
        }),
      (error) => error?.code === "SOURCE_INVALID",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ignored build replacement cannot pass candidate provenance", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-origin-"));
  let restoreEnvironment = () => {};
  try {
    const fixture = createFixtureRepository(parent);
    const environment = githubEnvironment({ sha: fixture.sha, candidate: true });
    const first = join(parent, "bundle-first");
    const second = join(parent, "bundle-second");
    assembleReleaseBundle({
      source: fixture.root,
      destination: first,
      expectedSha: fixture.sha,
      provenanceMode: "github-actions",
      environment,
    });
    const archive = join(parent, "candidate.zip");
    const artifactId = "777";
    createArtifactArchive(first, archive);
    restoreEnvironment = installFakeGithub(parent, {
      artifact: {
        id: Number(artifactId),
        name: `consolidated-release-${fixture.sha}`,
        expired: false,
        digest: `sha256:${sha256(archive)}`,
        workflow_run: { id: 123456789, head_sha: fixture.sha },
      },
      workflowRun: {
        id: 123456789,
        repository: {
          full_name: "604640310fsx-pixel/network-service-platform",
        },
        path: ".github/workflows/ci.yml",
        event: "push",
        head_branch: "integration/consolidate-project",
        head_sha: fixture.sha,
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
      },
    });
    const verifiedCandidate = validateBundle({
      bundle: first,
      expectedSha: fixture.sha,
      validationMode: "candidate",
      githubArtifactId: artifactId,
      artifactArchive: archive,
    });
    assert.equal(verifiedCandidate.status, "ok");
    assert.equal(verifiedCandidate.candidateVerified, true);
    writeFileSync(
      join(fixture.root, "website/dist/index.html"),
      "<!doctype html><title>replaced ignored build</title>\n",
      "utf8",
    );
    assert.equal(
      runGit(fixture.root, "status", "--porcelain=v1", "--untracked-files=all"),
      "",
    );
    assembleReleaseBundle({
      source: fixture.root,
      destination: second,
      expectedSha: fixture.sha,
      provenanceMode: "github-actions",
      environment,
    });

    const firstManifest = readFileSync(
      join(first, "release-manifest.json"),
      "utf8",
    );
    const secondManifest = readFileSync(
      join(second, "release-manifest.json"),
      "utf8",
    );
    assert.notEqual(firstManifest, secondManifest);
    assert.deepEqual(
      JSON.parse(firstManifest).provenance,
      JSON.parse(secondManifest).provenance,
    );
    assert.throws(
      () =>
        validateBundle({
          bundle: second,
          expectedSha: fixture.sha,
          validationMode: "candidate",
          githubArtifactId: artifactId,
          artifactArchive: archive,
        }),
      (error) => error?.code === "PROVENANCE_REQUIRED",
    );
  } finally {
    restoreEnvironment();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("candidate validation rejects ZIP payload tampering under the same manifest", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-zip-"));
  let restoreEnvironment = () => {};
  try {
    const fixture = createFixtureRepository(parent);
    const bundle = join(parent, "bundle");
    assembleReleaseBundle({
      source: fixture.root,
      destination: bundle,
      expectedSha: fixture.sha,
      provenanceMode: "github-actions",
      environment: githubEnvironment({ sha: fixture.sha, candidate: true }),
    });
    const tampered = join(parent, "tampered");
    cpSync(bundle, tampered, { recursive: true });
    writeFileSync(
      join(tampered, "website/dist/index.html"),
      "same manifest and paths, different payload\n",
      "utf8",
    );
    const archive = join(parent, "tampered.zip");
    createArtifactArchive(tampered, archive);
    const artifactId = "778";
    restoreEnvironment = installFakeGithub(parent, {
      artifact: {
        id: Number(artifactId),
        name: `consolidated-release-${fixture.sha}`,
        expired: false,
        digest: `sha256:${sha256(archive)}`,
        workflow_run: { id: 123456789, head_sha: fixture.sha },
      },
      workflowRun: {
        id: 123456789,
        repository: {
          full_name: "604640310fsx-pixel/network-service-platform",
        },
        path: ".github/workflows/ci.yml",
        event: "push",
        head_branch: "integration/consolidate-project",
        head_sha: fixture.sha,
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
      },
    });

    assert.throws(
      () =>
        validateBundle({
          bundle,
          expectedSha: fixture.sha,
          validationMode: "candidate",
          githubArtifactId: artifactId,
          artifactArchive: archive,
        }),
      (error) =>
        error?.code === "PROVENANCE_REQUIRED" &&
        /payload failed verification/.test(error.message),
    );
  } finally {
    restoreEnvironment();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("PR and task contexts cannot claim release-candidate provenance", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-pr-"));
  try {
    const fixture = createFixtureRepository(parent);
    assert.throws(
      () =>
        assembleReleaseBundle({
          source: fixture.root,
          destination: join(parent, "bundle"),
          expectedSha: fixture.sha,
          provenanceMode: "github-actions",
          environment: githubEnvironment({
            sha: fixture.sha,
            candidate: false,
          }),
        }),
      (error) => error?.code === "PROVENANCE_REQUIRED",
    );
    const testEnvironment = githubEnvironment({
      sha: fixture.sha,
      candidate: false,
    });
    const testBundle = join(parent, "test-bundle");
    assembleReleaseBundle({
      source: fixture.root,
      destination: testBundle,
      expectedSha: fixture.sha,
      provenanceMode: "github-actions-test",
      environment: testEnvironment,
    });
    assert.equal(
      validateBundle({
        bundle: testBundle,
        expectedSha: fixture.sha,
        validationMode: "ci-test",
        environment: testEnvironment,
      }).releaseUse,
      "forbidden",
    );
    assert.throws(
      () =>
        validateBundle({
          bundle: testBundle,
          expectedSha: fixture.sha,
          validationMode: "candidate",
        }),
      (error) => error?.code === "PROVENANCE_REQUIRED",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("CLI entrypoints execute through symbolic-link paths", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-link-"));
  try {
    const fixture = createFixtureRepository(parent);
    const assemblerLink = join(parent, "assemble-release.mjs");
    const validatorLink = join(parent, "validate-release.mjs");
    const bundle = join(parent, "bundle");
    symlinkSync(ASSEMBLER_PATH, assemblerLink, "file");
    symlinkSync(VALIDATOR_PATH, validatorLink, "file");

    const assembled = spawnSync(
      process.execPath,
      [
        assemblerLink,
        "--source",
        fixture.root,
        "--destination",
        bundle,
        "--expected-sha",
        fixture.sha,
        "--provenance-mode",
        LOCAL_PROVENANCE_MODE,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(assembled.status, 0, assembled.stderr);
    assert.equal(JSON.parse(assembled.stdout).status, "ok");
    assert.equal(existsSync(join(bundle, "release-manifest.json")), true);

    const rejected = spawnSync(process.execPath, [validatorLink], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(JSON.parse(rejected.stderr).code, "ARGUMENT_ERROR");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

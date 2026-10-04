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
  createReleaseProvenance,
  DIRECT14_19_RELEASE_SCHEMA_ROUTE,
  DIRECT14_RELEASE_SCHEMA_ROUTE,
  isForbiddenBundlePath,
  RELEASE_HTTP_CONTRACT_PATHS,
  RELEASE_MIGRATIONS,
  DIRECT14_20_RELEASE_SCHEMA_ROUTE,
  RELEASE_MIGRATIONS_001_019,
  RELEASE_MIGRATIONS_001_020,
  RELEASE_MIGRATIONS_001_021,
  RELEASE_MIGRATIONS_001_022,
  DIRECT14_21_RELEASE_SCHEMA_ROUTE,
  DIRECT14_22_RELEASE_SCHEMA_ROUTE,
  STANDARD16_19_RELEASE_SCHEMA_ROUTE,
  STANDARD16_20_RELEASE_SCHEMA_ROUTE,
  STANDARD16_21_RELEASE_SCHEMA_ROUTE,
  STANDARD19_20_RELEASE_SCHEMA_ROUTE,
  STANDARD19_21_RELEASE_SCHEMA_ROUTE,
  STANDARD16_22_RELEASE_SCHEMA_ROUTE,
  STANDARD19_22_RELEASE_SCHEMA_ROUTE,
  STANDARD16_23_RELEASE_SCHEMA_ROUTE,
  STANDARD19_23_RELEASE_SCHEMA_ROUTE,
  DIRECT14_23_RELEASE_SCHEMA_ROUTE,
  RELEASE_MIGRATIONS_001_023,
  RELEASE_MIGRATIONS_001_024,
  STANDARD16_24_RELEASE_SCHEMA_ROUTE,
  STANDARD19_24_RELEASE_SCHEMA_ROUTE,
  DIRECT14_24_RELEASE_SCHEMA_ROUTE,
  STANDARD16_25_RELEASE_SCHEMA_ROUTE,
  STANDARD19_25_RELEASE_SCHEMA_ROUTE,
  DIRECT14_25_RELEASE_SCHEMA_ROUTE,
  RELEASE_MIGRATIONS_001_025,
  STANDARD16_26_RELEASE_SCHEMA_ROUTE,
  STANDARD19_26_RELEASE_SCHEMA_ROUTE,
  DIRECT14_26_RELEASE_SCHEMA_ROUTE,
} from "./assemble-consolidated-release.mjs";
import {
  validateBundle,
  validateMonitorAuthProjectionSources,
} from "./validate-consolidated-release-packet.mjs";
import {
  createSanitizedSyntheticRender,
  OPEN_HTTP_PLACEHOLDERS,
  run as runOpenHttpContract,
  validateRenderedSources,
  validateTemplateSources,
  validateDualDirectTemplateSources,
} from "./validate-release-open-http-contract.mjs";

const ASSEMBLER_PATH = fileURLToPath(
  new URL("./assemble-consolidated-release.mjs", import.meta.url),
);
const VALIDATOR_PATH = fileURLToPath(
  new URL("./validate-consolidated-release-packet.mjs", import.meta.url),
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNBOOK_PATH = fileURLToPath(
  new URL("../../docs/ops/consolidated-release-runbook.md", import.meta.url),
);
const BINDINGS_PATH = fileURLToPath(
  new URL("../../docs/ops/consolidated-release-bindings.md", import.meta.url),
);
const LOCAL_PROVENANCE_MODE = "local-dry-run";
const SQLITE_BACKUP_SHA256_PROOF =
  "Snapshot mode 0600, bytes, SHA-256, quick check, foreign keys, and boundary 001-016 independently verify.";
const STALE_SQLITE_BACKUP_SHA256_PROOF =
  "Snapshot mode 0600, bytes, SHA-256, quick check, foreign keys, and boundary 001-015 independently verify.";

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

function contractSources() {
  return {
    openTemplate: readFileSync(
      join(REPOSITORY_ROOT, "ops/nginx/release-traffic-open.conf.example"),
      "utf8",
    ),
    dualTemplate: readFileSync(
      join(REPOSITORY_ROOT, "ops/nginx/release-traffic-dual-direct.conf.example"),
      "utf8",
    ),
    bareTemplate: readFileSync(
      join(REPOSITORY_ROOT, "ops/nginx/bare-domain-redirect.conf.example"),
      "utf8",
    ),
    closedCandidate: readFileSync(
      join(REPOSITORY_ROOT, "ops/nginx/release-traffic-closed.conf.example"),
      "utf8",
    ),
  };
}

function replaceTokens(source, replacements) {
  let rendered = source;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

function renderedContract(websiteRoot) {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender({ websiteRoot });
  return {
    ...sources,
    openConfig: replaceTokens(sources.openTemplate, synthetic.replacements),
    bareConfig: replaceTokens(sources.bareTemplate, synthetic.replacements),
    expected: synthetic.expected,
  };
}

function expectContractFailure(callback, expectedCode) {
  assert.throws(
    callback,
    (error) => error?.code === expectedCode,
    `expected open HTTP contract failure ${expectedCode}`,
  );
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

function createFixtureRepository(parent, migrations = RELEASE_MIGRATIONS) {
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
  for (const migration of migrations) {
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
  writeFixtureFile(
    root,
    "website/dist/referral.html",
    '<!doctype html><script type="module" src="/assets/referral-12345678.js"></script>\n',
  );
  writeFixtureFile(root, "website/dist/assets/referral-12345678.js", "export {};\n");
  writeFixtureFile(root, "website/dist/assets/app.js", "export {};\n");
  writeFixtureFile(root, "website/package.json", '{"type":"module"}\n');
  writeFixtureFile(root, "website/package-lock.json", '{"lockfileVersion":3}\n');
  for (const relativePath of RELEASE_HTTP_CONTRACT_PATHS) {
    writeFixtureFile(
      root,
      relativePath,
      readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8"),
    );
  }

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

test("release migrations independently pin the exact continuous 001-026 sequence", () => {
  assert.equal(RELEASE_MIGRATIONS.length, 26);
  assert.equal(RELEASE_MIGRATIONS.at(-1), "026_wallet.sql");
  // The historical 001-019 through 001-025 sequences stay frozen as exact prefixes.
  assert.equal(RELEASE_MIGRATIONS_001_025.length, 25);
  assert.equal(RELEASE_MIGRATIONS_001_025.at(-1), "025_ticket_attachments_and_grant_link.sql");
  assert.deepEqual(RELEASE_MIGRATIONS.slice(0, 25), [...RELEASE_MIGRATIONS_001_025]);
  assert.equal(RELEASE_MIGRATIONS_001_024.length, 24);
  assert.equal(RELEASE_MIGRATIONS_001_024.at(-1), "024_grant_delivery_monitor_target.sql");
  assert.deepEqual(RELEASE_MIGRATIONS.slice(0, 24), [...RELEASE_MIGRATIONS_001_024]);
  assert.equal(RELEASE_MIGRATIONS_001_023.length, 23);
  assert.equal(RELEASE_MIGRATIONS_001_023.at(-1), "023_admin_grant_delivery.sql");
  assert.deepEqual(RELEASE_MIGRATIONS.slice(0, 23), [...RELEASE_MIGRATIONS_001_023]);
  assert.equal(RELEASE_MIGRATIONS_001_022.length, 22);
  assert.equal(RELEASE_MIGRATIONS_001_022.at(-1), "022_admin_service_management.sql");
  assert.deepEqual(RELEASE_MIGRATIONS.slice(0, 22), [...RELEASE_MIGRATIONS_001_022]);
  assert.equal(RELEASE_MIGRATIONS_001_021.length, 21);
  assert.equal(RELEASE_MIGRATIONS_001_021.at(-1), "021_personal_invites.sql");
  assert.deepEqual(RELEASE_MIGRATIONS.slice(0, 21), [...RELEASE_MIGRATIONS_001_021]);
  assert.equal(RELEASE_MIGRATIONS_001_020.length, 20);
  assert.equal(RELEASE_MIGRATIONS_001_020.at(-1), "020_tickets.sql");
  assert.deepEqual(RELEASE_MIGRATIONS.slice(0, 20), [...RELEASE_MIGRATIONS_001_020]);
  assert.equal(RELEASE_MIGRATIONS_001_019.length, 19);
  assert.equal(
    RELEASE_MIGRATIONS_001_019.at(-1),
    "019_referral_candidate_owner_page_index.sql",
  );
  assert.deepEqual(RELEASE_MIGRATIONS.slice(0, 19), [...RELEASE_MIGRATIONS_001_019]);
  assert.deepEqual(
    RELEASE_MIGRATIONS.map((migration, index) => {
      const version = index + 1;
      assert.equal(
        migration.startsWith(`${String(version).padStart(3, "0")}_`),
        true,
      );
      return version;
    }),
    Array.from({ length: 26 }, (_, index) => index + 1),
  );
});

test("open HTTP templates freeze the exact value-free placeholder inventory", () => {
  const baseline = contractSources();
  assert.equal(validateTemplateSources(baseline).status, "ok");

  const missing = {
    ...baseline,
    openTemplate: baseline.openTemplate.replace(
      OPEN_HTTP_PLACEHOLDERS.websiteRoot,
      "",
    ),
  };
  expectContractFailure(
    () => validateTemplateSources(missing),
    "TEMPLATE_PLACEHOLDER_INVALID",
  );

  const unknown = {
    ...baseline,
    openTemplate: `${baseline.openTemplate}\n# __OPEN_UNKNOWN_VALUE__\n`,
  };
  expectContractFailure(
    () => validateTemplateSources(unknown),
    "TEMPLATE_PLACEHOLDER_INVALID",
  );

  const excess = {
    ...baseline,
    bareTemplate: `${baseline.bareTemplate}\n# ${OPEN_HTTP_PLACEHOLDERS.bareHost}\n`,
  };
  expectContractFailure(
    () => validateTemplateSources(excess),
    "TEMPLATE_PLACEHOLDER_INVALID",
  );
});

test("dual-direct is opt-in and preserves both hostnames", () => {
  const baseline = contractSources();
  assert.equal(validateTemplateSources(baseline).status, "ok");
  assert.equal(validateDualDirectTemplateSources(baseline).status, "ok");
  const synthetic = createSanitizedSyntheticRender();
  const openConfig = replaceTokens(baseline.dualTemplate, synthetic.replacements);
  const input = {
    openConfig,
    closedCandidate: baseline.closedCandidate,
    expected: synthetic.expected,
    mode: "dual-direct",
  };
  assert.equal(validateRenderedSources(input).topology, "open-dual-direct");
  const additionalCaseVariant = synthetic.expected.cspPolicy.replace(
    "frame-src",
    "Connect-Src 'self'; frame-src",
  );
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: openConfig.replace(synthetic.expected.cspPolicy, additionalCaseVariant),
    expected: { ...synthetic.expected, cspPolicy: additionalCaseVariant },
  }), "OPEN_SECURITY_INVALID");
  for (const mutated of [
    openConfig.replace("return 301 https://$host$request_uri;", "return 308 https://$host$request_uri;"),
    openConfig.replace("return 301 https://$host$request_uri;", "return 301 https://" + synthetic.expected.canonicalHost + "$request_uri;"),
    openConfig.replace("server_name " + synthetic.expected.bareHost + " " + synthetic.expected.canonicalHost + ";", "server_name " + synthetic.expected.canonicalHost + ";"),
  ]) {
    expectContractFailure(
      () => validateRenderedSources({ ...input, openConfig: mutated }),
      "OPEN_TOPOLOGY_INVALID",
    );
  }
  expectContractFailure(
    () => validateDualDirectTemplateSources({
      ...baseline,
      dualTemplate: baseline.dualTemplate.replace(OPEN_HTTP_PLACEHOLDERS.bareHost, "bare.example.invalid"),
    }),
    "TEMPLATE_PLACEHOLDER_INVALID",
  );
  expectContractFailure(
    () => validateRenderedSources({
      ...input,
      closedCandidate: baseline.closedCandidate.replace("return 503;", "return 200;"),
    }),
    "OPEN_CLOSED_CONFLICT",
  );
});

test("dual-direct can explicitly preserve absent framing and HSTS declarations with context proof", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const openConfig = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
  });
  const otherServer = "\nserver { listen 8080; server_name unrelated.example.invalid; return 204; }\n";
  const expected = {
    ...synthetic.expected,
    framingPolicy: "preserve-existing",
    hstsOwner: "preserve-existing",
    hstsValue: "preserve-existing",
  };
  const input = {
    openConfig,
    closedCandidate: sources.closedCandidate,
    expected,
    mode: "dual-direct",
    existingContext: openConfig + otherServer,
    candidateContext: openConfig + otherServer,
  };
  assert.equal(validateRenderedSources(input).effectiveInheritedSecurityPolicy, "UNVERIFIED");
  assert.equal(validateRenderedSources({
    ...input,
    existingContext: `http {\n${input.existingContext}\n}`,
    candidateContext: `http {\n${input.candidateContext}\n}`,
  }).effectiveInheritedSecurityPolicy, "UNVERIFIED");
  const parent = mkdtempSync(join(tmpdir(), "dual-direct-preserve-"));
  try {
    for (const [name, content] of Object.entries({
      "open.conf": openConfig,
      "closed.conf": sources.closedCandidate,
      "expected.json": JSON.stringify(expected),
      "existing.conf": input.existingContext,
      "candidate.conf": input.candidateContext,
    })) {
      writeFileSync(join(parent, name), content);
    }
    assert.equal(runOpenHttpContract([
      "--mode", "dual-direct",
      "--open-config", join(parent, "open.conf"),
      "--closed-config", join(parent, "closed.conf"),
      "--expected-metadata", join(parent, "expected.json"),
      "--existing-context", join(parent, "existing.conf"),
      "--candidate-context", join(parent, "candidate.conf"),
    ]).effectiveInheritedSecurityPolicy, "UNVERIFIED");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  expectContractFailure(
    () => validateRenderedSources({ ...input, existingContext: undefined }),
    "ARGUMENT_ERROR",
  );
  expectContractFailure(
    () => validateRenderedSources({ ...input, expected: synthetic.expected, existingContext: undefined, candidateContext: undefined }),
    "OPEN_SECURITY_INVALID",
  );
  expectContractFailure(
    () => validateRenderedSources({ ...input, mode: "canonical", bareConfig: openConfig }),
    "ARGUMENT_ERROR",
  );
  expectContractFailure(
    () => validateRenderedSources({ ...input, expected: { ...expected, hstsValue: synthetic.expected.hstsValue } }),
    "ARGUMENT_ERROR",
  );
  for (const directive of [
    'add_header X-Frame-Options "SAMEORIGIN" always;',
    'add_header Strict-Transport-Security "max-age=31536000" always;',
  ]) {
    const mutated = openConfig.replace("    location = /api {", `    ${directive}\n    location = /api {`);
    expectContractFailure(
      () => validateRenderedSources({ ...input, openConfig: mutated, candidateContext: mutated + otherServer }),
      "PRESERVED_SECURITY_DRIFT",
    );
    expectContractFailure(
      () => validateRenderedSources({ ...input, existingContext: mutated + otherServer }),
      "PRESERVED_SECURITY_DRIFT",
    );
  }
});

test("preserve-existing keeps an explicitly absent connect-src without weakening other modes", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const withoutConnect = synthetic.expected.cspPolicy.replace("connect-src 'self'; ", "");
  const render = (csp) => replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: `"${csp}"`,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
  });
  const otherServer = "\nserver { listen 8080; server_name unrelated.example.invalid; return 204; }\n";
  const absentOpen = render(withoutConnect);
  const expected = {
    ...synthetic.expected,
    cspPolicy: withoutConnect,
    cspConnectSources: [],
    framingPolicy: "preserve-existing",
    hstsOwner: "preserve-existing",
    hstsValue: "preserve-existing",
  };
  const input = {
    openConfig: absentOpen,
    closedCandidate: sources.closedCandidate,
    expected,
    mode: "dual-direct",
    existingContext: absentOpen + otherServer,
    candidateContext: absentOpen + otherServer,
  };
  assert.equal(validateRenderedSources(input).effectiveInheritedSecurityPolicy, "UNVERIFIED");
  const parent = mkdtempSync(join(tmpdir(), "dual-direct-absent-connect-"));
  try {
    for (const [name, content] of Object.entries({
      "open.conf": absentOpen,
      "closed.conf": sources.closedCandidate,
      "expected.json": JSON.stringify(expected),
      "before.conf": input.existingContext,
      "candidate.conf": input.candidateContext,
    })) {
      writeFileSync(join(parent, name), content);
    }
    assert.equal(runOpenHttpContract([
      "--mode", "dual-direct",
      "--open-config", join(parent, "open.conf"),
      "--closed-config", join(parent, "closed.conf"),
      "--expected-metadata", join(parent, "expected.json"),
      "--existing-context", join(parent, "before.conf"),
      "--candidate-context", join(parent, "candidate.conf"),
    ]).effectiveInheritedSecurityPolicy, "UNVERIFIED");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  const presentOpen = render(synthetic.expected.cspPolicy);
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: presentOpen,
    expected: { ...expected, cspPolicy: synthetic.expected.cspPolicy },
    existingContext: presentOpen + otherServer,
    candidateContext: presentOpen + otherServer,
  }), "RENDERED_METADATA_MISMATCH");
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: presentOpen,
    expected: {
      ...expected,
      cspPolicy: synthetic.expected.cspPolicy,
      cspConnectSources: ["'self'"],
    },
    candidateContext: presentOpen + otherServer,
  }), "PRESERVED_SECURITY_DRIFT");
  const changedCsp = synthetic.expected.cspPolicy.replace("connect-src 'self'", "connect-src 'none'");
  const changedOpen = render(changedCsp);
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: changedOpen,
    expected: { ...expected, cspPolicy: changedCsp, cspConnectSources: ["'none'"] },
    existingContext: presentOpen + otherServer,
    candidateContext: changedOpen + otherServer,
  }), "PRESERVED_SECURITY_DRIFT");
  const malformedCsp = withoutConnect.replace("frame-src", "connect-src; frame-src");
  const malformedOpen = render(malformedCsp);
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: malformedOpen,
    expected: { ...expected, cspPolicy: malformedCsp },
    existingContext: malformedOpen + otherServer,
    candidateContext: malformedOpen + otherServer,
  }), "OPEN_SECURITY_INVALID");
  const disguisedCsp = withoutConnect.replace("frame-src", "Connect-Src 'self'; frame-src");
  const disguisedOpen = render(disguisedCsp);
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: disguisedOpen,
    expected: { ...expected, cspPolicy: disguisedCsp },
    existingContext: disguisedOpen + otherServer,
    candidateContext: disguisedOpen + otherServer,
  }), "OPEN_SECURITY_INVALID");
  for (const mode of ["dual-direct", "canonical"]) {
    expectContractFailure(() => validateRenderedSources({
      ...input,
      mode,
      bareConfig: mode === "canonical" ? presentOpen : undefined,
      expected: { ...synthetic.expected, cspConnectSources: [] },
    }), "ARGUMENT_ERROR");
  }
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: absentOpen,
    expected: { ...synthetic.expected, cspPolicy: withoutConnect },
    existingContext: undefined,
    candidateContext: undefined,
  }), "OPEN_SECURITY_INVALID");
});

test("preserve-existing keeps inherited compression and Vary in their original scope", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const csp = synthetic.expected.cspPolicy.replace("connect-src 'self'; ", "");
  const replacements = {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: `"${csp}"`,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.compressionDirectives]: "# OPEN_COMPRESSION_OWNER: preserve-existing",
  };
  const openConfig = replaceTokens(sources.dualTemplate, replacements);
  const otherServer = "server { listen 8080; server_name unrelated.example.invalid; return 204; }";
  const context = (target) => `http {\n gzip on;\n gzip_vary on;\n ${target}\n ${otherServer}\n}`;
  const input = {
    openConfig,
    closedCandidate: sources.closedCandidate,
    expected: {
      ...synthetic.expected,
      cspPolicy: csp,
      cspConnectSources: [],
      framingPolicy: "preserve-existing",
      hstsOwner: "preserve-existing",
      hstsValue: "preserve-existing",
      compressionOwner: "preserve-existing",
    },
    mode: "dual-direct",
    existingContext: context(openConfig),
    candidateContext: context(openConfig),
  };
  assert.equal(validateRenderedSources(input).effectiveInheritedCompressionPolicy, "UNVERIFIED");
  const withGzip = openConfig.replace("    location = /api {", "    gzip on;\n    location = /api {");
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: withGzip,
    candidateContext: context(withGzip),
  }), "PRESERVED_COMPRESSION_DRIFT");
  const withVary = openConfig.replace("    location = /api {", '    add_header Vary "Accept-Encoding" always;\n    location = /api {');
  expectContractFailure(() => validateRenderedSources({
    ...input,
    openConfig: withVary,
    candidateContext: context(withVary),
  }), "PRESERVED_COMPRESSION_DRIFT");
  expectContractFailure(() => validateRenderedSources({
    ...input,
    candidateContext: input.candidateContext.replace("gzip on;", "gzip off;"),
  }), "PRESERVED_CONTEXT_DRIFT");
  const ordinaryWithoutCompression = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.compressionDirectives]: "# OPEN_COMPRESSION_OWNER: canonical-https",
  });
  expectContractFailure(() => validateRenderedSources({
    openConfig: ordinaryWithoutCompression,
    closedCandidate: sources.closedCandidate,
    expected: synthetic.expected,
    mode: "dual-direct",
  }), "OPEN_COMPRESSION_INVALID");
});

test("preserve-existing keeps MIME and security headers in their bound scope", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const csp = "frame-src 'none'";
  const withPreserveBlocks = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.tlsDirectives]:
      synthetic.replacements[OPEN_HTTP_PLACEHOLDERS.tlsDirectives] + "\n    include /synthetic/tls.conf;",
    [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: `"${csp}"`,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.compressionDirectives]: "# OPEN_COMPRESSION_OWNER: preserve-existing",
  });
  const omitBlock = (source, name) => source.replace(
    new RegExp(`^    # OPEN_PRESERVE_${name}_BEGIN:[^\\n]*\\n[\\s\\S]*?^    # OPEN_PRESERVE_${name}_END\\n`, "m"),
    "",
  );
  const openConfig = omitBlock(omitBlock(withPreserveBlocks, "MIME"), "SECURITY_HEADERS");
  assert.doesNotMatch(openConfig, /OPEN_PRESERVE_(?:MIME|SECURITY_HEADERS)_BEGIN/);
  const context = (target) => `http {\n include mime.types;\n default_type text/plain;\n ${target}\n}`;
  const input = {
    openConfig,
    closedCandidate: sources.closedCandidate,
    expected: {
      ...synthetic.expected,
      cspPolicy: csp,
      cspConnectSources: [],
      framingPolicy: "preserve-existing",
      hstsOwner: "preserve-existing",
      hstsValue: "preserve-existing",
      compressionOwner: "preserve-existing",
    },
    mode: "dual-direct",
    existingContext: context(openConfig),
    candidateContext: context(openConfig),
  };
  const preserved = validateRenderedSources(input);
  assert.equal(preserved.effectiveInheritedMimePolicy, "UNVERIFIED");
  assert.equal(preserved.securityPolicyAdequacy, "UNVERIFIED");
  for (const name of ["Content-Type", "cOnTeNt-TyPe", "Content-Encoding", "Vary", "Cache-Control"]) {
    const hiddenApiHeader = openConfig.replace(
      "    location = /api {",
      `    proxy_hide_header ${name};\n    location = /api {`,
    );
    expectContractFailure(() => validateRenderedSources({
      ...input,
      openConfig: hiddenApiHeader,
      candidateContext: context(hiddenApiHeader),
    }), "OPEN_ROUTING_INVALID");
  }
  for (const directive of [
    "proxy_hide_header X-Synthetic-Internal;",
    "proxy_ignore_headers Cache-Control;",
  ]) {
    const unchanged = openConfig.replace("    location = /api {", `    ${directive}\n    location = /api {`);
    assert.equal(validateRenderedSources({
      ...input,
      openConfig: unchanged,
      existingContext: context(unchanged),
      candidateContext: context(unchanged),
    }).status, "ok");
  }
  const withCsp = (policy) => {
    const changed = openConfig.replace(csp, policy);
    return {
      ...input,
      openConfig: changed,
      existingContext: context(changed),
      candidateContext: context(changed),
      expected: { ...input.expected, cspPolicy: policy },
    };
  };
  for (const policy of [
    "frame-src 'none'; Script-Src data:",
    "frame-src 'none'; script-src 'Unsafe-Eval'",
    "frame-src 'none'; script-src 'self'; Script-Src 'self'",
  ]) {
    expectContractFailure(() => validateRenderedSources(withCsp(policy)), "OPEN_SECURITY_INVALID");
  }
  const mixedCasePolicy = "frame-src 'none'; Script-Src 'self' 'nonce-AbC+/=' https://Example.invalid/CasePath";
  assert.equal(validateRenderedSources(withCsp(mixedCasePolicy)).securityPolicyAdequacy, "UNVERIFIED");
  for (const [directive, failure] of [
    ["include mime.types;", "PRESERVED_SECURITY_DRIFT"],
    ["default_type application/octet-stream;", "PRESERVED_MIME_DRIFT"],
    ['add_header X-Content-Type-Options "nosniff" always;', "PRESERVED_SECURITY_DRIFT"],
  ]) {
    const changed = openConfig.replace("    location = /api {", `    ${directive}\n    location = /api {`);
    expectContractFailure(() => validateRenderedSources({
      ...input,
      openConfig: changed,
      candidateContext: context(changed),
    }), failure);
  }
  expectContractFailure(() => validateRenderedSources({
    ...input,
    candidateContext: input.candidateContext.replace("default_type text/plain;", "default_type application/octet-stream;"),
  }), "PRESERVED_CONTEXT_DRIFT");
  const changeCsp = (policy) => openConfig.replace(csp, policy);
  for (const [policy, frameSources] of [
    ["frame-src 'self'", ["'self'"]],
    ["default-src 'self'; frame-src 'none'", ["'none'"]],
    ["default-src 'self'", []],
  ]) {
    const changed = changeCsp(policy);
    expectContractFailure(() => validateRenderedSources({
      ...input,
      openConfig: changed,
      candidateContext: context(changed),
      expected: { ...input.expected, cspPolicy: policy, cspFrameSources: frameSources },
    }), "PRESERVED_SECURITY_DRIFT");
  }
  expectContractFailure(() => validateRenderedSources({
    ...input,
    expected: { ...input.expected, cspFrameSources: [] },
  }), "RENDERED_METADATA_MISMATCH");
  for (const policy of ["frame-src;", "frame-src *", "Frame-Src 'none'"]) {
    const changed = changeCsp(policy);
    expectContractFailure(() => validateRenderedSources({
      ...input,
      openConfig: changed,
      candidateContext: context(changed),
      expected: { ...input.expected, cspPolicy: policy },
    }), "OPEN_SECURITY_INVALID");
  }
  const ordinary = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: `"${csp}"`,
  });
  expectContractFailure(() => validateRenderedSources({
    openConfig: ordinary,
    closedCandidate: sources.closedCandidate,
    expected: { ...synthetic.expected, cspPolicy: csp },
    mode: "dual-direct",
  }), "OPEN_SECURITY_INVALID");
});

test("preserve-existing keeps charset module directives in their bound scope", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const csp = "frame-src 'none'";
  const withPreserveBlocks = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.cspPolicy]: `"${csp}"`,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.compressionDirectives]: "# OPEN_COMPRESSION_OWNER: preserve-existing",
  });
  const omitBlock = (source, name) => source.replace(
    new RegExp(`^    # OPEN_PRESERVE_${name}_BEGIN:[^\\n]*\\n[\\s\\S]*?^    # OPEN_PRESERVE_${name}_END\\n`, "m"),
    "",
  );
  const openConfig = omitBlock(omitBlock(withPreserveBlocks, "MIME"), "SECURITY_HEADERS");
  const context = (target) => `http {\n include mime.types;\n default_type text/plain;\n ${target}\n}`;
  const input = {
    openConfig,
    closedCandidate: sources.closedCandidate,
    expected: {
      ...synthetic.expected,
      cspPolicy: csp,
      cspConnectSources: [],
      framingPolicy: "preserve-existing",
      hstsOwner: "preserve-existing",
      hstsValue: "preserve-existing",
      compressionOwner: "preserve-existing",
    },
    mode: "dual-direct",
    existingContext: context(openConfig),
    candidateContext: context(openConfig),
  };
  const withServerDirective = (target, directive) => target.replace(
    "    location = /api {",
    `    ${directive}\n    location = /api {`,
  );
  for (const [before, after] of [
    ["charset_types text/html application/json;", "charset_types text/html;"],
    ["source_charset utf-8;", "source_charset iso-8859-1;"],
    ["override_charset on;", "override_charset off;"],
  ]) {
    const oldTarget = withServerDirective(openConfig, before);
    const newTarget = withServerDirective(openConfig, after);
    expectContractFailure(() => validateRenderedSources({
      ...input,
      existingContext: context(oldTarget),
    }), "PRESERVED_MIME_DRIFT");
    expectContractFailure(() => validateRenderedSources({
      ...input,
      openConfig: newTarget,
      existingContext: context(oldTarget),
      candidateContext: context(newTarget),
    }), "PRESERVED_MIME_DRIFT");
    assert.equal(validateRenderedSources({
      ...input,
      openConfig: oldTarget,
      existingContext: context(oldTarget),
      candidateContext: context(oldTarget),
    }).effectiveInheritedMimePolicy, "UNVERIFIED");
  }
});

test("preserve-existing rejects changed security, TLS, non-target, or inherited context", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const openConfig = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
  });
  const otherServer = "\nserver { listen 8080; server_name unrelated.example.invalid; return 204; }\n";
  const input = {
    openConfig,
    closedCandidate: sources.closedCandidate,
    expected: {
      ...synthetic.expected,
      framingPolicy: "preserve-existing",
      hstsOwner: "preserve-existing",
      hstsValue: "preserve-existing",
    },
    mode: "dual-direct",
    existingContext: openConfig + otherServer,
    candidateContext: openConfig + otherServer,
  };
  const changedCsp = openConfig.replace("frame-ancestors 'self'", "frame-ancestors 'none'");
  expectContractFailure(
    () => validateRenderedSources({
      ...input,
      openConfig: changedCsp,
      candidateContext: changedCsp + otherServer,
      expected: { ...input.expected, cspPolicy: input.expected.cspPolicy.replace("frame-ancestors 'self'", "frame-ancestors 'none'") },
    }),
    "PRESERVED_SECURITY_DRIFT",
  );
  const changedCertificate = openConfig.replace("cert.pem", "different-cert.pem");
  expectContractFailure(
    () => validateRenderedSources({ ...input, openConfig: changedCertificate, candidateContext: changedCertificate + otherServer }),
    "PRESERVED_SECURITY_DRIFT",
  );
  expectContractFailure(
    () => validateRenderedSources({ ...input, candidateContext: openConfig + otherServer.replace("return 204", "return 200") }),
    "PRESERVED_CONTEXT_DRIFT",
  );
  expectContractFailure(
    () => validateRenderedSources({ ...input, candidateContext: `add_header X-Test inherited;\n${input.candidateContext}` }),
    "PRESERVED_CONTEXT_DRIFT",
  );
  expectContractFailure(
    () => validateRenderedSources({ ...input, candidateContext: input.candidateContext.replace("return 301", "return 302") }),
    "PRESERVED_CONTEXT_DRIFT",
  );
});

test("preserve-existing compares complete target listen declarations before and after", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const openConfig = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
  });
  const otherServer = "\nserver { listen 8080; server_name unrelated.example.invalid; return 204; }\n";
  const input = {
    openConfig,
    closedCandidate: sources.closedCandidate,
    expected: {
      ...synthetic.expected,
      framingPolicy: "preserve-existing",
      hstsOwner: "preserve-existing",
      hstsValue: "preserve-existing",
    },
    mode: "dual-direct",
    existingContext: openConfig + otherServer,
    candidateContext: openConfig + otherServer,
  };
  const extraListen = input.existingContext.replace(
    "listen 80;",
    "listen 80;\n    listen 8080;",
  );
  assert.notEqual(extraListen, input.existingContext);
  expectContractFailure(
    () => validateRenderedSources({ ...input, existingContext: extraListen }),
    "OPEN_TOPOLOGY_INVALID",
  );
});

test("preserve-existing rejects missing, extra, or changed target listen values and flags", () => {
  const sources = contractSources();
  const synthetic = createSanitizedSyntheticRender();
  const openConfig = replaceTokens(sources.dualTemplate, {
    ...synthetic.replacements,
    [OPEN_HTTP_PLACEHOLDERS.framingDirective]: "# OPEN_FRAMING_POLICY: preserve-existing",
    [OPEN_HTTP_PLACEHOLDERS.hstsDirective]: "# OPEN_HSTS_OWNER: preserve-existing",
  });
  const otherServer = "\nserver { listen 8080; server_name unrelated.example.invalid; return 204; }\n";
  const input = {
    openConfig,
    closedCandidate: sources.closedCandidate,
    expected: {
      ...synthetic.expected,
      framingPolicy: "preserve-existing",
      hstsOwner: "preserve-existing",
      hstsValue: "preserve-existing",
    },
    mode: "dual-direct",
    existingContext: openConfig + otherServer,
    candidateContext: openConfig + otherServer,
  };
  for (const mutated of [
    input.existingContext.replace("\n    listen [::]:80;", ""),
    input.existingContext.replace("    listen 443 ssl;", "    listen 443 ssl;\n    listen 8443 ssl;"),
    input.existingContext.replace("listen 80;", "listen 80 default_server;"),
    input.existingContext.replace("listen [::]:443 ssl;", "listen [::]:443;"),
  ]) {
    assert.notEqual(mutated, input.existingContext);
    expectContractFailure(
      () => validateRenderedSources({ ...input, existingContext: mutated }),
      "OPEN_TOPOLOGY_INVALID",
    );
  }
  const reordered = input.existingContext
    .replace("    listen 80;\n    listen [::]:80;", "    listen [::]:80;\n    listen 80;")
    .replace("    listen 443 ssl;\n    listen [::]:443 ssl;", "    listen [::]:443 ssl;\n    listen 443 ssl;");
  assert.notEqual(reordered, input.existingContext);
  assert.equal(
    validateRenderedSources({ ...input, existingContext: reordered }).status,
    "ok",
  );
});

test("open HTTP templates reject concrete host, root, upstream, TLS, and certificate values", () => {
  const baseline = contractSources();
  const cases = [
    {
      token: OPEN_HTTP_PLACEHOLDERS.canonicalHost,
      value: "canonical.example.invalid",
    },
    {
      token: OPEN_HTTP_PLACEHOLDERS.websiteRoot,
      value: "/srv/example-site",
    },
    {
      token: OPEN_HTTP_PLACEHOLDERS.apiUpstream,
      value: "http://127.0.0.1:18080",
    },
    {
      token: OPEN_HTTP_PLACEHOLDERS.tlsDirectives,
      value: "include /etc/nginx/example-tls.conf;",
    },
    {
      token: OPEN_HTTP_PLACEHOLDERS.tlsDirectives,
      value: "ssl_certificate /etc/nginx/example-cert.pem;",
    },
  ];
  for (const scenario of cases) {
    const mutated = {
      ...baseline,
      openTemplate:
        baseline.openTemplate.replace(scenario.token, scenario.value) +
        `\n# ${scenario.token}\n`,
    };
    expectContractFailure(
      () => validateTemplateSources(mutated),
      "TEMPLATE_VALUE_FORBIDDEN",
    );
  }
});

test("sanitized rendered validation rejects topology and routing isolation mutations", () => {
  const parent = mkdtempSync(join(tmpdir(), "open-http-routing-"));
  try {
    const baseline = renderedContract(join(parent, "root"));
    mkdirSync(baseline.expected.websiteRoot);
    assert.equal(
      validateRenderedSources({
        openConfig: baseline.openConfig,
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
        expected: baseline.expected,
      }).status,
      "ok",
    );

    const scenarios = [
      {
        code: "OPEN_TOPOLOGY_INVALID",
        openConfig: baseline.openConfig,
        bareConfig: baseline.bareConfig.replace(
          `server_name ${baseline.expected.bareHost};`,
          `server_name ${baseline.expected.canonicalHost};`,
        ),
        closedCandidate: baseline.closedCandidate,
      },
      {
        code: "OPEN_ROUTING_INVALID",
        openConfig: baseline.openConfig.replace(
          `proxy_pass ${baseline.expected.apiUpstream};`,
          `proxy_pass ${baseline.expected.apiUpstream};\n        try_files $uri /index.html;`,
        ),
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
      },
      {
        code: "OPEN_ROUTING_INVALID",
        openConfig: baseline.openConfig.replace(
          "try_files $uri $uri/ /index.html;",
          `proxy_pass ${baseline.expected.apiUpstream};\n        try_files $uri $uri/ /index.html;`,
        ),
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
      },
      {
        code: "OPEN_ROUTING_INVALID",
        openConfig: baseline.openConfig.replace(
          "location /assets/ {\n        set $open_cache_control \"no-cache, must-revalidate\";\n        try_files $uri =404;",
          "location /assets/ {\n        set $open_cache_control \"no-cache, must-revalidate\";\n        try_files $uri /index.html;",
        ),
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
      },
      {
        code: "OPEN_ROUTING_INVALID",
        openConfig: baseline.openConfig.replace(
          "location ~ \"^/(?!assets/)(?:.*/)?[^/]+\\.[^/]+$\" {\n        set $open_cache_control \"no-cache, must-revalidate\";\n        try_files $uri =404;",
          "location ~ \"^/(?!assets/)(?:.*/)?[^/]+\\.[^/]+$\" {\n        set $open_cache_control \"no-cache, must-revalidate\";\n        try_files $uri /index.html;",
        ),
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
      },
    ];
    for (const scenario of scenarios) {
      expectContractFailure(
        () =>
          validateRenderedSources({
            ...scenario,
            expected: baseline.expected,
          }),
        scenario.code,
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("sanitized rendered validation rejects HTML and asset cache mutations", () => {
  const baseline = renderedContract("/tmp/open-http-cache-test/root");
  const scenarios = [
    baseline.openConfig.replace(
      "location = /index.html {\n        set $open_cache_control \"no-cache, no-store, must-revalidate\";",
      "location = /index.html {\n        set $open_cache_control \"max-age=60\";",
    ),
    baseline.openConfig.replace(
      'set $open_cache_control "public, max-age=31536000, immutable";',
      'set $open_cache_control "public, max-age=60";',
    ),
    baseline.openConfig.replace(
      "location /assets/ {\n        set $open_cache_control \"no-cache, must-revalidate\";",
      "location /assets/ {\n        set $open_cache_control \"public, max-age=31536000, immutable\";",
    ),
  ];
  for (const openConfig of scenarios) {
    expectContractFailure(
      () =>
        validateRenderedSources({
          openConfig,
          bareConfig: baseline.bareConfig,
          closedCandidate: baseline.closedCandidate,
          expected: baseline.expected,
        }),
      "OPEN_CACHE_INVALID",
    );
  }
});

test("sanitized rendered validation rejects missing MIME and security duties", () => {
  const baseline = renderedContract("/tmp/open-http-security-test/root");
  const missingLines = [
    "    include mime.types;\n",
    '    add_header X-Content-Type-Options "nosniff" always;\n',
    '    add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n',
    '    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;\n',
  ];
  for (const line of missingLines) {
    expectContractFailure(
      () =>
        validateRenderedSources({
          openConfig: baseline.openConfig.replace(line, ""),
          bareConfig: baseline.bareConfig,
          closedCandidate: baseline.closedCandidate,
          expected: baseline.expected,
        }),
      "OPEN_SECURITY_INVALID",
    );
  }

  const cspWithoutBase = baseline.expected.cspPolicy.replace(
    "base-uri 'self'; ",
    "",
  );
  expectContractFailure(
    () =>
      validateRenderedSources({
        openConfig: baseline.openConfig.replace(
          baseline.expected.cspPolicy,
          cspWithoutBase,
        ),
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
        expected: { ...baseline.expected, cspPolicy: cspWithoutBase },
      }),
    "OPEN_SECURITY_INVALID",
  );
});

test("sanitized rendered validation rejects unsafe CSP and inconsistent framing", () => {
  const baseline = renderedContract("/tmp/open-http-csp-test/root");
  for (const scriptSources of ["*", "'self' 'unsafe-eval'", "'self' data:"]) {
    const cspPolicy = baseline.expected.cspPolicy.replace(
      "script-src 'self'",
      `script-src ${scriptSources}`,
    );
    expectContractFailure(
      () =>
        validateRenderedSources({
          openConfig: baseline.openConfig.replace(
            baseline.expected.cspPolicy,
            cspPolicy,
          ),
          bareConfig: baseline.bareConfig,
          closedCandidate: baseline.closedCandidate,
          expected: { ...baseline.expected, cspPolicy },
        }),
      "OPEN_SECURITY_INVALID",
    );
  }
  expectContractFailure(
    () =>
      validateRenderedSources({
        openConfig: baseline.openConfig.replace(
          "# OPEN_FRAMING_POLICY: same-origin",
          "# OPEN_FRAMING_POLICY: deny",
        ),
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
        expected: baseline.expected,
      }),
    "OPEN_SECURITY_INVALID",
  );
});

test("sanitized rendered validation rejects HSTS and compression ownership drift", () => {
  const baseline = renderedContract("/tmp/open-http-compression-test/root");
  const scenarios = [
    {
      code: "OPEN_SECURITY_INVALID",
      openConfig: baseline.openConfig.replace(
        /^\s*# OPEN_HSTS_OWNER: https-server\s*$/m,
        "",
      ),
    },
    {
      code: "OPEN_COMPRESSION_INVALID",
      openConfig: baseline.openConfig.replace(
        /^\s*# OPEN_COMPRESSION_OWNER: canonical-https\s*$/m,
        "",
      ),
    },
    {
      code: "OPEN_COMPRESSION_INVALID",
      openConfig: baseline.openConfig.replace("gzip on;", "gzip on;\nbrotli on;"),
    },
    {
      code: "OPEN_COMPRESSION_INVALID",
      openConfig: baseline.openConfig.replace("gzip_vary on;", "gzip_vary off;"),
    },
  ];
  for (const scenario of scenarios) {
    expectContractFailure(
      () =>
        validateRenderedSources({
          openConfig: scenario.openConfig,
          bareConfig: baseline.bareConfig,
          closedCandidate: baseline.closedCandidate,
          expected: baseline.expected,
        }),
      scenario.code,
    );
  }
});

test("open and closed states remain mutually exclusive and rendered tokens resolve", () => {
  const baseline = renderedContract("/tmp/open-http-mutual-test/root");
  expectContractFailure(
    () =>
      validateRenderedSources({
        openConfig: baseline.openConfig.replace(
          `return 308 https://${baseline.expected.canonicalHost}$request_uri;`,
          "return 503;",
        ),
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
        expected: baseline.expected,
      }),
    "OPEN_CLOSED_CONFLICT",
  );
  expectContractFailure(
    () =>
      validateRenderedSources({
        openConfig: baseline.openConfig,
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate.replace(
          "server {",
          "server {\n    root /tmp/open-http-mutual-test/root;",
        ),
        expected: baseline.expected,
      }),
    "OPEN_CLOSED_CONFLICT",
  );
  expectContractFailure(
    () =>
      validateRenderedSources({
        openConfig: `${baseline.openConfig}\n# __OPEN_CANONICAL_HOST__\n`,
        bareConfig: baseline.bareConfig,
        closedCandidate: baseline.closedCandidate,
        expected: baseline.expected,
      }),
    "UNRESOLVED_PLACEHOLDER",
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
    assert.equal(manifest.schemaRoute, STANDARD16_26_RELEASE_SCHEMA_ROUTE);
    assert.deepEqual(manifest.schemaBoundary, {
      rollback: 16,
      candidate: 26,
    });
    for (const relativePath of RELEASE_HTTP_CONTRACT_PATHS) {
      const entry = manifest.inventory.find(
        (candidate) => candidate.path === relativePath,
      );
      assert.equal(Number.isSafeInteger(entry?.bytes), true, relativePath);
      assert.match(entry?.sha256 ?? "", /^[a-f0-9]{64}$/, relativePath);
    }
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
    assert.ok(files.includes("website/dist/referral.html"));
    assert.ok(files.includes("release-manifest.json"));
    assert.equal(files.some((path) => isForbiddenBundlePath(path)), false);
    assert.equal(files.includes("customer-notes.txt"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("direct14 bundle requires an explicit matching route and distinct artifact name", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-direct14-test-"));
  try {
    const fixture = createFixtureRepository(parent);
    const direct = join(parent, "direct14");
    const standard = join(parent, "standard16");
    assembleReleaseBundle({
      source: fixture.root,
      destination: direct,
      expectedSha: fixture.sha,
      provenanceMode: LOCAL_PROVENANCE_MODE,
      schemaRoute: DIRECT14_RELEASE_SCHEMA_ROUTE,
    });
    assembleReleaseBundle({
      source: fixture.root,
      destination: standard,
      expectedSha: fixture.sha,
      provenanceMode: LOCAL_PROVENANCE_MODE,
    });
    const manifest = JSON.parse(readFileSync(join(direct, "release-manifest.json"), "utf8"));
    assert.equal(manifest.schemaRoute, DIRECT14_RELEASE_SCHEMA_ROUTE);
    assert.deepEqual(manifest.schemaBoundary, { rollback: 14, candidate: 26 });
    assert.equal(
      validateBundle({
        bundle: direct,
        expectedSha: fixture.sha,
        validationMode: "local-dry-run",
        schemaRoute: DIRECT14_RELEASE_SCHEMA_ROUTE,
      }).status,
      "ok",
    );
    for (const [bundle, schemaRoute] of [
      [direct, undefined],
      [standard, DIRECT14_RELEASE_SCHEMA_ROUTE],
    ]) {
      assert.throws(
        () => validateBundle({ bundle, expectedSha: fixture.sha, validationMode: "local-dry-run", schemaRoute }),
        (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
      );
    }
    manifest.schemaBoundary.rollback = 16;
    writeFileSync(join(direct, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => validateBundle({ bundle: direct, expectedSha: fixture.sha, validationMode: "local-dry-run", schemaRoute: DIRECT14_RELEASE_SCHEMA_ROUTE }),
      (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
    );
    const environment = githubEnvironment({ sha: fixture.sha, candidate: true });
    assert.equal(
      createReleaseProvenance({ mode: "github-actions", expectedSha: fixture.sha, environment }).artifactName,
      `consolidated-release-${fixture.sha}`,
    );
    assert.equal(
      createReleaseProvenance({ mode: "github-actions", expectedSha: fixture.sha, environment, schemaRoute: DIRECT14_RELEASE_SCHEMA_ROUTE }).artifactName,
      `consolidated-release-direct14-${fixture.sha}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("direct14 CI provenance validates only its route-specific artifact identity", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-direct14-ci-"));
  try {
    const fixture = createFixtureRepository(parent);
    const environment = githubEnvironment({ sha: fixture.sha, candidate: true });
    const bundle = join(parent, "candidate");
    assembleReleaseBundle({
      source: fixture.root,
      destination: bundle,
      expectedSha: fixture.sha,
      provenanceMode: "github-actions",
      schemaRoute: DIRECT14_RELEASE_SCHEMA_ROUTE,
      environment,
    });
    assert.equal(
      validateBundle({
        bundle,
        expectedSha: fixture.sha,
        validationMode: "ci-build",
        schemaRoute: DIRECT14_RELEASE_SCHEMA_ROUTE,
        environment,
      }).artifactName,
      `consolidated-release-direct14-${fixture.sha}`,
    );
    const manifestPath = join(bundle, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.provenance.artifactName = `consolidated-release-${fixture.sha}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => validateBundle({ bundle, expectedSha: fixture.sha, validationMode: "ci-build", schemaRoute: DIRECT14_RELEASE_SCHEMA_ROUTE, environment }),
      (error) => error?.code === "PROVENANCE_REQUIRED",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("historical 001-019 routes still assemble and validate only 019 bundles", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-historical-"));
  try {
    mkdirSync(join(parent, "h"));
    mkdirSync(join(parent, "c"));
    const historical = createFixtureRepository(join(parent, "h"), RELEASE_MIGRATIONS_001_019);
    const current = createFixtureRepository(join(parent, "c"));
    const standard19 = join(parent, "standard19");
    const direct19 = join(parent, "direct19");
    assembleReleaseBundle({ source: historical.root, destination: standard19, expectedSha: historical.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: STANDARD16_19_RELEASE_SCHEMA_ROUTE });
    assembleReleaseBundle({ source: historical.root, destination: direct19, expectedSha: historical.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: DIRECT14_19_RELEASE_SCHEMA_ROUTE });
    const standardManifest = JSON.parse(readFileSync(join(standard19, "release-manifest.json"), "utf8"));
    const directManifest = JSON.parse(readFileSync(join(direct19, "release-manifest.json"), "utf8"));
    // The historical standard manifest format (no schemaRoute) is preserved exactly.
    assert.equal(Object.hasOwn(standardManifest, "schemaRoute"), false);
    assert.deepEqual(standardManifest.schemaBoundary, { rollback: 16, candidate: 19 });
    assert.deepEqual(standardManifest.migrations, [...RELEASE_MIGRATIONS_001_019]);
    assert.equal(directManifest.schemaRoute, DIRECT14_19_RELEASE_SCHEMA_ROUTE);
    assert.deepEqual(directManifest.schemaBoundary, { rollback: 14, candidate: 19 });
    for (const [bundle, schemaRoute] of [[standard19, STANDARD16_19_RELEASE_SCHEMA_ROUTE], [direct19, DIRECT14_19_RELEASE_SCHEMA_ROUTE]]) {
      assert.equal(validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute }).status, "ok");
    }
    // A 019 bundle never passes as a 020, 021 or 022 candidate, with or without an explicit route.
    for (const [bundle, schemaRoute] of [[standard19, undefined], [standard19, STANDARD16_20_RELEASE_SCHEMA_ROUTE], [standard19, STANDARD16_21_RELEASE_SCHEMA_ROUTE], [standard19, STANDARD16_22_RELEASE_SCHEMA_ROUTE], [standard19, STANDARD16_24_RELEASE_SCHEMA_ROUTE], [standard19, STANDARD16_25_RELEASE_SCHEMA_ROUTE], [standard19, STANDARD16_26_RELEASE_SCHEMA_ROUTE], [direct19, DIRECT14_20_RELEASE_SCHEMA_ROUTE], [direct19, DIRECT14_21_RELEASE_SCHEMA_ROUTE], [direct19, DIRECT14_22_RELEASE_SCHEMA_ROUTE], [direct19, DIRECT14_RELEASE_SCHEMA_ROUTE]]) {
      assert.throws(
        () => validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute }),
        (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
      );
    }
    // Routes never cross generations at assembly time.
    for (const [fixture, schemaRoute, name] of [
      [current, STANDARD16_19_RELEASE_SCHEMA_ROUTE, "current-as-standard19"],
      [current, DIRECT14_19_RELEASE_SCHEMA_ROUTE, "current-as-direct19"],
      [historical, STANDARD16_20_RELEASE_SCHEMA_ROUTE, "historical-as-standard20"],
      [historical, DIRECT14_20_RELEASE_SCHEMA_ROUTE, "historical-as-direct20"],
      [historical, STANDARD16_21_RELEASE_SCHEMA_ROUTE, "historical-as-standard21"],
      [historical, DIRECT14_21_RELEASE_SCHEMA_ROUTE, "historical-as-direct21"],
      [historical, STANDARD16_22_RELEASE_SCHEMA_ROUTE, "historical-as-standard22"],
      [historical, DIRECT14_22_RELEASE_SCHEMA_ROUTE, "historical-as-direct22"],
      [historical, STANDARD16_23_RELEASE_SCHEMA_ROUTE, "historical-as-standard23"],
      [historical, DIRECT14_23_RELEASE_SCHEMA_ROUTE, "historical-as-direct23"],
      [historical, STANDARD16_24_RELEASE_SCHEMA_ROUTE, "historical-as-standard24"],
      [historical, DIRECT14_24_RELEASE_SCHEMA_ROUTE, "historical-as-direct24"],
      [historical, STANDARD16_26_RELEASE_SCHEMA_ROUTE, "historical-as-standard26"],
      [historical, DIRECT14_RELEASE_SCHEMA_ROUTE, "historical-as-direct25"],
    ]) {
      const destination = join(parent, name);
      assert.throws(
        () => assembleReleaseBundle({ source: fixture.root, destination, expectedSha: fixture.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute }),
        (error) => error?.code === "SCHEMA_BOUNDARY_MISMATCH",
        name,
      );
      assert.equal(existsSync(destination), false, name);
    }
    // A current bundle cannot be relabelled as historical.
    const standard23 = join(parent, "standard23");
    assembleReleaseBundle({ source: current.root, destination: standard23, expectedSha: current.sha, provenanceMode: LOCAL_PROVENANCE_MODE });
    assert.throws(
      () => validateBundle({ bundle: standard23, expectedSha: current.sha, validationMode: "local-dry-run", schemaRoute: STANDARD16_19_RELEASE_SCHEMA_ROUTE }),
      (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
    );
    assert.throws(
      () => assembleReleaseBundle({ source: current.root, destination: join(parent, "bad-route"), expectedSha: current.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: "standard16-27" }),
      (error) => error?.code === "ARGUMENT_ERROR",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("standard19-26 assembles exact 001-026 with its own boundary and rejects cross-route bundles", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-standard19-"));
  try {
    mkdirSync(join(parent, "c"));
    mkdirSync(join(parent, "h"));
    const current = createFixtureRepository(join(parent, "c"));
    const historical = createFixtureRepository(join(parent, "h"), RELEASE_MIGRATIONS_001_019);
    const bundles = {};
    for (const route of [STANDARD19_26_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE]) {
      bundles[route] = join(parent, route);
      assembleReleaseBundle({ source: current.root, destination: bundles[route], expectedSha: current.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: route });
    }
    const manifestPath = join(bundles[STANDARD19_26_RELEASE_SCHEMA_ROUTE], "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.schemaRoute, STANDARD19_26_RELEASE_SCHEMA_ROUTE);
    assert.deepEqual(manifest.schemaBoundary, { rollback: 19, candidate: 26 });
    assert.deepEqual(manifest.migrations, [...RELEASE_MIGRATIONS]);
    assert.equal(
      validateBundle({ bundle: bundles[STANDARD19_26_RELEASE_SCHEMA_ROUTE], expectedSha: current.sha, validationMode: "local-dry-run", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE }).status,
      "ok",
    );
    const integrityFailure = (error) => error?.code === "BUNDLE_INTEGRITY_FAILED";
    for (const route of [STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE, STANDARD16_19_RELEASE_SCHEMA_ROUTE, undefined]) {
      assert.throws(
        () => validateBundle({ bundle: bundles[STANDARD19_26_RELEASE_SCHEMA_ROUTE], expectedSha: current.sha, validationMode: "local-dry-run", schemaRoute: route }),
        integrityFailure,
        `standard19 bundle as ${route}`,
      );
    }
    for (const route of [STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE]) {
      assert.throws(
        () => validateBundle({ bundle: bundles[route], expectedSha: current.sha, validationMode: "local-dry-run", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE }),
        integrityFailure,
        `${route} bundle as standard19-25`,
      );
    }
    for (const [name, mutate] of [
      ["rollback-16", (m) => { m.schemaBoundary.rollback = 16; }],
      ["route-relabel", (m) => { m.schemaRoute = STANDARD16_26_RELEASE_SCHEMA_ROUTE; }],
      ["candidate-22", (m) => { m.schemaBoundary.candidate = 22; }],
      ["migrations-022", (m) => { m.migrations = [...RELEASE_MIGRATIONS_001_022]; }],
    ]) {
      const bundle = join(parent, `tampered-${name}`);
      cpSync(bundles[STANDARD19_26_RELEASE_SCHEMA_ROUTE], bundle, { recursive: true });
      const tampered = JSON.parse(readFileSync(join(bundle, "release-manifest.json"), "utf8"));
      mutate(tampered);
      writeFileSync(join(bundle, "release-manifest.json"), `${JSON.stringify(tampered, null, 2)}\n`);
      assert.throws(
        () => validateBundle({ bundle, expectedSha: current.sha, validationMode: "local-dry-run", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE }),
        integrityFailure,
        name,
      );
    }
    const refused = join(parent, "historical-as-standard19");
    assert.throws(
      () => assembleReleaseBundle({ source: historical.root, destination: refused, expectedSha: historical.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE }),
      (error) => error?.code === "SCHEMA_BOUNDARY_MISMATCH",
    );
    assert.equal(existsSync(refused), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("standard19-25 CI provenance binds its distinct artifact and PR builds stay test-only", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-standard19-ci-"));
  try {
    const fixture = createFixtureRepository(parent);
    const environment = githubEnvironment({ sha: fixture.sha, candidate: true });
    assert.equal(
      createReleaseProvenance({ mode: "github-actions", expectedSha: fixture.sha, environment, schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE }).artifactName,
      `consolidated-release-standard19-${fixture.sha}`,
    );
    const bundle = join(parent, "candidate");
    assembleReleaseBundle({ source: fixture.root, destination: bundle, expectedSha: fixture.sha, provenanceMode: "github-actions", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE, environment });
    const validated = validateBundle({ bundle, expectedSha: fixture.sha, validationMode: "ci-build", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE, environment });
    assert.equal(validated.artifactName, `consolidated-release-standard19-${fixture.sha}`);
    assert.equal(validated.releaseUse, "requires-github-artifact-verification");
    for (const other of [`consolidated-release-${fixture.sha}`, `consolidated-release-direct14-${fixture.sha}`]) {
      const renamed = join(parent, `renamed-${other.length}`);
      cpSync(bundle, renamed, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(renamed, "release-manifest.json"), "utf8"));
      manifest.provenance.artifactName = other;
      writeFileSync(join(renamed, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      assert.throws(
        () => validateBundle({ bundle: renamed, expectedSha: fixture.sha, validationMode: "ci-build", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE, environment }),
        (error) => error?.code === "PROVENANCE_REQUIRED",
      );
    }
    // A pull-request context cannot claim release provenance for this route; its
    // test build is forbidden for release use and never validates as a candidate.
    const prEnvironment = githubEnvironment({ sha: fixture.sha, candidate: false });
    assert.throws(
      () => assembleReleaseBundle({ source: fixture.root, destination: join(parent, "pr-claim"), expectedSha: fixture.sha, provenanceMode: "github-actions", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE, environment: prEnvironment }),
      (error) => error?.code === "PROVENANCE_REQUIRED",
    );
    const prBundle = join(parent, "pr-test");
    assembleReleaseBundle({ source: fixture.root, destination: prBundle, expectedSha: fixture.sha, provenanceMode: "github-actions-test", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE, environment: prEnvironment });
    const prManifest = JSON.parse(readFileSync(join(prBundle, "release-manifest.json"), "utf8"));
    assert.equal(prManifest.provenance.releaseUse, "forbidden");
    assert.throws(
      () => validateBundle({ bundle: prBundle, expectedSha: fixture.sha, validationMode: "ci-build", schemaRoute: STANDARD19_26_RELEASE_SCHEMA_ROUTE, environment: prEnvironment }),
      (error) => error?.code === "PROVENANCE_REQUIRED",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("historical 001-020 routes still assemble and validate only 020 bundles", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-historical-020-"));
  try {
    mkdirSync(join(parent, "h"));
    mkdirSync(join(parent, "c"));
    const historical = createFixtureRepository(join(parent, "h"), RELEASE_MIGRATIONS_001_020);
    const current = createFixtureRepository(join(parent, "c"));
    for (const [route, rollback] of [
      [STANDARD16_20_RELEASE_SCHEMA_ROUTE, 16],
      [DIRECT14_20_RELEASE_SCHEMA_ROUTE, 14],
      [STANDARD19_20_RELEASE_SCHEMA_ROUTE, 19],
    ]) {
      const bundle = join(parent, `historical-${route}`);
      assembleReleaseBundle({ source: historical.root, destination: bundle, expectedSha: historical.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: route });
      const manifest = JSON.parse(readFileSync(join(bundle, "release-manifest.json"), "utf8"));
      assert.equal(manifest.schemaRoute, route);
      assert.deepEqual(manifest.schemaBoundary, { rollback, candidate: 20 });
      assert.deepEqual(manifest.migrations, [...RELEASE_MIGRATIONS_001_020]);
      assert.equal(validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: route }).status, "ok");
      // A 020 bundle never passes as a later candidate.
      for (const currentRoute of [undefined, STANDARD16_21_RELEASE_SCHEMA_ROUTE, DIRECT14_21_RELEASE_SCHEMA_ROUTE, STANDARD19_21_RELEASE_SCHEMA_ROUTE, STANDARD16_22_RELEASE_SCHEMA_ROUTE, DIRECT14_22_RELEASE_SCHEMA_ROUTE, STANDARD19_22_RELEASE_SCHEMA_ROUTE, STANDARD16_24_RELEASE_SCHEMA_ROUTE, STANDARD16_25_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE, STANDARD19_24_RELEASE_SCHEMA_ROUTE, STANDARD19_25_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE]) {
        assert.throws(
          () => validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: currentRoute }),
          (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
          `${route} bundle as ${currentRoute}`,
        );
      }
    }
    // Routes never cross generations at assembly time.
    for (const [fixture, schemaRoute, name] of [
      [current, STANDARD16_20_RELEASE_SCHEMA_ROUTE, "current-as-standard20"],
      [current, DIRECT14_20_RELEASE_SCHEMA_ROUTE, "current-as-direct20"],
      [current, STANDARD19_20_RELEASE_SCHEMA_ROUTE, "current-as-standard19-20"],
      [historical, STANDARD16_21_RELEASE_SCHEMA_ROUTE, "historical-as-standard21"],
      [historical, DIRECT14_21_RELEASE_SCHEMA_ROUTE, "historical-as-direct21"],
      [historical, STANDARD19_21_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-21"],
      [historical, STANDARD16_22_RELEASE_SCHEMA_ROUTE, "historical-as-standard22"],
      [historical, DIRECT14_RELEASE_SCHEMA_ROUTE, "historical-as-direct22"],
      [historical, STANDARD19_22_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-22"],
    ]) {
      const destination = join(parent, name);
      assert.throws(
        () => assembleReleaseBundle({ source: fixture.root, destination, expectedSha: fixture.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute }),
        (error) => error?.code === "SCHEMA_BOUNDARY_MISMATCH",
        name,
      );
      assert.equal(existsSync(destination), false, name);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("historical 001-021 routes still assemble and validate only 021 bundles", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-historical-021-"));
  try {
    mkdirSync(join(parent, "h"));
    mkdirSync(join(parent, "c"));
    const historical = createFixtureRepository(join(parent, "h"), RELEASE_MIGRATIONS_001_021);
    const current = createFixtureRepository(join(parent, "c"));
    for (const [route, rollback] of [
      [STANDARD16_21_RELEASE_SCHEMA_ROUTE, 16],
      [DIRECT14_21_RELEASE_SCHEMA_ROUTE, 14],
      [STANDARD19_21_RELEASE_SCHEMA_ROUTE, 19],
    ]) {
      const bundle = join(parent, `historical-${route}`);
      assembleReleaseBundle({ source: historical.root, destination: bundle, expectedSha: historical.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: route });
      const manifest = JSON.parse(readFileSync(join(bundle, "release-manifest.json"), "utf8"));
      assert.equal(manifest.schemaRoute, route);
      assert.deepEqual(manifest.schemaBoundary, { rollback, candidate: 21 });
      assert.deepEqual(manifest.migrations, [...RELEASE_MIGRATIONS_001_021]);
      assert.equal(validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: route }).status, "ok");
      // A 021 bundle never passes as a 022 or 023 candidate.
      for (const currentRoute of [undefined, STANDARD16_22_RELEASE_SCHEMA_ROUTE, DIRECT14_22_RELEASE_SCHEMA_ROUTE, STANDARD19_22_RELEASE_SCHEMA_ROUTE, STANDARD16_24_RELEASE_SCHEMA_ROUTE, STANDARD16_25_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE, STANDARD19_24_RELEASE_SCHEMA_ROUTE, STANDARD19_25_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE]) {
        assert.throws(
          () => validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: currentRoute }),
          (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
          `${route} bundle as ${currentRoute}`,
        );
      }
    }
    // Routes never cross generations at assembly time.
    for (const [fixture, schemaRoute, name] of [
      [current, STANDARD16_21_RELEASE_SCHEMA_ROUTE, "current-as-standard21"],
      [current, DIRECT14_21_RELEASE_SCHEMA_ROUTE, "current-as-direct21"],
      [current, STANDARD19_21_RELEASE_SCHEMA_ROUTE, "current-as-standard19-21"],
      [historical, STANDARD16_22_RELEASE_SCHEMA_ROUTE, "historical-as-standard22"],
      [historical, DIRECT14_22_RELEASE_SCHEMA_ROUTE, "historical-as-direct22"],
      [historical, STANDARD19_22_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-22"],
      [historical, STANDARD16_23_RELEASE_SCHEMA_ROUTE, "historical-as-standard23"],
      [historical, DIRECT14_23_RELEASE_SCHEMA_ROUTE, "historical-as-direct23"],
      [historical, STANDARD19_23_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-23"],
      [historical, STANDARD16_24_RELEASE_SCHEMA_ROUTE, "historical-as-standard24"],
      [historical, DIRECT14_24_RELEASE_SCHEMA_ROUTE, "historical-as-direct24"],
      [historical, STANDARD19_24_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-24"],
      [historical, STANDARD16_26_RELEASE_SCHEMA_ROUTE, "historical-as-standard26"],
      [historical, DIRECT14_RELEASE_SCHEMA_ROUTE, "historical-as-direct25"],
      [historical, STANDARD19_26_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-26"],
    ]) {
      const destination = join(parent, name);
      assert.throws(
        () => assembleReleaseBundle({ source: fixture.root, destination, expectedSha: fixture.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute }),
        (error) => error?.code === "SCHEMA_BOUNDARY_MISMATCH",
        name,
      );
      assert.equal(existsSync(destination), false, name);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("historical 001-022 routes still assemble and validate only 022 bundles", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-historical-022-"));
  try {
    mkdirSync(join(parent, "h"));
    mkdirSync(join(parent, "c"));
    const historical = createFixtureRepository(join(parent, "h"), RELEASE_MIGRATIONS_001_022);
    const current = createFixtureRepository(join(parent, "c"));
    for (const [route, rollback] of [
      [STANDARD16_22_RELEASE_SCHEMA_ROUTE, 16],
      [DIRECT14_22_RELEASE_SCHEMA_ROUTE, 14],
      [STANDARD19_22_RELEASE_SCHEMA_ROUTE, 19],
    ]) {
      const bundle = join(parent, `historical-${route}`);
      assembleReleaseBundle({ source: historical.root, destination: bundle, expectedSha: historical.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: route });
      const manifest = JSON.parse(readFileSync(join(bundle, "release-manifest.json"), "utf8"));
      assert.equal(manifest.schemaRoute, route);
      assert.deepEqual(manifest.schemaBoundary, { rollback, candidate: 22 });
      assert.deepEqual(manifest.migrations, [...RELEASE_MIGRATIONS_001_022]);
      assert.equal(validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: route }).status, "ok");
      // A 022 bundle never passes as a later candidate.
      for (const currentRoute of [undefined, STANDARD16_23_RELEASE_SCHEMA_ROUTE, DIRECT14_23_RELEASE_SCHEMA_ROUTE, STANDARD19_23_RELEASE_SCHEMA_ROUTE, STANDARD16_24_RELEASE_SCHEMA_ROUTE, STANDARD16_25_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE, STANDARD19_24_RELEASE_SCHEMA_ROUTE, STANDARD19_25_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE]) {
        assert.throws(
          () => validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: currentRoute }),
          (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
          `${route} bundle as ${currentRoute}`,
        );
      }
    }
    // Routes never cross generations at assembly time.
    for (const [fixture, schemaRoute, name] of [
      [current, STANDARD16_22_RELEASE_SCHEMA_ROUTE, "current-as-standard22"],
      [current, DIRECT14_22_RELEASE_SCHEMA_ROUTE, "current-as-direct22"],
      [current, STANDARD19_22_RELEASE_SCHEMA_ROUTE, "current-as-standard19-22"],
      [historical, STANDARD16_23_RELEASE_SCHEMA_ROUTE, "historical-as-standard23"],
      [historical, DIRECT14_23_RELEASE_SCHEMA_ROUTE, "historical-as-direct23"],
      [historical, STANDARD19_23_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-23"],
      [historical, STANDARD16_24_RELEASE_SCHEMA_ROUTE, "historical-as-standard24"],
      [historical, DIRECT14_24_RELEASE_SCHEMA_ROUTE, "historical-as-direct24"],
      [historical, STANDARD19_24_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-24"],
      [historical, STANDARD16_26_RELEASE_SCHEMA_ROUTE, "historical-as-standard26"],
      [historical, DIRECT14_RELEASE_SCHEMA_ROUTE, "historical-as-direct25"],
      [historical, STANDARD19_26_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-26"],
    ]) {
      const destination = join(parent, name);
      assert.throws(
        () => assembleReleaseBundle({ source: fixture.root, destination, expectedSha: fixture.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute }),
        (error) => error?.code === "SCHEMA_BOUNDARY_MISMATCH",
        name,
      );
      assert.equal(existsSync(destination), false, name);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("historical 001-023 routes still assemble and validate only 023 bundles", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-historical-023-"));
  try {
    mkdirSync(join(parent, "h"));
    mkdirSync(join(parent, "c"));
    const historical = createFixtureRepository(join(parent, "h"), RELEASE_MIGRATIONS_001_023);
    const current = createFixtureRepository(join(parent, "c"));
    for (const [route, rollback] of [
      [STANDARD16_23_RELEASE_SCHEMA_ROUTE, 16],
      [DIRECT14_23_RELEASE_SCHEMA_ROUTE, 14],
      [STANDARD19_23_RELEASE_SCHEMA_ROUTE, 19],
    ]) {
      const bundle = join(parent, `historical-${route}`);
      assembleReleaseBundle({ source: historical.root, destination: bundle, expectedSha: historical.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute: route });
      const manifest = JSON.parse(readFileSync(join(bundle, "release-manifest.json"), "utf8"));
      assert.equal(manifest.schemaRoute, route);
      assert.deepEqual(manifest.schemaBoundary, { rollback, candidate: 23 });
      assert.deepEqual(manifest.migrations, [...RELEASE_MIGRATIONS_001_023]);
      assert.equal(validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: route }).status, "ok");
      // A 023 bundle never passes as a 024 or 025 candidate.
      for (const currentRoute of [undefined, STANDARD16_24_RELEASE_SCHEMA_ROUTE, STANDARD16_25_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE, STANDARD19_24_RELEASE_SCHEMA_ROUTE, STANDARD19_25_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE]) {
        assert.throws(
          () => validateBundle({ bundle, expectedSha: historical.sha, validationMode: "local-dry-run", schemaRoute: currentRoute }),
          (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
          `${route} bundle as ${currentRoute}`,
        );
      }
    }
    // Routes never cross generations at assembly time.
    for (const [fixture, schemaRoute, name] of [
      [current, STANDARD16_23_RELEASE_SCHEMA_ROUTE, "current-as-standard23"],
      [current, DIRECT14_23_RELEASE_SCHEMA_ROUTE, "current-as-direct23"],
      [current, STANDARD19_23_RELEASE_SCHEMA_ROUTE, "current-as-standard19-23"],
      [historical, STANDARD16_24_RELEASE_SCHEMA_ROUTE, "historical-as-standard24"],
      [historical, DIRECT14_24_RELEASE_SCHEMA_ROUTE, "historical-as-direct24"],
      [historical, STANDARD19_24_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-24"],
      [historical, STANDARD16_26_RELEASE_SCHEMA_ROUTE, "historical-as-standard26"],
      [historical, DIRECT14_RELEASE_SCHEMA_ROUTE, "historical-as-direct25"],
      [historical, STANDARD19_26_RELEASE_SCHEMA_ROUTE, "historical-as-standard19-26"],
    ]) {
      const destination = join(parent, name);
      assert.throws(
        () => assembleReleaseBundle({ source: fixture.root, destination, expectedSha: fixture.sha, provenanceMode: LOCAL_PROVENANCE_MODE, schemaRoute }),
        (error) => error?.code === "SCHEMA_BOUNDARY_MISMATCH",
        name,
      );
      assert.equal(existsSync(destination), false, name);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("assembler rejects missing, extra, or wrong Migration 020 inputs", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-schema-"));
  const cases = [
    {
      name: "missing",
      mutate(root) {
        rmSync(
          join(
            root,
            "auth-service/src/migrations/020_tickets.sql",
          ),
        );
      },
    },
    {
      name: "extra",
      mutate(root) {
        writeFixtureFile(
          root,
          "auth-service/src/migrations/021_unexpected.sql",
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
            "auth-service/src/migrations/020_tickets.sql",
          ),
        );
        writeFixtureFile(
          root,
          "auth-service/src/migrations/020_wrong.sql",
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

test("bundle validation rejects omitted, replaced, added, or symlinked HTTP contract inputs", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-http-contract-"));
  try {
    const fixture = createFixtureRepository(parent);
    const baseline = join(parent, "bundle-baseline");
    assembleReleaseBundle({
      source: fixture.root,
      destination: baseline,
      expectedSha: fixture.sha,
      provenanceMode: LOCAL_PROVENANCE_MODE,
    });

    for (const [pathIndex, relativePath] of RELEASE_HTTP_CONTRACT_PATHS.entries()) {
      for (const mutation of ["omitted", "replaced", "symlinked"]) {
        const bundle = join(parent, `bundle-${pathIndex}-${mutation}`);
        cpSync(baseline, bundle, { recursive: true });
        const target = join(bundle, relativePath);
        if (mutation === "omitted") {
          rmSync(target);
        } else if (mutation === "replaced") {
          writeFileSync(target, "# replaced contract input\n", "utf8");
        } else {
          rmSync(target);
          symlinkSync(join(bundle, "website/package.json"), target, "file");
        }
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
    }

    const added = join(parent, "bundle-added");
    cpSync(baseline, added, { recursive: true });
    writeFixtureFile(
      added,
      "ops/nginx/untracked-open-candidate.conf.example",
      "# untracked candidate\n",
    );
    assert.throws(
      () =>
        validateBundle({
          bundle: added,
          expectedSha: fixture.sha,
          validationMode: "local-dry-run",
        }),
      (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bundle validation rejects Migration 020 drift and old schema boundaries", () => {
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
      "auth-service/src/migrations/020_tickets.sql";
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
            "auth-service/src/migrations/021_unexpected.sql",
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
            "auth-service/src/migrations/020_wrong.sql",
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
      ["wrong-rollback", { rollback: 15, candidate: 23 }],
      ["historical-022-candidate", { rollback: 16, candidate: 22 }],
      ["historical-021-candidate", { rollback: 16, candidate: 21 }],
      ["historical-candidate", { rollback: 16, candidate: 19 }],
      ["historical-020-candidate", { rollback: 16, candidate: 20 }],
      ["wrong-candidate", { rollback: 16, candidate: 17 }],
      ["old-shared-boundary", { rollback: 15, candidate: 16 }],
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

test("runbook and bindings describe rollback 016 and candidate 025 consistently", () => {
  const runbook = readFileSync(RUNBOOK_PATH, "utf8");
  for (const fragment of [
    "PRE_RELEASE_SCHEMA_BOUNDARY: 16",
    "CANDIDATE_SCHEMA_BOUNDARY: 17",
    "migrations 001-024",
    "migrations 001-025",
    "migrations 001-026",
    "continuous prefix 001-016",
    "continuous migrations through 016",
    "Startup may apply migrations 017, 018, 019, 020, 021, 022, 023, 024, 025 and 026",
    "migration prefix 001-026",
    "Never open the old binary on a database containing migration 017, 018, 019, 020, 021, 022, 023, 024 or 025",
    "## Explicit DIRECT14 to 20 route",
    "Never start a 001-019 binary against\na database containing migration 020",
    "## Explicit STANDARD19 to 20 route",
    "`rollback: 19, candidate: 20`",
    "consolidated-release-standard19-<RELEASE_CANDIDATE_SHA>",
    "Their roots may differ",
    "Only then is a restorable 019 snapshot established.",
    "Startup may apply only migration **020**",
    "remains unproven until the site checks above are recorded",
    "never\noverwrite or restore the database, and never start a 001-019 Auth binary on a\ndatabase containing migration 020",
    "There is no rollback artifact for a\ndatabase at 020, and none may be assumed",
    "## Explicit DIRECT14 to 21 route",
    "`rollback: 14, candidate: 21`, and list exactly migrations 001-021",
    "## Explicit STANDARD19 to 21 route",
    "`rollback: 19, candidate: 21`",
    "never start a 001-019 or 001-020\nAuth binary on a database containing migration 021",
    "## Migration 021 table rebuild",
    "`schema_migrations` record for 021 commit in ONE exclusive transaction",
    "the service never runs with foreign keys off",
    "## Explicit DIRECT14 to 22 route",
    "`rollback: 14, candidate: 22`, and list exactly migrations 001-022",
    "## Explicit STANDARD19 to 22 route",
    "`rollback: 19, candidate: 22`",
    "## Migration 022 forward-only additive change",
    "(`database contains unknown migration version 22`), so after 022 applies there\nis no code-only rollback",
    "## Explicit DIRECT14 to 23 route",
    "`rollback: 14, candidate: 23`, and list exactly migrations 001-023",
    "## Explicit STANDARD19 to 23 route",
    "`rollback: 19, candidate: 23`",
    "## Migration 023 forward-only grant delivery",
    "(`database contains unknown migration version 23`), so after 023 applies there\nis no code-only rollback",
    "## Explicit DIRECT14 to 24 route",
    "`rollback: 14, candidate: 24`, and list exactly migrations 001-024",
    "## Explicit STANDARD19 to 24 route",
    "`rollback: 19, candidate: 24`",
    "## Migration 024 forward-only gift delivery VPS binding",
    "(`database contains unknown migration version 24`), so after 024 applies there\nis no code-only rollback",
    "## Explicit DIRECT14 to 25 route",
    "`rollback: 14, candidate: 25`, and list exactly migrations 001-025",
    "## Explicit STANDARD19 to 25 route",
    "`rollback: 19, candidate: 25`",
    "## Migration 025 forward-only ticket attachments and grant link",
    "(`database contains unknown migration version 25`), so after 025 applies there\nis no code-only rollback",
    "## Explicit DIRECT14 to 26 route",
    "`rollback: 14, candidate: 26`, and list exactly migrations 001-026",
    "## Explicit STANDARD19 to 26 route",
    "`rollback: 19, candidate: 26`",
    "## Migration 026 forward-only wallet accounting",
    "(`database contains unknown migration version 26`), so after 026 applies there\nis no code-only rollback",
  ]) {
    assert.equal(runbook.includes(fragment), true, fragment);
  }

  const bindings = readFileSync(BINDINGS_PATH, "utf8");
  for (const fragment of [
    "migrations 001-026 match inventory",
    "compatible with continuous migrations 001-016",
    "loopback health, schema 001-026",
    "MIGRATION_021_REBUILD_PROOF",
    "MIGRATION_022_FORWARD_ONLY_PROOF",
    "MIGRATION_023_FORWARD_ONLY_PROOF",
    "MIGRATION_024_FORWARD_ONLY_PROOF",
    "MIGRATION_025_FORWARD_ONLY_PROOF",
    "MIGRATION_026_FORWARD_ONLY_PROOF",
    "STANDARD19_ROUTE_AUTHORIZATION",
    "STANDARD19_CANDIDATE_ARTIFACT_PROOF",
    "STANDARD19_OLD_RELEASE_UNIT_PROOF",
    "STANDARD19_SCHEMA_PROOF",
    "STANDARD19_SQLITE_SNAPSHOT_PROOF",
    "STANDARD19_PRE_OPEN_RESTORE_PROOF",
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

test("monitor Auth release validator pins the target-free source contract and fails closed", () => {
  assert.equal(
    validateMonitorAuthProjectionSources(REPOSITORY_ROOT).status,
    "ok",
  );

  const cases = [
    {
      path: "auth-service/src/http/monitor-routes.ts",
      mutate(source) {
        return source.replace(
          'url: "/api/me/monitor-status"',
          'url: "/api/me/changed-status"',
        );
      },
    },
    {
      path: "auth-service/src/config.ts",
      mutate(source) {
        return `${source}\n// MONITOR_API_ORIGIN\n`;
      },
    },
    {
      path: "auth-service/src/http/payment-routes.ts",
      mutate(source) {
        return `${source}\n// monitorTargetKey\n`;
      },
    },
    {
      path: "website/app/lib/buyerStatusLink.ts",
      mutate(source) {
        return `${source}\n// ?vps=\n`;
      },
    },
  ];
  for (const scenario of cases) {
    const original = readFileSync(join(REPOSITORY_ROOT, scenario.path), "utf8");
    assert.throws(
      () =>
        validateMonitorAuthProjectionSources(REPOSITORY_ROOT, {
          [scenario.path]: scenario.mutate(original),
        }),
      (error) => error?.code === "PACKET_INCOMPLETE",
      scenario.path,
    );
  }
});

test("runbook and bindings pin liveness, aggregate readiness, and traffic-mode ownership", () => {
  const runbook = readFileSync(RUNBOOK_PATH, "utf8");
  for (const fragment of [
    'loopback\n   `GET /health` liveness response is exactly `200 {"status":"ok"}`',
    'loopback `GET /ready` to\n    return exact `200 {"status":"ready"}` with `Cache-Control: no-store`',
    "Disabled payment or mail is an accepted configured state",
    "`/ready` performs no live provider probe",
    "neither\n    `/ready` nor payment enablement proves quiescent, closed, or open traffic",
  ]) {
    assert.equal(runbook.includes(fragment), true, fragment);
  }

  const bindings = readFileSync(BINDINGS_PATH, "utf8");
  for (const fragment of [
    '`GET /health` liveness response `200 {"status":"ok"}`',
    "Loopback `GET /ready` is the normal aggregate readiness proof",
    '`200 {"status":"ready"}` with `Cache-Control: no-store`',
    "It performs no provider reachability probe",
    "Disabled payment or mail is an accepted configured readiness state",
    "Release configuration, active\nNginx topology, and external binding evidence own that proof",
  ]) {
    assert.equal(bindings.includes(fragment), true, fragment);
  }
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

// A realistic source for the repository gate: this repository's committed tree
// plus ignored build placeholders. `historical` rewrites it into a 001-019 source
// (no migration 020, no 020 runbook section, 019 CI route), like a real 019 commit.
function createArchiveSource(parent, name, { generation = 26 } = {}) {
  const root = join(parent, name);
  mkdirSync(root);
  const archive = spawnSync("git", ["-C", REPOSITORY_ROOT, "archive", "--format=tar", "HEAD"], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, String(archive.stderr));
  const extracted = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout });
  assert.equal(extracted.status, 0, String(extracted.stderr));
  writeFixtureFile(root, "auth-service/dist/src/db.js", "export const db = true;\n");
  writeFixtureFile(root, "auth-service/dist/src/server.js", "export const server = true;\n");
  writeFixtureFile(root, "website/dist/index.html", "<!doctype html><title>fixture</title>\n");
  writeFixtureFile(
    root,
    "website/dist/referral.html",
    '<!doctype html><script type="module" src="/assets/referral-12345678.js"></script>\n',
  );
  writeFixtureFile(root, "website/dist/assets/referral-12345678.js", "export {};\n");
  if (generation < 26) {
    // Strip the source back to an exact historical generation: its migrations,
    // runner entries, later runbook sections, and later CI route flags.
    const later = ["020_tickets.sql", "021_personal_invites.sql", "022_admin_service_management.sql", "023_admin_grant_delivery.sql", "024_grant_delivery_monitor_target.sql", "025_ticket_attachments_and_grant_link.sql", "026_wallet.sql"];
    const dropped = later.slice(generation - 19);
    const dbPath = join(root, "auth-service/src/db.ts");
    let db = readFileSync(dbPath, "utf8");
    for (const migration of dropped) {
      rmSync(join(root, `auth-service/src/migrations/${migration}`));
      assert.equal(db.includes(`  "${migration}",\n`), true);
      db = db.replace(`  "${migration}",\n`, "");
    }
    writeFileSync(dbPath, db);
    const runbookPath = join(root, "docs/ops/consolidated-release-runbook.md");
    const runbook = readFileSync(runbookPath, "utf8");
    const start = runbook.indexOf(`## Explicit DIRECT14 to ${generation + 1} route`);
    const end = runbook.indexOf("## Monitor boundary"); // also drops the later STANDARD19 and migration sections
    assert.ok(start > 0 && end > start);
    writeFileSync(
      runbookPath,
      (runbook.slice(0, start) + runbook.slice(end)).replaceAll("--schema-route standard16-26", `--schema-route standard16-${generation}`),
    );
    const workflowPath = join(root, ".github/workflows/ci.yml");
    const standard19Route = generation === 19 ? "standard16-19" : `standard19-${generation}`;
    writeFileSync(
      workflowPath,
      readFileSync(workflowPath, "utf8")
        .replaceAll("--schema-route direct14-26", `--schema-route direct14-${generation}`)
        .replaceAll("--schema-route standard16-26", `--schema-route standard16-${generation}`)
        .replaceAll("--schema-route standard19-26", `--schema-route ${standard19Route}`),
    );
  }
  runGit(root, "init", "--initial-branch=main");
  runGit(root, "add", "--all");
  runGit(root, "commit", "-m", name);
  return { root, sha: runGit(root, "rev-parse", "HEAD") };
}

function cli(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    json: result.status === 0 ? JSON.parse(result.stdout) : JSON.parse(result.stderr),
  };
}

test("validator CLI validates a historical 019 bundle against its own 019 source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-019-"));
  try {
    const source = createArchiveSource(parent, "source-019", { generation: 19 });
    for (const schemaRoute of [STANDARD16_19_RELEASE_SCHEMA_ROUTE, DIRECT14_19_RELEASE_SCHEMA_ROUTE]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
      assert.equal(validated.json.bundleValidated, true);
      // The same 019 source and bundle never pass under a later route.
      const laterRoutes = schemaRoute === DIRECT14_19_RELEASE_SCHEMA_ROUTE
        ? [DIRECT14_20_RELEASE_SCHEMA_ROUTE, DIRECT14_21_RELEASE_SCHEMA_ROUTE, DIRECT14_22_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE]
        : [STANDARD16_20_RELEASE_SCHEMA_ROUTE, STANDARD16_21_RELEASE_SCHEMA_ROUTE, STANDARD16_22_RELEASE_SCHEMA_ROUTE, STANDARD16_25_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE];
      for (const laterRoute of laterRoutes) {
        const asLater = cli(VALIDATOR_PATH, [
          "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
          "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", laterRoute,
        ]);
        assert.equal(asLater.status, 1);
        assert.equal(asLater.json.code, "SCHEMA_BOUNDARY_MISMATCH");
      }
    }
    for (const standard19Route of [STANDARD19_20_RELEASE_SCHEMA_ROUTE, STANDARD19_21_RELEASE_SCHEMA_ROUTE, STANDARD19_22_RELEASE_SCHEMA_ROUTE, STANDARD19_24_RELEASE_SCHEMA_ROUTE, STANDARD19_25_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE]) {
      const standard19OnHistorical = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", join(parent, `${standard19Route}-on-019`), "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", standard19Route,
      ]);
      assert.equal(standard19OnHistorical.status, 1);
      assert.equal(standard19OnHistorical.json.code, "SCHEMA_BOUNDARY_MISMATCH");
    }
    // Without a bundle, the repository gate stays strict on the current 001-023 route.
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 1);
    assert.equal(repositoryOnly.json.code, "SCHEMA_BOUNDARY_MISMATCH");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validator CLI validates a historical 020 bundle against its own 020 source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-020-"));
  try {
    const source = createArchiveSource(parent, "source-020", { generation: 20 });
    for (const [schemaRoute, currentRoute] of [
      [STANDARD16_20_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE],
      [DIRECT14_20_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE],
      [STANDARD19_20_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE],
    ]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
      // The same 020 source and bundle never pass under a current route.
      const asCurrent = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", currentRoute,
      ]);
      assert.equal(asCurrent.status, 1);
      assert.equal(asCurrent.json.code, "SCHEMA_BOUNDARY_MISMATCH");
    }
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 1);
    assert.equal(repositoryOnly.json.code, "SCHEMA_BOUNDARY_MISMATCH");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validator CLI validates a historical 021 bundle against its own 021 source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-021-"));
  try {
    const source = createArchiveSource(parent, "source-021", { generation: 21 });
    for (const [schemaRoute, currentRoute] of [
      [STANDARD16_21_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE],
      [DIRECT14_21_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE],
      [STANDARD19_21_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE],
    ]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
      // The same 021 source and bundle never pass under a current route.
      const asCurrent = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", currentRoute,
      ]);
      assert.equal(asCurrent.status, 1);
      assert.equal(asCurrent.json.code, "SCHEMA_BOUNDARY_MISMATCH");
    }
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 1);
    assert.equal(repositoryOnly.json.code, "SCHEMA_BOUNDARY_MISMATCH");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validator CLI validates a historical 022 bundle against its own 022 source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-022-"));
  try {
    const source = createArchiveSource(parent, "source-022", { generation: 22 });
    for (const [schemaRoute, currentRoute] of [
      [STANDARD16_22_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE],
      [DIRECT14_22_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE],
      [STANDARD19_22_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE],
    ]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
      // The same 022 source and bundle never pass under a current route.
      const asCurrent = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", currentRoute,
      ]);
      assert.equal(asCurrent.status, 1);
      assert.equal(asCurrent.json.code, "SCHEMA_BOUNDARY_MISMATCH");
    }
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 1);
    assert.equal(repositoryOnly.json.code, "SCHEMA_BOUNDARY_MISMATCH");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validator CLI validates a historical 023 bundle against its own 023 source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-023-"));
  try {
    const source = createArchiveSource(parent, "source-023", { generation: 23 });
    for (const [schemaRoute, currentRoute] of [
      [STANDARD16_23_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE],
      [DIRECT14_23_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE],
      [STANDARD19_23_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE],
    ]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
      // The same 023 source and bundle never pass under a current route.
      const asCurrent = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", currentRoute,
      ]);
      assert.equal(asCurrent.status, 1);
      assert.equal(asCurrent.json.code, "SCHEMA_BOUNDARY_MISMATCH");
    }
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 1);
    assert.equal(repositoryOnly.json.code, "SCHEMA_BOUNDARY_MISMATCH");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validator CLI validates a historical 025 bundle against its own 025 source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-025-"));
  try {
    const source = createArchiveSource(parent, "source-025", { generation: 25 });
    for (const [schemaRoute, currentRoute] of [
      [STANDARD16_25_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE],
      [DIRECT14_25_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE],
      [STANDARD19_25_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE],
    ]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
      // The same 025 source and bundle never pass under a current route.
      const asCurrent = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", currentRoute,
      ]);
      assert.equal(asCurrent.status, 1);
      assert.equal(asCurrent.json.code, "SCHEMA_BOUNDARY_MISMATCH");
    }
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 1);
    assert.equal(repositoryOnly.json.code, "SCHEMA_BOUNDARY_MISMATCH");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validator CLI validates a historical 024 bundle against its own 024 source", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-024-"));
  try {
    const source = createArchiveSource(parent, "source-024", { generation: 24 });
    for (const [schemaRoute, currentRoute] of [
      [STANDARD16_24_RELEASE_SCHEMA_ROUTE, STANDARD16_26_RELEASE_SCHEMA_ROUTE],
      [DIRECT14_24_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE],
      [STANDARD19_24_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE],
    ]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
      // The same 024 source and bundle never pass under a current route.
      const asCurrent = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", currentRoute,
      ]);
      assert.equal(asCurrent.status, 1);
      assert.equal(asCurrent.json.code, "SCHEMA_BOUNDARY_MISMATCH");
    }
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 1);
    assert.equal(repositoryOnly.json.code, "SCHEMA_BOUNDARY_MISMATCH");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validator CLI keeps the current 001-026 source strict", () => {
  const parent = mkdtempSync(join(tmpdir(), "consolidated-release-cli-026-"));
  try {
    const source = createArchiveSource(parent, "source-026");
    const repositoryOnly = cli(VALIDATOR_PATH, ["--source", source.root, "--expected-sha", source.sha]);
    assert.equal(repositoryOnly.status, 0, JSON.stringify(repositoryOnly.json));
    for (const schemaRoute of [STANDARD16_26_RELEASE_SCHEMA_ROUTE, DIRECT14_RELEASE_SCHEMA_ROUTE, STANDARD19_26_RELEASE_SCHEMA_ROUTE]) {
      const bundle = join(parent, `bundle-${schemaRoute}`);
      const assembled = cli(ASSEMBLER_PATH, [
        "--source", source.root, "--destination", bundle, "--expected-sha", source.sha,
        "--provenance-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(assembled.status, 0, JSON.stringify(assembled.json));
      const validated = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(validated.status, 0, `${schemaRoute}: ${JSON.stringify(validated.json)}`);
    }
    // A 026 source cannot be validated as a historical 019-025 release.
    const bundle = join(parent, `bundle-${STANDARD16_26_RELEASE_SCHEMA_ROUTE}`);
    for (const schemaRoute of [
      STANDARD16_19_RELEASE_SCHEMA_ROUTE,
      DIRECT14_19_RELEASE_SCHEMA_ROUTE,
      STANDARD16_20_RELEASE_SCHEMA_ROUTE,
      DIRECT14_20_RELEASE_SCHEMA_ROUTE,
      STANDARD19_20_RELEASE_SCHEMA_ROUTE,
      STANDARD16_21_RELEASE_SCHEMA_ROUTE,
      DIRECT14_21_RELEASE_SCHEMA_ROUTE,
      STANDARD19_21_RELEASE_SCHEMA_ROUTE,
      STANDARD16_22_RELEASE_SCHEMA_ROUTE,
      DIRECT14_22_RELEASE_SCHEMA_ROUTE,
      STANDARD19_22_RELEASE_SCHEMA_ROUTE,
      STANDARD16_23_RELEASE_SCHEMA_ROUTE,
      DIRECT14_23_RELEASE_SCHEMA_ROUTE,
      STANDARD19_23_RELEASE_SCHEMA_ROUTE,
      STANDARD16_24_RELEASE_SCHEMA_ROUTE,
      DIRECT14_24_RELEASE_SCHEMA_ROUTE,
      STANDARD19_24_RELEASE_SCHEMA_ROUTE,
      STANDARD16_25_RELEASE_SCHEMA_ROUTE,
      DIRECT14_25_RELEASE_SCHEMA_ROUTE,
      STANDARD19_25_RELEASE_SCHEMA_ROUTE,
    ]) {
      const asHistorical = cli(VALIDATOR_PATH, [
        "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
        "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", schemaRoute,
      ]);
      assert.equal(asHistorical.status, 1, schemaRoute);
      assert.equal(asHistorical.json.code, "SCHEMA_BOUNDARY_MISMATCH", schemaRoute);
    }
    const unknownRoute = cli(VALIDATOR_PATH, [
      "--source", source.root, "--expected-sha", source.sha, "--bundle", bundle,
      "--validation-mode", LOCAL_PROVENANCE_MODE, "--schema-route", "standard16-27",
    ]);
    assert.equal(unknownRoute.status, 1);
    assert.equal(unknownRoute.json.code, "ARGUMENT_ERROR");
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

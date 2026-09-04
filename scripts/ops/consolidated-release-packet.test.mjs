import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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

import {
  assembleReleaseBundle,
  isForbiddenBundlePath,
  RELEASE_MIGRATIONS,
} from "./assemble-consolidated-release.mjs";
import { validateBundle } from "./validate-consolidated-release-packet.mjs";

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
    });
    const secondResult = assembleReleaseBundle({
      source: fixture.root,
      destination: second,
      expectedSha: fixture.sha,
    });

    assert.deepEqual(firstResult, secondResult);
    assert.equal(
      readFileSync(join(first, "release-manifest.json"), "utf8"),
      readFileSync(join(second, "release-manifest.json"), "utf8"),
    );
    assert.equal(
      validateBundle({ bundle: first, expectedSha: fixture.sha }).status,
      "ok",
    );
    assert.equal(
      validateBundle({ bundle: second, expectedSha: fixture.sha }).status,
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
    });
    writeFileSync(join(bundle, "website/dist/index.html"), "tampered\n", "utf8");
    assert.throws(
      () => validateBundle({ bundle, expectedSha: fixture.sha }),
      (error) => error?.code === "BUNDLE_INTEGRITY_FAILED",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
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
        }),
      (error) => error?.code === "SOURCE_INVALID",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

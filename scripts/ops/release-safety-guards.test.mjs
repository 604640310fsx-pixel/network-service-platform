import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  validatedMonitorOrigin,
  verifyWebsiteMonitorOrigin,
} from "./verify-website-monitor-origin.mjs";
import { assertIsolatedRehearsal } from "./isolated-rehearsal-start.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://monitor.example.net";
const scratch = mkdtempSync(join(tmpdir(), "nsp-release-guards-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeFile(path, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error.code === code);
}

describe("verify-website-monitor-origin", () => {
  const dist = join(scratch, "dist");
  writeFile(join(dist, "index.html"), "<!doctype html>\n");
  writeFile(join(dist, "assets/index-abc.js"), `const m="${ORIGIN}";\n`);
  const emptyDist = join(scratch, "dist-without-origin");
  writeFile(join(emptyDist, "index.html"), "<!doctype html>\n");
  writeFile(join(emptyDist, "assets/index-abc.js"), "const m=undefined;\n");

  test("accepts only a bare https origin with a DNS hostname", () => {
    assert.equal(validatedMonitorOrigin(ORIGIN), ORIGIN);
    for (const bad of [
      "http://monitor.example.net",
      `${ORIGIN}/`,
      `${ORIGIN}/path`,
      `${ORIGIN}?a=1`,
      "https://user@monitor.example.net",
      "https://192.0.2.10",
      "https://[2001:db8::1]",
      "https://localhost",
      "not a url",
    ]) {
      assertCode(() => validatedMonitorOrigin(bad), "MONITOR_ORIGIN_INVALID");
    }
  });

  test("required policy fails closed when the origin is missing", () => {
    for (const phase of ["configured", "embedded"]) {
      assertCode(
        () =>
          verifyWebsiteMonitorOrigin({
            phase,
            policy: "required",
            dist,
            environment: {},
          }),
        "MONITOR_ORIGIN_REQUIRED",
      );
    }
  });

  test("optional policy reports an absent origin as test-only", () => {
    const result = verifyWebsiteMonitorOrigin({
      phase: "embedded",
      policy: "optional",
      dist: emptyDist,
      environment: {},
    });
    assert.equal(result.monitorOrigin, "absent");
    assert.equal(result.releaseUse, "test-only");
  });

  test("embedded phase requires the origin in the built website", () => {
    const environment = { VITE_MONITOR_URL: ORIGIN };
    const result = verifyWebsiteMonitorOrigin({
      phase: "embedded",
      policy: "required",
      dist,
      environment,
    });
    assert.equal(result.monitorOrigin, "embedded");
    assert.equal(result.embeddingFiles, 1);
    assertCode(
      () =>
        verifyWebsiteMonitorOrigin({
          phase: "embedded",
          policy: "optional",
          dist: emptyDist,
          environment,
        }),
      "MONITOR_ORIGIN_NOT_EMBEDDED",
    );
  });

  test("CLI output and errors never contain the origin", () => {
    const script = join(here, "verify-website-monitor-origin.mjs");
    const env = { ...process.env, VITE_MONITOR_URL: ORIGIN };
    const ok = spawnSync(
      process.execPath,
      [script, "--phase", "embedded", "--policy", "required", "--dist", dist],
      { env, encoding: "utf8" },
    );
    assert.equal(ok.status, 0);
    const failed = spawnSync(
      process.execPath,
      [script, "--phase", "embedded", "--policy", "required", "--dist", emptyDist],
      { env, encoding: "utf8" },
    );
    assert.equal(failed.status, 1);
    const invalid = spawnSync(
      process.execPath,
      [script, "--phase", "configured", "--policy", "required"],
      { env: { ...process.env, VITE_MONITOR_URL: `${ORIGIN}/secret-path` }, encoding: "utf8" },
    );
    assert.equal(invalid.status, 1);
    for (const run of [ok, failed, invalid]) {
      assert.equal(`${run.stdout}${run.stderr}`.includes("monitor.example.net"), false);
    }
  });
});

describe("isolated-rehearsal-start", () => {
  const liveDir = join(scratch, "live");
  const liveDb = writeFile(join(liveDir, "auth.sqlite"), "live");
  const root = join(scratch, "rehearsal");
  const copy = writeFile(join(root, "copy.sqlite"), "copy");
  const base = {
    protectedDb: liveDb,
    protectedPort: "3101",
    rehearsalRoot: root,
  };

  test("allows a copy inside the rehearsal root on another port", () => {
    const result = assertIsolatedRehearsal({
      ...base,
      environment: { DB_PATH: copy, PORT: "3197" },
    });
    assert.equal(result.status, "ok");
    assert.equal(JSON.stringify(result).includes(scratch), false);
  });

  test("refuses the live database after environment resolution", () => {
    assertCode(
      () =>
        assertIsolatedRehearsal({
          ...base,
          environment: { DB_PATH: liveDb, PORT: "3197" },
        }),
      "REHEARSAL_REFUSED",
    );
  });

  test("refuses a hard link or symlink to the live database", () => {
    const hard = join(root, "hard.sqlite");
    linkSync(liveDb, hard);
    const soft = join(root, "soft.sqlite");
    symlinkSync(liveDb, soft);
    for (const DB_PATH of [hard, soft]) {
      assertCode(
        () =>
          assertIsolatedRehearsal({
            ...base,
            environment: { DB_PATH, PORT: "3197" },
          }),
        "REHEARSAL_REFUSED",
      );
    }
  });

  test("refuses the live port, missing values, and paths outside the root", () => {
    const outside = writeFile(join(scratch, "outside.sqlite"), "x");
    for (const environment of [
      { DB_PATH: copy, PORT: "3101" },
      { DB_PATH: copy },
      { PORT: "3197" },
      { DB_PATH: "relative.sqlite", PORT: "3197" },
      { DB_PATH: join(root, "missing.sqlite"), PORT: "3197" },
      { DB_PATH: outside, PORT: "3197" },
    ]) {
      assertCode(
        () => assertIsolatedRehearsal({ ...base, environment }),
        "REHEARSAL_REFUSED",
      );
    }
  });

  test("refuses a rehearsal root that contains the live database", () => {
    assertCode(
      () =>
        assertIsolatedRehearsal({
          ...base,
          rehearsalRoot: scratch,
          environment: { DB_PATH: copy, PORT: "3197" },
        }),
      "REHEARSAL_REFUSED",
    );
    assertCode(
      () =>
        assertIsolatedRehearsal({
          ...base,
          rehearsalRoot: liveDir,
          environment: { DB_PATH: liveDb, PORT: "3197" },
        }),
      "REHEARSAL_REFUSED",
    );
  });

  test("CLI never starts the server when refused", () => {
    const marker = join(scratch, "server-started");
    const server = writeFile(
      join(scratch, "server.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    const script = join(here, "isolated-rehearsal-start.mjs");
    const args = [
      script,
      "--protected-db", liveDb,
      "--protected-port", "3101",
      "--rehearsal-root", root,
      "--server", server,
    ];
    const refused = spawnSync(process.execPath, args, {
      env: { ...process.env, DB_PATH: liveDb, PORT: "3197" },
      encoding: "utf8",
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /REHEARSAL_REFUSED/);
    assert.equal(refused.stderr.includes(scratch), false);
    assert.equal(existsSync(marker), false);
    const allowed = spawnSync(process.execPath, args, {
      env: { ...process.env, DB_PATH: copy, PORT: "3197" },
      encoding: "utf8",
    });
    assert.equal(allowed.status, 0);
    assert.equal(existsSync(marker), true);
  });
});

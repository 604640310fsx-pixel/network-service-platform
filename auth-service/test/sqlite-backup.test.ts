import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  initializeDatabase,
  MIGRATION_FILES,
  openAndVerifyDatabase,
  runMigrations,
  type DatabaseConnection,
} from "../src/db.js";

const require = createRequire(import.meta.url);

interface DatabaseConstructor {
  new (
    filename: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ): DatabaseConnection;
}

interface ToolResult {
  readonly status: "ok";
  readonly operation: "create" | "verify";
  readonly quickCheck: "ok";
  readonly foreignKeyFailures: 0;
  readonly migrations: readonly number[];
  readonly sha256: string;
  readonly bytes: number;
  readonly fileMode: "0600";
}

interface ToolFailure {
  readonly status: "error";
  readonly code: string;
  readonly message: string;
}

const Database = require("better-sqlite3") as DatabaseConstructor;
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const AUTH_SERVICE_DIRECTORY = resolve(TEST_DIRECTORY, "../..");
const TOOL_PATH = join(AUTH_SERVICE_DIRECTORY, "scripts/sqlite-backup.mjs");
const MIGRATIONS_DIRECTORY = join(AUTH_SERVICE_DIRECTORY, "src/migrations");

function executeTool(arguments_: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [TOOL_PATH, ...arguments_],
      {
        cwd: AUTH_SERVICE_DIRECTORY,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

function parseSuccess(output: string): ToolResult {
  return JSON.parse(output) as ToolResult;
}

function parseFailure(output: string): ToolFailure {
  return JSON.parse(output) as ToolFailure;
}

function openFixture(path: string, migrations = [1]): DatabaseConnection {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("wal_autocheckpoint = 0");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE backup_probe (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const version of migrations) {
    insertMigration.run(version, "2026-08-28T00:00:00.000Z");
  }
  return database;
}

async function openMigration13Fixture(path: string): Promise<DatabaseConnection> {
  const database = openAndVerifyDatabase(path);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const file of MIGRATION_FILES.slice(0, -1)) {
    const version = Number.parseInt(file.slice(0, 3), 10);
    const sql = await readFile(join(MIGRATIONS_DIRECTORY, file), "utf8");
    const applyMigration = database.transaction(() => {
      database.exec(sql);
      recordMigration.run(version, "2026-08-28T00:00:00.000Z");
    });
    applyMigration();
  }
  return database;
}

test("creates and independently verifies a single-file backup from a live WAL database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-wal-"));
  const source = join(directory, "source.sqlite");
  const backup = join(directory, "backup.sqlite");
  const sourceDatabase = initializeDatabase(source);

  try {
    sourceDatabase.pragma("wal_autocheckpoint = 0");
    sourceDatabase.exec(`
      CREATE TABLE backup_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO backup_probe (id, value) VALUES (1, 'present only in WAL fixture');
    `);
    await access(`${source}-wal`);

    const previousUmask = process.umask(0);
    let created: Awaited<ReturnType<typeof executeTool>>;
    try {
      created = await executeTool([
        "create",
        "--source",
        source,
        "--destination",
        backup,
      ]);
    } finally {
      process.umask(previousUmask);
    }
    assert.equal(created.exitCode, 0, created.stderr);
    assert.equal(created.stderr, "");
    const result = parseSuccess(created.stdout);
    assert.deepEqual(result, {
      status: "ok",
      operation: "create",
      quickCheck: "ok",
      foreignKeyFailures: 0,
      migrations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      sha256: result.sha256,
      bytes: result.bytes,
      fileMode: "0600",
    });
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.bytes > 0);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);

    const backupDatabase = new Database(backup, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.equal(
        backupDatabase.pragma("journal_mode", { simple: true }),
        "delete",
      );
      assert.deepEqual(backupDatabase.pragma("quick_check"), [
        { quick_check: "ok" },
      ]);
      assert.deepEqual(backupDatabase.pragma("foreign_key_check"), []);
      assert.deepEqual(
        backupDatabase
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(
          (version) => ({ version }),
        ),
      );
      assert.deepEqual(
        backupDatabase.prepare("SELECT id, value FROM backup_probe").all(),
        [{ id: 1, value: "present only in WAL fixture" }],
      );
    } finally {
      backupDatabase.close();
    }
    await assert.rejects(access(`${backup}-wal`));
    await assert.rejects(access(`${backup}-shm`));

    const verified = await executeTool([
      "verify",
      "--backup",
      backup,
      "--expected-sha256",
      result.sha256,
      "--expected-last-migration",
      "14",
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.deepEqual(parseSuccess(verified.stdout), {
      ...result,
      operation: "verify",
    });
  } finally {
    sourceDatabase.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an existing destination without changing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-existing-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "existing.sqlite");
  const database = openFixture(source);

  try {
    await writeFile(destination, "do-not-overwrite", "utf8");
    const result = await executeTool([
      "create",
      "--source",
      source,
      "--destination",
      destination,
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(parseFailure(result.stderr).code, "DESTINATION_EXISTS");
    assert.equal(await readFile(destination, "utf8"), "do-not-overwrite");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects source and destination resolving to the same path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-same-"));
  const source = join(directory, "source.sqlite");
  const database = openFixture(source);

  try {
    const result = await executeTool([
      "create",
      "--source",
      source,
      "--destination",
      source,
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(parseFailure(result.stderr).code, "SAME_PATH");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a corrupted backup during independent verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-corrupt-"));
  const source = join(directory, "source.sqlite");
  const backup = join(directory, "backup.sqlite");
  const database = openFixture(source);

  try {
    const created = await executeTool([
      "create",
      "--source",
      source,
      "--destination",
      backup,
    ]);
    assert.equal(created.exitCode, 0, created.stderr);
    const corruptBytes = Buffer.from("not a SQLite database", "utf8");
    await writeFile(backup, corruptBytes);
    const corruptHash = createHash("sha256").update(corruptBytes).digest("hex");

    const verified = await executeTool([
      "verify",
      "--backup",
      backup,
      "--expected-sha256",
      corruptHash,
      "--expected-last-migration",
      "1",
    ]);
    assert.equal(verified.exitCode, 1);
    assert.equal(verified.stdout, "");
    assert.equal(parseFailure(verified.stderr).code, "VERIFICATION_FAILED");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a verified 013 snapshot rollback-compatible after the live source advances to 014", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-rollback-"));
  const source = join(directory, "source.sqlite");
  const backup = join(directory, "backup.sqlite");
  const database = await openMigration13Fixture(source);

  try {
    database.exec(`
      CREATE TABLE backup_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO backup_probe (id, value)
      VALUES (1, 'pre-014 rollback fixture');
    `);
    const created = await executeTool([
      "create",
      "--source",
      source,
      "--destination",
      backup,
    ]);
    assert.equal(created.exitCode, 0, created.stderr);
    const snapshot = parseSuccess(created.stdout);
    assert.deepEqual(
      snapshot.migrations,
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    );

    runMigrations(database);
    assert.deepEqual(
      (
        database
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ readonly version: number }>
      ).map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    );

    const verified = await executeTool([
      "verify",
      "--backup",
      backup,
      "--expected-sha256",
      snapshot.sha256,
      "--expected-last-migration",
      "13",
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.deepEqual(parseSuccess(verified.stdout), {
      ...snapshot,
      operation: "verify",
    });

    const wrongHash = await executeTool([
      "verify",
      "--backup",
      backup,
      "--expected-sha256",
      "0".repeat(64),
      "--expected-last-migration",
      "13",
    ]);
    assert.equal(wrongHash.exitCode, 1);
    assert.equal(parseFailure(wrongHash.stderr).code, "HASH_MISMATCH");

    const wrongBoundary = await executeTool([
      "verify",
      "--backup",
      backup,
      "--expected-sha256",
      snapshot.sha256,
      "--expected-last-migration",
      "14",
    ]);
    assert.equal(wrongBoundary.exitCode, 1);
    assert.equal(parseFailure(wrongBoundary.stderr).code, "MIGRATION_MISMATCH");

    const ambiguousLiveSource = await executeTool([
      "verify",
      "--source",
      source,
      "--backup",
      backup,
      "--expected-sha256",
      snapshot.sha256,
      "--expected-last-migration",
      "13",
    ]);
    assert.equal(ambiguousLiveSource.exitCode, 1);
    assert.equal(parseFailure(ambiguousLiveSource.stderr).code, "ARGUMENT_ERROR");

    const rollbackDatabase = new Database(backup, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.deepEqual(
        (
          rollbackDatabase
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .all() as Array<{ readonly version: number }>
        ).map((row) => row.version),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      );
      assert.equal(
        rollbackDatabase
          .prepare("PRAGMA table_info(service_delivery_items)")
          .all()
          .some(
            (row) =>
              (row as { readonly name: string }).name === "monitor_target_key",
          ),
        false,
      );
      assert.deepEqual(
        rollbackDatabase.prepare("SELECT id, value FROM backup_probe").all(),
        [{ id: 1, value: "pre-014 rollback fixture" }],
      );
    } finally {
      rollbackDatabase.close();
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent verification rejects backup permissions broader than 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-permission-"));
  const source = join(directory, "source.sqlite");
  const backup = join(directory, "backup.sqlite");
  const database = openFixture(source);

  try {
    const created = await executeTool([
      "create",
      "--source",
      source,
      "--destination",
      backup,
    ]);
    assert.equal(created.exitCode, 0, created.stderr);
    const snapshot = parseSuccess(created.stdout);
    await chmod(backup, 0o644);

    const verified = await executeTool([
      "verify",
      "--backup",
      backup,
      "--expected-sha256",
      snapshot.sha256,
      "--expected-last-migration",
      "1",
    ]);
    assert.equal(verified.exitCode, 1);
    assert.equal(parseFailure(verified.stderr).code, "PERMISSION_FAILED");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication failure removes partial database, WAL, SHM, and journal artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-cleanup-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "backup.sqlite");
  const database = openFixture(source);

  try {
    await symlink("missing-target", destination);
    const result = await executeTool([
      "create",
      "--source",
      source,
      "--destination",
      destination,
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(parseFailure(result.stderr).code, "DESTINATION_EXISTS");
    assert.equal(await readlink(destination), "missing-target");
    const entries = await readdir(directory);
    assert.equal(
      entries.some((entry) => entry.startsWith(".backup.sqlite.partial-")),
      false,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes partial output when source verification fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sqlite-backup-invalid-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "backup.sqlite");
  const database = new Database(source);

  try {
    database.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    const result = await executeTool([
      "create",
      "--source",
      source,
      "--destination",
      destination,
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(parseFailure(result.stderr).code, "VERIFICATION_FAILED");
    await assert.rejects(access(destination));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

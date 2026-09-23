import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeDatabase,
  MIGRATION_FILES,
  prepareDatabaseReadinessProbe,
  readPragmaState,
  type DatabaseConnection,
} from "../src/db.js";

const EXPECTED_VERSIONS = MIGRATION_FILES.map((file) =>
  Number.parseInt(file.slice(0, 3), 10),
);

function migrationRows(versions: readonly number[]): unknown[] {
  return versions.map((version) => ({ version }));
}

function readTotalChanges(database: DatabaseConnection): number {
  const row = database.prepare("SELECT total_changes() AS value").all()[0];
  if (
    typeof row !== "object" ||
    row === null ||
    Array.isArray(row) ||
    !("value" in row)
  ) {
    assert.fail("SQLite total_changes() returned an invalid row");
  }
  const value = row.value;
  assert.equal(typeof value, "number");
  return value as number;
}

test("SQLite opens a file database with the approved PRAGMAs", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "auth-service-db-"));
  const databasePath = join(temporaryDirectory, "auth.sqlite");
  let database: DatabaseConnection | undefined;

  try {
    database = initializeDatabase(databasePath);

    assert.deepEqual(readPragmaState(database), {
      foreignKeys: 1,
      journalMode: "wal",
      busyTimeout: 5_000,
      synchronous: 1,
    });

    const readiness = prepareDatabaseReadinessProbe(database);
    const totalChangesBefore = readTotalChanges(database);
    for (let index = 0; index < 32; index += 1) {
      assert.equal(readiness.isReady(), true);
    }
    assert.equal(readTotalChanges(database), totalChangesBefore);
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("database readiness prepares the exact bounded statement once", () => {
  const calls = {
    prepare: [] as string[],
    all: [] as unknown[][],
    exec: 0,
    run: 0,
    pragma: 0,
    provider: 0,
  };
  const database = {
    prepare: (source: string) => {
      calls.prepare.push(source);
      return {
        all: (...parameters: readonly unknown[]): unknown[] => {
          calls.all.push([...parameters]);
          return migrationRows(EXPECTED_VERSIONS);
        },
        run: (): { readonly changes: number } => {
          calls.run += 1;
          throw new Error("readiness must not run a statement");
        },
      };
    },
    exec: (): never => {
      calls.exec += 1;
      throw new Error("readiness must not exec SQL");
    },
    pragma: (): never => {
      calls.pragma += 1;
      throw new Error("readiness must not read a PRAGMA");
    },
    providerCall: (): never => {
      calls.provider += 1;
      throw new Error("readiness must not call a provider");
    },
  };

  const readiness = prepareDatabaseReadinessProbe(database);
  assert.equal(readiness.isReady(), true);
  assert.equal(readiness.isReady(), true);
  assert.deepEqual(calls.prepare, [
    "SELECT version FROM schema_migrations ORDER BY version LIMIT ?",
  ]);
  assert.deepEqual(calls.all, [[18], [18]]);
  assert.deepEqual(
    { exec: calls.exec, run: calls.run, pragma: calls.pragma, provider: calls.provider },
    { exec: 0, run: 0, pragma: 0, provider: 0 },
  );
});

test("database readiness fails closed for incomplete, malformed, unknown, and throwing rows", () => {
  const exactRows = migrationRows(EXPECTED_VERSIONS);
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly rows?: readonly unknown[];
    readonly throwOnAll?: boolean;
    readonly throwOnPrepare?: boolean;
  }> = [
    { name: "missing", rows: exactRows.slice(0, -1) },
    {
      name: "gap",
      rows: migrationRows(
        EXPECTED_VERSIONS.map((version) => (version === 8 ? 9 : version)),
      ),
    },
    {
      name: "malformed",
      rows: exactRows.map((row, index) =>
        index === 7 ? { version: "8" } : row,
      ),
    },
    {
      name: "unknown 018",
      rows: [...exactRows, { version: 18 }],
    },
    { name: "query throws", throwOnAll: true },
    { name: "prepare throws", throwOnPrepare: true },
  ];

  for (const scenario of scenarios) {
    let prepareCalls = 0;
    let allCalls = 0;
    const readiness = prepareDatabaseReadinessProbe({
      prepare: () => {
        prepareCalls += 1;
        if (scenario.throwOnPrepare === true) {
          throw new Error("closed before prepare");
        }
        return {
          all: (...parameters: readonly unknown[]): unknown[] => {
            allCalls += 1;
            assert.deepEqual(parameters, [18]);
            if (scenario.throwOnAll === true) {
              throw new Error("closed after prepare");
            }
            return [...(scenario.rows ?? exactRows)];
          },
          run: () => ({ changes: 0 }),
        };
      },
    });

    assert.equal(readiness.isReady(), false, scenario.name);
    assert.equal(readiness.isReady(), false, `${scenario.name} repeated`);
    assert.equal(prepareCalls, 1, scenario.name);
    assert.equal(
      allCalls,
      scenario.throwOnPrepare === true ? 0 : 2,
      scenario.name,
    );
  }
});

test("database readiness returns false after its prepared SQLite handle closes", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "auth-service-readiness-closed-"),
  );
  const databasePath = join(temporaryDirectory, "auth.sqlite");
  let database: DatabaseConnection | undefined;

  try {
    database = initializeDatabase(databasePath);
    const readiness = prepareDatabaseReadinessProbe(database);
    assert.equal(readiness.isReady(), true);
    database.close();
    database = undefined;
    assert.equal(readiness.isReady(), false);
    assert.equal(readiness.isReady(), false);
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeDatabase,
  readPragmaState,
  type DatabaseConnection,
} from "../src/db.js";

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
  } finally {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

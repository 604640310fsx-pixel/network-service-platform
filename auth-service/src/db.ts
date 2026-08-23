import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

interface PragmaOptions {
  readonly simple?: boolean;
}

export interface DatabaseConnection {
  pragma(source: string, options?: PragmaOptions): unknown;
  exec(source: string): void;
  prepare(source: string): DatabaseStatement;
  transaction<Result>(operation: () => Result): DatabaseTransaction<Result>;
  close(): void;
}

export interface DatabaseTransaction<Result> {
  (): Result;
  immediate(): Result;
}

interface DatabaseStatement {
  all(...parameters: readonly unknown[]): unknown[];
  run(...parameters: readonly unknown[]): { readonly changes: number };
}

interface DatabaseConstructor {
  new (filename: string): DatabaseConnection;
}

const Database = require("better-sqlite3") as DatabaseConstructor;

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SOURCE_MIGRATIONS_DIRECTORY = resolve(MODULE_DIRECTORY, "migrations");
const COMPILED_MIGRATIONS_DIRECTORY = resolve(
  MODULE_DIRECTORY,
  "../../src/migrations",
);

export const MIGRATION_FILES = [
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
] as const;

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const SQLITE_SYNCHRONOUS_NORMAL = 1;

export interface PragmaState {
  readonly foreignKeys: number;
  readonly journalMode: string;
  readonly busyTimeout: number;
  readonly synchronous: number;
}

function readNumberPragma(database: DatabaseConnection, name: string): number {
  const value = database.pragma(name, { simple: true });

  if (typeof value !== "number") {
    throw new Error(`SQLite ${name} PRAGMA did not return a number`);
  }

  return value;
}

function readStringPragma(database: DatabaseConnection, name: string): string {
  const value = database.pragma(name, { simple: true });

  if (typeof value !== "string") {
    throw new Error(`SQLite ${name} PRAGMA did not return a string`);
  }

  return value.toLowerCase();
}

export function readPragmaState(database: DatabaseConnection): PragmaState {
  return {
    foreignKeys: readNumberPragma(database, "foreign_keys"),
    journalMode: readStringPragma(database, "journal_mode"),
    busyTimeout: readNumberPragma(database, "busy_timeout"),
    synchronous: readNumberPragma(database, "synchronous"),
  };
}

function verifyPragmaState(state: PragmaState): void {
  if (state.foreignKeys !== 1) {
    throw new Error("SQLite foreign_keys PRAGMA verification failed");
  }

  if (state.journalMode !== "wal") {
    throw new Error("SQLite journal_mode PRAGMA verification failed");
  }

  if (state.busyTimeout !== SQLITE_BUSY_TIMEOUT_MS) {
    throw new Error("SQLite busy_timeout PRAGMA verification failed");
  }

  if (state.synchronous !== SQLITE_SYNCHRONOUS_NORMAL) {
    throw new Error("SQLite synchronous PRAGMA verification failed");
  }
}

function resolveDefaultMigrationsDirectory(): string {
  if (existsSync(SOURCE_MIGRATIONS_DIRECTORY)) {
    return SOURCE_MIGRATIONS_DIRECTORY;
  }

  return COMPILED_MIGRATIONS_DIRECTORY;
}

function readAppliedMigrationVersions(database: DatabaseConnection): Set<number> {
  const rows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  const versions = new Set<number>();

  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("version" in row) ||
      typeof row.version !== "number"
    ) {
      throw new Error("schema_migrations contains an invalid version");
    }

    versions.add(row.version);
  }

  return versions;
}

function verifyMigrationFiles(migrationsDirectory: string): void {
  const files = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (
    files.length !== MIGRATION_FILES.length ||
    files.some((file, index) => file !== MIGRATION_FILES[index])
  ) {
    throw new Error("migration files do not match the frozen sequence");
  }
}

export function runMigrations(
  database: DatabaseConnection,
  migrationsDirectory = resolveDefaultMigrationsDirectory(),
): void {
  verifyPragmaState(readPragmaState(database));
  verifyMigrationFiles(migrationsDirectory);

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = readAppliedMigrationVersions(database);
  const expectedVersions = new Set(
    MIGRATION_FILES.map((file) => Number.parseInt(file.slice(0, 3), 10)),
  );

  for (const version of appliedVersions) {
    if (!expectedVersions.has(version)) {
      throw new Error(`database contains unknown migration version ${version}`);
    }
  }

  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );

  for (const file of MIGRATION_FILES) {
    const version = Number.parseInt(file.slice(0, 3), 10);

    if (appliedVersions.has(version)) {
      continue;
    }

    const sql = readFileSync(resolve(migrationsDirectory, file), "utf8");
    const applyMigration = database.transaction(() => {
      database.exec(sql);
      recordMigration.run(version, new Date().toISOString());
    });

    applyMigration();
  }

  verifyPragmaState(readPragmaState(database));
}

export function openAndVerifyDatabase(dbPath: string): DatabaseConnection {
  if (!dbPath.trim()) {
    throw new Error("DB_PATH is required");
  }

  const database = new Database(dbPath);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.pragma("synchronous = NORMAL");

    verifyPragmaState(readPragmaState(database));
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function initializeDatabase(
  dbPath: string,
  migrationsDirectory = resolveDefaultMigrationsDirectory(),
): DatabaseConnection {
  const database = openAndVerifyDatabase(dbPath);

  try {
    runMigrations(database, migrationsDirectory);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

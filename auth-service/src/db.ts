import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

interface PragmaOptions {
  readonly simple?: boolean;
}

export interface DatabaseConnection {
  // Present on real better-sqlite3 connections; the foreign-key-off migration
  // path fails closed unless it is exactly false.
  readonly inTransaction?: boolean;
  pragma(source: string, options?: PragmaOptions): unknown;
  exec(source: string): void;
  prepare(source: string): DatabaseStatement;
  transaction<Result>(operation: () => Result): DatabaseTransaction<Result>;
  close(): void;
}

export interface DatabaseTransaction<Result> {
  (): Result;
  immediate(): Result;
  exclusive?(): Result;
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
  "013_diagnosis_requests.sql",
  "014_service_delivery_monitor_target.sql",
  "015_diagnosis_request_idempotency.sql",
  "016_invite_codes_prebound_single_use.sql",
  "017_referral_profiles.sql",
  "018_referral_attribution_candidates.sql",
  "019_referral_candidate_owner_page_index.sql",
  "020_tickets.sql",
  "021_personal_invites.sql",
  "022_admin_service_management.sql",
] as const;

// Migrations that rebuild a table other tables reference with ON DELETE
// RESTRICT. SQLite cannot drop such a parent while foreign keys are enforced,
// so these, and only these, run through applyForeignKeysOffMigration.
const FOREIGN_KEYS_OFF_MIGRATIONS: ReadonlySet<string> = new Set([
  "021_personal_invites.sql",
]);
// Row counts that the rebuild must preserve exactly.
const FOREIGN_KEYS_OFF_PRESERVED_TABLES = ["users", "pending_registrations"] as const;

const DATABASE_READINESS_SQL =
  "SELECT version FROM schema_migrations ORDER BY version LIMIT ?";
const DATABASE_READINESS_ROW_LIMIT = 32;
const EXPECTED_MIGRATION_VERSIONS = Object.freeze(
  MIGRATION_FILES.map((file) => Number.parseInt(file.slice(0, 3), 10)),
);

export interface DatabaseReadinessProbe {
  isReady(): boolean;
}

export function prepareDatabaseReadinessProbe(
  database: Pick<DatabaseConnection, "prepare">,
): DatabaseReadinessProbe {
  let statement: DatabaseStatement | null = null;
  try {
    statement = database.prepare(DATABASE_READINESS_SQL);
  } catch {
    // Preparation is intentionally single-shot; a failed handle remains unready.
  }

  return Object.freeze({
    isReady: (): boolean => {
      if (statement === null) {
        return false;
      }
      try {
        const rows = statement.all(DATABASE_READINESS_ROW_LIMIT);
        return (
          rows.length === EXPECTED_MIGRATION_VERSIONS.length &&
          rows.every((row, index) => {
            if (
              typeof row !== "object" ||
              row === null ||
              Array.isArray(row) ||
              !Object.prototype.hasOwnProperty.call(row, "version")
            ) {
              return false;
            }
            const version = (row as { readonly version: unknown }).version;
            return (
              typeof version === "number" &&
              Number.isSafeInteger(version) &&
              version === EXPECTED_MIGRATION_VERSIONS[index]
            );
          })
        );
      } catch {
        return false;
      }
    },
  });
}

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

function readAppliedMigrationVersions(database: DatabaseConnection): number[] {
  const rows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  const versions: number[] = [];

  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("version" in row) ||
      typeof row.version !== "number"
    ) {
      throw new Error("schema_migrations contains an invalid version");
    }

    versions.push(row.version);
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
  const expectedVersions = MIGRATION_FILES.map((file) =>
    Number.parseInt(file.slice(0, 3), 10),
  );
  const expectedVersionSet = new Set(expectedVersions);

  for (const version of appliedVersions) {
    if (!expectedVersionSet.has(version)) {
      throw new Error(`database contains unknown migration version ${version}`);
    }
  }

  if (
    appliedVersions.some(
      (version, index) => version !== expectedVersions[index],
    )
  ) {
    throw new Error(
      "database migration history must be a continuous prefix starting at version 1",
    );
  }

  const appliedVersionSet = new Set(appliedVersions);

  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );

  for (const file of MIGRATION_FILES) {
    const version = Number.parseInt(file.slice(0, 3), 10);

    if (appliedVersionSet.has(version)) {
      continue;
    }

    const sql = readFileSync(resolve(migrationsDirectory, file), "utf8");
    if (FOREIGN_KEYS_OFF_MIGRATIONS.has(file)) {
      applyForeignKeysOffMigration(database, sql, () =>
        recordMigration.run(version, new Date().toISOString()),
      );
      continue;
    }
    const applyMigration = database.transaction(() => {
      database.exec(sql);
      recordMigration.run(version, new Date().toISOString());
    });

    applyMigration();
  }

  verifyPragmaState(readPragmaState(database));
}

function countRows(database: DatabaseConnection, table: string): number {
  const rows = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).all();
  const count = (rows[0] as { readonly count?: unknown } | undefined)?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count)) {
    throw new Error(`Migration row count for ${table} is invalid`);
  }
  return count;
}

/* Dedicated path for a table-rebuild migration. It runs on the startup
   connection before any request handler or background writer exists:
   1. refuse to start inside a transaction (PRAGMA foreign_keys is a no-op there);
   2. switch foreign_keys OFF on this connection only and verify it took effect;
   3. in ONE exclusive transaction: the migration SQL, preserved row counts,
      a full foreign_key_check, integrity_check, and the schema_migrations
      record; any failure rolls all of it back, so the ledger never advances;
   4. always switch foreign_keys back ON and verify it, then rethrow any
      failure so startup aborts; the service never runs with foreign keys off. */
function applyForeignKeysOffMigration(
  database: DatabaseConnection,
  sql: string,
  recordMigration: () => void,
): void {
  if (database.inTransaction !== false) {
    throw new Error("Foreign-key-off migration must start outside a transaction");
  }
  const expectedCounts = FOREIGN_KEYS_OFF_PRESERVED_TABLES.map((table) => ({
    table,
    count: countRows(database, table),
  }));

  let failure: unknown = null;
  database.pragma("foreign_keys = OFF");
  try {
    if (readNumberPragma(database, "foreign_keys") !== 0) {
      throw new Error("SQLite foreign_keys could not be disabled for the migration");
    }
    const apply = database.transaction(() => {
      database.exec(sql);
      for (const { table, count } of expectedCounts) {
        if (countRows(database, table) !== count) {
          throw new Error(`Migration did not preserve every ${table} row`);
        }
      }
      const violations = database.pragma("foreign_key_check");
      if (!Array.isArray(violations) || violations.length !== 0) {
        throw new Error("Migration foreign_key_check reported violations");
      }
      if (database.pragma("integrity_check", { simple: true }) !== "ok") {
        throw new Error("Migration integrity_check failed");
      }
      recordMigration();
    });
    if (typeof apply.exclusive !== "function") {
      throw new Error("Foreign-key-off migration requires an exclusive transaction");
    }
    apply.exclusive();
  } catch (error) {
    failure = error;
  } finally {
    try {
      database.pragma("foreign_keys = ON");
    } catch {
      // Verified below; a connection that cannot restore foreign keys is unusable.
    }
  }

  let restored = false;
  try {
    restored = readNumberPragma(database, "foreign_keys") === 1;
  } catch {
    restored = false;
  }
  if (!restored) {
    throw new Error("SQLite foreign_keys could not be restored after the migration");
  }
  if (failure !== null) {
    throw failure;
  }
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

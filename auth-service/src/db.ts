import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PragmaOptions {
  readonly simple?: boolean;
}

export interface DatabaseConnection {
  pragma(source: string, options?: PragmaOptions): unknown;
  close(): void;
}

interface DatabaseConstructor {
  new (filename: string): DatabaseConnection;
}

const Database = require("better-sqlite3") as DatabaseConstructor;

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

export function initializeDatabase(dbPath: string): DatabaseConnection {
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

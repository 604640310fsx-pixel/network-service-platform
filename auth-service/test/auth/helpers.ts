import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initializeDatabase,
  type DatabaseConnection,
} from "../../src/db.js";

const NOW = "2026-08-18T00:00:00.000Z";
const LATER = "2026-08-19T00:00:00.000Z";

function firstNumber(
  database: DatabaseConnection,
  source: string,
  ...parameters: readonly unknown[]
): number {
  const rows = database.prepare(source).all(...parameters) as Array<
    Record<string, unknown>
  >;
  const row = rows[0];
  const value = row === undefined ? undefined : Object.values(row)[0];

  if (typeof value !== "number") {
    throw new TypeError("query did not return a number");
  }

  return value;
}

export async function withAuthenticationDatabase<Result>(
  operation: (database: DatabaseConnection) => Promise<Result> | Result,
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), "auth-primitives-"));
  const database = initializeDatabase(join(directory, "auth.sqlite"));

  try {
    return await operation(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export function insertAuthenticationUser(
  database: DatabaseConnection,
  options: {
    readonly email: string;
    readonly passwordHash: string;
    readonly status: "active" | "disabled";
    readonly role?: "user" | "admin";
  },
): number {
  const inviteHash = `bootstrap-${options.email}`;
  database
    .prepare(
      `INSERT INTO invite_codes (
        code_hash, is_bootstrap, created_by_admin_id, max_uses, used_count,
        expires_at, revoked_at, note, created_at
      ) VALUES (?, 1, NULL, 1, 0, ?, NULL, NULL, ?)`,
    )
    .run(inviteHash, LATER, NOW);
  const inviteCodeId = firstNumber(
    database,
    "SELECT id FROM invite_codes WHERE code_hash = ?",
    inviteHash,
  );

  database
    .prepare(
      `INSERT INTO users (
        email, password_hash, role, status, invited_by_code_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.email,
      options.passwordHash,
      options.role ?? "user",
      options.status,
      inviteCodeId,
      NOW,
      NOW,
    );

  return firstNumber(
    database,
    "SELECT id FROM users WHERE email = ?",
    options.email,
  );
}

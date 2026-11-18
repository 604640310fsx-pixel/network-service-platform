import type { DatabaseConnection } from "../db.js";
import { canonicalizeEmail } from "./email.js";

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export interface AuthenticationUser {
  readonly id: number;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly status: UserStatus;
}

interface UserRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly password_hash: unknown;
  readonly role: unknown;
  readonly status: unknown;
}

const AUTHENTICATION_USER_COLUMNS =
  "id, email, password_hash, role, status";

function parseUserRow(row: unknown): AuthenticationUser {
  if (
    typeof row !== "object" ||
    row === null ||
    !("id" in row) ||
    !("email" in row) ||
    !("password_hash" in row) ||
    !("role" in row) ||
    !("status" in row)
  ) {
    throw new Error("Authentication user row is invalid");
  }

  const candidate = row as UserRow;
  if (
    typeof candidate.id !== "number" ||
    typeof candidate.email !== "string" ||
    typeof candidate.password_hash !== "string" ||
    (candidate.role !== "user" && candidate.role !== "admin") ||
    (candidate.status !== "active" && candidate.status !== "disabled")
  ) {
    throw new Error("Authentication user row is invalid");
  }

  return {
    id: candidate.id,
    email: candidate.email,
    passwordHash: candidate.password_hash,
    role: candidate.role,
    status: candidate.status,
  };
}

function firstUser(rows: unknown[]): AuthenticationUser | null {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length !== 1) {
    throw new Error("Authentication user lookup returned multiple rows");
  }

  return parseUserRow(rows[0]);
}

export function findUserByEmail(
  database: DatabaseConnection,
  email: string,
): AuthenticationUser | null {
  const canonicalEmail = canonicalizeEmail(email);
  const rows = database
    .prepare(
      `SELECT ${AUTHENTICATION_USER_COLUMNS}
       FROM users
       WHERE email = ?`,
    )
    .all(canonicalEmail);

  return firstUser(rows);
}

export function findUserById(
  database: DatabaseConnection,
  userId: number,
): AuthenticationUser | null {
  const rows = database
    .prepare(
      `SELECT ${AUTHENTICATION_USER_COLUMNS}
       FROM users
       WHERE id = ?`,
    )
    .all(userId);

  return firstUser(rows);
}

export function isUserLoginEligible(user: AuthenticationUser): boolean {
  return user.status === "active";
}

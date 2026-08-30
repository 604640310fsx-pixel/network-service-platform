import { randomBytes } from "node:crypto";

import type { DatabaseConnection } from "../db.js";
import {
  computeInviteCodeHash,
  type InviteHmacKeyring,
} from "./invite-code.js";

const INVITE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INVITE_CODE_CHARACTERS = 28;
const INVITE_LIST_LIMIT = 100;
const INVITE_CREATE_ATTEMPTS = 3;

export type AdminInviteCodeStatus =
  | "usable"
  | "expired"
  | "revoked"
  | "exhausted";

export interface AdminInviteCodeItem {
  readonly id: number;
  readonly isBootstrap: boolean;
  readonly status: AdminInviteCodeStatus;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface InviteAdminServiceDependencies {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface CreateInviteCodeInput {
  readonly adminUserId: number;
  readonly adminEmail: string;
  readonly maxUses: number;
  readonly expiresAt: string;
}

export interface RevokeInviteCodeInput {
  readonly adminUserId: number;
  readonly adminEmail: string;
  readonly inviteCodeId: number;
}

export class InviteAdminDomainError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 503,
    readonly code: "invalid_request" | "not_found" | "invite_unavailable",
  ) {
    super(code);
    this.name = "InviteAdminDomainError";
  }
}

type InviteCodeRow = {
  readonly id: unknown;
  readonly is_bootstrap: unknown;
  readonly max_uses: unknown;
  readonly used_count: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
  readonly created_at: unknown;
};

function timestamp(
  dependencies: InviteAdminServiceDependencies,
): string {
  const value = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(value.getTime())) {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  return value.toISOString();
}

function statusFor(
  row: {
    readonly revokedAt: string | null;
    readonly expiresAt: string;
    readonly usedCount: number;
    readonly maxUses: number;
  },
  now: string,
): AdminInviteCodeStatus {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt <= now) return "expired";
  if (row.usedCount >= row.maxUses) return "exhausted";
  return "usable";
}

function mapInviteCodeRow(
  row: InviteCodeRow,
  now: string,
): AdminInviteCodeItem {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    (row.is_bootstrap !== 0 && row.is_bootstrap !== 1) ||
    typeof row.max_uses !== "number" ||
    !Number.isSafeInteger(row.max_uses) ||
    row.max_uses < 1 ||
    typeof row.used_count !== "number" ||
    !Number.isSafeInteger(row.used_count) ||
    row.used_count < 0 ||
    typeof row.expires_at !== "string" ||
    (row.revoked_at !== null && typeof row.revoked_at !== "string") ||
    typeof row.created_at !== "string"
  ) {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  const item = {
    id: row.id,
    isBootstrap: row.is_bootstrap === 1,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
  return { ...item, status: statusFor(item, now) };
}

function readInviteCode(
  database: DatabaseConnection,
  inviteCodeId: number,
  now: string,
): AdminInviteCodeItem | null {
  const rows = database
    .prepare(
      `SELECT id, is_bootstrap, max_uses, used_count, expires_at,
              revoked_at, created_at
       FROM invite_codes
       WHERE id = ?`,
    )
    .all(inviteCodeId) as InviteCodeRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  return mapInviteCodeRow(rows[0], now);
}

function generateInviteCode(
  source: (size: number) => Buffer,
): string {
  const bytes = source(INVITE_CODE_CHARACTERS);
  if (!Buffer.isBuffer(bytes) || bytes.length !== INVITE_CODE_CHARACTERS) {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  const characters = Array.from(
    bytes,
    (byte) => INVITE_CODE_ALPHABET[byte & 31],
  );
  if (characters.some((character) => character === undefined)) {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += 4) {
    groups.push(characters.slice(index, index + 4).join(""));
  }
  return groups.join("-");
}

function isInviteHashCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    (error as { readonly code?: unknown }).code ===
    "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function validateCreateInput(
  input: CreateInviteCodeInput,
  now: string,
): void {
  const parsedExpiry = new Date(input.expiresAt);
  if (
    !Number.isSafeInteger(input.adminUserId) ||
    input.adminUserId <= 0 ||
    input.adminEmail === "" ||
    !Number.isSafeInteger(input.maxUses) ||
    input.maxUses < 1 ||
    !Number.isFinite(parsedExpiry.getTime()) ||
    parsedExpiry.toISOString() !== input.expiresAt ||
    input.expiresAt <= now
  ) {
    throw new InviteAdminDomainError(400, "invalid_request");
  }
}

function validateRevokeInput(input: RevokeInviteCodeInput): void {
  if (
    !Number.isSafeInteger(input.adminUserId) ||
    input.adminUserId <= 0 ||
    input.adminEmail === "" ||
    !Number.isSafeInteger(input.inviteCodeId) ||
    input.inviteCodeId <= 0
  ) {
    throw new InviteAdminDomainError(400, "invalid_request");
  }
}

export function listAdminInviteCodes(
  database: DatabaseConnection,
  dependencies: InviteAdminServiceDependencies = {},
): { readonly items: readonly AdminInviteCodeItem[]; readonly total: number } {
  const now = timestamp(dependencies);
  const rows = database
    .prepare(
      `SELECT id, is_bootstrap, max_uses, used_count, expires_at,
              revoked_at, created_at
       FROM invite_codes
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(INVITE_LIST_LIMIT) as InviteCodeRow[];
  const totalRows = database
    .prepare("SELECT COUNT(*) AS count FROM invite_codes")
    .all() as Array<{ readonly count: unknown }>;
  const total = totalRows[0]?.count;
  if (
    totalRows.length !== 1 ||
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0
  ) {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  return {
    items: rows.map((row) => mapInviteCodeRow(row, now)),
    total,
  };
}

export function createAdminInviteCode(
  database: DatabaseConnection,
  keyring: InviteHmacKeyring,
  input: CreateInviteCodeInput,
  dependencies: InviteAdminServiceDependencies = {},
): {
  readonly item: AdminInviteCodeItem;
  readonly inviteCode: string;
} {
  const now = timestamp(dependencies);
  validateCreateInput(input, now);
  const randomSource = dependencies.randomBytes ?? randomBytes;

  for (let attempt = 0; attempt < INVITE_CREATE_ATTEMPTS; attempt += 1) {
    const inviteCode = generateInviteCode(randomSource);
    const codeHash = computeInviteCodeHash(
      inviteCode,
      keyring,
      keyring.version,
    );
    try {
      const operation = database.transaction(() => {
        database
          .prepare(
            `INSERT INTO invite_codes (
               code_hash, is_bootstrap, created_by_admin_id, max_uses,
               used_count, expires_at, revoked_at, note, created_at
             ) VALUES (?, 0, ?, ?, 0, ?, NULL, NULL, ?)`,
          )
          .run(
            codeHash,
            input.adminUserId,
            input.maxUses,
            input.expiresAt,
            now,
          );
        const insertedRows = database
          .prepare("SELECT id FROM invite_codes WHERE code_hash = ?")
          .all(codeHash) as Array<{ readonly id: unknown }>;
        const inviteCodeId = insertedRows[0]?.id;
        if (
          insertedRows.length !== 1 ||
          typeof inviteCodeId !== "number" ||
          !Number.isSafeInteger(inviteCodeId) ||
          inviteCodeId <= 0
        ) {
          throw new InviteAdminDomainError(503, "invite_unavailable");
        }
        database
          .prepare(
            `INSERT INTO audit_log (actor, action, target_ref, created_at)
             VALUES (?, 'invite_code.create', ?, ?)`,
          )
          .run(input.adminEmail, `invite_code:${inviteCodeId}`, now);
        const item = readInviteCode(database, inviteCodeId, now);
        if (item === null) {
          throw new InviteAdminDomainError(503, "invite_unavailable");
        }
        return item;
      });
      return { item: operation.immediate(), inviteCode };
    } catch (error) {
      if (isInviteHashCollision(error)) continue;
      throw error;
    }
  }
  throw new InviteAdminDomainError(503, "invite_unavailable");
}

export function revokeAdminInviteCode(
  database: DatabaseConnection,
  input: RevokeInviteCodeInput,
  dependencies: InviteAdminServiceDependencies = {},
): AdminInviteCodeItem {
  validateRevokeInput(input);
  const now = timestamp(dependencies);
  const operation = database.transaction(() => {
    const current = readInviteCode(database, input.inviteCodeId, now);
    if (current === null) {
      throw new InviteAdminDomainError(404, "not_found");
    }
    if (current.revokedAt === null) {
      const updated = database
        .prepare(
          "UPDATE invite_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(now, input.inviteCodeId);
      if (updated.changes !== 1) {
        throw new InviteAdminDomainError(503, "invite_unavailable");
      }
      database
        .prepare(
          `INSERT INTO audit_log (actor, action, target_ref, created_at)
           VALUES (?, 'invite_code.revoke', ?, ?)`,
        )
        .run(
          input.adminEmail,
          `invite_code:${input.inviteCodeId}`,
          now,
        );
    }
    const item = readInviteCode(database, input.inviteCodeId, now);
    if (item === null) {
      throw new InviteAdminDomainError(503, "invite_unavailable");
    }
    return item;
  });
  return operation.immediate();
}

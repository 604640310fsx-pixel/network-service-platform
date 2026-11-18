import { randomBytes } from "node:crypto";

import { canonicalizeEmail } from "../auth/email.js";
import type { DatabaseConnection } from "../db.js";
import {
  computeRetainedInviteCodeHashCandidates,
  type InviteHmacKeyring,
} from "./invite-code.js";
import { computeMailRecipientAuditHmac } from "./mail-outbox.js";
import type { TokenHmacKeyring } from "../session/session-token.js";

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
  readonly recipientEmailMasked: string | null;
}

export interface InviteAdminServiceDependencies {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface CreateInviteCodeInput {
  readonly adminUserId: number;
  readonly recipientEmail: string;
  readonly expiresAt: string;
}

export interface RevokeInviteCodeInput {
  readonly adminUserId: number;
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
  readonly recipient_email: unknown;
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

function maskRecipientEmail(value: string | null): string | null {
  if (value === null) return null;
  let canonical: string;
  try {
    canonical = canonicalizeEmail(value);
  } catch {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  if (canonical !== value) {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }
  const separator = canonical.indexOf("@");
  const local = canonical.slice(0, separator);
  const domain = canonical.slice(separator + 1);
  const maskedLocal =
    local.length === 1
      ? "*"
      : local.length === 2
        ? `${local[0]}*`
        : `${local[0]}***${local.at(-1)}`;
  return `${maskedLocal}@${domain}`;
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
    typeof row.created_at !== "string" ||
    (row.recipient_email !== null && typeof row.recipient_email !== "string")
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
    recipientEmailMasked: maskRecipientEmail(row.recipient_email),
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
              revoked_at, created_at, recipient_email
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

function validateCreateInput(
  input: CreateInviteCodeInput,
  now: string,
): string {
  const parsedExpiry = new Date(input.expiresAt);
  if (
    !Number.isSafeInteger(input.adminUserId) ||
    input.adminUserId <= 0 ||
    typeof input.recipientEmail !== "string" ||
    !Number.isFinite(parsedExpiry.getTime()) ||
    parsedExpiry.toISOString() !== input.expiresAt ||
    input.expiresAt <= now
  ) {
    throw new InviteAdminDomainError(400, "invalid_request");
  }
  try {
    return canonicalizeEmail(input.recipientEmail);
  } catch {
    throw new InviteAdminDomainError(400, "invalid_request");
  }
}

function validateRevokeInput(input: RevokeInviteCodeInput): void {
  if (
    !Number.isSafeInteger(input.adminUserId) ||
    input.adminUserId <= 0 ||
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
              revoked_at, created_at, recipient_email
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
  inviteHmacKeyring: InviteHmacKeyring,
  recipientHmacKeyring: TokenHmacKeyring,
  input: CreateInviteCodeInput,
  dependencies: InviteAdminServiceDependencies = {},
): {
  readonly item: AdminInviteCodeItem;
  readonly inviteCode: string;
} {
  const now = timestamp(dependencies);
  const recipientEmail = validateCreateInput(input, now);
  const randomSource = dependencies.randomBytes ?? randomBytes;
  let recipientHmac: string;
  try {
    recipientHmac = computeMailRecipientAuditHmac(
      recipientEmail,
      recipientHmacKeyring,
      recipientHmacKeyring.version,
    );
  } catch {
    throw new InviteAdminDomainError(503, "invite_unavailable");
  }

  for (let attempt = 0; attempt < INVITE_CREATE_ATTEMPTS; attempt += 1) {
    const inviteCode = generateInviteCode(randomSource);
    let candidates;
    try {
      candidates = computeRetainedInviteCodeHashCandidates(
        inviteCode,
        inviteHmacKeyring,
      );
    } catch {
      throw new InviteAdminDomainError(503, "invite_unavailable");
    }
    const codeHash = candidates.find(
      (candidate) => candidate.version === inviteHmacKeyring.version,
    )?.codeHash;
    if (codeHash === undefined) {
      throw new InviteAdminDomainError(503, "invite_unavailable");
    }
    const operation = database.transaction(() => {
      const placeholders = candidates.map(() => "?").join(",");
      const collisions = database
        .prepare(
          `SELECT id FROM invite_codes
           WHERE code_hash IN (${placeholders})`,
        )
        .all(...candidates.map((candidate) => candidate.codeHash));
      if (collisions.length !== 0) {
        return { collision: true } as const;
      }
      const oldRows = database
        .prepare(
          `SELECT id FROM invite_codes
           WHERE recipient_email = ? AND revoked_at IS NULL AND used_count = 0
           ORDER BY id`,
        )
        .all(recipientEmail) as Array<{ readonly id: unknown }>;
      const oldIds = oldRows.map((row) => {
        if (
          typeof row.id !== "number" ||
          !Number.isSafeInteger(row.id) ||
          row.id <= 0
        ) {
          throw new InviteAdminDomainError(503, "invite_unavailable");
        }
        return row.id;
      });
      const revoked = database
        .prepare(
          `UPDATE invite_codes SET revoked_at = ?
           WHERE recipient_email = ? AND revoked_at IS NULL AND used_count = 0`,
        )
        .run(now, recipientEmail);
      if (revoked.changes !== oldIds.length) {
        throw new InviteAdminDomainError(503, "invite_unavailable");
      }
      database
        .prepare(
          `INSERT INTO invite_codes (
             code_hash, is_bootstrap, created_by_admin_id, max_uses,
             used_count, expires_at, revoked_at, note, created_at,
             recipient_email
           ) VALUES (?, 0, ?, 1, 0, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          codeHash,
          input.adminUserId,
          input.expiresAt,
          now,
          recipientEmail,
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
      const insertAudit = database.prepare(
        `INSERT INTO audit_log (
           actor, action, target_ref, created_at, invite_code_id,
           result_class, recipient_hmac
         ) VALUES ('system:invite', ?, NULL, ?, ?, ?, ?)`,
      );
      for (const oldId of oldIds) {
        insertAudit.run(
          "invite_code.revoke",
          now,
          oldId,
          "reissued_revoked",
          recipientHmac,
        );
      }
      insertAudit.run(
        "invite_code.create",
        now,
        inviteCodeId,
        "issued",
        recipientHmac,
      );
      const item = readInviteCode(database, inviteCodeId, now);
      if (item === null) {
        throw new InviteAdminDomainError(503, "invite_unavailable");
      }
      return { collision: false, item } as const;
    });
    const result = operation.immediate();
    if (result.collision) {
      continue;
    }
    return { item: result.item, inviteCode };
  }
  throw new InviteAdminDomainError(503, "invite_unavailable");
}

export function revokeAdminInviteCode(
  database: DatabaseConnection,
  recipientHmacKeyring: TokenHmacKeyring,
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
      const recipientRows = database
        .prepare("SELECT recipient_email FROM invite_codes WHERE id = ?")
        .all(input.inviteCodeId) as Array<{
          readonly recipient_email: unknown;
        }>;
      const recipientEmail = recipientRows[0]?.recipient_email;
      if (
        recipientRows.length !== 1 ||
        typeof recipientEmail !== "string"
      ) {
        throw new InviteAdminDomainError(503, "invite_unavailable");
      }
      let recipientHmac: string;
      try {
        recipientHmac = computeMailRecipientAuditHmac(
          recipientEmail,
          recipientHmacKeyring,
          recipientHmacKeyring.version,
        );
      } catch {
        throw new InviteAdminDomainError(503, "invite_unavailable");
      }
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
          `INSERT INTO audit_log (
             actor, action, target_ref, created_at, invite_code_id,
             result_class, recipient_hmac
           ) VALUES (
             'system:invite', 'invite_code.revoke', NULL, ?, ?,
             'admin_revoked', ?
           )`,
        )
        .run(now, input.inviteCodeId, recipientHmac);
    }
    const item = readInviteCode(database, input.inviteCodeId, now);
    if (item === null) {
      throw new InviteAdminDomainError(503, "invite_unavailable");
    }
    return item;
  });
  return operation.immediate();
}

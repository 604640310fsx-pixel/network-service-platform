import { createHmac, hkdfSync, randomBytes } from "node:crypto";

import { canonicalizeEmail } from "../auth/email.js";
import { hashPassword } from "../auth/password.js";
import { PasswordPolicyError } from "../auth/password-policy.js";
import type { DatabaseConnection } from "../db.js";
import {
  consumePasswordResetRateLimit,
  type RateLimitKeyring,
} from "../http/rate-limit.js";
import {
  buildPasswordResetIdempotencyKey,
  encryptMailPayload,
  PASSWORD_RESET_TOKEN_PATTERN,
} from "../registration/mail-outbox.js";
import type { RegistrationRandomBytesSource } from "../registration/registration-crypto.js";
import type { TokenHmacKeyring } from "../session/session-token.js";

/* Signed-out password reset over the existing password_reset_tokens table.

   Request always answers the same way whether or not the address belongs to
   an active account. For an active account it supersedes any unused token,
   stores only an HMAC of a fresh 32-byte token (30 minute TTL) and queues the
   reset link through the encrypted mail outbox; the raw token exists only in
   that ciphertext and in the mail itself.

   Confirm hashes the presented token under every keyring version, accepts it
   only while it is unused, unsuperseded and unexpired, sets the new password,
   marks the token used and revokes every session of the account. Every token
   failure is the same invalid_token. */

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000;

const TOKEN_BYTES = 32;
const NONCE_BYTES = 16;
const EMPTY_HKDF_SALT = Buffer.alloc(0);
const RESET_TOKEN_HKDF_INFO = Buffer.from("password-reset-token-v1", "utf8");
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export type PasswordResetErrorCode = "invalid_token" | "password_policy_violation";

export class PasswordResetError extends Error {
  readonly code: PasswordResetErrorCode;

  constructor(code: PasswordResetErrorCode) {
    super(code);
    this.name = "PasswordResetError";
    this.code = code;
  }
}

export interface PasswordResetDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly now?: () => Date;
  readonly randomBytes?: RegistrationRandomBytesSource;
  readonly hashPassword?: (password: string) => Promise<string>;
}

function nowDate(dependencies: PasswordResetDependencies): Date {
  const date = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Password reset time source is invalid");
  }
  return date;
}

function randomToken(dependencies: PasswordResetDependencies, size: number): string {
  const bytes = (dependencies.randomBytes ?? randomBytes)(size);
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
    throw new Error("Password reset random generation failed");
  }
  return bytes.toString("base64url");
}

function resetKey(keyring: TokenHmacKeyring, version: number): Buffer | null {
  const encoded = keyring.keys[String(version)];
  if (!Number.isSafeInteger(version) || version < 0 || encoded === undefined) return null;
  if (!BASE64_32_BYTE_KEY_PATTERN.test(encoded)) throw new Error("Token keyring is invalid");
  const master = Buffer.from(encoded, "base64");
  if (master.length !== 32 || master.toString("base64") !== encoded) {
    throw new Error("Token keyring is invalid");
  }
  return Buffer.from(hkdfSync("sha256", master, EMPTY_HKDF_SALT, RESET_TOKEN_HKDF_INFO, 32));
}

export function hashPasswordResetToken(keyring: TokenHmacKeyring, version: number, token: string): string {
  const key = resetKey(keyring, version);
  if (key === null) throw new Error("Token keyring is invalid");
  return createHmac("sha256", key).update(token, "utf8").digest("base64url");
}

function keyringVersions(keyring: TokenHmacKeyring): number[] {
  return Object.keys(keyring.keys)
    .filter((value) => /^(0|[1-9][0-9]*)$/.test(value))
    .map(Number)
    .sort((left, right) => right - left);
}

function audit(database: DatabaseConnection, userId: number, action: string, at: string): void {
  database
    .prepare(
      "INSERT INTO audit_log (actor, action, target_ref, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(`user:${userId}`, action, `user:${userId}`, at);
}

/** Always resolves the same way for well-formed input; rate limits still apply. */
export function requestPasswordReset(
  dependencies: PasswordResetDependencies,
  input: { readonly email: string; readonly ip: string },
): void {
  const { database } = dependencies;
  let email: string | null;
  try {
    email = canonicalizeEmail(input.email);
  } catch {
    email = null;
  }
  consumePasswordResetRateLimit(
    database,
    dependencies.rateLimitKeyring,
    { purpose: "request", ip: input.ip, canonicalEmail: email },
    { now: dependencies.now },
  );

  // Token and nonce are generated for every request so both paths do the same work.
  const token = randomToken(dependencies, TOKEN_BYTES);
  const nonce = randomToken(dependencies, NONCE_BYTES);
  const keyring = dependencies.tokenHmacKeyring;
  const tokenHash = hashPasswordResetToken(keyring, keyring.version, token);
  if (email === null) return;

  const account = database
    .prepare("SELECT id FROM users WHERE email = ? AND status = 'active'")
    .all(email)[0] as { readonly id: unknown } | undefined;
  if (account === undefined || typeof account.id !== "number") return;
  const userId = account.id;

  const now = nowDate(dependencies);
  const at = now.toISOString();
  const expiresEpochSeconds = Math.ceil((now.getTime() + PASSWORD_RESET_TTL_MS) / 1_000);
  const encrypted = encryptMailPayload(
    {
      idempotencyKey: buildPasswordResetIdempotencyKey(userId, expiresEpochSeconds, nonce),
      toEmail: email,
      template: "password_reset",
      plaintext: token,
    },
    dependencies.mailPayloadEncKeyring,
    dependencies.randomBytes,
  );
  database
    .transaction(() => {
      database
        .prepare(
          `UPDATE password_reset_tokens SET superseded_at = ?
           WHERE user_id = ? AND used_at IS NULL AND superseded_at IS NULL`,
        )
        .run(at, userId);
      database
        .prepare(
          `INSERT INTO password_reset_tokens
             (token_hash, hmac_key_version, user_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(tokenHash, keyring.version, userId, new Date(expiresEpochSeconds * 1_000).toISOString(), at);
      database
        .prepare(
          `INSERT INTO mail_outbox (
             idempotency_key, to_email, template, key_version, nonce, ciphertext,
             tag, status, attempts, next_attempt_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          encrypted.idempotencyKey,
          encrypted.toEmail,
          encrypted.template,
          encrypted.keyVersion,
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.tag,
          at,
          at,
        );
      audit(database, userId, "account.password_reset_request", at);
    })
    .immediate();
}

interface ResetTokenRow {
  readonly id: number;
  readonly userId: number;
}

function findUsableToken(
  database: DatabaseConnection,
  keyring: TokenHmacKeyring,
  token: string,
  at: string,
): ResetTokenRow | null {
  for (const version of keyringVersions(keyring)) {
    const row = database
      .prepare(
        `SELECT id, user_id FROM password_reset_tokens
         WHERE token_hash = ? AND hmac_key_version = ?
           AND used_at IS NULL AND superseded_at IS NULL AND expires_at > ?`,
      )
      .all(hashPasswordResetToken(keyring, version, token), version, at)[0] as
      | { readonly id: unknown; readonly user_id: unknown }
      | undefined;
    if (row !== undefined && typeof row.id === "number" && typeof row.user_id === "number") {
      return { id: row.id, userId: row.user_id };
    }
  }
  return null;
}

export async function confirmPasswordReset(
  dependencies: PasswordResetDependencies,
  input: { readonly token: string; readonly password: string; readonly ip: string },
): Promise<void> {
  const { database } = dependencies;
  consumePasswordResetRateLimit(
    database,
    dependencies.rateLimitKeyring,
    { purpose: "confirm", ip: input.ip },
    { now: dependencies.now },
  );
  if (!PASSWORD_RESET_TOKEN_PATTERN.test(input.token)) {
    throw new PasswordResetError("invalid_token");
  }
  // Checked before hashing so an expired link never costs an Argon2 run.
  if (findUsableToken(database, dependencies.tokenHmacKeyring, input.token, nowDate(dependencies).toISOString()) === null) {
    throw new PasswordResetError("invalid_token");
  }
  let newHash: string;
  try {
    newHash = await (dependencies.hashPassword ?? hashPassword)(input.password);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new PasswordResetError("password_policy_violation");
    }
    throw error;
  }

  const at = nowDate(dependencies).toISOString();
  database
    .transaction(() => {
      // Re-read inside the write transaction: a concurrent confirm wins once.
      const row = findUsableToken(database, dependencies.tokenHmacKeyring, input.token, at);
      if (row === null) throw new PasswordResetError("invalid_token");
      const used = database
        .prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .run(at, row.id);
      const updated = database
        .prepare(
          `UPDATE users SET password_hash = ?, updated_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(newHash, at, row.userId);
      if (used.changes !== 1 || updated.changes !== 1) {
        throw new PasswordResetError("invalid_token");
      }
      database
        .prepare(
          `UPDATE password_reset_tokens SET superseded_at = ?
           WHERE user_id = ? AND used_at IS NULL AND superseded_at IS NULL`,
        )
        .run(at, row.userId);
      database
        .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(at, row.userId);
      database
        .prepare("UPDATE session_families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(at, row.userId);
      audit(database, row.userId, "account.password_reset", at);
    })
    .immediate();
}

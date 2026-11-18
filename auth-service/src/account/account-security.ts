import {
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

import { canonicalizeEmail } from "../auth/email.js";
import { hashPassword, verifyPasswordHash } from "../auth/password.js";
import { PasswordPolicyError } from "../auth/password-policy.js";
import type { DatabaseConnection } from "../db.js";
import {
  consumeAccountSecurityRateLimit,
  type RateLimitKeyring,
} from "../http/rate-limit.js";
import {
  buildEmailChangedNoticeIdempotencyKey,
  buildEmailChangeOtpIdempotencyKey,
  EMAIL_CHANGED_NOTICE_PLAINTEXT,
  encryptMailPayload,
  type EncryptedRegistrationOtpPayload,
} from "../registration/mail-outbox.js";
import {
  generateRegistrationOtp,
  REGISTRATION_OTP_PATTERN,
  type RegistrationRandomBytesSource,
  type RegistrationRandomIntSource,
} from "../registration/registration-crypto.js";
import type { TokenHmacKeyring } from "../session/session-token.js";

/* Signed-in account security: change password and change login email.

   Password change verifies the current password, applies the frozen 12-256
   policy, and revokes every other session of the account while keeping the
   current one.

   Email change is two steps without new tables. Start verifies the current
   password and sends a six-digit code to the new address; it returns a signed,
   short-lived change token binding (account, current email, new email, code
   hash, expiry). Confirm checks that token and the code, and only succeeds
   while the account still has the email the token was issued for, so each
   token works at most once. Wrong codes are bounded by the per-account
   confirm rate limit. A successful change revokes the other sessions and
   sends a notice (no code, no new address) to the previous address. */

export const EMAIL_CHANGE_TTL_MS = 10 * 60 * 1_000;

const EMAIL_CHANGE_TOKEN_PATTERN =
  /^ec1\.v(0|[1-9][0-9]*)\.([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/;
const NONCE_BYTES = 16;
const EMPTY_HKDF_SALT = Buffer.alloc(0);
const TOKEN_HKDF_INFO = Buffer.from("email-change-token-v1", "utf8");
const OTP_HKDF_INFO = Buffer.from("email-change-otp-v1", "utf8");
const BASE64_32_BYTE_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export type AccountSecurityErrorCode =
  | "invalid_credentials"
  | "password_policy_violation"
  | "invalid_email"
  | "email_unchanged"
  | "email_taken"
  | "invalid_code"
  | "invalid_or_expired";

export class AccountSecurityError extends Error {
  readonly code: AccountSecurityErrorCode;

  constructor(code: AccountSecurityErrorCode) {
    super(code);
    this.name = "AccountSecurityError";
    this.code = code;
  }
}

export interface AccountSecurityDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
  readonly now?: () => Date;
  readonly randomBytes?: RegistrationRandomBytesSource;
  readonly randomInt?: RegistrationRandomIntSource;
  readonly hashPassword?: (password: string) => Promise<string>;
}

export interface AccountSession {
  readonly userId: number;
  readonly sessionTokenHash: string;
}

interface AccountRow {
  readonly id: number;
  readonly email: string;
  readonly passwordHash: string;
}

interface EmailChangeClaims {
  readonly userId: number;
  readonly oldEmail: string;
  readonly newEmail: string;
  readonly codeHash: string;
  readonly expiresEpochSeconds: number;
  readonly nonce: string;
}

function nowDate(dependencies: AccountSecurityDependencies): Date {
  const date = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Account security time source is invalid");
  }
  return date;
}

function readAccount(database: DatabaseConnection, userId: number): AccountRow {
  const row = database
    .prepare(
      "SELECT id, email, password_hash FROM users WHERE id = ? AND status = 'active'",
    )
    .all(userId)[0] as Record<string, unknown> | undefined;
  if (
    row === undefined ||
    typeof row.id !== "number" ||
    typeof row.email !== "string" ||
    typeof row.password_hash !== "string"
  ) {
    throw new AccountSecurityError("invalid_or_expired");
  }
  return { id: row.id, email: row.email, passwordHash: row.password_hash };
}

async function assertCurrentPassword(account: AccountRow, presented: string): Promise<void> {
  let matches = false;
  try {
    matches = await verifyPasswordHash(account.passwordHash, presented);
  } catch (error) {
    if (error instanceof PasswordPolicyError) matches = false;
    else throw error;
  }
  if (!matches) throw new AccountSecurityError("invalid_credentials");
}

function audit(database: DatabaseConnection, userId: number, action: string, at: string): void {
  database
    .prepare(
      "INSERT INTO audit_log (actor, action, target_ref, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(`user:${userId}`, action, `user:${userId}`, at);
}

/** Revokes every other session and session family of the account; the
    session presenting sessionTokenHash (and its family) stays valid. */
function revokeOtherSessions(
  database: DatabaseConnection,
  session: AccountSession,
  at: string,
): void {
  const current = database
    .prepare(
      "SELECT session_family_id FROM sessions WHERE token_hash = ? AND user_id = ?",
    )
    .all(session.sessionTokenHash, session.userId)[0] as
    | { readonly session_family_id: unknown }
    | undefined;
  if (current === undefined || typeof current.session_family_id !== "string") {
    throw new AccountSecurityError("invalid_or_expired");
  }
  database
    .prepare(
      `UPDATE sessions SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL AND token_hash <> ?`,
    )
    .run(at, session.userId, session.sessionTokenHash);
  database
    .prepare(
      `UPDATE session_families SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`,
    )
    .run(at, session.userId, current.session_family_id);
}

function insertOutbox(
  database: DatabaseConnection,
  encrypted: EncryptedRegistrationOtpPayload,
  now: string,
): void {
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
      now,
      now,
    );
}

function randomNonce(dependencies: AccountSecurityDependencies): string {
  const bytes = (dependencies.randomBytes ?? randomBytes)(NONCE_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== NONCE_BYTES) {
    throw new Error("Account security nonce generation failed");
  }
  return bytes.toString("base64url");
}

function derivedKey(keyring: TokenHmacKeyring, version: number, info: Buffer): Buffer {
  const encoded = keyring.keys[String(version)];
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    encoded === undefined ||
    !BASE64_32_BYTE_KEY_PATTERN.test(encoded)
  ) {
    throw new AccountSecurityError("invalid_or_expired");
  }
  const master = Buffer.from(encoded, "base64");
  if (master.length !== 32 || master.toString("base64") !== encoded) {
    throw new Error("Token keyring is invalid");
  }
  return Buffer.from(hkdfSync("sha256", master, EMPTY_HKDF_SALT, info, 32));
}

function hmac(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input, "utf8").digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function codeHash(keyring: TokenHmacKeyring, version: number, nonce: string, code: string): string {
  return hmac(derivedKey(keyring, version, OTP_HKDF_INFO), `${nonce}:${code}`);
}

function issueChangeToken(keyring: TokenHmacKeyring, claims: EmailChangeClaims): string {
  const payload = Buffer.from(
    JSON.stringify({
      u: claims.userId,
      o: claims.oldEmail,
      n: claims.newEmail,
      h: claims.codeHash,
      e: claims.expiresEpochSeconds,
      k: claims.nonce,
    }),
    "utf8",
  ).toString("base64url");
  const signed = `ec1.v${keyring.version}.${payload}`;
  return `${signed}.${hmac(derivedKey(keyring, keyring.version, TOKEN_HKDF_INFO), signed)}`;
}

function readChangeToken(
  keyring: TokenHmacKeyring,
  token: string,
): { readonly claims: EmailChangeClaims; readonly keyVersion: number } {
  const match = EMAIL_CHANGE_TOKEN_PATTERN.exec(token);
  if (match === null) throw new AccountSecurityError("invalid_or_expired");
  const keyVersion = Number(match[1]);
  const signed = `ec1.v${match[1]}.${match[2]}`;
  const expected = hmac(derivedKey(keyring, keyVersion, TOKEN_HKDF_INFO), signed);
  if (!safeEqual(expected, match[3]!)) throw new AccountSecurityError("invalid_or_expired");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8"));
  } catch {
    throw new AccountSecurityError("invalid_or_expired");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(record).sort().join(",") !== "e,h,k,n,o,u" ||
    typeof record.u !== "number" ||
    !Number.isSafeInteger(record.u) ||
    typeof record.o !== "string" ||
    typeof record.n !== "string" ||
    typeof record.h !== "string" ||
    typeof record.e !== "number" ||
    !Number.isSafeInteger(record.e) ||
    typeof record.k !== "string"
  ) {
    throw new AccountSecurityError("invalid_or_expired");
  }
  return {
    keyVersion,
    claims: {
      userId: record.u,
      oldEmail: record.o,
      newEmail: record.n,
      codeHash: record.h,
      expiresEpochSeconds: record.e,
      nonce: record.k,
    },
  };
}

export async function changeAccountPassword(
  dependencies: AccountSecurityDependencies,
  session: AccountSession,
  input: {
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly confirmPassword: string;
  },
): Promise<void> {
  const { database } = dependencies;
  consumeAccountSecurityRateLimit(
    database,
    dependencies.rateLimitKeyring,
    { purpose: "password_change", userId: session.userId },
    { now: dependencies.now },
  );
  const account = readAccount(database, session.userId);
  await assertCurrentPassword(account, input.currentPassword);
  if (input.newPassword !== input.confirmPassword) {
    throw new AccountSecurityError("password_policy_violation");
  }
  let newHash: string;
  try {
    newHash = await (dependencies.hashPassword ?? hashPassword)(input.newPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      throw new AccountSecurityError("password_policy_violation");
    }
    throw error;
  }

  const at = nowDate(dependencies).toISOString();
  database
    .transaction(() => {
      // Compare-and-swap on the verified hash: a concurrent change wins once.
      const updated = database
        .prepare(
          `UPDATE users SET password_hash = ?, updated_at = ?
           WHERE id = ? AND status = 'active' AND password_hash = ?`,
        )
        .run(newHash, at, account.id, account.passwordHash);
      if (updated.changes !== 1) throw new AccountSecurityError("invalid_credentials");
      revokeOtherSessions(database, session, at);
      audit(database, account.id, "account.password_change", at);
    })
    .immediate();
}

export async function startAccountEmailChange(
  dependencies: AccountSecurityDependencies,
  session: AccountSession,
  input: { readonly currentPassword: string; readonly newEmail: string },
): Promise<{ readonly changeToken: string; readonly expiresAt: string }> {
  const { database } = dependencies;
  let newEmail: string;
  try {
    newEmail = canonicalizeEmail(input.newEmail);
  } catch {
    throw new AccountSecurityError("invalid_email");
  }
  consumeAccountSecurityRateLimit(
    database,
    dependencies.rateLimitKeyring,
    { purpose: "email_change_start", userId: session.userId, canonicalNewEmail: newEmail },
    { now: dependencies.now },
  );
  const account = readAccount(database, session.userId);
  await assertCurrentPassword(account, input.currentPassword);
  if (newEmail === account.email) throw new AccountSecurityError("email_unchanged");
  if (database.prepare("SELECT 1 FROM users WHERE email = ?").all(newEmail).length !== 0) {
    throw new AccountSecurityError("email_taken");
  }

  const now = nowDate(dependencies);
  const at = now.toISOString();
  const expiresEpochSeconds = Math.ceil((now.getTime() + EMAIL_CHANGE_TTL_MS) / 1_000);
  const code = generateRegistrationOtp(dependencies.randomInt ?? randomInt);
  const nonce = randomNonce(dependencies);
  const keyring = dependencies.tokenHmacKeyring;
  const changeToken = issueChangeToken(keyring, {
    userId: account.id,
    oldEmail: account.email,
    newEmail,
    codeHash: codeHash(keyring, keyring.version, nonce, code),
    expiresEpochSeconds,
    nonce,
  });
  const encrypted = encryptMailPayload(
    {
      idempotencyKey: buildEmailChangeOtpIdempotencyKey(account.id, expiresEpochSeconds, nonce),
      toEmail: newEmail,
      template: "verification_code",
      plaintext: code,
    },
    dependencies.mailPayloadEncKeyring,
    dependencies.randomBytes,
  );
  database
    .transaction(() => {
      insertOutbox(database, encrypted, at);
      audit(database, account.id, "account.email_change_request", at);
    })
    .immediate();
  return { changeToken, expiresAt: new Date(expiresEpochSeconds * 1_000).toISOString() };
}

export function confirmAccountEmailChange(
  dependencies: AccountSecurityDependencies,
  session: AccountSession,
  input: { readonly changeToken: string; readonly code: string },
): void {
  const { database } = dependencies;
  consumeAccountSecurityRateLimit(
    database,
    dependencies.rateLimitKeyring,
    { purpose: "email_change_confirm", userId: session.userId },
    { now: dependencies.now },
  );
  const now = nowDate(dependencies);
  const { claims, keyVersion } = readChangeToken(dependencies.tokenHmacKeyring, input.changeToken);
  if (
    claims.userId !== session.userId ||
    claims.expiresEpochSeconds * 1_000 <= now.getTime()
  ) {
    throw new AccountSecurityError("invalid_or_expired");
  }
  if (
    !REGISTRATION_OTP_PATTERN.test(input.code) ||
    !safeEqual(
      codeHash(dependencies.tokenHmacKeyring, keyVersion, claims.nonce, input.code),
      claims.codeHash,
    )
  ) {
    throw new AccountSecurityError("invalid_code");
  }

  const at = now.toISOString();
  const notice = encryptMailPayload(
    {
      idempotencyKey: buildEmailChangedNoticeIdempotencyKey(
        claims.userId,
        Math.max(1, Math.floor(now.getTime() / 1_000)),
        randomNonce(dependencies),
      ),
      toEmail: claims.oldEmail,
      template: "email_changed_notice",
      plaintext: EMAIL_CHANGED_NOTICE_PLAINTEXT,
    },
    dependencies.mailPayloadEncKeyring,
    dependencies.randomBytes,
  );
  database
    .transaction(() => {
      if (
        database
          .prepare("SELECT 1 FROM users WHERE email = ? AND id <> ?")
          .all(claims.newEmail, claims.userId).length !== 0
      ) {
        throw new AccountSecurityError("email_taken");
      }
      // Only while the account still has the email the token was issued for.
      const updated = database
        .prepare(
          `UPDATE users SET email = ?, updated_at = ?
           WHERE id = ? AND status = 'active' AND email = ?`,
        )
        .run(claims.newEmail, at, claims.userId, claims.oldEmail);
      if (updated.changes !== 1) throw new AccountSecurityError("invalid_or_expired");
      revokeOtherSessions(database, session, at);
      audit(database, claims.userId, "account.email_change", at);
      insertOutbox(database, notice, at);
    })
    .immediate();
}

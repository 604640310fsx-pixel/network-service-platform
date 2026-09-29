import { randomBytes } from "node:crypto";

import type { DatabaseConnection } from "../db.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  computeMailRecipientAuditHmac,
  decryptMailPayload,
  parseEmailChangedNoticeIdempotencyKey,
  parseEmailChangeOtpIdempotencyKey,
  parseRegistrationOtpIdempotencyKey,
  type EncryptedRegistrationOtpPayload,
  type MailOutboxRandomBytesSource,
  type MailTemplate,
} from "./mail-outbox.js";

const MAIL_LEASE_TOKEN_BYTES = 32;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface MailOutboxRow {
  readonly idempotency_key: string;
  readonly to_email: string;
  readonly template: MailTemplate;
  readonly key_version: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
  readonly attempts: number;
}

interface ClaimedMail {
  readonly encrypted: EncryptedRegistrationOtpPayload;
  readonly attempts: number;
  readonly leaseToken: string;
  readonly recipientAuditHmac: string;
  readonly shouldAttemptDelivery: boolean;
}

export interface MailDelivery {
  readonly idempotencyKey: string;
  readonly toEmail: string;
  readonly template: MailTemplate;
  /** The six-digit code for verification_code mail; null for a notice. */
  readonly verificationCode: string | null;
}

// A previous-address notice that could not be sent within a day is dropped.
const EMAIL_CHANGED_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface MailTransport {
  send(delivery: MailDelivery): Promise<void>;
}

export interface MailDispatcherPolicy {
  readonly leaseMs: number;
  readonly maxAttempts: number;
  retryDelayMs(attempts: number): number;
}

export interface MailDispatcherDependencies {
  readonly database: DatabaseConnection;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly transport: MailTransport;
  readonly policy: MailDispatcherPolicy;
  readonly now?: () => Date;
  readonly randomBytes?: MailOutboxRandomBytesSource;
}

export type MailDispatchResult =
  | { readonly outcome: "idle" }
  | {
      readonly outcome: "sent" | "retry_scheduled" | "failed" | "lease_lost";
      readonly attempts: number;
    };

export interface MailDispatcherRunner {
  readonly stop: () => Promise<void>;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Mail dispatcher clock is invalid");
  }
  return value;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Mail dispatcher ${name} is invalid`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Mail dispatcher ${name} is invalid`);
  }
  return value;
}

function createLeaseToken(randomBytesSource: MailOutboxRandomBytesSource): string {
  const token = randomBytesSource(MAIL_LEASE_TOKEN_BYTES);
  if (!Buffer.isBuffer(token) || token.length !== MAIL_LEASE_TOKEN_BYTES) {
    throw new Error("Mail dispatcher lease token generation failed");
  }
  return token.toString("base64url");
}

function parseOutboxRow(value: unknown): MailOutboxRow {
  if (
    typeof value !== "object" ||
    value === null ||
    !("idempotency_key" in value) ||
    typeof value.idempotency_key !== "string" ||
    value.idempotency_key.length === 0 ||
    !("to_email" in value) ||
    typeof value.to_email !== "string" ||
    !("template" in value) ||
    (value.template !== "verification_code" &&
      value.template !== "email_changed_notice") ||
    !("key_version" in value) ||
    typeof value.key_version !== "number" ||
    !Number.isSafeInteger(value.key_version) ||
    value.key_version < 0 ||
    !("nonce" in value) ||
    !Buffer.isBuffer(value.nonce) ||
    !("ciphertext" in value) ||
    !Buffer.isBuffer(value.ciphertext) ||
    !("tag" in value) ||
    !Buffer.isBuffer(value.tag) ||
    !("attempts" in value) ||
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0
  ) {
    throw new Error("Mail outbox row is invalid");
  }

  return value as MailOutboxRow;
}

interface CurrentMailInput {
  readonly idempotencyKey: string;
  readonly toEmail: string;
  readonly template: MailTemplate;
}

function isActiveUser(database: DatabaseConnection, userId: number): boolean {
  return (
    database
      .prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'")
      .all(userId).length === 1
  );
}

/* Email-change code: unexpired, the account is still active, and no account
   uses the new address yet (once the change completes, pending code mail for
   it is stale and dropped). */
function isCurrentEmailChangeMail(database: DatabaseConnection, mail: CurrentMailInput, now: Date): boolean {
  const identity = parseEmailChangeOtpIdempotencyKey(mail.idempotencyKey);
  return (
    identity !== null &&
    mail.template === "verification_code" &&
    identity.epochSeconds * 1_000 > now.getTime() &&
    isActiveUser(database, identity.userId) &&
    database.prepare("SELECT 1 FROM users WHERE email = ?").all(mail.toEmail).length === 0
  );
}

function isCurrentEmailChangedNotice(database: DatabaseConnection, mail: CurrentMailInput, now: Date): boolean {
  const identity = parseEmailChangedNoticeIdempotencyKey(mail.idempotencyKey);
  return (
    identity !== null &&
    mail.template === "email_changed_notice" &&
    now.getTime() - identity.epochSeconds * 1_000 < EMAIL_CHANGED_NOTICE_MAX_AGE_MS &&
    database.prepare("SELECT 1 FROM users WHERE id = ?").all(identity.userId).length === 1
  );
}

function isCurrentMail(database: DatabaseConnection, mail: CurrentMailInput, now: Date): boolean {
  if (mail.idempotencyKey.startsWith("email-change-otp-v1:")) {
    return isCurrentEmailChangeMail(database, mail, now);
  }
  if (mail.idempotencyKey.startsWith("email-changed-notice-v1:")) {
    return isCurrentEmailChangedNotice(database, mail, now);
  }
  return mail.template === "verification_code" && isCurrentRegistrationMail(database, mail, now);
}

function isCurrentRegistrationMail(
  database: DatabaseConnection,
  mail: { readonly idempotencyKey: string; readonly toEmail: string },
  now: Date,
): boolean {
  const identity = parseRegistrationOtpIdempotencyKey(mail.idempotencyKey);
  if (identity === null) {
    return false;
  }
  const value = database
    .prepare(
      `SELECT email, otp_generation, phase, verified_at, expires_at,
              consumed_at, superseded_at
       FROM pending_registrations
       WHERE id = ?`,
    )
    .all(identity.pendingRegistrationId)[0];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const registration = value as Record<string, unknown>;
  if (
    registration.email !== mail.toEmail ||
    registration.otp_generation !== identity.otpGeneration ||
    registration.phase !== "awaiting_verification" ||
    registration.verified_at !== null ||
    registration.consumed_at !== null ||
    registration.superseded_at !== null ||
    typeof registration.expires_at !== "string"
  ) {
    return false;
  }
  const expiresAt = new Date(registration.expires_at);
  return (
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.toISOString() === registration.expires_at &&
    expiresAt.getTime() > now.getTime()
  );
}

function claimNextMail(
  dependencies: MailDispatcherDependencies,
  now: Date,
  randomBytesSource: MailOutboxRandomBytesSource,
  maxAttempts: number,
): ClaimedMail | null {
  const nowIso = now.toISOString();
  const leaseUntil = requireDate(
    new Date(
      now.getTime() +
        requirePositiveInteger(dependencies.policy.leaseMs, "lease"),
    ),
  ).toISOString();

  const claim = dependencies.database.transaction(() => {
    const row = dependencies.database
      .prepare(
        `SELECT idempotency_key, to_email, template, key_version,
                nonce, ciphertext, tag, attempts
         FROM mail_outbox
         WHERE (status = 'pending' AND next_attempt_at <= ?)
            OR (status = 'sending' AND leased_until IS NOT NULL AND leased_until <= ?)
         ORDER BY
           CASE WHEN status = 'pending' THEN next_attempt_at ELSE leased_until END,
           created_at,
           idempotency_key
         LIMIT 1`,
      )
      .all(nowIso, nowIso)[0];
    if (row === undefined) {
      return null;
    }

    const parsed = parseOutboxRow(row);
    const leaseToken = createLeaseToken(randomBytesSource);
    const recipientAuditHmac = computeMailRecipientAuditHmac(
      parsed.to_email,
      dependencies.mailPayloadEncKeyring,
      dependencies.mailPayloadEncKeyring.version,
    );
    const shouldAttemptDelivery =
      parsed.attempts < maxAttempts &&
      isCurrentMail(
        dependencies.database,
        {
          idempotencyKey: parsed.idempotency_key,
          toEmail: parsed.to_email,
          template: parsed.template,
        },
        now,
      );
    const result = dependencies.database
      .prepare(
        `UPDATE mail_outbox
         SET status = 'sending',
             attempts = attempts + ?,
             leased_until = ?,
             lease_token = ?
         WHERE idempotency_key = ?
           AND ((status = 'pending' AND next_attempt_at <= ?)
             OR (status = 'sending' AND leased_until IS NOT NULL AND leased_until <= ?))`,
      )
      .run(
        shouldAttemptDelivery ? 1 : 0,
        leaseUntil,
        leaseToken,
        parsed.idempotency_key,
        nowIso,
        nowIso,
      );
    if (result.changes !== 1) {
      throw new Error("Mail outbox claim failed");
    }

    return {
      encrypted: {
        idempotencyKey: parsed.idempotency_key,
        toEmail: parsed.to_email,
        template: parsed.template,
        keyVersion: parsed.key_version,
        nonce: parsed.nonce,
        ciphertext: parsed.ciphertext,
        tag: parsed.tag,
      },
      attempts: parsed.attempts + (shouldAttemptDelivery ? 1 : 0),
      leaseToken,
      recipientAuditHmac,
      shouldAttemptDelivery,
    } satisfies ClaimedMail;
  });

  return claim.immediate();
}

function finalizeMail(
  dependencies: MailDispatcherDependencies,
  claimed: ClaimedMail,
  outcome: "sent" | "failed",
  recordedAt: Date,
): boolean {
  const finalize = dependencies.database.transaction(() => {
    const owned = dependencies.database
      .prepare(
        `SELECT idempotency_key
         FROM mail_outbox
         WHERE idempotency_key = ?
           AND status = 'sending'
           AND lease_token = ?
           AND attempts = ?`,
      )
      .all(
        claimed.encrypted.idempotencyKey,
        claimed.leaseToken,
        claimed.attempts,
      )[0];
    if (owned === undefined) {
      return false;
    }

    dependencies.database
      .prepare(
        `INSERT INTO mail_outbox_audit (
           idempotency_key, to_email_hmac, template, outcome,
           final_attempts, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        claimed.encrypted.idempotencyKey,
        claimed.recipientAuditHmac,
        claimed.encrypted.template,
        outcome,
        claimed.attempts,
        recordedAt.toISOString(),
      );
    const deleted = dependencies.database
      .prepare(
        `DELETE FROM mail_outbox
         WHERE idempotency_key = ?
           AND status = 'sending'
           AND lease_token = ?
           AND attempts = ?`,
      )
      .run(
        claimed.encrypted.idempotencyKey,
        claimed.leaseToken,
        claimed.attempts,
      );
    if (deleted.changes !== 1) {
      throw new Error("Mail outbox finalization failed");
    }
    return true;
  });

  return finalize.immediate();
}

function scheduleRetry(
  dependencies: MailDispatcherDependencies,
  claimed: ClaimedMail,
  now: Date,
): boolean {
  const delay = requireNonNegativeInteger(
    dependencies.policy.retryDelayMs(claimed.attempts),
    "retry delay",
  );
  const nextAttemptAt = requireDate(
    new Date(now.getTime() + delay),
  ).toISOString();
  const result = dependencies.database
    .prepare(
      `UPDATE mail_outbox
       SET status = 'pending',
           next_attempt_at = ?,
           leased_until = NULL,
           lease_token = NULL
       WHERE idempotency_key = ?
         AND status = 'sending'
         AND lease_token = ?
         AND attempts = ?`,
    )
    .run(
      nextAttemptAt,
      claimed.encrypted.idempotencyKey,
      claimed.leaseToken,
      claimed.attempts,
    );
  return result.changes === 1;
}

export async function dispatchNextMail(
  dependencies: MailDispatcherDependencies,
): Promise<MailDispatchResult> {
  const maxAttempts = requirePositiveInteger(
    dependencies.policy.maxAttempts,
    "maximum attempts",
  );
  const nowSource = dependencies.now ?? (() => new Date());
  const randomBytesSource = dependencies.randomBytes ?? randomBytes;
  const claimed = claimNextMail(
    dependencies,
    requireDate(nowSource()),
    randomBytesSource,
    maxAttempts,
  );
  if (claimed === null) {
    return { outcome: "idle" };
  }
  if (!claimed.shouldAttemptDelivery) {
    return finalizeMail(
      dependencies,
      claimed,
      "failed",
      requireDate(nowSource()),
    )
      ? { outcome: "failed", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }

  const deliveryTime = requireDate(nowSource());
  if (
    !isCurrentMail(
      dependencies.database,
      {
        idempotencyKey: claimed.encrypted.idempotencyKey,
        toEmail: claimed.encrypted.toEmail,
        template: claimed.encrypted.template,
      },
      deliveryTime,
    )
  ) {
    return finalizeMail(dependencies, claimed, "failed", deliveryTime)
      ? { outcome: "failed", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }

  try {
    const plaintext = decryptMailPayload(
      claimed.encrypted,
      dependencies.mailPayloadEncKeyring,
    );
    await dependencies.transport.send({
      idempotencyKey: claimed.encrypted.idempotencyKey,
      toEmail: claimed.encrypted.toEmail,
      template: claimed.encrypted.template,
      verificationCode:
        claimed.encrypted.template === "verification_code" ? plaintext : null,
    });
  } catch {
    const failureTime = requireDate(nowSource());
    if (claimed.attempts >= maxAttempts) {
      return finalizeMail(dependencies, claimed, "failed", failureTime)
        ? { outcome: "failed", attempts: claimed.attempts }
        : { outcome: "lease_lost", attempts: claimed.attempts };
    }
    return scheduleRetry(dependencies, claimed, failureTime)
      ? { outcome: "retry_scheduled", attempts: claimed.attempts }
      : { outcome: "lease_lost", attempts: claimed.attempts };
  }

  return finalizeMail(
    dependencies,
    claimed,
    "sent",
    requireDate(nowSource()),
  )
    ? { outcome: "sent", attempts: claimed.attempts }
    : { outcome: "lease_lost", attempts: claimed.attempts };
}

export function startMailDispatcher(
  dependencies: MailDispatcherDependencies,
  intervalMs: number,
): MailDispatcherRunner {
  const validatedIntervalMs = requirePositiveInteger(intervalMs, "interval");
  if (validatedIntervalMs > MAX_TIMER_DELAY_MS) {
    throw new Error("Mail dispatcher interval is invalid");
  }

  let stopped = false;
  let currentRun: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || currentRun !== null) {
      return;
    }
    currentRun = dispatchNextMail(dependencies)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        currentRun = null;
      });
  }, validatedIntervalMs);
  timer.unref();

  return Object.freeze({
    stop: async (): Promise<void> => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await currentRun;
    },
  });
}

import { randomBytes, randomInt } from "node:crypto";

import { canonicalizeEmail } from "../auth/email.js";
import { hashPassword } from "../auth/password.js";
import type { DatabaseConnection } from "../db.js";
import {
  canonicalizeIp,
  consumeRegistrationIpRateLimit,
  consumeRegistrationResendRateLimit,
  consumeRegistrationStartRateLimit,
  type RateLimitKeyring,
  type RegistrationRateLimitDependencies,
} from "../http/rate-limit.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  computeInviteCodeHashCandidates,
  lookupInviteCode,
  type InviteHmacKeyring,
} from "./invite-code.js";
import { encryptRegistrationOtpPayload } from "./mail-outbox.js";
import {
  computeRegistrationOtpHash,
  computeRegistrationTokenHash,
  generateRegistrationOtp,
  generateRegistrationToken,
  verifyRegistrationOtp,
  type RegistrationRandomBytesSource,
  type RegistrationRandomIntSource,
} from "./registration-crypto.js";

export const REGISTRATION_TTL_MS = 10 * 60 * 1_000;
export const REGISTRATION_RESEND_COOLDOWN_MS = 60 * 1_000;
export const REGISTRATION_MAX_ATTEMPTS = 5;
export const REGISTRATION_MAX_RESENDS = 5;

interface PendingRegistrationRow {
  readonly id: number;
  readonly email: string;
  readonly invite_code_id: number;
  readonly otp_hash: string;
  readonly otp_key_version: number;
  readonly otp_generation: number;
  readonly phase: "awaiting_verification" | "verified" | "completed";
  readonly verified_at: string | null;
  readonly attempts: number;
  readonly resend_count: number;
  readonly last_sent_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly superseded_at: string | null;
}

export interface RegistrationServiceKeyrings {
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly inviteHmacKeyring: InviteHmacKeyring;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
}

export interface RegistrationServiceDependencies
  extends RegistrationRateLimitDependencies {
  readonly randomBytes?: RegistrationRandomBytesSource;
  readonly randomInt?: RegistrationRandomIntSource;
  readonly outboxRandomBytes?: RegistrationRandomBytesSource;
}

export interface RegistrationTokenResult {
  readonly registrationToken: string;
}

export class InvalidOrExpiredRegistrationError extends Error {
  readonly code = "invalid_or_expired";

  constructor() {
    super("Registration is invalid or expired");
    this.name = "InvalidOrExpiredRegistrationError";
  }
}

export class RegistrationEmailTakenError extends Error {
  readonly code = "email_taken";

  constructor() {
    super("Registration email is already in use");
    this.name = "RegistrationEmailTakenError";
  }
}

function registrationTimes(nowSource: () => Date): {
  readonly date: Date;
  readonly now: string;
  readonly expiresAt: string;
  readonly resendCutoff: string;
} {
  const date = nowSource();
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Registration time source is invalid");
  }
  return {
    date,
    now: date.toISOString(),
    expiresAt: new Date(milliseconds + REGISTRATION_TTL_MS).toISOString(),
    resendCutoff: new Date(
      milliseconds - REGISTRATION_RESEND_COOLDOWN_MS,
    ).toISOString(),
  };
}

function findPendingByHash(
  database: DatabaseConnection,
  tokenHash: string,
): PendingRegistrationRow | null {
  const rows = database
    .prepare(
      `SELECT id, email, invite_code_id, otp_hash, otp_key_version,
              otp_generation, phase, verified_at, attempts, resend_count,
              last_sent_at, expires_at, consumed_at, superseded_at
       FROM pending_registrations
       WHERE registration_token_hash = ?`,
    )
    .all(tokenHash) as PendingRegistrationRow[];
  if (rows.length > 1) {
    throw new Error("Registration token uniqueness is invalid");
  }
  return rows[0] ?? null;
}

function tokenHashOrInvalid(
  rawToken: string,
  keyring: TokenHmacKeyring,
): { readonly tokenHash: string; readonly hmacKeyVersion: number } {
  try {
    return computeRegistrationTokenHash(rawToken, keyring);
  } catch {
    throw new InvalidOrExpiredRegistrationError();
  }
}

function insertOutbox(
  database: DatabaseConnection,
  encrypted: ReturnType<typeof encryptRegistrationOtpPayload>,
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

export function startRegistration(
  database: DatabaseConnection,
  input: { readonly email: string; readonly inviteCode: string; readonly ip: string },
  keyrings: RegistrationServiceKeyrings,
  dependencies: RegistrationServiceDependencies = {},
): RegistrationTokenResult {
  const canonicalEmail = canonicalizeEmail(input.email);
  const inviteCandidates = computeInviteCodeHashCandidates(
    input.inviteCode,
    keyrings.inviteHmacKeyring,
  );
  const nowSource = dependencies.now ?? (() => new Date());
  const times = registrationTimes(nowSource);

  consumeRegistrationStartRateLimit(
    database,
    keyrings.rateLimitKeyring,
    {
      ip: input.ip,
      canonicalEmail,
      inviteHashIdentifiers: inviteCandidates.map(
        (candidate) => candidate.codeHash,
      ),
    },
    { now: () => times.date },
  );

  const token = generateRegistrationToken(
    keyrings.tokenHmacKeyring,
    dependencies.randomBytes ?? randomBytes,
  );
  const otp = generateRegistrationOtp(dependencies.randomInt ?? randomInt);
  const otpKeyVersion = keyrings.tokenHmacKeyring.version;
  const otpHash = computeRegistrationOtpHash(
    otp,
    otpKeyVersion,
    keyrings.tokenHmacKeyring,
  );
  const createPending = database.transaction((): boolean => {
    const invite = lookupInviteCode(
      database,
      input.inviteCode,
      keyrings.inviteHmacKeyring,
    );
    if (
      invite === null ||
      invite.revoked_at !== null ||
      invite.expires_at <= times.now ||
      invite.used_count >= invite.max_uses
    ) {
      return false;
    }
    database
      .prepare(
        `UPDATE pending_registrations
         SET superseded_at = ?
         WHERE email = ?
           AND phase IN ('awaiting_verification', 'verified')
           AND consumed_at IS NULL AND superseded_at IS NULL
           AND expires_at > ?`,
      )
      .run(times.now, canonicalEmail, times.now);

    database
      .prepare(
        `INSERT INTO pending_registrations (
           email, registration_token_hash, registration_token_key_version,
           invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
           attempts, resend_count, last_sent_at, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'awaiting_verification', 0, 1, ?, ?, ?)`,
      )
      .run(
        canonicalEmail,
        token.tokenHash,
        token.hmacKeyVersion,
        invite.id,
        otpHash,
        otpKeyVersion,
        times.now,
        times.expiresAt,
        times.now,
      );

    const pending = findPendingByHash(database, token.tokenHash);
    if (pending === null) {
      throw new Error("Registration pending row creation failed");
    }
    const encrypted = encryptRegistrationOtpPayload(
      {
        pendingRegistrationId: pending.id,
        otpGeneration: 1,
        toEmail: canonicalEmail,
        otp,
      },
      keyrings.mailPayloadEncKeyring,
      dependencies.outboxRandomBytes ?? randomBytes,
    );
    insertOutbox(database, encrypted, times.now);
    return true;
  });
  createPending.immediate();

  return { registrationToken: token.rawToken };
}

export function resendRegistrationCode(
  database: DatabaseConnection,
  input: { readonly registrationToken: string; readonly ip: string },
  keyrings: RegistrationServiceKeyrings,
  dependencies: RegistrationServiceDependencies = {},
): void {
  const { tokenHash } = tokenHashOrInvalid(
    input.registrationToken,
    keyrings.tokenHmacKeyring,
  );
  const pending = findPendingByHash(database, tokenHash);
  const nowSource = dependencies.now ?? (() => new Date());
  const times = registrationTimes(nowSource);
  if (pending === null) {
    consumeRegistrationIpRateLimit(
      database,
      keyrings.rateLimitKeyring,
      "register:resend:ip",
      input.ip,
      { now: () => times.date },
    );
    throw new InvalidOrExpiredRegistrationError();
  }

  const rateLimit = consumeRegistrationResendRateLimit(
    database,
    keyrings.rateLimitKeyring,
    { ip: input.ip, canonicalEmail: pending.email },
    { now: () => times.date },
  );
  if (rateLimit.emailSilenced) {
    return;
  }
  const resend = database.transaction((): boolean => {
    const current = findPendingByHash(database, tokenHash);
    if (
      current === null ||
      current.phase !== "awaiting_verification" ||
      current.expires_at <= times.now ||
      current.last_sent_at >= times.resendCutoff ||
      current.resend_count >= REGISTRATION_MAX_RESENDS ||
      current.superseded_at !== null ||
      current.consumed_at !== null
    ) {
      return false;
    }
    const otp = generateRegistrationOtp(dependencies.randomInt ?? randomInt);
    const otpKeyVersion = keyrings.tokenHmacKeyring.version;
    const otpHash = computeRegistrationOtpHash(
      otp,
      otpKeyVersion,
      keyrings.tokenHmacKeyring,
    );
    const nextGeneration = current.otp_generation + 1;
    const result = database
      .prepare(
        `UPDATE pending_registrations
         SET otp_hash = ?, otp_key_version = ?, otp_generation = otp_generation + 1,
             attempts = 0, last_sent_at = ?, resend_count = resend_count + 1,
             expires_at = ?
         WHERE registration_token_hash = ? AND phase = 'awaiting_verification'
           AND expires_at > ? AND resend_count < ?
           AND superseded_at IS NULL AND consumed_at IS NULL
           AND otp_generation = ?`,
      )
      .run(
        otpHash,
        otpKeyVersion,
        times.now,
        times.expiresAt,
        tokenHash,
        times.now,
        REGISTRATION_MAX_RESENDS,
        current.otp_generation,
      );
    if (result.changes !== 1) {
      throw new InvalidOrExpiredRegistrationError();
    }
    const encrypted = encryptRegistrationOtpPayload(
      {
        pendingRegistrationId: current.id,
        otpGeneration: nextGeneration,
        toEmail: current.email,
        otp,
      },
      keyrings.mailPayloadEncKeyring,
      dependencies.outboxRandomBytes ?? randomBytes,
    );
    insertOutbox(database, encrypted, times.now);
    return true;
  });
  resend.immediate();
}

export function verifyRegistrationCode(
  database: DatabaseConnection,
  input: {
    readonly registrationToken: string;
    readonly otp: string;
    readonly ip: string;
  },
  keyrings: RegistrationServiceKeyrings,
  dependencies: RegistrationServiceDependencies = {},
): RegistrationTokenResult {
  const nowSource = dependencies.now ?? (() => new Date());
  const times = registrationTimes(nowSource);
  consumeRegistrationIpRateLimit(
    database,
    keyrings.rateLimitKeyring,
    "register:verify:ip",
    input.ip,
    { now: () => times.date },
  );
  const { tokenHash } = tokenHashOrInvalid(
    input.registrationToken,
    keyrings.tokenHmacKeyring,
  );
  const pending = findPendingByHash(database, tokenHash);
  if (
    pending === null ||
    pending.phase !== "awaiting_verification" ||
    pending.expires_at <= times.now ||
    pending.attempts >= REGISTRATION_MAX_ATTEMPTS ||
    pending.superseded_at !== null ||
    pending.consumed_at !== null
  ) {
    throw new InvalidOrExpiredRegistrationError();
  }

  const verified = verifyRegistrationOtp(
    input.otp,
    pending.otp_hash,
    pending.otp_key_version,
    keyrings.tokenHmacKeyring,
  );
  if (!verified) {
    const result = database
      .prepare(
        `UPDATE pending_registrations SET attempts = attempts + 1
         WHERE registration_token_hash = ? AND phase = 'awaiting_verification'
           AND expires_at > ? AND attempts < ?
           AND superseded_at IS NULL AND consumed_at IS NULL
           AND otp_generation = ?`,
      )
      .run(
        tokenHash,
        times.now,
        REGISTRATION_MAX_ATTEMPTS,
        pending.otp_generation,
      );
    if (result.changes !== 1) {
      throw new InvalidOrExpiredRegistrationError();
    }
    throw new InvalidOrExpiredRegistrationError();
  }

  const nextToken = generateRegistrationToken(
    keyrings.tokenHmacKeyring,
    dependencies.randomBytes ?? randomBytes,
  );
  const result = database
    .prepare(
      `UPDATE pending_registrations
       SET phase = 'verified', verified_at = ?, registration_token_hash = ?,
           registration_token_key_version = ?
       WHERE registration_token_hash = ? AND phase = 'awaiting_verification'
         AND expires_at > ? AND attempts < ?
         AND superseded_at IS NULL AND consumed_at IS NULL
         AND otp_generation = ?`,
    )
    .run(
      times.now,
      nextToken.tokenHash,
      nextToken.hmacKeyVersion,
      tokenHash,
      times.now,
      REGISTRATION_MAX_ATTEMPTS,
      pending.otp_generation,
    );
  if (result.changes !== 1) {
    throw new InvalidOrExpiredRegistrationError();
  }
  return { registrationToken: nextToken.rawToken };
}

export async function completeRegistration(
  database: DatabaseConnection,
  input: {
    readonly registrationToken: string;
    readonly password: string;
    readonly ip: string;
  },
  keyrings: RegistrationServiceKeyrings,
  dependencies: RegistrationServiceDependencies = {},
): Promise<void> {
  const nowSource = dependencies.now ?? (() => new Date());
  const times = registrationTimes(nowSource);
  consumeRegistrationIpRateLimit(
    database,
    keyrings.rateLimitKeyring,
    "register:complete:ip",
    input.ip,
    { now: () => times.date },
  );
  const { tokenHash } = tokenHashOrInvalid(
    input.registrationToken,
    keyrings.tokenHmacKeyring,
  );
  const initial = findPendingByHash(database, tokenHash);
  if (
    initial === null ||
    initial.phase !== "verified" ||
    initial.expires_at <= times.now ||
    initial.superseded_at !== null ||
    initial.consumed_at !== null
  ) {
    throw new InvalidOrExpiredRegistrationError();
  }

  const passwordHash = await hashPassword(input.password);
  const ipAddress = canonicalizeIp(input.ip);
  const complete = database.transaction(() => {
    const current = findPendingByHash(database, tokenHash);
    if (
      current === null ||
      current.phase !== "verified" ||
      current.expires_at <= times.now ||
      current.superseded_at !== null ||
      current.consumed_at !== null
    ) {
      throw new InvalidOrExpiredRegistrationError();
    }
    const existingUser = database
      .prepare("SELECT id FROM users WHERE email = ?")
      .all(current.email);
    if (existingUser.length !== 0) {
      throw new RegistrationEmailTakenError();
    }
    const inviteUpdate = database
      .prepare(
        `UPDATE invite_codes SET used_count = used_count + 1
         WHERE id = ? AND used_count < max_uses
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(current.invite_code_id, times.now);
    if (inviteUpdate.changes !== 1) {
      throw new InvalidOrExpiredRegistrationError();
    }

    database
      .prepare(
        `INSERT INTO users (
           email, password_hash, role, status, invited_by_code_id,
           created_at, updated_at
         ) VALUES (?, ?, 'user', 'active', ?, ?, ?)`,
      )
      .run(
        current.email,
        passwordHash,
        current.invite_code_id,
        times.now,
        times.now,
      );
    const userRows = database
      .prepare("SELECT id FROM users WHERE email = ?")
      .all(current.email) as Array<{ readonly id: number }>;
    const userId = userRows[0]?.id;
    if (typeof userId !== "number") {
      throw new Error("Registration user creation failed");
    }
    database
      .prepare(
        `INSERT INTO invite_code_redemptions (
           invite_code_id, user_id, redeemed_at, ip_address
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(current.invite_code_id, userId, times.now, ipAddress);
    const pendingUpdate = database
      .prepare(
        `UPDATE pending_registrations SET phase = 'completed', consumed_at = ?
         WHERE registration_token_hash = ? AND phase = 'verified'
           AND consumed_at IS NULL AND superseded_at IS NULL`,
      )
      .run(times.now, tokenHash);
    if (pendingUpdate.changes !== 1) {
      throw new InvalidOrExpiredRegistrationError();
    }
    database
      .prepare(
        `INSERT INTO audit_log (actor, action, target_ref, created_at)
         VALUES ('system:register', 'user_created', ?, ?)`,
      )
      .run(String(userId), times.now);
  });
  complete.immediate();
}

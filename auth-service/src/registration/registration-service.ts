import { randomBytes, randomInt } from "node:crypto";

import { canonicalizeEmail } from "../auth/email.js";
import { hashPassword } from "../auth/password.js";
import type { DatabaseConnection } from "../db.js";
import {
  canonicalizeIp,
  consumeRegistrationIpRateLimit,
  withRegistrationIpRateLimit,
  withRegistrationResendRateLimit,
  withRegistrationStartRateLimit,
  type RateLimitKeyring,
  type RegistrationRateLimitDependencies,
} from "../http/rate-limit.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  computeInviteCodeHashCandidates,
  lookupInviteCode,
  type InviteHmacKeyring,
} from "./invite-code.js";
import {
  computeMailRecipientAuditHmac,
  encryptRegistrationOtpPayload,
} from "./mail-outbox.js";
import { ensureReferralProfile } from "../referral/profile.js";
import { REFERRAL_PUBLIC_CODE_PATTERN } from "../referral/public-resolution.js";
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
const REGISTRATION_MAX_SEND_COUNT = 1 + REGISTRATION_MAX_RESENDS;

interface PendingRegistrationRow {
  readonly id: number;
  readonly email: string;
  readonly invite_code_id: number | null;
  readonly personal_inviter_profile_id: number | null;
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
  readonly referral_source_profile_id: number | null;
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
  readonly hashPassword?: (password: string) => Promise<string>;
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
      `SELECT id, email, invite_code_id, personal_inviter_profile_id,
              otp_hash, otp_key_version,
              otp_generation, phase, verified_at, attempts, resend_count,
              last_sent_at, expires_at, consumed_at, superseded_at,
              referral_source_profile_id
       FROM pending_registrations
       WHERE registration_token_hash = ?`,
    )
    .all(tokenHash) as PendingRegistrationRow[];
  if (rows.length > 1) {
    throw new Error("Registration token uniqueness is invalid");
  }
  return rows[0] ?? null;
}

function findReferralSourceProfileId(
  database: DatabaseConnection,
  publicCode: string | undefined,
): number | null {
  if (
    publicCode === undefined ||
    !REFERRAL_PUBLIC_CODE_PATTERN.test(publicCode)
  ) {
    return null;
  }
  const rows = database
    .prepare("SELECT id FROM referral_profiles WHERE public_code = ?")
    .all(publicCode) as Array<{ readonly id: unknown }>;
  if (rows.length > 1) {
    throw new Error("Referral public code uniqueness is invalid");
  }
  const id = rows[0]?.id;
  if (id === undefined) return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new Error("Referral profile identity is invalid");
  }
  return id;
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

interface PersonalInviter {
  readonly profileId: number;
  readonly userId: number;
  readonly email: string;
}

// A personal code is valid only while its owner exists and is active (the
// existing users.status field); anything else is indistinguishable from an
// unknown code.
function findActivePersonalInviter(
  database: DatabaseConnection,
  where: { readonly publicCode: string } | { readonly profileId: number },
): PersonalInviter | null {
  const byCode = "publicCode" in where;
  const rows = database
    .prepare(
      `SELECT p.id AS profile_id, u.id AS user_id, u.email AS email
       FROM referral_profiles AS p
       JOIN users AS u ON u.id = p.user_id
       WHERE ${byCode ? "p.public_code = ?" : "p.id = ?"} AND u.status = 'active'`,
    )
    .all(byCode ? where.publicCode : where.profileId) as Array<{
    readonly profile_id: unknown;
    readonly user_id: unknown;
    readonly email: unknown;
  }>;
  if (rows.length > 1) {
    throw new Error("Personal invite code uniqueness is invalid");
  }
  const row = rows[0];
  if (row === undefined) return null;
  if (
    typeof row.profile_id !== "number" ||
    !Number.isSafeInteger(row.profile_id) ||
    typeof row.user_id !== "number" ||
    !Number.isSafeInteger(row.user_id) ||
    typeof row.email !== "string"
  ) {
    throw new Error("Personal inviter identity is invalid");
  }
  return { profileId: row.profile_id, userId: row.user_id, email: row.email };
}

interface PendingBinding {
  readonly email: string;
  readonly inviteCodeId: number | null;
  readonly personalInviterProfileId: number | null;
  readonly referralSourceProfileId: number | null;
}

// Shared by both paths: cooldown, supersede, pending row, and outbox mail.
// Returns false (silently) while the resend cooldown is active.
function createPendingRegistration(
  database: DatabaseConnection,
  binding: PendingBinding,
  secrets: {
    readonly tokenHash: string;
    readonly tokenKeyVersion: number;
    readonly otp: string;
    readonly otpHash: string;
    readonly otpKeyVersion: number;
  },
  times: ReturnType<typeof registrationTimes>,
  keyrings: RegistrationServiceKeyrings,
  dependencies: RegistrationServiceDependencies,
): boolean {
  const recentRows = database
    .prepare(
      `SELECT last_sent_at FROM pending_registrations
       WHERE email = ?
         AND phase IN ('awaiting_verification', 'verified')
         AND consumed_at IS NULL AND superseded_at IS NULL
         AND expires_at > ?
       ORDER BY last_sent_at DESC
       LIMIT 1`,
    )
    .all(binding.email, times.now) as Array<{
      readonly last_sent_at: unknown;
    }>;
  const recentSentAt = recentRows[0]?.last_sent_at;
  if (
    recentRows.length > 1 ||
    (recentSentAt !== undefined && typeof recentSentAt !== "string")
  ) {
    throw new Error("Registration cooldown state is invalid");
  }
  if (
    typeof recentSentAt === "string" &&
    recentSentAt > times.resendCutoff
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
    .run(times.now, binding.email, times.now);

  database
    .prepare(
      `INSERT INTO pending_registrations (
         email, registration_token_hash, registration_token_key_version,
         invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
         attempts, resend_count, last_sent_at, expires_at, created_at,
         referral_source_profile_id, personal_inviter_profile_id
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'awaiting_verification', 0, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      binding.email,
      secrets.tokenHash,
      secrets.tokenKeyVersion,
      binding.inviteCodeId,
      secrets.otpHash,
      secrets.otpKeyVersion,
      times.now,
      times.expiresAt,
      times.now,
      binding.referralSourceProfileId,
      binding.personalInviterProfileId,
    );

  const pending = findPendingByHash(database, secrets.tokenHash);
  if (pending === null) {
    throw new Error("Registration pending row creation failed");
  }
  const encrypted = encryptRegistrationOtpPayload(
    {
      pendingRegistrationId: pending.id,
      otpGeneration: 1,
      toEmail: binding.email,
      otp: secrets.otp,
    },
    keyrings.mailPayloadEncKeyring,
    dependencies.outboxRandomBytes ?? randomBytes,
  );
  insertOutbox(database, encrypted, times.now);
  return true;
}

export function startRegistration(
  database: DatabaseConnection,
  input: {
    readonly email: string;
    readonly inviteCode: string;
    readonly referralCode?: string;
    readonly ip: string;
  },
  keyrings: RegistrationServiceKeyrings,
  dependencies: RegistrationServiceDependencies = {},
): RegistrationTokenResult {
  const canonicalEmail = canonicalizeEmail(input.email);
  // The two code formats are disjoint: personal codes are the 24-character
  // referral public code; legacy admin codes are 34 characters with dashes.
  const personal = REFERRAL_PUBLIC_CODE_PATTERN.test(input.inviteCode);
  const inviteCandidates = personal
    ? []
    : computeInviteCodeHashCandidates(
        input.inviteCode,
        keyrings.inviteHmacKeyring,
      );
  const nowSource = dependencies.now ?? (() => new Date());
  const times = registrationTimes(nowSource);
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
  const secrets = {
    tokenHash: token.tokenHash,
    tokenKeyVersion: token.hmacKeyVersion,
    otp,
    otpHash,
    otpKeyVersion,
  };

  withRegistrationStartRateLimit(
    database,
    keyrings.rateLimitKeyring,
    personal
      ? { ip: input.ip, personalCodeIdentifier: input.inviteCode }
      : {
          ip: input.ip,
          inviteHashIdentifiers: inviteCandidates.map(
            (candidate) => candidate.codeHash,
          ),
        },
    (rateLimit) => {
      if (rateLimit.inviteSilenced) return false;
      if (personal) {
        const inviter = findActivePersonalInviter(database, {
          publicCode: input.inviteCode,
        });
        // Unknown/disabled owner, self-invite, or a conflicting referral code
        // all fail neutrally, exactly like an unknown code.
        if (
          inviter === null ||
          inviter.email === canonicalEmail ||
          (input.referralCode !== undefined &&
            input.referralCode !== input.inviteCode)
        ) {
          return false;
        }
        const emailRateLimit = rateLimit.consumeEmail(canonicalEmail);
        if (emailRateLimit.emailSilenced) return false;
        return createPendingRegistration(
          database,
          {
            email: canonicalEmail,
            inviteCodeId: null,
            personalInviterProfileId: inviter.profileId,
            referralSourceProfileId:
              input.referralCode === undefined ? null : inviter.profileId,
          },
          secrets,
          times,
          keyrings,
          dependencies,
        );
      }
      const invite = lookupInviteCode(
        database,
        input.inviteCode,
        keyrings.inviteHmacKeyring,
      );
      if (
        invite === null ||
        invite.is_bootstrap !== 0 ||
        invite.recipient_email === null ||
        invite.recipient_email !== canonicalEmail ||
        invite.max_uses !== 1 ||
        (invite.used_count !== 0 && invite.used_count !== 1)
      ) {
        return false;
      }
      const emailRateLimit = rateLimit.consumeEmail(invite.recipient_email);
      if (emailRateLimit.emailSilenced) return false;
      const referralSourceProfileId = findReferralSourceProfileId(
        database,
        input.referralCode,
      );
      return createPendingRegistration(
        database,
        {
          email: invite.recipient_email,
          inviteCodeId: invite.id,
          personalInviterProfileId: null,
          referralSourceProfileId,
        },
        secrets,
        times,
        keyrings,
        dependencies,
      );
    },
    { now: () => times.date },
  );

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
  const nowSource = dependencies.now ?? (() => new Date());
  const times = registrationTimes(nowSource);
  withRegistrationResendRateLimit(
    database,
    keyrings.rateLimitKeyring,
    { ip: input.ip },
    (rateLimit) => {
      const current = findPendingByHash(database, tokenHash);
      if (current === null) return false;
      const emailRateLimit = rateLimit.consumeEmail(current.email);
      if (
        emailRateLimit.emailSilenced ||
        current.phase !== "awaiting_verification" ||
        current.expires_at <= times.now ||
        current.last_sent_at > times.resendCutoff ||
        current.resend_count >= REGISTRATION_MAX_SEND_COUNT ||
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
          REGISTRATION_MAX_SEND_COUNT,
          current.otp_generation,
        );
      if (result.changes !== 1) {
        throw new Error("Registration resend update failed");
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
    },
    { now: () => times.date },
  );
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
  let tokenHash: string;
  try {
    ({ tokenHash } = tokenHashOrInvalid(
      input.registrationToken,
      keyrings.tokenHmacKeyring,
    ));
  } catch (error) {
    consumeRegistrationIpRateLimit(
      database,
      keyrings.rateLimitKeyring,
      "register:complete:ip",
      input.ip,
      { now: () => times.date },
    );
    throw error;
  }
  const initial = findPendingByHash(database, tokenHash);
  if (
    initial === null ||
    initial.phase !== "verified" ||
    initial.expires_at <= times.now ||
    initial.superseded_at !== null ||
    initial.consumed_at !== null
  ) {
    consumeRegistrationIpRateLimit(
      database,
      keyrings.rateLimitKeyring,
      "register:complete:ip",
      input.ip,
      { now: () => times.date },
    );
    throw new InvalidOrExpiredRegistrationError();
  }

  const passwordHash = await (dependencies.hashPassword ?? hashPassword)(
    input.password,
  );
  const ipAddress = canonicalizeIp(input.ip);
  const recipientHmac = computeMailRecipientAuditHmac(
    initial.email,
    keyrings.mailPayloadEncKeyring,
    keyrings.mailPayloadEncKeyring.version,
  );
  withRegistrationIpRateLimit(
    database,
    keyrings.rateLimitKeyring,
    "register:complete:ip",
    input.ip,
    () => {
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
      // Exactly one origin: the legacy prebound invite, or a real direct inviter.
      let personalInviterUserId: number | null = null;
      if (current.invite_code_id !== null) {
        const inviteUpdate = database
          .prepare(
            `UPDATE invite_codes SET used_count = 1
             WHERE id = ? AND recipient_email = ?
               AND is_bootstrap = 0 AND max_uses = 1 AND used_count = 0
               AND revoked_at IS NULL AND expires_at > ?`,
          )
          .run(current.invite_code_id, current.email, times.now);
        if (inviteUpdate.changes !== 1) {
          throw new InvalidOrExpiredRegistrationError();
        }
      } else {
        const inviter =
          current.personal_inviter_profile_id === null
            ? null
            : findActivePersonalInviter(database, {
                profileId: current.personal_inviter_profile_id,
              });
        if (inviter === null || inviter.email === current.email) {
          throw new InvalidOrExpiredRegistrationError();
        }
        personalInviterUserId = inviter.userId;
      }
      const existingUser = database
        .prepare("SELECT id FROM users WHERE email = ?")
        .all(current.email);
      if (existingUser.length !== 0) {
        throw new RegistrationEmailTakenError();
      }

      database
        .prepare(
          `INSERT INTO users (
             email, password_hash, role, status, invited_by_code_id,
             invited_by_user_id, created_at, updated_at
           ) VALUES (?, ?, 'user', 'active', ?, ?, ?, ?)`,
        )
        .run(
          current.email,
          passwordHash,
          current.invite_code_id,
          personalInviterUserId,
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
      // Every new account gets its own stable personal code in the same
      // transaction, through the existing collision-safe mechanism.
      ensureReferralProfile(database, userId, { now: () => times.date });
      if (current.referral_source_profile_id !== null) {
        const sourceRows = database
          .prepare("SELECT user_id FROM referral_profiles WHERE id = ?")
          .all(current.referral_source_profile_id) as Array<{
          readonly user_id: unknown;
        }>;
        const sourceUserId = sourceRows[0]?.user_id;
        if (
          sourceRows.length !== 1 ||
          typeof sourceUserId !== "number" ||
          !Number.isSafeInteger(sourceUserId) ||
          sourceUserId === userId
        ) {
          throw new InvalidOrExpiredRegistrationError();
        }
        database
          .prepare(
            `INSERT INTO referral_attribution_candidates (
               referred_user_id, source_profile_id, status, created_at
             ) VALUES (?, ?, 'pending', ?)
             ON CONFLICT(referred_user_id) DO NOTHING`,
          )
          .run(userId, current.referral_source_profile_id, times.now);
      }
      if (current.invite_code_id !== null) {
        database
          .prepare(
            `INSERT INTO invite_code_redemptions (
               invite_code_id, user_id, redeemed_at, ip_address
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(current.invite_code_id, userId, times.now, ipAddress);
        database
          .prepare(
            `INSERT INTO audit_log (
               actor, action, target_ref, created_at, invite_code_id,
               result_class, recipient_hmac
             ) VALUES (
               'system:invite', 'invite_code.redeem', NULL, ?, ?, 'redeemed', ?
             )`,
          )
          .run(times.now, current.invite_code_id, recipientHmac);
      }
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
    },
    { now: () => times.date },
  );
}

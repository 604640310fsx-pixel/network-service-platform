import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { DatabaseConnection } from "../db.js";

export const REFERRAL_PUBLIC_CODE_LENGTH = 24;
const REFERRAL_PUBLIC_CODE_BYTES = 18;
const MAX_PUBLIC_CODE_ATTEMPTS = 8;

export interface ReferralProfile {
  readonly publicCode: string;
  readonly createdAt: string;
}

export interface ReferralProfileDependencies {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
}

interface ReferralProfileRow {
  readonly public_code: unknown;
  readonly created_at: unknown;
}

function validateUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Referral profile user id is invalid");
  }
}

function parseProfileRow(row: unknown): ReferralProfile {
  if (
    typeof row !== "object" ||
    row === null ||
    !("public_code" in row) ||
    !("created_at" in row)
  ) {
    throw new Error("Referral profile query returned an invalid row");
  }
  const candidate = row as ReferralProfileRow;
  if (
    typeof candidate.public_code !== "string" ||
    !/^[A-Za-z0-9_-]{24}$/.test(candidate.public_code) ||
    typeof candidate.created_at !== "string"
  ) {
    throw new Error("Referral profile query returned an invalid row");
  }
  const instant = new Date(candidate.created_at);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString() !== candidate.created_at
  ) {
    throw new Error("Referral profile timestamp is invalid");
  }
  return {
    publicCode: candidate.public_code,
    createdAt: candidate.created_at,
  };
}

export function readReferralProfile(
  database: DatabaseConnection,
  userId: number,
): ReferralProfile | null {
  validateUserId(userId);
  const rows = database
    .prepare(
      `SELECT public_code, created_at
       FROM referral_profiles
       WHERE user_id = ?`,
    )
    .all(userId);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error("Referral profile query returned multiple rows");
  }
  return parseProfileRow(rows[0]);
}

function issuePublicCode(randomSource: (size: number) => Buffer): string {
  const bytes = randomSource(REFERRAL_PUBLIC_CODE_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== REFERRAL_PUBLIC_CODE_BYTES) {
    throw new Error("Referral public code random source is invalid");
  }
  const publicCode = bytes.toString("base64url");
  if (
    publicCode.length !== REFERRAL_PUBLIC_CODE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(publicCode)
  ) {
    throw new Error("Referral public code generation failed");
  }
  return publicCode;
}

export function ensureReferralProfile(
  database: DatabaseConnection,
  userId: number,
  dependencies: ReferralProfileDependencies = {},
): ReferralProfile {
  validateUserId(userId);
  const existing = readReferralProfile(database, userId);
  if (existing !== null) return existing;

  const randomSource = dependencies.randomBytes ?? nodeRandomBytes;
  const nowSource = dependencies.now ?? (() => new Date());

  for (let attempt = 0; attempt < MAX_PUBLIC_CODE_ATTEMPTS; attempt += 1) {
    const publicCode = issuePublicCode(randomSource);
    const createdAt = nowSource().toISOString();
    const create = database.transaction(() => {
      const current = readReferralProfile(database, userId);
      if (current !== null) return current;

      database
        .prepare(
          `INSERT INTO referral_profiles (user_id, public_code, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(userId, publicCode, createdAt);
      return readReferralProfile(database, userId);
    });
    const profile = create.immediate();
    if (profile !== null) return profile;
  }

  throw new Error("Referral public code could not be allocated");
}

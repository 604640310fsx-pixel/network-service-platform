import { timingSafeEqual } from "node:crypto";

import type { DatabaseConnection } from "../db.js";
import {
  CSRF_TOKEN_LENGTH,
  issueCsrfToken,
} from "../http/csrf.js";
import {
  computeSessionTokenHash,
  SESSION_TOKEN_HASH_LENGTH,
  SESSION_TOKEN_PATTERN,
  type TokenHmacKeyring,
} from "./session-token.js";
import { SESSION_IDLE_TTL_MS } from "./session-validity.js";

export type SessionTerminationResult =
  | "terminated"
  | "unauthenticated"
  | "csrf_invalid";

export interface SessionTerminationDependencies {
  readonly now?: () => Date;
}

interface ParsedSessionRow {
  readonly sessionId: number;
  readonly userId: number;
  readonly sessionFamilyId: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly sessionRevokedAt: string | null;
  readonly familyRevokedAt: string | null;
  readonly userStatus: "active" | "disabled";
}

const SESSION_ROW_KEYS = [
  "audience",
  "expires_at",
  "family_id",
  "family_revoked_at",
  "family_user_id",
  "hmac_key_version",
  "last_seen_at",
  "session_family_id",
  "session_id",
  "session_revoked_at",
  "session_user_id",
  "token_hash",
  "user_id",
  "user_status",
] as const;

const SESSION_TERMINATION_QUERY = `
  SELECT
    sessions.id AS session_id,
    sessions.token_hash AS token_hash,
    sessions.hmac_key_version AS hmac_key_version,
    sessions.user_id AS session_user_id,
    sessions.session_family_id AS session_family_id,
    sessions.audience AS audience,
    sessions.expires_at AS expires_at,
    sessions.last_seen_at AS last_seen_at,
    sessions.revoked_at AS session_revoked_at,
    session_families.id AS family_id,
    session_families.user_id AS family_user_id,
    session_families.revoked_at AS family_revoked_at,
    users.id AS user_id,
    users.status AS user_status
  FROM sessions
  LEFT JOIN session_families
    ON session_families.id = sessions.session_family_id
  LEFT JOIN users
    ON users.id = sessions.user_id
  WHERE sessions.token_hash = ?
    AND sessions.hmac_key_version = ?
    AND sessions.audience = ?
`;

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isNullableCanonicalTimestamp(value: unknown): value is string | null {
  return value === null || isCanonicalTimestamp(value);
}

function parseSessionRow(
  row: unknown,
  tokenHash: string,
  hmacKeyVersion: number,
): ParsedSessionRow {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Session termination returned an invalid row");
  }

  const candidate = row as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== SESSION_ROW_KEYS.length ||
    keys.some((key, index) => key !== SESSION_ROW_KEYS[index])
  ) {
    throw new Error("Session termination returned an unexpected row");
  }

  if (
    !isPositiveSafeInteger(candidate.session_id) ||
    typeof candidate.token_hash !== "string" ||
    !new RegExp(`^[A-Za-z0-9_-]{${SESSION_TOKEN_HASH_LENGTH}}$`).test(
      candidate.token_hash,
    ) ||
    !Number.isSafeInteger(candidate.hmac_key_version) ||
    typeof candidate.hmac_key_version !== "number" ||
    !isPositiveSafeInteger(candidate.session_user_id) ||
    typeof candidate.session_family_id !== "string" ||
    candidate.session_family_id.length === 0 ||
    candidate.audience !== "web" ||
    !isCanonicalTimestamp(candidate.expires_at) ||
    !isCanonicalTimestamp(candidate.last_seen_at) ||
    !isNullableCanonicalTimestamp(candidate.session_revoked_at) ||
    typeof candidate.family_id !== "string" ||
    candidate.family_id.length === 0 ||
    !isPositiveSafeInteger(candidate.family_user_id) ||
    !isNullableCanonicalTimestamp(candidate.family_revoked_at) ||
    !isPositiveSafeInteger(candidate.user_id) ||
    (candidate.user_status !== "active" && candidate.user_status !== "disabled")
  ) {
    throw new Error("Session termination returned a corrupt row");
  }

  if (
    candidate.token_hash !== tokenHash ||
    candidate.hmac_key_version !== hmacKeyVersion ||
    candidate.session_user_id !== candidate.family_user_id ||
    candidate.session_user_id !== candidate.user_id ||
    candidate.session_family_id !== candidate.family_id
  ) {
    throw new Error("Session termination identity binding failed");
  }

  return {
    sessionId: candidate.session_id,
    userId: candidate.session_user_id,
    sessionFamilyId: candidate.session_family_id,
    expiresAt: candidate.expires_at,
    lastSeenAt: candidate.last_seen_at,
    sessionRevokedAt: candidate.session_revoked_at,
    familyRevokedAt: candidate.family_revoked_at,
    userStatus: candidate.user_status,
  };
}

function sessionCutoffs(nowSource: () => Date): {
  readonly now: string;
  readonly idleCutoff: string;
} {
  const nowDate = nowSource();
  const nowValue = nowDate.getTime();
  if (!Number.isFinite(nowValue)) {
    throw new Error("Session termination time source is invalid");
  }

  return {
    now: nowDate.toISOString(),
    idleCutoff: new Date(nowValue - SESSION_IDLE_TTL_MS).toISOString(),
  };
}

function csrfMatches(
  csrfSigningKey: Buffer,
  sessionTokenHash: string,
  candidateToken: unknown,
): boolean {
  if (
    typeof candidateToken !== "string" ||
    !new RegExp(`^[A-Za-z0-9_-]{${CSRF_TOKEN_LENGTH}}$`).test(candidateToken)
  ) {
    return false;
  }

  const expectedToken = issueCsrfToken(csrfSigningKey, sessionTokenHash);
  return timingSafeEqual(
    Buffer.from(candidateToken, "ascii"),
    Buffer.from(expectedToken, "ascii"),
  );
}

export function terminateCurrentWebSession(
  database: DatabaseConnection,
  rawSessionToken: string,
  candidateCsrfToken: unknown,
  tokenHmacKeyring: TokenHmacKeyring,
  csrfSigningKey: Buffer,
  dependencies: SessionTerminationDependencies = {},
): SessionTerminationResult {
  if (!SESSION_TOKEN_PATTERN.test(rawSessionToken)) {
    return "unauthenticated";
  }

  // A syntactically legal token whose configured version cannot be hashed is an
  // infrastructure failure, not an unauthenticated credential.
  const token = computeSessionTokenHash(rawSessionToken, tokenHmacKeyring);
  const terminate = database.transaction((): SessionTerminationResult => {
    const rows = database
      .prepare(SESSION_TERMINATION_QUERY)
      .all(token.tokenHash, token.hmacKeyVersion, "web");

    if (rows.length === 0) {
      return "unauthenticated";
    }
    if (rows.length !== 1) {
      throw new Error("Session termination returned multiple rows");
    }

    const session = parseSessionRow(
      rows[0],
      token.tokenHash,
      token.hmacKeyVersion,
    );
    const { now, idleCutoff } = sessionCutoffs(
      dependencies.now ?? (() => new Date()),
    );
    if (
      session.sessionRevokedAt !== null ||
      session.expiresAt <= now ||
      session.lastSeenAt <= idleCutoff ||
      session.familyRevokedAt !== null ||
      session.userStatus !== "active"
    ) {
      return "unauthenticated";
    }

    if (!csrfMatches(csrfSigningKey, token.tokenHash, candidateCsrfToken)) {
      return "csrf_invalid";
    }

    const update = database
      .prepare(
        `UPDATE sessions
         SET revoked_at = ?
         WHERE id = ?
           AND token_hash = ?
           AND hmac_key_version = ?
           AND user_id = ?
           AND session_family_id = ?
           AND audience = 'web'
           AND revoked_at IS NULL`,
      )
      .run(
        now,
        session.sessionId,
        token.tokenHash,
        token.hmacKeyVersion,
        session.userId,
        session.sessionFamilyId,
      );

    if (update.changes !== 1) {
      throw new Error("Session termination update count was unexpected");
    }

    return "terminated";
  });

  return terminate.immediate();
}

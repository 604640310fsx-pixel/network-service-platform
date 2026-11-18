import type { FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import { readWebSessionCookie } from "../http/cookie.js";
import { SESSION_IDLE_TTL_MS } from "../session/session-validity.js";
import {
  computeSessionTokenHash,
  SessionTokenOperationError,
  type TokenHmacKeyring,
} from "../session/session-token.js";

export interface ReferralSessionDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly now?: () => Date;
}

export interface ReferralSession {
  readonly userId: number;
  readonly sessionTokenHash: string;
}

interface ReferralSessionRow {
  readonly user_id: unknown;
}

/** Referral GET is contractually read-only, so session validity is checked without
 * advancing last_seen_at. The cookie format, token hashing, audience, TTL, family
 * revocation and active-user rules are the existing customer-session rules. */
export function readReferralSessionReadOnly(
  request: FastifyRequest,
  dependencies: ReferralSessionDependencies,
): ReferralSession | null {
  const rawSessionToken = readWebSessionCookie(request.headers.cookie);
  if (rawSessionToken === null) return null;

  let token: ReturnType<typeof computeSessionTokenHash>;
  try {
    token = computeSessionTokenHash(
      rawSessionToken,
      dependencies.tokenHmacKeyring,
    );
  } catch (error) {
    if (error instanceof SessionTokenOperationError) return null;
    throw error;
  }

  const nowDate = (dependencies.now ?? (() => new Date()))();
  const nowValue = nowDate.getTime();
  if (!Number.isFinite(nowValue)) {
    throw new Error("Referral session time source is invalid");
  }
  const now = nowDate.toISOString();
  const idleCutoff = new Date(nowValue - SESSION_IDLE_TTL_MS).toISOString();
  const rows = dependencies.database
    .prepare(
      `SELECT sessions.user_id AS user_id
       FROM sessions
       JOIN session_families
         ON session_families.id = sessions.session_family_id
        AND session_families.user_id = sessions.user_id
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?
         AND sessions.hmac_key_version = ?
         AND sessions.audience = 'web'
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ?
         AND sessions.last_seen_at > ?
         AND session_families.revoked_at IS NULL
         AND users.status = 'active'`,
    )
    .all(token.tokenHash, token.hmacKeyVersion, now, idleCutoff);

  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error("Referral session lookup returned multiple rows");
  }
  const row = rows[0] as ReferralSessionRow | undefined;
  if (
    row === undefined ||
    typeof row.user_id !== "number" ||
    !Number.isSafeInteger(row.user_id) ||
    row.user_id <= 0
  ) {
    throw new Error("Referral session lookup returned an invalid row");
  }
  return { userId: row.user_id, sessionTokenHash: token.tokenHash };
}

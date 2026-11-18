import type { UserRole } from "../auth/user-repository.js";
import type { DatabaseConnection } from "../db.js";
import {
  computeSessionTokenHash,
  SessionTokenOperationError,
  type TokenHmacKeyring,
} from "./session-token.js";

export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1_000;

export type SessionAudience = "web" | "monitor";

export interface AuthenticatedPrincipal {
  readonly sessionId: number;
  readonly userId: number;
  readonly sessionFamilyId: string;
  readonly audience: SessionAudience;
  readonly email: string;
  readonly role: UserRole;
}

export interface SessionLookupDependencies {
  readonly now?: () => Date;
}

interface SessionRow {
  readonly session_id: unknown;
  readonly user_id: unknown;
  readonly session_family_id: unknown;
  readonly audience: unknown;
  readonly email: unknown;
  readonly role: unknown;
  readonly last_seen_at: unknown;
}

const VALID_SESSION_QUERY = `
  SELECT
    sessions.id AS session_id,
    sessions.user_id AS user_id,
    sessions.session_family_id AS session_family_id,
    sessions.audience AS audience,
    users.email AS email,
    users.role AS role,
    sessions.last_seen_at AS last_seen_at
  FROM sessions
  JOIN session_families
    ON session_families.id = sessions.session_family_id
   AND session_families.user_id = sessions.user_id
  JOIN users ON users.id = sessions.user_id
  WHERE sessions.token_hash = ?
    AND sessions.hmac_key_version = ?
    AND sessions.audience = ?
    AND sessions.revoked_at IS NULL
    AND sessions.expires_at > ?
    AND sessions.last_seen_at > ?
    AND session_families.revoked_at IS NULL
    AND users.status = 'active'
`;

function sessionCutoffs(nowSource: () => Date): {
  readonly now: string;
  readonly idleCutoff: string;
  readonly touchCutoff: string;
} {
  const nowDate = nowSource();
  const nowValue = nowDate.getTime();
  if (!Number.isFinite(nowValue)) {
    throw new Error("Session time source is invalid");
  }

  return {
    now: nowDate.toISOString(),
    idleCutoff: new Date(nowValue - SESSION_IDLE_TTL_MS).toISOString(),
    touchCutoff: new Date(
      nowValue - SESSION_TOUCH_INTERVAL_MS,
    ).toISOString(),
  };
}

function parseSessionRow(row: unknown): {
  readonly principal: AuthenticatedPrincipal;
  readonly lastSeenAt: string;
} {
  if (
    typeof row !== "object" ||
    row === null ||
    !("session_id" in row) ||
    !("user_id" in row) ||
    !("session_family_id" in row) ||
    !("audience" in row) ||
    !("email" in row) ||
    !("role" in row) ||
    !("last_seen_at" in row)
  ) {
    throw new Error("Session lookup returned an invalid row");
  }

  const candidate = row as SessionRow;
  if (
    typeof candidate.session_id !== "number" ||
    typeof candidate.user_id !== "number" ||
    typeof candidate.session_family_id !== "string" ||
    (candidate.audience !== "web" && candidate.audience !== "monitor") ||
    typeof candidate.email !== "string" ||
    (candidate.role !== "user" && candidate.role !== "admin") ||
    typeof candidate.last_seen_at !== "string"
  ) {
    throw new Error("Session lookup returned an invalid row");
  }

  return {
    principal: {
      sessionId: candidate.session_id,
      userId: candidate.user_id,
      sessionFamilyId: candidate.session_family_id,
      audience: candidate.audience,
      email: candidate.email,
      role: candidate.role,
    },
    lastSeenAt: candidate.last_seen_at,
  };
}

export function lookupAuthenticatedPrincipal(
  database: DatabaseConnection,
  rawSessionToken: string,
  audience: SessionAudience,
  tokenHmacKeyring: TokenHmacKeyring,
  dependencies: SessionLookupDependencies = {},
): AuthenticatedPrincipal | null {
  let token: ReturnType<typeof computeSessionTokenHash>;
  try {
    token = computeSessionTokenHash(rawSessionToken, tokenHmacKeyring);
  } catch (error) {
    if (error instanceof SessionTokenOperationError) {
      return null;
    }
    throw error;
  }

  const { now, idleCutoff, touchCutoff } = sessionCutoffs(
    dependencies.now ?? (() => new Date()),
  );
  const rows = database
    .prepare(VALID_SESSION_QUERY)
    .all(
      token.tokenHash,
      token.hmacKeyVersion,
      audience,
      now,
      idleCutoff,
    );

  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error("Session lookup returned multiple rows");
  }

  const { principal, lastSeenAt } = parseSessionRow(rows[0]);
  if (lastSeenAt < touchCutoff) {
    database
      .prepare(
        `UPDATE sessions
         SET last_seen_at = ?
         WHERE id = ? AND last_seen_at = ? AND last_seen_at < ?`,
      )
      .run(now, principal.sessionId, lastSeenAt, touchCutoff);
  }

  return principal;
}

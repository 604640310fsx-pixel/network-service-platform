import { randomUUID } from "node:crypto";

import {
  authenticateUserCandidate,
  InvalidCredentialsError,
  type AuthenticationCandidate,
} from "../auth/authentication.js";
import { findUserById, type UserRole } from "../auth/user-repository.js";
import type { DatabaseConnection } from "../db.js";
import {
  generateSessionToken,
  type RandomBytesSource,
  type TokenHmacKeyring,
} from "./session-token.js";

export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LoginSessionResult {
  readonly rawSessionToken: string;
  readonly sessionFamilyId: string;
  readonly userId: number;
  readonly role: UserRole;
  readonly expiresAt: string;
}

export interface LoginSessionDependencies {
  readonly now?: () => Date;
  readonly familyId?: () => string;
  readonly randomBytes?: RandomBytesSource;
}

function sessionTimes(nowSource: () => Date): {
  readonly now: string;
  readonly expiresAt: string;
} {
  const nowDate = nowSource();
  const nowValue = nowDate.getTime();
  if (!Number.isFinite(nowValue)) {
    throw new Error("Session time source is invalid");
  }

  return {
    now: nowDate.toISOString(),
    expiresAt: new Date(nowValue + SESSION_ABSOLUTE_TTL_MS).toISOString(),
  };
}

function createFamilyId(familyIdSource: () => string): string {
  const familyId = familyIdSource();
  if (!UUID_V4_PATTERN.test(familyId)) {
    throw new Error("Session family identifier generation failed");
  }
  return familyId;
}

export function createLoginSession(
  database: DatabaseConnection,
  candidate: AuthenticationCandidate,
  tokenHmacKeyring: TokenHmacKeyring,
  dependencies: LoginSessionDependencies = {},
): LoginSessionResult {
  const { now, expiresAt } = sessionTimes(dependencies.now ?? (() => new Date()));
  const sessionFamilyId = createFamilyId(
    dependencies.familyId ?? randomUUID,
  );
  const token = generateSessionToken(
    tokenHmacKeyring,
    dependencies.randomBytes,
  );

  const createSession = database.transaction((): UserRole => {
    const currentUser = findUserById(database, candidate.id);
    if (
      currentUser === null ||
      currentUser.status !== "active" ||
      currentUser.passwordHash !== candidate.verifiedPasswordHash
    ) {
      throw new InvalidCredentialsError();
    }

    database
      .prepare(
        `INSERT INTO session_families (id, user_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(sessionFamilyId, candidate.id, now);

    database
      .prepare(
        `INSERT INTO sessions (
          token_hash, hmac_key_version, user_id, session_family_id, audience,
          created_at, expires_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 'web', ?, ?, ?)`,
      )
      .run(
        token.tokenHash,
        token.hmacKeyVersion,
        candidate.id,
        sessionFamilyId,
        now,
        expiresAt,
        now,
      );

    return currentUser.role;
  });

  const currentRole = createSession.immediate();

  return {
    rawSessionToken: token.rawToken,
    sessionFamilyId,
    userId: candidate.id,
    role: currentRole,
    expiresAt,
  };
}

export async function loginAndCreateSession(
  database: DatabaseConnection,
  email: string,
  presentedPassword: string,
  tokenHmacKeyring: TokenHmacKeyring,
  dependencies: LoginSessionDependencies = {},
): Promise<LoginSessionResult> {
  const candidate = await authenticateUserCandidate(
    database,
    email,
    presentedPassword,
  );

  return createLoginSession(
    database,
    candidate,
    tokenHmacKeyring,
    dependencies,
  );
}

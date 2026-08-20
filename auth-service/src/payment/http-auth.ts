import type { FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import { readWebSessionCookie } from "../http/cookie.js";
import {
  computeSessionTokenHash,
  type TokenHmacKeyring,
} from "../session/session-token.js";
import {
  lookupAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from "../session/session-validity.js";

export interface PaymentSessionDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
}

export interface PaymentSession {
  readonly principal: AuthenticatedPrincipal;
  readonly sessionTokenHash: string;
}

export function readPaymentSession(
  request: FastifyRequest,
  dependencies: PaymentSessionDependencies,
): PaymentSession | null {
  const rawSessionToken = readWebSessionCookie(request.headers.cookie);
  if (rawSessionToken === null) {
    return null;
  }
  const lookup = dependencies.database.transaction(() =>
    lookupAuthenticatedPrincipal(
      dependencies.database,
      rawSessionToken,
      "web",
      dependencies.tokenHmacKeyring,
    ),
  );
  const principal = lookup.immediate();
  if (principal === null) {
    return null;
  }
  return {
    principal,
    sessionTokenHash: computeSessionTokenHash(
      rawSessionToken,
      dependencies.tokenHmacKeyring,
    ).tokenHash,
  };
}

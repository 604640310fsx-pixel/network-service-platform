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
  // 可选注入时钟。生产不提供 → Session 校验继续用真实 new Date()；
  // 测试提供冻结 TEST_NOW → Session validity 与 payment/order 业务同一时钟，
  // 避免真实墙钟越过固定 fixture 的 7 天 idle TTL 造成误判 idle-expired。
  readonly now?: () => Date;
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
      // 仅在注入时钟时传入，避免 exactOptionalPropertyTypes 下传 { now: undefined }；
      // 未注入时回落到 lookupAuthenticatedPrincipal 内部的真实 new Date()。
      dependencies.now ? { now: dependencies.now } : {},
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

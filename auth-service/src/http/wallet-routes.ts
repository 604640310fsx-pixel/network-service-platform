import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import { readPaymentSession, type PaymentSession } from "../payment/http-auth.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  produceRenewalQuote,
  readRenewalConsent,
  setRenewalConsent,
  walletBalance,
  WalletError,
  type BillingPeriod,
} from "../wallet/candidate.js";
import { verifyCsrfToken } from "./csrf.js";

const WALLET_BODY_LIMIT_BYTES = 32 * 1024;
const BILLING_PERIODS: readonly BillingPeriod[] = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"];

export interface WalletHttpDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly csrfSigningKey: Buffer;
  readonly now?: () => Date;
}

function errorBody(code: string) {
  return { error: { code } };
}

function setNoStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
}

type Gate =
  | { readonly ok: true; readonly session: PaymentSession }
  | { readonly ok: false; readonly statusCode: 401 | 403 | 503; readonly code: string };

// 身份永远来自服务端 Session；写操作再校验与该 Session 绑定的 X-CSRF-Token。
function authorize(
  request: FastifyRequest,
  dependencies: WalletHttpDependencies,
  options: { readonly write: boolean },
): Gate {
  let session: PaymentSession | null;
  try {
    session = readPaymentSession(request, dependencies);
  } catch {
    return { ok: false, statusCode: 503, code: "wallet_unavailable" };
  }
  if (session === null) return { ok: false, statusCode: 401, code: "unauthorized" };
  if (
    options.write &&
    !verifyCsrfToken(dependencies.csrfSigningKey, session.sessionTokenHash, request.headers["x-csrf-token"])
  ) {
    return { ok: false, statusCode: 403, code: "csrf_invalid" };
  }
  return { ok: true, session };
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WalletError) {
    // Foreign/missing share the uniform not-found boundary; owned-but-unavailable
    // and stale revision are the only 409 surfaces.
    if (error.code === "FORBIDDEN") return reply.code(404).send(errorBody("not_found"));
    if (error.code === "QUOTE_UNAVAILABLE") return reply.code(409).send(errorBody("quote_unavailable"));
    if (error.code === "REVISION_CONFLICT") return reply.code(409).send(errorBody("revision_conflict"));
    return reply.code(400).send(errorBody("invalid_request"));
  }
  return reply.code(503).send(errorBody("wallet_unavailable"));
}

function exactKeys(body: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (required.some((key) => !(key in value))) return null;
  return value;
}

function parseServiceId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parsePeriod(raw: unknown): BillingPeriod | null {
  return typeof raw === "string" && (BILLING_PERIODS as readonly string[]).includes(raw)
    ? (raw as BillingPeriod)
    : null;
}

/** Uniform owner check: the service row must exist and resolve through its
    payment→order join to the session user, regardless of its status. */
function ownsService(database: DatabaseConnection, serviceId: number, userId: number): boolean {
  const rows = database
    .prepare(
      `SELECT o.user_id FROM services s
       JOIN payments p ON p.id = s.payment_id JOIN orders o ON o.id = p.order_id
       WHERE s.id = ?`,
    )
    .all(serviceId) as Array<{ readonly user_id: number | null }>;
  return rows.length === 1 && rows[0] !== undefined && rows[0].user_id === userId;
}

export function registerWalletHttpRoutes(app: FastifyInstance, dependencies: WalletHttpDependencies): void {
  const routeOptions = {
    bodyLimit: WALLET_BODY_LIMIT_BYTES,
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => setNoStore(reply),
  };

  app.get("/api/me/wallet", routeOptions, async (request, reply) => {
    const gate = authorize(request, dependencies, { write: false });
    if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
    try {
      return await reply.send({ balanceFen: walletBalance(dependencies.database, gate.session.principal.userId), currency: "CNY" });
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    "/api/me/services/:id/renewal-quote",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: false });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const serviceId = parseServiceId(request.params.id);
      const period = parsePeriod(request.query.period);
      if (serviceId === null || period === null) return reply.code(404).send(errorBody("not_found"));
      try {
        if (!ownsService(dependencies.database, serviceId, gate.session.principal.userId)) {
          return reply.code(404).send(errorBody("not_found"));
        }
        const quote = produceRenewalQuote(dependencies.database, serviceId, period, gate.session.principal.userId);
        return await reply.send({
          quote: {
            key: quote.key, priceFen: quote.priceFen, currency: "CNY",
            durationId: quote.durationId, period: quote.period,
            previousEndsAt: quote.previousEndsAt, newEndsAt: quote.newEndsAt,
          },
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/me/services/:id/renewal-consent",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: false });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const serviceId = parseServiceId(request.params.id);
      if (serviceId === null) return reply.code(404).send(errorBody("not_found"));
      try {
        const consent = readRenewalConsent(dependencies.database, serviceId, gate.session.principal.userId);
        if (consent === null) return reply.code(404).send(errorBody("not_found"));
        return await reply.send({
          consent: {
            state: consent.state, revision: consent.revision, period: consent.period,
            priceFen: consent.priceFen, durationId: consent.durationId, updatedAt: consent.updatedAt,
          },
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/me/services/:id/renewal-consent",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const serviceId = parseServiceId(request.params.id);
      if (serviceId === null) return reply.code(404).send(errorBody("not_found"));
      const body = exactKeys(request.body, ["period", "expectedRevision", "enabled"]);
      const period = body === null ? null : parsePeriod(body.period);
      if (
        body === null || period === null ||
        !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 ||
        typeof body.enabled !== "boolean"
      ) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        if (!ownsService(dependencies.database, serviceId, gate.session.principal.userId)) {
          return reply.code(404).send(errorBody("not_found"));
        }
        const at = (dependencies.now?.() ?? new Date()).toISOString();
        const revision = setRenewalConsent(
          dependencies.database, serviceId, gate.session.principal.userId, period,
          body.expectedRevision as number, body.enabled as boolean, at,
        );
        return await reply.send({ revision });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}

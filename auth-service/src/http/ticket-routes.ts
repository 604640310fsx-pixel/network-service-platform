import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import { readPaymentSession, type PaymentSession } from "../payment/http-auth.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  closeTicketAsAdmin,
  createTicket,
  getOwnTicket,
  getTicketForAdmin,
  listOwnTickets,
  listTicketsForAdmin,
  normalizeTicketBody,
  normalizeTicketSubject,
  parseTicketPage,
  replyAsAdmin,
  replyAsCustomer,
  TicketDomainError,
  type TicketStatus,
} from "../tickets/tickets.js";
import { verifyCsrfToken } from "./csrf.js";

const TICKET_BODY_LIMIT_BYTES = 32 * 1024;
const ORDER_REF_PATTERN = /^DL[A-Za-z0-9]{8,64}$/;

export interface TicketHttpDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly csrfSigningKey: Buffer;
  readonly now?: () => Date;
  readonly randomRef?: () => Buffer;
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
  dependencies: TicketHttpDependencies,
  options: { readonly admin: boolean; readonly write: boolean },
): Gate {
  let session: PaymentSession | null;
  try {
    session = readPaymentSession(request, dependencies);
  } catch {
    return { ok: false, statusCode: 503, code: "tickets_unavailable" };
  }
  if (session === null) return { ok: false, statusCode: 401, code: "unauthorized" };
  if (options.admin && session.principal.role !== "admin") {
    return { ok: false, statusCode: 403, code: "forbidden" };
  }
  if (
    options.write &&
    !verifyCsrfToken(dependencies.csrfSigningKey, session.sessionTokenHash, request.headers["x-csrf-token"])
  ) {
    return { ok: false, statusCode: 403, code: "csrf_invalid" };
  }
  return { ok: true, session };
}

function exactKeys(body: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (required.some((key) => !(key in value))) return null;
  return value;
}

function onlyQueryKeys(query: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (typeof query !== "object" || query === null || Array.isArray(query)) return null;
  const value = query as Record<string, unknown>;
  return Object.keys(value).every((key) => allowed.includes(key)) ? value : null;
}

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TicketDomainError) {
    return reply.code(error.statusCode).send(errorBody(error.code));
  }
  return reply.code(503).send(errorBody("tickets_unavailable"));
}

const routeOptions = {
  bodyLimit: TICKET_BODY_LIMIT_BYTES,
  onRequest: async (_request: FastifyRequest, reply: FastifyReply) => setNoStore(reply),
  // 解析/体积错误统一成 invalid_request，不暴露框架细节。
  errorHandler: async (_error: unknown, _request: FastifyRequest, reply: FastifyReply) =>
    reply.code(400).send(errorBody("invalid_request")),
};

export function registerTicketHttpRoutes(app: FastifyInstance, dependencies: TicketHttpDependencies): void {
  const { database } = dependencies;

  // ---------- customer ----------
  app.post<{ Body: unknown }>("/api/me/tickets", routeOptions, async (request, reply) => {
    const gate = authorize(request, dependencies, { admin: false, write: true });
    if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
    const body = exactKeys(request.body, ["subject", "body"], ["serviceOrderRef"]);
    const subject = normalizeTicketSubject(body?.subject);
    const message = normalizeTicketBody(body?.body);
    const serviceOrderRef = body?.serviceOrderRef ?? null;
    if (
      body === null ||
      subject === null ||
      message === null ||
      (serviceOrderRef !== null && (typeof serviceOrderRef !== "string" || !ORDER_REF_PATTERN.test(serviceOrderRef)))
    ) {
      return reply.code(400).send(errorBody("invalid_request"));
    }
    try {
      const ticket = createTicket(database, {
        userId: gate.session.principal.userId,
        subject,
        body: message,
        serviceOrderRef: serviceOrderRef as string | null,
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.randomRef ? { randomRef: dependencies.randomRef } : {}),
      });
      return reply.code(200).send({ ticket });
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get("/api/me/tickets", routeOptions, async (request, reply) => {
    const gate = authorize(request, dependencies, { admin: false, write: false });
    if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
    const query = onlyQueryKeys(request.query, ["page"]);
    const pageNumber = query === null ? null : parseTicketPage(query.page);
    if (pageNumber === null) return reply.code(400).send(errorBody("invalid_request"));
    try {
      return reply.code(200).send(listOwnTickets(database, gate.session.principal.userId, pageNumber));
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get<{ Params: { ref: string } }>("/api/me/tickets/:ref", routeOptions, async (request, reply) => {
    const gate = authorize(request, dependencies, { admin: false, write: false });
    if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
    try {
      return reply.code(200).send({ ticket: getOwnTicket(database, gate.session.principal.userId, request.params.ref) });
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post<{ Params: { ref: string }; Body: unknown }>(
    "/api/me/tickets/:ref/messages",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { admin: false, write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const message = normalizeTicketBody(exactKeys(request.body, ["body"])?.body);
      if (message === null) return reply.code(400).send(errorBody("invalid_request"));
      try {
        const ticket = replyAsCustomer(database, {
          userId: gate.session.principal.userId,
          ref: request.params.ref,
          body: message,
          ...(dependencies.now ? { now: dependencies.now } : {}),
        });
        return reply.code(200).send({ ticket });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  // ---------- admin ----------
  app.get("/api/admin/tickets", routeOptions, async (request, reply) => {
    const gate = authorize(request, dependencies, { admin: true, write: false });
    if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
    const query = onlyQueryKeys(request.query, ["status", "page"]);
    const filter = query?.status ?? "all";
    const pageNumber = query === null ? null : parseTicketPage(query.page);
    if (
      pageNumber === null ||
      (filter !== "all" && filter !== "open" && filter !== "answered" && filter !== "closed")
    ) {
      return reply.code(400).send(errorBody("invalid_request"));
    }
    try {
      return reply.code(200).send(listTicketsForAdmin(database, filter as TicketStatus | "all", pageNumber));
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.get<{ Params: { ref: string } }>("/api/admin/tickets/:ref", routeOptions, async (request, reply) => {
    const gate = authorize(request, dependencies, { admin: true, write: false });
    if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
    try {
      return reply.code(200).send({ ticket: getTicketForAdmin(database, request.params.ref) });
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.post<{ Params: { ref: string }; Body: unknown }>(
    "/api/admin/tickets/:ref/messages",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { admin: true, write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const message = normalizeTicketBody(exactKeys(request.body, ["body"])?.body);
      if (message === null) return reply.code(400).send(errorBody("invalid_request"));
      try {
        const ticket = replyAsAdmin(database, {
          adminUserId: gate.session.principal.userId,
          adminEmail: gate.session.principal.email,
          ref: request.params.ref,
          body: message,
          ...(dependencies.now ? { now: dependencies.now } : {}),
        });
        return reply.code(200).send({ ticket });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { ref: string }; Body: unknown }>(
    "/api/admin/tickets/:ref/status",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { admin: true, write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      // MVP 只允许管理员关闭；open/answered 由回复驱动，关闭后不可重开。
      if (exactKeys(request.body, ["status"])?.status !== "closed") {
        return reply.code(400).send(errorBody("invalid_status"));
      }
      try {
        const ticket = closeTicketAsAdmin(database, {
          adminUserId: gate.session.principal.userId,
          adminEmail: gate.session.principal.email,
          ref: request.params.ref,
          ...(dependencies.now ? { now: dependencies.now } : {}),
        });
        return reply.code(200).send({ ticket });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import { readPaymentSession, type PaymentSession } from "../payment/http-auth.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  loadStoredAttachment,
  prepareTicketAttachments,
  type PreparedAttachment,
} from "../tickets/attachments.js";
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
import {
  consumeTicketAttachmentWriteRateLimit,
  RateLimitExceededError,
  type RateLimitKeyring,
} from "./rate-limit.js";

const TICKET_BODY_LIMIT_BYTES = 32 * 1024;
const TICKET_ATTACHMENT_BODY_LIMIT_BYTES = 21 * 1024 * 1024;
const ORDER_REF_PATTERN = /^DL[A-Za-z0-9]{8,64}$/;

export interface TicketHttpDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly rateLimitKeyring: RateLimitKeyring;
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
  if (error instanceof RateLimitExceededError) {
    return reply.code(429).send(errorBody("rate_limited"));
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

interface EarlyGatedRequest extends FastifyRequest {
  ticketWriteGate?: Gate;
}

function parsePositiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sendAttachmentBytes(reply: FastifyReply, stored: { contentType: string; content: Buffer }): FastifyReply {
  return reply
    .header("Content-Type", stored.contentType)
    .header("X-Content-Type-Options", "nosniff")
    .header("Cache-Control", "private, no-store")
    .send(stored.content);
}

export function registerTicketHttpRoutes(app: FastifyInstance, dependencies: TicketHttpDependencies): void {
  const { database } = dependencies;

  /* 可选附件的两条写路由放开到 21MiB，并在 preParsing（JSON 解析前）先完成
     会话与 CSRF 校验；未通过即返回，不读取大体积 body。其余路由保持 32KiB。 */
  const attachmentWriteOptions = {
    ...routeOptions,
    bodyLimit: TICKET_ATTACHMENT_BODY_LIMIT_BYTES,
    preParsing: async (request: FastifyRequest, reply: FastifyReply) => {
      const gate = authorize(request, dependencies, { admin: false, write: true });
      if (!gate.ok) {
        return reply.code(gate.statusCode).send(errorBody(gate.code));
      }
      (request as EarlyGatedRequest).ticketWriteGate = gate;
      return undefined;
    },
  };

  const writeGate = (request: FastifyRequest): Gate =>
    (request as EarlyGatedRequest).ticketWriteGate ?? authorize(request, dependencies, { admin: false, write: true });

  const consumeAttachmentWriteLimit = (userId: number): void =>
    consumeTicketAttachmentWriteRateLimit(
      database,
      dependencies.rateLimitKeyring,
      userId,
      dependencies.now ? { now: dependencies.now } : {},
    );

  // ---------- customer ----------
  app.post<{ Body: unknown }>("/api/me/tickets", attachmentWriteOptions, async (request, reply) => {
    const gate = writeGate(request);
    if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
    const body = exactKeys(request.body, ["subject", "body"], ["serviceOrderRef", "serviceGrantId", "attachments"]);
    const subject = normalizeTicketSubject(body?.subject);
    const message = normalizeTicketBody(body?.body);
    const serviceOrderRef = body?.serviceOrderRef ?? null;
    const rawGrantId = body?.serviceGrantId;
    const serviceGrantId = rawGrantId === undefined || rawGrantId === null ? null : parsePositiveId(rawGrantId);
    if (
      body === null ||
      subject === null ||
      message === null ||
      (serviceOrderRef !== null && (typeof serviceOrderRef !== "string" || !ORDER_REF_PATTERN.test(serviceOrderRef))) ||
      (rawGrantId !== undefined && rawGrantId !== null && serviceGrantId === null)
    ) {
      return reply.code(400).send(errorBody("invalid_request"));
    }
    try {
      // 只要带了 attachments 键就先计入每分钟上限再逐张校验：形状非法的大体积
      // 附件请求不能绕过限流；纯文本（无附件键）不计数。
      if (body.attachments !== undefined) consumeAttachmentWriteLimit(gate.session.principal.userId);
      const attachments = body.attachments === undefined ? [] : prepareTicketAttachments(body.attachments);
      const ticket = createTicket(database, {
        userId: gate.session.principal.userId,
        subject,
        body: message,
        serviceOrderRef: serviceOrderRef as string | null,
        serviceGrantId,
        attachments,
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
    attachmentWriteOptions,
    async (request, reply) => {
      const gate = writeGate(request);
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const body = exactKeys(request.body, ["body"], ["attachments"]);
      const message = normalizeTicketBody(body?.body);
      if (body === null || message === null) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        if (body.attachments !== undefined) consumeAttachmentWriteLimit(gate.session.principal.userId);
        const attachments = body.attachments === undefined ? [] : prepareTicketAttachments(body.attachments);
        const ticket = replyAsCustomer(database, {
          userId: gate.session.principal.userId,
          ref: request.params.ref,
          body: message,
          attachments,
          ...(dependencies.now ? { now: dependencies.now } : {}),
          ...(dependencies.randomRef ? { randomRef: dependencies.randomRef } : {}),
        });
        return reply.code(200).send({ ticket });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { ref: string; attachmentRef: string } }>(
    "/api/me/tickets/:ref/attachments/:attachmentRef",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { admin: false, write: false });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      try {
        const stored = loadStoredAttachment(database, {
          ticketRef: request.params.ref,
          attachmentRef: request.params.attachmentRef,
          ownerUserId: gate.session.principal.userId,
        });
        if (stored === null) return reply.code(404).send(errorBody("not_found"));
        return sendAttachmentBytes(reply, stored);
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

  app.get<{ Params: { ref: string; attachmentRef: string } }>(
    "/api/admin/tickets/:ref/attachments/:attachmentRef",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { admin: true, write: false });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      try {
        const stored = loadStoredAttachment(database, {
          ticketRef: request.params.ref,
          attachmentRef: request.params.attachmentRef,
        });
        if (stored === null) return reply.code(404).send(errorBody("not_found"));
        return sendAttachmentBytes(reply, stored);
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

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

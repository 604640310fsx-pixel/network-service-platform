import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { DatabaseConnection } from "../db.js";
import { verifyCsrfToken } from "./csrf.js";
import { readPaymentSession } from "../payment/http-auth.js";
import {
  createAdminInviteCode,
  InviteAdminDomainError,
  listAdminInviteCodes,
  revokeAdminInviteCode,
  type InviteAdminServiceDependencies,
} from "../registration/invite-admin-service.js";
import type { InviteHmacKeyring } from "../registration/invite-code.js";
import type { TokenHmacKeyring } from "../session/session-token.js";

interface ErrorBody {
  readonly error: { readonly code: string };
}

interface AdminIdentity {
  readonly userId: number;
  readonly sessionTokenHash: string;
}

type AdminAuthOutcome =
  | { readonly ok: true; readonly admin: AdminIdentity }
  | {
      readonly ok: false;
      readonly statusCode: 401 | 403 | 503;
      readonly code: string;
    };

export interface InviteAdminHttpDependencies
  extends InviteAdminServiceDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly inviteHmacKeyring: InviteHmacKeyring;
  readonly mailPayloadEncKeyring: TokenHmacKeyring;
  readonly csrfSigningKey: Buffer;
}

function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

function authorizeAdmin(
  request: FastifyRequest,
  dependencies: InviteAdminHttpDependencies,
): AdminAuthOutcome {
  let session;
  try {
    session = readPaymentSession(request, dependencies);
  } catch {
    return {
      ok: false,
      statusCode: 503,
      code: "invite_unavailable",
    };
  }
  if (session === null) {
    return { ok: false, statusCode: 401, code: "unauthorized" };
  }
  if (session.principal.role !== "admin") {
    return { ok: false, statusCode: 403, code: "forbidden" };
  }
  return {
    ok: true,
    admin: {
      userId: session.principal.userId,
      sessionTokenHash: session.sessionTokenHash,
    },
  };
}

function verifyAdminCsrf(
  request: FastifyRequest,
  dependencies: InviteAdminHttpDependencies,
  sessionTokenHash: string,
): boolean {
  return verifyCsrfToken(
    dependencies.csrfSigningKey,
    sessionTokenHash,
    request.headers["x-csrf-token"],
  );
}

function parseCreateBody(
  body: unknown,
): { readonly recipientEmail: string; readonly expiresAt: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => key !== "recipientEmail" && key !== "expiresAt",
    ) ||
    typeof value.recipientEmail !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return null;
  }
  return {
    recipientEmail: value.recipientEmail,
    expiresAt: value.expiresAt,
  };
}

function parseInviteCodeId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const inviteCodeId = Number(value);
  return Number.isSafeInteger(inviteCodeId) ? inviteCodeId : null;
}

function domainErrorReply(
  error: unknown,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof InviteAdminDomainError) {
    return reply.code(error.statusCode).send(errorBody(error.code));
  }
  return reply.code(503).send(errorBody("invite_unavailable"));
}

export function registerInviteAdminHttpRoutes(
  app: FastifyInstance,
  dependencies: InviteAdminHttpDependencies,
): void {
  app.get("/api/admin/invite-codes", async (request, reply) => {
    setNoStore(reply);
    const auth = authorizeAdmin(request, dependencies);
    if (!auth.ok) {
      return reply.code(auth.statusCode).send(errorBody(auth.code));
    }
    try {
      return reply
        .code(200)
        .send(listAdminInviteCodes(dependencies.database, dependencies));
    } catch (error) {
      return domainErrorReply(error, reply);
    }
  });

  app.post<{ Body: unknown }>(
    "/api/admin/invite-codes",
    async (request, reply) => {
      setNoStore(reply);
      const auth = authorizeAdmin(request, dependencies);
      if (!auth.ok) {
        return reply.code(auth.statusCode).send(errorBody(auth.code));
      }
      if (
        !verifyAdminCsrf(
          request,
          dependencies,
          auth.admin.sessionTokenHash,
        )
      ) {
        return reply.code(403).send(errorBody("csrf_invalid"));
      }
      const input = parseCreateBody(request.body);
      if (input === null) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        const created = createAdminInviteCode(
          dependencies.database,
          dependencies.inviteHmacKeyring,
          dependencies.mailPayloadEncKeyring,
          {
            adminUserId: auth.admin.userId,
            ...input,
          },
          dependencies,
        );
        return reply.code(201).send(created);
      } catch (error) {
        return domainErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/invite-codes/:id/revoke",
    async (request, reply) => {
      setNoStore(reply);
      const auth = authorizeAdmin(request, dependencies);
      if (!auth.ok) {
        return reply.code(auth.statusCode).send(errorBody(auth.code));
      }
      if (
        !verifyAdminCsrf(
          request,
          dependencies,
          auth.admin.sessionTokenHash,
        )
      ) {
        return reply.code(403).send(errorBody("csrf_invalid"));
      }
      const inviteCodeId = parseInviteCodeId(request.params.id);
      if (inviteCodeId === null) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        const item = revokeAdminInviteCode(
          dependencies.database,
          dependencies.mailPayloadEncKeyring,
          {
            adminUserId: auth.admin.userId,
            inviteCodeId,
          },
          dependencies,
        );
        return reply.code(200).send({ item });
      } catch (error) {
        return domainErrorReply(error, reply);
      }
    },
  );
}

import type { FastifyInstance, FastifyReply } from "fastify";

import { authorizeAdminSession, verifyAdminCsrf } from "./admin-routes.js";
import type { PaymentHttpDependencies } from "./payment-routes.js";
import { PaymentDomainError } from "../payment/commerce.js";
import {
  createGrantForAdmin,
  listUserServicesForAdmin,
  parseEndsAt,
  parseLabel,
  parseNote,
  searchUsersForAdmin,
  updateGrantForAdmin,
  updateServiceForAdmin,
  type GrantPatch,
  type ServicePatch,
} from "../payment/admin-services.js";

/* 管理员管理买家服务（Migration 022）。全部路由：会话 + role=admin（401/403），
   写操作再校验 CSRF（403 csrf_invalid）；请求体只接受列出的键，任何未知键或
   类型错误一律 400，不静默忽略。 */

function errorResponse(code: string): { readonly error: { readonly code: string } } {
  return { error: { code } };
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

function positiveId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function plainObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => allowed.has(key));
}

const SERVICE_PATCH_KEYS = new Set(["endsAt", "planLabel", "note"]);
const GRANT_CREATE_KEYS = new Set(["userId", "label", "endsAt", "reason"]);
const GRANT_PATCH_KEYS = new Set(["endsAt", "label", "status"]);

export function parseServicePatch(body: unknown): ServicePatch | null {
  const value = plainObject(body);
  if (value === null || !onlyKeys(value, SERVICE_PATCH_KEYS)) return null;
  const patch: { endsAt?: string | null; planLabel?: string | null; note?: string | null } = {};
  if ("endsAt" in value) {
    const parsed = parseEndsAt(value.endsAt);
    if (!parsed.ok) return null;
    patch.endsAt = parsed.value;
  }
  if ("planLabel" in value) {
    if (value.planLabel === null) {
      patch.planLabel = null;
    } else {
      const parsed = parseLabel(value.planLabel);
      if (!parsed.ok) return null;
      patch.planLabel = parsed.value;
    }
  }
  if ("note" in value) {
    const parsed = parseNote(value.note);
    if (!parsed.ok) return null;
    patch.note = parsed.value;
  }
  return patch;
}

export function parseGrantCreate(
  body: unknown,
): { readonly userId: number; readonly label: string; readonly endsAt: string | null; readonly reason: string | null } | null {
  const value = plainObject(body);
  if (value === null || !Object.keys(value).every((key) => GRANT_CREATE_KEYS.has(key))) return null;
  if (typeof value.userId !== "number" || !Number.isSafeInteger(value.userId) || value.userId <= 0) return null;
  const label = parseLabel(value.label);
  if (!label.ok) return null;
  const endsAt = value.endsAt === undefined ? ({ ok: true, value: null } as const) : parseEndsAt(value.endsAt);
  if (!endsAt.ok) return null;
  const reason = value.reason === undefined ? ({ ok: true, value: null } as const) : parseNote(value.reason);
  if (!reason.ok) return null;
  return { userId: value.userId, label: label.value, endsAt: endsAt.value, reason: reason.value };
}

export function parseGrantPatch(body: unknown): GrantPatch | null {
  const value = plainObject(body);
  if (value === null || !onlyKeys(value, GRANT_PATCH_KEYS)) return null;
  const patch: { endsAt?: string | null; label?: string; status?: "revoked" } = {};
  if ("endsAt" in value) {
    const parsed = parseEndsAt(value.endsAt);
    if (!parsed.ok) return null;
    patch.endsAt = parsed.value;
  }
  if ("label" in value) {
    const parsed = parseLabel(value.label);
    if (!parsed.ok) return null;
    patch.label = parsed.value;
  }
  if ("status" in value) {
    if (value.status !== "revoked") return null;
    patch.status = "revoked";
  }
  return patch;
}

export function registerAdminServiceHttpRoutes(
  app: FastifyInstance,
  dependencies: PaymentHttpDependencies,
): void {
  function sendDomainError(reply: FastifyReply, error: unknown) {
    if (error instanceof PaymentDomainError) {
      return reply.code(error.statusCode).send(errorResponse(error.code));
    }
    return reply.code(503).send(errorResponse("payment_unavailable"));
  }

  app.get<{ Querystring: { q?: string } }>("/api/admin/users", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) return reply.code(503).send(errorResponse("payment_unavailable"));
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) return reply.code(auth.statusCode).send(errorResponse(auth.code));
    const query = request.query.q;
    if (typeof query !== "string") return reply.code(400).send(errorResponse("invalid_query"));
    try {
      return reply.code(200).send({ items: searchUsersForAdmin(dependencies.database, query) });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/admin/users/:id/services", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) return reply.code(503).send(errorResponse("payment_unavailable"));
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) return reply.code(auth.statusCode).send(errorResponse(auth.code));
    const userId = positiveId(request.params.id);
    if (userId === null) return reply.code(404).send(errorResponse("not_found"));
    try {
      return reply.code(200).send(listUserServicesForAdmin(dependencies.database, userId));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/admin/services/:id", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) return reply.code(503).send(errorResponse("payment_unavailable"));
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) return reply.code(auth.statusCode).send(errorResponse(auth.code));
    if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
      return reply.code(403).send(errorResponse("csrf_invalid"));
    }
    const serviceId = positiveId(request.params.id);
    if (serviceId === null) return reply.code(404).send(errorResponse("not_found"));
    const patch = parseServicePatch(request.body);
    if (patch === null) return reply.code(400).send(errorResponse("invalid_service_patch"));
    try {
      return reply.code(200).send(
        updateServiceForAdmin(dependencies.database, {
          serviceId,
          patch,
          adminEmail: auth.admin.email,
          now: dependencies.now,
        }),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/admin/grants", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) return reply.code(503).send(errorResponse("payment_unavailable"));
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) return reply.code(auth.statusCode).send(errorResponse(auth.code));
    if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
      return reply.code(403).send(errorResponse("csrf_invalid"));
    }
    const body = parseGrantCreate(request.body);
    if (body === null) return reply.code(400).send(errorResponse("invalid_grant"));
    try {
      return reply.code(200).send(
        createGrantForAdmin(dependencies.database, {
          ...body,
          adminUserId: auth.admin.userId,
          adminEmail: auth.admin.email,
          now: dependencies.now,
        }),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/admin/grants/:id", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) return reply.code(503).send(errorResponse("payment_unavailable"));
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) return reply.code(auth.statusCode).send(errorResponse(auth.code));
    if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
      return reply.code(403).send(errorResponse("csrf_invalid"));
    }
    const grantId = positiveId(request.params.id);
    if (grantId === null) return reply.code(404).send(errorResponse("not_found"));
    const patch = parseGrantPatch(request.body);
    if (patch === null) return reply.code(400).send(errorResponse("invalid_grant_patch"));
    try {
      return reply.code(200).send(
        updateGrantForAdmin(dependencies.database, {
          grantId,
          patch,
          adminEmail: auth.admin.email,
          now: dependencies.now,
        }),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}

import type { FastifyInstance, FastifyReply } from "fastify";

import { authorizeAdminSession, verifyAdminCsrf } from "./admin-routes.js";
import type { PaymentHttpDependencies } from "./payment-routes.js";
import { PaymentDomainError } from "../payment/commerce.js";
import {
  DELIVERY_MAX_ITEMS,
  encryptGrantDeliveryItem,
  normalizeGrantDeliveryInput,
  type GrantDeliveryInput,
} from "../payment/delivery-crypto.js";
import { normalizeMonitorTargetKey } from "../monitor/target-catalog.js";
import {
  bindServiceDeliveryForAdmin,
  createGrantForAdmin,
  listUserServicesForAdmin,
  openGrantForAdmin,
  parseEndsAt,
  parseLabel,
  parseNote,
  searchUsersForAdmin,
  updateGrantForAdmin,
  updateServiceForAdmin,
  type GrantPatch,
  type GrantPlanSelection,
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
const GRANT_CREATE_KEYS = new Set([
  "userId", "typeId", "regionId", "ispId", "specId", "durationId", "months", "valueFen", "label", "endsAt", "reason",
]);
const GRANT_PATCH_KEYS = new Set([
  "endsAt", "label", "status", "typeId", "regionId", "ispId", "specId", "durationId", "months", "valueFen",
]);
const CATALOG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_GRANT_MONTHS = 120;
const MAX_GRANT_VALUE_FEN = 100_000_000;

function catalogId(value: unknown): string | null {
  return typeof value === "string" && CATALOG_ID.test(value) ? value : null;
}

/** typeId/regionId/ispId/durationId required, specId optional (null when absent); shape only —
    the domain layer checks the combination against sellable_plans. */
function parseSelection(value: Record<string, unknown>): GrantPlanSelection | null {
  const typeId = catalogId(value.typeId);
  const regionId = catalogId(value.regionId);
  const ispId = catalogId(value.ispId);
  const durationId = catalogId(value.durationId);
  const specId = value.specId === undefined || value.specId === null ? null : catalogId(value.specId);
  if (typeId === null || regionId === null || ispId === null || durationId === null) return null;
  if (value.specId !== undefined && value.specId !== null && specId === null) return null;
  return { typeId, regionId, ispId, specId, durationId };
}

function parseMonths(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_GRANT_MONTHS ? value : null;
}

function parseValueFen(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_GRANT_VALUE_FEN ? value : null;
}

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

export function parseGrantCreate(body: unknown): {
  readonly userId: number;
  readonly selection: GrantPlanSelection;
  readonly months: number;
  readonly valueFen: number;
  readonly label: string | null;
  readonly endsAt: string | null;
  readonly reason: string | null;
} | null {
  const value = plainObject(body);
  if (value === null || !Object.keys(value).every((key) => GRANT_CREATE_KEYS.has(key))) return null;
  if (typeof value.userId !== "number" || !Number.isSafeInteger(value.userId) || value.userId <= 0) return null;
  const selection = parseSelection(value);
  const months = parseMonths(value.months);
  const valueFen = parseValueFen(value.valueFen);
  if (selection === null || months === null || valueFen === null) return null;
  let label: string | null = null;
  if (value.label !== undefined && value.label !== null && !(typeof value.label === "string" && value.label.trim() === "")) {
    const parsed = parseLabel(value.label);
    if (!parsed.ok) return null;
    label = parsed.value;
  }
  const endsAt = value.endsAt === undefined ? ({ ok: true, value: null } as const) : parseEndsAt(value.endsAt);
  if (!endsAt.ok) return null;
  const reason = value.reason === undefined ? ({ ok: true, value: null } as const) : parseNote(value.reason);
  if (!reason.ok) return null;
  return { userId: value.userId, selection, months, valueFen, label, endsAt: endsAt.value, reason: reason.value };
}

export function parseGrantPatch(body: unknown): GrantPatch | null {
  const value = plainObject(body);
  if (value === null || !onlyKeys(value, GRANT_PATCH_KEYS)) return null;
  const patch: {
    endsAt?: string | null; label?: string; status?: "revoked";
    selection?: GrantPlanSelection; months?: number; valueFen?: number;
  } = {};
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
  const catalogKeys = ["typeId", "regionId", "ispId", "specId", "durationId"].filter((key) => key in value);
  if (catalogKeys.length > 0) {
    // The catalog selection is replaced as a whole (specId may be omitted for plans without one).
    const selection = parseSelection(value);
    if (selection === null) return null;
    patch.selection = selection;
  }
  if ("months" in value) {
    const months = parseMonths(value.months);
    if (months === null) return null;
    patch.months = months;
  }
  if ("valueFen" in value) {
    const valueFen = parseValueFen(value.valueFen);
    if (valueFen === null) return null;
    patch.valueFen = valueFen;
  }
  return patch;
}

export function parseGrantOpenItems(body: unknown): readonly GrantDeliveryInput[] | null {
  const value = plainObject(body);
  if (value === null || !onlyKeys(value, new Set(["items"]))) return null;
  const raw = value.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > DELIVERY_MAX_ITEMS) return null;
  const items: GrantDeliveryInput[] = [];
  for (const entry of raw) {
    const entryObject = plainObject(entry);
    if (entryObject === null || !Object.keys(entryObject).every((key) => key === "label" || key === "subscriptionUrl")) return null;
    const item = normalizeGrantDeliveryInput(entryObject);
    if (item === null) return null;
    items.push(item);
  }
  return items;
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

  app.post<{ Params: { id: string }; Body: unknown }>("/api/admin/grants/:id/open", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) return reply.code(503).send(errorResponse("payment_unavailable"));
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) return reply.code(auth.statusCode).send(errorResponse(auth.code));
    if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
      return reply.code(403).send(errorResponse("csrf_invalid"));
    }
    const grantId = positiveId(request.params.id);
    if (grantId === null) return reply.code(404).send(errorResponse("not_found"));
    const items = parseGrantOpenItems(request.body);
    if (items === null) return reply.code(400).send(errorResponse("invalid_item"));
    try {
      const encrypted = items.map((item, index) =>
        encryptGrantDeliveryItem({ grantId, position: index + 1, item }, dependencies.deliveryEncKeyring),
      );
      return reply.code(200).send(
        openGrantForAdmin(dependencies.database, { grantId, items: encrypted, adminEmail: auth.admin.email, now: dependencies.now }),
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  /* 事后补绑：监控目录必须可用且目标在用（与开通同一判定），否则 503 / 400。 */
  app.patch<{ Params: { id: string; position: string }; Body: unknown }>(
    "/api/admin/services/:id/delivery/:position",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) return reply.code(503).send(errorResponse("payment_unavailable"));
      const auth = authorizeAdminSession(request, dependencies);
      if (!auth.ok) return reply.code(auth.statusCode).send(errorResponse(auth.code));
      if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
        return reply.code(403).send(errorResponse("csrf_invalid"));
      }
      const serviceId = positiveId(request.params.id);
      const position = positiveId(request.params.position);
      if (serviceId === null || position === null) return reply.code(404).send(errorResponse("not_found"));
      const body = plainObject(request.body);
      const monitorTargetKey = body !== null && onlyKeys(body, new Set(["monitorTargetKey"]))
        ? normalizeMonitorTargetKey(body.monitorTargetKey)
        : null;
      if (monitorTargetKey === null) return reply.code(400).send(errorResponse("invalid_monitor_target"));
      if (dependencies.monitorTargetCatalog === null) return reply.code(503).send(errorResponse("monitor_unavailable"));
      let active: boolean;
      try {
        active = (await dependencies.monitorTargetCatalog.list()).some(
          (target) => target.key === monitorTargetKey && target.state === "active",
        );
      } catch {
        return reply.code(503).send(errorResponse("monitor_unavailable"));
      }
      if (!active) return reply.code(400).send(errorResponse("invalid_monitor_target"));
      try {
        return reply.code(200).send(
          bindServiceDeliveryForAdmin(dependencies.database, {
            serviceId,
            position,
            monitorTargetKey,
            adminEmail: auth.admin.email,
            now: dependencies.now,
          }),
        );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );
}

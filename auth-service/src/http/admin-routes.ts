import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { verifyCsrfToken } from "./csrf.js";
import type { PaymentHttpDependencies } from "./payment-routes.js";
import {
  createCoupon,
  listCoupons,
  listCouponRedemptions,
  listSellablePlans,
  PaymentDomainError,
  updateCoupon,
  updateSellablePlan,
} from "../payment/commerce.js";
import { readPaymentSession } from "../payment/http-auth.js";
import {
  DELIVERY_MAX_ITEMS,
  encryptServiceDeliveryItem,
  normalizeServiceDeliveryInput,
  type ServiceDeliveryInput,
} from "../payment/delivery-crypto.js";
import { listPendingServicesForAdmin, openService } from "../payment/orders.js";

function errorResponse(code: string): { readonly error: { readonly code: string } } {
  return { error: { code } };
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

function stringHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

type ParsedOpenItems =
  | { readonly ok: true; readonly items: readonly ServiceDeliveryInput[] }
  | { readonly ok: false; readonly code: "items_required" | "invalid_item" };

function parseOpenItems(body: unknown): ParsedOpenItems {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "items_required" };
  }
  const rawItems = (body as Record<string, unknown>).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, code: "items_required" };
  }
  if (rawItems.length > DELIVERY_MAX_ITEMS) {
    return { ok: false, code: "invalid_item" };
  }
  const items: ServiceDeliveryInput[] = [];
  for (const rawItem of rawItems) {
    const item = normalizeServiceDeliveryInput(rawItem);
    if (item === null) {
      return { ok: false, code: "invalid_item" };
    }
    items.push(item);
  }
  return { ok: true, items };
}

type EnabledDependencies = Extract<PaymentHttpDependencies, { readonly enabled: true }>;

interface AdminIdentity {
  readonly userId: number;
  readonly email: string;
  readonly sessionTokenHash: string;
}

type AdminAuthOutcome =
  | { readonly ok: true; readonly admin: AdminIdentity }
  | { readonly ok: false; readonly statusCode: number; readonly code: string };

/* 六个新路由共用的会话 + role 校验（GET/POST/PATCH 一致）；写操作额外调用
   verifyAdminCsrf。与既有 /api/admin/services* 两个路由完全同一套判定，
   只是抽成函数避免六处重复内联。 */
function authorizeAdminSession(
  request: FastifyRequest,
  dependencies: EnabledDependencies,
): AdminAuthOutcome {
  let session;
  try {
    session = readPaymentSession(request, dependencies);
  } catch {
    return { ok: false, statusCode: 503, code: "payment_unavailable" };
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
      email: session.principal.email,
      sessionTokenHash: session.sessionTokenHash,
    },
  };
}

function verifyAdminCsrf(
  request: FastifyRequest,
  dependencies: EnabledDependencies,
  sessionTokenHash: string,
): boolean {
  const csrfToken = stringHeader(request.headers["x-csrf-token"]);
  return (
    csrfToken !== null &&
    verifyCsrfToken(dependencies.csrfSigningKey, sessionTokenHash, csrfToken)
  );
}

interface PlanPatchBody {
  readonly priceFen?: number;
  readonly isActive?: boolean;
  readonly totalSlots?: number | null;
}

function parsePlanPatchBody(body: unknown): PlanPatchBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  if (
    (value.priceFen !== undefined &&
      (typeof value.priceFen !== "number" || !Number.isSafeInteger(value.priceFen) || value.priceFen <= 0)) ||
    (value.isActive !== undefined && typeof value.isActive !== "boolean") ||
    (value.totalSlots !== undefined &&
      value.totalSlots !== null &&
      (typeof value.totalSlots !== "number" || !Number.isSafeInteger(value.totalSlots) || value.totalSlots < 0))
  ) {
    return null;
  }
  return {
    priceFen: typeof value.priceFen === "number" ? value.priceFen : undefined,
    isActive: typeof value.isActive === "boolean" ? value.isActive : undefined,
    totalSlots: value.totalSlots === undefined ? undefined : (value.totalSlots as number | null),
  };
}

interface CouponCreateBody {
  readonly code: string;
  readonly kind: "fixed" | "percent";
  readonly amountOffFen: number | null;
  readonly percentOff: number | null;
  readonly minAmountFen: number | null;
  readonly scope: "all" | "plans";
  readonly planIds: readonly number[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly maxRedemptions: number | null;
}

function parseCouponCreateBody(body: unknown): CouponCreateBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  if (
    typeof value.code !== "string" ||
    (value.kind !== "fixed" && value.kind !== "percent") ||
    (value.amountOffFen !== null && typeof value.amountOffFen !== "number") ||
    (value.percentOff !== null && typeof value.percentOff !== "number") ||
    (value.minAmountFen !== undefined &&
      value.minAmountFen !== null &&
      typeof value.minAmountFen !== "number") ||
    (value.scope !== "all" && value.scope !== "plans") ||
    (value.planIds !== undefined &&
      (!Array.isArray(value.planIds) || value.planIds.some((item) => typeof item !== "number"))) ||
    typeof value.startsAt !== "string" ||
    typeof value.endsAt !== "string" ||
    (value.maxRedemptions !== undefined &&
      value.maxRedemptions !== null &&
      typeof value.maxRedemptions !== "number")
  ) {
    return null;
  }
  return {
    code: value.code,
    kind: value.kind,
    amountOffFen: (value.amountOffFen as number | null) ?? null,
    percentOff: (value.percentOff as number | null) ?? null,
    minAmountFen: value.minAmountFen === undefined ? null : (value.minAmountFen as number | null),
    scope: value.scope,
    planIds: Array.isArray(value.planIds) ? (value.planIds as number[]) : [],
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    maxRedemptions:
      value.maxRedemptions === undefined ? null : (value.maxRedemptions as number | null),
  };
}

interface CouponPatchBody {
  readonly isActive?: boolean;
  readonly endsAt?: string;
  readonly maxRedemptions?: number | null;
}

const COUPON_PATCH_ALLOWED_KEYS = new Set(["isActive", "endsAt", "maxRedemptions"]);

function parseCouponPatchBody(body: unknown): CouponPatchBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  // 创建后只允许改这三个字段——出现任何其它键一律拒绝，不静默忽略。
  for (const key of Object.keys(value)) {
    if (!COUPON_PATCH_ALLOWED_KEYS.has(key)) {
      return null;
    }
  }
  if (
    (value.isActive !== undefined && typeof value.isActive !== "boolean") ||
    (value.endsAt !== undefined && typeof value.endsAt !== "string") ||
    (value.maxRedemptions !== undefined &&
      value.maxRedemptions !== null &&
      typeof value.maxRedemptions !== "number")
  ) {
    return null;
  }
  return {
    isActive: typeof value.isActive === "boolean" ? value.isActive : undefined,
    endsAt: typeof value.endsAt === "string" ? value.endsAt : undefined,
    maxRedemptions:
      value.maxRedemptions === undefined ? undefined : (value.maxRedemptions as number | null),
  };
}

export function registerPaymentAdminHttpRoutes(
  app: FastifyInstance,
  dependencies: PaymentHttpDependencies,
): void {
  app.get<{ Querystring: { status?: string } }>(
    "/api/admin/services",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      let session;
      try {
        session = readPaymentSession(request, dependencies);
      } catch {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      if (session === null) {
        return reply.code(401).send(errorResponse("unauthorized"));
      }
      if (session.principal.role !== "admin") {
        return reply.code(403).send(errorResponse("forbidden"));
      }
      if (request.query.status !== "pending_open") {
        return reply.code(400).send(errorResponse("invalid_status"));
      }
      try {
        return reply
          .code(200)
          .send({ items: listPendingServicesForAdmin(dependencies.database) });
      } catch {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/admin/services/:id/open",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      let session;
      try {
        session = readPaymentSession(request, dependencies);
      } catch {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      if (session === null) {
        return reply.code(401).send(errorResponse("unauthorized"));
      }
      if (session.principal.role !== "admin") {
        return reply.code(403).send(errorResponse("forbidden"));
      }
      const csrfToken = stringHeader(request.headers["x-csrf-token"]);
      if (
        csrfToken === null ||
        !verifyCsrfToken(
          dependencies.csrfSigningKey,
          session.sessionTokenHash,
          csrfToken,
        )
      ) {
        return reply.code(403).send(errorResponse("csrf_invalid"));
      }
      if (!/^[1-9][0-9]*$/.test(request.params.id)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      const serviceId = Number(request.params.id);
      if (!Number.isSafeInteger(serviceId)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      const parsedItems = parseOpenItems(request.body);
      if (!parsedItems.ok) {
        return reply.code(400).send(errorResponse(parsedItems.code));
      }
      try {
        const encryptedItems = parsedItems.items.map((item, index) =>
          encryptServiceDeliveryItem(
            { serviceId, position: index + 1, item },
            dependencies.deliveryEncKeyring,
          ),
        );
        return reply.code(200).send(
          openService(dependencies.database, {
            serviceId,
            adminUserId: session.principal.userId,
            adminEmail: session.principal.email,
            items: encryptedItems,
            now: dependencies.now,
          }),
        );
      } catch (error) {
        if (error instanceof PaymentDomainError) {
          return reply.code(error.statusCode).send(errorResponse(error.code));
        }
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
    },
  );

  app.get("/api/admin/plans", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) {
      return reply.code(auth.statusCode).send(errorResponse(auth.code));
    }
    try {
      return reply.code(200).send({ items: listSellablePlans(dependencies.database) });
    } catch {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/admin/plans/:id",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      const auth = authorizeAdminSession(request, dependencies);
      if (!auth.ok) {
        return reply.code(auth.statusCode).send(errorResponse(auth.code));
      }
      if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
        return reply.code(403).send(errorResponse("csrf_invalid"));
      }
      if (!/^[1-9][0-9]*$/.test(request.params.id)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      const planId = Number(request.params.id);
      if (!Number.isSafeInteger(planId)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      const patch = parsePlanPatchBody(request.body);
      if (patch === null) {
        return reply.code(400).send(errorResponse("invalid_plan_patch"));
      }
      try {
        const updated = updateSellablePlan(dependencies.database, {
          planId,
          priceFen: patch.priceFen,
          isActive: patch.isActive,
          totalSlots: patch.totalSlots,
          adminUserId: auth.admin.userId,
          now: dependencies.now ?? (() => new Date()),
        });
        return reply.code(200).send(updated);
      } catch (error) {
        if (error instanceof PaymentDomainError) {
          return reply.code(error.statusCode).send(errorResponse(error.code));
        }
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
    },
  );

  app.get("/api/admin/coupons", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) {
      return reply.code(auth.statusCode).send(errorResponse(auth.code));
    }
    try {
      return reply.code(200).send({ items: listCoupons(dependencies.database) });
    } catch {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
  });

  app.post<{ Body: unknown }>("/api/admin/coupons", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
    const auth = authorizeAdminSession(request, dependencies);
    if (!auth.ok) {
      return reply.code(auth.statusCode).send(errorResponse(auth.code));
    }
    if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
      return reply.code(403).send(errorResponse("csrf_invalid"));
    }
    const body = parseCouponCreateBody(request.body);
    if (body === null) {
      return reply.code(400).send(errorResponse("invalid_coupon"));
    }
    try {
      const created = createCoupon(dependencies.database, {
        code: body.code,
        kind: body.kind,
        amountOffFen: body.amountOffFen,
        percentOff: body.percentOff,
        minAmountFen: body.minAmountFen,
        scope: body.scope,
        planIds: body.planIds,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        maxRedemptions: body.maxRedemptions,
        adminUserId: auth.admin.userId,
        now: dependencies.now ?? (() => new Date()),
      });
      return reply.code(200).send(created);
    } catch (error) {
      if (error instanceof PaymentDomainError) {
        return reply.code(error.statusCode).send(errorResponse(error.code));
      }
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/admin/coupons/:id",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      const auth = authorizeAdminSession(request, dependencies);
      if (!auth.ok) {
        return reply.code(auth.statusCode).send(errorResponse(auth.code));
      }
      if (!verifyAdminCsrf(request, dependencies, auth.admin.sessionTokenHash)) {
        return reply.code(403).send(errorResponse("csrf_invalid"));
      }
      if (!/^[1-9][0-9]*$/.test(request.params.id)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      const couponId = Number(request.params.id);
      if (!Number.isSafeInteger(couponId)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      if (
        typeof request.body === "object" &&
        request.body !== null &&
        !Array.isArray(request.body) &&
        Object.keys(request.body as Record<string, unknown>).some(
          (key) => !COUPON_PATCH_ALLOWED_KEYS.has(key),
        )
      ) {
        return reply.code(400).send(errorResponse("immutable_field"));
      }
      const patch = parseCouponPatchBody(request.body);
      if (patch === null) {
        return reply.code(400).send(errorResponse("invalid_coupon_patch"));
      }
      try {
        const updated = updateCoupon(dependencies.database, {
          couponId,
          isActive: patch.isActive,
          endsAt: patch.endsAt,
          maxRedemptions: patch.maxRedemptions,
          now: dependencies.now ?? (() => new Date()),
        });
        return reply.code(200).send(updated);
      } catch (error) {
        if (error instanceof PaymentDomainError) {
          return reply.code(error.statusCode).send(errorResponse(error.code));
        }
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/coupons/:id/redemptions",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      const auth = authorizeAdminSession(request, dependencies);
      if (!auth.ok) {
        return reply.code(auth.statusCode).send(errorResponse(auth.code));
      }
      if (!/^[1-9][0-9]*$/.test(request.params.id)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      const couponId = Number(request.params.id);
      if (!Number.isSafeInteger(couponId)) {
        return reply.code(404).send(errorResponse("not_found"));
      }
      try {
        return reply
          .code(200)
          .send({ items: listCouponRedemptions(dependencies.database, couponId) });
      } catch {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
    },
  );
}

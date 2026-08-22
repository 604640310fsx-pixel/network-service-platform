import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyCsrfToken } from "./csrf.js";
import type { PaymentHttpDependencies } from "./payment-routes.js";
import { readPaymentSession } from "../payment/http-auth.js";
import {
  DELIVERY_MAX_ITEMS,
  encryptServiceDeliveryItem,
  normalizeServiceDeliveryInput,
  type ServiceDeliveryInput,
} from "../payment/delivery-crypto.js";
import {
  listPendingServicesForAdmin,
  openService,
  PaymentDomainError,
} from "../payment/orders.js";

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
}

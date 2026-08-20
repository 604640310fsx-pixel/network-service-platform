import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyCsrfToken } from "./csrf.js";
import type { PaymentHttpDependencies } from "./payment-routes.js";
import { readPaymentSession } from "../payment/http-auth.js";
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

  app.post<{ Params: { id: string } }>(
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
      try {
        return reply.code(200).send(
          openService(dependencies.database, {
            serviceId,
            adminUserId: session.principal.userId,
            adminEmail: session.principal.email,
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

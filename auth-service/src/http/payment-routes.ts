import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import {
  parseYuanAsFen,
  queryAlipayTrade,
  type AlipaySdkLike,
} from "../payment/alipay.js";
import { readPaymentSession } from "../payment/http-auth.js";
import {
  auditDeliveryDecryptFailure,
  claimAlipayQuery,
  createPaymentOrder,
  getAuthorizedOrderStatus,
  listMyServices,
  PaymentDomainError,
  readServiceDeliveryItems,
  retryPaymentOrder,
  type OrderCreationResult,
  type OrderSelection,
  type OrderServiceDependencies,
  type ServiceDeliveryItem,
  type ServiceStatus,
} from "../payment/orders.js";
import {
  acceptPendingPaymentEvent,
  auditPaymentFailure,
  finalizeClosed,
  finalizePaid,
  type PaymentEventInput,
} from "../payment/state-machine.js";
import type { TokenHmacKeyring } from "../session/session-token.js";

const NOTIFY_BODY_LIMIT = 65_536;
const CRITICAL_NOTIFY_FIELDS = [
  "sign",
  "sign_type",
  "notify_id",
  "app_id",
  "seller_id",
  "out_trade_no",
  "trade_no",
  "trade_status",
  "total_amount",
] as const;

export interface PaymentEnabledDependencies extends OrderServiceDependencies {
  readonly enabled: true;
  readonly sellerId: string;
  readonly csrfSigningKey: Buffer;
}

export type PaymentHttpDependencies =
  | { readonly enabled: false }
  | PaymentEnabledDependencies;

interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly currentAmountFen?: number;
    readonly maxSingleFen?: number;
  };
}

interface CreateOrderBody {
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly contact: string;
  readonly scenarios: readonly string[];
  readonly notes: string | null;
  readonly acknowledgedAmountFen: number;
}

type ParsedFormValue = string | string[];
type ParsedFormBody = Record<string, ParsedFormValue>;

function errorResponse(
  code: string,
  details: Readonly<Record<string, number>> = {},
): ErrorResponse {
  return { error: { code, ...details } };
}

function setNoStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

function stringHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseCreateBody(body: unknown): CreateOrderBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  if (
    typeof value.typeId !== "string" ||
    typeof value.regionId !== "string" ||
    typeof value.ispId !== "string" ||
    (value.specId !== null && typeof value.specId !== "string") ||
    typeof value.durationId !== "string" ||
    typeof value.contact !== "string" ||
    !Array.isArray(value.scenarios) ||
    value.scenarios.some((item) => typeof item !== "string") ||
    (value.notes !== null && typeof value.notes !== "string") ||
    !Number.isSafeInteger(value.acknowledgedAmountFen) ||
    typeof value.acknowledgedAmountFen !== "number"
  ) {
    return null;
  }
  return value as unknown as CreateOrderBody;
}

function publicCreationResult(result: OrderCreationResult): {
  readonly orderRef: string;
  readonly status: string;
  readonly payUrl?: string;
} {
  return result.payUrl === undefined
    ? { orderRef: result.orderRef, status: result.status }
    : {
        orderRef: result.orderRef,
        status: result.status,
        payUrl: result.payUrl,
      };
}

async function sendDomainError(
  reply: FastifyReply,
  error: unknown,
): Promise<FastifyReply> {
  if (error instanceof PaymentDomainError) {
    return reply
      .code(error.statusCode)
      .send(errorResponse(error.code, error.details));
  }
  return reply.code(503).send(errorResponse("payment_unavailable"));
}

function parseUrlEncodedBody(body: Buffer): ParsedFormBody {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const parsed: ParsedFormBody = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const existing = parsed[key];
    if (existing === undefined) {
      parsed[key] = value;
    } else if (typeof existing === "string") {
      parsed[key] = [existing, value];
    } else {
      existing.push(value);
    }
  }
  return parsed;
}

function normalizedCriticalFields(
  body: ParsedFormBody,
): Record<(typeof CRITICAL_NOTIFY_FIELDS)[number], string> | null {
  const normalized = {} as Record<
    (typeof CRITICAL_NOTIFY_FIELDS)[number],
    string
  >;
  for (const field of CRITICAL_NOTIFY_FIELDS) {
    const value = body[field];
    if (typeof value !== "string" || value === "") {
      return null;
    }
    normalized[field] = value;
  }
  return normalized;
}

function payloadHash(body: ParsedFormBody): string {
  const canonical = Object.keys(body)
    .sort()
    .map((key) => [key, body[key]])
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function paymentEvent(
  fields: Record<(typeof CRITICAL_NOTIFY_FIELDS)[number], string>,
  amountFen: number,
  hash: string,
): PaymentEventInput {
  return {
    outTradeNo: fields.out_trade_no,
    tradeNo: fields.trade_no,
    tradeStatus: fields.trade_status,
    totalAmount: fields.total_amount,
    totalAmountFen: amountFen,
    appId: fields.app_id,
    sellerId: fields.seller_id,
    notification: { notifyId: fields.notify_id, payloadHash: hash },
  };
}

function targetFromForm(body: ParsedFormBody): string {
  const outTradeNo = body.out_trade_no;
  if (typeof outTradeNo === "string" && outTradeNo !== "") {
    return outTradeNo;
  }
  const notifyId = body.notify_id;
  return typeof notifyId === "string" && notifyId !== "" ? notifyId : "unknown";
}

async function refreshOrderFromAlipay(
  dependencies: PaymentEnabledDependencies,
  order: ReturnType<typeof getAuthorizedOrderStatus>,
): Promise<void> {
  if (!claimAlipayQuery(dependencies, order.paymentId)) {
    return;
  }

  try {
    const queried = await queryAlipayTrade(dependencies.sdk, order.outTradeNo);
    if (
      !queried.recognized ||
      queried.outTradeNo !== order.outTradeNo ||
      queried.tradeNo === null ||
      queried.totalAmount === null ||
      queried.totalAmountFen === null ||
      queried.totalAmountFen !== order.amountFen ||
      queried.tradeStatus === null
    ) {
      auditPaymentFailure(
        dependencies,
        "payment.query_rejected",
        order.outTradeNo,
      );
      return;
    }
    const event: PaymentEventInput = {
      outTradeNo: order.outTradeNo,
      tradeNo: queried.tradeNo,
      tradeStatus: queried.tradeStatus,
      totalAmount: queried.totalAmount,
      totalAmountFen: queried.totalAmountFen,
      appId: dependencies.appId,
      sellerId: dependencies.sellerId,
    };
    if (
      queried.tradeStatus === "TRADE_SUCCESS" ||
      queried.tradeStatus === "TRADE_FINISHED"
    ) {
      finalizePaid(dependencies, event);
    } else if (queried.tradeStatus === "TRADE_CLOSED") {
      finalizeClosed(dependencies, event);
    } else if (queried.tradeStatus === "WAIT_BUYER_PAY") {
      acceptPendingPaymentEvent(dependencies, event);
    }
  } catch {
    auditPaymentFailure(
      dependencies,
      "payment.query_failed",
      order.outTradeNo,
    );
  }
}

function registerNotifyRoute(
  app: FastifyInstance,
  dependencies: PaymentHttpDependencies,
): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer", bodyLimit: NOTIFY_BODY_LIMIT },
      (_request, body, done) => {
        try {
          if (!Buffer.isBuffer(body)) {
            throw new Error("Alipay notify body is invalid");
          }
          done(null, parseUrlEncodedBody(body));
        } catch (error) {
          done(error as Error);
        }
      },
    );

    scope.post<{ Body: ParsedFormBody }>(
      "/api/pay/alipay/notify",
      async (request, reply) => {
        if (!dependencies.enabled) {
          return reply.code(503).type("text/plain").send("failure");
        }
        const fields = normalizedCriticalFields(request.body);
        if (fields === null) {
          auditPaymentFailure(
            dependencies,
            "payment.notify_invalid_fields",
            targetFromForm(request.body),
          );
          return reply.code(400).type("text/plain").send("failure");
        }
        let verified = false;
        try {
          verified = dependencies.sdk.checkNotifySignV2(request.body);
        } catch {
          verified = false;
        }
        if (!verified) {
          auditPaymentFailure(
            dependencies,
            "payment.notify_signature_rejected",
            fields.out_trade_no,
          );
          return reply.code(400).type("text/plain").send("failure");
        }
        const amountFen = parseYuanAsFen(fields.total_amount);
        if (amountFen === null) {
          auditPaymentFailure(
            dependencies,
            "payment.notify_amount_rejected",
            fields.out_trade_no,
          );
          return reply.code(400).type("text/plain").send("failure");
        }
        const input = paymentEvent(
          fields,
          amountFen,
          payloadHash(request.body),
        );
        let result: ReturnType<typeof finalizePaid>;
        if (
          fields.trade_status === "TRADE_SUCCESS" ||
          fields.trade_status === "TRADE_FINISHED"
        ) {
          result = finalizePaid(dependencies, input);
        } else if (fields.trade_status === "TRADE_CLOSED") {
          result = finalizeClosed(dependencies, input);
        } else if (fields.trade_status === "WAIT_BUYER_PAY") {
          result = acceptPendingPaymentEvent(dependencies, input);
        } else {
          auditPaymentFailure(
            dependencies,
            "payment.notify_unknown_status",
            fields.out_trade_no,
          );
          return reply.code(400).type("text/plain").send("failure");
        }
        return result === "rejected"
          ? reply.code(400).type("text/plain").send("failure")
          : reply.code(200).type("text/plain").send("success");
      },
    );
  });
}

export function registerPaymentHttpRoutes(
  app: FastifyInstance,
  dependencies: PaymentHttpDependencies,
): void {
  if (!dependencies.enabled) {
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?", 1)[0] ?? request.url;
      const isPaymentBusinessPath =
        path.startsWith("/api/pay/") ||
        path === "/api/me/services" ||
        path.startsWith("/api/admin/services");
      if (!isPaymentBusinessPath) {
        return;
      }
      if (path === "/api/pay/alipay/notify") {
        await reply.code(503).type("text/plain").send("failure");
      } else {
        await reply.code(503).send(errorResponse("payment_unavailable"));
      }
    });
  }
  registerNotifyRoute(app, dependencies);

  app.post<{ Body: unknown }>("/api/pay/orders", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
    const body = parseCreateBody(request.body);
    if (body === null) {
      return reply.code(400).send(errorResponse("invalid_selection"));
    }
    const idempotencyKey = stringHeader(request.headers["idempotency-key"]);
    if (idempotencyKey === null) {
      return reply.code(400).send(errorResponse("idempotency_key_required"));
    }
    const rawAccessToken = stringHeader(
      request.headers["x-order-access-token"],
    );
    if (rawAccessToken === null) {
      return reply.code(400).send(errorResponse("access_token_required"));
    }
    try {
      const session = readPaymentSession(request, dependencies);
      const selection: OrderSelection = {
        typeId: body.typeId,
        regionId: body.regionId,
        ispId: body.ispId,
        specId: body.specId,
        durationId: body.durationId,
      };
      const result = createPaymentOrder(dependencies, {
        idempotencyKey,
        rawAccessToken,
        selection,
        contact: body.contact,
        scenarios: body.scenarios,
        notes: body.notes,
        acknowledgedAmountFen: body.acknowledgedAmountFen,
        userId: session?.principal.userId ?? null,
      });
      return reply.code(200).send(publicCreationResult(result));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post<{ Params: { orderRef: string } }>(
    "/api/pay/orders/:orderRef/retry",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      const idempotencyKey = stringHeader(request.headers["idempotency-key"]);
      if (idempotencyKey === null) {
        return reply.code(400).send(errorResponse("idempotency_key_required"));
      }
      const newToken = stringHeader(
        request.headers["x-new-order-access-token"],
      );
      if (newToken === null) {
        return reply.code(400).send(errorResponse("access_token_required"));
      }
      const oldToken = stringHeader(request.headers["x-order-access-token"]);
      try {
        const session = readPaymentSession(request, dependencies);
        const result = retryPaymentOrder(dependencies, {
          oldOrderRef: request.params.orderRef,
          idempotencyKey,
          oldRawAccessToken: oldToken,
          newRawAccessToken: newToken,
          currentUserId: session?.principal.userId ?? null,
        });
        return reply.code(200).send(publicCreationResult(result));
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{ Params: { orderRef: string } }>(
    "/api/pay/orders/:orderRef",
    async (request, reply) => {
      setNoStore(reply);
      if (!dependencies.enabled) {
        return reply.code(503).send(errorResponse("payment_unavailable"));
      }
      const rawAccessToken = stringHeader(
        request.headers["x-order-access-token"],
      );
      try {
        const session = readPaymentSession(request, dependencies);
        const authorization = {
          orderRef: request.params.orderRef,
          userId: session?.principal.userId ?? null,
          rawAccessToken,
        };
        const before = getAuthorizedOrderStatus(dependencies, authorization);
        if (before.status !== "paid") {
          await refreshOrderFromAlipay(dependencies, before);
        }
        const after = getAuthorizedOrderStatus(dependencies, authorization);
        let service: {
          readonly status: ServiceStatus;
          readonly items?: readonly ServiceDeliveryItem[];
        } | null = after.service;
        if (after.service?.status === "open") {
          try {
            if (after.serviceId === null) {
              throw new Error("Service database invariant failed");
            }
            const items = readServiceDeliveryItems(
              dependencies.database,
              after.serviceId,
              dependencies.deliveryEncKeyring,
            );
            if (items.length > 0) {
              service = { status: "open", items };
            }
          } catch {
            try {
              auditDeliveryDecryptFailure(
                dependencies.database,
                after.orderRef,
                dependencies.now ?? (() => new Date()),
              );
            } catch {
              // The response remains fail-closed even when audit persistence fails.
            }
            return reply
              .code(503)
              .send(errorResponse("payment_unavailable"));
          }
        }
        return reply.code(200).send({
          orderRef: after.orderRef,
          status: after.status,
          amountFen: after.amountFen,
          currency: after.currency,
          service,
        });
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get("/api/me/services", async (request, reply) => {
    setNoStore(reply);
    if (!dependencies.enabled) {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
    try {
      const session = readPaymentSession(request, dependencies);
      if (session === null) {
        return reply.code(401).send(errorResponse("unauthorized"));
      }
      return reply
        .code(200)
        .send({ items: listMyServices(dependencies.database, session.principal.userId) });
    } catch {
      return reply.code(503).send(errorResponse("payment_unavailable"));
    }
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabaseConnection } from "../db.js";
import type { AlipaySdkLike } from "../payment/alipay.js";
import { readPaymentSession, type PaymentSession } from "../payment/http-auth.js";
import { observePendingTradeForCancel } from "../payment/payment-refresh.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import {
  applyAdminOrderClose,
  applyBuyerOrderCancellation,
  loadOrderPaymentById,
  loadOrderPaymentByRef,
  produceRenewalQuote,
  readRenewalConsent,
  setNextBillingPeriod,
  setRenewalConsent,
  walletBalance,
  WalletError,
  type BillingPeriod,
  type InternalActor,
} from "../wallet/candidate.js";
import { verifyCsrfToken } from "./csrf.js";

const WALLET_BODY_LIMIT_BYTES = 32 * 1024;
const BILLING_PERIODS: readonly BillingPeriod[] = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"];

export interface WalletHttpDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly csrfSigningKey: Buffer;
  readonly now?: () => Date;
  /* Provider channel for unpaid-order close observation only; paid-order admin
     closure is internal and needs no provider. Absent → order-close routes 503. */
  readonly payment?: {
    readonly appId: string;
    readonly sellerId: string;
    readonly sdk: AlipaySdkLike;
  };
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
    if (error.code === "ORDER_UNAVAILABLE") return reply.code(404).send(errorBody("not_found"));
    if (error.code === "QUOTE_UNAVAILABLE") return reply.code(409).send(errorBody("quote_unavailable"));
    if (error.code === "QUOTE_CHANGED") return reply.code(409).send(errorBody("quote_changed"));
    if (error.code === "SERVICE_CLOSED") return reply.code(409).send(errorBody("service_closed"));
    if (error.code === "REVISION_CONFLICT") return reply.code(409).send(errorBody("revision_conflict"));
    if (
      error.code === "NOT_CANCELLABLE" ||
      error.code === "SOURCE_UNAVAILABLE" ||
      error.code === "SOURCE_CONFLICT"
    ) {
      return reply.code(409).send(errorBody("not_cancellable"));
    }
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
      const body = exactKeys(request.body, ["period", "expectedRevision", "enabled"], ["expectedQuoteKey"]);
      const period = body === null ? null : parsePeriod(body.period);
      if (
        body === null || period === null ||
        !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 ||
        typeof body.enabled !== "boolean" ||
        (body.enabled === true &&
          (typeof body.expectedQuoteKey !== "string" || body.expectedQuoteKey.length === 0))
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
          body.expectedRevision as number, body.enabled as boolean,
          body.enabled === true ? (body.expectedQuoteKey as string) : null, at,
        );
        return await reply.send({ revision });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  const actorOf = (session: PaymentSession): InternalActor => ({
    userId: session.principal.userId,
    sessionValid: true,
    csrfValid: true,
    isAdmin: session.principal.role === "admin",
  });
  const nowAt = () => (dependencies.now?.() ?? new Date()).toISOString();
  const requireAdmin = (gate: Gate): { readonly statusCode: 403; readonly code: string } | null =>
    gate.ok && gate.session.principal.role !== "admin"
      ? { statusCode: 403, code: "forbidden" }
      : null;
  const refreshDeps = () => {
    const payment = dependencies.payment;
    if (payment === undefined) return null;
    return { database: dependencies.database, appId: payment.appId, sellerId: payment.sellerId, sdk: payment.sdk, now: dependencies.now };
  };

  /* 买家取消仅限真实未付款订单：先外部观察（关单+权威复查，绝不以推测充当
     已关闭），再在事务内原子完成 order/payment/management-close/release-once。
     已付（含复查刚发现的迟到支付）一律 409，财务事实保留、绝不重开。 */
  app.post<{ Params: { orderRef: string } }>(
    "/api/me/orders/:orderRef/cancel",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const orderRef = typeof request.params.orderRef === "string" && request.params.orderRef.length > 0
        ? request.params.orderRef
        : null;
      if (orderRef === null) return reply.code(404).send(errorBody("not_found"));
      let row;
      try {
        row = loadOrderPaymentByRef(dependencies.database, orderRef);
      } catch (error) {
        return sendFailure(reply, error);
      }
      if (row === null || row.ownerId !== gate.session.principal.userId) {
        return reply.code(404).send(errorBody("not_found"));
      }
      let observation = null;
      if (row.orderStatus === "pending" && row.paymentStatus === "pending" &&
        dependencies.database.prepare("SELECT order_id FROM wallet_order_closures WHERE order_id=?").all(row.orderId).length === 0) {
        const paymentDeps = refreshDeps();
        if (paymentDeps === null) return reply.code(503).send(errorBody("wallet_unavailable"));
        observation = await observePendingTradeForCancel(paymentDeps, {
          outTradeNo: paymentOutTradeNo(dependencies.database, row.paymentId),
          paymentId: row.paymentId,
          amountFen: row.amountFen,
        });
        if (observation.kind === "unknown") return reply.code(503).send(errorBody("wallet_unavailable"));
      }
      try {
        const result = applyBuyerOrderCancellation(
          dependencies.database,
          {
            database: dependencies.database,
            appId: dependencies.payment?.appId ?? "",
            sellerId: dependencies.payment?.sellerId ?? "",
            now: dependencies.now,
          },
          actorOf(gate.session), orderRef, observation, nowAt(),
        );
        if (result === "NOT_CANCELLABLE") return reply.code(409).send(errorBody("not_cancellable"));
        return await reply.send({ result });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  /* 管理员订单列表：只读主表投影 + payment/service 左连（含无支付/无服务行）。
     无 provider/网络/支付动作；闭单、退款案、终止案与管理关闭标记全部读自
     存储事实——表缺失或数据库故障一律 503，绝不返回空集或假标志。
     过滤器仅 orderRef/userId/beforeId；按 id 倒序定长 50，多取一行推导游标。 */
  const ADMIN_ORDER_FILTERS = new Set(["orderRef", "userId", "beforeId"]);
  app.get<{ Querystring: { orderRef?: string; userId?: string; beforeId?: string } }>(
    "/api/admin/orders",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: false });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const denied = requireAdmin(gate);
      if (denied !== null) return reply.code(denied.statusCode).send(errorBody(denied.code));
      const query = request.query as Record<string, unknown>;
      if (Object.keys(query).some((key) => !ADMIN_ORDER_FILTERS.has(key))) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      const positive = (raw: unknown): boolean =>
        raw === undefined ||
        (typeof raw === "string" && /^[0-9]+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0);
      if (
        !positive(query.userId) || !positive(query.beforeId) ||
        !(query.orderRef === undefined ||
          (typeof query.orderRef === "string" && query.orderRef.length > 0 && query.orderRef.length <= 128))
      ) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      const orderRef = (query.orderRef as string | undefined) ?? null;
      const userId = query.userId === undefined ? null : Number(query.userId);
      const beforeId = query.beforeId === undefined ? null : Number(query.beforeId);
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (orderRef !== null) { clauses.push("o.order_ref = ?"); params.push(orderRef); }
      if (userId !== null) { clauses.push("o.user_id = ?"); params.push(userId); }
      if (beforeId !== null) { clauses.push("o.id < ?"); params.push(beforeId); }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      try {
        const rows = dependencies.database.prepare(
          `SELECT o.id, o.order_ref, o.user_id, o.status, o.amount_fen, o.currency, o.created_at,
             p.status AS payment_status,
             s.id AS service_id, s.status AS service_status,
             CASE WHEN c.order_id IS NULL THEN 0 ELSE 1 END AS management_closed,
             rc.refund_state, tc.stop_state
           FROM orders o
           LEFT JOIN payments p ON p.order_id = o.id
           LEFT JOIN services s ON s.payment_id = p.id
           LEFT JOIN wallet_order_closures c ON c.order_id = o.id
           LEFT JOIN wallet_refund_cases rc ON rc.source_kind = 'ORIGINAL_PAYMENT' AND rc.source_id = p.id
           LEFT JOIN wallet_termination_cases tc ON tc.service_id = s.id
           ${where}
           ORDER BY o.id DESC
           LIMIT 51`,
        ).all(...params) as Array<{
          readonly id: number; readonly order_ref: string; readonly user_id: number | null;
          readonly status: "pending" | "paid" | "closed";
          readonly amount_fen: number; readonly currency: string; readonly created_at: string;
          readonly payment_status: "pending" | "paid" | "closed" | null;
          readonly service_id: number | null; readonly service_status: "pending_open" | "open" | null;
          readonly management_closed: number; readonly refund_state: string | null;
          readonly stop_state: string | null;
        }>;
        const page = rows.slice(0, 50);
        return await reply.send({
          orders: page.map((row) => ({
            id: row.id,
            orderRef: row.order_ref,
            userId: row.user_id,
            status: row.status,
            paymentStatus: row.payment_status,
            amountFen: row.amount_fen,
            currency: row.currency,
            createdAt: row.created_at,
            serviceId: row.service_id,
            serviceStatus: row.service_status,
            managementClosed: row.management_closed === 1,
            refundState: row.refund_state,
            serviceStopState: row.stop_state,
          })),
          nextBeforeId: rows.length === 51 ? page[49]!.id : null,
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  /* 管理员内部关单：未付款走与买家相同的观察路径；已付款仅内部记录管理关闭
     + 结算 + AWAITING_POLICY 退款案（绑定已验证支付来源），OPEN 服务另记
     REQUESTED 终止请求并禁用后续自动续期——不执行也不声称任何外部停止。 */
  app.post<{ Params: { id: string } }>(
    "/api/admin/orders/:id/close",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const denied = requireAdmin(gate);
      if (denied !== null) return reply.code(denied.statusCode).send(errorBody(denied.code));
      const orderId = parseServiceId(request.params.id);
      if (orderId === null) return reply.code(404).send(errorBody("not_found"));
      let row;
      try {
        row = loadOrderPaymentById(dependencies.database, orderId);
      } catch (error) {
        return sendFailure(reply, error);
      }
      if (row === null) return reply.code(404).send(errorBody("not_found"));
      let observation = null;
      if (row.orderStatus === "pending" && row.paymentStatus === "pending" &&
        dependencies.database.prepare("SELECT order_id FROM wallet_order_closures WHERE order_id=?").all(row.orderId).length === 0) {
        const paymentDeps = refreshDeps();
        if (paymentDeps === null) return reply.code(503).send(errorBody("wallet_unavailable"));
        observation = await observePendingTradeForCancel(paymentDeps, {
          outTradeNo: paymentOutTradeNo(dependencies.database, row.paymentId),
          paymentId: row.paymentId,
          amountFen: row.amountFen,
        });
        if (observation.kind === "unknown") return reply.code(503).send(errorBody("wallet_unavailable"));
      }
      try {
        const result = applyAdminOrderClose(
          dependencies.database,
          {
            database: dependencies.database,
            appId: dependencies.payment?.appId ?? "",
            sellerId: dependencies.payment?.sellerId ?? "",
            now: dependencies.now,
          },
          actorOf(gate.session), orderId, observation, nowAt(),
        );
        return await reply.send(result);
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  /* 下期周期：{period,expectedRevision} 为唯一合法体；服务端重新校验真实
     在售 SKU 报价，ENABLED/RECONSENT_REQUIRED 归 RECONSENT_REQUIRED，DISABLED
     保持；买家限本人服务（外部/缺失同 404），管理员凭角色管理任意真实服务。 */
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/me/services/:id/next-billing-period",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const serviceId = parseServiceId(request.params.id);
      if (serviceId === null) return reply.code(404).send(errorBody("not_found"));
      const body = exactKeys(request.body, ["period", "expectedRevision"]);
      const period = body === null ? null : parsePeriod(body.period);
      if (
        body === null || period === null ||
        !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
      ) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        if (!ownsService(dependencies.database, serviceId, gate.session.principal.userId)) {
          return reply.code(404).send(errorBody("not_found"));
        }
        const revision = setNextBillingPeriod(
          dependencies.database, actorOf(gate.session), serviceId, period,
          body.expectedRevision as number, nowAt(),
        );
        return await reply.send({ revision });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/admin/services/:id/next-billing-period",
    routeOptions,
    async (request, reply) => {
      const gate = authorize(request, dependencies, { write: true });
      if (!gate.ok) return reply.code(gate.statusCode).send(errorBody(gate.code));
      const denied = requireAdmin(gate);
      if (denied !== null) return reply.code(denied.statusCode).send(errorBody(denied.code));
      const serviceId = parseServiceId(request.params.id);
      if (serviceId === null) return reply.code(404).send(errorBody("not_found"));
      const body = exactKeys(request.body, ["period", "expectedRevision"]);
      const period = body === null ? null : parsePeriod(body.period);
      if (
        body === null || period === null ||
        !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
      ) {
        return reply.code(400).send(errorBody("invalid_request"));
      }
      try {
        const revision = setNextBillingPeriod(
          dependencies.database, actorOf(gate.session), serviceId, period,
          body.expectedRevision as number, nowAt(),
        );
        return await reply.send({ revision });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}

function paymentOutTradeNo(database: DatabaseConnection, paymentId: number): string {
  const rows = database.prepare("SELECT out_trade_no FROM payments WHERE id=?").all(paymentId) as Array<{ out_trade_no: unknown }>;
  const value = rows[0]?.out_trade_no;
  if (typeof value !== "string" || value.length === 0) throw new Error("Payment out_trade_no invariant failed");
  return value;
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { DatabaseConnection } from "../db.js";
import {
  computeOrderAccessTokenHash,
  orderAccessTokenExpiry,
  OrderAccessTokenError,
} from "../session/order-access-token.js";
import type { TokenHmacKeyring } from "../session/session-token.js";
import type { AlipaySdkLike } from "./alipay.js";
import { normalizeMonitorTargetKey } from "../monitor/target-catalog.js";
import {
  findRedeemedCouponCode,
  normalizeCouponCode,
  occupyPlanAndCoupon,
  PaymentDomainError,
  resolveQuote,
  type PlanSelection,
} from "./commerce.js";
import {
  decryptServiceDeliveryItem,
  DELIVERY_MAX_ITEMS,
  type EncryptedServiceDeliveryItem,
} from "./delivery-crypto.js";
import { CATALOG_VERSION } from "./pricing.js";
import { planOverrideLabel } from "./admin-services.js";

export type OrderStatus = "pending" | "paid" | "closed";
export type ServiceStatus = "pending_open" | "open";

// PaymentDomainError 的唯一定义现在在 commerce.ts；这里保留原有的导入路径
// re-export，避免 payment-routes.ts / admin-routes.ts 已有的
// `from "../payment/orders.js"` 引用需要跟着改。
export { PaymentDomainError };

export type OrderSelection = PlanSelection;

const ORDER_RESERVATION_MS = 30 * 60 * 1_000;

export interface CreateOrderInput {
  readonly idempotencyKey: string;
  readonly rawAccessToken: string;
  readonly selection: OrderSelection;
  readonly contact: string;
  readonly scenarios: readonly string[];
  readonly notes: string | null;
  readonly acknowledgedAmountFen: number;
  readonly userId: number | null;
  // 可选，缺省视为无优惠券——保持旧调用方（不涉及优惠券的既有测试）零改动可编译。
  readonly couponCode?: string | null;
}

export interface RetryOrderInput {
  readonly oldOrderRef: string;
  readonly idempotencyKey: string;
  readonly oldRawAccessToken: string | null;
  readonly newRawAccessToken: string;
  // 重新支付会生成新订单，必须由已登录用户发起；新订单只归属该 Session 用户。
  readonly currentUserId: number;
}

export interface OrderServiceDependencies {
  readonly database: DatabaseConnection;
  readonly tokenHmacKeyring: TokenHmacKeyring;
  readonly deliveryEncKeyring: TokenHmacKeyring;
  readonly appId: string;
  readonly notifyUrl: string;
  readonly returnUrl: string;
  readonly sdk: AlipaySdkLike;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}

export interface OrderCreationResult {
  readonly orderRef: string;
  readonly status: OrderStatus;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly reservedUntil: string | null;
}

export interface OrderStatusResult {
  readonly orderRef: string;
  readonly status: OrderStatus;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly reservedUntil: string | null;
  readonly service: { readonly status: ServiceStatus } | null;
}

export interface AuthorizedOrderStatus extends OrderStatusResult {
  readonly serviceId: number | null;
  readonly paymentId: number;
  readonly outTradeNo: string;
  readonly tradeNo: string | null;
  readonly lastQueriedAt: string | null;
}

interface StoredOrder {
  readonly id: number;
  readonly orderRef: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly userId: number | null;
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly amountFen: number;
  readonly contact: string;
  readonly scenarios: readonly string[];
  readonly notes: string | null;
  readonly status: OrderStatus;
  readonly paymentId: number;
  readonly outTradeNo: string;
  readonly tradeNo: string | null;
  readonly lastQueriedAt: string | null;
  readonly reservedUntil: string | null;
  readonly tokenHash: string;
  readonly tokenKeyVersion: number;
  readonly tokenExpiresAt: string;
  readonly tokenRevokedAt: string | null;
  readonly serviceStatus: ServiceStatus | null;
  readonly serviceId: number | null;
}

function nowDate(dependencies: Pick<OrderServiceDependencies, "now">): Date {
  const value = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Payment time source is invalid");
  }
  return value;
}

function parseScenarios(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    throw new Error("Order scenarios are invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Order scenarios are invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("Order scenarios are invalid");
  }
  return parsed;
}

function rowString(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error("Order database invariant failed");
  }
  return value;
}

function rowNullableString(
  row: Record<string, unknown>,
  name: string,
): string | null {
  const value = row[name];
  if (value !== null && typeof value !== "string") {
    throw new Error("Order database invariant failed");
  }
  return value;
}

function rowNumber(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number") {
    throw new Error("Order database invariant failed");
  }
  return value;
}

function parseStoredOrder(row: unknown): StoredOrder {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Order database invariant failed");
  }
  const value = row as Record<string, unknown>;
  const status = rowString(value, "status");
  const serviceStatus = rowNullableString(value, "service_status");
  const serviceIdValue = value.service_id;
  const userIdValue = value.user_id;
  if (
    (status !== "pending" && status !== "paid" && status !== "closed") ||
    (serviceStatus !== null &&
      serviceStatus !== "pending_open" &&
      serviceStatus !== "open") ||
    (userIdValue !== null && typeof userIdValue !== "number") ||
    (serviceIdValue !== null && typeof serviceIdValue !== "number")
  ) {
    throw new Error("Order database invariant failed");
  }
  return {
    id: rowNumber(value, "id"),
    orderRef: rowString(value, "order_ref"),
    idempotencyKey: rowString(value, "idempotency_key"),
    requestFingerprint: rowString(value, "request_fingerprint"),
    userId: userIdValue,
    typeId: rowString(value, "type_id"),
    regionId: rowString(value, "region_id"),
    ispId: rowString(value, "isp_id"),
    specId: rowNullableString(value, "spec_id"),
    durationId: rowString(value, "duration_id"),
    amountFen: rowNumber(value, "amount_fen"),
    contact: rowString(value, "contact"),
    scenarios: parseScenarios(value.scenarios),
    notes: rowNullableString(value, "notes"),
    status,
    paymentId: rowNumber(value, "payment_id"),
    outTradeNo: rowString(value, "out_trade_no"),
    tradeNo: rowNullableString(value, "trade_no"),
    lastQueriedAt: rowNullableString(value, "last_queried_at"),
    reservedUntil: rowNullableString(value, "reserved_until"),
    tokenHash: rowString(value, "token_hash"),
    tokenKeyVersion: rowNumber(value, "token_key_version"),
    tokenExpiresAt: rowString(value, "expires_at"),
    tokenRevokedAt: rowNullableString(value, "revoked_at"),
    serviceStatus,
    serviceId: serviceIdValue,
  };
}

const ORDER_SELECT = `
  SELECT
    orders.id, orders.order_ref, orders.idempotency_key,
    orders.request_fingerprint, orders.user_id, orders.type_id,
    orders.region_id, orders.isp_id, orders.spec_id, orders.duration_id,
    orders.amount_fen, orders.contact, orders.scenarios, orders.notes,
    orders.status,
    payments.id AS payment_id, payments.out_trade_no,
    payments.trade_no, payments.last_queried_at, payments.reserved_until,
    order_access_tokens.token_hash,
    order_access_tokens.token_key_version,
    order_access_tokens.expires_at,
    order_access_tokens.revoked_at,
    services.id AS service_id, services.status AS service_status
  FROM orders
  JOIN payments ON payments.order_id = orders.id
  JOIN order_access_tokens ON order_access_tokens.order_id = orders.id
  LEFT JOIN services ON services.payment_id = payments.id
`;

function findOrder(
  database: DatabaseConnection,
  whereClause: string,
  parameter: string,
): StoredOrder | null {
  const rows = database
    .prepare(`${ORDER_SELECT} WHERE ${whereClause}`)
    .all(parameter);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) {
    throw new Error("Order database invariant failed");
  }
  return parseStoredOrder(rows[0]);
}

function normalizeScenarios(scenarios: readonly string[]): readonly string[] {
  return [...new Set(scenarios.map((value) => value.trim()).filter(Boolean))].sort();
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function requestFingerprint(input: {
  readonly selection: OrderSelection;
  readonly contact: string;
  readonly scenarios: readonly string[];
  readonly notes: string | null;
  // 创建订单时是客户端提交的 acknowledgedAmountFen（不依赖服务器可变状态，
  // 与旧行为一致）；重试没有客户端承诺金额，传 null——这样重试的幂等重放判定
  // 不需要先调用会因库存/优惠券状态变化而抛错的 resolveQuote。
  readonly amountFen: number | null;
  readonly userId: number | null;
  readonly couponCode: string | null;
  readonly retryOf?: string;
}): string {
  return fingerprint({
    typeId: input.selection.typeId,
    regionId: input.selection.regionId,
    ispId: input.selection.ispId,
    specId: input.selection.specId,
    durationId: input.selection.durationId,
    contact: input.contact,
    scenarios: input.scenarios,
    notes: input.notes,
    amountFen: input.amountFen,
    userId: input.userId,
    couponCode: input.couponCode,
    retryOf: input.retryOf ?? null,
  });
}

function assertTokenMatches(
  order: StoredOrder,
  rawToken: string,
  keyring: TokenHmacKeyring,
): boolean {
  try {
    const computed = computeOrderAccessTokenHash(
      rawToken,
      keyring,
      order.tokenKeyVersion,
    );
    return timingSafeEqual(
      Buffer.from(computed.tokenHash, "ascii"),
      Buffer.from(order.tokenHash, "ascii"),
    );
  } catch (error) {
    if (error instanceof OrderAccessTokenError) {
      return false;
    }
    throw error;
  }
}

function publicReservedUntil(order: StoredOrder): string | null {
  if (order.status !== "pending") {
    return null;
  }
  if (order.reservedUntil === null) {
    throw new Error("Order database invariant failed");
  }
  const parsed = new Date(order.reservedUntil);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== order.reservedUntil
  ) {
    throw new Error("Order database invariant failed");
  }
  return order.reservedUntil;
}

function paymentResponse(order: StoredOrder): OrderCreationResult {
  return {
    orderRef: order.orderRef,
    status: order.status,
    amountFen: order.amountFen,
    currency: "CNY",
    reservedUntil: publicReservedUntil(order),
  };
}

function createReference(dependencies: OrderServiceDependencies): string {
  const uuid = (dependencies.randomUuid ?? randomUUID)();
  const compact = uuid.replace(/-/g, "");
  if (!/^[A-Za-z0-9]{1,64}$/.test(compact)) {
    throw new Error("Payment reference generation failed");
  }
  return `DL${compact}`;
}

function createStoredOrder(
  dependencies: OrderServiceDependencies,
  input: {
    readonly idempotencyKey: string;
    readonly rawAccessToken: string;
    readonly selection: OrderSelection;
    readonly contact: string;
    readonly scenarios: readonly string[];
    readonly notes: string | null;
    readonly amountFen: number;
    readonly userId: number | null;
    readonly fingerprint: string;
    readonly planId: number;
    readonly couponId: number | null;
    readonly discountFen: number;
  },
): StoredOrder {
  const existing = findOrder(
    dependencies.database,
    "orders.idempotency_key = ?",
    input.idempotencyKey,
  );
  if (existing !== null) {
    if (
      existing.requestFingerprint !== input.fingerprint ||
      !assertTokenMatches(
        existing,
        input.rawAccessToken,
        dependencies.tokenHmacKeyring,
      )
    ) {
      throw new PaymentDomainError(409, "idempotency_key_conflict");
    }
    return existing;
  }

  let accessToken: ReturnType<typeof computeOrderAccessTokenHash>;
  try {
    accessToken = computeOrderAccessTokenHash(
      input.rawAccessToken,
      dependencies.tokenHmacKeyring,
    );
  } catch (error) {
    if (error instanceof OrderAccessTokenError) {
      throw new PaymentDomainError(400, "access_token_required");
    }
    throw error;
  }
  if (
    dependencies.database
      .prepare("SELECT id FROM order_access_tokens WHERE token_hash = ?")
      .all(accessToken.tokenHash).length !== 0
  ) {
    throw new PaymentDomainError(409, "idempotency_key_conflict");
  }

  const created = nowDate(dependencies);
  const now = created.toISOString();
  const orderRef = createReference(dependencies);
  dependencies.database
    .prepare(
      `INSERT INTO orders (
         order_ref, idempotency_key, request_fingerprint, user_id,
         type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
         amount_fen, currency, contact, scenarios, notes, status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CNY', ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      orderRef,
      input.idempotencyKey,
      input.fingerprint,
      input.userId,
      input.selection.typeId,
      input.selection.regionId,
      input.selection.ispId,
      input.selection.specId,
      input.selection.durationId,
      CATALOG_VERSION,
      input.amountFen,
      input.contact,
      JSON.stringify(input.scenarios),
      input.notes,
      now,
      now,
    );
  const idRows = dependencies.database
    .prepare("SELECT id FROM orders WHERE order_ref = ?")
    .all(orderRef);
  if (
    idRows.length !== 1 ||
    typeof idRows[0] !== "object" ||
    idRows[0] === null ||
    !("id" in idRows[0]) ||
    typeof idRows[0].id !== "number"
  ) {
    throw new Error("Order insertion failed");
  }
  const orderId = idRows[0].id;
  const reservedUntil = new Date(created.getTime() + ORDER_RESERVATION_MS).toISOString();
  dependencies.database
    .prepare(
      `INSERT INTO payments (
         order_id, out_trade_no, channel, app_id, amount_fen, currency,
         status, trade_no, alipay_trade_status, last_queried_at,
         close_reason, paid_at, closed_at, reserved_until, created_at, updated_at
       ) VALUES (?, ?, 'alipay_page', ?, ?, 'CNY', 'pending', NULL, NULL,
                 NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(orderId, orderRef, dependencies.appId, input.amountFen, reservedUntil, now, now);
  occupyPlanAndCoupon(dependencies.database, {
    planId: input.planId,
    couponId: input.couponId,
    orderId,
    userId: input.userId,
    discountFen: input.discountFen,
    now: () => created,
  });
  dependencies.database
    .prepare(
      `INSERT INTO order_access_tokens (
         order_id, token_hash, token_key_version, expires_at, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      orderId,
      accessToken.tokenHash,
      accessToken.tokenKeyVersion,
      orderAccessTokenExpiry(created),
      now,
    );

  const inserted = findOrder(
    dependencies.database,
    "orders.order_ref = ?",
    orderRef,
  );
  if (inserted === null) {
    throw new Error("Order insertion failed");
  }
  return inserted;
}

export function createPaymentOrder(
  dependencies: OrderServiceDependencies,
  input: CreateOrderInput,
): OrderCreationResult {
  const contact = input.contact.trim();
  if (!contact) {
    throw new PaymentDomainError(400, "contact_required");
  }
  if (!input.idempotencyKey.trim()) {
    throw new PaymentDomainError(400, "idempotency_key_required");
  }
  const scenarios = normalizeScenarios(input.scenarios);
  const notes = input.notes?.trim() || null;
  const couponCode =
    input.couponCode === null || input.couponCode === undefined
      ? null
      : normalizeCouponCode(input.couponCode);
  const requestHash = requestFingerprint({
    selection: input.selection,
    contact,
    scenarios,
    notes,
    amountFen: input.acknowledgedAmountFen,
    userId: input.userId,
    couponCode,
  });
  const replayOperation = dependencies.database.transaction(() => {
    const existing = findOrder(
      dependencies.database,
      "orders.idempotency_key = ?",
      input.idempotencyKey,
    );
    if (existing === null) {
      return null;
    }
    if (
      existing.requestFingerprint !== requestHash ||
      !assertTokenMatches(
        existing,
        input.rawAccessToken,
        dependencies.tokenHmacKeyring,
      )
    ) {
      throw new PaymentDomainError(409, "idempotency_key_conflict");
    }
    return existing;
  });
  const replay = replayOperation.immediate();
  if (replay !== null) {
    return paymentResponse(replay);
  }

  // 服务器重新核价：价格、可售状态、库存与优惠券全部以此为准，不信任客户端。
  const quote = resolveQuote(dependencies.database, {
    selection: input.selection,
    couponCode,
    now: dependencies.now ?? (() => new Date()),
  });
  if (input.acknowledgedAmountFen !== quote.amountFen) {
    throw new PaymentDomainError(409, "price_changed", {
      currentAmountFen: quote.amountFen,
    });
  }
  const operation = dependencies.database.transaction(() =>
    createStoredOrder(dependencies, {
      idempotencyKey: input.idempotencyKey,
      rawAccessToken: input.rawAccessToken,
      selection: input.selection,
      contact,
      scenarios,
      notes,
      amountFen: quote.amountFen,
      userId: input.userId,
      fingerprint: requestHash,
      planId: quote.planId,
      couponId: quote.couponId,
      discountFen: quote.discountFen,
    }),
  );
  return paymentResponse(operation.immediate());
}

function tokenAuthorized(
  order: StoredOrder,
  rawToken: string | null,
  keyring: TokenHmacKeyring,
  now: string,
): boolean {
  return (
    rawToken !== null &&
    order.tokenRevokedAt === null &&
    order.tokenExpiresAt > now &&
    assertTokenMatches(order, rawToken, keyring)
  );
}

function orderAuthorized(
  order: StoredOrder,
  userId: number | null,
  rawToken: string | null,
  keyring: TokenHmacKeyring,
  now: string,
): boolean {
  return (
    (userId !== null && order.userId === userId) ||
    tokenAuthorized(order, rawToken, keyring, now)
  );
}

export function retryPaymentOrder(
  dependencies: OrderServiceDependencies,
  input: RetryOrderInput,
): OrderCreationResult {
  if (!input.idempotencyKey.trim()) {
    throw new PaymentDomainError(400, "idempotency_key_required");
  }
  const operation = dependencies.database.transaction(() => {
    const oldOrder = findOrder(
      dependencies.database,
      "orders.order_ref = ?",
      input.oldOrderRef,
    );
    const now = nowDate(dependencies).toISOString();
    // 已绑定账户的旧订单只允许同一账户重试，即使持有有效查询凭证也不能跨账户；
    // 游客旧订单沿用原有查询凭证校验。旧订单本身的归属从不改写。
    const oldOrderAuthorized =
      oldOrder !== null &&
      (oldOrder.userId !== null
        ? oldOrder.userId === input.currentUserId
        : tokenAuthorized(
            oldOrder,
            input.oldRawAccessToken,
            dependencies.tokenHmacKeyring,
            now,
          ));
    if (oldOrder === null || !oldOrderAuthorized) {
      throw new PaymentDomainError(404, "not_found");
    }
    const selection: OrderSelection = {
      typeId: oldOrder.typeId,
      regionId: oldOrder.regionId,
      ispId: oldOrder.ispId,
      specId: oldOrder.specId,
      durationId: oldOrder.durationId,
    };
    // retry 默认复用原订单已核销的优惠券（若有），从持久化的 coupon_redemptions
    // 关联读取；不接受客户端临时更换优惠券（RetryOrderInput 本就没有该字段）。
    const couponCode = findRedeemedCouponCode(dependencies.database, oldOrder.id);
    const ownerUserId = input.currentUserId;
    const requestHash = requestFingerprint({
      selection,
      contact: oldOrder.contact,
      scenarios: oldOrder.scenarios,
      notes: oldOrder.notes,
      amountFen: null,
      userId: ownerUserId,
      couponCode,
      retryOf: oldOrder.orderRef,
    });
    const existingRetry = findOrder(
      dependencies.database,
      "orders.idempotency_key = ?",
      input.idempotencyKey,
    );
    if (existingRetry !== null) {
      if (
        existingRetry.requestFingerprint !== requestHash ||
        !assertTokenMatches(
          existingRetry,
          input.newRawAccessToken,
          dependencies.tokenHmacKeyring,
        )
      ) {
        throw new PaymentDomainError(409, "idempotency_key_conflict");
      }
      return existingRetry;
    }
    if (oldOrder.status !== "closed") {
      throw new PaymentDomainError(409, "invalid_transition");
    }
    // 重新核价：价格、有效期、适用套餐范围与剩余次数全部重新校验，验证通过后
    // 由 createStoredOrder 在同一事务内原子占用。
    const quote = resolveQuote(dependencies.database, {
      selection,
      couponCode,
      now: dependencies.now ?? (() => new Date()),
    });
    return createStoredOrder(dependencies, {
      idempotencyKey: input.idempotencyKey,
      rawAccessToken: input.newRawAccessToken,
      selection,
      contact: oldOrder.contact,
      scenarios: oldOrder.scenarios,
      notes: oldOrder.notes,
      amountFen: quote.amountFen,
      userId: ownerUserId,
      fingerprint: requestHash,
      planId: quote.planId,
      couponId: quote.couponId,
      discountFen: quote.discountFen,
    });
  });
  return paymentResponse(operation.immediate());
}

function orderStatusResult(order: StoredOrder): AuthorizedOrderStatus {
  return {
    orderRef: order.orderRef,
    status: order.status,
    amountFen: order.amountFen,
    currency: "CNY",
    reservedUntil: publicReservedUntil(order),
    service:
      order.serviceStatus === null ? null : { status: order.serviceStatus },
    serviceId: order.serviceId,
    paymentId: order.paymentId,
    outTradeNo: order.outTradeNo,
    tradeNo: order.tradeNo,
    lastQueriedAt: order.lastQueriedAt,
  };
}

export function getAuthorizedOrderStatus(
  dependencies: Pick<OrderServiceDependencies, "database" | "tokenHmacKeyring" | "now">,
  input: {
    readonly orderRef: string;
    readonly userId: number | null;
    readonly rawAccessToken: string | null;
  },
): AuthorizedOrderStatus {
  const order = findOrder(
    dependencies.database,
    "orders.order_ref = ?",
    input.orderRef,
  );
  const now = nowDate(dependencies).toISOString();
  if (
    order === null ||
    !orderAuthorized(
      order,
      input.userId,
      input.rawAccessToken,
      dependencies.tokenHmacKeyring,
      now,
    )
  ) {
    throw new PaymentDomainError(404, "not_found");
  }
  return orderStatusResult(order);
}

export interface ServiceDeliveryItem {
  readonly position: number;
  readonly label: string;
  readonly subscriptionUrl: string;
  readonly monitorTargetKey: string | null;
}

function rowBuffer(row: Record<string, unknown>, name: string): Buffer {
  const value = row[name];
  if (!Buffer.isBuffer(value)) {
    throw new Error("Service delivery database invariant failed");
  }
  return value;
}

export function readServiceDeliveryItems(
  database: DatabaseConnection,
  serviceId: number,
  keyring: TokenHmacKeyring,
): ServiceDeliveryItem[] {
  if (!Number.isSafeInteger(serviceId) || serviceId < 1) {
    throw new Error("Service delivery database invariant failed");
  }
  return database
    .prepare(
      `SELECT position, label, monitor_target_key,
              key_version, nonce, ciphertext, tag
       FROM service_delivery_items
       WHERE service_id = ?
       ORDER BY position ASC`,
    )
    .all(serviceId)
    .map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("Service delivery database invariant failed");
      }
      const value = row as Record<string, unknown>;
      const position = rowNumber(value, "position");
      const label = rowString(value, "label");
      const monitorTargetKey = rowNullableString(value, "monitor_target_key");
      const keyVersion = rowNumber(value, "key_version");
      if (
        monitorTargetKey !== null &&
        normalizeMonitorTargetKey(monitorTargetKey) === null
      ) {
        throw new Error("Service delivery database invariant failed");
      }
      return {
        position,
        label,
        monitorTargetKey,
        subscriptionUrl: decryptServiceDeliveryItem(
          {
            serviceId,
            position,
            label,
            keyVersion,
            nonce: rowBuffer(value, "nonce"),
            ciphertext: rowBuffer(value, "ciphertext"),
            tag: rowBuffer(value, "tag"),
          },
          keyring,
        ),
      };
    });
}

export function auditDeliveryDecryptFailure(
  database: DatabaseConnection,
  orderRef: string,
  now: () => Date = () => new Date(),
): void {
  const occurredAt = now();
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new Error("Service delivery audit time source is invalid");
  }
  database
    .prepare(
      `INSERT INTO audit_log (actor, action, target_ref, created_at)
       VALUES ('system', 'service.delivery_decrypt_failed', ?, ?)`,
    )
    .run(orderRef, occurredAt.toISOString());
}

export function claimAlipayQuery(
  dependencies: Pick<OrderServiceDependencies, "database" | "now">,
  paymentId: number,
): boolean {
  const operation = dependencies.database.transaction(() => {
    const now = nowDate(dependencies);
    const cutoff = new Date(now.getTime() - 15_000).toISOString();
    const result = dependencies.database
      .prepare(
        `UPDATE payments SET last_queried_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'closed')
           AND (last_queried_at IS NULL OR last_queried_at < ?)`,
      )
      .run(now.toISOString(), now.toISOString(), paymentId, cutoff);
    return result.changes === 1;
  });
  return operation.immediate();
}

export interface MyServiceItem {
  readonly source: "purchase";
  /** Real services.id for wallet/renewal lookups; grants carry grantId instead and never map here. */
  readonly serviceId: number;
  readonly orderRef: string;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly orderStatus: OrderStatus;
  readonly serviceStatus: ServiceStatus;
  readonly createdAt: string;
  /** Admin-set expiry (Migration 022); null = long-term. */
  readonly endsAt: string | null;
  /** Admin plan-name override; null = show the order snapshot. */
  readonly planLabel: string | null;
}

export function listMyServices(
  database: DatabaseConnection,
  userId: number,
): MyServiceItem[] {
  const rows = database
    .prepare(
      `SELECT services.id AS service_id, orders.order_ref, orders.amount_fen, orders.currency,
              orders.status AS order_status, services.status AS service_status,
              services.created_at, services.ends_at, services.plan_override
       FROM services
       JOIN payments ON payments.id = services.payment_id
       JOIN orders ON orders.id = payments.order_id
       WHERE orders.user_id = ?
       ORDER BY services.id DESC`,
    )
    .all(userId);
  return rows.map((row) => {
    if (typeof row !== "object" || row === null) {
      throw new Error("Service database invariant failed");
    }
    const value = row as Record<string, unknown>;
    const orderStatus = rowString(value, "order_status");
    const serviceStatus = rowString(value, "service_status");
    const serviceId = rowNumber(value, "service_id");
    if (
      (orderStatus !== "pending" && orderStatus !== "paid" && orderStatus !== "closed") ||
      (serviceStatus !== "pending_open" && serviceStatus !== "open") ||
      !Number.isSafeInteger(serviceId) ||
      serviceId < 1
    ) {
      throw new Error("Service database invariant failed");
    }
    return {
      source: "purchase" as const,
      serviceId,
      orderRef: rowString(value, "order_ref"),
      amountFen: rowNumber(value, "amount_fen"),
      currency: "CNY" as const,
      orderStatus,
      serviceStatus,
      createdAt: rowString(value, "created_at"),
      endsAt: rowNullableString(value, "ends_at"),
      planLabel: planOverrideLabel(value.plan_override),
    };
  });
}

export interface MyDeliveryLineItem {
  readonly orderRef: string;
  readonly position: number;
  readonly label: string;
}

/* 买家可见的交付线路名称。所有权在 SQL 层限定；只读取已经交付的公开名称，
   不读取或解密订阅 URL，也不读取或暴露管理员绑定的目标键、主机名、IP、
   面板地址或监控源返回的连接字段。 */
export function listMyDeliveryLines(
  database: DatabaseConnection,
  userId: number,
): MyDeliveryLineItem[] {
  const rows = database
    .prepare(
      `SELECT orders.order_ref, service_delivery_items.position,
              service_delivery_items.label
       FROM service_delivery_items
       JOIN services ON services.id = service_delivery_items.service_id
       JOIN payments ON payments.id = services.payment_id
       JOIN orders ON orders.id = payments.order_id
       WHERE orders.user_id = ? AND services.status = 'open'
       ORDER BY services.id DESC, service_delivery_items.position ASC`,
    )
    .all(userId);
  return rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("Service delivery database invariant failed");
    }
    const value = row as Record<string, unknown>;
    const position = rowNumber(value, "position");
    const label = rowString(value, "label");
    if (
      !Number.isSafeInteger(position) ||
      position < 1 ||
      label.trim() !== label ||
      label.length === 0
    ) {
      throw new Error("Service delivery database invariant failed");
    }
    return {
      orderRef: rowString(value, "order_ref"),
      position,
      label,
    };
  });
}

export interface MyOrderItem {
  readonly orderRef: string;
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly status: OrderStatus;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly createdAt: string;
  readonly reservedUntil: string | null;
  readonly serviceStatus: ServiceStatus | null;
}

// canonical ISO instant 严格 round-trip 校验：必须是有效日期且 toISOString() 与原值
// 逐字符相等。orders.created_at / payments.reserved_until 都是无校验的 TEXT 列，
// 非 canonical 值一律视为数据库不变量破坏 → fail closed。
function requireIsoInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Order database invariant failed");
  }
  return value;
}

// pending 订单公开的 reservedUntil：与 publicReservedUntil 同一套 round-trip 校验，
// 但作用于列表行（无 StoredOrder）。非法即数据异常 → fail closed。
function requirePublicReservedUntil(value: string | null): string {
  if (value === null) {
    throw new Error("Order database invariant failed");
  }
  return requireIsoInstant(value);
}

/* 登录用户订单列表。所有权在 SQL 层用 orders.user_id = ? 限定，绝不取全表再过滤；
   不读取 order_access_tokens，不触碰支付宝。字段严格限定为冻结公开契约，
   contact / scenarios / notes / trade_no / out_trade_no / payment_id / service_id /
   user_id / 内部 ID / 交付内容一律不出现在结果中。
   状态语义与 GET /api/pay/orders/:orderRef 一致：
   pending → reservedUntil 有效 ISO 且 serviceStatus 必为 null；
   paid    → reservedUntil 归 null 且 serviceStatus 必为 pending_open|open；
   closed  → reservedUntil 归 null 且 serviceStatus 必为 null。
   任一行不满足即数据异常，向上抛出由路由 fail closed 成 503。 */
export function listMyOrders(
  database: DatabaseConnection,
  userId: number,
): MyOrderItem[] {
  const rows = database
    .prepare(
      `SELECT orders.order_ref, orders.type_id, orders.region_id, orders.isp_id,
              orders.spec_id, orders.duration_id, orders.status AS order_status,
              orders.amount_fen, orders.currency, orders.created_at,
              payments.reserved_until,
              services.status AS service_status
       FROM orders
       JOIN payments ON payments.order_id = orders.id
       LEFT JOIN services ON services.payment_id = payments.id
       WHERE orders.user_id = ?
       ORDER BY orders.created_at DESC, orders.id DESC`,
    )
    .all(userId);
  return rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("Order database invariant failed");
    }
    const value = row as Record<string, unknown>;
    const status = rowString(value, "order_status");
    const rawServiceStatus = rowNullableString(value, "service_status");
    const rawReservedUntil = rowNullableString(value, "reserved_until");
    const amountFen = rowNumber(value, "amount_fen");
    if (
      (status !== "pending" && status !== "paid" && status !== "closed") ||
      (rawServiceStatus !== null &&
        rawServiceStatus !== "pending_open" &&
        rawServiceStatus !== "open") ||
      !Number.isSafeInteger(amountFen) ||
      amountFen <= 0 ||
      rowString(value, "currency") !== "CNY"
    ) {
      throw new Error("Order database invariant failed");
    }

    let reservedUntil: string | null;
    let serviceStatus: ServiceStatus | null;
    if (status === "pending") {
      if (rawServiceStatus !== null) {
        throw new Error("Order database invariant failed");
      }
      reservedUntil = requirePublicReservedUntil(rawReservedUntil);
      serviceStatus = null;
    } else if (status === "paid") {
      if (rawServiceStatus === null) {
        throw new Error("Order database invariant failed");
      }
      reservedUntil = null;
      serviceStatus = rawServiceStatus;
    } else {
      if (rawServiceStatus !== null) {
        throw new Error("Order database invariant failed");
      }
      reservedUntil = null;
      serviceStatus = null;
    }

    return {
      orderRef: rowString(value, "order_ref"),
      typeId: rowString(value, "type_id"),
      regionId: rowString(value, "region_id"),
      ispId: rowString(value, "isp_id"),
      specId: rowNullableString(value, "spec_id"),
      durationId: rowString(value, "duration_id"),
      status,
      amountFen,
      currency: "CNY" as const,
      createdAt: requireIsoInstant(rowString(value, "created_at")),
      reservedUntil,
      serviceStatus,
    };
  });
}

export interface AdminPendingServiceItem {
  readonly serviceId: number;
  readonly orderRef: string;
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly amountFen: number;
  readonly contact: string;
  readonly scenarios: readonly string[];
  readonly notes: string | null;
  readonly createdAt: string;
}

export function listPendingServicesForAdmin(
  database: DatabaseConnection,
): AdminPendingServiceItem[] {
  return database
    .prepare(
      `SELECT services.id AS service_id, orders.order_ref,
              orders.type_id, orders.region_id, orders.isp_id, orders.spec_id,
              orders.duration_id, orders.amount_fen, orders.contact,
              orders.scenarios, orders.notes, services.created_at
       FROM services
       JOIN payments ON payments.id = services.payment_id
       JOIN orders ON orders.id = payments.order_id
       WHERE services.status = 'pending_open'
       ORDER BY services.id ASC`,
    )
    .all()
    .map((row) => {
      if (typeof row !== "object" || row === null) {
        throw new Error("Admin service database invariant failed");
      }
      const value = row as Record<string, unknown>;
      return {
        serviceId: rowNumber(value, "service_id"),
        orderRef: rowString(value, "order_ref"),
        typeId: rowString(value, "type_id"),
        regionId: rowString(value, "region_id"),
        ispId: rowString(value, "isp_id"),
        specId: rowNullableString(value, "spec_id"),
        durationId: rowString(value, "duration_id"),
        amountFen: rowNumber(value, "amount_fen"),
        contact: rowString(value, "contact"),
        scenarios: parseScenarios(value.scenarios),
        notes: rowNullableString(value, "notes"),
        createdAt: rowString(value, "created_at"),
      };
    });
}

export function openService(
  database: DatabaseConnection,
  input: {
    readonly serviceId: number;
    readonly adminUserId: number;
    readonly adminEmail: string;
    readonly items: readonly EncryptedServiceDeliveryItem[];
    readonly now?: () => Date;
  },
): {
  readonly id: number;
  readonly status: "open";
  readonly openedAt: string;
  readonly items: ReadonlyArray<{
    readonly position: number;
    readonly label: string;
    readonly monitorTargetKey: string | null;
  }>;
} {
  if (
    input.items.length < 1 ||
    input.items.length > DELIVERY_MAX_ITEMS ||
    input.items.some(
      (item, index) =>
        item.position !== index + 1 ||
        item.label.trim().length === 0,
    )
  ) {
    throw new PaymentDomainError(400, "invalid_item");
  }
  const operation = database.transaction(() => {
    const rows = database
      .prepare(
        `SELECT services.status, orders.order_ref, orders.id AS order_id
         FROM services
         JOIN payments ON payments.id = services.payment_id
         JOIN orders ON orders.id = payments.order_id
         WHERE services.id = ?`,
      )
      .all(input.serviceId);
    if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
      throw new PaymentDomainError(404, "not_found");
    }
    const row = rows[0] as Record<string, unknown>;
    if (row.status !== "pending_open") {
      throw new PaymentDomainError(409, "invalid_transition");
    }
    /* Management closure/termination is authoritative and checked against this
       service's real order inside the same transaction — a closed service can
       never be opened through any caller. Missing wallet tables surface as a
       real error (503 at the route), never a silent pass. Zero writes on deny. */
    const orderId = row.order_id;
    const closed = typeof orderId === "number" &&
      database.prepare("SELECT order_id FROM wallet_order_closures WHERE order_id = ?").all(orderId).length > 0;
    const terminated =
      database.prepare("SELECT service_id FROM wallet_termination_cases WHERE service_id = ?").all(input.serviceId).length > 0;
    if (closed || terminated) {
      throw new PaymentDomainError(409, "service_closed");
    }
    const now = (input.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Service time source is invalid");
    }
    const openedAt = now.toISOString();
    const updated = database
      .prepare(
        `UPDATE services
         SET status = 'open', opened_by_admin_id = ?, opened_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending_open'`,
      )
      .run(input.adminUserId, openedAt, openedAt, input.serviceId);
    if (updated.changes !== 1) {
      throw new PaymentDomainError(409, "invalid_transition");
    }
    const insertDeliveryItem = database.prepare(
      `INSERT INTO service_delivery_items (
         service_id, position, label, monitor_target_key,
         key_version, nonce, ciphertext, tag,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of input.items) {
      insertDeliveryItem.run(
        input.serviceId,
        item.position,
        item.label,
        item.monitorTargetKey,
        item.keyVersion,
        item.nonce,
        item.ciphertext,
        item.tag,
        openedAt,
        openedAt,
      );
    }
    database
      .prepare(
        `INSERT INTO audit_log (actor, action, target_ref, created_at)
         VALUES (?, 'service.open', ?, ?)`,
      )
      .run(input.adminEmail, rowString(row, "order_ref"), openedAt);
    // Opened while the monitor catalog was unavailable: record that some lines still need a VPS binding.
    if (input.items.some((item) => item.monitorTargetKey === null)) {
      database
        .prepare(
          `INSERT INTO audit_log (actor, action, target_ref, created_at)
           VALUES (?, 'service.delivery_unbound', ?, ?)`,
        )
        .run(input.adminEmail, rowString(row, "order_ref"), openedAt);
    }
    return {
      id: input.serviceId,
      status: "open" as const,
      openedAt,
      items: input.items.map(({ position, label, monitorTargetKey }) => ({
        position,
        label,
        monitorTargetKey,
      })),
    };
  });
  return operation.immediate();
}

import type { CatalogSelection } from "./resolveSelection";

export const PAYMENT_MAX_SINGLE_FEN_FRONTEND = 200_000;

const STORAGE_PREFIX = "nsp.payment.v1";
const CHECKOUT_ATTEMPT_KEY = `${STORAGE_PREFIX}.checkout-attempt`;
const RETRY_ATTEMPT_KEY = `${STORAGE_PREFIX}.retry-attempt`;
const LAST_ORDER_REF_KEY = `${STORAGE_PREFIX}.last-order`;
const ORDER_STORAGE_PREFIX = `${STORAGE_PREFIX}.order.`;
const ATTEMPT_TTL_MS = 30 * 60 * 1_000;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_REF_PATTERN = /^DL[A-Za-z0-9]{1,64}$/;
const DELIVERY_MAX_ITEMS = 20;
const DELIVERY_MAX_LABEL_LENGTH = 200;
const DELIVERY_MAX_URL_BYTES = 2048;
const MONITOR_TARGET_KEY_MAX_LENGTH = 128;
const MONITOR_TARGET_LABEL_MAX_LENGTH = 200;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

type JsonRecord = Record<string, unknown>;

export type PaymentOrderStatus = "pending" | "paid" | "closed";
export type ServiceStatus = "pending_open" | "open";

export type ServiceDeliveryItem = {
  readonly position: number;
  readonly label: string;
  readonly subscriptionUrl: string;
};

export type DeliveryItemInput = {
  readonly label: string;
  readonly subscriptionUrl: string;
  readonly monitorTargetKey: string;
};

export type RequirementDraft = {
  readonly selection: CatalogSelection;
  readonly contact: string;
  readonly scenarios: string[];
  readonly notes: string;
  readonly acknowledgedAmountFen: number;
  readonly couponCode: string | null;
};

export type QuoteResult = {
  readonly listPriceFen: number;
  readonly discountFen: number;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly couponCode: string | null;
};

const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

/* 与 auth-service 完全一致的规范化：trim + 大写。四处必须统一——订单请求体、
   RequirementDraft、checkout 幂等指纹、服务端 request fingerprint——本函数是前三处的唯一入口。 */
export function normalizeCouponCode(raw: string): string | null {
  const normalized = raw.trim().toUpperCase();
  return normalized === "" ? null : normalized;
}

export function isValidCouponCode(code: string): boolean {
  return COUPON_CODE_PATTERN.test(code);
}

export type OrderCredentials = {
  readonly idempotencyKey: string;
  readonly accessToken: string;
};

/* 创建 / 重试 / 获取电脑网站支付页（POST :orderRef/pay-page）三处同一冻结结构。
   payUrl 仅在 pending 时有值，只留在内存并用于导航，绝不写入本站 URL / localStorage / 日志。 */
export type PaymentOrderResult = {
  readonly orderRef: string;
  readonly status: PaymentOrderStatus;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly reservedUntil: string | null;
  readonly payUrl: string | null;
  // 当面付二维码内容（增量字段）：仅当后端预下单成功时存在，否则为 null。
  readonly qrCode: string | null;
};

// 只接受支付宝官方二维码域名；其他值一律视为无效响应。
const ALIPAY_QR_CODE_PATTERN = /^https:\/\/qr\.alipay\.com\/[A-Za-z0-9]+$/;

function parseOptionalQrCode(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !ALIPAY_QR_CODE_PATTERN.test(value)) {
    throw new PaymentApiError("invalid_response");
  }
  return value;
}

export type PaymentOrderSnapshot = {
  readonly orderRef: string;
  readonly status: PaymentOrderStatus;
  readonly amountFen: number;
  readonly currency: "CNY";
  // GET 快照新增 reservedUntil（不返回二维码）；旧后端缺省时按 null 兜底。
  readonly reservedUntil: string | null;
  readonly service: {
    readonly status: ServiceStatus;
    readonly items?: readonly ServiceDeliveryItem[];
  } | null;
};

export type MyServiceItem = {
  readonly orderRef: string;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly orderStatus: PaymentOrderStatus;
  readonly serviceStatus: ServiceStatus;
  readonly createdAt: string;
  /** Admin-set expiry; null = long-term. */
  readonly endsAt: string | null;
  /** Admin plan-name override; null = no override. */
  readonly planLabel: string | null;
};

/** An admin gift (no order or payment behind it). */
export type MyGrantItem = {
  readonly grantId: number;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
};

export type MyServiceListing = {
  readonly services: readonly MyServiceItem[];
  readonly grants: readonly MyGrantItem[];
};

export type MyDeliveryLineItem = {
  readonly orderRef: string;
  readonly position: number;
  readonly label: string;
};

export type AdminMonitorTarget = {
  readonly key: string;
  readonly label: string;
  readonly state: "active" | "disabled" | "retired";
};

// GET /api/me/orders 单项。字段严格对应冻结后端契约；serviceStatus 可为 null（无服务）。
export type MyOrderItem = {
  readonly orderRef: string;
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly status: PaymentOrderStatus;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly createdAt: string;
  readonly reservedUntil: string | null;
  readonly serviceStatus: ServiceStatus | null;
};

export type AdminPendingServiceItem = {
  readonly serviceId: number;
  readonly orderRef: string;
  readonly amountFen: number;
  readonly contact: string;
  readonly scenarios: string[];
  readonly notes: string | null;
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly createdAt: string;
};

export type OpenServiceResult = {
  readonly id: number;
  readonly status: "open";
  readonly openedAt: string;
  readonly items: ReadonlyArray<{
    readonly position: number;
    readonly label: string;
    readonly monitorTargetKey: string;
  }>;
};

export class PaymentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentAmountFen: number | null;
  readonly maxSingleFen: number | null;

  constructor(
    code: string,
    status = 0,
    details: { readonly currentAmountFen?: number; readonly maxSingleFen?: number } = {},
  ) {
    super(code);
    this.name = "PaymentApiError";
    this.status = status;
    this.code = code;
    this.currentAmountFen = details.currentAmountFen ?? null;
    this.maxSingleFen = details.maxSingleFen ?? null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isPaymentOrderStatus(value: unknown): value is PaymentOrderStatus {
  return value === "pending" || value === "paid" || value === "closed";
}

function isServiceStatus(value: unknown): value is ServiceStatus {
  return value === "pending_open" || value === "open";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIsoInstant(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

// canonical ISO instant：不仅可解析，且必须与 toISOString() 逐字符相等（round-trip）。
// 仅供 GET /api/me/orders 解析使用，不改动全局 isIsoInstant，避免影响其他支付流程。
function isCanonicalIsoInstant(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isAbsoluteHttpsUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function normalizeMonitorTargetKey(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > MONITOR_TARGET_KEY_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeDeliveryPayload(
  value: unknown,
): Pick<DeliveryItemInput, "label" | "subscriptionUrl"> | null {
  if (!isRecord(value)) return null;
  const { label, subscriptionUrl } = value;
  if (typeof label !== "string" || typeof subscriptionUrl !== "string") return null;
  const normalizedLabel = label.trim();
  if (normalizedLabel.length === 0 || normalizedLabel.length > DELIVERY_MAX_LABEL_LENGTH) return null;
  if (
    subscriptionUrl.length === 0 ||
    subscriptionUrl !== subscriptionUrl.trim() ||
    new TextEncoder().encode(subscriptionUrl).byteLength > DELIVERY_MAX_URL_BYTES
  ) {
    return null;
  }
  try {
    if (new URL(subscriptionUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { label: normalizedLabel, subscriptionUrl };
}

export function normalizeDeliveryItemInput(value: unknown): DeliveryItemInput | null {
  const payload = normalizeDeliveryPayload(value);
  if (payload === null || !isRecord(value)) return null;
  const monitorTargetKey = normalizeMonitorTargetKey(value.monitorTargetKey);
  return monitorTargetKey === null
    ? null
    : { ...payload, monitorTargetKey };
}

function parseDeliveryItems(value: unknown): readonly ServiceDeliveryItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > DELIVERY_MAX_ITEMS) {
    throw new PaymentApiError("invalid_response");
  }
  return value.map((rawItem, index) => {
    const item = requireRecord(rawItem);
    const normalized = normalizeDeliveryPayload(item);
    if (
      !hasExactKeys(item, ["position", "label", "subscriptionUrl"]) ||
      item.position !== index + 1 ||
      normalized === null
    ) {
      throw new PaymentApiError("invalid_response");
    }
    return {
      position: item.position,
      ...normalized,
    };
  });
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new PaymentApiError("invalid_response");
  return value;
}

function parseOrderResult(value: unknown): PaymentOrderResult {
  const body = requireRecord(value);
  if (
    !isNonEmptyString(body.orderRef) ||
    !isPaymentOrderStatus(body.status) ||
    !isPositiveInteger(body.amountFen) ||
    body.currency !== "CNY"
  ) {
    throw new PaymentApiError("invalid_response");
  }

  // pending 必须带绝对失效时刻与 HTTPS 支付页；paid/closed 两者一律为 null。
  if (body.status === "pending") {
    if (!isIsoInstant(body.reservedUntil) || !isAbsoluteHttpsUrl(body.payUrl)) {
      throw new PaymentApiError("invalid_response");
    }
    return {
      orderRef: body.orderRef,
      status: body.status,
      amountFen: body.amountFen,
      currency: "CNY",
      reservedUntil: body.reservedUntil,
      payUrl: body.payUrl,
      qrCode: parseOptionalQrCode(body.qrCode),
    };
  }

  if (body.payUrl !== null) throw new PaymentApiError("invalid_response");

  return {
    orderRef: body.orderRef,
    status: body.status,
    amountFen: body.amountFen,
    currency: "CNY",
    reservedUntil: null,
    payUrl: null,
    qrCode: null,
  };
}

function parseOrderSnapshot(value: unknown): PaymentOrderSnapshot {
  const body = requireRecord(value);
  let service: PaymentOrderSnapshot["service"] = null;
  if (body.service !== null) {
    const serviceBody = requireRecord(body.service);
    if (!isServiceStatus(serviceBody.status)) throw new PaymentApiError("invalid_response");
    if (serviceBody.status === "pending_open" && serviceBody.items !== undefined) {
      throw new PaymentApiError("invalid_response");
    }
    service = serviceBody.items === undefined
      ? { status: serviceBody.status }
      : { status: serviceBody.status, items: parseDeliveryItems(serviceBody.items) };
  }

  if (
    !isNonEmptyString(body.orderRef) ||
    !isPaymentOrderStatus(body.status) ||
    !isPositiveInteger(body.amountFen) ||
    body.currency !== "CNY"
  ) {
    throw new PaymentApiError("invalid_response");
  }

  return {
    orderRef: body.orderRef,
    status: body.status,
    amountFen: body.amountFen,
    currency: body.currency,
    reservedUntil: isIsoInstant(body.reservedUntil) ? body.reservedUntil : null,
    service,
  };
}

function isNullableIsoInstant(value: unknown): value is string | null {
  return value === null || isIsoInstant(value);
}

function parseMyServiceListing(value: unknown): MyServiceListing {
  const body = requireRecord(value);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");
  const services: MyServiceItem[] = [];
  const grants: MyGrantItem[] = [];
  for (const rawItem of body.items) {
    const item = requireRecord(rawItem);
    if (item.source === "grant") {
      if (
        typeof item.grantId !== "number" ||
        !Number.isSafeInteger(item.grantId) ||
        !isNonEmptyString(item.label) ||
        !isIsoInstant(item.startsAt) ||
        !isNullableIsoInstant(item.endsAt) ||
        item.status !== "active"
      ) {
        throw new PaymentApiError("invalid_response");
      }
      grants.push({ grantId: item.grantId, label: item.label, startsAt: item.startsAt, endsAt: item.endsAt });
      continue;
    }
    // Purchases; servers before Migration 022 send no source / endsAt / planLabel.
    if (item.source !== undefined && item.source !== "purchase") throw new PaymentApiError("invalid_response");
    services.push(parseMyServiceItem(item));
  }
  return { services, grants };
}

function parseMyServiceItem(item: Record<string, unknown>): MyServiceItem {
  const endsAt = item.endsAt === undefined ? null : item.endsAt;
  const planLabel = item.planLabel === undefined ? null : item.planLabel;
  if (
    !isNullableIsoInstant(endsAt) ||
    (planLabel !== null && !isNonEmptyString(planLabel)) ||
    !isNonEmptyString(item.orderRef) ||
    !isPositiveInteger(item.amountFen) ||
    item.currency !== "CNY" ||
    !isPaymentOrderStatus(item.orderStatus) ||
    !isServiceStatus(item.serviceStatus) ||
    !isNonEmptyString(item.createdAt)
  ) {
    throw new PaymentApiError("invalid_response");
  }
  return {
    orderRef: item.orderRef,
    amountFen: item.amountFen,
    currency: item.currency,
    orderStatus: item.orderStatus,
    serviceStatus: item.serviceStatus,
    createdAt: item.createdAt,
    endsAt,
    planLabel: planLabel as string | null,
  };
}

function parseMyDeliveryLines(value: unknown): MyDeliveryLineItem[] {
  const body = requireRecord(value);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");

  return body.items.map((rawItem) => {
    const item = requireRecord(rawItem);
    if (
      !hasExactKeys(item, ["orderRef", "position", "label"]) ||
      !isNonEmptyString(item.orderRef) ||
      !isPositiveInteger(item.position) ||
      !isNonEmptyString(item.label) ||
      item.label !== item.label.trim() ||
      item.label.length > DELIVERY_MAX_LABEL_LENGTH
    ) {
      throw new PaymentApiError("invalid_response");
    }
    return {
      orderRef: item.orderRef,
      position: item.position,
      label: item.label,
    };
  });
}

/* 严格解析 GET /api/me/orders：每个字段的类型与枚举都必须精确匹配冻结契约。
   任何未知 status / serviceStatus 值、缺字段、非 ISO 时间一律判为 invalid_response，
   绝不静默接受并展示。不在前端重排：保持后端 createdAt DESC / id DESC 顺序。 */
function parseMyOrders(value: unknown): MyOrderItem[] {
  const body = requireRecord(value);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");

  return body.items.map((rawItem) => {
    const item = requireRecord(rawItem);
    if (
      !isNonEmptyString(item.orderRef) ||
      !isNonEmptyString(item.typeId) ||
      !isNonEmptyString(item.regionId) ||
      !isNonEmptyString(item.ispId) ||
      !(item.specId === null || isNonEmptyString(item.specId)) ||
      !isNonEmptyString(item.durationId) ||
      !isPaymentOrderStatus(item.status) ||
      !isPositiveInteger(item.amountFen) ||
      item.currency !== "CNY" ||
      !isCanonicalIsoInstant(item.createdAt) ||
      !(item.reservedUntil === null || isCanonicalIsoInstant(item.reservedUntil)) ||
      !(item.serviceStatus === null || isServiceStatus(item.serviceStatus))
    ) {
      throw new PaymentApiError("invalid_response");
    }
    // 冻结状态组合校验；任何不符合的组合都是数据异常，绝不静默修正或降级显示。
    // pending: reservedUntil 必为 canonical ISO 且 serviceStatus 必为 null。
    // paid:    reservedUntil 必为 null 且 serviceStatus 必为 pending_open|open。
    // closed:  reservedUntil 必为 null 且 serviceStatus 必为 null。
    if (
      (item.status === "pending" && (item.reservedUntil === null || item.serviceStatus !== null)) ||
      (item.status === "paid" && (item.reservedUntil !== null || item.serviceStatus === null)) ||
      (item.status === "closed" && (item.reservedUntil !== null || item.serviceStatus !== null))
    ) {
      throw new PaymentApiError("invalid_response");
    }
    return {
      orderRef: item.orderRef,
      typeId: item.typeId,
      regionId: item.regionId,
      ispId: item.ispId,
      specId: item.specId,
      durationId: item.durationId,
      status: item.status,
      amountFen: item.amountFen,
      currency: item.currency,
      createdAt: item.createdAt,
      reservedUntil: item.reservedUntil,
      serviceStatus: item.serviceStatus,
    };
  });
}

function parseAdminPendingServices(value: unknown): AdminPendingServiceItem[] {
  const body = requireRecord(value);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");

  return body.items.map((rawItem) => {
    const item = requireRecord(rawItem);
    if (
      !isPositiveInteger(item.serviceId) ||
      !isNonEmptyString(item.orderRef) ||
      !isPositiveInteger(item.amountFen) ||
      !isNonEmptyString(item.contact) ||
      !isStringArray(item.scenarios) ||
      !(item.notes === null || typeof item.notes === "string") ||
      !isNonEmptyString(item.typeId) ||
      !isNonEmptyString(item.regionId) ||
      !isNonEmptyString(item.ispId) ||
      !(item.specId === null || typeof item.specId === "string") ||
      !isNonEmptyString(item.durationId) ||
      !isNonEmptyString(item.createdAt)
    ) {
      throw new PaymentApiError("invalid_response");
    }
    return {
      serviceId: item.serviceId,
      orderRef: item.orderRef,
      amountFen: item.amountFen,
      contact: item.contact,
      scenarios: item.scenarios,
      notes: item.notes,
      typeId: item.typeId,
      regionId: item.regionId,
      ispId: item.ispId,
      specId: item.specId,
      durationId: item.durationId,
      createdAt: item.createdAt,
    };
  });
}

export function parseAdminMonitorTargets(value: unknown): AdminMonitorTarget[] {
  const body = requireRecord(value);
  if (!Array.isArray(body.items) || body.items.length > 100) {
    throw new PaymentApiError("invalid_response");
  }
  const seen = new Set<string>();
  return body.items.map((rawItem) => {
    const item = requireRecord(rawItem);
    const key = normalizeMonitorTargetKey(item.key);
    const state = item.state === undefined ? "active" : item.state;
    if (
      key === null ||
      typeof item.label !== "string" ||
      item.label.trim() !== item.label ||
      item.label.length < 1 ||
      item.label.length > MONITOR_TARGET_LABEL_MAX_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(item.label) ||
      (state !== "active" && state !== "disabled" && state !== "retired") ||
      seen.has(key)
    ) {
      throw new PaymentApiError("invalid_response");
    }
    seen.add(key);
    return { key, label: item.label, state };
  });
}

function parseOpenService(value: unknown): OpenServiceResult {
  const body = requireRecord(value);
  if (
    !isPositiveInteger(body.id) ||
    body.status !== "open" ||
    !isNonEmptyString(body.openedAt) ||
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > DELIVERY_MAX_ITEMS
  ) {
    throw new PaymentApiError("invalid_response");
  }
  const items = body.items.map((rawItem, index) => {
    const item = requireRecord(rawItem);
    const monitorTargetKey = normalizeMonitorTargetKey(item.monitorTargetKey);
    if (
      item.position !== index + 1 ||
      typeof item.label !== "string" ||
      item.label.length === 0 ||
      item.label !== item.label.trim() ||
      item.label.length > DELIVERY_MAX_LABEL_LENGTH ||
      monitorTargetKey === null
    ) {
      throw new PaymentApiError("invalid_response");
    }
    return {
      position: item.position,
      label: item.label,
      monitorTargetKey,
    };
  });
  return { id: body.id, status: body.status, openedAt: body.openedAt, items };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PaymentApiError("invalid_response", response.status);
  }
}

function errorFromResponse(status: number, value: unknown): PaymentApiError {
  if (!isRecord(value) || !isRecord(value.error) || !isNonEmptyString(value.error.code)) {
    return new PaymentApiError("request_failed", status);
  }
  return new PaymentApiError(value.error.code, status, {
    currentAmountFen: isNonNegativeInteger(value.error.currentAmountFen)
      ? value.error.currentAmountFen
      : undefined,
    maxSingleFen: isNonNegativeInteger(value.error.maxSingleFen)
      ? value.error.maxSingleFen
      : undefined,
  });
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin" });
  } catch {
    throw new PaymentApiError("network_error");
  }

  const body = await readJson(response);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return body;
}

function mutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    ...extra,
  };
}

function orderBody(draft: RequirementDraft): JsonRecord {
  return {
    typeId: draft.selection.typeId,
    regionId: draft.selection.regionId,
    ispId: draft.selection.ispId,
    specId: draft.selection.specId,
    durationId: draft.selection.durationId,
    contact: draft.contact,
    scenarios: draft.scenarios,
    notes: draft.notes.trim() === "" ? null : draft.notes,
    acknowledgedAmountFen: draft.acknowledgedAmountFen,
    couponCode: draft.couponCode,
  };
}

function parseQuoteResult(value: unknown): QuoteResult {
  const body = requireRecord(value);
  if (
    !isNonNegativeInteger(body.listPriceFen) ||
    !isNonNegativeInteger(body.discountFen) ||
    !isPositiveInteger(body.amountFen) ||
    body.currency !== "CNY" ||
    !(body.couponCode === null || isNonEmptyString(body.couponCode))
  ) {
    throw new PaymentApiError("invalid_response");
  }
  return {
    listPriceFen: body.listPriceFen,
    discountFen: body.discountFen,
    amountFen: body.amountFen,
    currency: body.currency,
    couponCode: body.couponCode === null ? null : body.couponCode,
  };
}

export async function getQuote(
  selection: CatalogSelection,
  couponCode: string | null,
): Promise<QuoteResult> {
  const response = await requestJson("/api/pay/quote", {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify({
      typeId: selection.typeId,
      regionId: selection.regionId,
      ispId: selection.ispId,
      specId: selection.specId,
      durationId: selection.durationId,
      couponCode,
    }),
  });
  return parseQuoteResult(response);
}

/* 新建订单与重新支付都会生成新订单：必须登录，并携带 /api/auth/me 下发的 Session 绑定 CSRF 令牌。 */
export async function createPaymentOrder(
  draft: RequirementDraft,
  credentials: OrderCredentials,
  csrfToken: string,
): Promise<PaymentOrderResult> {
  const response = await requestJson("/api/pay/orders", {
    method: "POST",
    headers: mutationHeaders({
      "Idempotency-Key": credentials.idempotencyKey,
      "X-Order-Access-Token": credentials.accessToken,
      "X-CSRF-Token": csrfToken,
    }),
    body: JSON.stringify(orderBody(draft)),
  });
  return parseOrderResult(response);
}

export async function retryPaymentOrder(
  orderRef: string,
  currentAccessToken: string | null,
  newCredentials: OrderCredentials,
  csrfToken: string,
): Promise<PaymentOrderResult> {
  const headers: Record<string, string> = {
    "Idempotency-Key": newCredentials.idempotencyKey,
    "X-New-Order-Access-Token": newCredentials.accessToken,
    "X-CSRF-Token": csrfToken,
  };
  if (currentAccessToken !== null) headers["X-Order-Access-Token"] = currentAccessToken;
  const response = await requestJson(`/api/pay/orders/${encodeURIComponent(orderRef)}/retry`, {
    method: "POST",
    headers: mutationHeaders(headers),
    body: "{}",
  });
  return parseOrderResult(response);
}

/* pending 订单在有效期内重新获取同一 out_trade_no 的电脑网站支付页。
   后端幂等，不新建支付记录、不重复收款。返回与创建/重试完全一致的冻结结构。 */
export async function refreshOrderPayPage(
  orderRef: string,
  accessToken: string | null,
): Promise<PaymentOrderResult> {
  const headers: Record<string, string> = {};
  if (accessToken !== null) headers["X-Order-Access-Token"] = accessToken;
  const response = await requestJson(`/api/pay/orders/${encodeURIComponent(orderRef)}/pay-page`, {
    method: "POST",
    headers: mutationHeaders(headers),
    body: "{}",
  });
  return parseOrderResult(response);
}

export async function getPaymentOrder(
  orderRef: string,
  accessToken: string | null,
  signal?: AbortSignal,
): Promise<PaymentOrderSnapshot> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessToken !== null) headers["X-Order-Access-Token"] = accessToken;
  const response = await requestJson(`/api/pay/orders/${encodeURIComponent(orderRef)}`, {
    method: "GET",
    headers,
    signal,
  });
  return parseOrderSnapshot(response);
}

/** Purchased services only (dashboard and network pages). */
export async function getMyServices(signal?: AbortSignal): Promise<MyServiceItem[]> {
  return [...(await getMyServiceListing(signal)).services];
}

/** Purchased services plus active admin gifts (the "My plans" page). */
export async function getMyServiceListing(signal?: AbortSignal): Promise<MyServiceListing> {
  const response = await requestJson("/api/me/services", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return parseMyServiceListing(response);
}

export async function getMyDeliveryLines(signal?: AbortSignal): Promise<MyDeliveryLineItem[]> {
  const response = await requestJson("/api/me/delivery-lines", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return parseMyDeliveryLines(response);
}

export async function getMyOrders(signal?: AbortSignal): Promise<MyOrderItem[]> {
  const response = await requestJson("/api/me/orders", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return parseMyOrders(response);
}

export async function getAdminPendingServices(signal?: AbortSignal): Promise<AdminPendingServiceItem[]> {
  const response = await requestJson("/api/admin/services?status=pending_open", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return parseAdminPendingServices(response);
}

export async function getAdminMonitorTargets(signal?: AbortSignal): Promise<AdminMonitorTarget[]> {
  const response = await requestJson("/api/admin/monitor-targets", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return parseAdminMonitorTargets(response);
}

export async function openAdminService(
  serviceId: number,
  csrfToken: string,
  items: readonly DeliveryItemInput[],
): Promise<OpenServiceResult> {
  if (
    items.length < 1 ||
    items.length > DELIVERY_MAX_ITEMS ||
    items.some((item) => normalizeDeliveryItemInput(item) === null)
  ) {
    throw new PaymentApiError("invalid_item", 400);
  }
  const response = await requestJson(`/api/admin/services/${serviceId}/open`, {
    method: "POST",
    headers: mutationHeaders({ "X-CSRF-Token": csrfToken }),
    body: JSON.stringify({ items: items.map((item) => normalizeDeliveryItemInput(item)) }),
  });
  return parseOpenService(response);
}

function storage(): Storage {
  try {
    const target = window.localStorage;
    const probe = `${STORAGE_PREFIX}.probe`;
    target.setItem(probe, "1");
    target.removeItem(probe);
    return target;
  } catch {
    throw new PaymentApiError("storage_unavailable");
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function createOrderCredentials(): OrderCredentials {
  return {
    idempotencyKey: window.crypto.randomUUID(),
    accessToken: generateAccessToken(),
  };
}

function parseCredentials(value: unknown): OrderCredentials | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.idempotencyKey) ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !isNonEmptyString(value.accessToken) ||
    !ACCESS_TOKEN_PATTERN.test(value.accessToken)
  ) {
    return null;
  }
  return { idempotencyKey: value.idempotencyKey, accessToken: value.accessToken };
}

function isFreshSavedAt(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const savedAt = Date.parse(value);
  const age = Date.now() - savedAt;
  return Number.isFinite(savedAt) && age >= 0 && age <= ATTEMPT_TTL_MS;
}

function credentialsEqual(left: OrderCredentials, right: OrderCredentials): boolean {
  return left.idempotencyKey === right.idempotencyKey && left.accessToken === right.accessToken;
}

function readAttemptRecord(target: Storage, key: string): JsonRecord | null {
  const raw = target.getItem(key);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 2 || !isFreshSavedAt(value.savedAt)) {
      target.removeItem(key);
      return null;
    }
    return value;
  } catch {
    target.removeItem(key);
    return null;
  }
}

function cleanupLegacyAttemptRecords(target: Storage): void {
  const keysToRemove: string[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (
      key?.startsWith(`${STORAGE_PREFIX}.attempt.`) ||
      key?.startsWith(`${STORAGE_PREFIX}.retry.`)
    ) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) target.removeItem(key);
}

async function checkoutFingerprint(draft: RequirementDraft): Promise<string> {
  const canonical = JSON.stringify({
    selection: {
      typeId: draft.selection.typeId,
      regionId: draft.selection.regionId,
      ispId: draft.selection.ispId,
      specId: draft.selection.specId,
      durationId: draft.selection.durationId,
    },
    contact: draft.contact.trim(),
    scenarios: [...draft.scenarios].sort(),
    notes: draft.notes.trim(),
    acknowledgedAmountFen: draft.acknowledgedAmountFen,
    couponCode: draft.couponCode,
  });
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64Url(new Uint8Array(digest));
}

export async function getOrCreateCheckoutAttempt(draft: RequirementDraft): Promise<OrderCredentials> {
  const fingerprint = await checkoutFingerprint(draft);
  const target = storage();
  cleanupLegacyAttemptRecords(target);
  const current = readAttemptRecord(target, CHECKOUT_ATTEMPT_KEY);
  const currentCredentials = current === null ? null : parseCredentials(current.credentials);
  if (
    currentCredentials !== null &&
    isNonEmptyString(current?.fingerprint) &&
    current.fingerprint === fingerprint
  ) {
    return currentCredentials;
  }

  const credentials = createOrderCredentials();
  target.setItem(
    CHECKOUT_ATTEMPT_KEY,
    JSON.stringify({ version: 2, fingerprint, credentials, savedAt: new Date().toISOString() }),
  );
  return credentials;
}

export function getOrCreateRetryAttempt(orderRef: string): OrderCredentials {
  const target = storage();
  cleanupLegacyAttemptRecords(target);
  const current = readAttemptRecord(target, RETRY_ATTEMPT_KEY);
  const currentCredentials = current === null ? null : parseCredentials(current.credentials);
  if (currentCredentials !== null && current?.orderRef === orderRef) {
    return currentCredentials;
  }

  const credentials = createOrderCredentials();
  target.setItem(
    RETRY_ATTEMPT_KEY,
    JSON.stringify({ version: 2, orderRef, credentials, savedAt: new Date().toISOString() }),
  );
  return credentials;
}

function clearMatchingAttempt(target: Storage, key: string, credentials: OrderCredentials): void {
  const current = readAttemptRecord(target, key);
  const currentCredentials = current === null ? null : parseCredentials(current.credentials);
  if (currentCredentials === null || credentialsEqual(currentCredentials, credentials)) {
    target.removeItem(key);
  }
  // 清理本实现早期按幂等键保存的同一条记录，避免旧草稿继续留存。
  target.removeItem(`${STORAGE_PREFIX}.attempt.${credentials.idempotencyKey}`);
  target.removeItem(`${STORAGE_PREFIX}.retry.${credentials.idempotencyKey}`);
}

export function clearCheckoutAttempt(credentials: OrderCredentials): void {
  clearMatchingAttempt(storage(), CHECKOUT_ATTEMPT_KEY, credentials);
}

export function clearRetryAttempt(credentials: OrderCredentials): void {
  clearMatchingAttempt(storage(), RETRY_ATTEMPT_KEY, credentials);
}

export function shouldClearAttemptAfterError(error: unknown): boolean {
  return (
    error instanceof PaymentApiError &&
    error.code !== "network_error" &&
    error.code !== "invalid_response" &&
    error.status >= 400 &&
    error.status < 500
  );
}

export function bindOrderAccess(orderRef: string, credentials: OrderCredentials): void {
  const target = storage();
  target.setItem(
    `${ORDER_STORAGE_PREFIX}${orderRef}`,
    JSON.stringify({ version: 1, accessToken: credentials.accessToken, savedAt: new Date().toISOString() }),
  );
  target.setItem(
    LAST_ORDER_REF_KEY,
    JSON.stringify({ version: 1, orderRef, savedAt: new Date().toISOString() }),
  );
  clearMatchingAttempt(target, CHECKOUT_ATTEMPT_KEY, credentials);
  clearMatchingAttempt(target, RETRY_ATTEMPT_KEY, credentials);
}

export function readLastOrderRef(): string | null {
  let target: Storage;
  try {
    target = window.localStorage;
  } catch {
    return null;
  }

  const saved = target.getItem(LAST_ORDER_REF_KEY);
  if (saved !== null) {
    try {
      const value: unknown = JSON.parse(saved);
      if (isRecord(value) && value.version === 1 && typeof value.orderRef === "string" && ORDER_REF_PATTERN.test(value.orderRef)) {
        return value.orderRef;
      }
    } catch {
      // 继续扫描已有订单凭证，兼容 last-order 指针上线前创建的订单。
    }
    target.removeItem(LAST_ORDER_REF_KEY);
  }

  let latest: { readonly orderRef: string; readonly savedAt: number } | null = null;
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (key === null || !key.startsWith(ORDER_STORAGE_PREFIX)) continue;
    const orderRef = key.slice(ORDER_STORAGE_PREFIX.length);
    if (!ORDER_REF_PATTERN.test(orderRef)) continue;
    const raw = target.getItem(key);
    if (raw === null) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || !isNonEmptyString(value.accessToken) || !ACCESS_TOKEN_PATTERN.test(value.accessToken)) continue;
      const savedAt = typeof value.savedAt === "string" ? Date.parse(value.savedAt) : Number.NaN;
      if (!Number.isFinite(savedAt)) continue;
      if (latest === null || savedAt > latest.savedAt) latest = { orderRef, savedAt };
    } catch {
      // 单条损坏记录不应阻断其他订单恢复。
    }
  }
  if (latest === null) return null;
  target.setItem(
    LAST_ORDER_REF_KEY,
    JSON.stringify({ version: 1, orderRef: latest.orderRef, savedAt: new Date(latest.savedAt).toISOString() }),
  );
  return latest.orderRef;
}

export function readOrderAccessToken(orderRef: string): string | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(`${ORDER_STORAGE_PREFIX}${orderRef}`);
  } catch {
    throw new PaymentApiError("storage_unavailable");
  }
  if (raw === null) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isNonEmptyString(value.accessToken) || !ACCESS_TOKEN_PATTERN.test(value.accessToken)) {
      return null;
    }
    return value.accessToken;
  } catch {
    return null;
  }
}

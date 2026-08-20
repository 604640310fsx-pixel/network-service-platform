import type { CatalogSelection } from "./resolveSelection";

export const PAYMENT_MAX_SINGLE_FEN_FRONTEND = 200_000;

const STORAGE_PREFIX = "nsp.payment.v1";
const CHECKOUT_ATTEMPT_KEY = `${STORAGE_PREFIX}.checkout-attempt`;
const RETRY_ATTEMPT_KEY = `${STORAGE_PREFIX}.retry-attempt`;
const ATTEMPT_TTL_MS = 30 * 60 * 1_000;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRecord = Record<string, unknown>;

export type PaymentOrderStatus = "pending" | "paid" | "closed";
export type ServiceStatus = "pending_open" | "open";

export type RequirementDraft = {
  readonly selection: CatalogSelection;
  readonly contact: string;
  readonly scenarios: string[];
  readonly notes: string;
  readonly acknowledgedAmountFen: number;
};

export type OrderCredentials = {
  readonly idempotencyKey: string;
  readonly accessToken: string;
};

export type PaymentOrderResult = {
  readonly orderRef: string;
  readonly status: PaymentOrderStatus;
  readonly payUrl: string | null;
};

export type PaymentOrderSnapshot = {
  readonly orderRef: string;
  readonly status: PaymentOrderStatus;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly service: { readonly status: ServiceStatus } | null;
};

export type MyServiceItem = {
  readonly orderRef: string;
  readonly amountFen: number;
  readonly currency: "CNY";
  readonly orderStatus: PaymentOrderStatus;
  readonly serviceStatus: ServiceStatus;
  readonly createdAt: string;
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

function isSecureUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new PaymentApiError("invalid_response");
  return value;
}

function parseOrderResult(value: unknown): PaymentOrderResult {
  const body = requireRecord(value);
  if (
    !isNonEmptyString(body.orderRef) ||
    !isPaymentOrderStatus(body.status)
  ) {
    throw new PaymentApiError("invalid_response");
  }

  if (body.status === "pending") {
    if (!isSecureUrl(body.payUrl)) throw new PaymentApiError("invalid_response");
    return {
      orderRef: body.orderRef,
      status: body.status,
      payUrl: body.payUrl,
    };
  }

  return {
    orderRef: body.orderRef,
    status: body.status,
    payUrl: null,
  };
}

function parseOrderSnapshot(value: unknown): PaymentOrderSnapshot {
  const body = requireRecord(value);
  let service: PaymentOrderSnapshot["service"] = null;
  if (body.service !== null) {
    const serviceBody = requireRecord(body.service);
    if (!isServiceStatus(serviceBody.status)) throw new PaymentApiError("invalid_response");
    service = { status: serviceBody.status };
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
    service,
  };
}

function parseMyServices(value: unknown): MyServiceItem[] {
  const body = requireRecord(value);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");

  return body.items.map((rawItem) => {
    const item = requireRecord(rawItem);
    if (
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

function parseOpenService(value: unknown): OpenServiceResult {
  const body = requireRecord(value);
  if (!isPositiveInteger(body.id) || body.status !== "open" || !isNonEmptyString(body.openedAt)) {
    throw new PaymentApiError("invalid_response");
  }
  return { id: body.id, status: body.status, openedAt: body.openedAt };
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
  };
}

export async function createPaymentOrder(
  draft: RequirementDraft,
  credentials: OrderCredentials,
): Promise<PaymentOrderResult> {
  const response = await requestJson("/api/pay/orders", {
    method: "POST",
    headers: mutationHeaders({
      "Idempotency-Key": credentials.idempotencyKey,
      "X-Order-Access-Token": credentials.accessToken,
    }),
    body: JSON.stringify(orderBody(draft)),
  });
  return parseOrderResult(response);
}

export async function retryPaymentOrder(
  orderRef: string,
  currentAccessToken: string | null,
  newCredentials: OrderCredentials,
): Promise<PaymentOrderResult> {
  const headers: Record<string, string> = {
    "Idempotency-Key": newCredentials.idempotencyKey,
    "X-New-Order-Access-Token": newCredentials.accessToken,
  };
  if (currentAccessToken !== null) headers["X-Order-Access-Token"] = currentAccessToken;
  const response = await requestJson(`/api/pay/orders/${encodeURIComponent(orderRef)}/retry`, {
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

export async function getMyServices(signal?: AbortSignal): Promise<MyServiceItem[]> {
  const response = await requestJson("/api/me/services", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return parseMyServices(response);
}

export async function getAdminPendingServices(signal?: AbortSignal): Promise<AdminPendingServiceItem[]> {
  const response = await requestJson("/api/admin/services?status=pending_open", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  return parseAdminPendingServices(response);
}

export async function openAdminService(serviceId: number, csrfToken: string): Promise<OpenServiceResult> {
  const response = await requestJson(`/api/admin/services/${serviceId}/open`, {
    method: "POST",
    headers: mutationHeaders({ "X-CSRF-Token": csrfToken }),
    body: "{}",
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
    `${STORAGE_PREFIX}.order.${orderRef}`,
    JSON.stringify({ version: 1, accessToken: credentials.accessToken, savedAt: new Date().toISOString() }),
  );
  clearMatchingAttempt(target, CHECKOUT_ATTEMPT_KEY, credentials);
  clearMatchingAttempt(target, RETRY_ATTEMPT_KEY, credentials);
}

export function readOrderAccessToken(orderRef: string): string | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(`${STORAGE_PREFIX}.order.${orderRef}`);
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

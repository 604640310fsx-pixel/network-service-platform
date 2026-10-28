import { PaymentApiError } from "./payment-api";

export type AdminPlanItem = {
  readonly id: number;
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly priceFen: number;
  readonly isActive: boolean;
  readonly totalSlots: number | null;
  readonly occupiedSlots: number;
};

export type AdminCouponItem = {
  readonly id: number;
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
  readonly redeemedCount: number;
  readonly isActive: boolean;
  readonly createdAt: string;
};

export type CouponRedemptionItem = {
  readonly orderRef: string;
  readonly discountFen: number;
  readonly redeemedAt: string;
  readonly releasedAt: string | null;
};

export type PlanPatch = {
  readonly priceFen?: number;
  readonly isActive?: boolean;
  readonly totalSlots?: number | null;
};

export type CouponCreateDraft = {
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
};

export type CouponPatch = {
  readonly isActive?: boolean;
  readonly endsAt?: string;
  readonly maxRedemptions?: number | null;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isSafeInteger(item));
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new PaymentApiError("invalid_response");
  return value;
}

function parsePlanItem(raw: unknown): AdminPlanItem {
  const value = requireRecord(raw);
  if (
    !isNonNegativeInteger(value.id) ||
    !isNonEmptyString(value.typeId) ||
    !isNonEmptyString(value.regionId) ||
    !isNonEmptyString(value.ispId) ||
    !(value.specId === null || typeof value.specId === "string") ||
    !isNonEmptyString(value.durationId) ||
    !isNonNegativeInteger(value.priceFen) ||
    typeof value.isActive !== "boolean" ||
    !isNullableNonNegativeInteger(value.totalSlots) ||
    !isNonNegativeInteger(value.occupiedSlots)
  ) {
    throw new PaymentApiError("invalid_response");
  }
  return {
    id: value.id,
    typeId: value.typeId,
    regionId: value.regionId,
    ispId: value.ispId,
    specId: value.specId as string | null,
    durationId: value.durationId,
    priceFen: value.priceFen,
    isActive: value.isActive,
    totalSlots: value.totalSlots as number | null,
    occupiedSlots: value.occupiedSlots,
  };
}

function parseCouponItem(raw: unknown): AdminCouponItem {
  const value = requireRecord(raw);
  if (
    !isNonNegativeInteger(value.id) ||
    !isNonEmptyString(value.code) ||
    (value.kind !== "fixed" && value.kind !== "percent") ||
    !(value.amountOffFen === null || isNonNegativeInteger(value.amountOffFen)) ||
    !(value.percentOff === null || isNonNegativeInteger(value.percentOff)) ||
    !(value.minAmountFen === null || isNonNegativeInteger(value.minAmountFen)) ||
    (value.scope !== "all" && value.scope !== "plans") ||
    !isNumberArray(value.planIds) ||
    !isNonEmptyString(value.startsAt) ||
    !isNonEmptyString(value.endsAt) ||
    !isNullableNonNegativeInteger(value.maxRedemptions) ||
    !isNonNegativeInteger(value.redeemedCount) ||
    typeof value.isActive !== "boolean" ||
    !isNonEmptyString(value.createdAt)
  ) {
    throw new PaymentApiError("invalid_response");
  }
  return {
    id: value.id,
    code: value.code,
    kind: value.kind,
    amountOffFen: value.amountOffFen as number | null,
    percentOff: value.percentOff as number | null,
    minAmountFen: value.minAmountFen as number | null,
    scope: value.scope,
    planIds: value.planIds,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    maxRedemptions: value.maxRedemptions as number | null,
    redeemedCount: value.redeemedCount,
    isActive: value.isActive,
    createdAt: value.createdAt,
  };
}

function parseRedemptionItem(raw: unknown): CouponRedemptionItem {
  const value = requireRecord(raw);
  if (
    !isNonEmptyString(value.orderRef) ||
    !isNonNegativeInteger(value.discountFen) ||
    !isNonEmptyString(value.redeemedAt) ||
    !(value.releasedAt === null || isNonEmptyString(value.releasedAt))
  ) {
    throw new PaymentApiError("invalid_response");
  }
  return {
    orderRef: value.orderRef,
    discountFen: value.discountFen,
    redeemedAt: value.redeemedAt,
    releasedAt: value.releasedAt as string | null,
  };
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
  return new PaymentApiError(value.error.code, status);
}

async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", signal });
  } catch {
    throw new PaymentApiError("network_error");
  }
  const body = await readJson(response);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return body;
}

function readHeaders(): Record<string, string> {
  return { Accept: "application/json" };
}

function writeHeaders(csrfToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-Token": csrfToken,
  };
}

export async function getAdminPlans(signal?: AbortSignal): Promise<AdminPlanItem[]> {
  const response = await requestJson("/api/admin/plans", { method: "GET", headers: readHeaders() }, signal);
  const body = requireRecord(response);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");
  return body.items.map(parsePlanItem);
}

export async function updateAdminPlan(
  planId: number,
  csrfToken: string,
  patch: PlanPatch,
): Promise<AdminPlanItem> {
  const response = await requestJson(`/api/admin/plans/${planId}`, {
    method: "PATCH",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify(patch),
  });
  return parsePlanItem(response);
}

export async function getAdminCoupons(signal?: AbortSignal): Promise<AdminCouponItem[]> {
  const response = await requestJson("/api/admin/coupons", { method: "GET", headers: readHeaders() }, signal);
  const body = requireRecord(response);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");
  return body.items.map(parseCouponItem);
}

export async function createAdminCoupon(
  csrfToken: string,
  draft: CouponCreateDraft,
): Promise<AdminCouponItem> {
  const response = await requestJson("/api/admin/coupons", {
    method: "POST",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify(draft),
  });
  return parseCouponItem(response);
}

export async function updateAdminCoupon(
  couponId: number,
  csrfToken: string,
  patch: CouponPatch,
): Promise<AdminCouponItem> {
  const response = await requestJson(`/api/admin/coupons/${couponId}`, {
    method: "PATCH",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify(patch),
  });
  return parseCouponItem(response);
}

export async function getAdminCouponRedemptions(
  couponId: number,
  signal?: AbortSignal,
): Promise<CouponRedemptionItem[]> {
  const response = await requestJson(
    `/api/admin/coupons/${couponId}/redemptions`,
    { method: "GET", headers: readHeaders() },
    signal,
  );
  const body = requireRecord(response);
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");
  return body.items.map(parseRedemptionItem);
}

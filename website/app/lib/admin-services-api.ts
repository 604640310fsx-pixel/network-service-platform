import { PaymentApiError } from "./payment-api";

/* 管理员管理买家服务（/api/admin/users*、/api/admin/services/:id、/api/admin/grants*）。
   响应逐字段校验，不合约定即 invalid_response；写请求带 CSRF。 */

export type AdminUserSummary = {
  readonly id: number;
  readonly email: string;
  readonly role: "user" | "admin";
  readonly status: "active" | "disabled";
  readonly createdAt: string;
};

export type AdminUserService = {
  readonly id: number;
  readonly orderRef: string;
  readonly amountFen: number;
  readonly orderStatus: string;
  readonly serviceStatus: "pending_open" | "open";
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
  readonly createdAt: string;
  readonly openedAt: string | null;
  readonly endsAt: string | null;
  readonly planLabel: string | null;
  readonly adminNote: string | null;
};

export type AdminGrant = {
  readonly id: number;
  readonly userId: number;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly status: "active" | "revoked";
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AdminServicePatch = {
  readonly endsAt?: string | null;
  readonly planLabel?: string | null;
  readonly note?: string | null;
};

export type AdminGrantDraft = {
  readonly userId: number;
  readonly label: string;
  readonly endsAt: string | null;
  readonly reason: string | null;
};

export type AdminGrantPatch = {
  readonly endsAt?: string | null;
  readonly label?: string;
  readonly status?: "revoked";
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new PaymentApiError("invalid_response");
  return value;
}

function nullableStr(value: unknown): string | null {
  return value === null ? null : str(value);
}

function int(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new PaymentApiError("invalid_response");
  return value;
}

function record(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new PaymentApiError("invalid_response");
  return value;
}

function parseUser(value: unknown): AdminUserSummary {
  const row = record(value);
  const role = row.role;
  const status = row.status;
  if ((role !== "user" && role !== "admin") || (status !== "active" && status !== "disabled")) {
    throw new PaymentApiError("invalid_response");
  }
  return { id: int(row.id), email: str(row.email), role, status, createdAt: str(row.createdAt) };
}

function parseService(value: unknown): AdminUserService {
  const row = record(value);
  const serviceStatus = row.serviceStatus;
  if (serviceStatus !== "pending_open" && serviceStatus !== "open") throw new PaymentApiError("invalid_response");
  return {
    id: int(row.id),
    orderRef: str(row.orderRef),
    amountFen: int(row.amountFen),
    orderStatus: str(row.orderStatus),
    serviceStatus,
    typeId: str(row.typeId),
    regionId: str(row.regionId),
    ispId: str(row.ispId),
    specId: nullableStr(row.specId),
    durationId: str(row.durationId),
    createdAt: str(row.createdAt),
    openedAt: nullableStr(row.openedAt),
    endsAt: nullableStr(row.endsAt),
    planLabel: nullableStr(row.planLabel),
    adminNote: nullableStr(row.adminNote),
  };
}

function parseGrant(value: unknown): AdminGrant {
  const row = record(value);
  const status = row.status;
  if (status !== "active" && status !== "revoked") throw new PaymentApiError("invalid_response");
  return {
    id: int(row.id),
    userId: int(row.userId),
    label: str(row.label),
    startsAt: str(row.startsAt),
    endsAt: nullableStr(row.endsAt),
    status,
    reason: nullableStr(row.reason),
    createdAt: str(row.createdAt),
    updatedAt: str(row.updatedAt),
  };
}

async function requestJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", signal });
  } catch {
    throw new PaymentApiError("network_error");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PaymentApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" ? body.error.code : "request_failed";
    throw new PaymentApiError(code, response.status);
  }
  return body;
}

function writeInit(method: "PATCH" | "POST", csrfToken: string, payload: unknown): RequestInit {
  return {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(payload),
  };
}

export async function searchAdminUsers(query: string, signal?: AbortSignal): Promise<AdminUserSummary[]> {
  const body = record(
    await requestJson(`/api/admin/users?q=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" } }, signal),
  );
  if (!Array.isArray(body.items)) throw new PaymentApiError("invalid_response");
  return body.items.map(parseUser);
}

export async function getAdminUserServices(
  userId: number,
  signal?: AbortSignal,
): Promise<{ readonly services: AdminUserService[]; readonly grants: AdminGrant[] }> {
  const body = record(await requestJson(`/api/admin/users/${userId}/services`, { headers: { Accept: "application/json" } }, signal));
  if (!Array.isArray(body.services) || !Array.isArray(body.grants)) throw new PaymentApiError("invalid_response");
  return { services: body.services.map(parseService), grants: body.grants.map(parseGrant) };
}

export async function updateAdminService(serviceId: number, patch: AdminServicePatch, csrfToken: string): Promise<AdminUserService> {
  return parseService(await requestJson(`/api/admin/services/${serviceId}`, writeInit("PATCH", csrfToken, patch)));
}

export async function createAdminGrant(draft: AdminGrantDraft, csrfToken: string): Promise<AdminGrant> {
  return parseGrant(await requestJson("/api/admin/grants", writeInit("POST", csrfToken, draft)));
}

export async function updateAdminGrant(grantId: number, patch: AdminGrantPatch, csrfToken: string): Promise<AdminGrant> {
  return parseGrant(await requestJson(`/api/admin/grants/${grantId}`, writeInit("PATCH", csrfToken, patch)));
}

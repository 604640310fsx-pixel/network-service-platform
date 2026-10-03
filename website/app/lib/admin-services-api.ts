// Node's strip-types test runner needs the extension; Vite resolves the same module during build.
// @ts-ignore TS5097: the website tsconfig does not enable allowImportingTsExtensions.
import { PaymentApiError } from "./payment-api.ts";

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
  readonly deliveryLines: ReadonlyArray<{ readonly position: number; readonly label: string; readonly monitorTargetKey: string | null }>;
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
  readonly typeId: string | null;
  readonly regionId: string | null;
  readonly ispId: string | null;
  readonly specId: string | null;
  readonly durationId: string | null;
  readonly months: number | null;
  readonly valueFen: number | null;
  readonly deliveryStatus: "pending_open" | "open";
  readonly openedAt: string | null;
  readonly deliveryLines: ReadonlyArray<AdminDeliveryLine>;
};

/** A delivered line as admins see it: public name plus VPS binding (null = not bound). */
export type AdminDeliveryLine = { readonly position: number; readonly label: string; readonly monitorTargetKey: string | null };

export type AdminServicePatch = {
  readonly endsAt?: string | null;
  readonly planLabel?: string | null;
  readonly note?: string | null;
};

export type GrantSelection = {
  readonly typeId: string;
  readonly regionId: string;
  readonly ispId: string;
  readonly specId: string | null;
  readonly durationId: string;
};

export type AdminGrantDraft = GrantSelection & {
  readonly userId: number;
  readonly months: number;
  readonly valueFen: number;
  /** null = server builds a name from the catalog ids. */
  readonly label: string | null;
  readonly endsAt: string | null;
  readonly reason: string | null;
};

export type AdminGrantPatch = Partial<GrantSelection> & {
  readonly endsAt?: string | null;
  readonly label?: string;
  readonly status?: "revoked";
  readonly months?: number;
  readonly valueFen?: number;
};

/** monitorTargetKey omitted or null = deliver without a VPS binding. */
export type AdminGrantDeliveryInput = { readonly label: string; readonly subscriptionUrl: string; readonly monitorTargetKey?: string | null };

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
    deliveryLines: Array.isArray(row.deliveryLines)
      ? row.deliveryLines.map((line) => {
          const item = record(line);
          return { position: int(item.position), label: str(item.label), monitorTargetKey: nullableStr(item.monitorTargetKey) };
        })
      : (() => { throw new PaymentApiError("invalid_response"); })(),
  };
}

function nullableInt(value: unknown): number | null {
  return value === null ? null : int(value);
}

function parseGrant(value: unknown): AdminGrant {
  const row = record(value);
  const status = row.status;
  const deliveryStatus = row.deliveryStatus;
  if ((status !== "active" && status !== "revoked") || (deliveryStatus !== "pending_open" && deliveryStatus !== "open")) {
    throw new PaymentApiError("invalid_response");
  }
  if (!Array.isArray(row.deliveryLines)) throw new PaymentApiError("invalid_response");
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
    typeId: nullableStr(row.typeId),
    regionId: nullableStr(row.regionId),
    ispId: nullableStr(row.ispId),
    specId: nullableStr(row.specId),
    durationId: nullableStr(row.durationId),
    months: nullableInt(row.months),
    valueFen: nullableInt(row.valueFen),
    deliveryStatus,
    openedAt: nullableStr(row.openedAt),
    deliveryLines: row.deliveryLines.map((line) => {
      const item = record(line);
      return { position: int(item.position), label: str(item.label), monitorTargetKey: nullableStr(item.monitorTargetKey) };
    }),
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

export async function openAdminGrant(grantId: number, items: readonly AdminGrantDeliveryInput[], csrfToken: string): Promise<AdminGrant> {
  const payload = items.map(({ label, subscriptionUrl, monitorTargetKey }) =>
    monitorTargetKey ? { label, subscriptionUrl, monitorTargetKey } : { label, subscriptionUrl },
  );
  return parseGrant(await requestJson(`/api/admin/grants/${grantId}/open`, writeInit("POST", csrfToken, { items: payload })));
}

/** Bind, rebind (another active VPS) or unbind (null) a delivered service line. */
export async function bindAdminServiceDelivery(serviceId: number, position: number, monitorTargetKey: string | null, csrfToken: string): Promise<AdminUserService> {
  return parseService(await requestJson(`/api/admin/services/${serviceId}/delivery/${position}`, writeInit("PATCH", csrfToken, { monitorTargetKey })));
}

/** Same for a delivered line of an opened gift. */
export async function bindAdminGrantDelivery(grantId: number, position: number, monitorTargetKey: string | null, csrfToken: string): Promise<AdminGrant> {
  return parseGrant(await requestJson(`/api/admin/grants/${grantId}/delivery/${position}`, writeInit("PATCH", csrfToken, { monitorTargetKey })));
}

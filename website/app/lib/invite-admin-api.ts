export type AdminInviteCodeStatus =
  | "usable"
  | "expired"
  | "revoked"
  | "exhausted";

export interface AdminInviteCodeItem {
  readonly id: number;
  readonly isBootstrap: boolean;
  readonly status: AdminInviteCodeStatus;
  readonly maxUses: number;
  readonly usedCount: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

type JsonRecord = Record<string, unknown>;

const INVITE_CODE_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const STATUSES: readonly AdminInviteCodeStatus[] = [
  "usable",
  "expired",
  "revoked",
  "exhausted",
];

export class InviteAdminApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "InviteAdminApiError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parseItem(value: unknown): AdminInviteCodeItem {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.isBootstrap !== "boolean" ||
    typeof value.status !== "string" ||
    !STATUSES.some((status) => status === value.status) ||
    typeof value.maxUses !== "number" ||
    !Number.isSafeInteger(value.maxUses) ||
    value.maxUses < 1 ||
    typeof value.usedCount !== "number" ||
    !Number.isSafeInteger(value.usedCount) ||
    value.usedCount < 0 ||
    !isCanonicalInstant(value.expiresAt) ||
    (value.revokedAt !== null && !isCanonicalInstant(value.revokedAt)) ||
    !isCanonicalInstant(value.createdAt)
  ) {
    throw new InviteAdminApiError("invalid_response");
  }
  return {
    id: value.id,
    isBootstrap: value.isBootstrap,
    status: value.status as AdminInviteCodeStatus,
    maxUses: value.maxUses,
    usedCount: value.usedCount,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt as string | null,
    createdAt: value.createdAt,
  };
}

function errorCode(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !isRecord(value.error) ||
    typeof value.error.code !== "string"
  ) {
    return null;
  }
  return value.error.code;
}

async function requestJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new InviteAdminApiError("network_error");
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new InviteAdminApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    throw new InviteAdminApiError(
      errorCode(value) ?? "request_failed",
      response.status,
    );
  }
  return value;
}

export async function getAdminInviteCodes(
  signal?: AbortSignal,
): Promise<{
  readonly items: readonly AdminInviteCodeItem[];
  readonly total: number;
}> {
  const value = await requestJson(
    "/api/admin/invite-codes",
    { method: "GET" },
    signal,
  );
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < value.items.length
  ) {
    throw new InviteAdminApiError("invalid_response");
  }
  return {
    items: value.items.map(parseItem),
    total: value.total,
  };
}

export async function createAdminInviteCode(
  csrfToken: string,
  maxUses: number,
  expiresAt: string,
): Promise<{
  readonly item: AdminInviteCodeItem;
  readonly inviteCode: string;
}> {
  const value = await requestJson("/api/admin/invite-codes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ maxUses, expiresAt }),
  });
  if (
    !isRecord(value) ||
    typeof value.inviteCode !== "string" ||
    !INVITE_CODE_PATTERN.test(value.inviteCode)
  ) {
    throw new InviteAdminApiError("invalid_response");
  }
  return { item: parseItem(value.item), inviteCode: value.inviteCode };
}

export async function revokeAdminInviteCode(
  inviteCodeId: number,
  csrfToken: string,
): Promise<AdminInviteCodeItem> {
  const value = await requestJson(
    `/api/admin/invite-codes/${inviteCodeId}/revoke`,
    {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    },
  );
  if (!isRecord(value)) {
    throw new InviteAdminApiError("invalid_response");
  }
  return parseItem(value.item);
}

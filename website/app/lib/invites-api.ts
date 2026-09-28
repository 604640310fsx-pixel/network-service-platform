/* /api/me/invites client: the signed-in account's own personal invite code and
   its direct-invite count. The response never carries invitee data. */

export interface MyInvites {
  readonly code: string;
  readonly directInviteCount: number;
}

const PERSONAL_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export class InvitesApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "InvitesApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMyInvites(value: unknown): MyInvites {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "code,directInviteCount" ||
    typeof value.code !== "string" ||
    !PERSONAL_CODE_PATTERN.test(value.code) ||
    typeof value.directInviteCount !== "number" ||
    !Number.isSafeInteger(value.directInviteCount) ||
    value.directInviteCount < 0
  ) {
    throw new InvitesApiError("invalid_response");
  }
  return { code: value.code, directInviteCount: value.directInviteCount };
}

export async function getMyInvites(signal?: AbortSignal): Promise<MyInvites> {
  let response: Response;
  try {
    response = await fetch("/api/me/invites", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new InvitesApiError("network_error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new InvitesApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    const code = isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "request_failed";
    throw new InvitesApiError(code, response.status);
  }
  return parseMyInvites(value);
}

// The shareable link is a registration link on this same site.
export function personalInviteLink(origin: string, code: string): string {
  return `${origin}/register?invite=${encodeURIComponent(code)}`;
}

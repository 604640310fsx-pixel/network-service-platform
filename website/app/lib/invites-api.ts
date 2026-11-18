/* /api/me/invites client: the signed-in account's own personal invite code and
   its direct-invite count. The response never carries invitee data.
   GET is read-only and reports "uninitialized" for an account without a code;
   only the CSRF-protected POST provisions it, idempotently. */

export interface MyInvites {
  readonly code: string;
  readonly directInviteCount: number;
}

export type MyInvitesState =
  | { readonly status: "ready"; readonly invites: MyInvites }
  | { readonly status: "uninitialized" };

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

export function parseMyInvites(value: unknown): MyInvitesState {
  if (isRecord(value) && Object.keys(value).join(",") === "status" && value.status === "uninitialized") {
    return { status: "uninitialized" };
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "code,directInviteCount,status" ||
    value.status !== "ready" ||
    typeof value.code !== "string" ||
    !PERSONAL_CODE_PATTERN.test(value.code) ||
    typeof value.directInviteCount !== "number" ||
    !Number.isSafeInteger(value.directInviteCount) ||
    value.directInviteCount < 0
  ) {
    throw new InvitesApiError("invalid_response");
  }
  return { status: "ready", invites: { code: value.code, directInviteCount: value.directInviteCount } };
}

async function requestJson(init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("/api/me/invites", { ...init, credentials: "same-origin", cache: "no-store", signal });
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
  return value;
}

// Read-only: never provisions a code.
export async function getMyInvites(signal?: AbortSignal): Promise<MyInvitesState> {
  return parseMyInvites(await requestJson({ method: "GET", headers: { Accept: "application/json" } }, signal));
}

// The only write: provisions this account's code once; repeats return the same code.
export async function ensureMyInvites(csrfToken: string, signal?: AbortSignal): Promise<MyInvitesState> {
  return parseMyInvites(
    await requestJson(
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-Token": csrfToken,
        },
        body: "{}",
      },
      signal,
    ),
  );
}

// The shareable link is a registration link on this same site.
export function personalInviteLink(origin: string, code: string): string {
  return `${origin}/register?invite=${encodeURIComponent(code)}`;
}

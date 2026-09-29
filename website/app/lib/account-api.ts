/* Signed-in account security writes (/api/me/password/change and
   /api/me/email/change/{start,confirm}). Every call carries the session CSRF
   token; passwords, codes and the change token live only in the request body
   and in component memory, never in the URL or browser storage. */

export class AccountApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "AccountApiError";
    this.code = code;
    this.status = status;
  }
}

const CHANGE_TOKEN_PATTERN = /^ec1\.v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function post(url: string, csrfToken: string, body: Readonly<Record<string, string>>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AccountApiError("network_error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new AccountApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    const code = isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "request_failed";
    throw new AccountApiError(code, response.status);
  }
  return value;
}

function assertOk(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).join(",") !== "status" || value.status !== "ok") {
    throw new AccountApiError("invalid_response");
  }
}

export async function changePassword(
  csrfToken: string,
  input: { readonly currentPassword: string; readonly newPassword: string; readonly confirmPassword: string },
): Promise<void> {
  assertOk(await post("/api/me/password/change", csrfToken, input));
}

export type EmailChangeStarted = { readonly changeToken: string; readonly expiresAt: string };

export function parseEmailChangeStarted(value: unknown): EmailChangeStarted {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "changeToken,expiresAt,status" ||
    value.status !== "ok" ||
    typeof value.changeToken !== "string" ||
    !CHANGE_TOKEN_PATTERN.test(value.changeToken) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(new Date(value.expiresAt).getTime())
  ) {
    throw new AccountApiError("invalid_response");
  }
  return { changeToken: value.changeToken, expiresAt: value.expiresAt };
}

export async function startEmailChange(
  csrfToken: string,
  input: { readonly currentPassword: string; readonly newEmail: string },
): Promise<EmailChangeStarted> {
  return parseEmailChangeStarted(await post("/api/me/email/change/start", csrfToken, input));
}

export async function confirmEmailChange(
  csrfToken: string,
  input: { readonly changeToken: string; readonly code: string },
): Promise<void> {
  assertOk(await post("/api/me/email/change/confirm", csrfToken, input));
}

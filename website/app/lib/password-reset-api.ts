type JsonRecord = Record<string, unknown>;

/* Signed-out password reset (/api/auth/password-reset/{request,confirm}).
   The reset token is only ever held in memory: read from the emailed link,
   sent once to confirm, never stored. */

export const PASSWORD_RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class PasswordResetApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "PasswordResetApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(value: unknown): string | null {
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === "string"
    ? value.error.code
    : null;
}

export function parseOk(value: unknown): void {
  if (!isRecord(value) || value.status !== "ok" || Object.keys(value).length !== 1) {
    throw new PasswordResetApiError("invalid_response");
  }
}

async function postJson(url: string, body: Readonly<Record<string, string>>): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PasswordResetApiError("network_error");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new PasswordResetApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    throw new PasswordResetApiError(errorCode(value) ?? "request_failed", response.status);
  }
  parseOk(value);
}

export function requestPasswordReset(email: string): Promise<void> {
  return postJson("/api/auth/password-reset/request", { email: email.trim() });
}

export function confirmPasswordReset(token: string, password: string): Promise<void> {
  return postJson("/api/auth/password-reset/confirm", { token, password });
}

/** The emailed link is exactly `/reset-password?token=<43-char token>`. */
export function resetTokenFromSearch(search: string): string | null {
  const parameters = new URLSearchParams(search);
  if (parameters.getAll("token").length !== 1) return null;
  const token = parameters.get("token");
  return token !== null && PASSWORD_RESET_TOKEN_PATTERN.test(token) ? token : null;
}

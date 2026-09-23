type JsonRecord = Record<string, unknown>;

const REGISTRATION_TOKEN_PATTERN =
  /^v[0-9]+\.[A-Za-z0-9_-]{43}$/;
const REFERRAL_PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export class RegistrationApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "RegistrationApiError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  body: Readonly<Record<string, string>>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RegistrationApiError("network_error");
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new RegistrationApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    throw new RegistrationApiError(
      errorCode(value) ?? "request_failed",
      response.status,
    );
  }
  return value;
}

function parseRegistrationToken(value: unknown): string {
  if (
    !isRecord(value) ||
    value.status !== "ok" ||
    typeof value.registrationToken !== "string" ||
    !REGISTRATION_TOKEN_PATTERN.test(value.registrationToken)
  ) {
    throw new RegistrationApiError("invalid_response");
  }
  return value.registrationToken;
}

function assertOk(value: unknown): void {
  if (
    !isRecord(value) ||
    value.status !== "ok" ||
    Object.keys(value).some(
      (key) => key !== "status",
    )
  ) {
    throw new RegistrationApiError("invalid_response");
  }
}

export async function startRegistration(
  email: string,
  inviteCode: string,
  referralCode: string | null = null,
): Promise<string> {
  return parseRegistrationToken(
    await requestJson("/api/auth/register/start", {
      email,
      inviteCode,
      ...(referralCode === null ? {} : { referralCode }),
    }),
  );
}

export function referralSourceCodeFromSearch(search: string): string | null {
  const parameters = new URLSearchParams(search);
  const keys = [...parameters.keys()];
  if (
    keys.length !== 1 ||
    keys[0] !== "referralCode" ||
    parameters.getAll("referralCode").length !== 1
  ) {
    return null;
  }
  const code = parameters.get("referralCode");
  return code !== null && REFERRAL_PUBLIC_CODE_PATTERN.test(code) ? code : null;
}

export async function resendRegistrationCode(
  registrationToken: string,
): Promise<void> {
  assertOk(
    await requestJson("/api/auth/register/resend-code", {
      registrationToken,
    }),
  );
}

export async function verifyRegistrationCode(
  registrationToken: string,
  otp: string,
): Promise<string> {
  return parseRegistrationToken(
    await requestJson("/api/auth/register/verify-code", {
      registrationToken,
      otp,
    }),
  );
}

export async function completeRegistration(
  registrationToken: string,
  password: string,
  confirmPassword: string,
): Promise<void> {
  assertOk(
    await requestJson("/api/auth/register/complete", {
      registrationToken,
      password,
      confirmPassword,
    }),
  );
}

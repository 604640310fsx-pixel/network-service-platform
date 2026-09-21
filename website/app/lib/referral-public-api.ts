type JsonRecord = Record<string, unknown>;

export type ReferralPublicResolution = { readonly valid: boolean };

export class ReferralPublicApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "ReferralPublicApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

function responseErrorCode(value: unknown): string | null {
  return isRecord(value) &&
    isRecord(value.error) &&
    hasExactKeys(value, ["error"]) &&
    hasExactKeys(value.error, ["code"]) &&
    typeof value.error.code === "string"
    ? value.error.code
    : null;
}

export function referralCodeFromSearch(search: string): string | null {
  const parameters = new URLSearchParams(search);
  const keys = [...parameters.keys()];
  if (
    keys.length !== 1 ||
    keys[0] !== "code" ||
    parameters.getAll("code").length !== 1
  ) {
    return null;
  }
  return parameters.get("code");
}

export function parseReferralPublicResolution(
  value: unknown,
): ReferralPublicResolution {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["valid"]) ||
    typeof value.valid !== "boolean"
  ) {
    throw new ReferralPublicApiError("invalid_response");
  }
  return { valid: value.valid };
}

export async function resolvePublicReferral(
  code: string | null,
  signal?: AbortSignal,
): Promise<ReferralPublicResolution> {
  const query = code === null ? "" : `?code=${encodeURIComponent(code)}`;
  let response: Response;
  try {
    response = await fetch(`/api/public/referral${query}`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ReferralPublicApiError("network_error");
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ReferralPublicApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    throw new ReferralPublicApiError(
      responseErrorCode(value) ?? "request_failed",
      response.status,
    );
  }
  return parseReferralPublicResolution(value);
}

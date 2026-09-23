import type {
  ReferralCenterData,
  ReferralLinkState,
} from "../components/referrals/referralModel";

type JsonRecord = Record<string, unknown>;

export type ReferralProfileIdentity = {
  readonly publicCode: string;
  readonly createdAt: string;
};

export type ReferralProgramContract = {
  readonly tiers: readonly [
    { readonly minSalesFen: 5900; readonly maxSalesFen: 99899; readonly rateBps: 1000 },
    { readonly minSalesFen: 99900; readonly maxSalesFen: 199899; readonly rateBps: 1500 },
    { readonly minSalesFen: 199900; readonly maxSalesFen: 399899; readonly rateBps: 2000 },
    { readonly minSalesFen: 399900; readonly maxSalesFen: null; readonly rateBps: 3000 },
  ];
  readonly withdrawalThresholdFen: 100000;
  readonly productCap: { readonly status: "unconfigured" };
  readonly commission: { readonly status: "not_integrated" };
  readonly refunds: { readonly status: "not_integrated" };
  readonly settlement: { readonly status: "not_integrated" };
  readonly withdrawn: { readonly status: "not_integrated" };
};

export type ReferralStateResponse = {
  readonly profile: ReferralProfileIdentity | null;
  readonly link: {
    readonly status: "unavailable";
    readonly reason: "public_route_not_integrated";
  };
  readonly program: ReferralProgramContract;
};

export type ReferralAdapterState =
  | { readonly status: "pending" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly response: ReferralStateResponse };

export type ReferralComponentState = {
  readonly data: ReferralCenterData;
  readonly link: ReferralLinkState;
  readonly profile: ReferralProfileIdentity | null;
};

export class ReferralApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = "ReferralApiError";
    this.code = code;
    this.status = status;
  }
}

const EXPECTED_TIERS = [
  { minSalesFen: 5_900, maxSalesFen: 99_899, rateBps: 1_000 },
  { minSalesFen: 99_900, maxSalesFen: 199_899, rateBps: 1_500 },
  { minSalesFen: 199_900, maxSalesFen: 399_899, rateBps: 2_000 },
  { minSalesFen: 399_900, maxSalesFen: null, rateBps: 3_000 },
] as const;

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

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parseProfile(value: unknown): ReferralProfileIdentity | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["publicCode", "createdAt"]) ||
    typeof value.publicCode !== "string" ||
    !/^[A-Za-z0-9_-]{24}$/.test(value.publicCode) ||
    !isCanonicalInstant(value.createdAt)
  ) {
    throw new ReferralApiError("invalid_response");
  }
  return { publicCode: value.publicCode, createdAt: value.createdAt };
}

function isStatusObject(value: unknown, status: string): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["status"]) &&
    value.status === status
  );
}

export function parseReferralStateResponse(value: unknown): ReferralStateResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["profile", "link", "program"]) ||
    !isRecord(value.link) ||
    !hasExactKeys(value.link, ["status", "reason"]) ||
    value.link.status !== "unavailable" ||
    value.link.reason !== "public_route_not_integrated" ||
    !isRecord(value.program) ||
    !hasExactKeys(value.program, [
      "tiers",
      "withdrawalThresholdFen",
      "productCap",
      "commission",
      "refunds",
      "settlement",
      "withdrawn",
    ]) ||
    !Array.isArray(value.program.tiers) ||
    value.program.tiers.length !== EXPECTED_TIERS.length ||
    !value.program.tiers.every((tier, index) => {
      const expected = EXPECTED_TIERS[index];
      return (
        expected !== undefined &&
        isRecord(tier) &&
        hasExactKeys(tier, ["minSalesFen", "maxSalesFen", "rateBps"]) &&
        tier.minSalesFen === expected.minSalesFen &&
        tier.maxSalesFen === expected.maxSalesFen &&
        tier.rateBps === expected.rateBps
      );
    }) ||
    value.program.withdrawalThresholdFen !== 100_000 ||
    !isStatusObject(value.program.productCap, "unconfigured") ||
    !isStatusObject(value.program.commission, "not_integrated") ||
    !isStatusObject(value.program.refunds, "not_integrated") ||
    !isStatusObject(value.program.settlement, "not_integrated") ||
    !isStatusObject(value.program.withdrawn, "not_integrated")
  ) {
    throw new ReferralApiError("invalid_response");
  }

  return {
    profile: parseProfile(value.profile),
    link: {
      status: "unavailable",
      reason: "public_route_not_integrated",
    },
    program: {
      tiers: EXPECTED_TIERS,
      withdrawalThresholdFen: 100_000,
      productCap: { status: "unconfigured" },
      commission: { status: "not_integrated" },
      refunds: { status: "not_integrated" },
      settlement: { status: "not_integrated" },
      withdrawn: { status: "not_integrated" },
    },
  };
}

function errorCode(value: unknown): string | null {
  return isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
    ? value.error.code
    : null;
}

async function requestReferralState(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<ReferralStateResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...init.headers },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ReferralApiError("network_error");
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ReferralApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    throw new ReferralApiError(
      errorCode(value) ?? "request_failed",
      response.status,
    );
  }
  return parseReferralStateResponse(value);
}

export function getReferralState(signal?: AbortSignal): Promise<ReferralStateResponse> {
  return requestReferralState(
    "/api/me/referral",
    { method: "GET" },
    signal,
  );
}

export function ensureReferralProfile(
  csrfToken: string,
  signal?: AbortSignal,
): Promise<ReferralStateResponse> {
  return requestReferralState(
    "/api/me/referral/profile",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": csrfToken,
      },
      body: "{}",
    },
    signal,
  );
}

/** Financial systems and the public landing route are not integrated in this
 * packet. A successful identity read therefore remains honest pending data and
 * an unavailable (non-copyable) link; it never synthesizes zero balances. */
export function adaptReferralState(state: ReferralAdapterState): ReferralComponentState {
  if (state.status === "pending") {
    return { data: { status: "pending" }, link: { status: "pending" }, profile: null };
  }
  if (state.status === "loading") {
    return { data: { status: "loading" }, link: { status: "pending" }, profile: null };
  }
  if (state.status === "error") {
    return { data: { status: "error" }, link: { status: "pending" }, profile: null };
  }
  return {
    data: { status: "pending" },
    link: { status: "unavailable" },
    profile: state.response.profile,
  };
}

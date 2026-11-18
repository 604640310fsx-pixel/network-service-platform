export const WITHDRAWAL_THRESHOLD_FEN = 100_000;
const RATE_DENOMINATOR_BPS = 10_000;

export type CommissionPolicy =
  | {
      readonly status: "approved";
      readonly version: string;
      readonly calculation: {
        readonly kind: "explicit_rate";
        readonly rateBps: number;
      };
    }
  | {
      readonly status: "synthetic";
      readonly version: string;
      readonly calculation: { readonly kind: "synthetic_min_tier_product_cap" };
    }
  | { readonly status: "unapproved"; readonly version: string | null };

export interface CommissionInput {
  readonly paymentStatus: "paid" | "unpaid";
  readonly eligibilityStatus: "approved" | "unapproved";
  readonly actualPaidFen: number;
  readonly cumulativeRefundFen: number;
  readonly monthlyEffectiveSalesFen: number;
  readonly productCapBps: number | null;
  readonly policy: CommissionPolicy | null;
}

export interface ExactCommissionFen {
  readonly numeratorFenBps: string;
  readonly denominatorBps: 10000;
  readonly wholeFen: number;
  readonly remainderFenBps: number;
  readonly roundingRequired: boolean;
}

export type CommissionResult =
  | {
      readonly status: "unresolved";
      readonly reason:
        | "monthly_sales_below_first_tier"
        | "eligibility_not_approved"
        | "product_cap_missing"
        | "policy_not_approved"
        | "policy_rate_exceeds_limit";
      readonly effectivePaidFen: number;
      readonly commission: null;
    }
  | {
      readonly status: "zero";
      readonly reason: "unpaid" | "fully_refunded";
      readonly effectivePaidFen: 0;
      readonly commission: ExactCommissionFen;
    }
  | {
      readonly status: "estimated" | "synthetic_estimate";
      readonly effectivePaidFen: number;
      readonly tierBps: number;
      readonly appliedRateBps: number;
      readonly policyVersion: string;
      readonly commission: ExactCommissionFen;
    };

function requireNonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

function requireBasisPoints(value: number, name: string): void {
  requireNonnegativeSafeInteger(value, name);
  if (value > RATE_DENOMINATOR_BPS) {
    throw new Error(`${name} cannot exceed 10000 bps`);
  }
}

export function resolveMonthlyCommissionTierBps(
  monthlyEffectiveSalesFen: number,
): number | null {
  requireNonnegativeSafeInteger(monthlyEffectiveSalesFen, "monthlyEffectiveSalesFen");
  if (monthlyEffectiveSalesFen < 5_900) return null;
  if (monthlyEffectiveSalesFen < 99_900) return 1_000;
  if (monthlyEffectiveSalesFen < 199_900) return 1_500;
  if (monthlyEffectiveSalesFen < 399_900) return 2_000;
  return 3_000;
}

function exactCommission(effectivePaidFen: number, rateBps: number): ExactCommissionFen {
  const numerator = BigInt(effectivePaidFen) * BigInt(rateBps);
  const denominator = BigInt(RATE_DENOMINATOR_BPS);
  const remainder = numerator % denominator;
  return {
    numeratorFenBps: numerator.toString(),
    denominatorBps: 10000,
    wholeFen: Number(numerator / denominator),
    remainderFenBps: Number(remainder),
    roundingRequired: remainder !== 0n,
  };
}

function unresolved(
  reason: Extract<CommissionResult, { status: "unresolved" }>["reason"],
  effectivePaidFen: number,
): CommissionResult {
  return { status: "unresolved", reason, effectivePaidFen, commission: null };
}

/** Calculates an exact estimate only; no result represents a settled balance. */
export function calculateReferralCommission(input: CommissionInput): CommissionResult {
  requireNonnegativeSafeInteger(input.actualPaidFen, "actualPaidFen");
  requireNonnegativeSafeInteger(input.cumulativeRefundFen, "cumulativeRefundFen");
  if (input.cumulativeRefundFen > input.actualPaidFen) {
    throw new Error("cumulativeRefundFen cannot exceed actualPaidFen");
  }
  if (input.productCapBps !== null) {
    requireBasisPoints(input.productCapBps, "productCapBps");
  }
  const tierBps = resolveMonthlyCommissionTierBps(input.monthlyEffectiveSalesFen);

  if (input.paymentStatus === "unpaid") {
    if (input.actualPaidFen !== 0 || input.cumulativeRefundFen !== 0) {
      throw new Error("unpaid input cannot contain paid or refunded amounts");
    }
    return {
      status: "zero",
      reason: "unpaid",
      effectivePaidFen: 0,
      commission: exactCommission(0, 0),
    };
  }
  if (input.paymentStatus !== "paid") {
    throw new Error("paymentStatus is invalid");
  }

  const effectivePaidFen = input.actualPaidFen - input.cumulativeRefundFen;
  if (effectivePaidFen === 0) {
    return {
      status: "zero",
      reason: "fully_refunded",
      effectivePaidFen: 0,
      commission: exactCommission(0, 0),
    };
  }
  if (input.eligibilityStatus !== "approved") {
    return unresolved("eligibility_not_approved", effectivePaidFen);
  }
  if (tierBps === null) {
    return unresolved("monthly_sales_below_first_tier", effectivePaidFen);
  }
  if (input.productCapBps === null) {
    return unresolved("product_cap_missing", effectivePaidFen);
  }
  const policy = input.policy;
  if (
    policy === null ||
    (policy.status !== "approved" && policy.status !== "synthetic") ||
    typeof policy.version !== "string" ||
    policy.version.trim() === ""
  ) {
    return unresolved("policy_not_approved", effectivePaidFen);
  }

  let appliedRateBps: number;
  if (policy.status === "synthetic") {
    if (policy.calculation.kind !== "synthetic_min_tier_product_cap") {
      return unresolved("policy_not_approved", effectivePaidFen);
    }
    appliedRateBps = Math.min(tierBps, input.productCapBps);
  } else {
    if (policy.calculation.kind !== "explicit_rate") {
      return unresolved("policy_not_approved", effectivePaidFen);
    }
    requireBasisPoints(policy.calculation.rateBps, "policy.rateBps");
    appliedRateBps = policy.calculation.rateBps;
    if (appliedRateBps > tierBps || appliedRateBps > input.productCapBps) {
      return unresolved("policy_rate_exceeds_limit", effectivePaidFen);
    }
  }

  return {
    status: policy.status === "approved" ? "estimated" : "synthetic_estimate",
    effectivePaidFen,
    tierBps,
    appliedRateBps,
    policyVersion: policy.version,
    commission: exactCommission(effectivePaidFen, appliedRateBps),
  };
}

export type WithdrawalEligibility =
  | { readonly status: "unresolved"; readonly reason: "balance_not_settled" }
  | { readonly status: "eligible"; readonly shortfallFen: 0 }
  | { readonly status: "ineligible"; readonly shortfallFen: number };

/** Requires an externally classified balance; it never accepts a commission result. */
export function evaluateWithdrawalEligibility(input: {
  readonly balanceStatus: "settled" | "estimated";
  readonly balanceFen: number;
}): WithdrawalEligibility {
  requireNonnegativeSafeInteger(input.balanceFen, "balanceFen");
  if (input.balanceStatus !== "settled") {
    return { status: "unresolved", reason: "balance_not_settled" };
  }
  if (input.balanceFen >= WITHDRAWAL_THRESHOLD_FEN) {
    return { status: "eligible", shortfallFen: 0 };
  }
  return {
    status: "ineligible",
    shortfallFen: WITHDRAWAL_THRESHOLD_FEN - input.balanceFen,
  };
}

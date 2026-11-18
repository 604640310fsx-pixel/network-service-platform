import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateReferralCommission,
  evaluateWithdrawalEligibility,
  resolveMonthlyCommissionTierBps,
  WITHDRAWAL_THRESHOLD_FEN,
  type CommissionInput,
  type CommissionPolicy,
} from "../src/referral/commission-core.js";

const APPROVED_POLICY: CommissionPolicy = {
  status: "approved",
  version: "test-approved-v1",
  calculation: { kind: "explicit_rate", rateBps: 1_000 },
};

function paidInput(overrides: Partial<CommissionInput> = {}): CommissionInput {
  return {
    paymentStatus: "paid",
    eligibilityStatus: "approved",
    actualPaidFen: 10_000,
    cumulativeRefundFen: 0,
    monthlyEffectiveSalesFen: 5_900,
    productCapBps: 3_000,
    policy: APPROVED_POLICY,
    ...overrides,
  };
}

test("monthly sales tiers include each lower bound and exclude each upper bound", () => {
  for (const [salesFen, expectedBps] of [
    [0, null],
    [5_899, null],
    [5_900, 1_000],
    [99_899, 1_000],
    [99_900, 1_500],
    [199_899, 1_500],
    [199_900, 2_000],
    [399_899, 2_000],
    [399_900, 3_000],
    [Number.MAX_SAFE_INTEGER, 3_000],
  ] as const) {
    assert.equal(resolveMonthlyCommissionTierBps(salesFen), expectedBps);
  }
  for (const salesFen of [-1, 5_900.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveMonthlyCommissionTierBps(salesFen));
  }
});

test("unpaid add-ons and fully refunded payments have zero effective amount and commission", () => {
  const unpaid = calculateReferralCommission(
    paidInput({ paymentStatus: "unpaid", actualPaidFen: 0 }),
  );
  assert.equal(unpaid.status, "zero");
  assert.equal(unpaid.effectivePaidFen, 0);
  assert.equal(unpaid.commission?.wholeFen, 0);
  assert.equal(unpaid.commission?.roundingRequired, false);

  const refunded = calculateReferralCommission(
    paidInput({ cumulativeRefundFen: 10_000 }),
  );
  assert.deepEqual(refunded, {
    status: "zero",
    reason: "fully_refunded",
    effectivePaidFen: 0,
    commission: {
      numeratorFenBps: "0",
      denominatorBps: 10_000,
      wholeFen: 0,
      remainderFenBps: 0,
      roundingRequired: false,
    },
  });
});

test("partial refunds remove the refunded portion without recomputing upstream monthly sales", () => {
  const result = calculateReferralCommission(
    paidInput({ actualPaidFen: 10_001, cumulativeRefundFen: 2 }),
  );
  assert.equal(result.status, "estimated");
  assert.equal(result.effectivePaidFen, 9_999);
  assert.deepEqual(result.commission, {
    numeratorFenBps: "9999000",
    denominatorBps: 10_000,
    wholeFen: 999,
    remainderFenBps: 9_000,
    roundingRequired: true,
  });
});

test("missing eligibility, tier, cap, or approved policy remains unresolved", () => {
  const cases: Array<[Partial<CommissionInput>, string]> = [
    [{ eligibilityStatus: "unapproved" }, "eligibility_not_approved"],
    [{ monthlyEffectiveSalesFen: 5_899 }, "monthly_sales_below_first_tier"],
    [{ productCapBps: null }, "product_cap_missing"],
    [{ policy: null }, "policy_not_approved"],
    [{ policy: { status: "unapproved", version: null } }, "policy_not_approved"],
  ];
  for (const [overrides, reason] of cases) {
    const result = calculateReferralCommission(paidInput(overrides));
    assert.equal(result.status, "unresolved");
    if (result.status === "unresolved") {
      assert.equal(result.reason, reason);
      assert.equal(result.commission, null);
    }
  }
});

test("approved policy supplies an explicit rate; no cap or tier is silently applied", () => {
  const result = calculateReferralCommission(
    paidInput({ productCapBps: 500 }),
  );
  assert.equal(result.status, "unresolved");
  if (result.status === "unresolved") {
    assert.equal(result.reason, "policy_rate_exceeds_limit");
  }

  const synthetic = calculateReferralCommission(
    paidInput({
      productCapBps: 500,
      policy: {
        status: "synthetic",
        version: "test-only",
        calculation: { kind: "synthetic_min_tier_product_cap" },
      },
    }),
  );
  assert.equal(synthetic.status, "synthetic_estimate");
  if (synthetic.status === "synthetic_estimate") {
    assert.equal(synthetic.appliedRateBps, 500);
    assert.equal(synthetic.commission.wholeFen, 500);
  }
});

test("all four tiers calculate with explicit approved rates", () => {
  for (const [monthlySalesFen, rateBps] of [
    [5_900, 1_000],
    [99_900, 1_500],
    [199_900, 2_000],
    [399_900, 3_000],
  ] as const) {
    const result = calculateReferralCommission(
      paidInput({
        monthlyEffectiveSalesFen: monthlySalesFen,
        policy: {
          status: "approved",
          version: "test-approved-v1",
          calculation: { kind: "explicit_rate", rateBps },
        },
      }),
    );
    assert.equal(result.status, "estimated");
    if (result.status === "estimated") {
      assert.equal(result.tierBps, rateBps);
      assert.equal(result.commission.wholeFen, rateBps);
      assert.equal(result.commission.roundingRequired, false);
    }
  }
});

test("invalid refund totals, unsafe fen, and invalid basis points are rejected", () => {
  for (const overrides of [
    { cumulativeRefundFen: -1 },
    { cumulativeRefundFen: 10_001 },
    { actualPaidFen: Number.MAX_SAFE_INTEGER + 1 },
    { actualPaidFen: 10_000.5 },
    { productCapBps: -1 },
    { productCapBps: 10_001 },
    { paymentStatus: "unpaid" as const },
  ]) {
    assert.throws(() => calculateReferralCommission(paidInput(overrides)));
  }
  assert.throws(() =>
    calculateReferralCommission(
      paidInput({
        policy: {
          status: "approved",
          version: "test-approved-v1",
          calculation: { kind: "explicit_rate", rateBps: 1_000.5 },
        },
      }),
    ),
  );
});

test("bigint multiplication preserves precision at maximum safe paid amount", () => {
  const amount = Number.MAX_SAFE_INTEGER;
  const result = calculateReferralCommission(
    paidInput({
      actualPaidFen: amount,
      monthlyEffectiveSalesFen: amount,
      policy: {
        status: "approved",
        version: "test-approved-v1",
        calculation: { kind: "explicit_rate", rateBps: 3_000 },
      },
    }),
  );
  assert.equal(result.status, "estimated");
  assert.equal(result.commission?.numeratorFenBps, (BigInt(amount) * 3_000n).toString());
  assert.equal(result.commission?.remainderFenBps, 3_000);
  assert.equal(result.commission?.roundingRequired, true);
});

test("withdrawal eligibility requires an external settled balance at 100000 fen", () => {
  assert.equal(WITHDRAWAL_THRESHOLD_FEN, 100_000);
  assert.deepEqual(
    evaluateWithdrawalEligibility({ balanceStatus: "estimated", balanceFen: 100_000 }),
    { status: "unresolved", reason: "balance_not_settled" },
  );
  assert.deepEqual(
    evaluateWithdrawalEligibility({ balanceStatus: "settled", balanceFen: 99_999 }),
    { status: "ineligible", shortfallFen: 1 },
  );
  assert.deepEqual(
    evaluateWithdrawalEligibility({ balanceStatus: "settled", balanceFen: 100_000 }),
    { status: "eligible", shortfallFen: 0 },
  );
  assert.throws(() =>
    evaluateWithdrawalEligibility({ balanceStatus: "settled", balanceFen: -1 }),
  );
});

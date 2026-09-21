import assert from "node:assert/strict";
import test from "node:test";

import {
  ReferralApiError,
  adaptReferralState,
  ensureReferralProfile,
  getReferralState,
  parseReferralStateResponse,
  type ReferralStateResponse,
} from "../app/lib/referral-api.ts";

const RESPONSE: ReferralStateResponse = {
  profile: {
    publicCode: "A".repeat(24),
    createdAt: "2026-09-22T03:04:05.678Z",
  },
  link: {
    status: "unavailable",
    reason: "public_route_not_integrated",
  },
  program: {
    tiers: [
      { minSalesFen: 5_900, maxSalesFen: 99_899, rateBps: 1_000 },
      { minSalesFen: 99_900, maxSalesFen: 199_899, rateBps: 1_500 },
      { minSalesFen: 199_900, maxSalesFen: 399_899, rateBps: 2_000 },
      { minSalesFen: 399_900, maxSalesFen: null, rateBps: 3_000 },
    ],
    withdrawalThresholdFen: 100_000,
    productCap: { status: "unconfigured" },
    commission: { status: "not_integrated" },
    refunds: { status: "not_integrated" },
    settlement: { status: "not_integrated" },
    withdrawn: { status: "not_integrated" },
  },
};

test("parses only the frozen identity/program response without fake financial zeros", () => {
  assert.deepEqual(parseReferralStateResponse(RESPONSE), RESPONSE);
  assert.throws(
    () =>
      parseReferralStateResponse({
        ...RESPONSE,
        program: {
          ...RESPONSE.program,
          productCap: { status: "configured", rateBps: 0 },
        },
      }),
    (error: unknown) =>
      error instanceof ReferralApiError && error.code === "invalid_response",
  );
  assert.throws(
    () =>
      parseReferralStateResponse({
        ...RESPONSE,
        program: { ...RESPONSE.program, withdrawnFen: 0 },
      }),
    (error: unknown) =>
      error instanceof ReferralApiError && error.code === "invalid_response",
  );
});

test("adapter covers pending/loading/error/ready and never enables an unavailable link", () => {
  assert.deepEqual(adaptReferralState({ status: "pending" }), {
    data: { status: "pending" },
    link: { status: "pending" },
    profile: null,
  });
  assert.deepEqual(adaptReferralState({ status: "loading" }), {
    data: { status: "loading" },
    link: { status: "pending" },
    profile: null,
  });
  assert.deepEqual(adaptReferralState({ status: "error" }), {
    data: { status: "error" },
    link: { status: "pending" },
    profile: null,
  });
  assert.deepEqual(adaptReferralState({ status: "ready", response: RESPONSE }), {
    data: { status: "pending" },
    link: { status: "unavailable" },
    profile: RESPONSE.profile,
  });
});

test("GET and CSRF POST use same-origin credentials and the exact referral endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ readonly input: string; readonly init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(typeof input, "string");
    calls.push({ input: input as string, init: init ?? {} });
    return new Response(JSON.stringify(RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await getReferralState();
    const csrfToken = "C".repeat(43);
    await ensureReferralProfile(csrfToken);
    assert.equal(calls[0]?.input, "/api/me/referral");
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(calls[0]?.init.credentials, "same-origin");
    assert.equal(calls[1]?.input, "/api/me/referral/profile");
    assert.equal(calls[1]?.init.method, "POST");
    assert.equal(calls[1]?.init.credentials, "same-origin");
    assert.equal(calls[1]?.init.body, "{}");
    assert.deepEqual(calls[1]?.init.headers, {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

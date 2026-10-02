import test from "node:test";
import assert from "node:assert/strict";
import { getMyServiceListing, getMyServices, PaymentApiError } from "../app/lib/payment-api.ts";
import { endOfUtcDay, serviceTerm, utcDateInput } from "../app/lib/serviceTerm.ts";
import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";

const CJK = /[㐀-鿿]/;

function withFetch<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const PURCHASE = {
  source: "purchase",
  orderRef: "DL0000000001",
  amountFen: 7900,
  currency: "CNY",
  orderStatus: "paid",
  serviceStatus: "open",
  createdAt: "2026-08-21T00:00:00.000Z",
  endsAt: "2026-12-31T23:59:59.999Z",
  planLabel: "US Residential Pro",
};
const GRANT = {
  source: "grant",
  grantId: 7,
  label: "Trial line",
  planLabel: "Trial line",
  startsAt: "2026-08-21T00:00:00.000Z",
  endsAt: null,
  status: "active",
};

test("the services listing splits purchases and gifts and keeps server order", async () => {
  const listing = await withFetch({ items: [PURCHASE, GRANT] }, () => getMyServiceListing());
  assert.deepEqual(listing.services.map((item) => [item.orderRef, item.endsAt, item.planLabel]), [
    ["DL0000000001", "2026-12-31T23:59:59.999Z", "US Residential Pro"],
  ]);
  assert.deepEqual(listing.grants, [{ grantId: 7, label: "Trial line", startsAt: "2026-08-21T00:00:00.000Z", endsAt: null }]);
  // Other pages keep receiving purchases only.
  const purchases = await withFetch({ items: [PURCHASE, GRANT] }, () => getMyServices());
  assert.deepEqual(purchases.map((item) => item.orderRef), ["DL0000000001"]);
});

test("responses from a pre-022 server still parse with long-term defaults", async () => {
  const { source: _source, endsAt: _endsAt, planLabel: _planLabel, ...legacy } = PURCHASE;
  const [item] = await withFetch({ items: [legacy] }, () => getMyServices());
  assert.equal(item.endsAt, null);
  assert.equal(item.planLabel, null);
});

test("malformed services or gifts fail closed", async () => {
  for (const items of [
    [{ ...GRANT, status: "revoked" }],
    [{ ...GRANT, label: "" }],
    [{ ...GRANT, endsAt: "soon" }],
    [{ ...PURCHASE, endsAt: 5 }],
    [{ ...PURCHASE, planLabel: "" }],
    [{ ...PURCHASE, source: "other" }],
  ]) {
    await assert.rejects(
      () => withFetch({ items }, () => getMyServiceListing()),
      (error) => error instanceof PaymentApiError && error.code === "invalid_response",
      JSON.stringify(items),
    );
  }
});

test("terms: long-term, remaining days rounded up, and expired stays visible", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  assert.deepEqual(serviceTerm(null, now), { kind: "long_term" });
  assert.deepEqual(serviceTerm("2026-08-23T00:00:00.000Z", now), { kind: "remaining", days: 2 });
  assert.deepEqual(serviceTerm("2026-08-21T12:00:01.000Z", now), { kind: "remaining", days: 1 });
  assert.deepEqual(serviceTerm("2026-08-21T12:00:00.000Z", now), { kind: "expired" });
  assert.deepEqual(serviceTerm("2026-01-01T00:00:00.000Z", now), { kind: "expired" });
});

test("date inputs map to the end of the UTC day and back", () => {
  assert.equal(endOfUtcDay(""), null);
  assert.equal(endOfUtcDay("2026-12-31"), "2026-12-31T23:59:59.999Z");
  assert.equal(utcDateInput("2026-12-31T23:59:59.999Z"), "2026-12-31");
  assert.equal(utcDateInput(null), "");
  for (const bad of ["2026-02-30", "31/12/2026", "2026-1-1"]) {
    assert.throws(() => endOfUtcDay(bad), RangeError, bad);
  }
});

test("customer-plan copy exists in both languages and English has no Chinese", () => {
  assert.deepEqual(Object.keys(en.adminServices).sort(), Object.keys(zh.adminServices).sort());
  assert.deepEqual(Object.keys(en.adminServices.errors).sort(), Object.keys(zh.adminServices.errors).sort());
  for (const [key, value] of Object.entries({ ...en.adminServices, ...en.adminServices.errors })) {
    if (typeof value === "string") assert.doesNotMatch(value, CJK, key);
  }
  assert.equal(en.services.termRemaining(1), "1 day left");
  assert.equal(en.services.termRemaining(3), "3 days left");
  assert.equal(zh.services.termRemaining(3), "剩余 3 天");
  assert.equal(en.services.gift, "Gift");
  assert.equal(zh.services.gift, "赠送");
  assert.equal(zh.services.termExpired, "已到期");
});

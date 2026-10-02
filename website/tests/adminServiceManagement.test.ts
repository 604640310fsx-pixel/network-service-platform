import test from "node:test";
import assert from "node:assert/strict";
import { getMyDeliveryLines, getMyGrantDelivery, getMyServiceListing, getMyServices, PaymentApiError } from "../app/lib/payment-api.ts";
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
  // GRANT mimics a gift from a server before Migration 023: catalog fields absent → null, no delivery.
  assert.deepEqual(listing.grants, [{
    grantId: 7, label: "Trial line", startsAt: "2026-08-21T00:00:00.000Z", endsAt: null,
    typeId: null, regionId: null, ispId: null, specId: null, durationId: null, months: null, valueFen: null,
    deliveryStatus: "pending_open",
  }]);
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

const STRUCTURED_GRANT = {
  ...GRANT,
  grantId: 9,
  typeId: "local-isp",
  regionId: "us",
  ispId: "us-verizon",
  specId: null,
  durationId: "month-1",
  months: 3,
  valueFen: 23700,
  deliveryStatus: "open",
};

test("structured gifts parse every catalog, month, value and delivery field", async () => {
  const { grants } = await withFetch({ items: [STRUCTURED_GRANT] }, () => getMyServiceListing());
  assert.deepEqual(grants[0], {
    grantId: 9, label: "Trial line", startsAt: "2026-08-21T00:00:00.000Z", endsAt: null,
    typeId: "local-isp", regionId: "us", ispId: "us-verizon", specId: null, durationId: "month-1",
    months: 3, valueFen: 23700, deliveryStatus: "open",
  });
  for (const bad of [{ months: 0 }, { valueFen: -1 }, { deliveryStatus: "delivered" }, { typeId: "" }, { months: 1.5 }]) {
    await assert.rejects(
      () => withFetch({ items: [{ ...STRUCTURED_GRANT, ...bad }] }, () => getMyServiceListing()),
      (error) => error instanceof PaymentApiError && error.code === "invalid_response",
      JSON.stringify(bad),
    );
  }
});

test("delivery-lines keeps gift lines out of the order-grouped list but still validates them", async () => {
  const serviceLine = { orderRef: "DL0000000001", position: 1, label: "Line A" };
  const giftLine = { source: "grant", grantId: 9, position: 1, label: "Gift line" };
  assert.deepEqual(await withFetch({ items: [serviceLine, giftLine] }, () => getMyDeliveryLines()), [serviceLine]);
  await assert.rejects(
    () => withFetch({ items: [{ ...giftLine, subscriptionUrl: "https://x.example.invalid" }] }, () => getMyDeliveryLines()),
    (error) => error instanceof PaymentApiError && error.code === "invalid_response",
  );
});

test("gift delivery parses https lines in order and rejects mismatched or unsafe payloads", async () => {
  const items = [
    { position: 1, label: "Line A", subscriptionUrl: "https://sub.example.invalid/a" },
    { position: 2, label: "Line B", subscriptionUrl: "https://sub.example.invalid/b" },
  ];
  const delivery = await withFetch({ grantId: 9, items }, () => getMyGrantDelivery(9));
  assert.deepEqual(delivery, { grantId: 9, items });
  for (const body of [
    { grantId: 8, items },
    { grantId: 9, items: [{ ...items[0], subscriptionUrl: "http://sub.example.invalid/a" }] },
    { grantId: 9, items: [{ ...items[1] }] },
    { grantId: 9, items: [] },
  ]) {
    await assert.rejects(
      () => withFetch(body, () => getMyGrantDelivery(9)),
      (error) => error instanceof PaymentApiError && error.code === "invalid_response",
      JSON.stringify(body),
    );
  }
});

test("structured-gift copy exists in both languages", () => {
  for (const key of ["grantPlan", "grantMonths", "grantValue", "open", "openTitle", "lineLabel", "lineUrl", "legacyGift"] as const) {
    assert.equal(typeof en.adminServices[key], "string", key);
    assert.equal(typeof zh.adminServices[key], "string", key);
    assert.doesNotMatch(en.adminServices[key], CJK, key);
  }
  assert.deepEqual(Object.keys(en.adminServices.deliveryStatus).sort(), Object.keys(zh.adminServices.deliveryStatus).sort());
  assert.equal(en.services.giftMonths(1), "1 month");
  assert.equal(en.services.giftMonths(3), "3 months");
  assert.equal(zh.services.giftMonths(3), "3 个月");
  assert.equal(en.services.giftValue("237"), "Value ¥237");
  assert.equal(en.adminServices.deliveredLines(2), "2 lines delivered");
});

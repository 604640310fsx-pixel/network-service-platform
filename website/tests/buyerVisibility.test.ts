import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
import { buyerPlanCounts, combineBuyerPlans } from "../app/components/dashboard/buyerPlans.ts";
// @ts-ignore TS5097
import { groupGiftLines } from "../app/components/network/giftLines.ts";
// @ts-ignore TS5097
import { getMyDeliveryLineListing, getMyDeliveryLines, type MyGrantItem, type MyServiceItem } from "../app/lib/payment-api.ts";
// @ts-ignore TS5097
import { en } from "../app/i18n/en.ts";
// @ts-ignore TS5097
import { zh } from "../app/i18n/zh.ts";

const CJK = /[㐀-鿿]/;

function service(orderRef: string, createdAt: string, serviceStatus: "open" | "pending_open"): MyServiceItem {
  return { orderRef, amountFen: 7_900, currency: "CNY", orderStatus: "paid", serviceStatus, createdAt, endsAt: null, planLabel: null };
}

function gift(grantId: number, startsAt: string, deliveryStatus: "open" | "pending_open", label = `Gift ${grantId}`): MyGrantItem {
  return {
    grantId, label, startsAt, endsAt: null, typeId: "local-isp", regionId: "us", ispId: "us-att", specId: null,
    durationId: "month-1", months: 3, valueFen: 26_400, deliveryStatus,
  } as MyGrantItem;
}

test("dashboard plans merge purchases and gifts newest first and count each by its own status", () => {
  const plans = combineBuyerPlans(
    [service("DL1", "2026-09-01T00:00:00.000Z", "open"), service("DL2", "2026-09-20T00:00:00.000Z", "pending_open")],
    [gift(7, "2026-10-01T00:00:00.000Z", "pending_open"), gift(8, "2026-09-10T00:00:00.000Z", "open")],
  );
  assert.deepEqual(plans.map((plan) => plan.key), ["grant:7", "purchase:DL2", "grant:8", "purchase:DL1"]);
  // purchases by serviceStatus, gifts by deliveryStatus
  assert.deepEqual(buyerPlanCounts(plans), { total: 4, open: 2, pending: 2 });
  assert.deepEqual(plans.map((plan) => plan.open), [false, false, true, true]);
});

test("a buyer with only a gift has one plan, not zero", () => {
  const plans = combineBuyerPlans([], [gift(3, "2026-10-02T00:00:00.000Z", "open", "演示赠送")]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.kind, "grant");
  assert.deepEqual(buyerPlanCounts(plans), { total: 1, open: 1, pending: 0 });
  assert.deepEqual(buyerPlanCounts([]), { total: 0, open: 0, pending: 0 });
});

test("gift lines group by grant id, keep pending gifts and never drop lines of an unlisted gift", () => {
  const groups = groupGiftLines(
    [gift(7, "2026-10-01T00:00:00.000Z", "open"), gift(8, "2026-10-02T00:00:00.000Z", "pending_open")],
    [
      { grantId: 7, position: 2, label: "B" },
      { grantId: 9, position: 1, label: "Orphan" },
      { grantId: 7, position: 1, label: "A" },
    ],
  );
  assert.deepEqual(groups.map((group) => [group.grantId, group.label, group.deliveryStatus, group.lines.map((line) => line.label)]), [
    [7, "Gift 7", "open", ["A", "B"]],
    [8, "Gift 8", "pending_open", []],
    [9, null, "open", ["Orphan"]],
  ]);
  assert.deepEqual(groupGiftLines([gift(7, "2026-10-01T00:00:00.000Z", "open")], null)[0]?.lines, []);
});

test("delivery-line listing keeps gift line names (no URL field) and service lines stay compatible", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    items: [
      { orderRef: "DL1", position: 1, label: "Service line" },
      { source: "grant", grantId: 7, position: 1, label: "Gift line" },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    const listing = await getMyDeliveryLineListing();
    assert.deepEqual(listing, {
      services: [{ orderRef: "DL1", position: 1, label: "Service line" }],
      grants: [{ grantId: 7, position: 1, label: "Gift line" }],
    });
    assert.deepEqual(await getMyDeliveryLines(), [{ orderRef: "DL1", position: 1, label: "Service line" }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("gift visibility copy is bilingual", () => {
  for (const key of ["latestGift", "giftValue", "giftStarted", "giftEnds", "giftLongTerm", "deliveryStatus", "giftDelivered", "giftAwaitingDelivery", "giftOpenHint", "giftPendingHint"] as const) {
    assert.ok(zh.dashboard[key], key);
    assert.doesNotMatch(en.dashboard[key], CJK, key);
  }
  assert.doesNotMatch(en.network.giftAwaitingLines, CJK);
  assert.equal(zh.dashboard.giftAwaitingDelivery, "待开通交付");
  assert.match(zh.dashboard.stats.services.hint, /赠送/);
  assert.doesNotMatch(en.dashboard.stats.open.hint, CJK);
});

test("the services page counts purchases and gifts with the dashboard semantics", () => {
  const page = readFileSync(new URL("../app/components/customer/CustomerServicesPage.tsx", import.meta.url), "utf8");
  assert.match(page, /const counts = buyerPlanCounts\(combineBuyerPlans\(items, grants\)\);/);
  for (const field of ["total", "open", "pending"]) assert.match(page, new RegExp(`<strong>\\{counts\\.${field}\\}</strong>`), field);
  assert.match(page, /itemCount\(counts\.total\)/);
  assert.doesNotMatch(page, /itemCount\(items\.length\)|<strong>\{items\.length\}<\/strong>/);
  // The total hint must say gifts are included, matching the dashboard copy.
  assert.equal(zh.services.totalHint, zh.dashboard.stats.services.hint);
  assert.equal(en.services.totalHint, en.dashboard.stats.services.hint);
});

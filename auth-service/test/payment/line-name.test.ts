import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { PaymentEnabledDependencies } from "../../src/http/payment-routes.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import { ACCESS_TOKEN_A, allRows, firstValue, insertWebSession, localIspSelection, paymentDependencies } from "./helpers.js";

/* NSP-LINE-NAME-10：绑定 VPS 的交付线路，买家可见名与 VPS 展示名一致。
   Catalog (helpers): "DMIT Premium" → "DMIT Premium", "Tokyo Transit A" → "日本东京 VPS 中转 A". */

type Catalog = PaymentEnabledDependencies["monitorTargetCatalog"];
const URL_A = "https://sub.example.invalid/a";
const URL_B = "https://sub.example.invalid/b";
const TOKYO = "日本东京 VPS 中转 A";

function seedPendingService(database: DatabaseConnection, userId: number, key: string): number {
  const dependencies = paymentDependencies(database);
  const order = createPaymentOrder(dependencies, {
    idempotencyKey: `line-name-${key}`,
    rawAccessToken: ACCESS_TOKEN_A,
    selection: localIspSelection(),
    contact: "c",
    scenarios: [],
    notes: null,
    acknowledgedAmountFen: 7_900,
    userId,
  });
  finalizePaid(dependencies, {
    outTradeNo: order.orderRef,
    tradeNo: `trade-${key}`,
    tradeStatus: "TRADE_SUCCESS",
    totalAmount: "79.00",
    totalAmountFen: 7_900,
    appId: "app-123",
    sellerId: "seller-456",
    notification: { notifyId: `n-${key}`, payloadHash: `h-${key}` },
  });
  return firstValue(database, "SELECT MAX(id) FROM services") as number;
}

async function withFixture(
  run: (fixture: {
    readonly database: DatabaseConnection;
    readonly buyerId: number;
    readonly app: (catalog?: Catalog | "default") => ReturnType<typeof buildApp>;
    readonly headers: Record<string, string>;
  }) => Promise<void>,
): Promise<void> {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "name-buyer@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "name-admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    const admin = insertWebSession(database, adminId);
    const apps: Array<ReturnType<typeof buildApp>> = [];
    const app = (catalog: Catalog | "default" = "default") => {
      const base = paymentDependencies(database);
      const built = buildApp({ payment: catalog === "default" ? base : { ...base, monitorTargetCatalog: catalog } });
      apps.push(built);
      return built;
    };
    try {
      await run({
        database,
        buyerId,
        app,
        headers: { cookie: admin.cookie, "content-type": "application/json", "x-csrf-token": admin.csrfToken },
      });
    } finally {
      for (const built of apps) await built.close();
    }
  });
}

test("opening names bound lines after their VPS (service and gift); an unbound gift line keeps its name", async () => {
  await withFixture(async ({ database, buyerId, app, headers }) => {
    const live = app();
    const serviceId = seedPendingService(database, buyerId, "open");
    const opened = await live.inject({
      method: "POST",
      url: `/api/admin/services/${serviceId}/open`,
      headers,
      payload: { items: [{ label: "My own name", subscriptionUrl: URL_A, monitorTargetKey: "Tokyo Transit A" }] },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.deepEqual(opened.json().items, [{ position: 1, label: TOKYO, monitorTargetKey: "Tokyo Transit A" }]);

    const grant = await live.inject({
      method: "POST", url: "/api/admin/grants", headers,
      payload: { userId: buyerId, typeId: "local-isp", regionId: "us", ispId: "us-verizon", durationId: "month-1", months: 1, valueFen: 7_900 },
    });
    const giftOpen = await live.inject({
      method: "POST", url: `/api/admin/grants/${grant.json().id}/open`, headers,
      payload: { items: [
        { label: "Gift custom", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium" },
        { label: "Gift free", subscriptionUrl: URL_B },
      ] },
    });
    assert.equal(giftOpen.statusCode, 200, giftOpen.body);
    assert.deepEqual(giftOpen.json().deliveryLines.map((line: { label: string }) => line.label), ["DMIT Premium", "Gift free"]);

    // The buyer-visible names follow; subscriptions still decrypt (the label is not part of the AAD).
    const buyer = insertWebSession(database, buyerId);
    const lines = await live.inject({ method: "GET", url: "/api/me/delivery-lines", headers: { cookie: buyer.cookie } });
    assert.deepEqual(lines.json().items.map((line: { label: string }) => line.label).sort(), ["DMIT Premium", "Gift free", TOKYO].sort());
    const delivery = await live.inject({ method: "GET", url: `/api/me/grants/${grant.json().id}/delivery`, headers: { cookie: buyer.cookie } });
    assert.equal(delivery.statusCode, 200, delivery.body);
    assert.equal(delivery.json().items[0].label, "DMIT Premium");
  });
});

test("bind and rebind rename the line; unbind keeps the last name (service and gift)", async () => {
  await withFixture(async ({ database, buyerId, app, headers }) => {
    const serviceId = seedPendingService(database, buyerId, "bind");
    const opened = await app(null).inject({
      method: "POST", url: `/api/admin/services/${serviceId}/open`, headers,
      payload: { allowUnbound: true, items: [{ label: "Unbound A", subscriptionUrl: URL_A }] },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.equal(opened.json().items[0].label, "Unbound A", "an unbound line keeps the admin's name");
    const live = app();
    const grant = await live.inject({
      method: "POST", url: "/api/admin/grants", headers,
      payload: { userId: buyerId, typeId: "local-isp", regionId: "us", ispId: "us-verizon", durationId: "month-1", months: 1, valueFen: 7_900 },
    });
    const grantId = grant.json().id as number;
    await live.inject({ method: "POST", url: `/api/admin/grants/${grantId}/open`, headers, payload: { items: [{ label: "Gift free", subscriptionUrl: URL_A }] } });

    for (const [url, read] of [
      [`/api/admin/services/${serviceId}/delivery/1`, () => firstValue(database, "SELECT label FROM service_delivery_items WHERE service_id = ?", serviceId)],
      [`/api/admin/grants/${grantId}/delivery/1`, () => firstValue(database, "SELECT label FROM admin_grant_delivery_items WHERE grant_id = ?", grantId)],
    ] as const) {
      const bind = (monitorTargetKey: string | null, catalog: Catalog | "default" = "default") =>
        app(catalog).inject({ method: "PATCH", url, headers, payload: { monitorTargetKey } });
      assert.equal((await bind("DMIT Premium")).statusCode, 200);
      assert.equal(read(), "DMIT Premium", url);
      const rebound = await bind("Tokyo Transit A");
      assert.equal(rebound.statusCode, 200);
      assert.equal(read(), TOKYO, url);
      assert.equal((await bind(null, null)).statusCode, 200, "unbind needs no catalog");
      assert.equal(read(), TOKYO, `${url}: unbinding keeps the last name`);
      // A label in the bind body is not accepted: binding alone names the line.
      const withLabel = await live.inject({ method: "PATCH", url, headers, payload: { monitorTargetKey: "DMIT Premium", label: "Mine" } });
      assert.equal(withLabel.statusCode, 400);
    }
  });
});

test("re-binding the same VPS syncs a legacy custom name and is audited as a rebind", async () => {
  await withFixture(async ({ database, buyerId, app, headers }) => {
    const serviceId = seedPendingService(database, buyerId, "legacy");
    const live = app();
    await live.inject({
      method: "POST", url: `/api/admin/services/${serviceId}/open`, headers,
      payload: { items: [{ label: "x", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium" }] },
    });
    // A row bound before this rule, with its own name (not rewritten by the release).
    database.prepare("UPDATE service_delivery_items SET label = 'Legacy name' WHERE service_id = ?").run(serviceId);
    const url = `/api/admin/services/${serviceId}/delivery/1`;
    const synced = await live.inject({ method: "PATCH", url, headers, payload: { monitorTargetKey: "DMIT Premium" } });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().deliveryLines[0].label, "DMIT Premium");
    const again = await live.inject({ method: "PATCH", url, headers, payload: { monitorTargetKey: "DMIT Premium" } });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(
      allRows(database, "SELECT action FROM audit_log WHERE action LIKE 'admin.service.delivery_%' ORDER BY id"),
      [{ action: "admin.service.delivery_rebind" }],
      "the sync is one rebind; a fully unchanged line is a no-op",
    );
  });
});

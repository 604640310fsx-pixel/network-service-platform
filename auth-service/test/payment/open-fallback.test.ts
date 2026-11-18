import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { PaymentEnabledDependencies } from "../../src/http/payment-routes.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  allRows,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

const URL_A = "https://sub.example.invalid/a";
const URL_B = "https://sub.example.invalid/b";

function seedPendingService(database: DatabaseConnection, userId: number): { serviceId: number; orderRef: string } {
  const dependencies = paymentDependencies(database);
  const order = createPaymentOrder(dependencies, {
    idempotencyKey: `fallback-${userId}`,
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
    tradeNo: `trade-${userId}`,
    tradeStatus: "TRADE_SUCCESS",
    totalAmount: "79.00",
    totalAmountFen: 7_900,
    appId: "app-123",
    sellerId: "seller-456",
    notification: { notifyId: `n-${userId}`, payloadHash: `h-${userId}` },
  });
  return { serviceId: firstValue(database, "SELECT MAX(id) FROM services") as number, orderRef: order.orderRef };
}

type Catalog = PaymentEnabledDependencies["monitorTargetCatalog"];
const FAILING: Catalog = { list: async () => { throw new Error("monitor down"); } };

async function withFixture(
  catalog: Catalog | "default",
  run: (fixture: {
    readonly database: DatabaseConnection;
    readonly app: ReturnType<typeof buildApp>;
    readonly admin: ReturnType<typeof insertWebSession>;
    readonly serviceId: number;
    readonly orderRef: string;
  }) => Promise<void>,
): Promise<void> {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "fallback-buyer@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "fallback-admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    const { serviceId, orderRef } = seedPendingService(database, buyerId);
    const base = paymentDependencies(database);
    const app = buildApp({ payment: catalog === "default" ? base : { ...base, monitorTargetCatalog: catalog } });
    try {
      await run({ database, app, admin: insertWebSession(database, adminId), serviceId, orderRef });
    } finally {
      await app.close();
    }
  });
}

function headers(session: ReturnType<typeof insertWebSession>) {
  return { cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrfToken };
}

test("with the catalog available, every line still needs an active VPS even when allowUnbound is sent", async () => {
  await withFixture("default", async ({ app, admin, serviceId, database }) => {
    for (const payload of [
      { allowUnbound: true, items: [{ label: "A", subscriptionUrl: URL_A }] },
      { allowUnbound: true, items: [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: null }] },
      { items: [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "Paused VPS" }] },
    ]) {
      const response = await app.inject({ method: "POST", url: `/api/admin/services/${serviceId}/open`, headers: headers(admin), payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.json().error.code, "invalid_monitor_target");
    }
    const ok = await app.inject({
      method: "POST",
      url: `/api/admin/services/${serviceId}/open`,
      headers: headers(admin),
      payload: { items: [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium" }] },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(allRows(database, "SELECT action FROM audit_log WHERE action LIKE 'service.%' ORDER BY id"), [{ action: "service.open" }]);
  });
});

for (const [name, catalog] of [["unconfigured", null], ["failing", FAILING]] as const) {
  test(`with the catalog ${name}, opening needs explicit allowUnbound and stores unbound lines`, async () => {
    await withFixture(catalog, async ({ app, admin, serviceId, orderRef, database }) => {
      // Without the explicit confirmation nothing opens: a line without a VPS is malformed (400),
      // and a line with a VPS cannot be validated (503, the pre-existing behaviour).
      const unconfirmed = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: headers(admin),
        payload: { items: [{ label: "A", subscriptionUrl: URL_A }] },
      });
      assert.equal(unconfirmed.statusCode, 400);
      assert.equal(unconfirmed.json().error.code, "invalid_item");
      const refused = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: headers(admin),
        payload: { items: [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium" }] },
      });
      assert.equal(refused.statusCode, 503);
      assert.equal(refused.json().error.code, "monitor_unavailable");
      const withTarget = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: headers(admin),
        payload: { allowUnbound: true, items: [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium" }] },
      });
      assert.equal(withTarget.statusCode, 400, "a target cannot be validated while the catalog is unavailable");
      const badFlag = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: headers(admin),
        payload: { allowUnbound: "yes", items: [{ label: "A", subscriptionUrl: URL_A }] },
      });
      assert.equal(badFlag.statusCode, 400);
      assert.equal(firstValue(database, "SELECT status FROM services WHERE id = ?", serviceId), "pending_open");

      const opened = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: headers(admin),
        payload: { allowUnbound: true, items: [{ label: "A", subscriptionUrl: URL_A }, { label: "B", subscriptionUrl: URL_B, monitorTargetKey: "" }] },
      });
      assert.equal(opened.statusCode, 200, opened.body);
      assert.deepEqual(opened.json().items, [
        { position: 1, label: "A", monitorTargetKey: null },
        { position: 2, label: "B", monitorTargetKey: null },
      ]);
      assert.deepEqual(allRows(database, "SELECT position, monitor_target_key FROM service_delivery_items ORDER BY position"), [
        { position: 1, monitor_target_key: null },
        { position: 2, monitor_target_key: null },
      ]);
      assert.deepEqual(allRows(database, "SELECT actor, action, target_ref FROM audit_log WHERE action LIKE 'service.%' ORDER BY id"), [
        { actor: "fallback-admin@example.com", action: "service.open", target_ref: orderRef },
        { actor: "fallback-admin@example.com", action: "service.delivery_unbound", target_ref: orderRef },
      ]);

      // Binding later needs the catalog; while it is unavailable the bind is refused.
      const bind = await app.inject({
        method: "PATCH",
        url: `/api/admin/services/${serviceId}/delivery/1`,
        headers: headers(admin),
        payload: { monitorTargetKey: "DMIT Premium" },
      });
      assert.equal(bind.statusCode, 503);
    });
  });
}

test("binding a delivered line later validates the target, the line and CSRF, and is audited", async () => {
  // Open unbound while the catalog fails, then bind with the catalog back.
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "bind-buyer@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "bind-admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    const { serviceId } = seedPendingService(database, buyerId);
    const admin = insertWebSession(database, adminId);
    const buyer = insertWebSession(database, buyerId);
    const down = buildApp({ payment: { ...paymentDependencies(database), monitorTargetCatalog: FAILING } });
    try {
      const opened = await down.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: headers(admin),
        payload: { allowUnbound: true, items: [{ label: "A", subscriptionUrl: URL_A }, { label: "B", subscriptionUrl: URL_B }] },
      });
      assert.equal(opened.statusCode, 200);
    } finally {
      await down.close();
    }
    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      const url = `/api/admin/services/${serviceId}/delivery/2`;
      for (const [payload, status] of [
        [{ monitorTargetKey: "Paused VPS" }, 400],
        [{ monitorTargetKey: "Unknown VPS" }, 400],
        [{ monitorTargetKey: "" }, 400],
        [{ monitorTargetKey: "DMIT Premium", extra: 1 }, 400],
      ] as const) {
        const response = await app.inject({ method: "PATCH", url, headers: headers(admin), payload });
        assert.equal(response.statusCode, status, JSON.stringify(payload));
      }
      const missingLine = await app.inject({ method: "PATCH", url: `/api/admin/services/${serviceId}/delivery/9`, headers: headers(admin), payload: { monitorTargetKey: "DMIT Premium" } });
      assert.equal(missingLine.statusCode, 404);
      const noCsrf = await app.inject({ method: "PATCH", url, headers: { cookie: admin.cookie, "content-type": "application/json" }, payload: { monitorTargetKey: "DMIT Premium" } });
      assert.equal(noCsrf.statusCode, 403);
      const asBuyer = await app.inject({ method: "PATCH", url, headers: headers(buyer), payload: { monitorTargetKey: "DMIT Premium" } });
      assert.equal(asBuyer.statusCode, 403);

      const bound = await app.inject({ method: "PATCH", url, headers: headers(admin), payload: { monitorTargetKey: "Tokyo Transit A" } });
      assert.equal(bound.statusCode, 200, bound.body);
      assert.deepEqual(bound.json().deliveryLines, [
        { position: 1, label: "A", monitorTargetKey: null },
        // NSP-LINE-NAME-10: binding renames the line to the VPS display name.
        { position: 2, label: "日本东京 VPS 中转 A", monitorTargetKey: "Tokyo Transit A" },
      ]);
      assert.deepEqual(
        allRows(database, "SELECT actor, action, target_ref FROM audit_log WHERE action = 'admin.service.delivery_bind'"),
        [{ actor: "bind-admin@example.com", action: "admin.service.delivery_bind", target_ref: `service:${serviceId}#2` }],
      );
      // The buyer's own delivery still decrypts after binding (encryption is unaffected by the target).
      const listed = await app.inject({ method: "GET", url: `/api/admin/users/${buyerId}/services`, headers: { cookie: admin.cookie } });
      assert.deepEqual(listed.json().services[0].deliveryLines.map((line: { monitorTargetKey: string | null }) => line.monitorTargetKey), [null, "Tokyo Transit A"]);
    } finally {
      await app.close();
    }
  });
});

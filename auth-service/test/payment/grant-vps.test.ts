import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import type { PaymentEnabledDependencies } from "../../src/http/payment-routes.js";
import { listMyNodeLines } from "../../src/monitor/node-status.js";
import { deliveryBindingChange } from "../../src/payment/admin-services.js";
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

/* NSP-GRANT-VPS-03：赠送交付线路可绑 VPS（Migration 024），以及服务/赠送线路的绑定、换绑、解绑。 */

type Session = ReturnType<typeof insertWebSession>;
type Catalog = PaymentEnabledDependencies["monitorTargetCatalog"];

const PLAN = { typeId: "local-isp", regionId: "us", ispId: "us-verizon", durationId: "month-1", months: 3, valueFen: 23_700 } as const;
const URL_A = "https://sub.example.invalid/gift-a?token=demo-a";
const URL_B = "https://sub.example.invalid/gift-b?token=demo-b";
const FAILING: Catalog = { list: async () => { throw new Error("monitor down"); } };

interface Fixture {
  readonly database: DatabaseConnection;
  readonly buyerId: number;
  readonly buyer: Session;
  readonly admin: Session;
  readonly app: (catalog?: Catalog | "default") => ReturnType<typeof buildApp>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "vps-buyer@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "vps-admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    const apps: Array<ReturnType<typeof buildApp>> = [];
    const app = (catalog: Catalog | "default" = "default") => {
      const base = paymentDependencies(database);
      const built = buildApp({ payment: catalog === "default" ? base : { ...base, monitorTargetCatalog: catalog } });
      apps.push(built);
      return built;
    };
    try {
      await run({ database, buyerId, buyer: insertWebSession(database, buyerId), admin: insertWebSession(database, adminId), app });
    } finally {
      for (const built of apps) await built.close();
    }
  });
}

function headers(session: Session, csrf = true): Record<string, string> {
  return { cookie: session.cookie, "content-type": "application/json", ...(csrf ? { "x-csrf-token": session.csrfToken } : {}) };
}

async function createGrant(app: ReturnType<typeof buildApp>, admin: Session, userId: number): Promise<number> {
  const response = await app.inject({ method: "POST", url: "/api/admin/grants", headers: headers(admin), payload: { userId, ...PLAN } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().id as number;
}

function openGrant(app: ReturnType<typeof buildApp>, admin: Session, grantId: number, items: unknown[]) {
  return app.inject({ method: "POST", url: `/api/admin/grants/${grantId}/open`, headers: headers(admin), payload: { items } });
}

function bind(app: ReturnType<typeof buildApp>, session: Session, url: string, monitorTargetKey: unknown, csrf = true) {
  return app.inject({ method: "PATCH", url, headers: headers(session, csrf), payload: { monitorTargetKey } });
}

test("binding changes are classified as bind, rebind, unbind or no-op", () => {
  assert.equal(deliveryBindingChange(null, "A"), "bind");
  assert.equal(deliveryBindingChange("A", "B"), "rebind");
  assert.equal(deliveryBindingChange("A", null), "unbind");
  assert.equal(deliveryBindingChange("A", "A"), null);
  assert.equal(deliveryBindingChange(null, null), null);
});

test("opening a gift stores optional VPS bindings validated like service opening, and the buyer never sees them", async () => {
  await withFixture(async ({ app, admin, buyer, buyerId, database }) => {
    const live = app();
    const grantId = await createGrant(live, admin, buyerId);

    for (const [items, status, code] of [
      [[{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "Paused VPS" }], 400, "invalid_monitor_target"],
      [[{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "Unknown VPS" }], 400, "invalid_monitor_target"],
      [[{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: 7 }], 400, "invalid_item"],
      [[{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium", extra: 1 }], 400, "invalid_item"],
    ] as const) {
      const response = await openGrant(live, admin, grantId, [...items]);
      assert.equal(response.statusCode, status, JSON.stringify(items));
      assert.equal(response.json().error.code, code);
    }
    // A target cannot be validated while the catalog is missing or failing.
    for (const catalog of [null, FAILING]) {
      const response = await openGrant(app(catalog), admin, grantId, [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium" }]);
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, "monitor_unavailable");
    }
    assert.equal(firstValue(database, "SELECT delivery_status FROM admin_grants WHERE id = ?", grantId), "pending_open");

    const opened = await openGrant(live, admin, grantId, [
      { label: "Tokyo line", subscriptionUrl: URL_A, monitorTargetKey: "Tokyo Transit A" },
      { label: "Plain line", subscriptionUrl: URL_B, monitorTargetKey: "" },
    ]);
    assert.equal(opened.statusCode, 200, opened.body);
    assert.deepEqual(opened.json().deliveryLines, [
      // NSP-LINE-NAME-10: the request label is overridden by the VPS display name.
      { position: 1, label: "日本东京 VPS 中转 A", monitorTargetKey: "Tokyo Transit A" },
      { position: 2, label: "Plain line", monitorTargetKey: null },
    ]);
    assert.deepEqual(allRows(database, "SELECT position, monitor_target FROM admin_grant_delivery_items ORDER BY position"), [
      { position: 1, monitor_target: "Tokyo Transit A" },
      { position: 2, monitor_target: null },
    ]);

    // Buyer surfaces carry names and URLs only; never the monitor key.
    for (const url of ["/api/me/delivery-lines", `/api/me/grants/${grantId}/delivery`, "/api/me/services"]) {
      const response = await live.inject({ method: "GET", url, headers: { cookie: buyer.cookie } });
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.body.includes("Tokyo Transit A"), false, url);
      assert.equal(response.body.includes("monitorTarget"), false, url);
    }
    // Node status reads the gift line's target (server-side only) instead of treating it as unbound.
    assert.deepEqual(
      listMyNodeLines(database, buyerId).filter((line) => line.kind === "grant").map((line) => [line.position, line.targetKey]),
      [[1, "Tokyo Transit A"], [2, null]],
    );
  });
});

test("gifts still open without the catalog when no line asks for a VPS", async () => {
  await withFixture(async ({ app, admin, buyerId }) => {
    const grantId = await createGrant(app(), admin, buyerId);
    const opened = await openGrant(app(null), admin, grantId, [{ label: "Plain", subscriptionUrl: URL_A }]);
    assert.equal(opened.statusCode, 200, opened.body);
    assert.deepEqual(opened.json().deliveryLines, [{ position: 1, label: "Plain", monitorTargetKey: null }]);
  });
});

test("gift lines can be bound, rebound and unbound with an audit row per change", async () => {
  await withFixture(async ({ app, admin, buyer, buyerId, database }) => {
    const live = app();
    const grantId = await createGrant(live, admin, buyerId);
    const pending = await bind(live, admin, `/api/admin/grants/${grantId}/delivery/1`, "DMIT Premium");
    assert.equal(pending.statusCode, 404, "a pending gift has no delivered line yet");
    assert.equal((await openGrant(live, admin, grantId, [{ label: "A", subscriptionUrl: URL_A }, { label: "B", subscriptionUrl: URL_B }])).statusCode, 200);

    const url = `/api/admin/grants/${grantId}/delivery/2`;
    for (const [payload, status] of [
      ["Paused VPS", 400],
      ["Unknown VPS", 400],
      ["", 400],
      [5, 400],
    ] as const) {
      assert.equal((await bind(live, admin, url, payload)).statusCode, status, JSON.stringify(payload));
    }
    assert.equal((await live.inject({ method: "PATCH", url, headers: headers(admin), payload: { monitorTargetKey: "DMIT Premium", extra: 1 } })).statusCode, 400);
    assert.equal((await live.inject({ method: "PATCH", url, headers: headers(admin), payload: {} })).statusCode, 400);
    assert.equal((await bind(live, admin, `/api/admin/grants/${grantId}/delivery/9`, "DMIT Premium")).statusCode, 404);
    assert.equal((await bind(live, admin, url, "DMIT Premium", false)).statusCode, 403);
    assert.equal((await bind(live, buyer, url, "DMIT Premium")).statusCode, 403);
    assert.equal((await bind(app(FAILING), admin, url, "DMIT Premium")).statusCode, 503);

    const bound = await bind(live, admin, url, "DMIT Premium");
    assert.equal(bound.statusCode, 200, bound.body);
    assert.deepEqual(bound.json().deliveryLines.map((line: { monitorTargetKey: string | null }) => line.monitorTargetKey), [null, "DMIT Premium"]);
    const same = await bind(live, admin, url, "DMIT Premium");
    assert.equal(same.statusCode, 200, "rebinding to the same target is a no-op");
    const rebound = await bind(live, admin, url, "Tokyo Transit A");
    assert.equal(rebound.json().deliveryLines[1].monitorTargetKey, "Tokyo Transit A");
    // Unbinding needs no catalog: it works while monitoring is down.
    const unbound = await bind(app(FAILING), admin, url, null);
    assert.equal(unbound.statusCode, 200, unbound.body);
    assert.equal(unbound.json().deliveryLines[1].monitorTargetKey, null);
    assert.deepEqual(
      allRows(database, "SELECT actor, action, target_ref FROM audit_log WHERE action LIKE 'admin.grant.delivery_%' ORDER BY id"),
      ["bind", "rebind", "unbind"].map((change) => ({
        actor: "vps-admin@example.com",
        action: `admin.grant.delivery_${change}`,
        target_ref: `grant:${grantId}#2`,
      })),
    );

    // Revoked gifts cannot be changed.
    assert.equal((await live.inject({ method: "PATCH", url: `/api/admin/grants/${grantId}`, headers: headers(admin), payload: { status: "revoked" } })).statusCode, 200);
    const revoked = await bind(live, admin, url, "DMIT Premium");
    assert.equal(revoked.statusCode, 409);
    assert.equal(revoked.json().error.code, "grant_revoked");
  });
});

test("service lines can be rebound and unbound, each change audited", async () => {
  await withFixture(async ({ app, admin, buyerId, database }) => {
    const dependencies = paymentDependencies(database);
    const order = createPaymentOrder(dependencies, {
      idempotencyKey: "grant-vps-service",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "c",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: buyerId,
    });
    finalizePaid(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-grant-vps",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
      notification: { notifyId: "n-grant-vps", payloadHash: "h-grant-vps" },
    });
    const serviceId = firstValue(database, "SELECT MAX(id) FROM services") as number;
    const live = app();
    const opened = await live.inject({
      method: "POST",
      url: `/api/admin/services/${serviceId}/open`,
      headers: headers(admin),
      payload: { items: [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "DMIT Premium" }] },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    const url = `/api/admin/services/${serviceId}/delivery/1`;
    const rebound = await bind(live, admin, url, "Tokyo Transit A");
    assert.equal(rebound.statusCode, 200, rebound.body);
    assert.equal(rebound.json().deliveryLines[0].monitorTargetKey, "Tokyo Transit A");
    const unbound = await bind(app(null), admin, url, null);
    assert.equal(unbound.statusCode, 200, unbound.body);
    assert.equal(unbound.json().deliveryLines[0].monitorTargetKey, null);
    assert.equal((await bind(live, admin, url, "Paused VPS")).statusCode, 400);
    assert.deepEqual(
      allRows(database, "SELECT action, target_ref FROM audit_log WHERE action LIKE 'admin.service.delivery_%' ORDER BY id"),
      [
        { action: "admin.service.delivery_rebind", target_ref: `service:${serviceId}#1` },
        { action: "admin.service.delivery_unbind", target_ref: `service:${serviceId}#1` },
      ],
    );
    assert.equal(firstValue(database, "SELECT monitor_target_key FROM service_delivery_items WHERE service_id = ?", serviceId), null);
  });
});

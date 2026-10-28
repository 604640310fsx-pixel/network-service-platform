import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import { parseEndsAt } from "../../src/payment/admin-services.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  allRows,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

type Session = ReturnType<typeof insertWebSession>;

// A real sellable_plans combination (the order tests buy the same one).
const PLAN = { typeId: "local-isp", regionId: "us", ispId: "us-verizon", durationId: "month-1", months: 1, valueFen: 7_900 } as const;

function seedPaidService(database: DatabaseConnection, userId: number): number {
  const dependencies = paymentDependencies(database);
  const order = createPaymentOrder(dependencies, {
    idempotencyKey: `admin-svc-${userId}`,
    rawAccessToken: ACCESS_TOKEN_A,
    selection: localIspSelection(),
    contact: "delivery-contact",
    scenarios: ["AI 工具"],
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
    notification: { notifyId: `notify-${userId}`, payloadHash: `hash-${userId}` },
  });
  const serviceId = firstValue(database, "SELECT MAX(id) FROM services");
  assert.equal(typeof serviceId, "number");
  return serviceId as number;
}

async function withAdminFixture(
  run: (fixture: {
    readonly database: DatabaseConnection;
    readonly app: ReturnType<typeof buildApp>;
    readonly buyerId: number;
    readonly adminId: number;
    readonly buyer: Session;
    readonly admin: Session;
    readonly serviceId: number;
  }) => Promise<void>,
): Promise<void> {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "buyer@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const buyer = insertWebSession(database, buyerId);
    const admin = insertWebSession(database, adminId);
    const serviceId = seedPaidService(database, buyerId);
    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      await run({ database, app, buyerId, adminId, buyer, admin, serviceId });
    } finally {
      await app.close();
    }
  });
}

function json(session: Session, csrf = true): Record<string, string> {
  return {
    cookie: session.cookie,
    "content-type": "application/json",
    ...(csrf ? { "x-csrf-token": session.csrfToken } : {}),
  };
}

test("endsAt accepts only a strict UTC instant or null", () => {
  assert.deepEqual(parseEndsAt(null), { ok: true, value: null });
  assert.deepEqual(parseEndsAt("2026-12-31T23:59:59.999Z"), { ok: true, value: "2026-12-31T23:59:59.999Z" });
  assert.deepEqual(parseEndsAt("2026-12-31T23:59:59Z"), { ok: true, value: "2026-12-31T23:59:59.000Z" });
  for (const bad of ["2026-12-31", "2026-02-30T00:00:00Z", "2026-12-31T23:59:59+08:00", "tomorrow", 1, "", "1999-01-01T00:00:00Z"]) {
    assert.equal(parseEndsAt(bad).ok, false, String(bad));
  }
});

test("admin endpoints require a session (401), the admin role (403) and CSRF on writes", async () => {
  await withAdminFixture(async ({ app, buyer, admin, serviceId, buyerId }) => {
    const requests = [
      { method: "GET" as const, url: "/api/admin/users?q=buyer" },
      { method: "GET" as const, url: `/api/admin/users/${buyerId}/services` },
      { method: "PATCH" as const, url: `/api/admin/services/${serviceId}`, payload: { note: "x" } },
      { method: "POST" as const, url: "/api/admin/grants", payload: { userId: buyerId, ...PLAN, label: "Gift" } },
      { method: "PATCH" as const, url: "/api/admin/grants/1", payload: { status: "revoked" } },
    ];
    for (const request of requests) {
      const anonymous = await app.inject({ ...request, headers: { "content-type": "application/json" } });
      assert.equal(anonymous.statusCode, 401, `${request.method} ${request.url} anonymous`);
      const asBuyer = await app.inject({ ...request, headers: json(buyer) });
      assert.equal(asBuyer.statusCode, 403, `${request.method} ${request.url} buyer`);
      assert.equal(asBuyer.json().error.code, "forbidden");
    }
    for (const request of requests.filter((item) => item.method !== "GET")) {
      const noCsrf = await app.inject({ ...request, headers: json(admin, false) });
      assert.equal(noCsrf.statusCode, 403, `${request.method} ${request.url} without CSRF`);
      assert.equal(noCsrf.json().error.code, "csrf_invalid");
      const wrongCsrf = await app.inject({ ...request, headers: { ...json(admin, false), "x-csrf-token": buyer.csrfToken } });
      assert.equal(wrongCsrf.statusCode, 403, `${request.method} ${request.url} with another session's CSRF`);
    }
  });
});

test("admin user search matches email substrings literally and is bounded", async () => {
  await withAdminFixture(async ({ app, admin, database }) => {
    for (let index = 0; index < 25; index += 1) {
      insertAuthenticationUser(database, { email: `bulk${index}@example.com`, passwordHash: "hash", status: "active" });
    }
    const found = await app.inject({ method: "GET", url: "/api/admin/users?q=BUYER", headers: json(admin, false) });
    assert.equal(found.statusCode, 200);
    assert.deepEqual(found.json().items.map((item: { email: string }) => item.email), ["buyer@example.com"]);
    assert.deepEqual(Object.keys(found.json().items[0]).sort(), ["createdAt", "email", "id", "role", "status"]);
    const bulk = await app.inject({ method: "GET", url: "/api/admin/users?q=bulk", headers: json(admin, false) });
    assert.equal(bulk.json().items.length, 20);
    const wildcard = await app.inject({ method: "GET", url: "/api/admin/users?q=%25", headers: json(admin, false) });
    assert.deepEqual(wildcard.json().items, []);
    for (const url of ["/api/admin/users", "/api/admin/users?q=", `/api/admin/users?q=${"a".repeat(101)}`]) {
      const invalid = await app.inject({ method: "GET", url, headers: json(admin, false) });
      assert.equal(invalid.statusCode, 400, url);
      assert.equal(invalid.json().error.code, "invalid_query");
    }
  });
});

test("PATCH service sets expiry, plan label and note with an audit row; buyers see no note", async () => {
  await withAdminFixture(async ({ app, admin, buyer, database, serviceId, buyerId }) => {
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/admin/services/${serviceId}`,
      headers: json(admin),
      payload: { endsAt: "2026-12-31T23:59:59.999Z", planLabel: "  US Residential Pro  ", note: "VIP customer — renewal agreed" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().endsAt, "2026-12-31T23:59:59.999Z");
    assert.equal(patched.json().planLabel, "US Residential Pro");
    assert.equal(patched.json().adminNote, "VIP customer — renewal agreed");
    assert.deepEqual(
      allRows(database, "SELECT ends_at, plan_override, admin_note FROM services WHERE id = ?", serviceId),
      [{ ends_at: "2026-12-31T23:59:59.999Z", plan_override: '{"label":"US Residential Pro"}', admin_note: "VIP customer — renewal agreed" }],
    );
    assert.deepEqual(
      allRows(database, "SELECT actor, action, target_ref FROM audit_log WHERE action = 'admin.service.update'"),
      [{ actor: "admin@example.com", action: "admin.service.update", target_ref: `service:${serviceId}` }],
    );

    const mine = await app.inject({ method: "GET", url: "/api/me/services", headers: { cookie: buyer.cookie } });
    assert.equal(mine.statusCode, 200);
    const [item] = mine.json().items;
    assert.equal(item.source, "purchase");
    assert.equal(item.endsAt, "2026-12-31T23:59:59.999Z");
    assert.equal(item.planLabel, "US Residential Pro");
    assert.equal(mine.body.includes("VIP customer"), false, "admin_note never reaches the buyer");
    assert.equal(Object.hasOwn(item, "adminNote"), false);

    const listed = await app.inject({ method: "GET", url: `/api/admin/users/${buyerId}/services`, headers: json(admin, false) });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().services[0].adminNote, "VIP customer — renewal agreed");
    assert.deepEqual(listed.json().grants, []);

    // null clears: long-term again, order snapshot again, no note.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/admin/services/${serviceId}`,
      headers: json(admin),
      payload: { endsAt: null, planLabel: null, note: "  " },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual([cleared.json().endsAt, cleared.json().planLabel, cleared.json().adminNote], [null, null, null]);
    const mineAgain = await app.inject({ method: "GET", url: "/api/me/services", headers: { cookie: buyer.cookie } });
    assert.deepEqual([mineAgain.json().items[0].endsAt, mineAgain.json().items[0].planLabel], [null, null]);
  });
});

test("PATCH service rejects unknown keys, bad values, empty bodies and unknown ids", async () => {
  await withAdminFixture(async ({ app, admin, database, serviceId }) => {
    for (const payload of [
      {},
      { status: "open" },
      { endsAt: "2026-12-31" },
      { endsAt: "2026-02-30T00:00:00.000Z" },
      { planLabel: "" },
      { planLabel: "x".repeat(81) },
      { planLabel: "line\nbreak" },
      { note: "x".repeat(501) },
      { note: 5 },
    ]) {
      const response = await app.inject({ method: "PATCH", url: `/api/admin/services/${serviceId}`, headers: json(admin), payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.json().error.code, "invalid_service_patch");
    }
    const missing = await app.inject({ method: "PATCH", url: "/api/admin/services/999", headers: json(admin), payload: { note: "x" } });
    assert.equal(missing.statusCode, 404);
    const badId = await app.inject({ method: "PATCH", url: "/api/admin/services/abc", headers: json(admin), payload: { note: "x" } });
    assert.equal(badId.statusCode, 404);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM audit_log WHERE action LIKE 'admin.%'"), 0);
    assert.deepEqual(
      allRows(database, "SELECT ends_at, plan_override, admin_note FROM services"),
      [{ ends_at: null, plan_override: null, admin_note: null }],
    );
  });
});

test("grants are created without orders or payments, shown to the buyer, and disappear when revoked", async () => {
  await withAdminFixture(async ({ app, admin, buyer, buyerId, database }) => {
    const ordersBefore = firstValue(database, "SELECT COUNT(*) FROM orders");
    const paymentsBefore = firstValue(database, "SELECT COUNT(*) FROM payments");
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/grants",
      headers: json(admin),
      payload: { userId: buyerId, ...PLAN, label: "Trial line", endsAt: "2026-09-30T23:59:59.999Z", reason: "compensation for outage" },
    });
    assert.equal(created.statusCode, 200, created.body);
    const grant = created.json();
    assert.equal(grant.status, "active");
    assert.equal(grant.startsAt, "2026-08-21T00:00:00.000Z");
    assert.equal(grant.reason, "compensation for outage");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), ordersBefore);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM payments"), paymentsBefore);

    const mine = await app.inject({ method: "GET", url: "/api/me/services", headers: { cookie: buyer.cookie } });
    const items = mine.json().items as Array<Record<string, unknown>>;
    assert.deepEqual(items.map((item) => item.source), ["purchase", "grant"]);
    assert.deepEqual(items[1], {
      source: "grant",
      grantId: grant.id,
      label: "Trial line",
      planLabel: "Trial line",
      startsAt: "2026-08-21T00:00:00.000Z",
      endsAt: "2026-09-30T23:59:59.999Z",
      status: "active",
      typeId: "local-isp",
      regionId: "us",
      ispId: "us-verizon",
      specId: null,
      durationId: "month-1",
      months: 1,
      valueFen: 7_900,
      deliveryStatus: "pending_open",
    });
    assert.equal(mine.body.includes("compensation"), false, "grant reason never reaches the buyer");

    const relabelled = await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: json(admin), payload: { label: "Trial line+", endsAt: null } });
    assert.equal(relabelled.statusCode, 200);
    assert.deepEqual([relabelled.json().label, relabelled.json().endsAt], ["Trial line+", null]);

    const revoked = await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: json(admin), payload: { status: "revoked" } });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().status, "revoked");
    const afterRevoke = await app.inject({ method: "GET", url: "/api/me/services", headers: { cookie: buyer.cookie } });
    assert.deepEqual((afterRevoke.json().items as Array<{ source: string }>).map((item) => item.source), ["purchase"]);

    const reactivate = await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: json(admin), payload: { label: "again" } });
    assert.equal(reactivate.statusCode, 409);
    assert.equal(reactivate.json().error.code, "grant_revoked");

    const listed = await app.inject({ method: "GET", url: `/api/admin/users/${buyerId}/services`, headers: json(admin, false) });
    assert.equal(listed.json().grants[0].status, "revoked");
    assert.equal(listed.json().grants[0].reason, "compensation for outage");

    assert.deepEqual(
      allRows(database, "SELECT actor, action, target_ref FROM audit_log WHERE action LIKE 'admin.grant.%' ORDER BY id"),
      [
        { actor: "admin@example.com", action: "admin.grant.create", target_ref: `grant:${grant.id}` },
        { actor: "admin@example.com", action: "admin.grant.update", target_ref: `grant:${grant.id}` },
        { actor: "admin@example.com", action: "admin.grant.revoke", target_ref: `grant:${grant.id}` },
      ],
    );
  });
});

test("grant input is validated fail-closed", async () => {
  await withAdminFixture(async ({ app, admin, buyerId, database }) => {
    for (const payload of [
      {},
      { userId: buyerId },
      { userId: buyerId, label: "Gift" },
      { userId: buyerId, ...PLAN, label: "x".repeat(81) },
      { userId: "1", ...PLAN },
      { userId: buyerId, ...PLAN, extra: true },
      { userId: buyerId, ...PLAN, endsAt: "2026-09-30" },
      { userId: buyerId, ...PLAN, months: 0 },
      { userId: buyerId, ...PLAN, months: 1.5 },
      { userId: buyerId, ...PLAN, valueFen: -1 },
      { userId: buyerId, ...PLAN, typeId: "Local ISP" },
      { userId: buyerId, ...PLAN, durationId: undefined },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/grants", headers: json(admin), payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    const past = await app.inject({
      method: "POST",
      url: "/api/admin/grants",
      headers: json(admin),
      payload: { userId: buyerId, ...PLAN, label: "Gift", endsAt: "2026-08-20T00:00:00.000Z" },
    });
    assert.equal(past.statusCode, 400);
    assert.equal(past.json().error.code, "invalid_ends_at");
    const unknownUser = await app.inject({ method: "POST", url: "/api/admin/grants", headers: json(admin), payload: { userId: 999, ...PLAN, label: "Gift" } });
    assert.equal(unknownUser.statusCode, 404);
    assert.equal(unknownUser.json().error.code, "user_not_found");
    for (const payload of [{}, { status: "active" }, { label: "" }]) {
      const response = await app.inject({ method: "PATCH", url: "/api/admin/grants/1", headers: json(admin), payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    const missing = await app.inject({ method: "PATCH", url: "/api/admin/grants/999", headers: json(admin), payload: { status: "revoked" } });
    assert.equal(missing.statusCode, 404);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM admin_grants"), 0);
  });
});

test("listing services for an unknown user is a 404, and other buyers' grants stay private", async () => {
  await withAdminFixture(async ({ app, admin, database, buyerId }) => {
    const missing = await app.inject({ method: "GET", url: "/api/admin/users/999/services", headers: json(admin, false) });
    assert.equal(missing.statusCode, 404);
    const otherId = insertAuthenticationUser(database, { email: "other@example.com", passwordHash: "hash", status: "active" });
    const other = insertWebSession(database, otherId);
    await app.inject({ method: "POST", url: "/api/admin/grants", headers: json(admin), payload: { userId: buyerId, ...PLAN, label: "Only for buyer" } });
    const othersView = await app.inject({ method: "GET", url: "/api/me/services", headers: { cookie: other.cookie } });
    assert.equal(othersView.statusCode, 200);
    assert.deepEqual(othersView.json().items, []);
  });
});

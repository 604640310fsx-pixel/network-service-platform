import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { addUtcMonths, defaultGrantLabel } from "../../src/payment/admin-services.js";
import {
  decryptGrantDeliveryItem,
  decryptServiceDeliveryItem,
  encryptGrantDeliveryItem,
} from "../../src/payment/delivery-crypto.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import { DELIVERY_KEYRING, allRows, firstValue, insertWebSession, paymentDependencies } from "./helpers.js";

type Session = ReturnType<typeof insertWebSession>;

const PLAN = { typeId: "local-isp", regionId: "us", ispId: "us-verizon", durationId: "month-1", months: 3, valueFen: 23_700 } as const;
const URL_A = "https://sub.example.invalid/gift-a?token=demo-a";
const URL_B = "https://sub.example.invalid/gift-b?token=demo-b";

async function withFixture(
  run: (fixture: {
    readonly database: DatabaseConnection;
    readonly app: ReturnType<typeof buildApp>;
    readonly buyerId: number;
    readonly buyer: Session;
    readonly other: Session;
    readonly admin: Session;
  }) => Promise<void>,
): Promise<void> {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "buyer@example.com", passwordHash: "hash", status: "active" });
    const otherId = insertAuthenticationUser(database, { email: "other@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    const app = buildApp({ payment: paymentDependencies(database) });
    try {
      await run({
        database,
        app,
        buyerId,
        buyer: insertWebSession(database, buyerId),
        other: insertWebSession(database, otherId),
        admin: insertWebSession(database, adminId),
      });
    } finally {
      await app.close();
    }
  });
}

function headers(session: Session, csrf = true): Record<string, string> {
  return { cookie: session.cookie, "content-type": "application/json", ...(csrf ? { "x-csrf-token": session.csrfToken } : {}) };
}

async function createGrant(app: ReturnType<typeof buildApp>, admin: Session, payload: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: "/api/admin/grants", headers: headers(admin), payload });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { id: number; label: string; endsAt: string | null; deliveryStatus: string; [key: string]: unknown };
}

test("addUtcMonths keeps the time of day and clamps to the month's last day", () => {
  assert.equal(addUtcMonths("2026-08-21T10:30:00.000Z", 3), "2026-11-21T10:30:00.000Z");
  assert.equal(addUtcMonths("2026-01-31T00:00:00.000Z", 1), "2026-02-28T00:00:00.000Z");
  assert.equal(addUtcMonths("2028-01-31T00:00:00.000Z", 1), "2028-02-29T00:00:00.000Z");
  assert.equal(addUtcMonths("2026-12-15T00:00:00.000Z", 12), "2027-12-15T00:00:00.000Z");
  assert.equal(defaultGrantLabel({ typeId: "local-isp", regionId: "us", ispId: "us-verizon", specId: null, durationId: "month-1" }, 3), "US us-verizon local-isp · 3M");
});

test("structured gifts validate the catalog, default the label and derive endsAt from months", async () => {
  await withFixture(async ({ app, admin, buyerId, database }) => {
    const grant = await createGrant(app, admin, { userId: buyerId, ...PLAN, reason: "loyalty" });
    assert.equal(grant.label, "US us-verizon local-isp · 3M");
    assert.equal(grant.endsAt, "2026-11-21T00:00:00.000Z", "starts_at (test clock) + 3 months");
    assert.deepEqual(
      [grant.typeId, grant.regionId, grant.ispId, grant.specId, grant.durationId, grant.months, grant.valueFen, grant.deliveryStatus, grant.openedAt],
      ["local-isp", "us", "us-verizon", null, "month-1", 3, 23_700, "pending_open", null],
    );
    const explicit = await createGrant(app, admin, { userId: buyerId, ...PLAN, label: "VIP line", endsAt: "2026-09-01T00:00:00.000Z" });
    assert.equal(explicit.endsAt, "2026-09-01T00:00:00.000Z", "an explicit endsAt wins over months");
    assert.equal(explicit.label, "VIP line");

    for (const selection of [
      { regionId: "jp" },
      { durationId: "month-7" },
      { specId: "shared-5" },
      { ispId: "us-att", typeId: "residential" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/grants",
        headers: headers(admin),
        payload: { userId: buyerId, ...PLAN, ...selection },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(selection));
      assert.equal(response.json().error.code, "invalid_plan");
    }
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM admin_grants"), 2);
  });
});

test("opening a gift stores encrypted lines; the buyer sees names in delivery-lines and URLs only via the owned endpoint", async () => {
  await withFixture(async ({ app, admin, buyer, other, buyerId, database }) => {
    const grant = await createGrant(app, admin, { userId: buyerId, ...PLAN, label: "Gift line", reason: "secret reason" });
    const pendingDelivery = await app.inject({ method: "GET", url: `/api/me/grants/${grant.id}/delivery`, headers: { cookie: buyer.cookie } });
    assert.equal(pendingDelivery.statusCode, 404, "pending gifts expose no delivery");

    for (const items of [
      [],
      [{ label: "A", subscriptionUrl: "http://sub.example.invalid/x" }],
      [{ label: "", subscriptionUrl: URL_A }],
      [{ label: "A", subscriptionUrl: URL_A, monitorTargetKey: "x" }],
    ]) {
      const invalid = await app.inject({ method: "POST", url: `/api/admin/grants/${grant.id}/open`, headers: headers(admin), payload: { items } });
      assert.equal(invalid.statusCode, 400, JSON.stringify(items));
    }
    const noCsrf = await app.inject({ method: "POST", url: `/api/admin/grants/${grant.id}/open`, headers: headers(admin, false), payload: { items: [] } });
    assert.equal(noCsrf.statusCode, 403);
    const asBuyer = await app.inject({ method: "POST", url: `/api/admin/grants/${grant.id}/open`, headers: headers(buyer), payload: { items: [] } });
    assert.equal(asBuyer.statusCode, 403);

    const opened = await app.inject({
      method: "POST",
      url: `/api/admin/grants/${grant.id}/open`,
      headers: headers(admin),
      payload: { items: [{ label: "Line A", subscriptionUrl: URL_A }, { label: "Line B", subscriptionUrl: URL_B }] },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.equal(opened.json().deliveryStatus, "open");
    assert.equal(opened.json().openedAt, "2026-08-21T00:00:00.000Z");
    assert.deepEqual(opened.json().deliveryLines, [
      { position: 1, label: "Line A", monitorTargetKey: null },
      { position: 2, label: "Line B", monitorTargetKey: null },
    ]);
    assert.equal(opened.body.includes(URL_A), false, "the admin response never echoes subscription URLs");

    const stored = allRows(database, "SELECT position, label, ciphertext FROM admin_grant_delivery_items ORDER BY position");
    assert.equal(stored.length, 2);
    assert.equal(Buffer.from(stored[0]?.ciphertext as Buffer).toString("utf8").includes("sub.example.invalid"), false);
    assert.deepEqual(
      allRows(database, "SELECT action, target_ref FROM audit_log WHERE action LIKE 'admin.grant.%' ORDER BY id"),
      [
        { action: "admin.grant.create", target_ref: `grant:${grant.id}` },
        { action: "admin.grant.open", target_ref: `grant:${grant.id}` },
      ],
    );

    const again = await app.inject({ method: "POST", url: `/api/admin/grants/${grant.id}/open`, headers: headers(admin), payload: { items: [{ label: "C", subscriptionUrl: URL_A }] } });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, "invalid_transition");

    const lines = await app.inject({ method: "GET", url: "/api/me/delivery-lines", headers: { cookie: buyer.cookie } });
    assert.equal(lines.statusCode, 200);
    assert.deepEqual(lines.json().items, [
      { source: "grant", grantId: grant.id, position: 1, label: "Line A" },
      { source: "grant", grantId: grant.id, position: 2, label: "Line B" },
    ]);
    assert.equal(lines.body.includes(URL_A), false, "delivery-lines carries names only, like service lines");

    const delivery = await app.inject({ method: "GET", url: `/api/me/grants/${grant.id}/delivery`, headers: { cookie: buyer.cookie } });
    assert.equal(delivery.statusCode, 200);
    assert.deepEqual(delivery.json(), {
      grantId: grant.id,
      items: [
        { position: 1, label: "Line A", subscriptionUrl: URL_A },
        { position: 2, label: "Line B", subscriptionUrl: URL_B },
      ],
    });
    assert.equal(delivery.headers["cache-control"], "no-store");
    const services = await app.inject({ method: "GET", url: "/api/me/services", headers: { cookie: buyer.cookie } });
    assert.equal(services.json().items[0].deliveryStatus, "open");
    assert.equal(services.body.includes("secret reason"), false);

    const foreign = await app.inject({ method: "GET", url: `/api/me/grants/${grant.id}/delivery`, headers: { cookie: other.cookie } });
    assert.equal(foreign.statusCode, 404, "another buyer cannot read the gift");
    const anonymous = await app.inject({ method: "GET", url: `/api/me/grants/${grant.id}/delivery` });
    assert.equal(anonymous.statusCode, 401);
    const otherLines = await app.inject({ method: "GET", url: "/api/me/delivery-lines", headers: { cookie: other.cookie } });
    assert.deepEqual(otherLines.json().items, []);

    // An opened gift may still be edited (except its delivery) until revoked.
    const edited = await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: headers(admin), payload: { label: "Gift line v2", months: 6, valueFen: 47_400 } });
    assert.equal(edited.statusCode, 200);
    assert.deepEqual([edited.json().label, edited.json().months, edited.json().valueFen, edited.json().deliveryStatus], ["Gift line v2", 6, 47_400, "open"]);

    const revoked = await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: headers(admin), payload: { status: "revoked" } });
    assert.equal(revoked.statusCode, 200);
    const linesAfter = await app.inject({ method: "GET", url: "/api/me/delivery-lines", headers: { cookie: buyer.cookie } });
    assert.deepEqual(linesAfter.json().items, []);
    const deliveryAfter = await app.inject({ method: "GET", url: `/api/me/grants/${grant.id}/delivery`, headers: { cookie: buyer.cookie } });
    assert.equal(deliveryAfter.statusCode, 404);
    const editRevoked = await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: headers(admin), payload: { months: 1 } });
    assert.equal(editRevoked.statusCode, 409);
  });
});

test("revoked gifts cannot be opened and catalog edits are validated as one selection", async () => {
  await withFixture(async ({ app, admin, buyerId }) => {
    const grant = await createGrant(app, admin, { userId: buyerId, ...PLAN });
    const badCatalog = await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: headers(admin), payload: { regionId: "jp" } });
    assert.equal(badCatalog.statusCode, 400, "a partial selection is rejected");
    const unknownCombo = await app.inject({
      method: "PATCH",
      url: `/api/admin/grants/${grant.id}`,
      headers: headers(admin),
      payload: { typeId: "local-isp", regionId: "jp", ispId: "us-verizon", durationId: "month-1" },
    });
    assert.equal(unknownCombo.statusCode, 400);
    assert.equal(unknownCombo.json().error.code, "invalid_plan");
    const sameCombo = await app.inject({
      method: "PATCH",
      url: `/api/admin/grants/${grant.id}`,
      headers: headers(admin),
      payload: { typeId: "local-isp", regionId: "us", ispId: "us-verizon", specId: null, durationId: "month-1" },
    });
    assert.equal(sameCombo.statusCode, 200);

    await app.inject({ method: "PATCH", url: `/api/admin/grants/${grant.id}`, headers: headers(admin), payload: { status: "revoked" } });
    const open = await app.inject({ method: "POST", url: `/api/admin/grants/${grant.id}/open`, headers: headers(admin), payload: { items: [{ label: "A", subscriptionUrl: URL_A }] } });
    assert.equal(open.statusCode, 409);
    assert.equal(open.json().error.code, "grant_revoked");
  });
});

test("gifts created before Migration 023 still list for the buyer with NULL catalog fields", async () => {
  await withFixture(async ({ app, buyer, buyerId, database }) => {
    database.prepare(
      `INSERT INTO admin_grants (user_id, granted_by_admin_id, label, starts_at, ends_at, status, reason, created_at, updated_at)
       VALUES (?, ?, 'Legacy gift', '2026-08-01T00:00:00.000Z', NULL, 'active', 'old', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run(buyerId, buyerId);
    const mine = await app.inject({ method: "GET", url: "/api/me/services", headers: { cookie: buyer.cookie } });
    assert.equal(mine.statusCode, 200);
    const [gift] = mine.json().items;
    assert.equal(gift.label, "Legacy gift");
    assert.deepEqual(
      [gift.typeId, gift.regionId, gift.ispId, gift.specId, gift.durationId, gift.months, gift.valueFen, gift.deliveryStatus],
      [null, null, null, null, null, null, null, "pending_open"],
    );
  });
});

test("grant lines are bound to their grant id and never decrypt as service lines", () => {
  const encrypted = encryptGrantDeliveryItem({ grantId: 7, position: 1, item: { label: "Line", subscriptionUrl: URL_A } }, DELIVERY_KEYRING);
  assert.equal(decryptGrantDeliveryItem({ ...encrypted, grantId: 7 }, DELIVERY_KEYRING), URL_A);
  assert.throws(() => decryptGrantDeliveryItem({ ...encrypted, grantId: 8 }, DELIVERY_KEYRING));
  assert.throws(() => decryptGrantDeliveryItem({ ...encrypted, grantId: 7, position: 2 }, DELIVERY_KEYRING));
  assert.throws(() => decryptServiceDeliveryItem({ ...encrypted, serviceId: 7 }, DELIVERY_KEYRING));
});

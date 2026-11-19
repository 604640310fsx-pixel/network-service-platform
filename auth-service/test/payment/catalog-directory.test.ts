import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../../src/app.js";
import { listPurchaseCatalogPlans, PaymentDomainError, resolveQuote } from "../../src/payment/commerce.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { CatalogDirectoryNotFound, isDirectoryEnabled, listCatalogDirectory, updateCatalogDirectoryStatus } from "../../src/payment/catalog-directory.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import { ACCESS_TOKEN_A, insertWebSession, localIspSelection, paymentDependencies, TEST_NOW } from "./helpers.js";

test("independent directory switches gate new quotes and catalog without changing plan state", async () => {
  await withAuthenticationDatabase(async (database) => {
    const selection = localIspSelection();
    const quote = () => resolveQuote(database, { selection, couponCode: null, now: () => new Date(TEST_NOW) });
    const plan = () => listPurchaseCatalogPlans(database).find((row) => row.typeId === selection.typeId &&
      row.regionId === selection.regionId && row.ispId === selection.ispId && row.specId === null && row.durationId === selection.durationId);
    const before = quote();
    assert.equal(plan()?.isActive, true);
    assert.equal(isDirectoryEnabled(database, "unknown", "us", "us-verizon"), false);
    assert.equal(listCatalogDirectory(database).regions.some((row) => row.typeId === "local-isp" && row.regionId === "us"), true);

    const base = { typeId: "local-isp", regionId: "us", adminUserId: 1, now: () => new Date(TEST_NOW) };
    updateCatalogDirectoryStatus(database, { ...base, kind: "operator", ispId: "us-verizon", isActive: false });
    assert.equal(plan()?.isActive, false);
    assert.throws(quote, (error: unknown) => error instanceof PaymentDomainError && error.code === "plan_unavailable");
    assert.throws(() => createPaymentOrder(paymentDependencies(database), {
      idempotencyKey: "synthetic-disabled-directory", rawAccessToken: ACCESS_TOKEN_A, selection,
      contact: "synthetic", scenarios: [], notes: null, acknowledgedAmountFen: before.amountFen, userId: null,
    }), (error: unknown) => error instanceof PaymentDomainError && error.code === "plan_unavailable");
    assert.equal((database.prepare("SELECT count(*) AS n FROM orders").all()[0] as { n: number }).n, 0);
    updateCatalogDirectoryStatus(database, { ...base, kind: "region", isActive: false });
    updateCatalogDirectoryStatus(database, { ...base, kind: "region", isActive: true });
    assert.equal(isDirectoryEnabled(database, "local-isp", "us", "us-verizon"), false);
    assert.equal(isDirectoryEnabled(database, "us-local-carrier", "us", "ntt"), true);
    updateCatalogDirectoryStatus(database, { ...base, kind: "operator", ispId: "us-verizon", isActive: true });
    assert.equal(quote().amountFen, before.amountFen);
    assert.equal(plan()?.isActive, true);
    database.prepare("UPDATE sellable_plans SET total_slots = 0 WHERE id = ?").run(before.planId);
    assert.throws(quote, (error: unknown) => error instanceof PaymentDomainError && error.code === "sold_out");
    database.prepare("UPDATE sellable_plans SET total_slots = NULL WHERE id = ?").run(before.planId);
    database.prepare(`INSERT INTO sellable_plans
      (type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,total_slots,occupied_slots,created_at,updated_at)
      VALUES ('local-isp','zz','synthetic',NULL,'month-1',9900,1,NULL,0,?,?)`).run(TEST_NOW.toISOString(),TEST_NOW.toISOString());
    assert.equal(isDirectoryEnabled(database, "local-isp", "zz", "synthetic"), false);
    assert.equal(listCatalogDirectory(database).regions.find((item) => item.typeId === "local-isp" && item.regionId === "zz")?.isActive, false);
    assert.equal(listCatalogDirectory(database).operators.find((item) => item.typeId === "local-isp" && item.regionId === "zz" && item.ispId === "synthetic")?.isActive, false);
    assert.throws(() => resolveQuote(database, { selection: { ...selection, regionId: "zz", ispId: "synthetic" }, couponCode: null,
      now: () => new Date(TEST_NOW) }), (error: unknown) => error instanceof PaymentDomainError && error.code === "plan_unavailable");
    updateCatalogDirectoryStatus(database, { ...base, kind: "operator", regionId: "zz", ispId: "synthetic", isActive: true });
    assert.equal(listCatalogDirectory(database).operators.find((item) => item.regionId === "zz")?.isActive, true);
    assert.equal(listCatalogDirectory(database).regions.find((item) => item.regionId === "zz")?.isActive, false);
    assert.equal(isDirectoryEnabled(database, "local-isp", "zz", "synthetic"), false);
    updateCatalogDirectoryStatus(database, { ...base, kind: "region", regionId: "zz", isActive: true });
    assert.equal(isDirectoryEnabled(database, "local-isp", "zz", "synthetic"), true);
    assert.equal(resolveQuote(database, { selection: { ...selection, regionId: "zz", ispId: "synthetic" }, couponCode: null,
      now: () => new Date(TEST_NOW) }).amountFen, 9900);
    assert.throws(() => updateCatalogDirectoryStatus(database, { ...base, kind: "operator", regionId: "zz", ispId: "invented", isActive: true }),
      CatalogDirectoryNotFound);
    const raw = database.prepare("SELECT is_active, occupied_slots FROM sellable_plans WHERE id = ?").all(before.planId)[0] as { is_active: number; occupied_slots: number };
    assert.deepEqual(raw, { is_active: 1, occupied_slots: 0 });
  });
});

test("directory API enforces admin session, CSRF and configured keys", async () => {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "buyer@synthetic.invalid", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "admin@synthetic.invalid", passwordHash: "hash", status: "active", role: "admin" });
    const buyer = insertWebSession(database, buyerId);
    const admin = insertWebSession(database, adminId);
    const app = buildApp({ payment: paymentDependencies(database) });
    const url = "/api/admin/catalog-directory/operators/local-isp/us/us-verizon";
    try {
      assert.equal((await app.inject({ method: "GET", url: "/api/admin/catalog-directory" })).statusCode, 401);
      assert.equal((await app.inject({ method: "GET", url: "/api/admin/catalog-directory", headers: { cookie: buyer.cookie } })).statusCode, 403);
      assert.equal((await app.inject({ method: "PATCH", url, headers: { cookie: admin.cookie }, payload: { isActive: false } })).statusCode, 403);
      assert.equal((await app.inject({ method: "PATCH", url, headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrfToken }, payload: { isActive: false } })).statusCode, 403);
      const headers = { cookie: admin.cookie, "x-csrf-token": admin.csrfToken, "content-type": "application/json" };
      assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { isActive: "false" } })).statusCode, 400);
      assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/catalog-directory/regions/local-isp/missing", headers, payload: { isActive: false } })).statusCode, 404);
      const changed = await app.inject({ method: "PATCH", url, headers, payload: { isActive: false } });
      assert.equal(changed.statusCode, 200);
      assert.equal(changed.json().isActive, false);
      assert.equal((await app.inject({ method: "GET", url: "/api/admin/catalog-directory", headers: { cookie: admin.cookie } })).json()
        .operators.find((row: { ispId: string }) => row.ispId === "us-verizon")?.isActive, false);
      database.prepare(`INSERT INTO sellable_plans
        (type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,total_slots,occupied_slots,created_at,updated_at)
        VALUES ('local-isp','zz','synthetic',NULL,'month-1',9900,1,NULL,0,?,?)`).run(TEST_NOW.toISOString(),TEST_NOW.toISOString());
      const pending = (await app.inject({ method: "GET", url: "/api/admin/catalog-directory", headers: { cookie: admin.cookie } })).json();
      assert.equal(pending.regions.find((row: { regionId: string }) => row.regionId === "zz")?.isActive, false);
      assert.equal(pending.operators.find((row: { regionId: string }) => row.regionId === "zz")?.isActive, false);
      const newOperatorUrl = "/api/admin/catalog-directory/operators/local-isp/zz/synthetic";
      assert.equal((await app.inject({ method: "PATCH", url: newOperatorUrl, headers: { cookie: admin.cookie }, payload: { isActive: true } })).statusCode, 403);
      assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/catalog-directory/operators/local-isp/zz/invented", headers, payload: { isActive: true } })).statusCode, 404);
      assert.equal((await app.inject({ method: "PATCH", url: newOperatorUrl, headers, payload: { isActive: true } })).statusCode, 200);
      assert.equal(isDirectoryEnabled(database, "local-isp", "zz", "synthetic"), false);
      assert.equal((await app.inject({ method: "PATCH", url: "/api/admin/catalog-directory/regions/local-isp/zz", headers, payload: { isActive: true } })).statusCode, 200);
      assert.equal(isDirectoryEnabled(database, "local-isp", "zz", "synthetic"), true);
    } finally { await app.close(); }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import { ACCESS_TOKEN_A, FakeAlipaySdk, insertWebSession, paymentDependencies } from "./helpers.js";

test("existing catalog, quote and order routes keep the four synthetic dual-ISP prices and snapshot exact spec", async () => {
  // Existing fixture uses a disposable local database and a fake payment SDK; no live service or transaction.
  await withAuthenticationDatabase(async (database) => {
    const insert = database.prepare(`INSERT INTO sellable_plans
      (type_id, region_id, isp_id, spec_id, duration_id, price_fen, is_active,
       total_slots, occupied_slots, created_at, updated_at)
      VALUES ('us-local-carrier','us',?,?,'month-1',?,1,NULL,0,?,?)`);
    const stamp = "2026-11-08T00:00:00.000Z";
    const prices = { "direct-200g": 4_900, "direct-500g": 5_900, "optimized-200g": 5_900, "optimized-500g": 7_900 };
    for (const ispId of ["ntt", "gtt", "cogent", "charter"]) {
      for (const [specId, priceFen] of Object.entries(prices)) insert.run(ispId, specId, priceFen, stamp, stamp);
    }
    // Keep one existing NULL-row occupancy to prove a new spec does not copy or alter it.
    database.prepare("UPDATE sellable_plans SET occupied_slots=1 WHERE type_id='us-local-carrier' AND isp_id='ntt' AND spec_id IS NULL AND duration_id='month-1'").run();
    const userId = insertAuthenticationUser(database, { email: "dual-isp-buyer@example.test", passwordHash: "synthetic", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "dual-isp-admin@example.test", passwordHash: "synthetic", status: "active", role: "admin" });
    const session = insertWebSession(database, userId);
    const admin = insertWebSession(database, adminId);
    const dependencies = paymentDependencies(database, new FakeAlipaySdk());
    const app = buildApp({ payment: dependencies });
    try {
      const catalog = await app.inject({ method: "GET", url: "/api/catalog/plans" });
      assert.equal(catalog.statusCode, 200);
      const items = catalog.json().items as Array<{ typeId: string; ispId: string; specId: string | null; durationId: string; priceFen: number }>;
      for (const ispId of ["ntt", "gtt", "cogent", "charter"]) {
        for (const [specId, priceFen] of Object.entries(prices)) {
          const selection = { typeId: "us-local-carrier", regionId: "us", ispId, specId, durationId: "month-1" };
          assert.equal(items.find((item) => item.typeId === selection.typeId && item.ispId === ispId &&
            item.specId === specId && item.durationId === selection.durationId)?.priceFen, priceFen);
          const quote = await app.inject({ method: "POST", url: "/api/pay/quote", payload: { ...selection, couponCode: null } });
          assert.equal(quote.statusCode, 200, `${ispId}/${specId}`);
          assert.deepEqual({ listPriceFen: quote.json().listPriceFen, amountFen: quote.json().amountFen,
            discountFen: quote.json().discountFen }, { listPriceFen: priceFen, amountFen: priceFen, discountFen: 0 });
        }
      }
      const selection = { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: "optimized-500g", durationId: "month-1" };
      const created = await app.inject({ method: "POST", url: "/api/pay/orders",
        headers: { "content-type": "application/json", "idempotency-key": "dual-isp-synthetic-order",
          "x-order-access-token": ACCESS_TOKEN_A, cookie: session.cookie, "x-csrf-token": session.csrfToken },
        payload: { ...selection, contact: "synthetic-contact", scenarios: [], notes: null, acknowledgedAmountFen: 7_900 },
      });
      assert.equal(created.statusCode, 200);
      const snapshot = database.prepare("SELECT type_id,region_id,isp_id,spec_id,duration_id,amount_fen FROM orders WHERE idempotency_key=?")
        .all("dual-isp-synthetic-order")[0] as Record<string, unknown>;
      assert.deepEqual(snapshot, { type_id: "us-local-carrier", region_id: "us", isp_id: "ntt",
        spec_id: "optimized-500g", duration_id: "month-1", amount_fen: 7_900 });
      const stock = database.prepare("SELECT spec_id,occupied_slots FROM sellable_plans WHERE type_id='us-local-carrier' AND isp_id='ntt' AND duration_id='month-1' AND (spec_id IS NULL OR spec_id='optimized-500g') ORDER BY spec_id")
        .all() as Array<{ spec_id: string | null; occupied_slots: number }>;
      assert.deepEqual(stock, [{ spec_id: null, occupied_slots: 1 }, { spec_id: "optimized-500g", occupied_slots: 1 }]);
      // Synthetic signed completion creates the existing pending-open reminder; no external payment is called.
      assert.equal(finalizePaid(dependencies, { outTradeNo: created.json().orderRef,
        tradeNo: "synthetic-trade", tradeStatus: "TRADE_SUCCESS", totalAmount: "79.00", totalAmountFen: 7_900,
        appId: dependencies.appId, sellerId: dependencies.sellerId }), "finalized");
      const pending = await app.inject({ method: "GET", url: "/api/admin/services?status=pending_open",
        headers: { cookie: admin.cookie } });
      assert.equal(pending.statusCode, 200);
      const reminder = (pending.json().items as Array<Record<string, unknown>>).find((item) => item.orderRef === created.json().orderRef);
      assert.deepEqual({ typeId: reminder?.typeId, regionId: reminder?.regionId, ispId: reminder?.ispId,
        specId: reminder?.specId, durationId: reminder?.durationId, amountFen: reminder?.amountFen },
      { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: "optimized-500g",
        durationId: "month-1", amountFen: 7_900 });
    } finally {
      await app.close();
    }
  });
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { DatabaseConnection } from "../../src/db.js";
import { listPurchaseCatalogPlans, PaymentDomainError, resolveQuote } from "../../src/payment/commerce.js";

const Database = createRequire(import.meta.url)("better-sqlite3") as new (path: string) => DatabaseConnection;

test("dual-ISP catalogue and quote read exact synthetic sellable rows without adding a route fee or falling back", () => {
  const database = new Database(":memory:");
  try {
    // Only the columns read by the real catalogue and quote functions; no migrations, orders or external service.
    database.exec(`CREATE TABLE sellable_plans (
      id INTEGER PRIMARY KEY, type_id TEXT NOT NULL, region_id TEXT NOT NULL, isp_id TEXT NOT NULL,
      spec_id TEXT, duration_id TEXT NOT NULL, price_fen INTEGER NOT NULL,
      is_active INTEGER NOT NULL, total_slots INTEGER, occupied_slots INTEGER NOT NULL
    )`);
    const insert = database.prepare(`INSERT INTO sellable_plans
      (type_id, region_id, isp_id, spec_id, duration_id, price_fen, is_active, total_slots, occupied_slots)
      VALUES ('us-local-carrier', 'us', ?, ?, 'month-1', ?, 1, NULL, 0)`);
    const prices = { "direct-200g": 4_900, "direct-500g": 5_900, "optimized-200g": 5_900, "optimized-500g": 7_900 };
    for (const ispId of ["ntt", "gtt", "cogent", "charter"]) {
      for (const [specId, priceFen] of Object.entries(prices)) insert.run(ispId, specId, priceFen);
    }
    // An old NULL row must never supply a missing new specification's price.
    insert.run("ntt", null, 5_900);

    const catalogue = listPurchaseCatalogPlans(database);
    for (const ispId of ["ntt", "gtt", "cogent", "charter"]) {
      for (const [specId, priceFen] of Object.entries(prices)) {
        const selection = { typeId: "us-local-carrier", regionId: "us", ispId, specId, durationId: "month-1" };
        const item = catalogue.find((row) => row.typeId === selection.typeId && row.regionId === selection.regionId &&
          row.ispId === ispId && row.specId === specId && row.durationId === selection.durationId);
        assert.equal(item?.priceFen, priceFen, `${ispId}/${specId} catalogue`);
        const quote = resolveQuote(database, { selection, couponCode: null, now: () => new Date("2026-11-08T00:00:00Z") });
        assert.equal(quote.listPriceFen, priceFen, `${ispId}/${specId} list price`);
        assert.equal(quote.amountFen, priceFen, `${ispId}/${specId} final quote`);
        assert.equal(quote.discountFen, 0);
      }
    }

    database.prepare("DELETE FROM sellable_plans WHERE isp_id = 'ntt' AND spec_id = 'optimized-500g'").run();
    const missing = { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: "optimized-500g", durationId: "month-1" };
    assert.equal(listPurchaseCatalogPlans(database).some((row) => row.typeId === missing.typeId &&
      row.ispId === missing.ispId && row.specId === missing.specId), false);
    assert.throws(
      () => resolveQuote(database, { selection: missing, couponCode: null, now: () => new Date("2026-11-08T00:00:00Z") }),
      (error: unknown) => error instanceof PaymentDomainError && error.code === "plan_unavailable",
    );
  } finally {
    database.close();
  }
});

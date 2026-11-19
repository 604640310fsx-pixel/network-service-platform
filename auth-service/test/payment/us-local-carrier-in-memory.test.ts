import assert from "node:assert/strict";
import test from "node:test";
import { listPurchaseCatalogPlans, PaymentDomainError, resolveQuote } from "../../src/payment/commerce.js";
import { updateCatalogDirectoryStatus, isDirectoryEnabled } from "../../src/payment/catalog-directory.js";
import { resolvePriceFen } from "../../src/payment/pricing.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { withAuthenticationDatabase } from "../auth/helpers.js";
import { paymentDependencies } from "./helpers.js";

const NOW = new Date("2026-11-08T00:00:00.000Z");
const base = { typeId: "us-local-carrier", regionId: "us", ispId: "ntt", specId: null } as const;

test("381 fixed dual-ISP seed prices stay exact; unconfigured option SKUs have no quote", async () => {
  await withAuthenticationDatabase((database) => {
    for (const ispId of ["ntt", "gtt", "cogent"]) {
      for (const [durationId, expectedFen] of [["month-1", 5900], ["month-6", 29900], ["month-12", 49900]] as const) {
        const selection = { ...base, ispId, durationId };
        assert.equal(resolvePriceFen(selection), expectedFen);
        const quote = resolveQuote(database, { selection, couponCode: null, now: () => NOW });
        assert.equal(quote.listPriceFen, expectedFen);
        assert.equal(quote.amountFen, expectedFen);
      }
      for (const specId of ["direct-200g", "direct-500g", "optimized-200g", "optimized-500g"]) {
        const selection = { ...base, ispId, specId, durationId: "month-1" };
        assert.equal(resolvePriceFen(selection), null);
        assert.equal(listPurchaseCatalogPlans(database).some((item) => item.typeId === selection.typeId &&
          item.regionId === selection.regionId && item.ispId === selection.ispId && item.specId === specId), false);
        assert.throws(() => resolveQuote(database, { selection, couponCode: null, now: () => NOW }),
          (error: unknown) => error instanceof PaymentDomainError && error.code === "plan_unavailable");
      }
    }
    assert.equal(resolvePriceFen({ ...base, ispId: "charter", durationId: "month-1" }), 5900);
  });
});

test("configured optimized half-year and yearly rows quote and order at exact database amounts", async () => {
  await withAuthenticationDatabase((database) => {
    const configured = [
      { specId: "optimized-200g", durationId: "month-6", priceFen: 31234 },
      { specId: "optimized-200g", durationId: "month-12", priceFen: 41234 },
      { specId: "optimized-500g", durationId: "month-6", priceFen: 51234 },
      { specId: "optimized-500g", durationId: "month-12", priceFen: 61234 },
    ] as const;
    for (const row of configured) database.prepare(`INSERT INTO sellable_plans
      (type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,total_slots,occupied_slots,created_at,updated_at)
      VALUES ('us-local-carrier','us','ntt',?,?,?,1,NULL,0,?,?)`)
      .run(row.specId,row.durationId,row.priceFen,NOW.toISOString(),NOW.toISOString());
    let sequence=0;
    const deps=paymentDependencies(database,undefined,()=>`${String(++sequence).padStart(8,"0")}-1111-4111-8111-111111111111`);
    for (const [index,row] of configured.entries()) {
      const selection={...base,specId:row.specId,durationId:row.durationId};
      assert.equal(resolvePriceFen(selection),null,"static 381 helper has no option price");
      const quote=resolveQuote(database,{selection,couponCode:null,now:()=>NOW});
      assert.equal(quote.listPriceFen,row.priceFen);
      assert.equal(quote.amountFen,row.priceFen);
      const order=createPaymentOrder(deps,{idempotencyKey:`synthetic-optimized-${index}`,
        rawAccessToken:Buffer.alloc(32,index+1).toString("base64url"),selection,contact:"synthetic",scenarios:[],notes:null,
        acknowledgedAmountFen:row.priceFen,userId:null});
      assert.equal(order.amountFen,row.priceFen);
      const saved=database.prepare("SELECT amount_fen FROM orders WHERE order_ref=?").all(order.orderRef)[0] as {amount_fen:number};
      assert.equal(saved.amount_fen,row.priceFen);
    }
    updateCatalogDirectoryStatus(database,{kind:"operator",typeId:base.typeId,regionId:base.regionId,ispId:base.ispId,
      isActive:false,adminUserId:1,now:()=>NOW});
    const selection={...base,specId:"optimized-500g",durationId:"month-12"};
    assert.throws(()=>resolveQuote(database,{selection,couponCode:null,now:()=>NOW}),
      (error:unknown)=>error instanceof PaymentDomainError&&error.code==="plan_unavailable");
    assert.throws(()=>createPaymentOrder(deps,{idempotencyKey:"synthetic-optimized-disabled",
      rawAccessToken:Buffer.alloc(32,9).toString("base64url"),selection,contact:"synthetic",scenarios:[],notes:null,
      acknowledgedAmountFen:61234,userId:null}),
      (error:unknown)=>error instanceof PaymentDomainError&&error.code==="plan_unavailable");
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM orders WHERE idempotency_key LIKE 'synthetic-optimized-%'").all()[0] as {n:number}).n,4);
  });
});

test("directory switch blocks the unchanged fixed quote and preserves each operator state", async () => {
  await withAuthenticationDatabase((database) => {
    const selection = { ...base, durationId: "month-1" };
    const quote = () => resolveQuote(database, { selection, couponCode: null, now: () => NOW });
    assert.equal(quote().amountFen, 5900);
    const update = { typeId: base.typeId, regionId: base.regionId, adminUserId: 1, now: () => NOW };
    updateCatalogDirectoryStatus(database, { ...update, kind: "operator", ispId: "ntt", isActive: false });
    assert.equal(isDirectoryEnabled(database, base.typeId, base.regionId, "ntt"), false);
    assert.equal(isDirectoryEnabled(database, base.typeId, base.regionId, "gtt"), true);
    assert.equal(listPurchaseCatalogPlans(database).find((item) => item.typeId === selection.typeId &&
      item.regionId === selection.regionId && item.ispId === selection.ispId && item.specId === null &&
      item.durationId === selection.durationId)?.isActive, false);
    assert.throws(quote, (error: unknown) => error instanceof PaymentDomainError && error.code === "plan_unavailable");
    updateCatalogDirectoryStatus(database, { ...update, kind: "region", isActive: false });
    updateCatalogDirectoryStatus(database, { ...update, kind: "region", isActive: true });
    assert.equal(isDirectoryEnabled(database, base.typeId, base.regionId, "ntt"), false);
    assert.equal(isDirectoryEnabled(database, base.typeId, base.regionId, "gtt"), true);
    const row = database.prepare("SELECT price_fen FROM sellable_plans WHERE type_id='us-local-carrier' AND region_id='us' AND isp_id='ntt' AND spec_id IS NULL AND duration_id='month-1'").all()[0] as {price_fen:number};
    assert.equal(row.price_fen, 5900);
  });
});

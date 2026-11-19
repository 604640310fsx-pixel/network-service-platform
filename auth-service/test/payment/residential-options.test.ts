import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { findSellablePlan, resolveQuote, listPurchaseCatalogPlans, createCoupon } from "../../src/payment/commerce.js";
import { createPaymentOrder, retryPaymentOrder, getAuthorizedOrderStatus, listPendingServicesForAdmin, openService } from "../../src/payment/orders.js";
import { finalizeClosed, finalizePaid } from "../../src/payment/state-machine.js";
import { residentialOptionsForOrder, parseResidentialOptions, residentialSnapshotSql } from "../../src/payment/residential-options.js";
import { produceRenewalQuote } from "../../src/wallet/candidate.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import { ACCESS_TOKEN_A, ACCESS_TOKEN_B, paymentDependencies, firstValue, TEST_NOW, DELIVERY_KEYRING, FakeAlipaySdk, insertWebSession, TOKEN_KEYRING } from "./helpers.js";
import { encryptServiceDeliveryItem } from "../../src/payment/delivery-crypto.js";

const selection = (specId = "res-v2-direct-200g", durationId = "month-1") => ({ typeId: "residential", regionId: "sg", ispId: "sptel", specId, durationId });
const matrix = [
  ["direct", "200g", 0, 200, 3], ["direct", "300g", 0, 300, 5], ["direct", "1t", 0, 1000, 10],
  ["optimized", "200g", 1000, 200, 3], ["optimized", "300g", 1200, 300, 5], ["optimized", "1t", 3000, 1000, 10],
  ["highspeed", "200g", 2000, 200, 3], ["highspeed", "300g", 2500, 300, 5], ["highspeed", "1t", 7000, 1000, 10],
  ["live", "200g", 3000, 200, 3], ["live", "300g", 3500, 300, 5], ["live", "1t", 10000, 1000, 10],
] as const;
const bases = [
  ["sg","sptel"],["jp","glbb-japan"],["vn","vnpt-corp"],["my","tm-technology"],
  ["kr","sk-broadband"],["tw","hinet"],["tw","so-net"],
  ["us","cox"],["us","rcn"],["us","windstream"],["us","att"],["us","verizon"],["us","comcast"],
] as const;
function orderInput(specId: string, amount: number, userId: number | null = null, couponCode: string | null = null) {
  return { idempotencyKey: "residential-order-a", rawAccessToken: ACCESS_TOKEN_A, selection: selection(specId), contact: "synthetic@example.invalid", scenarios: [], notes: null,
    acknowledgedAmountFen: amount, userId, couponCode };
}

test("031 is nullable JSON-object only; no backfill; new direct device allowance is explicit, never inferred from sharing count", async () => {
  await withAuthenticationDatabase(async db => {
    assert.equal(firstValue(db,"SELECT max(version) FROM schema_migrations"),32);
    assert.equal(firstValue(db,"SELECT count(*) FROM sellable_plans"),1014);
    const deps=paymentDependencies(db),old=createPaymentOrder(deps,{...orderInput("shared-3",21900)});
    assert.equal(firstValue(db,"SELECT residential_options_json FROM orders WHERE order_ref=?",old.orderRef),null);
    for(const raw of ["null","[]","123",'"text"',"broken"])
      assert.throws(()=>db.prepare("UPDATE orders SET residential_options_json=? WHERE order_ref=?").run(raw,old.orderRef));
    const current=resolveQuote(db,{selection:selection(),couponCode:null,now:()=>TEST_NOW});
    assert.equal(current.residentialOptions?.trafficGb,200);assert.equal(current.residentialOptions?.deviceAllowance,3);
    assert.throws(()=>parseResidentialOptions(JSON.stringify({...current.residentialOptions,deviceAllowance:null}),selection()));
    assert.throws(()=>parseResidentialOptions(JSON.stringify({...current.residentialOptions,extra:true}),selection()));
  });
});

test("all 13 saleable tuples and12 choices use selected original traffic tier plus discounted period add-on; obsolete500G is never sold", async () => {
  await withAuthenticationDatabase(async db => {
    const catalog=listPurchaseCatalogPlans(db).filter(row=>row.typeId==="residential");assert.equal(catalog.length,624);
    assert.ok(catalog.every(row=>row.specId!=="res-v2-direct-default"));
    assert.ok(catalog.every(row=>row.specId?.startsWith("res-v2-")));
    for(const [regionId,ispId] of bases) for(const [line,traffic,addon,gb,devices] of matrix)
      for(const [durationId,numerator,denominator] of [["month-1",1,1],["month-3",27,10],["month-6",51,10],["month-12",48,5]] as const) {
        const tuple={...selection(`res-v2-${line}-${traffic}`,durationId),regionId,ispId};
        const quote=resolveQuote(db,{selection:tuple,couponCode:null,now:()=>TEST_NOW});
        const originalSpec=gb===200?'shared-5':gb===300?'shared-3':'dedicated';
        const anchor=findSellablePlan(db,{...tuple,specId:originalSpec})!;
        const base=findSellablePlan(db,{...tuple,specId:originalSpec,durationId:'month-1'})!.priceFen;
        const addonPeriod=durationId==='month-1'?addon:Math.floor((addon*numerator+denominator*50)/(denominator*100))*100;
        const expected=anchor.priceFen+addonPeriod;
        assert.equal(quote.amountFen,expected);assert.equal(quote.residentialOptions?.baseMonthlyFen,base);
        assert.equal(quote.residentialOptions?.trafficGb,gb);assert.equal(quote.residentialOptions?.deviceAllowance,devices);
        assert.equal(quote.planId,anchor.id);assert.equal(quote.residentialOptions?.basePeriodFen,anchor.priceFen);
        assert.equal(quote.residentialOptions?.addonPeriodFen,addonPeriod);assert.equal(quote.residentialOptions?.finalPeriodFen,expected);
        assert.equal(catalog.find(row=>row.regionId===regionId&&row.ispId===ispId&&row.specId===tuple.specId&&row.durationId===durationId)?.priceFen,expected);
      }
    for(const line of ['direct','optimized','highspeed','live'])assert.throws(()=>resolveQuote(db,{selection:selection(`res-v2-${line}-500g`),couponCode:null,now:()=>TEST_NOW}));
    assert.equal(resolveQuote(db,{selection:selection(),couponCode:null,now:()=>TEST_NOW}).amountFen,14900);
    assert.equal(resolveQuote(db,{selection:selection('res-v2-optimized-200g'),couponCode:null,now:()=>TEST_NOW}).amountFen,15900);
    assert.equal(resolveQuote(db,{selection:selection('res-v2-live-1t'),couponCode:null,now:()=>TEST_NOW}).amountFen,69900);
    for(const [spec,monthly,quarter,addonPeriod]of [['optimized',23100,62300,3200],['highspeed',24400,65900,6800],['live',25400,68600,9500]]as const){
      assert.equal(resolveQuote(db,{selection:selection(`res-v2-${spec}-300g`),couponCode:null,now:()=>TEST_NOW}).amountFen,monthly);
      const q=resolveQuote(db,{selection:selection(`res-v2-${spec}-300g`,'month-3'),couponCode:null,now:()=>TEST_NOW});assert.equal(q.amountFen,quarter);assert.equal(q.residentialOptions?.basePeriodFen,59100);assert.equal(q.residentialOptions?.addonPeriodFen,addonPeriod);
    }
  });
});

test("original monthly and period anchors fail closed; admin period price is never re-derived from monthly price", async () => {
  await withAuthenticationDatabase(async db => {
    const tuple=selection("res-v2-optimized-200g","month-6"),base={...tuple,specId:"shared-5"};
    const monthly=findSellablePlan(db,{...base,durationId:"month-1"})!,period=findSellablePlan(db,base)!;
    const oldPrice=period.priceFen;
    db.prepare("UPDATE sellable_plans SET price_fen=24125 WHERE id=?").run(monthly.id);
    assert.equal(resolveQuote(db,{selection:tuple,couponCode:null,now:()=>TEST_NOW}).amountFen,oldPrice+5100);
    assert.equal(resolveQuote(db,{selection:{...tuple,specId:'res-v2-direct-200g'},couponCode:null,now:()=>TEST_NOW}).amountFen,oldPrice);
    db.prepare('UPDATE sellable_plans SET price_fen=123456 WHERE id=?').run(period.id);
    assert.equal(resolveQuote(db,{selection:tuple,couponCode:null,now:()=>TEST_NOW}).amountFen,128556);
    db.prepare('UPDATE sellable_plans SET price_fen=? WHERE id=?').run(oldPrice,period.id);
    assert.equal(findSellablePlan(db,base)?.priceFen,oldPrice);
    for(const id of [monthly.id,period.id]) {
      assert.throws(()=>db.prepare('UPDATE sellable_plans SET price_fen=0 WHERE id=?').run(id),/CHECK constraint failed/);
      db.prepare("UPDATE sellable_plans SET is_active=0 WHERE id=?").run(id);
      assert.throws(()=>resolveQuote(db,{selection:tuple,couponCode:null,now:()=>TEST_NOW}));
      db.prepare("UPDATE sellable_plans SET is_active=1,total_slots=0 WHERE id=?").run(id);
      assert.throws(()=>resolveQuote(db,{selection:tuple,couponCode:null,now:()=>TEST_NOW}));
      db.prepare("UPDATE sellable_plans SET total_slots=NULL WHERE id=?").run(id);
    }
    assert.equal(findSellablePlan(db,selection("res-v2-live-500g")),null);
    assert.equal(findSellablePlan(db,{...tuple,ispId:"glbb-japan"}),null);
    db.prepare('DELETE FROM sellable_plans WHERE id=?').run(monthly.id);
    assert.throws(()=>resolveQuote(db,{selection:tuple,couponCode:null,now:()=>TEST_NOW}));
    db.prepare('DELETE FROM sellable_plans WHERE id=?').run(period.id);
    assert.equal(findSellablePlan(db,tuple),null);
  });
});

test('period coupons apply once to exact original period plus discounted route add-on, using the selected period stock pool',async()=>{
 await withAuthenticationDatabase(async db=>{
  const admin=insertAuthenticationUser(db,{email:'period-admin@example.invalid',passwordHash:'synthetic',role:'admin',status:'active'}),tuple=selection('res-v2-optimized-200g','month-3'),anchor=findSellablePlan(db,{...tuple,specId:'shared-5'})!;
  db.prepare('UPDATE sellable_plans SET price_fen=50999,total_slots=1 WHERE id=?').run(anchor.id);
  for(const [code,kind,amountOffFen,percentOff,expected]of [['PERFIX','fixed',5000,null,48699],['PERPCT','percent',null,10,48330]]as const){
   createCoupon(db,{code,kind,amountOffFen,percentOff,minAmountFen:53000,scope:'plans',planIds:[anchor.id],startsAt:'2020-01-01T00:00:00.000Z',endsAt:'2030-01-01T00:00:00.000Z',maxRedemptions:1,adminUserId:admin,now:()=>TEST_NOW});
   const q=resolveQuote(db,{selection:tuple,couponCode:code,now:()=>TEST_NOW});assert.equal(q.listPriceFen,53699);assert.equal(q.amountFen,expected);assert.equal(q.planId,anchor.id);
  }
  const deps=paymentDependencies(db),input={...orderInput(tuple.specId,48699,null,'PERFIX'),selection:tuple},order=createPaymentOrder(deps,input);
  assert.equal(order.residentialOptions?.basePeriodFen,50999);assert.equal(order.residentialOptions?.addonPeriodFen,2700);assert.equal(order.residentialOptions?.finalPeriodFen,53699);
  assert.equal(firstValue(db,'SELECT occupied_slots FROM sellable_plans WHERE id=?',anchor.id),1);
  finalizeClosed(deps,{outTradeNo:order.orderRef,tradeNo:'period-close',tradeStatus:'TRADE_CLOSED',totalAmount:'486.99',totalAmountFen:48699,appId:deps.appId,sellerId:deps.sellerId});
  assert.equal(firstValue(db,'SELECT occupied_slots FROM sellable_plans WHERE id=?',anchor.id),0);
  assert.equal(firstValue(db,"SELECT redeemed_count FROM coupons WHERE code='PERFIX'"),0);
 });
});

test("v2 aliases share anchor stock and one exact coupon reservation/release; no doublediscount or alias bypass", async () => {
  await withAuthenticationDatabase(async db => {
    const admin=insertAuthenticationUser(db,{email:"coupon-admin@example.invalid",passwordHash:"synthetic",status:"active",role:"admin"});
    const deps=paymentDependencies(db),tuple=selection("res-v2-optimized-300g"),anchor=findSellablePlan(db,{...tuple,specId:"shared-3"})!;
    db.prepare("UPDATE sellable_plans SET total_slots=1 WHERE id=?").run(anchor.id);
    createCoupon(db,{code:"RES10",kind:"percent",amountOffFen:null,percentOff:10,minAmountFen:23000,scope:"plans",planIds:[anchor.id],startsAt:"2020-01-01T00:00:00.000Z",endsAt:"2030-01-01T00:00:00.000Z",maxRedemptions:1,adminUserId:admin,now:()=>TEST_NOW});
    const input=orderInput(tuple.specId,20790,null,"RES10"),created=createPaymentOrder(deps,input);
    assert.equal(firstValue(db,"SELECT occupied_slots FROM sellable_plans WHERE id=?",anchor.id),1);
    assert.equal(firstValue(db,"SELECT redeemed_count FROM coupons WHERE code='RES10'"),1);
    assert.throws(()=>resolveQuote(db,{selection:selection("res-v2-live-300g"),couponCode:null,now:()=>TEST_NOW}));
    assert.equal(resolveQuote(db,{selection:selection('res-v2-live-200g'),couponCode:null,now:()=>TEST_NOW}).amountFen,17900);
    assert.equal(resolveQuote(db,{selection:selection('res-v2-live-1t'),couponCode:null,now:()=>TEST_NOW}).amountFen,69900);
    assert.deepEqual(createPaymentOrder(deps,input),created);
    const event={outTradeNo:created.orderRef,tradeNo:"synthetic-close",tradeStatus:"TRADE_CLOSED",totalAmount:"207.90",totalAmountFen:20790,appId:deps.appId,sellerId:deps.sellerId};
    finalizeClosed(deps,event);finalizeClosed(deps,event);
    assert.equal(firstValue(db,"SELECT occupied_slots FROM sellable_plans WHERE id=?",anchor.id),0);
    assert.equal(firstValue(db,"SELECT redeemed_count FROM coupons WHERE code='RES10'"),0);
    assert.equal(firstValue(db,"SELECT count(*) FROM coupon_redemptions WHERE released_at IS NOT NULL"),1);
  });
});

test("persisted v2 survives locked payment, closed retry, admin manual opening and future renewal; old NULL rights unchanged", async () => {
  await withAuthenticationDatabase(async db => {
    const owner=insertAuthenticationUser(db,{email:"buyer-v2@example.invalid",passwordHash:"synthetic",status:"active"});
    const admin=insertAuthenticationUser(db,{email:"admin-v2@example.invalid",passwordHash:"synthetic",status:"active",role:"admin"});
    const deps=paymentDependencies(db,new FakeAlipaySdk(),randomUUID),tuple=selection("res-v2-highspeed-300g");
    const original=createPaymentOrder(deps,orderInput(tuple.specId,24400,owner));
    const frozen=firstValue(db,"SELECT residential_options_json FROM orders WHERE order_ref=?",original.orderRef);
    db.prepare("UPDATE sellable_plans SET price_fen=22900 WHERE type_id='residential' AND isp_id='sptel' AND spec_id='shared-3' AND duration_id='month-1'").run();
    const read=getAuthorizedOrderStatus(deps,{orderRef:original.orderRef,userId:owner,rawAccessToken:null});assert.equal(read.amountFen,24400);assert.equal(read.residentialOptions?.baseMonthlyFen,21900);
    finalizeClosed(deps,{outTradeNo:original.orderRef,tradeNo:"v2-close",tradeStatus:"TRADE_CLOSED",totalAmount:"244.00",totalAmountFen:24400,appId:deps.appId,sellerId:deps.sellerId});
    const retry=retryPaymentOrder(deps,{oldOrderRef:original.orderRef,idempotencyKey:"residential-retry",oldRawAccessToken:null,newRawAccessToken:ACCESS_TOKEN_B,currentUserId:owner});
    assert.equal(retry.amountFen,25400);assert.equal(retry.residentialOptions?.lineId,"highspeed");assert.equal(retry.residentialOptions?.deviceAllowance,5);
    assert.equal(firstValue(db,"SELECT residential_options_json FROM orders WHERE order_ref=?",original.orderRef),frozen);
    finalizePaid(deps,{outTradeNo:retry.orderRef,tradeNo:"v2-paid",tradeStatus:"TRADE_SUCCESS",totalAmount:"254.00",totalAmountFen:25400,appId:deps.appId,sellerId:deps.sellerId});
    const pending=listPendingServicesForAdmin(db).find(row=>row.orderRef===retry.orderRef)!;assert.equal(pending.residentialOptions?.trafficGb,300);
    const item=encryptServiceDeliveryItem({serviceId:pending.serviceId,position:1,item:{label:"synthetic",subscriptionUrl:"https://example.invalid/v2",monitorTargetKey:null}},DELIVERY_KEYRING);
    openService(db,{serviceId:pending.serviceId,adminUserId:admin,adminEmail:"admin-v2@example.invalid",items:[item],now:()=>TEST_NOW});
    db.prepare("UPDATE services SET ends_at='2026-09-21T00:00:00.000Z' WHERE id=?").run(pending.serviceId);
    const rights=JSON.stringify(db.prepare("SELECT * FROM services WHERE id=?").all(pending.serviceId));
    const originalAnnual=findSellablePlan(db,{...selection('shared-3','month-12')})!.priceFen;
    const renew=produceRenewalQuote(db,pending.serviceId,"ANNUAL",owner);assert.equal(renew.priceFen,originalAnnual+24000);assert.equal(renew.residentialOptions?.lineId,"highspeed");assert.equal(renew.residentialOptions?.deviceAllowance,5);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM services WHERE id=?").all(pending.serviceId)),rights);
    assert.equal(residentialOptionsForOrder(db,retry.orderRef)?.finalMonthlyFen,25400);
    assert.throws(()=>produceRenewalQuote(db,pending.serviceId,"MONTHLY",admin));
  });
});

test("corrupt/conflicting v2 snapshots never fall back to shared-3 or legacy NULL", async () => {
  await withAuthenticationDatabase(async db => {
    const deps=paymentDependencies(db),created=createPaymentOrder(deps,orderInput("res-v2-live-1t",69900));
    const valid=residentialOptionsForOrder(db,created.orderRef)!;
    for(const raw of [null,JSON.stringify({...valid,deviceAllowance:3}),JSON.stringify({...valid,basePlanId:1}),JSON.stringify({...valid,basePlanId:findSellablePlan(db,selection('shared-5'))!.id}),JSON.stringify({...valid,durationId:"month-6"}),JSON.stringify({...valid,pricingStrategyVersion:'unknown'}),JSON.stringify({...valid,basePeriodFen:0}),JSON.stringify({...valid,addonPeriodFen:1}),JSON.stringify({...valid,finalPeriodFen:1})]) {
      db.prepare("UPDATE orders SET residential_options_json=? WHERE order_ref=?").run(raw,created.orderRef);
      assert.throws(()=>getAuthorizedOrderStatus(deps,{orderRef:created.orderRef,userId:null,rawAccessToken:ACCESS_TOKEN_A}));
    }
  });
});

test('marked031 missing its snapshot column is corruption, not historical NULL fallback',async()=>{
 await withAuthenticationDatabase(async db=>{
  const owner=insertAuthenticationUser(db,{email:'schema-negative@example.invalid',passwordHash:'synthetic',status:'active'}),deps=paymentDependencies(db);
  const old=createPaymentOrder(deps,orderInput('shared-3',21900,owner));
  finalizePaid(deps,{outTradeNo:old.orderRef,tradeNo:'schema-negative-paid',tradeStatus:'TRADE_SUCCESS',totalAmount:'219.00',totalAmountFen:21900,appId:deps.appId,sellerId:deps.sellerId});
  const serviceId=firstValue(db,'SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id WHERE p.out_trade_no=?',old.orderRef)as number;
  db.prepare("UPDATE services SET status='open',opened_by_admin_id=?,opened_at=?,ends_at='2026-09-21T00:00:00.000Z' WHERE id=?").run(owner,TEST_NOW.toISOString(),serviceId);
  db.exec('ALTER TABLE orders DROP COLUMN residential_options_json');
  assert.equal(firstValue(db,'SELECT MAX(version) FROM schema_migrations'),32);
  assert.throws(()=>residentialSnapshotSql(db),{message:'Residential snapshot schema missing'});
  assert.throws(()=>resolveQuote(db,{selection:selection(),couponCode:null,now:()=>TEST_NOW}),{message:'Residential snapshot schema missing'});
  assert.throws(()=>produceRenewalQuote(db,serviceId,'MONTHLY',owner),{message:'QUOTE_UNAVAILABLE'});
 });
});

test('historical selected-tier direct NULL devices remain frozen through retry/renewal; new direct generation has3/5/10',async()=>{
 await withAuthenticationDatabase(async db=>{
  const owner=insertAuthenticationUser(db,{email:'historical-direct@example.invalid',passwordHash:'synthetic',status:'active'}),deps=paymentDependencies(db,new FakeAlipaySdk(),randomUUID);
  const old=createPaymentOrder(deps,orderInput('res-v2-direct-200g',14900,owner));
  const current=residentialOptionsForOrder(db,old.orderRef)!;
  const historical={...current,pricingStrategyVersion:'original-traffic-tier-v1',deviceAllowance:null};
  db.prepare('UPDATE orders SET residential_options_json=? WHERE order_ref=?').run(JSON.stringify(historical),old.orderRef);
  assert.equal(getAuthorizedOrderStatus(deps,{orderRef:old.orderRef,userId:owner,rawAccessToken:null}).residentialOptions?.deviceAllowance,null);
  finalizeClosed(deps,{outTradeNo:old.orderRef,tradeNo:'old-direct-close',tradeStatus:'TRADE_CLOSED',totalAmount:'149.00',totalAmountFen:14900,appId:deps.appId,sellerId:deps.sellerId});
  const retry=retryPaymentOrder(deps,{oldOrderRef:old.orderRef,idempotencyKey:'direct-historical-retry',oldRawAccessToken:null,newRawAccessToken:ACCESS_TOKEN_B,currentUserId:owner});
  assert.equal(retry.residentialOptions?.deviceAllowance,null);assert.equal(retry.residentialOptions?.pricingStrategyVersion,'original-traffic-tier-v1');
  finalizePaid(deps,{outTradeNo:retry.orderRef,tradeNo:'old-direct-paid',tradeStatus:'TRADE_SUCCESS',totalAmount:'149.00',totalAmountFen:14900,appId:deps.appId,sellerId:deps.sellerId});
  const id=firstValue(db,'SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id WHERE p.out_trade_no=?',retry.orderRef)as number;
  db.prepare("UPDATE services SET status='open',opened_by_admin_id=?,opened_at=?,ends_at='2026-09-21T00:00:00.000Z' WHERE id=?").run(owner,TEST_NOW.toISOString(),id);
  const renewal=produceRenewalQuote(db,id,'QUARTERLY',owner);assert.equal(renewal.residentialOptions?.deviceAllowance,null);assert.equal(renewal.residentialOptions?.pricingStrategyVersion,'original-traffic-tier-v1');
  for(const [traffic,devices]of [['200g',3],['300g',5],['1t',10]]as const){const fresh=resolveQuote(db,{selection:selection(`res-v2-direct-${traffic}`),couponCode:null,now:()=>TEST_NOW});assert.equal(fresh.residentialOptions?.deviceAllowance,devices);assert.equal(fresh.residentialOptions?.pricingStrategyVersion,'original-traffic-tier-v2');}
  assert.deepEqual(residentialOptionsForOrder(db,old.orderRef),historical);
 });
});

test("original NULL SKU retry/renew keeps exact identity", async () => {
  for(const [specId,traffic] of [["shared-3",null]] as const) await withAuthenticationDatabase(async db => {
    const owner=insertAuthenticationUser(db,{email:"legacy-owner@example.invalid",passwordHash:"synthetic",status:"active"});
    const deps=paymentDependencies(db,new FakeAlipaySdk(),randomUUID);
    const old=createPaymentOrder(deps,orderInput(specId,21900,owner));
    const stored=firstValue(db,"SELECT residential_options_json FROM orders WHERE order_ref=?",old.orderRef);
    assert.equal(old.residentialOptions?.trafficGb??null,traffic);
    finalizeClosed(deps,{outTradeNo:old.orderRef,tradeNo:"legacy-closed",tradeStatus:"TRADE_CLOSED",totalAmount:"219.00",totalAmountFen:21900,appId:deps.appId,sellerId:deps.sellerId});
    const retry=retryPaymentOrder(deps,{oldOrderRef:old.orderRef,idempotencyKey:"legacy-retry",oldRawAccessToken:null,newRawAccessToken:ACCESS_TOKEN_B,currentUserId:owner});
    assert.equal(retry.residentialOptions?.trafficGb??null,traffic);
    finalizePaid(deps,{outTradeNo:retry.orderRef,tradeNo:"legacy-paid",tradeStatus:"TRADE_SUCCESS",totalAmount:"219.00",totalAmountFen:21900,appId:deps.appId,sellerId:deps.sellerId});
    const id=firstValue(db,"SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id WHERE p.out_trade_no=?",retry.orderRef) as number;
    db.prepare("UPDATE services SET status='open',opened_by_admin_id=?,opened_at=?,ends_at='2026-09-21T00:00:00.000Z' WHERE id=?").run(owner,TEST_NOW.toISOString(),id);
    const quote=produceRenewalQuote(db,id,"MONTHLY",owner);assert.equal(quote.priceFen,21900);assert.equal(quote.residentialOptions?.trafficGb??null,traffic);
    assert.equal(firstValue(db,"SELECT residential_options_json FROM orders WHERE order_ref=?",old.orderRef),stored);
  });
});

test("real HTTP v2 rejects client overrides and missing owner/CSRF; admin sees only persisted snapshots", async () => {
  await withAuthenticationDatabase(async db => {
    const owner=insertAuthenticationUser(db,{email:"http-owner@example.invalid",passwordHash:"synthetic",status:"active"});
    const deps=paymentDependencies(db,new FakeAlipaySdk(),randomUUID),session=insertWebSession(db,owner);
    const app=buildApp({auth:{database:db,nodeEnv:"test",tokenHmacKeyring:TOKEN_KEYRING,rateLimitKeyring:TOKEN_KEYRING,csrfSigningKey:deps.csrfSigningKey},payment:deps});
    try {
      const quoteBody={...selection("res-v2-direct-200g"),couponCode:null};
      const good=await app.inject({method:"POST",url:"/api/pay/quote",payload:quoteBody});assert.equal(good.statusCode,200);assert.equal(good.json().amountFen,14900);assert.equal(good.json().residentialOptions.deviceAllowance,3);
      for(const field of ["deviceAllowance","baseMonthlyFen","residentialOptions","residential_options_json","residentialHistory"])
        assert.equal((await app.inject({method:"POST",url:"/api/pay/quote",payload:{...quoteBody,[field]:0}})).statusCode,400);
      const payload={...quoteBody,contact:"synthetic@example.invalid",scenarios:[],notes:null,acknowledgedAmountFen:14900};
      const headers={cookie:session.cookie,"idempotency-key":"http-v2","x-order-access-token":ACCESS_TOKEN_A};
      assert.equal((await app.inject({method:"POST",url:"/api/pay/orders",payload,headers:{}})).statusCode,401);
      assert.equal((await app.inject({method:"POST",url:"/api/pay/orders",payload,headers})).statusCode,403);
      const created=await app.inject({method:"POST",url:"/api/pay/orders",payload,headers:{...headers,"x-csrf-token":session.csrfToken}});
      assert.equal(created.statusCode,200);assert.equal(created.json().residentialOptions.trafficGb,200);
      assert.equal((await app.inject({method:"POST",url:"/api/pay/orders",payload:{...payload,deviceAllowance:10},headers:{...headers,"idempotency-key":"http-override","x-csrf-token":session.csrfToken}})).statusCode,400);
      assert.equal(firstValue(db,"SELECT count(*) FROM orders"),1);
    } finally {await app.close();}
  });
});

test("superseded local v2 snapshots remain readable and locked but cannot silently retry or renew under a new pricing strategy", async()=>{
 for(const paid of [false,true])await withAuthenticationDatabase(async db=>{
  const owner=insertAuthenticationUser(db,{email:'old-v2@example.invalid',passwordHash:'synthetic',status:'active'}),deps=paymentDependencies(db,new FakeAlipaySdk(),randomUUID);
  const old=createPaymentOrder(deps,orderInput('shared-3',21900,owner));
  const anchor=findSellablePlan(db,selection('shared-3'))!;
  const snapshot={version:'residential-options-v2',typeId:'residential',regionId:'sg',ispId:'sptel',specId:'res-v2-direct-default',durationId:'month-1',basePlanId:anchor.id,baseMonthlyFen:21900,addonMonthlyFen:0,finalMonthlyFen:21900,lineId:'direct',trafficGb:300,deviceAllowance:null};
  db.prepare("UPDATE orders SET spec_id='res-v2-direct-default',catalog_version='residential-options-v2',residential_options_json=? WHERE order_ref=?").run(JSON.stringify(snapshot),old.orderRef);
  const before=firstValue(db,'SELECT residential_options_json FROM orders WHERE order_ref=?',old.orderRef);
  assert.equal(getAuthorizedOrderStatus(deps,{orderRef:old.orderRef,userId:owner,rawAccessToken:null}).amountFen,21900);
  const event={outTradeNo:old.orderRef,tradeNo:'old-local-v2',tradeStatus:paid?'TRADE_SUCCESS':'TRADE_CLOSED',totalAmount:'219.00',totalAmountFen:21900,appId:deps.appId,sellerId:deps.sellerId};
  if(paid){
   finalizePaid(deps,event);const id=firstValue(db,'SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id WHERE p.out_trade_no=?',old.orderRef) as number;
   db.prepare("UPDATE services SET status='open',opened_by_admin_id=?,opened_at=?,ends_at='2026-09-21T00:00:00.000Z' WHERE id=?").run(owner,TEST_NOW.toISOString(),id);
   assert.throws(()=>produceRenewalQuote(db,id,'MONTHLY',owner),{message:'QUOTE_UNAVAILABLE'});
  }else{
   finalizeClosed(deps,event);
   assert.throws(()=>retryPaymentOrder(deps,{oldOrderRef:old.orderRef,idempotencyKey:'old-v2-retry',oldRawAccessToken:null,newRawAccessToken:ACCESS_TOKEN_B,currentUserId:owner}),{message:'plan_unavailable'});
   assert.equal(firstValue(db,'SELECT occupied_slots FROM sellable_plans WHERE id=?',anchor.id),0);
  }
  assert.equal(firstValue(db,'SELECT residential_options_json FROM orders WHERE order_ref=?',old.orderRef),before);
  assert.equal(firstValue(db,'SELECT count(*) FROM orders'),1);
 });
});
